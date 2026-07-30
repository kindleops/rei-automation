-- =====================================================================
-- Offerr hosted-staging base schema bootstrap
-- =====================================================================
--
-- WHAT THIS FILE IS
-- -----------------
-- The staging-only wrapper around the CANONICAL comp-intelligence contract in
--
--   apps/api/supabase/contracts/offerr-comp-intelligence/
--
-- It contributes nothing of its own to the comp surface. Every table, view and
-- function the real comp loader touches is \ir-included from canonical/, so
-- there is exactly ONE copy of each definition in this repository and staging
-- cannot silently drift from the recovered production contract.
--
-- What this file adds on top of the canonical contract is strictly staging
-- concerns:
--   * a refuse-to-run guard for anything that is not an empty/synthetic target
--   * public.system_control with every automation flag pinned OFF
--   * the Supabase grant posture the Offerr API needs
--   * a recorded schema-contract version
--   * a post-bootstrap completeness assertion
--
--
-- PARITY STATUS (2026-07-30)
-- --------------------------
--   public.get_comp_candidates_for_subject  EXACT production definition (verbatim)
--   public.v_recent_sold_comps              EXACT production definition (verbatim)
--   public.buyer_comp_raw_v2                EXACT production column contract (167/167)
--   public.buyer_entities_v2                EXACT production column contract (49/49)
--   public.properties                       117-of-343 column read-surface subset
--   public.system_control                   canonical shape, staging-safe flag state
--
-- The behavioural stand-in that previously lived in this file is GONE. Staging
-- now executes the same comp SQL production executes. See
-- contracts/offerr-comp-intelligence/README.md for provenance, the licensing
-- review, and the enumerated deviations.
--
--
-- SAFETY
-- ------
-- Section 0 aborts before any DDL if the target holds a single non-synthetic
-- property, comp or buyer row. That is a last line of defence only — the
-- operator is still responsible for pointing psql at a disposable or staging
-- database. NEVER run this against lcppdrmrdfblstpcbgpf.
--
--   psql "$OFFERR_STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f apps/api/scripts/offerr/offerr-supabase-prereqs.sql
--   psql "$OFFERR_STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f apps/api/scripts/offerr/offerr-staging-bootstrap.sql
--
-- Idempotent: safe to re-run. Every statement is CREATE ... IF NOT EXISTS,
-- CREATE OR REPLACE, or an idempotent GRANT/REVOKE.
-- =====================================================================


