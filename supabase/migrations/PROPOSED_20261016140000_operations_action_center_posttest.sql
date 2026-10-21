-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261016140000_operations_action_center.sql (8.5.20 part C).
-- Runs AFTER the runner applied the migration; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id operations_action_center
-- Expected last notice: "posttest(operations_action_center): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;

-- ── grants + shape ──────────────────────────────────────────────────────────
do $$
begin
  if not has_function_privilege('agent_api', 'agent.ops_conversation_facts(timestamptz, uuid, integer)', 'execute') then raise exception 'assert: agent_api reads conversation facts'; end if;
  if not has_function_privilege('agent_api', 'agent.ops_work_item_sync(text, uuid, jsonb, boolean)', 'execute') then raise exception 'assert: agent_api syncs work items'; end if;
  if has_function_privilege('anon', 'agent.ops_conversation_facts(timestamptz, uuid, integer)', 'execute') then raise exception 'assert: anon has no execute'; end if;
  if has_function_privilege('authenticated', 'agent.ops_work_item_decide(uuid, text, text)', 'execute') then raise exception 'assert: authenticated has no execute'; end if;
  if has_function_privilege('agent_api', 'agent.ops_scope_of_kind(text)', 'execute') then raise exception 'assert: internal helper not granted'; end if;
  if has_table_privilege('agent_api', 'public.inbox_thread_state', 'select') then raise exception 'assert: agent_api cannot read public directly'; end if;
  if has_table_privilege('agent_api', 'agent.ops_work_item', 'insert') or has_table_privilege('agent_api', 'agent.conversation_action_state', 'update') then raise exception 'assert: tables are read-only to agent_api'; end if;
  if has_table_privilege('anon', 'agent.conversation_action_state', 'select') then raise exception 'assert: anon reads nothing'; end if;
  if exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where p.prosecdef and s.nspname = 'agent' and p.proname like 'ops\_%' and not exists (
       select 1 from unnest(p.proconfig) c where c like 'search_path=%')) then raise exception 'assert: every ops SECURITY DEFINER function pins search_path'; end if;
  raise notice 'posttest(operations_action_center): grants OK';
end
$$;

-- ── behaviour ───────────────────────────────────────────────────────────────
do $$
declare
  op constant text := '11111111-1111-4111-8111-111111111111';
  t_wait uuid; t_opt uuid; o_live uuid; c jsonb; tok uuid; jid text; r jsonb; facts jsonb; w uuid; v text; n int;
