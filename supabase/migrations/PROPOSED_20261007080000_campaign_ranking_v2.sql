-- PROPOSED — NOT APPLIED. Acquisition OS §11–19 / §67–69 (agent A2), 2026-10-07.
-- Owner approval required (§86/§87). Rollback: PROPOSED_20261007080000_campaign_ranking_v2_rollback.sql
--
-- CAMPAIGN RANKING v2 — the SQL twin of
--   apps/api/src/lib/domain/campaigns/ranking-v2/campaign-rank-v2.js
-- (formula-identical; tests pin both to the same fixtures). Until this lands,
-- CAMPAIGN_RANKING_V2=on ranks in-process over a 20,000-row window; with it,
-- the graph read itself orders by campaign_rank_v2_priority (whole cohort).
--
-- Depends on PROPOSED_20261007071100_seller_situation_scores.sql (A1).
-- Nothing here changes the legacy order: acquisition_score stays as it is and
-- the existing builds keep ordering by it while the flag is OFF.
--
-- Cost notes: the projection is a keyset-batched UPDATE (≤ 2,000 rows/call,
-- statement_timeout 30 s) run off-peak (before 05:00Z / 09:00–09:15Z / after
-- 12:00Z), never a trigger, never one national statement. Added graph bytes:
-- ~10 narrow columns ≈ 40 B/row ≈ 7 MB for 170K rows + one btree ≈ 8 MB.

BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';

-- ── 1. formula functions (immutable, no table access) ────────────────────────

-- Contactability 0–100: identity + line type + 2-month usage; null when none known.
CREATE OR REPLACE FUNCTION public.campaign_rank_v2_contact(p_identity text, p_phone_type text, p_usage text)
RETURNS smallint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN lower(coalesce(p_identity,'')) NOT IN ('verified','probable','entity_company_linked','unknown','mismatch')
     AND upper(coalesce(p_phone_type,'')) NOT IN ('W','L')
     AND lower(coalesce(p_usage,'')) NOT IN ('very heavy usage','heavy usage','moderate usage','light usage','minimal usage')
    THEN NULL
    ELSE (
      CASE lower(coalesce(p_identity,'')) WHEN 'verified' THEN 40 WHEN 'probable' THEN 28 WHEN 'entity_company_linked' THEN 22
        WHEN 'unknown' THEN 10 WHEN 'mismatch' THEN 0 ELSE 20 END
      + CASE upper(coalesce(p_phone_type,'')) WHEN 'W' THEN 30 WHEN 'L' THEN 12 ELSE 15 END
      + CASE lower(coalesce(p_usage,'')) WHEN 'very heavy usage' THEN 30 WHEN 'heavy usage' THEN 30 WHEN 'moderate usage' THEN 24
        WHEN 'light usage' THEN 16 WHEN 'minimal usage' THEN 8 ELSE 15 END
    )::smallint
  END
$$;

