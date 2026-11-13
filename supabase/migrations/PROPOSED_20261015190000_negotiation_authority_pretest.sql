-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261015190000_negotiation_authority.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- No transaction control, no includes: read-only prerequisite checks.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id negotiation_authority
-- Expected last notice: "pretest(negotiation_authority): prerequisites OK".
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public.negotiation_envelopes') is not null
     or to_regclass('public.negotiation_envelope_revocations') is not null
     or to_regclass('public.negotiation_offer_events') is not null then
    raise exception 'pretest(negotiation_authority): tables already exist — reconcile first';
  end if;
  if to_regprocedure('public.negotiation_immutable_guard()') is not null then
    raise exception 'pretest(negotiation_authority): guard function already exists';
  end if;
  if not exists (select 1 from pg_proc where proname = 'gen_random_uuid') then
    raise exception 'pretest(negotiation_authority): gen_random_uuid() unavailable';
  end if;
  if not exists (select 1 from pg_proc where proname = 'hashtextextended') then
    raise exception 'pretest(negotiation_authority): hashtextextended() unavailable';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'pretest(negotiation_authority): role service_role missing';
  end if;
  raise notice 'pretest(negotiation_authority): prerequisites OK';
end
$$;
