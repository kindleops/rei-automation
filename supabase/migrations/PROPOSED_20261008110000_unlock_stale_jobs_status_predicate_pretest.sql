-- PRETEST for PROPOSED_20261008110000_unlock_stale_jobs_status_predicate.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Read-only prerequisite checks. The behaviour assertions (formerly this file, which \i-included
-- the migration) are ..._posttest.sql, run by the migration test runner after it applies the
-- migration on a disposable database:
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id unlock_stale_jobs_status_predicate
\set ON_ERROR_STOP on
do $$
begin
  if to_regclass('public.send_queue') is null then raise exception 'pretest(unlock_stale_jobs): public.send_queue missing'; end if;
  if to_regprocedure('public.unlock_stale_jobs(integer)') is null then raise exception 'pretest(unlock_stale_jobs): public.unlock_stale_jobs(integer) missing — this migration replaces it'; end if;
  raise notice 'pretest(unlock_stale_jobs): prerequisites OK';
end $$;