-- Within-band score 0–100. Unknown term → its neutral prior (documented in JS).
CREATE OR REPLACE FUNCTION public.campaign_rank_v2_score(
  p_sell365 numeric, p_forced_sale numeric, p_stacked_codes integer, p_equity numeric,
  p_other_pressure numeric, p_aos numeric, p_market numeric, p_contact numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT round((
      0.22 * coalesce(least(greatest(p_sell365, 0), 100), 20)
    + 0.2 * coalesce(least(greatest(p_forced_sale, 0), 100), 20)
    + 0.12 * least(coalesce(p_stacked_codes, 0) * 15, 100)
    + 0.12 * coalesce(least(greatest(p_equity, 0), 100), 40)
    + 0.06 * coalesce(least(greatest(p_other_pressure, 0), 100), 20)
    + 0.06 * coalesce(least(greatest(CASE WHEN p_aos > 100 THEN p_aos / 10 ELSE p_aos END, 0), 100), 50)
    + 0.14 * coalesce(least(greatest(p_market, 0), 100), 50)
    + 0.08 * coalesce(least(greatest(p_contact, 0), 100), 50)
  )::numeric, 2)
$$;

-- Band-encoded priority (one sortable number, 0–100):
--   A 75+.2499·score · B 50+.2499·score · C 25+.2499·score · no tier → .2499·legacy (FALLBACK) · neither → NULL (bands never touch)
CREATE OR REPLACE FUNCTION public.campaign_rank_v2_priority(p_tier text, p_score numeric, p_legacy numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_tier = 'A' AND p_score IS NOT NULL THEN round(75 + 0.2499 * least(greatest(p_score,0),100), 2)
    WHEN p_tier = 'B' AND p_score IS NOT NULL THEN round(50 + 0.2499 * least(greatest(p_score,0),100), 2)
    WHEN p_tier = 'C' AND p_score IS NOT NULL THEN round(25 + 0.2499 * least(greatest(p_score,0),100), 2)
    WHEN p_legacy IS NOT NULL THEN round(0.2499 * least(greatest(p_legacy,0),100), 2)
    ELSE NULL
  END
$$;

-- ── 2. ZIP market quality (market_quality_v1, transparent; see market-quality.js) ──
CREATE OR REPLACE VIEW public.v_zip_market_quality_v1 AS
WITH r AS (
  SELECT geo_key AS zip, asset, qualified_sale_count, investor_count, buyer_known_count, cash_count,
         median_price, median_ppsf, median_ppu, median_inv_price, latest_sale, build_id
    FROM public.mi_geo_period_rollup
   WHERE build_id = (SELECT max(build_id) FROM public.mi_geo_period_rollup)
     AND geo_level = 'zip' AND period = '1y'
), b AS (
  SELECT zip,
         CASE WHEN units >= 5 THEN 'mf_5_plus' WHEN units >= 2 THEN 'mf_2_4' ELSE 'sfr' END AS asset,
         count(DISTINCT lower(trim(buyer)))::int AS investor_buyers_36m
    FROM public.mi_buyer_activity
   WHERE build_id = (SELECT max(build_id) FROM public.mi_buyer_activity)
     AND is_investor AND sold_on >= (current_date - interval '36 months')
   GROUP BY 1, 2
), t AS (
  SELECT r.*,
         coalesce(b.investor_buyers_36m, 0) AS investor_buyers_36m,
         round(100 * least(1, ln(1 + greatest(r.qualified_sale_count,0)) / ln(1 + 250)))::smallint AS liquidity,
         round(100 * least(1, ln(1 + coalesce(b.investor_buyers_36m,0)) / ln(1 + 20)))::smallint AS buyer_depth,
         CASE WHEN r.buyer_known_count >= 8
              THEN round(100 * least(1, (r.investor_count::numeric / r.buyer_known_count) / 0.5))::smallint END AS investor_activity
    FROM r LEFT JOIN b ON b.zip = r.zip AND b.asset = r.asset
)
SELECT t.*,
       round((0.4 * liquidity + 0.4 * buyer_depth + 0.2 * coalesce(investor_activity, 0))
             / (0.8 + CASE WHEN investor_activity IS NULL THEN 0 ELSE 0.2 END))::smallint AS market_quality
  FROM t;

COMMENT ON VIEW public.v_zip_market_quality_v1 IS
  'market_quality_v1: liquidity=ln(1+qualified 1y)/ln(251); buyer_depth=ln(1+distinct investor buyers 36m)/ln(21); investor_activity=(investor/known-buyer sales)/0.5 when known>=8; weights .4/.4/.2 over known terms. Buyer names never leave the DB.';

-- ── 3. graph projection columns ──────────────────────────────────────────────
ALTER TABLE public.campaign_target_graph
  ADD COLUMN IF NOT EXISTS opportunity_tier text,
  ADD COLUMN IF NOT EXISTS seller_situation text,
  ADD COLUMN IF NOT EXISTS forced_sale_pressure smallint,
  ADD COLUMN IF NOT EXISTS sell_p365 smallint,
  ADD COLUMN IF NOT EXISTS situation_score_version text,
  ADD COLUMN IF NOT EXISTS market_quality smallint,
  ADD COLUMN IF NOT EXISTS campaign_rank_v2_score numeric(5,2),
  ADD COLUMN IF NOT EXISTS campaign_rank_v2_priority numeric(5,2),
  ADD COLUMN IF NOT EXISTS campaign_rank_v2_source text,
  ADD COLUMN IF NOT EXISTS campaign_rank_v2_at timestamptz;

COMMIT;

-- Index outside the transaction (CONCURRENTLY; no write lock on the graph).
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_target_graph_rank_v2_idx
  ON public.campaign_target_graph (queue_eligible DESC, campaign_rank_v2_priority DESC NULLS LAST, graph_id);

-- ── 4. keyset-batched projection (call repeatedly; resumable by p_after) ─────
CREATE OR REPLACE FUNCTION public.campaign_target_graph_project_rank_v2(p_after text DEFAULT '', p_limit integer DEFAULT 2000)
RETURNS TABLE(updated integer, last_property_id text)
LANGUAGE plpgsql SECURITY INVOKER SET statement_timeout = '30s' AS $$
DECLARE v_last text; v_n integer;
BEGIN
  WITH batch AS (
    SELECT g.property_id FROM public.campaign_target_graph g
     WHERE g.property_id > coalesce(p_after, '') ORDER BY g.property_id LIMIT least(greatest(p_limit, 1), 5000)
  ), src AS (
    SELECT g.property_id, s.opportunity_tier, s.seller_situation, s.forced_sale_pressure, s.sell_p365, s.score_version,
           mq.market_quality,
           public.campaign_rank_v2_contact(g.identity_alignment, g.phone_type, g.usage_2_months) AS contact,
           (SELECT count(DISTINCT e->>0)::int FROM jsonb_array_elements(coalesce(s.evidence,'[]'::jsonb)) e
             WHERE (e->>1) ~ '^-?[0-9.]+$' AND (e->>1)::numeric > 0) AS stacked,
           greatest(s.landlord_fatigue, s.tax_pain, s.debt_pressure, s.property_burden) AS other_pressure,
           s.equity_unlock, g.aos_score, g.acquisition_score
      FROM batch b
      JOIN public.campaign_target_graph g ON g.property_id = b.property_id
      LEFT JOIN public.seller_situation_scores s ON s.property_id = g.property_id
      LEFT JOIN public.v_zip_market_quality_v1 mq
        ON mq.zip = left(g.property_zip, 5)
       AND mq.asset = CASE WHEN g.units_count >= 5 THEN 'mf_5_plus' WHEN g.units_count >= 2 THEN 'mf_2_4' ELSE 'sfr' END
  ), scored AS (
    SELECT src.*,
           CASE WHEN opportunity_tier IN ('A','B','C')
                THEN public.campaign_rank_v2_score(sell_p365, forced_sale_pressure, stacked, equity_unlock, other_pressure, aos_score, market_quality, contact)
           END AS v2_score
      FROM src
  ), upd AS (
    UPDATE public.campaign_target_graph g SET
      opportunity_tier = s.opportunity_tier,
      seller_situation = s.seller_situation,
      forced_sale_pressure = s.forced_sale_pressure,
      sell_p365 = s.sell_p365,
      situation_score_version = s.score_version,
      market_quality = s.market_quality,
      campaign_rank_v2_score = s.v2_score,
      campaign_rank_v2_priority = public.campaign_rank_v2_priority(s.opportunity_tier, s.v2_score, s.acquisition_score),
      campaign_rank_v2_source = CASE WHEN s.v2_score IS NOT NULL THEN 'v2' WHEN s.acquisition_score IS NOT NULL THEN 'legacy_fallback' ELSE 'unranked' END,
      campaign_rank_v2_at = now()
      FROM scored s
     WHERE g.property_id = s.property_id
       AND (g.campaign_rank_v2_priority IS DISTINCT FROM public.campaign_rank_v2_priority(s.opportunity_tier, s.v2_score, s.acquisition_score)
         OR g.opportunity_tier IS DISTINCT FROM s.opportunity_tier
         OR g.market_quality IS DISTINCT FROM s.market_quality)
    RETURNING g.property_id
  )
  SELECT count(*)::int INTO v_n FROM upd;
  SELECT max(property_id) INTO v_last FROM (
    SELECT property_id FROM public.campaign_target_graph WHERE property_id > coalesce(p_after,'') ORDER BY property_id LIMIT least(greatest(p_limit,1),5000)
  ) x;
  RETURN QUERY SELECT v_n, v_last;
END $$;

-- ── 5. campaign discovery (zip_discovery_v1; see campaign-discovery.js) ──────
CREATE OR REPLACE VIEW public.v_campaign_zip_discovery_v1 AS
SELECT left(g.property_zip, 5) AS zip,
       CASE WHEN g.units_count >= 5 THEN 'mf_5_plus' WHEN g.units_count >= 2 THEN 'mf_2_4' ELSE 'sfr' END AS asset,
       min(g.market) AS market, min(g.state) AS state,
       count(*) AS sellers_in_graph,
       count(*) FILTER (WHERE g.queue_eligible) AS reachable,
       count(*) FILTER (WHERE g.queue_eligible AND g.opportunity_tier = 'A') AS tier_a,
       count(*) FILTER (WHERE g.queue_eligible AND g.opportunity_tier = 'B') AS tier_b,
       count(*) FILTER (WHERE g.queue_eligible AND g.opportunity_tier = 'C') AS tier_c,
       count(*) FILTER (WHERE g.queue_eligible AND g.opportunity_tier = 'A') AS high_pressure,  -- acute tier A; FSP not calibrated (§10)
       percentile_cont(0.5) WITHIN GROUP (ORDER BY g.equity_percent) FILTER (WHERE g.queue_eligible) AS median_equity_percent,
       max(g.market_quality) AS market_quality,
       round((count(*) FILTER (WHERE g.queue_eligible AND g.opportunity_tier = 'A')
            + 0.5 * count(*) FILTER (WHERE g.queue_eligible AND g.opportunity_tier = 'B'))
            * coalesce(max(g.market_quality), 50) / 100.0, 1) AS discovery_score
  FROM public.campaign_target_graph g
 WHERE g.property_zip ~ '^[0-9]{5}'
 GROUP BY 1, 2;

-- Read-only RPC; the scope (state/market) bounds the scan, the index on
-- (state, market) already exists on the graph.
CREATE OR REPLACE FUNCTION public.campaign_zip_discovery(p_state text DEFAULT NULL, p_market text DEFAULT NULL, p_asset text DEFAULT NULL, p_limit integer DEFAULT 25)
RETURNS SETOF public.v_campaign_zip_discovery_v1
LANGUAGE sql STABLE SECURITY INVOKER SET statement_timeout = '30s' AS $$
  SELECT * FROM public.v_campaign_zip_discovery_v1 d
   WHERE (p_state IS NULL OR d.state = p_state)
     AND (p_market IS NULL OR d.market = p_market)
     AND (p_asset IS NULL OR d.asset = p_asset)
     AND d.reachable >= 10
     AND (d.tier_a + 0.5 * d.tier_b) >= 1
   ORDER BY d.discovery_score DESC, d.high_pressure DESC, d.zip
   LIMIT least(greatest(p_limit, 1), 200)
$$;

REVOKE ALL ON FUNCTION public.campaign_zip_discovery(text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.campaign_zip_discovery(text, text, text, integer) TO service_role, authenticated;
REVOKE ALL ON FUNCTION public.campaign_target_graph_project_rank_v2(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_target_graph_project_rank_v2(text, integer) TO service_role;
