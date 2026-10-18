-- PROPOSED rollback of PROPOSED_20261017120000_followup_intent_lifecycle.sql: drops exactly the objects it
-- created. REFUSES while any intent is still executable or held (planned / materializing / ready /
-- dispatched / held): those are follow-ups that would silently disappear. Set
-- system_control.followup_execution_mode to 'off' FIRST, let the ready rows send (or cancel them through
-- followup_intent_close_for_thread), and EXPORT followup_intents + followup_intent_events (the audit is
-- dropped with the tables). Roll back the CODE first as well: the lifecycle code fails closed (writes
-- nothing, legacy writers resume) when followup_intent_plan is missing.
-- inbox_thread_state.follow_up_at keeps its last projected value; nothing else is modified.
begin;
do $$
begin
  if to_regclass('public.followup_intents') is null then raise exception 'rollback precondition: lifecycle not present'; end if;
  if exists (select 1 from public.followup_intents where state in ('planned', 'materializing', 'ready', 'dispatched', 'held')) then
    raise exception 'rollback precondition: % executable / held follow-up intent(s) remain; close or let them finish first',
      (select count(*) from public.followup_intents where state in ('planned', 'materializing', 'ready', 'dispatched', 'held'));
  end if;
end $$;

drop trigger zz_followup_thread_state_guard on public.inbox_thread_state;
drop trigger zz_followup_no_empty_claimable on public.send_queue;
drop trigger zz_followup_intent_sync on public.send_queue;
drop trigger zz_followup_intent_bind on public.send_queue;
drop index public.uq_send_queue_followup_intent_live;
drop view public.v_followup_intent_reasons;
drop view public.v_followup_intent_health;
drop function public.followup_thread_state_guard();
drop function public.followup_no_empty_claimable_guard();
drop function public.followup_intent_sync_send_queue();
drop function public.followup_intent_bind_send_queue();
drop function public.followup_intent_close_for_thread(jsonb);
drop function public.followup_intent_requeue_failed(uuid, text, text);
drop function public.followup_intent_rematerialize(uuid, uuid, text, text);
drop function public.followup_intent_transition(uuid, uuid, text, text, timestamptz, boolean, jsonb, text);
drop function public.followup_intent_claim(text, integer, integer, integer, uuid);
drop function public.followup_intent_plan(jsonb);
drop function public.followup_intent_cancel_row(uuid, text, text, boolean);
drop function public.followup_intent_project(text);
drop table public.followup_intent_events;
drop table public.followup_intents;
drop function public.followup_intent_events_append_only();
drop function public.followup_intents_audit();
drop function public.followup_intents_guard();
drop function public.followup_intent_transition_allowed(text, text);

do $$
begin
  if to_regclass('public.followup_intents') is not null or to_regclass('public.followup_intent_events') is not null
     or to_regclass('public.v_followup_intent_health') is not null or to_regclass('public.uq_send_queue_followup_intent_live') is not null
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'followup_intent%' or p.proname in ('followup_thread_state_guard', 'followup_no_empty_claimable_guard')))
     or exists (select 1 from pg_trigger where not tgisinternal and tgname like '%followup_%') then
    raise exception 'rollback postcondition: follow-up lifecycle objects remain';
  end if;
end $$;
commit;
