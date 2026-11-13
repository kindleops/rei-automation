-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261013160000_conversation_ai_shadow_rollback.sql:
-- runs AFTER the runner applied the rollback file; the rollback dropped exactly what was created.
-- Read-only.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id conversation_ai_shadow
\set ON_ERROR_STOP on
do $$
begin
  if to_regclass('public.conversation_ai_shadow_decisions') is not null or to_regclass('public.conversation_ai_reply_policy') is not null then
    raise exception 'assert: rollback removed both tables';
  end if;
  raise notice 'pretest(conversation_ai_shadow): ALL OK (rolled back)';
end
$$;
