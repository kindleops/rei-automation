-- PROPOSED ONLY — PRETEST for PROPOSED_20261013160000_conversation_ai_shadow.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Read-only prerequisite checks. The apply → assert half is ..._posttest.sql and the
-- "rollback file drops exactly what was created" check is ..._rollback_posttest.sql (rc-8.5.15.1:
-- a fixture never includes another file — the runner applies the migration and the rollback).
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id conversation_ai_shadow
-- Expected last notice: "pretest(conversation_ai_shadow): prerequisites OK".
\set ON_ERROR_STOP on

do $$
begin
  if to_regclass('public.conversation_ai_shadow_decisions') is not null or to_regclass('public.conversation_ai_reply_policy') is not null then
    raise exception 'pretest(conversation_ai_shadow): tables already exist — reconcile first';
  end if;
  if not exists (select 1 from pg_proc where proname = 'gen_random_uuid') then
    raise exception 'pretest(conversation_ai_shadow): gen_random_uuid() unavailable';
  end if;
  raise notice 'pretest(conversation_ai_shadow): prerequisites OK';
end
$$;
