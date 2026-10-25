-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261016200000_automation_holds_registry.sql (the registry CORE). Changes NOTHING
-- (BEGIN … ROLLBACK). The behavioural hold tests (holds blocking writes) are the guards link's posttest.
\set ON_ERROR_STOP on
begin;
do $$
declare ok boolean := false; guards boolean;
begin
  assert (select count(*) from public.automation_holds) = 0, 'the registry starts empty';
  assert not exists (select 1 from public.automation_hold_for('tk_core', null, 'P_CORE', null, 'MO_CORE', null)), 'an empty lookup finds nothing';
  assert (select relrowsecurity from pg_class where oid = 'public.automation_holds'::regclass), 'RLS on automation_holds';
  assert not has_table_privilege('anon', 'public.automation_holds', 'select'), 'anon cannot read holds';
  guards := (select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and tgname in ('aa_automation_hold_seller_offers',
             'aa_automation_hold_closing_cases', 'aa_automation_hold_opportunities', 'aa_automation_hold_send_queue')) = 4;
  if not guards then
    -- the core alone: no hold can exist without enforcement
    begin
      insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref) values ('core:x', 'operator_hold', '+13125550101', 'r', 's', 'a');
    exception when others then
      ok := sqlerrm like 'HOLD_ENFORCEMENT_NOT_INSTALLED%';
    end;
    assert ok, 'a hold is refused (HOLD_ENFORCEMENT_NOT_INSTALLED) until the live-table guards are installed';
    assert (select count(*) from public.automation_holds) = 0, 'nothing was written';
  else
    -- core + guards: holds are accepted (enforced by the guards link; its posttest proves the blocking)
    insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref) values ('core:x', 'operator_hold', '+13125550101', 'r', 's', 'a');
    assert (select count(*) from public.automation_holds where hold_key = 'core:x') = 1, 'a hold is accepted once the guards are installed';
  end if;
  raise notice 'posttest(automation_holds_registry core): ALL OK';
end $$;
rollback;