-- ── 0. Fail closed on anything that is not an empty/synthetic target ─────
-- Checked BEFORE any DDL. Every fixture identifier this repository creates is
-- prefixed OFFERR-STAGING-TEST-, so a row without that prefix means real data.
DO $$
DECLARE
  foreign_properties bigint := 0;
  foreign_comps      bigint := 0;
  foreign_buyers     bigint := 0;
  problems           text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.properties') IS NOT NULL THEN
    EXECUTE $q$
      SELECT count(*) FROM public.properties
      WHERE property_id IS NULL OR property_id NOT LIKE 'OFFERR-STAGING-TEST-%'
    $q$ INTO foreign_properties;
    IF foreign_properties > 0 THEN
      problems := problems || format('public.properties holds %s non-synthetic row(s)', foreign_properties);
    END IF;
  END IF;

  -- Pre-existing comp data is refused just as hard as property data: a comp
  -- corpus is exactly what must never be present in a staging bootstrap target.
  IF to_regclass('public.buyer_comp_raw_v2') IS NOT NULL THEN
    EXECUTE $q$
      SELECT count(*) FROM public.buyer_comp_raw_v2
      WHERE source_record_id IS NULL OR source_record_id NOT LIKE 'OFFERR-STAGING-TEST-%'
    $q$ INTO foreign_comps;
    IF foreign_comps > 0 THEN
      problems := problems || format('public.buyer_comp_raw_v2 holds %s non-synthetic row(s)', foreign_comps);
    END IF;
  END IF;

  IF to_regclass('public.buyer_entities_v2') IS NOT NULL THEN
    EXECUTE $q$
      SELECT count(*) FROM public.buyer_entities_v2
      WHERE buyer_key IS NULL OR buyer_key NOT LIKE 'OFFERR-STAGING-TEST-%'
    $q$ INTO foreign_buyers;
    IF foreign_buyers > 0 THEN
      problems := problems || format('public.buyer_entities_v2 holds %s non-synthetic row(s)', foreign_buyers);
    END IF;
  END IF;

  IF array_length(problems, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'REFUSING TO BOOTSTRAP: % . This database is not an empty Offerr staging project. Aborting before any DDL.',
      array_to_string(problems, '; ');
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ── 1. system_control (canonical shape, staging-safe flag state) ─────────
-- Mirrors supabase/migrations/20260428_create_system_control.sql, MINUS its
-- production seed. That migration seeds outbound_sms_enabled / feeder_enabled /
-- queue_runner_enabled to 'true'; staging must never inherit those.
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
  -- Offerr's own flag. Default OFF; the E2E harness toggles it deliberately.
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


-- ── 2. Canonical comp-intelligence contract ──────────────────────────────
-- Included verbatim from the contract directory. \ir resolves relative to THIS
-- file's directory, so this works from any working directory.
--
-- Order matters: buyer_comp_raw_v2 must exist before the view over it, and the
-- view + properties must exist before the RPC that reads them.
\ir ../../supabase/contracts/offerr-comp-intelligence/canonical/010_properties.sql
\ir ../../supabase/contracts/offerr-comp-intelligence/canonical/020_buyer_comp_raw_v2.sql
\ir ../../supabase/contracts/offerr-comp-intelligence/canonical/030_buyer_entities_v2.sql
\ir ../../supabase/contracts/offerr-comp-intelligence/canonical/040_v_recent_sold_comps.sql
\ir ../../supabase/contracts/offerr-comp-intelligence/canonical/050_get_comp_candidates_for_subject.sql


-- ── 3. Schema-contract version marker ────────────────────────────────────
-- Lets the drift checker and the E2E harness assert that the database was
-- bootstrapped from a contract version they understand, instead of inferring
-- compatibility from the presence of objects.
--
-- DELIBERATELY *NOT* NAMED offerr_*. offerr-schema-verify.sql asserts that the
-- Offerr migration creates exactly three `offerr%` tables and that anon and
-- authenticated hold zero privileges on them; a bootstrap-owned marker in that
-- namespace would break both invariants and mask a real regression. This marker
-- describes the comp-intelligence contract, not the Offerr spine, so it is
-- named for what it is.
CREATE TABLE IF NOT EXISTS public.comp_intelligence_schema_contract (
  contract_name text        PRIMARY KEY,
  version       text        NOT NULL,
  applied_at    timestamptz NOT NULL DEFAULT now(),
  source        text        NOT NULL
);

INSERT INTO public.comp_intelligence_schema_contract (contract_name, version, source) VALUES
  ('offerr-comp-intelligence', '1.0.0',
   'apps/api/supabase/contracts/offerr-comp-intelligence (recovered read-only from lcppdrmrdfblstpcbgpf 2026-07-30)')
ON CONFLICT (contract_name) DO UPDATE
  SET version = EXCLUDED.version, source = EXCLUDED.source, applied_at = now();


-- ── 4. Grants ────────────────────────────────────────────────────────────
-- STAGING DEVIATION FROM PRODUCTION, DELIBERATE AND LOAD-BEARING:
-- production grants anon/authenticated full DML on all three comp tables and
-- EXECUTE on the RPC to PUBLIC (see contracts README §5 "Production posture
-- findings"). Staging does NOT reproduce that posture for the tables: the API
-- reaches these as service_role, and a staging database that let anon write the
-- comp corpus would make the side-effect proof meaningless.
--
-- The RPC's PUBLIC EXECUTE grant IS reproduced (in canonical/050) because the
-- RPC is read-only and its grant is part of the recovered contract.
REVOKE ALL ON public.buyer_comp_raw_v2  FROM anon, authenticated;
REVOKE ALL ON public.buyer_entities_v2  FROM anon, authenticated;
REVOKE ALL ON public.v_recent_sold_comps FROM anon, authenticated;
-- The marker table is created after offerr-supabase-prereqs.sql has installed
-- Supabase's ALTER DEFAULT PRIVILEGES, so it inherits anon/authenticated DML
-- unless explicitly revoked. Schema-contract state is operator metadata.
REVOKE ALL ON public.comp_intelligence_schema_contract FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.properties            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.buyer_comp_raw_v2     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.buyer_entities_v2     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.system_control        TO service_role;
GRANT SELECT                         ON public.v_recent_sold_comps   TO service_role;
GRANT SELECT, INSERT, UPDATE         ON public.comp_intelligence_schema_contract TO service_role;
GRANT EXECUTE ON FUNCTION public.get_comp_candidates_for_subject(text, numeric, integer, integer)
  TO service_role;


-- ── 5. Post-bootstrap assertion ──────────────────────────────────────────
-- Fails loudly if the bootstrap did not produce the exact surface the real comp
-- loader needs. Checks objects AND the load-bearing columns AND the RPC's
-- result contract — presence alone is not evidence of compatibility.
DO $$
DECLARE
  missing     text[] := ARRAY[]::text[];
  rpc_oid     oid;
  result_cols int;
  ident_args  text;
BEGIN
  IF to_regclass('public.system_control')        IS NULL THEN missing := missing || 'table:system_control';        END IF;
  IF to_regclass('public.properties')            IS NULL THEN missing := missing || 'table:properties';            END IF;
  IF to_regclass('public.buyer_comp_raw_v2')     IS NULL THEN missing := missing || 'table:buyer_comp_raw_v2';     END IF;
  IF to_regclass('public.buyer_entities_v2')     IS NULL THEN missing := missing || 'table:buyer_entities_v2';     END IF;
  IF to_regclass('public.v_recent_sold_comps')   IS NULL THEN missing := missing || 'view:v_recent_sold_comps';    END IF;
  IF to_regclass('public.comp_intelligence_schema_contract') IS NULL THEN missing := missing || 'table:comp_intelligence_schema_contract'; END IF;

  SELECT p.oid INTO rpc_oid
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_comp_candidates_for_subject';

  IF rpc_oid IS NULL THEN
    missing := missing || 'function:get_comp_candidates_for_subject';
  ELSE
    ident_args := pg_get_function_identity_arguments(rpc_oid);
    IF ident_args <> 'p_subject_property_id text, p_radius_miles numeric, p_months_back integer, p_limit integer' THEN
      missing := missing || format('rpc_signature_mismatch:%s', ident_args);
    END IF;
    -- The recovered contract returns exactly 32 columns.
    SELECT count(*) INTO result_cols
    FROM unnest(string_to_array(
      substring(pg_get_function_result(rpc_oid) from '\((.*)\)$'), ', ')) AS t;
    IF result_cols <> 32 THEN
      missing := missing || format('rpc_result_contract_mismatch:%s_columns', result_cols);
    END IF;
  END IF;

  -- The view's two derived gating columns are what the RPC actually depends on.
  IF to_regclass('public.v_recent_sold_comps') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='v_recent_sold_comps'
                     AND column_name='is_usable_comp') THEN
      missing := missing || 'column:v_recent_sold_comps.is_usable_comp';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='v_recent_sold_comps'
                     AND column_name='computed_ppsf') THEN
      missing := missing || 'column:v_recent_sold_comps.computed_ppsf';
    END IF;
  END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Offerr staging bootstrap incomplete/drifted. Problems: %',
      array_to_string(missing, ', ');
  END IF;

  RAISE NOTICE 'Offerr staging bootstrap OK.';
  RAISE NOTICE '  contract offerr-comp-intelligence 1.0.0 applied';
  RAISE NOTICE '  4 tables + 1 view + 1 RPC (32-column contract) present';
  RAISE NOTICE '  offerr_evaluation_enabled is pinned false';
  RAISE NOTICE '  next: apply the Offerr evaluation-spine migration';
END $$;
