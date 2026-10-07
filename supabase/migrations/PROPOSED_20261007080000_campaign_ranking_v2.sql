-- PROPOSED — NOT APPLIED. MIGRATION (b): ORDERING-AFFECTING — stays SEPARATE and UNAPPLIED.
-- (Schema-only support is migration (a): PROPOSED_20261007090000_ranking_shadow_support.sql.)
-- Acquisition OS ranking v2.1 (owner rebuild 2026-10-07, agent A2).
-- Owner approval required (§86/§87). Rollback: PROPOSED_20261007080000_campaign_ranking_v2_rollback.sql
--
-- CAMPAIGN RANKING v2.1 — the SQL twin of
--   apps/api/src/lib/domain/campaigns/ranking-v2/campaign-rank-v2.js  (+ contact-evidence.js)
-- (formula-identical; tests pin both). Layers: L1 contact confidence → L2 seller
-- pressure CONDITIONAL on contact → L3 deal (equity KNOWN only) → L4 market.
--   priority = 0.4·L1 + 0.3·L2·L1/100 + 0.15·L3 + 0.15·L4
-- No tier bands. Legacy acquisition_score is read only as a marked L2 fallback.
-- Market response-rate context is NOT persisted (refit + capped ±4 in the app).
--
-- Depends on PROPOSED_20261007071100_seller_situation_scores.sql (A1).
-- Cost: keyset-batched UPDATE (≤ 5,000 rows/call, statement_timeout 30 s),
-- off-peak, never a trigger; ~12 narrow columns ≈ 50 B/row ≈ 9 MB + one btree.

BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';

-- ── 1. formula functions (immutable, no table access) ────────────────────────

-- equity_known_v1: a 0/blank loan is NOT proof of no debt. Known only when
-- loan>0 & value>0, or (loan 0/blank AND vendor "Free And Clear" flag AND value>0).
CREATE OR REPLACE FUNCTION public.campaign_equity_known_pct(p_value numeric, p_loan numeric, p_flags text)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_value > 0 AND p_loan > 0 THEN greatest(-100, least(100, round(((p_value - p_loan) / p_value) * 1000) / 10))
    WHEN p_value > 0 AND coalesce(p_loan, 0) = 0 AND lower(coalesce(p_flags,'')) ~ '(^|;\s*)free and clear(\s*;|$)' THEN 100
    ELSE NULL
  END
$$;

