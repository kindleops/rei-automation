-- lc-fixture: posttest
-- PROPOSED ONLY — ROLLBACK POSTTEST for PROPOSED_20261016200100_automation_hold_guards_rollback.sql.
\set ON_ERROR_STOP on
do $$ begin
  assert not exists (select 1 from pg_trigger where not tgisinternal and tgname in ('aa_automation_hold_seller_offers', 'aa_automation_hold_closing_cases',
         'aa_automation_hold_opportunities', 'aa_automation_hold_send_queue')), 'rb: the live-table guards are gone';
  assert to_regclass('public.automation_holds') is not null, 'rb: the registry core is untouched';
  assert exists (select 1 from pg_trigger where not tgisinternal and tgname = 'aa_automation_holds_require_guards'), 'rb: no hold can be created again';
  raise notice 'rollback posttest(automation_hold_guards): ALL OK';
end $$;
