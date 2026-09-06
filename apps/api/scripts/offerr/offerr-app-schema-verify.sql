-- ============================================================================
-- offerr_app — schema and privilege verification
-- ============================================================================
--
-- Run after applying 20260804120000_offerr_app_public_state.sql:
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
--     -f apps/api/scripts/offerr/offerr-app-schema-verify.sql
--
-- Every check RAISES on failure, so a non-zero exit means the schema is not in
-- the state the OfferrAI adapter requires. This is a privilege test, not a
-- description: it asserts what `anon` and `authenticated` genuinely cannot do,
-- rather than trusting that the grants in the migration were applied.
-- ============================================================================

CREATE OR REPLACE FUNCTION pg_temp.chk(label text, condition boolean)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF condition THEN
    RAISE NOTICE 'PASS  %', label;
  ELSE
    RAISE EXCEPTION 'FAIL  %', label;
  END IF;
END $$;

-- ── Schema exists ───────────────────────────────────────────────────────────

SELECT pg_temp.chk('schema offerr_app exists',
  EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'offerr_app'));

-- ── Every expected table exists ─────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sessions', 'seller_results', 'idempotency_reservations',
    'rate_limit_buckets', 'property_cooldowns', 'consent_records',
    'canary_access', 'review_items'
  ] LOOP
    PERFORM pg_temp.chk(
      format('table offerr_app.%s exists', t),
      EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'offerr_app' AND table_name = t));
  END LOOP;
END $$;

-- ── Every expected function exists ──────────────────────────────────────────

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'digest_key', 'session_touch', 'rate_consume', 'cooldown_check',
    'cooldown_mark', 'reserve', 'complete', 'release', 'find_by_key',
    'read_result', 'record_consent', 'canary_allowed', 'enqueue_review', 'sweep'
  ] LOOP
    PERFORM pg_temp.chk(
      format('function offerr_app.%s exists', f),
      EXISTS (SELECT 1 FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'offerr_app' AND p.proname = f));
  END LOOP;
END $$;

-- ── RLS is enabled on every table ───────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sessions', 'seller_results', 'idempotency_reservations',
    'rate_limit_buckets', 'property_cooldowns', 'consent_records',
    'canary_access', 'review_items'
  ] LOOP
    PERFORM pg_temp.chk(
      format('RLS enabled on offerr_app.%s', t),
      (SELECT c.relrowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'offerr_app' AND c.relname = t));
  END LOOP;
END $$;

-- ── anon and authenticated hold NO privilege anywhere in the schema ─────────
--
-- This is the check that matters most. The browser holds the anon key; if anon
-- can reach any object here, the private-schema posture is a fiction.

SELECT pg_temp.chk('anon has no USAGE on schema offerr_app',
  NOT has_schema_privilege('anon', 'offerr_app', 'USAGE'));

SELECT pg_temp.chk('authenticated has no USAGE on schema offerr_app',
  NOT has_schema_privilege('authenticated', 'offerr_app', 'USAGE'));

DO $$
DECLARE
  t text;
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH t IN ARRAY ARRAY[
      'sessions', 'seller_results', 'idempotency_reservations',
      'rate_limit_buckets', 'property_cooldowns', 'consent_records',
      'canary_access', 'review_items'
    ] LOOP
      PERFORM pg_temp.chk(
        format('%s cannot SELECT offerr_app.%s', r, t),
        NOT has_table_privilege(r, format('offerr_app.%I', t), 'SELECT'));
      PERFORM pg_temp.chk(
        format('%s cannot INSERT offerr_app.%s', r, t),
        NOT has_table_privilege(r, format('offerr_app.%I', t), 'INSERT'));
      PERFORM pg_temp.chk(
        format('%s cannot UPDATE offerr_app.%s', r, t),
        NOT has_table_privilege(r, format('offerr_app.%I', t), 'UPDATE'));
      PERFORM pg_temp.chk(
        format('%s cannot DELETE offerr_app.%s', r, t),
        NOT has_table_privilege(r, format('offerr_app.%I', t), 'DELETE'));
    END LOOP;
  END LOOP;
END $$;

-- ── service_role retains exactly what the adapter needs ─────────────────────

SELECT pg_temp.chk('service_role has USAGE on schema offerr_app',
  has_schema_privilege('service_role', 'offerr_app', 'USAGE'));

SELECT pg_temp.chk('service_role can read offerr_app.seller_results',
  has_table_privilege('service_role', 'offerr_app.seller_results', 'SELECT'));

-- ── PUBLIC holds nothing ────────────────────────────────────────────────────

SELECT pg_temp.chk('PUBLIC has no USAGE on schema offerr_app',
  NOT has_schema_privilege('public', 'offerr_app', 'USAGE'));

-- ── The schema must NOT be exposed through PostgREST ────────────────────────
--
-- Advisory: `pgrst.db_schemas` is set on the role or via the platform. If this
-- reports a value containing offerr_app, the private-schema guarantee is broken.

DO $$
DECLARE v_setting text;
BEGIN
  SELECT current_setting('pgrst.db_schemas', true) INTO v_setting;
  IF v_setting IS NULL THEN
    RAISE NOTICE 'INFO  pgrst.db_schemas not visible from this session; verify exposed schemas in the dashboard (must NOT list offerr_app)';
  ELSE
    PERFORM pg_temp.chk('offerr_app is not exposed through PostgREST',
      position('offerr_app' in v_setting) = 0);
  END IF;
END $$;

-- ── No OfferrAI object may reference canonical acquisition tables ───────────
--
-- The OfferrAI surface must not be able to mutate acquisition data by way of a
-- foreign key or trigger it inherited by accident.

SELECT pg_temp.chk('no FK from offerr_app points outside offerr_app',
  NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class      t ON t.oid = c.conrelid
      JOIN pg_namespace  n ON n.oid = t.relnamespace
      JOIN pg_class      f ON f.oid = c.confrelid
      JOIN pg_namespace  fn ON fn.oid = f.relnamespace
     WHERE c.contype = 'f'
       AND n.nspname = 'offerr_app'
       AND fn.nspname <> 'offerr_app'));

DO $$ BEGIN RAISE NOTICE 'ALL offerr_app SCHEMA AND PRIVILEGE CHECKS PASSED'; END $$;
