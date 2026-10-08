-- ============================================================================
-- STAGING ONLY — positive identity for the isolated integration database.
-- ============================================================================
-- Target: Supabase preview branch "prominent-intake-staging" (project ref
-- eiawfeddmmwwavzlfwia) of REI Automation (lcppdrmrdfblstpcbgpf).
--
-- This file lives OUTSIDE supabase/migrations on purpose: it can never be
-- picked up as a production migration. It refuses to run on any database that
-- carries the production fingerprint (the outbound send_queue, or a property
-- universe larger than a test fixture), and it is the only thing that creates
-- the identity row every staging script and the staging API demand before
-- they will touch a database (see scripts/staging/guard.mjs).

DO $$
BEGIN
  IF to_regclass('public.send_queue') IS NOT NULL
     OR coalesce((SELECT reltuples FROM pg_class WHERE oid = to_regclass('public.properties')), 0) > 10000 THEN
    RAISE EXCEPTION 'STAGING_GUARD: production fingerprint detected (send_queue / property universe); refusing to claim staging identity';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS staging_guard;
REVOKE ALL ON SCHEMA staging_guard FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS staging_guard.identity (
  singleton    boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  project_ref  text NOT NULL,
  environment  text NOT NULL CHECK (environment = 'staging'),
  purpose      text NOT NULL,
  claimed_at   timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON staging_guard.identity FROM PUBLIC, anon, authenticated;

INSERT INTO staging_guard.identity (project_ref, environment, purpose)
VALUES ('eiawfeddmmwwavzlfwia', 'staging', 'Prominent seller portal + shared scheduling core integration certification')
ON CONFLICT (singleton) DO NOTHING;

-- Server-side assertion used at the top of every staging bootstrap file.
CREATE OR REPLACE FUNCTION staging_guard.assert_staging()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM staging_guard.identity WHERE environment = 'staging') THEN
    RAISE EXCEPTION 'STAGING_GUARD: no staging identity on this database';
  END IF;
  IF to_regclass('public.send_queue') IS NOT NULL
     OR coalesce((SELECT reltuples FROM pg_class WHERE oid = to_regclass('public.properties')), 0) > 10000 THEN
    RAISE EXCEPTION 'STAGING_GUARD: production fingerprint present';
  END IF;
END $$;
REVOKE ALL ON FUNCTION staging_guard.assert_staging() FROM PUBLIC, anon, authenticated;

-- What clients call (service role only) to prove where they are connected.
CREATE OR REPLACE FUNCTION public.staging_identity()
RETURNS TABLE (project_ref text, environment text, claimed_at timestamptz, production_fingerprint boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT i.project_ref, i.environment, i.claimed_at,
         (to_regclass('public.send_queue') IS NOT NULL
          OR coalesce((SELECT reltuples FROM pg_catalog.pg_class WHERE oid = to_regclass('public.properties')), 0) > 10000)
  FROM staging_guard.identity i;
$$;
REVOKE ALL ON FUNCTION public.staging_identity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staging_identity() TO service_role;

-- Staging bootstrap and migrations are applied with plain SQL, never
-- recorded in supabase_migrations, so a branch merge can never carry them to
-- production. This log is the record instead.
CREATE TABLE IF NOT EXISTS staging_guard.applied (
  name text PRIMARY KEY,
  sha256 text,
  applied_at timestamptz NOT NULL DEFAULT now(),
  result text NOT NULL
);
REVOKE ALL ON staging_guard.applied FROM PUBLIC, anon, authenticated;
