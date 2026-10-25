-- lc-fixture: pretest
-- PROPOSED ONLY — PRETEST for PROPOSED_20261016200100_automation_hold_guards.sql. Changes NOTHING.
\set ON_ERROR_STOP on
do $$ begin
  assert to_regclass('public.automation_holds') is not null and to_regprocedure('public.automation_hold_assert_clear(text,text,text,uuid,text,uuid,text,jsonb)') is not null, 'pretest: the registry core is applied';
  assert not exists (select 1 from pg_trigger where not tgisinternal and tgname in ('aa_automation_hold_seller_offers', 'aa_automation_hold_closing_cases',
         'aa_automation_hold_opportunities', 'aa_automation_hold_send_queue')), 'pretest: no live-table guard yet';
  assert to_regclass('public.seller_offers') is not null and to_regclass('public.closing_cases') is not null and to_regclass('public.acquisition_opportunities') is not null
     and to_regclass('public.send_queue') is not null and to_regclass('public.inbox_thread_state') is not null, 'pretest: the protected tables exist';
  raise notice 'pretest(automation_hold_guards): ALL OK';
end $$;
