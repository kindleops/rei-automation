-- =====================================================================
-- Offerr hosted-staging base schema bootstrap
-- =====================================================================
--
-- WHY THIS FILE EXISTS
-- --------------------
-- The Offerr evaluation spine depends on five database objects. Only one of
-- them is defined anywhere in this repository:
--
--   object                              defined in repo?
--   ----------------------------------  ----------------------------------
--   public.system_control               YES — supabase/migrations/
--                                             20260428_create_system_control.sql
--   public.properties                   NO  — production-only
--   public.buyer_comp_raw_v2            NO  — production-only
--   public.buyer_entities_v2            NO  — production-only
--   public.get_comp_candidates_for_subject(...)  NO — production-only
--
-- Verified 2026-07-30 by searching every *.sql in the repository. The four
-- production-only objects were created out of band and are not reproducible
-- from the migration tree. Creating an empty Supabase project therefore does
-- NOT yield a schema the Offerr spine can run against, and replaying the
-- 120-migration history would not create them either.
--
-- This file is the "small deterministic staging bootstrap" alternative to
-- cloning production. It creates the minimum representative base schema, with
-- no production data, no secrets, and no outbound configuration.
--
--
-- WHAT THIS FILE IS NOT
-- ---------------------
-- `get_comp_candidates_for_subject` here is a BEHAVIOURAL STAND-IN: same
-- signature, same return contract, deterministic implementation. It is not a
-- copy of production's SQL, which is unavailable to this repository.
--
--   => Hosted staging using this bootstrap proves how OFFERR HANDLES comp
--      data (depth, contamination, package clusters, fail-closed gates).
--   => It does NOT validate production's own comp retrieval SQL.
--
-- That distinction must survive into any rollout decision. Treat production
-- comp-SQL parity as a separate, still-open verification item.
--
--
-- SAFETY
-- ------
-- Section 0 aborts if the target database looks like production. That check is
-- a last line of defence only — the operator is still responsible for pointing
-- psql at the staging project. Never run this against lcppdrmrdfblstpcbgpf.
--
--   psql "$OFFERR_STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f apps/api/scripts/offerr/offerr-staging-bootstrap.sql
--
-- Idempotent: safe to re-run. Every statement is CREATE ... IF NOT EXISTS or
-- CREATE OR REPLACE.
-- =====================================================================


-- ── 0. Fail closed if this looks like production ─────────────────────────
DO $$
DECLARE
  foreign_rows bigint;
