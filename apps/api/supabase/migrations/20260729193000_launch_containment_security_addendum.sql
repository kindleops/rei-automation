-- Launch containment security addendum
--
-- Companion to 20260726120000_seller_inbound_bursts.sql (PR #54) and to the
-- Supabase-backed launch alerting introduced alongside it.
--
-- Context: in this project the `anon` and `authenticated` roles hold blanket
-- DML grants on public tables. Any table in the `public` (PostgREST-exposed)
-- schema WITHOUT row level security is therefore readable AND writable by any
-- holder of the publishable/anon key. This migration closes that hole for the
-- tables the production launch depends on.
--
-- It deliberately does NOT modify any function body: claim/reclaim/finalize
-- semantics from PR #54 are preserved exactly. Only RLS, privileges and
-- search_path pinning change.
--
-- Safe to run before or after the burst table exists: every statement is
-- guarded so a missing object is skipped rather than failing the migration.

-- ── 1. seller_inbound_bursts ────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.seller_inbound_bursts') IS NULL THEN
    RAISE NOTICE 'seller_inbound_bursts absent; skipping table lockdown';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public.seller_inbound_bursts ENABLE ROW LEVEL SECURITY';

  -- No policies are created: with RLS enabled and zero policies, only roles
  -- with BYPASSRLS (service_role) can read or write. This matches the existing
  -- system_control lockdown pattern in this project.
  EXECUTE 'REVOKE ALL ON TABLE public.seller_inbound_bursts FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON TABLE public.seller_inbound_bursts FROM anon';
  EXECUTE 'REVOKE ALL ON TABLE public.seller_inbound_bursts FROM authenticated';

  -- The API talks to Supabase with the service role only.
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.seller_inbound_bursts TO service_role';
END $$;

-- ── 2. claim_seller_inbound_burst: pin search_path, minimise EXECUTE ────────
-- ALTER (not CREATE OR REPLACE) so the PR #54 body is untouched.
DO $$
DECLARE
  fn_signature text;
BEGIN
  SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
    INTO fn_signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'claim_seller_inbound_burst'
   LIMIT 1;

  IF fn_signature IS NULL THEN
    RAISE NOTICE 'claim_seller_inbound_burst absent; skipping function lockdown';
    RETURN;
  END IF;

  -- Deterministic name resolution regardless of caller search_path.
  EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn_signature);

  -- Postgres grants EXECUTE to PUBLIC on every new function; anon/authenticated
  -- inherit it. Revoke, then grant only the role the API actually uses.
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn_signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn_signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn_signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn_signature);
END $$;

-- ── 3. Launch-critical alert sink + queue containment audit tables ──────────
-- notification_events is the canonical operator-facing alert store and is the
-- sink for launch-critical alerts. The queue audit tables are written by
-- triggers/DB functions and read only by operators. None of them has any
-- anon-key reader: the dashboard reaches notifications over the HTTP API using
-- the service role (apps/api/src/app/api/cockpit/notifications/*).
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'notification_events',
    'notification_action_audit',
    'notification_preferences',
    'notification_mutes',
    'ops_notifications',
    'send_queue_lifecycle_guard_events',
    'queue_claim_audit',
    'queue_scheduled_for_mutation_audit',
    'queue_canary_execution_audits'
  ]
  LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      RAISE NOTICE 'table % absent; skipped', tbl;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', tbl);
  END LOOP;
END $$;

-- ── 4. Internal queue/delivery functions must not be publicly executable ────
-- reconcile_delivery_receipt is SECURITY DEFINER, so PUBLIC EXECUTE on it is an
-- RLS bypass reachable with the anon key. The others are internal queue
-- primitives with no legitimate anonymous caller.
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) AS sig,
           p.prosecdef,
           p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'reconcile_delivery_receipt',
         'apply_send_queue_stale_expiration',
         'queue_execution_mode_normalized',
         'queue_processor_mode_normalized',
         'queue_system_control_text'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);

    -- SECURITY DEFINER functions must have a pinned search_path.
    IF fn.prosecdef AND (fn.proconfig IS NULL OR NOT (fn.proconfig::text LIKE '%search_path%')) THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn.sig);
    END IF;
  END LOOP;
END $$;
