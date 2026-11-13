-- PROPOSED ONLY — PRETEST for PROPOSED_20261016150000_ai_conversation_company_identity_setting.sql. Changes NOTHING.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id ai_conversation_company_identity_setting
\set ON_ERROR_STOP on
do $$
begin
  if to_regclass('public.system_control') is null then
    raise exception 'pretest: public.system_control must exist';
  end if;
  raise notice 'pretest(ai_conversation_company_identity_setting): prerequisites OK';
end $$;
