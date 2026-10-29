-- POSTTEST for PROPOSED_20261029100000_action_gateway_agent_message.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- One transaction ending in ROLLBACK (the runner proves the schema is unchanged afterwards):
--   A. the composed self-check is ok; this link's 10 registry rows; the handoff kind; the T2 lead writes are standing,
--      the agent message never is; born OFF (no switch row ⇒ the activation refuses);
--   B. lc_action_gateway executes exactly the seven new gateway functions and none of LeadCommand's (reserve / settle /
--      activation / lead / the event writer); anon / authenticated execute nothing; the role reaches no new table;
--   C. the standing flag is confined (only the two pairs; the per-grant lead cap only on the agent-message capability);
--   D. the event feed is append-only and masked (a phone in a payload is refused).
begin;
do $$
declare v jsonb;
begin
  v := action_gateway.self_check('lc_action_gateway');
  if not coalesce((v ->> 'ok')::boolean, false) then raise exception 'A: composed self-check not ok: %', v -> 'findings'; end if;
  if (select count(*) from action_gateway.extensions where link = 'PROPOSED_20261029100000_action_gateway_agent_message') <> 12 then raise exception 'A: this link''s extension rows'; end if;
  if action_gateway.t34_handoff_kind('queue_agent_message') is distinct from 'action_gateway.execute' then raise exception 'A: the handoff kind'; end if;
  if not (action_gateway.standing_t2_actions() @> array['assign_lead', 'release_lead']) or 'queue_agent_message' = any (action_gateway.standing_t2_actions()) then raise exception 'A: the standing T2 actions'; end if;
  if not exists (select 1 from public.system_control where key = 'ai_agent_message_enabled') and action_gateway.agent_message_refusal() is null then raise exception 'A: not born OFF'; end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.action_gateway_agent_message_state(uuid,uuid,uuid)', 'public.action_gateway_message_templates()', 'public.action_gateway_dw_lead_assignment(uuid,uuid)',
      'public.action_gateway_lead_assignment_get(uuid,uuid)', 'public.action_gateway_events_since(bigint,integer)', 'public.action_gateway_agent_lead_pool(text,integer,text)', 'public.action_gateway_send_controls()'] loop
    if not has_function_privilege('lc_action_gateway', f, 'EXECUTE') then raise exception 'B: the role cannot execute %', f; end if;
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE') then raise exception 'B: anon / authenticated can execute %', f; end if;
  end loop;
  foreach f in array array['public.lc_agent_message_reserve(uuid)', 'public.lc_agent_message_settle(uuid,text)', 'public.lc_agent_message_activation()', 'public.lc_agent_message_lead(uuid)',
      'public.lc_lead_event_append(text,text,text,uuid,jsonb,timestamp with time zone)'] loop
    if has_function_privilege('lc_action_gateway', f, 'EXECUTE') then raise exception 'B: the role reaches LeadCommand''s %', f; end if;
    if not has_function_privilege('service_role', f, 'EXECUTE') then raise exception 'B: LeadCommand''s worker cannot execute %', f; end if;
  end loop;
  foreach f in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if has_table_privilege('lc_action_gateway', 'action_gateway.lead_assignments', f) or has_table_privilege('lc_action_gateway', 'action_gateway.lead_events', f)
       or has_table_privilege('lc_action_gateway', 'action_gateway.agent_message_restore', f) then raise exception 'B: the role reaches a new table (%)', f; end if;
  end loop;
end $$;

do $$
declare ok boolean;
begin
  if pg_get_constraintdef((select oid from pg_constraint where conrelid = 'action_gateway.capability_grants'::regclass and conname = 'capability_grants_standing_seller_facing_chk')) !~ 'conversation.queue_agent_message' then raise exception 'C: the standing pair'; end if;
  if pg_get_constraintdef((select oid from pg_constraint where conrelid = 'action_gateway.capability_grants'::regclass and conname = 'capability_grants_agent_message_lead_day_cap_chk')) !~ 'conversation.queue_agent_message' then raise exception 'C: the lead cap confinement'; end if;
  begin
    insert into action_gateway.lead_events (event_id, kind, payload, occurred_at) values ('inbound_message:posttest-1', 'inbound_message', jsonb_build_object('note', 'call me at 312 555 0161'), now());
    ok := true;
  exception when check_violation then ok := false;
  end;
  if ok then raise exception 'D: a phone in an event payload was accepted'; end if;
  insert into action_gateway.lead_events (event_id, kind, payload, occurred_at) values ('inbound_message:posttest-2', 'inbound_message', '{"message_id":"m-1"}'::jsonb, now());
  begin
    update action_gateway.lead_events set kind = 'opt_out' where event_id = 'inbound_message:posttest-2';
    ok := true;
  exception when others then ok := false;
  end;
  if ok then raise exception 'D: the event feed is not append-only'; end if;
  -- the feed's ids: a property id only in its encoded form (a raw one is encoded or dropped), never contact data
  if action_gateway.property_ref_of('227876842') <> 'pid_iinonmoki' or action_gateway.property_ref_of('p-12') is not null then raise exception 'D: property_ref_of'; end if;
  if action_gateway.lead_event_ids('{"property_id":"227876842"}'::jsonb, null, null) ->> 'property_id' <> 'pid_iinonmoki' then raise exception 'D: a raw property id was not encoded'; end if;
  if action_gateway.lead_event_ids('{"property_id":"p-12"}'::jsonb, null, null) ? 'property_id' then raise exception 'D: an unencodable property id was kept'; end if;
  if has_function_privilege('lc_action_gateway', 'action_gateway.lead_event_ids(jsonb,uuid,text,text,uuid)', 'EXECUTE') or has_function_privilege('lc_action_gateway', 'action_gateway.campaign_target_of(text,text)', 'EXECUTE') then
    raise exception 'B: the role reaches an internal helper';
  end if;
  -- E. the R2 runtime emergency stop refuses every seller-facing send at request time (reply and offer included)
  update agent.runtime_limits set emergency_stop = true, emergency_stop_at = now() where id = 1;
  if action_gateway.t34_capability_refusal('queue_authorized_reply') is distinct from 'EMERGENCY_STOP_ACTIVE'
     or action_gateway.t34_capability_refusal('execute_authorized_offer') is distinct from 'EMERGENCY_STOP_ACTIVE'
     or action_gateway.t34_capability_refusal('queue_agent_message') is distinct from 'EMERGENCY_STOP_ACTIVE' then raise exception 'E: R2 does not refuse a seller-facing send'; end if;
  if action_gateway.t34_capability_refusal('record_seller_counteroffer') is not null then raise exception 'E: recording a counter is not a send'; end if;
  update agent.runtime_limits set emergency_stop = false, emergency_stop_at = null where id = 1;
  raise notice 'posttest: registry, roles, confinement and the feed hold';
end $$;
rollback;
