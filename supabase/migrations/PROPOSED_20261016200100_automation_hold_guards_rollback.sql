-- PROPOSED ONLY. ROLLBACK of PROPOSED_20261016200100_automation_hold_guards.sql: removes the four live-table guards.
-- Refused while any hold is active (it would stop being enforced). The registry core stays (and refuses new holds again).
begin;
do $$
begin
  if exists (select 1 from public.automation_holds where released_at is null) then
    raise exception 'rollback precondition: % active hold(s) would lose their enforcement; release them first', (select count(*) from public.automation_holds where released_at is null);
  end if;
end $$;
drop trigger aa_automation_hold_send_queue on public.send_queue;
drop trigger aa_automation_hold_opportunities on public.acquisition_opportunities;
drop trigger aa_automation_hold_closing_cases on public.closing_cases;
drop trigger aa_automation_hold_seller_offers on public.seller_offers;
drop function public.automation_hold_guard_send_queue();
drop function public.automation_hold_guard_opportunities();
drop function public.automation_hold_guard_closing_cases();
drop function public.automation_hold_guard_seller_offers();
do $$
begin
  if exists (select 1 from pg_trigger where not tgisinternal and tgname like 'aa_automation_hold\_%' and tgname <> 'aa_automation_holds_require_guards'
             and tgrelid in ('public.send_queue'::regclass, 'public.seller_offers'::regclass, 'public.closing_cases'::regclass, 'public.acquisition_opportunities'::regclass)) then
    raise exception 'rollback postcondition: a live-table guard remains';
  end if;
end $$;
commit;
