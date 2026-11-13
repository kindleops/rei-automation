-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261017120000_followup_intent_lifecycle.sql (P0 follow-up lifecycle).
-- Read-only assertions; no writes, no transaction control.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
do $$ begin
  assert to_regclass('public.followup_intents') is null and to_regclass('public.followup_intent_events') is null, 'pretest: the lifecycle must not exist yet';
  assert to_regclass('public.send_queue') is not null and to_regclass('public.inbox_thread_state') is not null and to_regclass('public.system_control') is not null, 'pretest: send_queue / inbox_thread_state / system_control exist';
  assert exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inbox_thread_state' and column_name = 'follow_up_at'), 'pretest: inbox_thread_state.follow_up_at exists';
  assert exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'inbox_thread_state' and indexdef ilike 'CREATE UNIQUE INDEX%(thread_key)'), 'pretest: inbox_thread_state.thread_key is unique';
  assert to_regprocedure('public.is_ops_operator()') is not null, 'pretest: is_ops_operator() exists (RLS policy pattern)';
  assert not exists (select 1 from pg_trigger where not tgisinternal and tgname like '%followup_intent%'), 'pretest: no lifecycle triggers yet';
  assert to_regclass('public.uq_send_queue_followup_intent_live') is null, 'pretest: no lifecycle index yet';
  raise notice 'pretest(followup_intent_lifecycle): ALL OK';
end $$;
