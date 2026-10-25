-- PROPOSED rollback of PROPOSED_automation_holds_registry.sql: drops exactly the objects it created.
-- REFUSES while any hold is active: roll back (b)/(c) first (they release their holds). The audit rows
-- in automation_holds / automation_hold_events are dropped with the tables, so EXPORT THEM FIRST
-- (EXECUTION-PLAN.md step R-a.0). Roll back the CODE first as well: the hotfix code fails closed when
-- automation_hold_for is missing, which pauses every automated send and advancement.
begin;
do $$
begin
  if to_regclass('public.automation_holds') is null then raise exception 'rollback precondition: registry not present'; end if;
  if exists (select 1 from pg_trigger where not tgisinternal and tgname = 'aa_automation_hold_send_queue') then
    raise exception 'rollback precondition: roll back PROPOSED_20261016200100_automation_hold_guards first';
  end if;
  if exists (select 1 from public.automation_holds where released_at is null) then
    raise exception 'rollback precondition: % active hold(s); release them (roll back (b)/(c)) first', (select count(*) from public.automation_holds where released_at is null);
  end if;
end $$;

drop function public.automation_hold_assert_clear(text,text,text,uuid,text,uuid,text,jsonb);
drop function public.automation_hold_stage_rank(text);
drop function public.automation_hold_for(text,uuid,text,uuid,text,text);
drop table public.automation_hold_events;
drop table public.automation_holds;
drop function public.automation_holds_audit();
drop function public.automation_holds_append_only();
drop function if exists public.automation_holds_require_guards();

do $$
begin
  if to_regclass('public.automation_holds') is not null or to_regclass('public.automation_hold_events') is not null
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'automation_hold%')
     or exists (select 1 from pg_trigger where not tgisinternal and tgname like '%automation_hold%') then
    raise exception 'rollback postcondition: hold objects remain';
  end if;
end $$;
commit;