-- 'high' | 'low' | 'unknown' (vendor High/Low Equity flag gives a class without a %)
CREATE OR REPLACE FUNCTION public.campaign_equity_class(p_value numeric, p_loan numeric, p_flags text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN public.campaign_equity_known_pct(p_value, p_loan, p_flags) IS NOT NULL
      THEN CASE WHEN public.campaign_equity_known_pct(p_value, p_loan, p_flags) >= 40 THEN 'high' ELSE 'low' END
    WHEN lower(coalesce(p_flags,'')) ~ '(^|;\s*)high equity(\s*;|$)' THEN 'high'
    WHEN lower(coalesce(p_flags,'')) ~ '(^|;\s*)low equity(\s*;|$)' THEN 'low'
    ELSE 'unknown'
  END
$$;

-- Identity tier (contact-evidence.js identityTier): a missing tag is absence of evidence.
CREATE OR REPLACE FUNCTION public.campaign_identity_tier(p_identity text, p_tag text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN lower(coalesce(p_identity,'')) = 'mismatch' THEN 'contradictory'
    WHEN p_tag = 'renter_no_owner' AND lower(coalesce(p_identity,'')) IN ('verified','probable','entity_company_linked') THEN 'contradictory'
    WHEN lower(coalesce(p_identity,'')) = 'verified' THEN CASE WHEN p_tag IN ('likely_owner','linked_to_company') THEN 'strongest' WHEN p_tag IS NULL THEN 'strong' ELSE 'moderate' END
    WHEN lower(coalesce(p_identity,'')) = 'probable' THEN CASE WHEN p_tag IN ('likely_owner','linked_to_company') THEN 'strong' ELSE 'moderate' END
    WHEN lower(coalesce(p_identity,'')) = 'entity_company_linked' THEN CASE WHEN p_tag = 'linked_to_company' THEN 'strong' ELSE 'moderate' END
    WHEN lower(coalesce(p_identity,'')) = 'unknown' THEN CASE WHEN p_tag IN ('likely_owner','linked_to_company') THEN 'moderate' ELSE 'weak' END
    WHEN p_tag IN ('likely_owner','linked_to_company') THEN 'moderate'
    WHEN p_tag IN ('renter_no_owner','potential_owner','potentially_linked_to_company','family_only') THEN 'weak'
    ELSE 'none'
  END
$$;

-- L1 contact confidence 0–100 (contact-evidence.js CONTACT_POINTS; max raw 92).
-- p_tag: likely_owner | linked_to_company | potential_owner | potentially_linked_to_company
--        | family_only | renter_no_owner | NULL (missing)
CREATE OR REPLACE FUNCTION public.campaign_rank_v2_contact(p_identity text, p_phone_type text, p_usage text, p_tag text, p_phone_owner_count integer)
RETURNS smallint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT greatest(0, least(100, round((
      CASE upper(coalesce(p_phone_type,'')) WHEN 'W' THEN 30 WHEN 'L' THEN 4 ELSE 14 END
    + CASE public.campaign_identity_tier(p_identity, p_tag) WHEN 'strongest' THEN 52 WHEN 'strong' THEN 44 WHEN 'moderate' THEN 34
        WHEN 'weak' THEN 14 WHEN 'contradictory' THEN 4 ELSE 20 END
    + CASE lower(coalesce(p_usage,'')) WHEN 'very heavy usage' THEN 10 WHEN 'heavy usage' THEN 10 WHEN 'moderate usage' THEN 8
        WHEN 'light usage' THEN 5 WHEN 'minimal usage' THEN 0 ELSE 5 END
    + CASE WHEN p_phone_owner_count > 1 THEN -15 ELSE 0 END
  )::numeric / 92 * 100)))::smallint
$$;

-- prospects.matching_flags → tag class (contact-evidence.js matchingTagClass)
CREATE OR REPLACE FUNCTION public.campaign_matching_tag_class(p_flags text, p_entity_owned boolean)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN nullif(trim(coalesce(p_flags,'')), '') IS NULL THEN NULL
    WHEN lower(p_flags) ~ '(^|,\s*)likely owner(\s*,|$)' THEN 'likely_owner'
    WHEN lower(p_flags) ~ '(^|,\s*)linked to company(\s*,|$)' THEN CASE WHEN p_entity_owned THEN 'linked_to_company' ELSE 'potential_owner' END
    WHEN lower(p_flags) ~ '(^|,\s*)potential owner(\s*,|$)' THEN 'potential_owner'
    WHEN lower(p_flags) ~ 'potentially linked to company' THEN 'potentially_linked_to_company'
    WHEN lower(p_flags) ~ '(resident|likely renting)' THEN 'renter_no_owner'
    WHEN lower(p_flags) ~ 'family' THEN 'family_only'
    ELSE NULL
  END
$$;

-- L2 seller pressure 0–100 (unknown → prior). Tier points A 100 / B 65 / C 25.
CREATE OR REPLACE FUNCTION public.campaign_rank_v2_pressure(p_tier text, p_sell365 numeric, p_forced_sale numeric, p_stacked_codes integer, p_other_pressure numeric, p_legacy numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_tier IN ('A','B','C') THEN round((
        0.3 * CASE p_tier WHEN 'A' THEN 100 WHEN 'B' THEN 65 ELSE 25 END
      + 0.25 * coalesce(least(greatest(p_sell365, 0), 100), 20)
      + 0.2 * coalesce(least(greatest(p_forced_sale, 0), 100), 20)
      + 0.1 * least(coalesce(p_stacked_codes, 0) * 15, 100)
      + 0.15 * coalesce(least(greatest(p_other_pressure, 0), 100), 20))::numeric, 2)
    WHEN p_legacy IS NOT NULL THEN round(least(50, least(greatest(p_legacy,0),100) / 2)::numeric, 2)  -- marked legacy_fallback
    ELSE 25
  END
$$;

-- L3 deal 0–100: 0.75·equity term + 0.25·valuation term
CREATE OR REPLACE FUNCTION public.campaign_rank_v2_deal(p_equity_pct numeric, p_equity_class text, p_value numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT round((0.75 * CASE
                  WHEN p_equity_pct IS NOT NULL THEN greatest(0, least(100, p_equity_pct))
                  WHEN p_equity_class = 'high' THEN 70
                  WHEN p_equity_class = 'low' THEN 25
                  ELSE 45 END
              + 0.25 * CASE WHEN p_value > 0 THEN 70 ELSE 30 END)::numeric, 2)
$$;

-- priority 0–100 (no bands). p_market = market_quality (NULL → 50). Response
-- context is applied in the app only (refit, capped ±4) and never stored.
CREATE OR REPLACE FUNCTION public.campaign_rank_v2_priority(p_contact numeric, p_pressure numeric, p_deal numeric, p_market numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT round((0.4 * p_contact
              + 0.3 * p_pressure * (p_contact / 100)   -- pure gate: distress is only as reachable as the contact
              + 0.15 * p_deal
              + 0.15 * coalesce(least(greatest(p_market,0),100), 50))::numeric, 2)
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
  ADD COLUMN IF NOT EXISTS matching_tag text,
  ADD COLUMN IF NOT EXISTS contact_confidence smallint,
  ADD COLUMN IF NOT EXISTS equity_known_pct numeric(5,1),
  ADD COLUMN IF NOT EXISTS equity_class text,
  ADD COLUMN IF NOT EXISTS campaign_rank_v2_priority numeric(5,2),
  ADD COLUMN IF NOT EXISTS campaign_rank_v2_source text,
  ADD COLUMN IF NOT EXISTS campaign_rank_v2_at timestamptz;

COMMIT;

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
  ), phones AS (   -- distinct owners per phone, for the batch's phones only (indexed canonical_e164)
    SELECT g2.canonical_e164, count(DISTINCT g2.master_owner_id)::int AS owners
      FROM public.campaign_target_graph g2
     WHERE g2.canonical_e164 IN (SELECT g.canonical_e164 FROM batch b JOIN public.campaign_target_graph g USING (property_id) WHERE g.canonical_e164 IS NOT NULL)
     GROUP BY 1
  ), src AS (
    SELECT g.property_id, s.opportunity_tier, s.seller_situation, s.forced_sale_pressure, s.sell_p365, s.score_version,
           mq.market_quality, g.acquisition_score, g.estimated_value,
           public.campaign_equity_known_pct(g.estimated_value, g.total_loan_balance, g.property_flags_text) AS eq_pct,
           public.campaign_equity_class(g.estimated_value, g.total_loan_balance, g.property_flags_text) AS eq_class,
           public.campaign_matching_tag_class(pr.matching_flags, coalesce(g.is_corporate_owner, false)) AS tag,
           ph.owners AS phone_owners,
           g.identity_alignment, g.phone_type, g.usage_2_months,
           (SELECT count(DISTINCT e->>0)::int FROM jsonb_array_elements(coalesce(s.evidence,'[]'::jsonb)) e
             WHERE (e->>1) ~ '^-?[0-9.]+$' AND (e->>1)::numeric > 0) AS stacked,
           greatest(s.landlord_fatigue, s.tax_pain, s.debt_pressure, s.property_burden) AS other_pressure
      FROM batch b
      JOIN public.campaign_target_graph g ON g.property_id = b.property_id
      LEFT JOIN public.seller_situation_scores s ON s.property_id = g.property_id
      LEFT JOIN LATERAL (SELECT p.matching_flags FROM public.prospects p WHERE p.individual_key = g.seller_person_key AND p.matching_flags IS NOT NULL LIMIT 1) pr ON true
      LEFT JOIN phones ph ON ph.canonical_e164 = g.canonical_e164
      LEFT JOIN public.v_zip_market_quality_v1 mq
        ON mq.zip = left(g.property_zip, 5)
       AND mq.asset = CASE WHEN g.units_count >= 5 THEN 'mf_5_plus' WHEN g.units_count >= 2 THEN 'mf_2_4' ELSE 'sfr' END
  ), scored AS (
    SELECT src.*,
           public.campaign_rank_v2_contact(identity_alignment, phone_type, usage_2_months, tag, phone_owners) AS contact,
           public.campaign_rank_v2_pressure(opportunity_tier, sell_p365, forced_sale_pressure, stacked, other_pressure, acquisition_score) AS pressure,
           public.campaign_rank_v2_deal(eq_pct, eq_class, estimated_value) AS deal
      FROM src
  ), upd AS (
    UPDATE public.campaign_target_graph g SET
      opportunity_tier = s.opportunity_tier,
      seller_situation = s.seller_situation,
      forced_sale_pressure = s.forced_sale_pressure,
      sell_p365 = s.sell_p365,
      situation_score_version = s.score_version,
      market_quality = s.market_quality,
      matching_tag = s.tag,
      contact_confidence = s.contact,
      equity_known_pct = s.eq_pct,
      equity_class = s.eq_class,
      campaign_rank_v2_priority = public.campaign_rank_v2_priority(s.contact, s.pressure, s.deal, s.market_quality),
      campaign_rank_v2_source = CASE WHEN s.opportunity_tier IN ('A','B','C') THEN 'v2' WHEN s.acquisition_score IS NOT NULL THEN 'legacy_fallback' ELSE 'v2_no_situation' END,
      campaign_rank_v2_at = now()
      FROM scored s
     WHERE g.property_id = s.property_id
       AND (g.campaign_rank_v2_priority IS DISTINCT FROM public.campaign_rank_v2_priority(s.contact, s.pressure, s.deal, s.market_quality)
         OR g.opportunity_tier IS DISTINCT FROM s.opportunity_tier
         OR g.equity_class IS DISTINCT FROM s.eq_class)
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
       percentile_cont(0.5) WITHIN GROUP (ORDER BY g.equity_known_pct) FILTER (WHERE g.queue_eligible AND g.equity_known_pct IS NOT NULL) AS median_known_equity_percent,
       count(*) FILTER (WHERE g.queue_eligible AND g.equity_known_pct IS NOT NULL) AS equity_known,
       count(*) FILTER (WHERE g.queue_eligible AND g.contact_confidence >= 75) AS contact_high,
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
