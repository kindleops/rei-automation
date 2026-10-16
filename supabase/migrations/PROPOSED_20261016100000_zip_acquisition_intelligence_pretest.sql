-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261016100000_zip_acquisition_intelligence.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- No transaction control, no includes.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id zip_acquisition_intelligence
-- Expected last notice: "pretest(zip_acquisition_intelligence): prerequisites OK".
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public.zip_acquisition_economics') is not null or to_regclass('public.zip_model_build_state') is not null
     or to_regclass('public.zip_model_versions') is not null or to_regclass('public.acquisition_outcomes') is not null
     or to_regclass('public.acquisition_outcomes_training') is not null then
    raise exception 'pretest(zip_acquisition_intelligence): a target relation already exists — reconcile first';
  end if;
  if to_regprocedure('public.acquisition_outcomes_guard()') is not null then
    raise exception 'pretest(zip_acquisition_intelligence): guard function already exists';
  end if;
  if not exists (select 1 from pg_proc where proname = 'gen_random_uuid') then
    raise exception 'pretest(zip_acquisition_intelligence): gen_random_uuid() unavailable';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'pretest(zip_acquisition_intelligence): role service_role missing';
  end if;
  raise notice 'pretest(zip_acquisition_intelligence): prerequisites OK';
end
$$;
