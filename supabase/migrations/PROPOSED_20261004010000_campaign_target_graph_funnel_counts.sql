-- PROPOSED — NOT APPLIED. Campaign audience funnel in one statement + cohort keyset index.
--
-- Why: the Composer's audience read (readComposerAudience → previewCampaignTargets →
-- summarizeCampaignGraph) counted Reach's funnel with FIFTEEN separate `count: exact`
-- HEAD requests over campaign_target_graph, fired together beside the build-simulation
-- page read. Each statement is 0.1–0.3 s in Postgres (EXPLAIN ANALYZE, Minneapolis,
-- 2026-10-04), but they queue on the PostgREST pool: the funnel phase measured ~4.5 s
-- for one market. This function counts every bucket in ONE scan of the audience rows.
--
-- One predicate, no second copy of the audience logic: the API RECORDS the exact
-- builder calls (applyCampaignGraphFilters + each bucket's extra) and sends them as
-- data — [{op, column, value|values}] with op in eq/neq/gt/gte/lt/lte/in/is_null/
-- not_null (apps/api/src/lib/domain/campaigns/campaign-graph-funnel.js). Anything it
-- cannot express exactly (ilike, or(), imatch, not-in, drawn area) never reaches this
-- function; the API keeps the per-bucket counts. Until this is applied the call 404s
-- and the API falls back automatically (same numbers).
--
-- Literal semantics match PostgREST: values are rendered as quoted literals
-- (format %L) compared against the column, so they coerce to the column type exactly
-- as `col=eq.true` / `col=in.(a,b)` do. Columns are validated against the table's
-- live attributes and quoted with %I.
--
-- Gate: SECURITY INVOKER, EXECUTE for service_role only (the API's role, which already
-- reads the graph). anon/authenticated cannot call it.
--
-- Index (OPTIONAL, small win): the cohort count (countCampaignAudienceCohort) reads
-- queue-eligible rows in 16 keyset partitions ORDER BY graph_id within the audience;
-- each partition is a BitmapAnd of the market index with a ~10K-entry pkey range
-- (≈130 ms in Postgres, Minneapolis EXPLAIN ANALYZE). The partial index serves
-- (market, graph_id) ranges directly — worth ≈0.3 s per cohort at 6-way concurrency.
-- The cohort is payload-bound (≈2.7 KB of JSON per row), not index-bound, so skip it if
-- the extra write cost on the reconcile matters.
--
-- Maintenance (not part of this migration): the graph has never been vacuumed since
-- the 2026-10-03 rebuild (n_dead_tup 9,805; relallvisible 47,461 / 67,456 pages), so
-- index-only counts heap-fetch (10,301 heap fetches for 5,411 Minneapolis rows) and
-- the whole-graph exact count in readCampaignGraphRefreshStatus hit the 8 s PostgREST
-- timeout once during the reconcile. Run `VACUUM (ANALYZE) public.campaign_target_graph;`
-- after the 05:00–07:00 UTC reconcile.
--
-- Apply plan (outside a transaction — CONCURRENTLY cannot run in one):
--   1. Pretest: BEGIN; <CREATE FUNCTION below>; SELECT public.campaign_target_graph_funnel_counts(...)
--      for Minneapolis and Dallas; compare with the per-bucket counts; ROLLBACK.
--   2. Apply the function (transactional, instant).
--   3. CREATE INDEX CONCURRENTLY (outside the 05:00–07:00 UTC reconcile window).
--   4. NOTIFY pgrst, 'reload schema';
-- Rollback: PROPOSED_20261004010000_campaign_target_graph_funnel_counts_rollback.sql.

CREATE OR REPLACE FUNCTION public.campaign_target_graph_predicate_sql(p_predicate jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clause jsonb;
  v_op text;
  v_column text;
  v_parts text[] := ARRAY[]::text[];
  v_values text;
BEGIN
  IF p_predicate IS NULL OR jsonb_typeof(p_predicate) <> 'array' THEN
    RAISE EXCEPTION 'campaign_target_graph_predicate_sql: predicate must be an array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_predicate) > 64 THEN
    RAISE EXCEPTION 'campaign_target_graph_predicate_sql: too many clauses' USING ERRCODE = '22023';
  END IF;
  FOR v_clause IN SELECT value FROM jsonb_array_elements(p_predicate) LOOP
    v_op := v_clause->>'op';
    v_column := v_clause->>'column';
    IF v_column IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'public.campaign_target_graph'::regclass
        AND attname = v_column AND attnum > 0 AND NOT attisdropped
    ) THEN
      RAISE EXCEPTION 'campaign_target_graph_predicate_sql: unknown column %', v_column USING ERRCODE = '42703';
    END IF;
    IF v_op IN ('eq', 'neq', 'gt', 'gte', 'lt', 'lte') THEN
      IF jsonb_typeof(v_clause->'value') NOT IN ('string', 'number', 'boolean') THEN
        RAISE EXCEPTION 'campaign_target_graph_predicate_sql: % needs a scalar value', v_op USING ERRCODE = '22023';
      END IF;
      v_parts := v_parts || format('%I %s %L', v_column,
        CASE v_op WHEN 'eq' THEN '=' WHEN 'neq' THEN '<>' WHEN 'gt' THEN '>' WHEN 'gte' THEN '>=' WHEN 'lt' THEN '<' ELSE '<=' END,
        v_clause->>'value');
    ELSIF v_op = 'in' THEN
      IF jsonb_typeof(v_clause->'values') <> 'array' OR jsonb_array_length(v_clause->'values') = 0 THEN
        RAISE EXCEPTION 'campaign_target_graph_predicate_sql: in needs values' USING ERRCODE = '22023';
      END IF;
      SELECT string_agg(format('%L', e.value #>> '{}'), ', ') INTO v_values
      FROM jsonb_array_elements(v_clause->'values') AS e(value);
      v_parts := v_parts || format('%I IN (%s)', v_column, v_values);
    ELSIF v_op = 'is_null' THEN
      v_parts := v_parts || format('%I IS NULL', v_column);
    ELSIF v_op = 'not_null' THEN
      v_parts := v_parts || format('%I IS NOT NULL', v_column);
    ELSE
      RAISE EXCEPTION 'campaign_target_graph_predicate_sql: unsupported op %', v_op USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF cardinality(v_parts) = 0 THEN RETURN 'true'; END IF;
  RETURN '(' || array_to_string(v_parts, ' AND ') || ')';
END
$$;

CREATE OR REPLACE FUNCTION public.campaign_target_graph_funnel_counts(p_base jsonb, p_buckets jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_select text[] := ARRAY[]::text[];
  v_key text;
  v_bucket jsonb;
  v_result jsonb;
BEGIN
  IF p_buckets IS NULL OR jsonb_typeof(p_buckets) <> 'object' THEN
    RAISE EXCEPTION 'campaign_target_graph_funnel_counts: buckets must be an object' USING ERRCODE = '22023';
  END IF;
  FOR v_key, v_bucket IN SELECT key, value FROM jsonb_each(p_buckets) LOOP
    v_select := v_select || format('%L, count(*) FILTER (WHERE %s)', v_key, public.campaign_target_graph_predicate_sql(v_bucket));
  END LOOP;
  -- jsonb_build_object takes at most 100 arguments (50 buckets).
  IF cardinality(v_select) = 0 OR cardinality(v_select) > 50 THEN
    RAISE EXCEPTION 'campaign_target_graph_funnel_counts: 1..50 buckets' USING ERRCODE = '22023';
  END IF;
  EXECUTE format(
    'SELECT jsonb_build_object(%s) FROM public.campaign_target_graph WHERE %s',
    array_to_string(v_select, ', '),
    public.campaign_target_graph_predicate_sql(p_base)
  ) INTO v_result;
  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION public.campaign_target_graph_predicate_sql(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_funnel_counts(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_target_graph_predicate_sql(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.campaign_target_graph_funnel_counts(jsonb, jsonb) TO service_role;

-- Run separately, outside a transaction (step 3 above):
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ctg_queue_eligible_market_graph_id
--   ON public.campaign_target_graph (market, graph_id)
--   WHERE queue_eligible AND property_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
