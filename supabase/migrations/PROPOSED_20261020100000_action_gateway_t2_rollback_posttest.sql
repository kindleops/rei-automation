-- POSTTEST of the rollback of PROPOSED_20261020100000_action_gateway_t2.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It is read-only and ends in ROLLBACK. With the runner's fingerprint comparison it proves the rollback
-- removed exactly this link's objects and restored #26.
begin;
do $$
declare problems text[] := '{}'; v jsonb;
begin
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('action_gateway_dw_deal_action', 'action_gateway_dw_followup_schedule',
               'action_gateway_dw_followup_cancel', 'action_gateway_dw_campaign_pause', 'action_gateway_dw_human_request', 'action_gateway_followup_intents')) then
    problems := problems || 'a T2 function remains'::text;
  end if;
  if to_regprocedure('action_gateway.t2_never_revive(uuid,text,uuid,text)') is not null then problems := problems || 't2_never_revive remains'::text; end if;
  if to_regclass('action_gateway.extensions') is not null then problems := problems || 'the extension registry remains (no other link registered)'::text; end if;
  if action_gateway.standing_t2_actions() <> array['set_thread_hold']::text[] then problems := problems || 'standing_t2_actions() is not #26''s'::text; end if;
  if (select provolatile from pg_proc where oid = 'action_gateway.standing_t2_actions()'::regprocedure) <> 'i' then problems := problems || 'standing_t2_actions() is not IMMUTABLE again'::text; end if;
  -- #26 is intact and its self-check still ok
  v := action_gateway.self_check('lc_action_gateway');
  if not coalesce((v ->> 'ok')::boolean, false) then problems := problems || ('the #26 self-check is not ok: ' || (v -> 'findings')::text); end if;
  if to_regprocedure('public.action_gateway_dw_thread_hold_set(uuid,uuid)') is null or to_regprocedure('public.action_gateway_complete(uuid,uuid,text,text,jsonb)') is null then
    problems := problems || 'a #26 function was dropped'::text;
  end if;
  if to_regprocedure('public.followup_intent_plan(jsonb)') is null or to_regprocedure('public.campaign_transition_status(uuid,text,text,timestamp with time zone)') is null then
    problems := problems || 'a domain writer the T2 link wrapped was dropped'::text;
  end if;
  if array_length(problems, 1) > 0 then raise exception 'rollback posttest: %', array_to_string(problems, '; '); end if;
  raise notice 'rollback posttest: only link #27''s objects are gone; #26 is restored';
end $$;
rollback;
