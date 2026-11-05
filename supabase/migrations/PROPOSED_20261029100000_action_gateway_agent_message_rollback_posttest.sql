-- POSTTEST of the rollback of PROPOSED_20261029100000_action_gateway_agent_message.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- Read-only, ends in ROLLBACK. With the runner's fingerprint comparison it proves the rollback removed exactly this link's
-- objects and registry rows and restored #28's / #31's bodies and CHECKs.
begin;
do $$
declare problems text[] := '{}';
begin
  if to_regclass('action_gateway.lead_assignments') is not null or to_regclass('action_gateway.lead_events') is not null or to_regclass('action_gateway.agent_message_restore') is not null
     or to_regclass('action_gateway.agent_text_submissions') is not null then problems := problems || 'a table remains'::text; end if;
  if exists (select 1 from action_gateway.extensions where link = 'PROPOSED_20261029100000_action_gateway_agent_message') then problems := problems || 'registry rows remain'::text; end if;
  if exists (select 1 from pg_proc where proname in ('agent_message_refusal', 'agent_message_policy', 'lc_agent_message_reserve', 'action_gateway_events_since', 'action_gateway_dw_lead_assignment', 'lc_lead_event_append', 'action_gateway_agent_lead_pool', 'action_gateway_send_controls', 'lead_event_ids', 'campaign_target_of', 'property_ref_of',
      'agent_text_policy', 'agent_text_refusal', 'agent_text_usage', 'agent_text_initiated', 'action_gateway_agent_text_submit', 'action_gateway_agent_text_state', 'lc_agent_text_activation', 'lc_agent_text_load',
      'lc_agent_text_reserve', 'lc_agent_text_settle', 'lc_agent_text_delivery_record', 'lc_agent_lead_holder')) then problems := problems || 'a function remains'::text; end if;
  if action_gateway.t34_handoff_kind('queue_agent_message') is not null or action_gateway.t34_handoff_kind('queue_agent_text') is not null then problems := problems || 't34_handoff_kind still lists the agent message / text'::text; end if;
  if action_gateway.t34_capability_refusal('queue_authorized_reply') = 'AGENT_COMPOSES_TEXT' then problems := problems || 'the certified reply is still retired'::text; end if;
  if pg_get_constraintdef((select oid from pg_constraint where conrelid = 'action_gateway.capability_grants'::regclass and conname = 'capability_grants_standing_seller_facing_chk')) ~ 'queue_agent_(message|text)' then problems := problems || '#31''s standing CHECK was not restored'::text; end if;
  if exists (select 1 from pg_attribute where attrelid = 'action_gateway.capability_grants'::regclass and attname = 'agent_message_lead_day_cap' and not attisdropped) then problems := problems || 'the per-grant cap column remains'::text; end if;
  if not coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false) then problems := problems || 'the self-check is not ok after the rollback'::text; end if;
  if array_length(problems, 1) > 0 then raise exception 'rollback posttest: %', array_to_string(problems, '; '); end if;
  raise notice 'rollback posttest: only this link''s objects are gone; #26 / #27 / #28 / #31 are intact';
end $$;
rollback;
