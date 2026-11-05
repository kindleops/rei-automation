-- POSTTEST for PROPOSED_20261020100000_action_gateway_t2.sql (link #27). DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- One transaction, ends in ROLLBACK. Every probe of the role runs AS lc_action_gateway with the tenant claim.
-- It proves:
--   A. the registry composes: standing_t2_actions() = set_thread_hold ∪ the registered actions (each with its
--      basis); action_gateway_complete() refuses every registered domain-write action (no "completed without
--      its write"); a row another link registers joins the union; the self-check stays ok and still NAMES a
--      finding for a raw write;
--   B. the role still cannot write followup_intents, campaigns or approval_request directly;
--   C. pause_campaign: open → authorize (standing grant alone) → claim → the lifecycle writer → paused;
--   D. schedule_followup: a planned intent through followup_intent_plan with the lifecycle's own fi1. key;
--      a HOLD (checked at plan, R7) and a suppressed thread are refused with no intent written;
--      cancel_followup: the intent is cancelled through the lifecycle cancel path;
--   E. the human request: a request that does not match the intent (another capability / another stage) is
--      refused; a stage request to a closing stage is refused; the Hartford hold and a permanent exclusion
--      can never be the subject of a release request; a matching request files ONE pending approval for a
--      human (requested_by = the sponsor), and the gateway role cannot decide it;
--   F. irreversible T2 that is NOT registered stays per-use-approval only (a standing grant alone refuses it).
begin;

do $$
declare
  org_a uuid := '00000000-0000-4000-8000-00000000ab01';
  owner_a uuid := '1a2ee0ff-0000-4000-8000-0000000000e1';
  op_a uuid := '1a2ee0ff-0000-4000-8000-0000000000e2';
  dig text := repeat('c3', 32);
  thread uuid := gen_random_uuid(); thread_s uuid := gen_random_uuid(); hthread uuid := '596a9368-6ef8-40f8-97cb-fcc46e6672d3';
  camp uuid := gen_random_uuid(); opp uuid := gen_random_uuid();
  g jsonb := '{}'::jsonb; cap text; gid uuid;
  ii uuid; tok uuid; j jsonb; v text; n bigint; fid uuid; hid uuid; hh uuid; pe uuid;
  fails text[] := '{}';
begin
  insert into agent.org (org_id, name) values (org_a, 'T2 posttest org') on conflict do nothing;
  insert into agent.operator_membership (org_id, user_id, role, added_by) values (org_a, owner_a, 'owner', 'posttest'), (org_a, op_a, 'operator', 'posttest');
  insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, created_by)
  values ('agt_t2post', org_a, 'T2 posttest agent', op_a, dig, now() + interval '30 days', 2, owner_a);
  foreach cap in array array['campaigns.pause', 'followups.schedule', 'followups.cancel', 'leads.update_stage', 'holds.request_release', 'offers.record_counter'] loop
    insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, granted_by, expires_at) values (org_a, 'agt_t2post', cap, 2, owner_a, now() + interval '30 days')
    returning grant_id into gid;
    g := g || jsonb_build_object(cap, gid);
  end loop;
  insert into public.inbox_thread_state (id, thread_key, property_id) values (thread, '+13125550171', 'pt-prop-1'), (thread_s, '+13125550172', 'pt-prop-2'), (hthread, '+13125550173', '225438557');
  update public.inbox_thread_state set is_suppressed = true where id = thread_s;
  insert into public.campaigns (id, name, status) values (camp, 'posttest campaign', 'active');
  insert into public.acquisition_opportunities (id, primary_property_id, acquisition_stage, opportunity_status) values (opp, 'pt-prop-1', 'asking_price', 'active');
  insert into public.system_control (key, value) values ('action_gateway_enabled', 'true'), ('action_gateway_tiers', 'T1,T2') on conflict (key) do update set value = excluded.value;
  perform set_config('request.jwt.claim.lc_org', org_a::text, true);

  -- ── A. the registry ─────────────────────────────────────────────────────────
  foreach v in array array['set_thread_hold', 'pause_campaign', 'cancel_followup', 'schedule_followup', 'create_deal_action', 'update_lead_stage', 'update_lead_disposition', 'update_lead_temperature',
                           'request_thread_hold_release', 'request_campaign_resume', 'adjust_campaign_plan'] loop
    if not (v = any (action_gateway.standing_t2_actions())) then fails := fails || ('A: not standing: ' || v); end if;
  end loop;
  if 'record_seller_counteroffer' = any (action_gateway.standing_t2_actions()) then fails := fails || 'A: an unregistered T2 action is standing'::text; end if;
  if (select count(*) from action_gateway.extensions where kind = 'standing_t2_action' and basis = 'request_only') <> 6
     or (select count(*) from action_gateway.extensions where kind = 'standing_t2_action' and basis = 'reversible') <> 4 then fails := fails || 'A: registry bases'::text; end if;
  insert into action_gateway.extensions (kind, name, link, basis) values ('standing_t2_action', 'zz_other_link_action', 'posttest_other_link', 'reversible');
  if not ('zz_other_link_action' = any (action_gateway.standing_t2_actions())) then fails := fails || 'A: another link''s row does not join the union'::text; end if;
  delete from action_gateway.extensions where link = 'posttest_other_link';
  j := action_gateway.self_check('lc_action_gateway');
  if not (j ->> 'ok')::boolean then fails := fails || ('A: self-check ' || (j -> 'findings')::text); end if;
  execute 'grant insert on public.followup_intents to lc_action_gateway';
  j := action_gateway.self_check('lc_action_gateway');
  execute 'revoke insert on public.followup_intents from lc_action_gateway';
  if (j ->> 'ok')::boolean or not (j -> 'findings')::text ~ 'write_privilege:public.followup_intents' then fails := fails || ('A: a raw write was not named: ' || (j -> 'findings')::text); end if;

  -- ── B. raw writes are refused ──────────────────────────────────────────────
  foreach v in array array[
      'insert into public.followup_intents (intent_key, thread_key, kind, intent, due_at, writer) values (''x'', ''+13125550171'', ''k'', ''i'', now(), ''w'')',
      'update public.campaigns set status = ''paused''',
      'select public.followup_intent_plan(''{}''::jsonb)',
      'select public.campaign_transition_status(gen_random_uuid(), ''paused'')',
      'select agent.capability_approval_transition(''00000000-0000-4000-8000-00000000ab01'', ''apr_x'', array[''pending''], ''executing'')',
      'select count(*) from action_gateway.extensions'] loop
    begin
      execute 'set local role lc_action_gateway';
      execute v;
      execute 'reset role';
      fails := fails || ('B: not refused: ' || left(v, 90));
    exception when others then
      if sqlstate <> '42501' then fails := fails || format('B: %s refused with %s: %s', left(v, 60), sqlstate, left(sqlerrm, 100)); end if;
    end;
  end loop;

  -- ── C. pause_campaign end to end ───────────────────────────────────────────
  execute 'set local role lc_action_gateway';
  ii := (public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_t2post', 'action', 'pause_campaign', 'capability', 'campaigns.pause', 'tier', 2,
          'resource_type', 'campaign', 'resource_id', camp::text, 'client_key', 'pt-pause-0001', 'idempotency_key', md5('pause') || md5('pause1'),
          'params', jsonb_build_object('campaign_id', camp, 'reason_code', 'deliverability_concern'), 'params_hash', repeat('a', 64), 'correlation_id', gen_random_uuid())) -> 'intent' ->> 'intent_id')::uuid;
  j := public.action_gateway_authorize(ii, dig, jsonb_build_object('grant_id', g ->> 'campaigns.pause', 'policy_id', 'pause_campaign.policy', 'policy_version', 'v1'));
  if not coalesce((j ->> 'ok')::boolean, false) or j -> 'intent' ->> 'state' <> 'authorized' then fails := fails || ('C: a standing grant did not authorize pause: ' || j::text); end if;
  tok := (public.action_gateway_claim(ii, 'pt-worker', 30) ->> 'lease_token')::uuid;
  j := public.action_gateway_complete(ii, tok, 'succeeded', 'FAKE', '{}'::jsonb);
  if j ->> 'reason' is distinct from 'domain_write_action' then fails := fails || ('A: complete() accepted a registered domain-write action: ' || j::text); end if;
  j := public.action_gateway_dw_campaign_pause(ii, tok);
  execute 'reset role';
  if j ->> 'code' <> 'CAMPAIGN_PAUSED' or (select status from public.campaigns where id = camp) <> 'paused' then fails := fails || ('C: pause ' || j::text); end if;
  if (select last_transition_reason from public.campaigns where id = camp) !~ '^agent_pause:agt_t2post:' then fails := fails || 'C: the lifecycle writer did not record the agent reason'::text; end if;

  -- ── D. follow-ups ──────────────────────────────────────────────────────────
  foreach v in array array['plain', 'held', 'suppressed'] loop
    if v = 'held' then
      insert into public.automation_holds (hold_key, hold_type, thread_key, inbox_thread_id, reason, set_by, approval_ref) values ('pt:hold', 'operator_hold', '+13125550171', thread, 'posttest', 'owner', 'pt') returning id into hid;
    end if;
    execute 'set local role lc_action_gateway';
    ii := (public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_t2post', 'action', 'schedule_followup', 'capability', 'followups.schedule', 'tier', 2,
            'resource_type', 'thread', 'resource_id', (case v when 'suppressed' then thread_s else thread end)::text, 'client_key', 'pt-fu-' || v || '-01', 'idempotency_key', md5('fu' || v) || md5('fu2' || v),
            'params', jsonb_build_object('thread_id', case v when 'suppressed' then thread_s else thread end, 'kind', 'seller_requested_callback', 'intent', 'seller_callback',
                                         'use_case', 'nurture_seller_callback', 'due_at', now() + interval '3 days', 'reason_code', 'seller_asked_for_callback'),
            'params_hash', repeat('b', 64), 'correlation_id', gen_random_uuid())) -> 'intent' ->> 'intent_id')::uuid;
    perform public.action_gateway_authorize(ii, dig, jsonb_build_object('grant_id', g ->> 'followups.schedule', 'policy_id', 'schedule_followup.policy', 'policy_version', 'v1'));
    tok := (public.action_gateway_claim(ii, 'pt-worker', 30) ->> 'lease_token')::uuid;
    j := public.action_gateway_dw_followup_schedule(ii, tok);
    execute 'reset role';
    if v = 'plain' then
      fid := (j -> 'result' ->> 'followup_intent_id')::uuid;
      if j ->> 'code' <> 'FOLLOWUP_PLANNED' or not exists (select 1 from public.followup_intents where id = fid and state = 'planned' and writer = 'action_gateway'
           and intent_key = 'fi1.' || left(encode(sha256(convert_to('followup-lifecycle.v1|+13125550171|pt-prop-1|seller_requested_callback|cause:action_intent:' || ii::text, 'UTF8')), 'hex'), 40)) then
        fails := fails || ('D: plan ' || j::text);
      end if;
      if exists (select 1 from public.followup_intents where id = fid and row_spec::text ~ 'action_gateway' and not (row_spec -> 'metadata' ->> 'messaging_category' = 'scheduled_followup')) then
        fails := fails || 'D: the contact-window category is not scheduled_followup'::text;
      end if;
      -- cancel it through the lifecycle cancel path (allowed under the hold set next)
      insert into public.automation_holds (hold_key, hold_type, thread_key, inbox_thread_id, reason, set_by, approval_ref) values ('pt:hold-c', 'operator_hold', '+13125550171', thread, 'posttest', 'owner', 'pt') returning id into hh;
      execute 'set local role lc_action_gateway';
      ii := (public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_t2post', 'action', 'cancel_followup', 'capability', 'followups.cancel', 'tier', 2,
              'resource_type', 'thread', 'resource_id', thread::text, 'client_key', 'pt-fu-cancel-01', 'idempotency_key', md5('cancel') || md5('cancel2'),
              'params', jsonb_build_object('thread_id', thread, 'followup_intent_id', fid, 'reason_code', 'seller_replied'), 'params_hash', repeat('c', 64), 'correlation_id', gen_random_uuid())) -> 'intent' ->> 'intent_id')::uuid;
      perform public.action_gateway_authorize(ii, dig, jsonb_build_object('grant_id', g ->> 'followups.cancel', 'policy_id', 'cancel_followup.policy', 'policy_version', 'v1'));
      tok := (public.action_gateway_claim(ii, 'pt-worker', 30) ->> 'lease_token')::uuid;
      j := public.action_gateway_dw_followup_cancel(ii, tok);
      execute 'reset role';
      if j ->> 'code' <> 'FOLLOWUP_CANCELLED' or (select state from public.followup_intents where id = fid) <> 'cancelled'
         or (select reason from public.followup_intents where id = fid) <> 'agent_cancel:seller_replied' then fails := fails || ('D: cancel ' || j::text); end if;
      update public.automation_holds set released_at = now(), released_by = 'owner', release_reason = 'posttest' where id = hh;
    elsif v = 'held' then
      if j ->> 'code' <> 'AUTOMATION_HOLD' or j ->> 'status' <> 'refused' then fails := fails || ('D: a held thread was planned: ' || j::text); end if;
      update public.automation_holds set released_at = now(), released_by = 'owner', release_reason = 'posttest' where id = hid;
    else
      if j ->> 'code' <> 'CONTACT_NOT_PERMITTED' then fails := fails || ('D: a suppressed thread was planned: ' || j::text); end if;
    end if;
  end loop;
  if (select count(*) from public.followup_intents where writer = 'action_gateway') <> 1 then fails := fails || 'D: a refused plan wrote an intent'::text; end if;

  -- ── E. human requests ──────────────────────────────────────────────────────
  insert into public.automation_holds (hold_key, hold_type, thread_key, inbox_thread_id, property_id, reason, set_by, approval_ref)
  values ('owner_hold_20261016:hartford', 'operator_hold', '+13125550173', hthread, '225438557', 'posttest', 'owner', 'pt') returning id into hh;
  insert into public.automation_holds (hold_key, hold_type, thread_key, inbox_thread_id, reason, set_by, approval_ref)
  values ('pt:permanent', 'permanent_exclusion', '+13125550171', thread, 'posttest', 'owner', 'pt') returning id into pe;
  foreach v in array array['stage_wrong_cap', 'stage_wrong_change', 'stage_closing', 'release_hartford', 'release_permanent', 'stage_ok'] loop
    execute 'set local role lc_action_gateway';
    if v like 'stage%' then
      ii := (public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_t2post', 'action', 'update_lead_stage', 'capability', 'leads.update_stage', 'tier', 2,
              'resource_type', 'opportunity', 'resource_id', opp::text, 'client_key', 'pt-' || replace(v, '_', '-'), 'idempotency_key', md5(v) || md5(v || '2'),
              'params', jsonb_build_object('opportunity_id', opp, 'to_stage', case v when 'stage_closing' then 'closed' else 'property_condition' end, 'reason', 'seller described the roof',
                                           'source', 'action_gateway:agt_t2post'), 'params_hash', repeat('d', 64), 'correlation_id', gen_random_uuid())) -> 'intent' ->> 'intent_id')::uuid;
      perform public.action_gateway_authorize(ii, dig, jsonb_build_object('grant_id', g ->> 'leads.update_stage', 'policy_id', 'update_lead_stage.policy', 'policy_version', 'v1'));
      tok := (public.action_gateway_claim(ii, 'pt-worker', 30) ->> 'lease_token')::uuid;
      j := public.action_gateway_dw_human_request(ii, tok, jsonb_build_object(
             'capability_id', case v when 'stage_wrong_cap' then 'campaigns.prepare_launch_approval' else 'pipeline.propose_stage_change' end, 'capability_version', 1,
             'target', jsonb_build_object('opportunity_id', opp),
             'intended_change', jsonb_build_object('action', 'stage_change', 'opportunity_id', opp, 'from_stage', 'asking_price',
                                                   'to_stage', case v when 'stage_wrong_change' then 'offer' when 'stage_closing' then 'closed' else 'property_condition' end,
                                                   'reason', 'seller described the roof', 'source', 'action_gateway:agt_t2post'),
             'snapshot_hash', repeat('1', 64), 'payload_hash', repeat('2', 64), 'idempotency_key', md5(v || 'k') || md5(v || 'k2'), 'summary', jsonb_build_array('Move the deal'), 'ttl_seconds', 3600));
    else
      ii := (public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_t2post', 'action', 'request_thread_hold_release', 'capability', 'holds.request_release', 'tier', 2,
              'resource_type', 'thread', 'resource_id', (case v when 'release_hartford' then hthread else thread end)::text, 'client_key', 'pt-' || replace(v, '_', '-'), 'idempotency_key', md5(v) || md5(v || '2'),
              'params', jsonb_build_object('hold_id', case v when 'release_hartford' then hh else pe end, 'thread_id', case v when 'release_hartford' then hthread else thread end,
                                           'reason_code', 'seller_confirmed_ownership', 'source', 'action_gateway:agt_t2post'), 'params_hash', repeat('d', 64), 'correlation_id', gen_random_uuid())) -> 'intent' ->> 'intent_id')::uuid;
      perform public.action_gateway_authorize(ii, dig, jsonb_build_object('grant_id', g ->> 'holds.request_release', 'policy_id', 'request_thread_hold_release.policy', 'policy_version', 'v1'));
      tok := (public.action_gateway_claim(ii, 'pt-worker', 30) ->> 'lease_token')::uuid;
      j := public.action_gateway_dw_human_request(ii, tok, jsonb_build_object('capability_id', 'holds.prepare_release_approval', 'capability_version', 1,
             'target', jsonb_build_object('hold_id', case v when 'release_hartford' then hh else pe end),
             'intended_change', jsonb_build_object('action', 'hold_release', 'hold_id', case v when 'release_hartford' then hh else pe end,
                                                   'thread_id', case v when 'release_hartford' then hthread else thread end, 'reason_code', 'seller_confirmed_ownership', 'source', 'action_gateway:agt_t2post'),
             'snapshot_hash', repeat('1', 64), 'payload_hash', repeat('2', 64), 'idempotency_key', md5(v || 'k') || md5(v || 'k2'), 'summary', '[]'::jsonb));
    end if;
    execute 'reset role';
    if v in ('stage_wrong_cap', 'stage_wrong_change') and j ->> 'code' is distinct from 'REQUEST_DOES_NOT_MATCH_INTENT' then fails := fails || ('E: ' || v || ' ' || j::text); end if;
    if v = 'stage_closing' and j ->> 'code' is distinct from 'CONTRACT_OR_CLOSING_STAGE_REFUSED' then fails := fails || ('E: closing ' || j::text); end if;
    if v = 'release_hartford' and j ->> 'code' is distinct from 'CLOSED_LOST_NEVER_REVIVE' then fails := fails || ('E: Hartford ' || j::text); end if;
    if v = 'release_permanent' and j ->> 'code' is distinct from 'PERMANENT_EXCLUSION' then fails := fails || ('E: permanent ' || j::text); end if;
    if v = 'stage_ok' then
      if j ->> 'code' is distinct from 'HUMAN_APPROVAL_REQUESTED'
         or not exists (select 1 from agent.approval_request a where a.approval_id = j -> 'result' ->> 'approval_id' and a.state = 'pending' and a.requested_by = op_a
                         and a.capability_id = 'pipeline.propose_stage_change' and a.intended_change ->> 'source' = 'action_gateway:agt_t2post' and a.provenance = 'model') then
        fails := fails || ('E: request ' || j::text);
      end if;
      if (select acquisition_stage from public.acquisition_opportunities where id = opp) <> 'asking_price' then fails := fails || 'E: the request changed the stage'::text; end if;
    end if;
  end loop;
  if (select count(*) from agent.approval_request where capability_id in ('pipeline.propose_stage_change', 'holds.prepare_release_approval')) <> 1 then fails := fails || 'E: a refused request filed an approval'::text; end if;

  -- ── F. an unregistered T2 action is never authorized by a standing grant alone ─
  execute 'set local role lc_action_gateway';
  ii := (public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_t2post', 'action', 'record_seller_counteroffer', 'capability', 'offers.record_counter', 'tier', 2,
          'resource_type', 'thread', 'resource_id', thread::text, 'client_key', 'pt-counter-01', 'idempotency_key', md5('counter') || md5('counter2'),
          'params', '{}'::jsonb, 'params_hash', repeat('e', 64), 'correlation_id', gen_random_uuid())) -> 'intent' ->> 'intent_id')::uuid;
  j := public.action_gateway_authorize(ii, dig, jsonb_build_object('grant_id', g ->> 'offers.record_counter', 'policy_id', 'x.policy', 'policy_version', 'v1'));
  execute 'reset role';
  if coalesce((j ->> 'ok')::boolean, false) or j ->> 'code' <> 'T2_ACTION_NOT_REVERSIBLE' then fails := fails || ('F: ' || j::text); end if;

  if array_length(fails, 1) > 0 then raise exception 'action_gateway_t2 posttest failures: %', array_to_string(fails, ' | '); end if;
  raise notice 'action_gateway_t2 posttest: registry, raw-write refusals, pause, plan / hold / suppression / cancel, human requests, standing T2 limits ok';
end $$;

rollback;
