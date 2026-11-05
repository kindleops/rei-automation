-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261016200000_automation_holds_registry.sql (P0 holds registry,
-- rc-8.5.20-holds = hotfix/automation-holds; carried by rc-8.5.21 as the FIRST link of the release chain;
-- production receives it via the hotfix). Read-only assertions; no writes, no transaction control.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
do $$ begin
  assert to_regclass('public.automation_holds') is null and to_regclass('public.automation_hold_events') is null, 'pretest: the registry must not exist yet';
  assert to_regprocedure('public.automation_hold_for(text,uuid,text,uuid,text,text)') is null, 'pretest: automation_hold_for must not exist yet';
  assert not exists (select 1 from pg_trigger where not tgisinternal and tgname like 'aa_automation_hold_%'), 'pretest: no hold triggers yet';
  assert to_regclass('public.seller_offers') is not null and to_regclass('public.closing_cases') is not null and to_regclass('public.acquisition_opportunities') is not null
     and to_regclass('public.send_queue') is not null and to_regclass('public.inbox_thread_state') is not null, 'pretest: the protected tables exist';
  assert to_regprocedure('public.is_ops_operator()') is not null, 'pretest: is_ops_operator() exists (RLS policy pattern)';
  assert exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'inbox_thread_state' and indexdef ilike 'CREATE UNIQUE INDEX%(thread_key)'), 'pretest: inbox_thread_state.thread_key is unique';
  raise notice 'pretest(automation_holds_registry): ALL OK';
end $$;
