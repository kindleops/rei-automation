-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261015191000_ai_operator_feedback.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- No transaction control, no includes.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id ai_operator_feedback
-- Expected last notice: "pretest(ai_operator_feedback): prerequisites OK".
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public.ai_operator_feedback') is not null or to_regclass('public.ai_eval_sets') is not null then
    raise exception 'pretest(ai_operator_feedback): tables already exist — reconcile first';
  end if;
  if to_regprocedure('public.ai_feedback_immutable_guard()') is not null then
    raise exception 'pretest(ai_operator_feedback): guard function already exists';
  end if;
  if not exists (select 1 from pg_proc where proname = 'gen_random_uuid') then
    raise exception 'pretest(ai_operator_feedback): gen_random_uuid() unavailable';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'pretest(ai_operator_feedback): role service_role missing';
  end if;
  raise notice 'pretest(ai_operator_feedback): prerequisites OK';
end
$$;
