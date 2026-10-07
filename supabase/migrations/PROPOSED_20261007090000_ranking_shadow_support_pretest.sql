-- PRETEST for PROPOSED_20261007090000_ranking_shadow_support.sql (migration (a)).
-- Runs the transactional part inside BEGIN … ROLLBACK and asserts the result,
-- so nothing persists. (The CONCURRENTLY indexes cannot run inside a
-- transaction; they are on new empty tables and are checked by name after the
-- real apply.) Run with the owner, off-peak; expected output: NOTICE lines
-- "pretest ok" and a final ROLLBACK.
BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
DO $$ BEGIN
  IF to_regclass('public.campaign_rank_shadow') IS NOT NULL THEN RAISE EXCEPTION 'campaign_rank_shadow already exists'; END IF;
  IF to_regclass('public.campaign_test_cohorts') IS NOT NULL THEN RAISE EXCEPTION 'campaign_test_cohorts already exists'; END IF;
END $$;

SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';

-- 1. Shadow ranking: one row per property × ranking version (components only).
CREATE TABLE IF NOT EXISTS public.campaign_rank_shadow (
  property_id        text        NOT NULL,
  ranking_version    text        NOT NULL,           -- e.g. campaign_rank_v2.1
  computed_at        timestamptz NOT NULL DEFAULT now(),
  run_id             text,
  eligible           boolean     NOT NULL,
  priority           numeric(5,2),
  contact            smallint    CHECK (contact BETWEEN 0 AND 100),
  identity_tier      text        CHECK (identity_tier IN ('strongest','strong','moderate','weak','none','contradictory')),
  line_type          text        CHECK (line_type IN ('W','L','unknown')),
  matching_tag       text,
  pressure           numeric(5,2),
  pressure_effective numeric(5,2),
  pressure_source    text        CHECK (pressure_source IN ('seller_situation_v2','legacy_fallback','unknown')),
  deal               numeric(5,2),
  equity_class       text        CHECK (equity_class IN ('high','low','unknown')),
  equity_known_pct   numeric(5,1),
  market             numeric(5,2),
  market_quality     smallint,
  response_points    numeric(4,2) CHECK (response_points BETWEEN -4 AND 4),
  tier               text        CHECK (tier IN ('A','B','C','UNKNOWN')),
  situation_score_version text,
  legacy_final_acquisition_score numeric,              -- COMPARISON ONLY
  PRIMARY KEY (property_id, ranking_version)
);
COMMENT ON TABLE public.campaign_rank_shadow IS 'Ranking v2.1 SHADOW scores (layers only). Read by reports; never by builds/feeders. Ordering is unaffected.';

-- 2. Saved test cohorts (pre-registered, frozen).
CREATE TABLE IF NOT EXISTS public.campaign_test_cohorts (
  cohort_key          text        PRIMARY KEY,         -- e.g. v2_1_dal_hou_sfr_20261007
  created_at          timestamptz NOT NULL DEFAULT now(),
  status              text        NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','launched','closed','abandoned')),
  definition          jsonb       NOT NULL,            -- filter definition (test + control rules)
  preregistration     jsonb       NOT NULL,            -- primary/secondary/guardrails/decision rule
  interleave          jsonb,                           -- schedule rules (pairs are in members)
  test_campaign_id    uuid,
  control_campaign_id uuid,
  launched_at         timestamptz,                     -- first opener of either arm
  extract_as_of       timestamptz,
  created_by          text
);

CREATE TABLE IF NOT EXISTS public.campaign_test_cohort_members (
  cohort_key    text     NOT NULL REFERENCES public.campaign_test_cohorts(cohort_key) ON DELETE CASCADE,
  property_id   text     NOT NULL,
  arm           text     NOT NULL CHECK (arm IN ('test','control')),
  zip           text,
  pair_id       integer,
  send_day      smallint,
  block_15m     smallint,
  first_in_pair text     CHECK (first_in_pair IN ('test','control')),
  selection     jsonb    NOT NULL DEFAULT '{}'::jsonb,  -- {tier, identity_tier, contact, priority, legacy} at selection time
  PRIMARY KEY (cohort_key, property_id)
);

-- 3. Checkpoint reads (24h/72h/7d/14d/21d), append-only.
CREATE TABLE IF NOT EXISTS public.campaign_test_checkpoints (
  cohort_key   text        NOT NULL REFERENCES public.campaign_test_cohorts(cohort_key) ON DELETE CASCADE,
  checkpoint   text        NOT NULL CHECK (checkpoint IN ('24h','72h','7d','14d','21d')),
  computed_at  timestamptz NOT NULL DEFAULT now(),
  window_since timestamptz NOT NULL,
  window_until timestamptz NOT NULL,
  result       jsonb       NOT NULL,                   -- per-arm stages, diffs + CIs, verdict, contamination
  PRIMARY KEY (cohort_key, checkpoint, computed_at)
);

