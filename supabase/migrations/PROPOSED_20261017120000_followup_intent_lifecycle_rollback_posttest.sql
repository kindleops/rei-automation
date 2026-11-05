-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261017120000_followup_intent_lifecycle.sql. Read-only.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
do $$ begin
  assert to_regclass('public.followup_intents') is null and to_regclass('public.followup_intent_events') is null, 'rollback posttest: tables dropped';
  assert to_regclass('public.v_followup_intent_health') is null and to_regclass('public.v_followup_intent_reasons') is null, 'rollback posttest: views dropped';
  assert not exists (select 1 from pg_trigger where not tgisinternal and tgname like '%followup_%'), 'rollback posttest: triggers dropped';
  assert to_regclass('public.uq_send_queue_followup_intent_live') is null, 'rollback posttest: index dropped';
  assert to_regclass('public.send_queue') is not null and to_regclass('public.inbox_thread_state') is not null, 'rollback posttest: the base tables are untouched';
  raise notice 'rollback posttest(followup_intent_lifecycle): ALL OK';
end $$;
