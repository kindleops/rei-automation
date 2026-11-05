-- PRETEST for PROPOSED_20261020100000_action_gateway_t2.sql (link #27). DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. The runner proves it leaves no trace.
-- Asserts the prerequisites the apply relies on:
--   * link #26 (action_gateway) is applied and its self-check is ok;
--   * the follow-up lifecycle writer / cancel path and the campaign lifecycle writer exist;
--   * none of this link's functions exist yet, and this link is not registered.
begin;
do $$
declare t text; problems text[] := '{}'; v jsonb;
begin
  if to_regnamespace('action_gateway') is null or to_regprocedure('action_gateway.dw_begin(uuid,uuid,text[])') is null then
    problems := problems || 'link #26 (action_gateway) is not applied'::text;
  else
    v := action_gateway.self_check('lc_action_gateway');
    if not coalesce((v ->> 'ok')::boolean, false) then problems := problems || ('the #26 self-check is not ok: ' || (v -> 'findings')::text); end if;
  end if;
  foreach t in array array['public.followup_intent_plan(jsonb)','public.followup_intent_close_for_thread(jsonb)','public.followup_intent_cancel_row(uuid,text,text,boolean)',
      'public.followup_intent_project(text)','public.campaign_transition_status(uuid,text,text,timestamp with time zone)','public.automation_hold_for(text,uuid,text,uuid,text,text)'] loop
    if to_regprocedure(t) is null then problems := problems || ('missing function ' || t); end if;
  end loop;
  if to_regclass('public.followup_intents') is null then problems := problems || 'missing public.followup_intents'::text; end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('action_gateway_dw_deal_action', 'action_gateway_dw_followup_schedule',
               'action_gateway_dw_followup_cancel', 'action_gateway_dw_campaign_pause', 'action_gateway_dw_human_request', 'action_gateway_followup_intents')) then
    problems := problems || 'a T2 function already exists'::text;
  end if;
  if to_regclass('action_gateway.extensions') is not null then
    execute 'select count(*) from action_gateway.extensions where link = $1' into t using 'PROPOSED_20261020100000_action_gateway_t2';
    if t <> '0' then problems := problems || 'link #27 is already registered'::text; end if;
  end if;
  if array_length(problems, 1) > 0 then raise exception 'pretest: %', array_to_string(problems, '; '); end if;
  raise notice 'pretest: prerequisites present; registry present = %', to_regclass('action_gateway.extensions') is not null;
end $$;
rollback;