BEGIN
  IF to_regclass('public.properties') IS NOT NULL THEN
    -- A staging database only ever holds synthetic OFFERR-STAGING-TEST- rows.
    -- Any other row means this is a real dataset: refuse immediately.
    EXECUTE $q$
      SELECT count(*) FROM public.properties
      WHERE property_id IS NULL OR property_id NOT LIKE 'OFFERR-STAGING-TEST-%'
    $q$ INTO foreign_rows;

    IF foreign_rows > 0 THEN
      RAISE EXCEPTION
        'REFUSING TO BOOTSTRAP: public.properties already holds % non-synthetic row(s). '
        'This database is not an empty Offerr staging project. Aborting before any DDL.',
        foreign_rows;
    END IF;
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ── 1. system_control (canonical shape, staging-safe flag state) ─────────
-- Mirrors 20260428_create_system_control.sql, MINUS its production seed. That
-- migration seeds outbound_sms_enabled/feeder_enabled/queue_runner_enabled to
-- 'true'; staging must never inherit those.
CREATE TABLE IF NOT EXISTS public.system_control (
  key        text        PRIMARY KEY,
  value      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.set_system_control_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_system_control_updated_at ON public.system_control;
CREATE TRIGGER trg_system_control_updated_at
  BEFORE UPDATE ON public.system_control
  FOR EACH ROW EXECUTE FUNCTION public.set_system_control_updated_at();

-- Every automation / outbound flag is pinned OFF in staging. Unlike the
-- production migration these use DO UPDATE, so a re-run re-asserts safety
-- rather than silently leaving a flag someone flipped on.
INSERT INTO public.system_control (key, value) VALUES
  ('outbound_sms_enabled',                'false'),
  ('feeder_enabled',                      'false'),
  ('queue_runner_enabled',                'false'),
  ('retry_enabled',                       'false'),
  ('reconcile_enabled',                   'false'),
  ('podio_sync_enabled',                  'false'),
  ('discord_alerts_enabled',              'false'),
  ('discord_actions_enabled',             'false'),
  ('email_enabled',                       'false'),
  ('verification_textgrid_send_enabled',  'false'),
  ('buyer_sms_blast_enabled',             'false'),
  ('campaign_auto_reply_enabled',         'false'),
  ('dashboard_live_enabled',              'false'),
  -- Offerr's own flag. Default OFF; Phase 11/12 toggles it deliberately.
  ('offerr_evaluation_enabled',           'false')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

ALTER TABLE public.system_control ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_control_service_all ON public.system_control;
CREATE POLICY system_control_service_all ON public.system_control
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS system_control_authed_read ON public.system_control;
CREATE POLICY system_control_authed_read ON public.system_control
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS system_control_anon_read ON public.system_control;
CREATE POLICY system_control_anon_read ON public.system_control
  FOR SELECT TO anon USING (true);


-- ── 2. properties — canonical subject table ──────────────────────────────
-- Column set matches PROPERTIES_FIXTURE_DDL in offerr-staging-fixtures.mjs so
-- the same fixture loader drives local and hosted runs. Columns are the ones
-- offerr-property-resolution.js selects plus what classifyAssetLane reads.
CREATE TABLE IF NOT EXISTS public.properties (
  property_id            text PRIMARY KEY,
  property_export_id     text,
  property_address_full  text,
  property_address       text,
  property_address_city  text,
  property_address_state text,
  property_address_zip   text,
  market                 text,
  property_type          text,
  property_class         text,
  building_square_feet   numeric,
  units_count            integer,
  estimated_value        numeric,
  latitude               double precision,
  longitude              double precision
);

-- The resolver does: ilike(property_address_full, '<num> %')
--                AND ilike(property_address_full, '%<token>%') LIMIT 25.
-- A trigram index keeps that bounded scan cheap as fixtures accumulate.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_properties_address_full_trgm
  ON public.properties USING gin (property_address_full gin_trgm_ops);


-- ── 3. buyer_comp_raw_v2 — comp identity source ──────────────────────────
-- First block: exactly the columns RAW_IDENTITY_SELECT reads in
-- compCandidateLoader.js. Second block: geography/characteristics the
-- bootstrap RPC needs to emit the candidate contract. In production those
-- come from other joined sources; keeping them here makes staging
-- self-contained and deterministic.
CREATE TABLE IF NOT EXISTS public.buyer_comp_raw_v2 (
  id                    text PRIMARY KEY,
  property_id           text,
  apn_parcel_id         text,
  owner_name            text,
  owner_1_name          text,
  is_corporate_owner    boolean,
  out_of_state_owner    boolean,
  owner_address_full    text,
  document_type         text,
  last_sale_doc_type    text,
  recording_date        date,
  sale_price            numeric,
  mls_sold_price        numeric,
  subdivision_name      text,
  school_district_name  text,
  effective_year_built  integer,
  total_loan_amt        numeric,
  total_loan_balance    numeric,
  total_loan_payment    numeric,
  lienholder_name       text,
  -- staging-only characteristics backing the bootstrap RPC
  mls_sold_date         date,
  address               text,
  city                  text,
  state                 text,
  zip                   text,
  latitude              double precision,
  longitude             double precision,
  beds                  numeric,
  baths                 numeric,
  sqft                  numeric,
  year_built            integer,
  units_count           integer,
  property_type         text,
  asset_class           text,
  building_condition    text,
  construction_type     text
);

CREATE INDEX IF NOT EXISTS idx_buyer_comp_raw_v2_recording_date
  ON public.buyer_comp_raw_v2 (recording_date DESC);
CREATE INDEX IF NOT EXISTS idx_buyer_comp_raw_v2_geo
  ON public.buyer_comp_raw_v2 (latitude, longitude);


-- ── 4. buyer_entities_v2 — buy-box enrichment (optional path) ────────────
-- compCandidateLoader treats a failure here as non-fatal; it is still created
-- so the enrichment branch executes for real instead of being skipped.
CREATE TABLE IF NOT EXISTS public.buyer_entities_v2 (
  buyer_key               text PRIMARY KEY,
  normalized_buyer_name   text,
  markets_active          text[],
  purchase_count          integer,
  avg_purchase_price      numeric,
  preferred_asset_classes text[]
);

-- Loader filters with .in('normalized_buyer_name', [...]).
CREATE INDEX IF NOT EXISTS idx_buyer_entities_v2_normalized_name
  ON public.buyer_entities_v2 (normalized_buyer_name);


-- ── 5. get_comp_candidates_for_subject — staging stand-in ────────────────
-- Signature and return contract taken from compCandidateLoader.js (the RPC
-- call) and compIdentityEnrichment.js normalizeCandidate() (the fields read).
--
-- Deterministic by construction: great-circle distance filter, recency window,
-- then a stable ORDER BY. No random sampling, no time-of-day dependence beyond
-- the explicit p_months_back window.
CREATE OR REPLACE FUNCTION public.get_comp_candidates_for_subject(
  p_subject_property_id text,
  p_radius_miles        numeric DEFAULT 4,
  p_months_back         integer DEFAULT 30,
  p_limit               integer DEFAULT 100
)
RETURNS TABLE (
  comp_id            text,
  id                 text,
  property_id        text,
  address            text,
  city               text,
  state              text,
  zip                text,
  latitude           double precision,
  longitude          double precision,
  sale_price         numeric,
  sale_date          date,
  mls_sold_price     numeric,
  mls_sold_date      date,
  beds               numeric,
  baths              numeric,
  sqft               numeric,
  year_built         integer,
  units_count        integer,
  property_type      text,
  asset_class        text,
  building_condition text,
  construction_type  text,
  distance_miles     numeric,
  similarity_score   numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH subject AS (
    SELECT p.latitude AS lat, p.longitude AS lon, p.building_square_feet AS sqft
    FROM public.properties p
    WHERE p.property_id = p_subject_property_id
  ),
  scored AS (
    SELECT
      c.id,
      c.property_id,
      c.address, c.city, c.state, c.zip,
      c.latitude, c.longitude,
      c.sale_price, c.recording_date, c.mls_sold_price, c.mls_sold_date,
      c.beds, c.baths, c.sqft, c.year_built, c.units_count,
      c.property_type, c.asset_class, c.building_condition, c.construction_type,
      -- Great-circle distance in miles (3958.7566 mi mean Earth radius).
      (3958.7566 * 2 * asin(sqrt(
         power(sin(radians(c.latitude - s.lat) / 2), 2)
         + cos(radians(s.lat)) * cos(radians(c.latitude))
         * power(sin(radians(c.longitude - s.lon) / 2), 2)
      )))::numeric AS dist_mi,
      s.sqft AS subject_sqft
    FROM public.buyer_comp_raw_v2 c
    CROSS JOIN subject s
    WHERE c.latitude IS NOT NULL
      AND c.longitude IS NOT NULL
      AND c.recording_date IS NOT NULL
      AND c.recording_date >= (CURRENT_DATE - make_interval(months => p_months_back))
      AND c.id IS DISTINCT FROM p_subject_property_id
  )
  SELECT
    scored.id                       AS comp_id,
    scored.id                       AS id,
    scored.property_id,
    scored.address, scored.city, scored.state, scored.zip,
    scored.latitude, scored.longitude,
    scored.sale_price,
    scored.recording_date           AS sale_date,
    scored.mls_sold_price, scored.mls_sold_date,
    scored.beds, scored.baths, scored.sqft, scored.year_built, scored.units_count,
    scored.property_type, scored.asset_class,
    scored.building_condition, scored.construction_type,
    round(scored.dist_mi, 4)        AS distance_miles,
    -- Simple, explainable similarity: distance decay blended with size parity.
    round(
      greatest(0::numeric, least(1::numeric,
        (1::numeric - (scored.dist_mi / nullif(p_radius_miles, 0)))
        * CASE
            WHEN scored.subject_sqft IS NULL OR scored.sqft IS NULL
              OR scored.subject_sqft <= 0 OR scored.sqft <= 0 THEN 0.80::numeric
            ELSE greatest(0::numeric, 1::numeric - (
              abs(scored.sqft - scored.subject_sqft) / scored.subject_sqft
            ))
          END
      )), 4)                        AS similarity_score
  FROM scored
  WHERE scored.dist_mi <= p_radius_miles
  -- Deterministic total order; `id` last so ties never reorder between runs.
  ORDER BY scored.dist_mi ASC, scored.recording_date DESC, scored.id ASC
  LIMIT greatest(1, coalesce(p_limit, 100));
$$;


-- ── 6. Grants ────────────────────────────────────────────────────────────
-- The Offerr API reaches these as service_role. anon/authenticated get no
-- access to comp internals; `properties` and `system_control` keep the read
-- posture the canonical migration established.
REVOKE ALL ON public.buyer_comp_raw_v2 FROM anon, authenticated;
REVOKE ALL ON public.buyer_entities_v2 FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_comp_candidates_for_subject(text, numeric, integer, integer)
  FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.properties            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.buyer_comp_raw_v2     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.buyer_entities_v2     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.system_control        TO service_role;
GRANT EXECUTE ON FUNCTION public.get_comp_candidates_for_subject(text, numeric, integer, integer)
  TO service_role;


-- ── 7. Post-bootstrap assertion ──────────────────────────────────────────
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.system_control')     IS NULL THEN missing := missing || 'system_control';     END IF;
  IF to_regclass('public.properties')         IS NULL THEN missing := missing || 'properties';         END IF;
  IF to_regclass('public.buyer_comp_raw_v2')  IS NULL THEN missing := missing || 'buyer_comp_raw_v2';  END IF;
  IF to_regclass('public.buyer_entities_v2')  IS NULL THEN missing := missing || 'buyer_entities_v2';  END IF;
  IF to_regproc('public.get_comp_candidates_for_subject') IS NULL
    THEN missing := missing || 'get_comp_candidates_for_subject'; END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Offerr staging bootstrap incomplete. Missing: %', array_to_string(missing, ', ');
  END IF;

  RAISE NOTICE 'Offerr staging bootstrap OK — 4 tables + 1 function present.';
  RAISE NOTICE 'offerr_evaluation_enabled is pinned false. Apply the Offerr migration next.';
END $$;
