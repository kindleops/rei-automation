-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261016150000_ai_conversation_company_identity_setting.sql:
-- runs AFTER the runner applied the migration; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id ai_conversation_company_identity_setting
-- Expected last notice: "posttest(ai_conversation_company_identity_setting): apply assertions OK".
\set ON_ERROR_STOP on
begin;
do $$
declare v text; n int;
begin
  select value into v from public.system_control where key = 'ai_conversation_company_identity';
  if v is distinct from '' then raise exception 'assert: the setting is born EMPTY (do not mention company details), got %', v; end if;
  -- an owner-set value is never overwritten by a re-apply (ON CONFLICT DO NOTHING)
  update public.system_control set value = '{"name":"Owner Approved Co"}' where key = 'ai_conversation_company_identity';
  insert into public.system_control (key, value) values ('ai_conversation_company_identity', '') on conflict (key) do nothing;
  select value into v from public.system_control where key = 'ai_conversation_company_identity';
  if v <> '{"name":"Owner Approved Co"}' then raise exception 'assert: re-apply must not overwrite an owner value'; end if;
  select count(*) into n from public.system_control where key = 'ai_conversation_company_identity';
  if n <> 1 then raise exception 'assert: exactly one row'; end if;
  raise notice 'posttest(ai_conversation_company_identity_setting): apply assertions OK';
end $$;
rollback;
