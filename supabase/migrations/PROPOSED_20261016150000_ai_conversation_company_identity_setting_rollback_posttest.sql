-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261016150000_ai_conversation_company_identity_setting_rollback.sql:
-- runs AFTER the runner applied the rollback file; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id ai_conversation_company_identity_setting
-- Expected last notice: "posttest(ai_conversation_company_identity_setting): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;
do $$
begin
  if exists (select 1 from public.system_control where key = 'ai_conversation_company_identity') then
    raise exception 'assert: the born-empty setting is removed by the rollback';
  end if;
  -- an owner-set value survives the rollback file's predicate
  insert into public.system_control (key, value) values ('ai_conversation_company_identity', '{"name":"Owner Approved Co"}');
  delete from public.system_control where key = 'ai_conversation_company_identity' and coalesce(value, '') = '';
  if not exists (select 1 from public.system_control where key = 'ai_conversation_company_identity') then
    raise exception 'assert: the rollback predicate never deletes an owner-set identity';
  end if;
  raise notice 'posttest(ai_conversation_company_identity_setting): ALL OK (rolled back)';
end $$;
rollback;
