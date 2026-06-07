-- Campaign sender coverage lock-in.
--
-- sender_covered becomes the health-safe production route truth:
--   1. health-safe exact market
--   2. approved state/regional fallback
--   3. uncovered when neither exists
--
-- Existing graph JSON columns retain exact/fallback diagnostics without adding
-- schema columns. The staged commit recalculates coverage before facets are
-- refreshed, and this migration performs one logged recalculation of the
-- existing graph when it is applied.

CREATE OR REPLACE FUNCTION public.normalize_campaign_sender_market(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT trim(
    both '_' from regexp_replace(
      lower(trim(COALESCE(p_value, ''))),
      '[^a-z0-9]+',
      '_',
      'g'
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.normalize_campaign_sender_phone(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH digits AS (
    SELECT regexp_replace(COALESCE(p_value, ''), '[^0-9]', '', 'g') AS value
  )
  SELECT CASE
    WHEN length(value) = 10 THEN '1' || value
    WHEN length(value) = 11 AND left(value, 1) = '1' THEN value
    ELSE value
  END
  FROM digits;
$$;

CREATE OR REPLACE FUNCTION public.resolve_campaign_safe_sender_route(
  p_market text,
  p_state text
)
RETURNS TABLE(
  sender_covered boolean,
  sender_id uuid,
  sender_phone_number text,
  sender_market text,
  route_type text,
  routing_rule_name text,
  exact_market_covered boolean,
  health_safe_exact boolean,
  fallback_covered boolean,
  safe_sender_count integer,
  health_blocked_sender_count integer
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH route_input AS (
    SELECT
      public.normalize_campaign_sender_market(p_market) AS market_key,
      upper(COALESCE(
        NULLIF(trim(p_state), ''),
        substring(p_market from ',[[:space:]]*([A-Za-z]{2})[[:space:]]*$')
      )) AS state_key
  ),
  blocked_values AS (
    SELECT blocked.phone_number
    FROM (
      VALUES
        ('+14704920588'::text),
        ('+14693131600'::text)
    ) AS blocked(phone_number)

    UNION ALL

    SELECT trim(entry.phone_number)
    FROM public.system_control sc
    CROSS JOIN LATERAL regexp_split_to_table(
      translate(COALESCE(sc.value, ''), '[]"', ''),
      '[[:space:]]*,[[:space:]]*'
    ) AS entry(phone_number)
    WHERE sc.key = 'sms_blocked_sender_numbers'
      AND NULLIF(trim(entry.phone_number), '') IS NOT NULL
  ),
  blocked_senders AS (
    SELECT DISTINCT public.normalize_campaign_sender_phone(phone_number) AS phone_number
    FROM blocked_values
    WHERE NULLIF(public.normalize_campaign_sender_phone(phone_number), '') IS NOT NULL
  ),
  active_inventory AS (
    SELECT
      tn.id,
      tn.phone_number,
      tn.market,
      public.normalize_campaign_sender_market(tn.market) AS market_key,
      COALESCE(tn.messages_sent_today, 0) AS messages_sent_today,
      tn.last_used_at,
      EXISTS (
        SELECT 1
        FROM blocked_senders blocked
        WHERE blocked.phone_number = public.normalize_campaign_sender_phone(tn.phone_number)
      ) AS health_blocked
    FROM public.textgrid_numbers tn
    WHERE NULLIF(public.normalize_campaign_sender_phone(tn.phone_number), '') IS NOT NULL
      AND COALESCE(NULLIF(lower(trim(tn.status)), ''), 'active') = 'active'
  ),
  safe_inventory AS (
    SELECT *
    FROM active_inventory
    WHERE NOT health_blocked
  ),
  route_rules(state_key, rule_name, route_priority, target_market) AS (
    VALUES
      ('CA', 'ca_to_los_angeles', 1, 'Los Angeles, CA'),
      ('OR', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('WA', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('NV', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('AZ', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('ID', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('UT', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('NM', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('CO', 'west_mountain_to_los_angeles', 1, 'Los Angeles, CA'),
      ('MN', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('WI', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('IA', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('ND', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('SD', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('NE', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('IL', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('IN', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('MI', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('OH', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('MO', 'midwest_to_minneapolis', 1, 'Minneapolis, MN'),
      ('OK', 'southern_plains_to_dallas_then_houston', 1, 'Dallas, TX'),
      ('OK', 'southern_plains_to_dallas_then_houston', 2, 'Houston, TX'),
      ('AR', 'southern_plains_to_dallas_then_houston', 1, 'Dallas, TX'),
      ('AR', 'southern_plains_to_dallas_then_houston', 2, 'Houston, TX'),
      ('KS', 'southern_plains_to_dallas_then_houston', 1, 'Dallas, TX'),
      ('KS', 'southern_plains_to_dallas_then_houston', 2, 'Houston, TX'),
      ('LA', 'louisiana_to_houston', 1, 'Houston, TX'),
      ('TX', 'texas_to_dallas_then_houston', 1, 'Dallas, TX'),
      ('TX', 'texas_to_dallas_then_houston', 2, 'Houston, TX'),
      ('GA', 'georgia_to_atlanta', 1, 'Atlanta, GA'),
      ('NC', 'carolinas_to_charlotte', 1, 'Charlotte, NC'),
      ('SC', 'carolinas_to_charlotte', 1, 'Charlotte, NC'),
      ('FL', 'florida_to_jacksonville_then_miami', 1, 'Jacksonville, FL'),
      ('FL', 'florida_to_jacksonville_then_miami', 2, 'Miami, FL'),
      ('NY', 'northeast_to_miami', 1, 'Miami, FL'),
      ('NJ', 'northeast_to_miami', 1, 'Miami, FL'),
      ('PA', 'northeast_to_miami', 1, 'Miami, FL'),
      ('MD', 'northeast_to_miami', 1, 'Miami, FL'),
      ('VA', 'northeast_to_miami', 1, 'Miami, FL'),
      ('DC', 'northeast_to_miami', 1, 'Miami, FL'),
      ('DE', 'northeast_to_miami', 1, 'Miami, FL'),
      ('CT', 'northeast_to_miami', 1, 'Miami, FL'),
      ('RI', 'northeast_to_miami', 1, 'Miami, FL'),
      ('MA', 'northeast_to_miami', 1, 'Miami, FL'),
      ('NH', 'northeast_to_miami', 1, 'Miami, FL'),
      ('VT', 'northeast_to_miami', 1, 'Miami, FL'),
      ('ME', 'northeast_to_miami', 1, 'Miami, FL'),
      ('AL', 'southeast_inland_to_atlanta_then_charlotte', 1, 'Atlanta, GA'),
      ('AL', 'southeast_inland_to_atlanta_then_charlotte', 2, 'Charlotte, NC'),
      ('MS', 'southeast_inland_to_atlanta_then_charlotte', 1, 'Atlanta, GA'),
      ('MS', 'southeast_inland_to_atlanta_then_charlotte', 2, 'Charlotte, NC'),
      ('TN', 'southeast_inland_to_atlanta_then_charlotte', 1, 'Atlanta, GA'),
      ('TN', 'southeast_inland_to_atlanta_then_charlotte', 2, 'Charlotte, NC'),
      ('KY', 'southeast_inland_to_atlanta_then_charlotte', 1, 'Atlanta, GA'),
      ('KY', 'southeast_inland_to_atlanta_then_charlotte', 2, 'Charlotte, NC')
  ),
  route_candidates AS (
    SELECT
      inventory.*,
      'exact_market_match'::text AS route_type,
      'exact_market_match'::text AS routing_rule_name,
      0::integer AS route_priority
    FROM safe_inventory inventory
    CROSS JOIN route_input input
    WHERE inventory.market_key = input.market_key

    UNION ALL

    SELECT
      inventory.*,
      'approved_state_fallback'::text AS route_type,
      rules.rule_name AS routing_rule_name,
      rules.route_priority
    FROM route_input input
    JOIN route_rules rules
      ON rules.state_key = input.state_key
    JOIN safe_inventory inventory
      ON inventory.market_key = public.normalize_campaign_sender_market(rules.target_market)
  ),
  selected AS (
    SELECT *
    FROM route_candidates
    ORDER BY
      route_priority,
      messages_sent_today,
      last_used_at NULLS FIRST,
      id
    LIMIT 1
  ),
  diagnostics AS (
    SELECT
      EXISTS (
        SELECT 1
        FROM active_inventory inventory
        CROSS JOIN route_input input
        WHERE inventory.market_key = input.market_key
      ) AS exact_market_covered,
      EXISTS (
        SELECT 1
        FROM safe_inventory inventory
        CROSS JOIN route_input input
        WHERE inventory.market_key = input.market_key
      ) AS health_safe_exact,
      (SELECT COUNT(*)::integer FROM active_inventory WHERE health_blocked) AS health_blocked_sender_count
  )
  SELECT
    selected.id IS NOT NULL AS sender_covered,
    selected.id AS sender_id,
    selected.phone_number AS sender_phone_number,
    selected.market AS sender_market,
    COALESCE(selected.route_type, 'no_sender_route') AS route_type,
    selected.routing_rule_name,
    diagnostics.exact_market_covered,
    diagnostics.health_safe_exact,
    COALESCE(selected.route_type = 'approved_state_fallback', false) AS fallback_covered,
    CASE
      WHEN selected.market_key IS NULL THEN 0
      ELSE (
        SELECT COUNT(*)::integer
        FROM safe_inventory inventory
        WHERE inventory.market_key = selected.market_key
      )
    END AS safe_sender_count,
    diagnostics.health_blocked_sender_count
  FROM diagnostics
  LEFT JOIN selected ON true;
$$;

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_sender_coverage(
  p_source text DEFAULT 'campaign_target_graph_sender_coverage_refresh'
)
RETURNS TABLE(
  graph_rows integer,
  clean_targets integer,
  exact_market_covered integer,
  health_safe_exact integer,
  fallback_covered integer,
  sender_covered integer,
  expanded_deliverable integer,
  uncovered_gap integer,
  health_blocked_sender_count integer
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_updated_rows integer := 0;
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  PERFORM set_config('work_mem', '128MB', true);

  WITH resolved AS (
    SELECT
      graph.graph_id,
      route.*
    FROM public.campaign_target_graph graph
    CROSS JOIN LATERAL public.resolve_campaign_safe_sender_route(
      graph.market,
      graph.state
    ) route
  )
  UPDATE public.campaign_target_graph graph
  SET
    sender_covered = resolved.sender_covered,
    sender_market = resolved.sender_market,
    routing_tier = resolved.route_type,
    queue_eligible = (
      graph.sms_eligible
      AND NOT graph.true_post_contact_suppression
      AND NOT graph.wrong_number
      AND NOT graph.pending_prior_touch
      AND NOT graph.active_queue_item
      AND resolved.sender_covered
    ),
    queue_block_reason = CASE
      WHEN NOT graph.sms_eligible THEN 'sms_ineligible'
      WHEN graph.true_post_contact_suppression THEN 'suppressed'
      WHEN graph.wrong_number THEN 'wrong_number'
      WHEN graph.pending_prior_touch THEN 'pending_prior_touch'
      WHEN graph.active_queue_item THEN 'active_queue_item'
      WHEN NOT resolved.sender_covered THEN 'no_sender_coverage'
      ELSE NULL
    END,
    linkage_counts = COALESCE(graph.linkage_counts, '{}'::jsonb) || jsonb_build_object(
      'sender_numbers', resolved.safe_sender_count
    ),
    blocker_flags = COALESCE(graph.blocker_flags, '{}'::jsonb) || jsonb_build_object(
      'sender_covered', resolved.sender_covered,
      'exact_market_covered', resolved.exact_market_covered,
      'health_safe_exact', resolved.health_safe_exact,
      'fallback_covered', resolved.fallback_covered,
      'health_blocked_sender_count', resolved.health_blocked_sender_count
    ),
    extra_data = COALESCE(graph.extra_data, '{}'::jsonb) || jsonb_build_object(
      'sender_route',
      jsonb_strip_nulls(jsonb_build_object(
        'source', COALESCE(NULLIF(p_source, ''), 'campaign_target_graph_sender_coverage_refresh'),
        'sender_id', resolved.sender_id,
        'sender_phone_number', resolved.sender_phone_number,
        'sender_market', resolved.sender_market,
        'route_type', resolved.route_type,
        'routing_rule_name', resolved.routing_rule_name,
        'exact_market_covered', resolved.exact_market_covered,
        'health_safe_exact', resolved.health_safe_exact,
        'fallback_covered', resolved.fallback_covered,
        'safe_sender_count', resolved.safe_sender_count,
        'health_blocked_sender_count', resolved.health_blocked_sender_count
      ))
    )
  FROM resolved
  WHERE resolved.graph_id = graph.graph_id;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

  RETURN QUERY
  SELECT
    v_updated_rows,
    COUNT(*) FILTER (
      WHERE graph.sms_eligible
        AND NOT graph.true_post_contact_suppression
        AND NOT graph.wrong_number
    )::integer,
    COUNT(*) FILTER (
      WHERE graph.sms_eligible
        AND NOT graph.true_post_contact_suppression
        AND NOT graph.wrong_number
        AND COALESCE((graph.blocker_flags->>'exact_market_covered')::boolean, false)
    )::integer,
    COUNT(*) FILTER (
      WHERE graph.sms_eligible
        AND NOT graph.true_post_contact_suppression
        AND NOT graph.wrong_number
        AND COALESCE((graph.blocker_flags->>'health_safe_exact')::boolean, false)
    )::integer,
    COUNT(*) FILTER (
      WHERE graph.sms_eligible
        AND NOT graph.true_post_contact_suppression
        AND NOT graph.wrong_number
        AND COALESCE((graph.blocker_flags->>'fallback_covered')::boolean, false)
    )::integer,
    COUNT(*) FILTER (
      WHERE graph.sms_eligible
        AND NOT graph.true_post_contact_suppression
        AND NOT graph.wrong_number
        AND graph.sender_covered
    )::integer,
    COUNT(*) FILTER (WHERE graph.queue_eligible)::integer,
    COUNT(*) FILTER (
      WHERE graph.sms_eligible
        AND NOT graph.true_post_contact_suppression
        AND NOT graph.wrong_number
        AND NOT graph.sender_covered
    )::integer,
    COALESCE(
      MAX((graph.blocker_flags->>'health_blocked_sender_count')::integer),
      0
    )::integer
  FROM public.campaign_target_graph graph;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_campaign_target_graph_stage_commit(p_run_id uuid)
RETURNS TABLE(
  run_id uuid,
  graph_rows integer,
  facet_rows integer,
  graph_refresh_scope text,
  elapsed_ms integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_stage_rows integer := 0;
  v_graph_rows integer := 0;
  v_facet_rows integer := 0;
  v_elapsed_ms integer := 0;
  v_scope text := 'partial';
  v_run_metadata jsonb := '{}'::jsonb;
  v_sender_coverage record;
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  PERFORM set_config('work_mem', '128MB', true);

  SELECT COALESCE(refresh_run.metadata, '{}'::jsonb)
  INTO v_run_metadata
  FROM public.campaign_target_graph_refresh_runs refresh_run
  WHERE refresh_run.id = p_run_id
    AND refresh_run.status = 'started';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign target graph refresh run % is not active', p_run_id;
  END IF;

  SELECT COUNT(*)::integer
  INTO v_stage_rows
  FROM public.campaign_target_graph_stage;

  IF v_stage_rows <= 0 THEN
    UPDATE public.campaign_target_graph_refresh_runs
    SET
      status = 'failed',
      finished_at = now(),
      graph_rows = 0,
      facet_rows = 0,
      error_message = 'campaign_target_graph_stage_empty',
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'graph_refresh_scope', 'empty',
        'stage_rows', 0
      )
    WHERE id = p_run_id;

    RAISE EXCEPTION 'campaign_target_graph_stage is empty for run %', p_run_id;
  END IF;

  v_scope := CASE
    WHEN COALESCE(v_run_metadata->>'completed_all_batches', 'false') = 'true' THEN 'full'
    ELSE 'partial'
  END;

  TRUNCATE TABLE public.campaign_target_graph;

  INSERT INTO public.campaign_target_graph
  SELECT *
  FROM public.campaign_target_graph_stage;

  GET DIAGNOSTICS v_graph_rows = ROW_COUNT;

  SELECT *
  INTO v_sender_coverage
  FROM public.refresh_campaign_target_graph_sender_coverage(
    'refresh_campaign_target_graph_stage_commit'
  );

  SELECT public.refresh_campaign_target_graph_facets()
  INTO v_facet_rows;

  v_elapsed_ms := GREATEST(
    0,
    floor(EXTRACT(epoch FROM clock_timestamp() - v_started_at) * 1000)::integer
  );

  UPDATE public.campaign_target_graph_refresh_runs
  SET
    status = 'completed',
    finished_at = now(),
    graph_rows = v_graph_rows,
    facet_rows = v_facet_rows,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'source', 'refresh_campaign_target_graph_stage_commit',
      'stage_rows', v_stage_rows,
      'graph_rows', v_graph_rows,
      'facet_rows', v_facet_rows,
      'graph_refresh_scope', v_scope,
      'fallback_enabled', true,
      'sender_route_mode', 'health_safe_exact_then_approved_state_fallback',
      'first_touch_regional_fallback_enabled', true,
      'exact_market_covered', v_sender_coverage.exact_market_covered,
      'health_safe_exact', v_sender_coverage.health_safe_exact,
      'fallback_covered', v_sender_coverage.fallback_covered,
      'sender_covered', v_sender_coverage.sender_covered,
      'expanded_deliverable', v_sender_coverage.expanded_deliverable,
      'uncovered_gap', v_sender_coverage.uncovered_gap,
      'health_blocked_sender_count', v_sender_coverage.health_blocked_sender_count,
      'elapsed_ms_commit', v_elapsed_ms
    )
  WHERE id = p_run_id;

  run_id := p_run_id;
  graph_rows := v_graph_rows;
  facet_rows := v_facet_rows;
  graph_refresh_scope := v_scope;
  elapsed_ms := v_elapsed_ms;
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  UPDATE public.campaign_target_graph_refresh_runs
  SET
    status = 'failed',
    finished_at = now(),
    error_message = SQLERRM,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'source', 'refresh_campaign_target_graph_stage_commit',
      'error_sqlstate', SQLSTATE
    )
  WHERE id = p_run_id;
  RAISE;
END;
$$;

-- Runtime routing must permit the same approved fallback used by the graph.
INSERT INTO public.system_control (key, value)
VALUES
  ('require_local_routing', 'false'),
  ('allow_regional_fallback_for_first_touch', 'true')
ON CONFLICT (key) DO UPDATE
SET
  value = EXCLUDED.value,
  updated_at = now();

-- Recalculate the existing graph and write an explicit audit row. This is data
-- refresh only; no graph columns or tables are added by this migration.
DO $$
DECLARE
  v_metrics record;
  v_facet_rows integer := 0;
BEGIN
  SELECT *
  INTO v_metrics
  FROM public.refresh_campaign_target_graph_sender_coverage(
    'migration:campaign_sender_coverage_safe_route_lockin'
  );

  SELECT public.refresh_campaign_target_graph_facets()
  INTO v_facet_rows;

  INSERT INTO public.campaign_target_graph_refresh_runs (
    status,
    started_at,
    finished_at,
    graph_rows,
    facet_rows,
    metadata
  )
  VALUES (
    'completed',
    now(),
    now(),
    v_metrics.graph_rows,
    v_facet_rows,
    jsonb_build_object(
      'source', 'migration:campaign_sender_coverage_safe_route_lockin',
      'refresh_type', 'sender_coverage_data_only',
      'sender_route_mode', 'health_safe_exact_then_approved_state_fallback',
      'first_touch_regional_fallback_enabled', true,
      'clean_targets', v_metrics.clean_targets,
      'exact_market_covered', v_metrics.exact_market_covered,
      'health_safe_exact', v_metrics.health_safe_exact,
      'fallback_covered', v_metrics.fallback_covered,
      'sender_covered', v_metrics.sender_covered,
      'expanded_deliverable', v_metrics.expanded_deliverable,
      'uncovered_gap', v_metrics.uncovered_gap,
      'health_blocked_sender_count', v_metrics.health_blocked_sender_count
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_campaign_sender_market(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.normalize_campaign_sender_phone(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_campaign_safe_sender_route(text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_sender_coverage(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_stage_commit(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_stage_start()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_stage_batch(uuid, integer, integer, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_fallback_batch(uuid, integer, integer, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_property_universe_batch(uuid, integer, integer, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_campaign_target_graph_staged(integer, integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.normalize_campaign_sender_market(text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.normalize_campaign_sender_phone(text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_campaign_safe_sender_route(text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_sender_coverage(text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_stage_commit(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_stage_start()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_stage_batch(uuid, integer, integer, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_fallback_batch(uuid, integer, integer, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_property_universe_batch(uuid, integer, integer, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_campaign_target_graph_staged(integer, integer)
  TO service_role;