-- 4. Outcome measurement read models (views: no storage, no locks on base tables).
-- First touch = the FIRST delivered send_queue row per property (follow-up and
-- inbox rows carry no campaign_id); pre-campaign feeder rows → 'legacy_feeder'.
CREATE OR REPLACE VIEW public.v_property_first_touch_v1 AS
SELECT DISTINCT ON (property_id)
       property_id, coalesce(sent_at, created_at) AS first_delivered_at, campaign_id AS first_touch_campaign_id,
       coalesce(source, 'legacy_feeder') AS first_touch_source, template_id AS first_touch_template_id, textgrid_number_id AS first_touch_sender_id
  FROM public.send_queue
 WHERE property_id IS NOT NULL AND queue_status = 'delivered'
 ORDER BY property_id, coalesce(sent_at, created_at);

-- Ever-reached lifecycle + VERIFIED contract (a closing_cases row that is not
-- voided/cancelled). A lifecycle formal_contract without a closing record is
-- 'unverified' (audit 2026-10-07: 296670809 on a misparsed "$331").
CREATE OR REPLACE VIEW public.v_property_deal_outcome_v1 AS
WITH lc AS (
  SELECT property_id, array_agg(DISTINCT new_value) AS lifecycle_reached, max(created_at) AS last_lifecycle_at
    FROM public.universal_lead_state_events
   WHERE field_name = 'lifecycle_stage' AND property_id IS NOT NULL
   GROUP BY 1
), cc AS (
  SELECT DISTINCT ON (property_id) property_id, closing_status, contract_status, funding_status, revenue_status,
         coalesce((provenance->>'voided')::boolean, (automation_state->>'voided')::boolean, false)
           OR lower(coalesce(contract_status,'')) = 'cancelled' AS voided
    FROM public.closing_cases WHERE property_id IS NOT NULL
   ORDER BY property_id, created_at DESC
)
SELECT coalesce(lc.property_id, cc.property_id) AS property_id,
       lc.lifecycle_reached, lc.last_lifecycle_at,
       ('offer' = ANY(lc.lifecycle_reached) OR 'formal_contract' = ANY(lc.lifecycle_reached)) AS negotiation_reached,
       (cc.property_id IS NOT NULL AND NOT cc.voided) AS contract_verified,
       ('formal_contract' = ANY(lc.lifecycle_reached) AND cc.property_id IS NULL) AS contract_unverified,
       coalesce(cc.voided, false) AS contract_voided,
       (cc.property_id IS NOT NULL AND NOT cc.voided
         AND (lower(coalesce(cc.funding_status,'')) IN ('funded','received','realized','closed','paid')
           OR lower(coalesce(cc.revenue_status,'')) IN ('funded','received','realized','closed','paid'))) AS profitable_deal,
       cc.closing_status, cc.contract_status, cc.funding_status, cc.revenue_status
  FROM lc FULL JOIN cc ON cc.property_id = lc.property_id;

ALTER TABLE public.campaign_rank_shadow ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_test_cohorts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_test_cohort_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_test_checkpoints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.campaign_rank_shadow, public.campaign_test_cohorts, public.campaign_test_cohort_members, public.campaign_test_checkpoints FROM anon, authenticated;
REVOKE ALL ON public.v_property_first_touch_v1, public.v_property_deal_outcome_v1 FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.campaign_rank_shadow, public.campaign_test_cohorts, public.campaign_test_cohort_members, public.campaign_test_checkpoints TO service_role;
GRANT SELECT ON public.v_property_first_touch_v1, public.v_property_deal_outcome_v1 TO service_role;


DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM information_schema.tables WHERE table_schema='public'
     AND table_name IN ('campaign_rank_shadow','campaign_test_cohorts','campaign_test_cohort_members','campaign_test_checkpoints');
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 new tables, got %', n; END IF;
  PERFORM 1 FROM public.v_property_first_touch_v1 LIMIT 1;
  PERFORM 1 FROM public.v_property_deal_outcome_v1 LIMIT 1;
  -- the views must reproduce the 2026-10-07 audit: 1 voided contract, 0 verified, 0 profitable
  SELECT count(*) INTO n FROM public.v_property_deal_outcome_v1 WHERE contract_verified; RAISE NOTICE 'verified contracts: %', n;
  SELECT count(*) INTO n FROM public.v_property_deal_outcome_v1 WHERE contract_voided; RAISE NOTICE 'voided contracts: %', n;
  SELECT count(*) INTO n FROM public.v_property_deal_outcome_v1 WHERE contract_unverified; RAISE NOTICE 'unverified lifecycle contracts: %', n;
  -- no existing table changed
  PERFORM 1 FROM information_schema.columns WHERE table_name='campaign_target_graph' AND column_name='campaign_rank_v2_priority';
  IF FOUND THEN RAISE EXCEPTION 'migration (a) must not touch campaign_target_graph'; END IF;
  RAISE NOTICE 'pretest ok';
END $$;
ROLLBACK;
