-- Offerr verification prerequisites — reproduce a hosted Supabase project's
-- role and privilege environment on a plain PostgreSQL instance.
--
-- Purpose: make the Offerr migration's REVOKE/GRANT and RLS statements
-- meaningful to verify locally. Without this, a bare PostgreSQL database has no
-- anon/authenticated/service_role roles and none of Supabase's default table
-- privileges, so "anon has no access" would pass trivially and the real defect
-- (service_role inheriting arwd from ALTER DEFAULT PRIVILEGES) would be
-- invisible.
--
-- Run this ONLY against a disposable verification database. It is never applied
-- to a hosted Supabase project — those already have these roles.
--
--   psql "$OFFERR_VERIFY_DATABASE_URL" -v ON_ERROR_STOP=1 -f offerr-supabase-prereqs.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT anon, authenticated, service_role TO authenticator;

-- Supabase's own default: every new table in `public` is reachable by the API
-- roles unless explicitly revoked. Reproducing this is what makes the Offerr
-- migration's REVOKE statements load-bearing rather than decorative.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;

-- Hosted Supabase seeds the SAME default for FUNCTIONS and SEQUENCES, not just
-- tables. Omitting them here is not a harmless simplification — it hid a real
-- defect: `REVOKE ALL ON FUNCTION ... FROM PUBLIC` in the Offerr migration
-- removed PostgreSQL's implicit PUBLIC grant and passed locally, while on the
-- hosted preview branch anon and authenticated still held EXECUTE through these
-- EXPLICIT per-role default grants (a PUBLIC revoke cannot remove a role grant).
-- Verified against branch ktvjkokwcqcgapzztkwu of real-estate-automation on
-- 2026-07-31; pg_default_acl there carries r/f/S entries for public granted by
-- both `postgres` and `supabase_admin`.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role;

-- Prerequisite canonical table the Offerr migration seeds its flag into
-- (apps/api/supabase/migrations/20260428_create_system_control.sql).
CREATE TABLE IF NOT EXISTS public.system_control (
  key        text        PRIMARY KEY,
  value      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