begin
  -- seed: a seller waiting on an unanswered offer request, an opted-out thread, a live "offer" with no offer event
  insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, seller_stage, contactability_status, is_archived, updated_at)
    values ('+15550000001', '+15550000001', '2124415662', 'offer_interest', 'contactable', true, now() - interval '2 days') returning id into t_wait;
  insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, seller_stage, contactability_status, updated_at)
    values ('+15550000002', '+15550000002', '2124415663', 'ownership_confirmation', 'opted_out', now() - interval '1 day') returning id into t_opt;
  insert into public.inbox_thread_state (thread_key, canonical_e164, updated_at) values ('+15550000003', '+15550000003', now());   -- outbound only: never a candidate
  insert into public.message_events (thread_key, direction, detected_intent, event_timestamp) values
    ('+15550000001', 'outbound', null, now() - interval '3 days'),
    ('+15550000001', 'inbound', 'ownership_confirmed', now() - interval '2 days 23 hours'),
    ('+15550000001', 'inbound', 'asks_offer', now() - interval '2 days'),
    ('+15550000002', 'inbound', 'opt_out', now() - interval '1 day'),
    ('+15550000003', 'outbound', null, now());
  update public.message_events set is_opt_out = true where thread_key = '+15550000002';
  insert into public.acquisition_opportunities (dedupe_key, primary_thread_key, primary_property_id, acquisition_stage, opportunity_status, stage_entered_at)
    values ('t1', '+15550000001', '2124415662', 'offer', 'active', now() - interval '20 days') returning id into o_live;

  -- read functions, AS agent_api
  set local role agent_api;
  facts := agent.ops_conversation_facts(null, null, 10);
  if jsonb_array_length(facts) <> 2 then raise exception 'assert: two conversations with an inbound (got %)', jsonb_array_length(facts); end if;
  if facts::text ~ '\+1555' or facts::text ~ '"thread_key"' or facts::text ~ 'canonical_e164' then raise exception 'assert: no phone / thread key leaves the facts'; end if;
  select count(*) into n from jsonb_array_elements(facts) e where e ->> 'conversation_id' = t_wait::text and e ->> 'last_meaningful_intent' = 'asks_offer' and (e ->> 'outbound_after_inbound')::int = 0 and e ->> 'opportunity_id' = o_live::text;
  if n <> 1 then raise exception 'assert: the waiting seller is read with its offer request and opportunity (%)', facts; end if;
  select count(*) into n from jsonb_array_elements(facts) e where e ->> 'conversation_id' = t_opt::text and (e ->> 'any_opt_out')::boolean;
  if n <> 1 then raise exception 'assert: the opt-out is read'; end if;
  -- keyset: after the first row only the second remains
  if jsonb_array_length(agent.ops_conversation_facts(now() - interval '36 hours', '00000000-0000-0000-0000-000000000000', 10)) <> 1 then raise exception 'assert: keyset cursor'; end if;
  if jsonb_array_length(agent.ops_pipeline_facts(null, 10)) <> 1 then raise exception 'assert: one live opportunity'; end if;
  if (agent.ops_supervisor_snapshot(now()) -> 'pipeline' ->> 'live')::int <> 1 then raise exception 'assert: supervisor snapshot reads the pipeline'; end if;
  if (agent.ops_brief_facts(now() - interval '1 day', now()) -> 'offers_prepared' ->> 'count')::int <> 0 then raise exception 'assert: brief facts read offers (0 rows is a real 0)'; end if;
  begin
    insert into agent.ops_work_item (org_id, scope, kind, dedupe_key, severity, title, subject_type) values ('00000000-0000-4000-8000-00000000a001', 'supervisor', 'remediation', 'supervisor:x', 'info', 'x', 'system');
    raise exception 'assert: agent_api cannot insert work items directly';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- lease-bound writers
  update agent.runtime_limits set runtime_enabled = true,
    kind_limits = jsonb_build_object('inbox.action_center', jsonb_build_object('enabled', true, 'max_concurrency', 1, 'armed_by', op),
                                     'ops.health_check', jsonb_build_object('enabled', true, 'max_concurrency', 1, 'armed_by', op)) where id = 1;
  perform agent.runtime_enqueue('inbox.action_center', encode(sha256('ops-posttest-1'::bytea), 'hex'), '{}'::jsonb, op);
  c := agent.runtime_claim('posttest', 1, array['inbox.action_center']);
  jid := c -> 'claimed' -> 0 ->> 'job_id'; tok := (c -> 'claimed' -> 0 ->> 'lease_token')::uuid;
  if jid is null then raise exception 'assert: action center job claimed (%)', c; end if;
  perform agent.runtime_start(jid, tok);
  r := agent.ops_action_state_upsert(jid, tok, jsonb_build_array(jsonb_build_object('conversation_id', t_wait, 'state', 'needs_attention', 'owner', 'none',
         'verified_stage', 'property_condition', 'stage_verified', false, 'stage_note', 'offer_stage_without_offer_event', 'next_action', 'answer the seller',
         'priority_reason', 'seller_waiting', 'lost', true, 'reasons', jsonb_build_array('meaningful_inbound_without_next_action'), 'version', 'action-center.v1',
         'evidence_refs', jsonb_build_array(jsonb_build_object('source', 'public.acquisition_opportunities', 'record_id', o_live)), 'property_ref', 'pid_ghijklmnop')));
  if not (r ->> 'ok')::boolean or (r ->> 'changed')::int <> 1 then raise exception 'assert: upsert (%)', r; end if;
  r := agent.ops_action_state_upsert(jid, tok, jsonb_build_array(jsonb_build_object('conversation_id', t_wait, 'state', 'needs_attention', 'owner', 'none', 'stage_verified', false,
         'next_action', 'answer the seller', 'priority_reason', 'seller_waiting', 'lost', true, 'version', 'action-center.v1')));
  if (r ->> 'changed')::int <> 0 then raise exception 'assert: same state is not a change'; end if;
  if (select count(*) from agent.v_action_center_queue) <> 1 then raise exception 'assert: the active queue shows the lost conversation'; end if;
  if (agent.ops_action_state_upsert(jid, gen_random_uuid(), '[]'::jsonb) ->> 'reason') <> 'lease_lost' then raise exception 'assert: a wrong token writes nothing'; end if;
  begin
    perform agent.ops_action_state_upsert(jid, tok, jsonb_build_array(jsonb_build_object('conversation_id', t_opt, 'state', 'waiting_on_seller', 'owner', 'seller', 'stage_verified', false,
            'next_action', 'call +1 555 000 0002', 'priority_reason', 'x', 'version', 'action-center.v1')));
    raise exception 'assert: a phone in next_action is refused';
  exception when check_violation then null;
  end;
  begin
    perform agent.ops_action_state_upsert(jid, tok, jsonb_build_array(jsonb_build_object('conversation_id', t_opt, 'state', 'archived', 'owner', 'none', 'stage_verified', false,
            'next_action', 'x', 'priority_reason', 'x', 'version', 'action-center.v1')));
    raise exception 'assert: only the nine states';
  exception when check_violation then null;
  end;

  -- work items: scope-bound, de-duplicated, auto-resolved, reopened, operator decisions
  r := agent.ops_work_item_sync(jid, tok, jsonb_build_array(jsonb_build_object('dedupe_key', 'action_center:lost:' || t_wait, 'kind', 'lost_conversation', 'severity', 'warning',
         'title', 'Seller message without a next action', 'subject_type', 'conversation', 'subject_id', t_wait::text)), true);
  if (r ->> 'inserted')::int <> 1 then raise exception 'assert: work item inserted (%)', r; end if;
  if (agent.ops_work_item_sync(jid, tok, jsonb_build_array(jsonb_build_object('dedupe_key', 'supervisor:x', 'kind', 'remediation', 'title', 'x', 'subject_type', 'system'))) ->> 'reason') <> 'dedupe_key_outside_scope' then
    raise exception 'assert: a job only writes its own scope';
  end if;
  r := agent.ops_work_item_sync(jid, tok, '[]'::jsonb, true);
  if (r ->> 'resolved')::int <> 1 then raise exception 'assert: close_missing resolves a cleared condition (%)', r; end if;
  r := agent.ops_work_item_sync(jid, tok, jsonb_build_array(jsonb_build_object('dedupe_key', 'action_center:lost:' || t_wait, 'kind', 'lost_conversation', 'severity', 'warning',
         'title', 'Seller message without a next action', 'subject_type', 'conversation', 'subject_id', t_wait::text)), false);
  select work_item_id, state into w, v from agent.ops_work_item where dedupe_key = 'action_center:lost:' || t_wait;
  if v <> 'open' or (r ->> 'reopened')::int <> 1 then raise exception 'assert: a recurring condition reopens an auto-resolved item (% %)', v, r; end if;
  if (agent.ops_work_item_decide(w, 'system:cron', 'acknowledge') ->> 'reason') <> 'by_not_named_operator' then raise exception 'assert: decisions need a named operator'; end if;
  if not (agent.ops_work_item_decide(w, op, 'acknowledge') ->> 'ok')::boolean then raise exception 'assert: acknowledge'; end if;
  if not (agent.ops_work_item_decide(w, op, 'dismiss') ->> 'ok')::boolean then raise exception 'assert: dismiss'; end if;
  perform agent.ops_work_item_sync(jid, tok, jsonb_build_array(jsonb_build_object('dedupe_key', 'action_center:lost:' || t_wait, 'kind', 'lost_conversation', 'severity', 'warning',
         'title', 'Seller message without a next action', 'subject_type', 'conversation', 'subject_id', t_wait::text)), false);
  if (select state from agent.ops_work_item where work_item_id = w) <> 'dismissed' then raise exception 'assert: an operator dismissal stands'; end if;

  -- another kind's lease cannot write action states
  perform agent.runtime_enqueue('ops.health_check', encode(sha256('ops-posttest-2'::bytea), 'hex'), '{}'::jsonb, op);
  c := agent.runtime_claim('posttest', 1, array['ops.health_check']);
  perform agent.runtime_start(c -> 'claimed' -> 0 ->> 'job_id', (c -> 'claimed' -> 0 ->> 'lease_token')::uuid);
  if (agent.ops_action_state_upsert(c -> 'claimed' -> 0 ->> 'job_id', (c -> 'claimed' -> 0 ->> 'lease_token')::uuid, '[]'::jsonb) ->> 'reason') <> 'kind_not_allowed' then
    raise exception 'assert: only inbox.action_center writes action states';
  end if;
  if (agent.ops_work_item_sync(c -> 'claimed' -> 0 ->> 'job_id', (c -> 'claimed' -> 0 ->> 'lease_token')::uuid, '[]'::jsonb) ->> 'reason') <> 'kind_not_allowed' then
    raise exception 'assert: ops.health_check has no work-item scope';
  end if;
  -- nothing in public was written by any ops function
  if (select count(*) from public.inbox_thread_state) <> 3 or (select count(*) from public.send_queue) <> 0 then raise exception 'assert: public untouched'; end if;
  raise notice 'posttest(operations_action_center): behaviour OK';
end
$$;
do $$ begin raise notice 'posttest(operations_action_center): ALL OK (rolled back)'; end $$;
rollback;
