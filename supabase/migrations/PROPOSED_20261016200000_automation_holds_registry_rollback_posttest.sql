-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261016200000_automation_holds_registry_rollback.sql.
-- Read-only: after the rollback no registry object remains (the runner also compares the full schema
-- fingerprint with the pre-apply one). DISPOSABLE DATABASE ONLY.
do $$ begin
  assert to_regclass('public.automation_holds') is null and to_regclass('public.automation_hold_events') is null, 'rb: registry tables dropped';
  assert not exists (select 1 from pg_trigger where not tgisinternal and tgname like '%automation_hold%'), 'rb: hold triggers dropped';
  assert not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'automation_hold%'), 'rb: hold functions dropped';
  assert to_regclass('public.send_queue') is not null and to_regclass('public.seller_offers') is not null, 'rb: the protected tables are untouched';
  raise notice 'rollback posttest(automation_holds_registry): ALL OK';
end $$;
