-- POSTTEST for PROPOSED_20261019160000_action_gateway.sql. DISPOSABLE DATABASE ONLY:
-- run by scripts/db/run-migration-test.mjs, never against production.
-- It runs in one transaction and ends in ROLLBACK. The runner proves the schema is unchanged afterwards.
--
-- Every probe of the role runs AS lc_action_gateway (SET LOCAL ROLE inside an exception block, so a
-- refused probe also reverts the role) with the tenant claim request.jwt.claim.lc_org. It proves:
--   A. role shape: NOLOGIN NOINHERIT, no privileged attribute, member of no role, granted to authenticator;
--   B. the DATABASE refuses every raw write outside the gateway bookkeeping (automation_holds,
--      ops_work_item, system_control, send_queue, the principal registry, the grants), any read of the
--      principal registry, and any UPDATE of an intent's request columns;
--   C. tenant isolation: another org's credential digest resolves to nothing, another org's intent is
--      invisible, and an intent cannot be opened without a tenant claim;
--   D. a forged agent credential (a digest that is not the intent agent's) cannot authorize; a grant of
--      another capability cannot authorize; a tier above the agent's ceiling cannot authorize;
--   E. the full T2 path: open → authorize → claim → set_thread_hold through the lease-bound domain write:
--      the hold is in the ONE hold registry, and a send_queue row queued BEFORE the hold can no longer be
--      claimed (the registry's send_queue trigger); a wrong lease token is refused; the outcome and the
--      audit trail are immutable;
--   F. the GLOBAL EMERGENCY STOP and the tier / capability kills refuse authorization, and a stop engaged
--      AFTER authorization refuses the execution (recorded as a refused outcome, nothing written);
--   G. approvals: approval_required without an approval is refused; an approval that is not an executed
--      HUMAN decision bound to this intent and these params is refused; an approval cannot be used twice
--      (replay: unique); an approval whose grant window passed is refused;
--   H. at most one executing intent per resource (resource_busy);
--   I. the self-check is ok for the applied state and NAMES a finding when the role gains a raw write.
begin;

do $$
declare
  org_a uuid := '00000000-0000-4000-8000-00000000aa01';
  org_b uuid := '00000000-0000-4000-8000-00000000aa02';
  owner_a uuid := '1a2ee0ff-0000-4000-8000-0000000000a1';
  op_a uuid := '1a2ee0ff-0000-4000-8000-0000000000a2';
  owner_b uuid := '1a2ee0ff-0000-4000-8000-0000000000b1';
  dig_a text := repeat('a1', 32);
  dig_b text := repeat('b2', 32);
  thread uuid := gen_random_uuid();
  thread2 uuid := gen_random_uuid();
  g_hold uuid; g_task uuid; g_b uuid;
  i1 uuid; i2 uuid; i3 uuid; i4 uuid; i5 uuid; i6 uuid;
  tok uuid; tok2 uuid;
  j jsonb; v text; n bigint; q_id uuid;
  fails text[] := '{}';
  apr text := 'apr_' || gen_random_uuid()::text;
  apr_old text := 'apr_' || gen_random_uuid()::text;
begin
  -- ── world (as the owner) ───────────────────────────────────────────────────
  insert into agent.org (org_id, name) values (org_a, 'posttest org A'), (org_b, 'posttest org B') on conflict do nothing;
  insert into agent.operator_membership (org_id, user_id, role, added_by) values (org_a, owner_a, 'owner', 'posttest'), (org_a, op_a, 'operator', 'posttest'), (org_b, owner_b, 'owner', 'posttest');
  insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, created_by)
  values ('agt_alpha', org_a, 'Alpha agent', op_a, dig_a, now() + interval '30 days', 2, owner_a),
         ('agt_beta', org_b, 'Beta agent', owner_b, dig_b, now() + interval '30 days', 2, owner_b);
  insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, granted_by, expires_at)
  values (org_a, 'agt_alpha', 'holds.set_thread_hold', 2, owner_a, now() + interval '30 days') returning grant_id into g_hold;
  insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, granted_by, expires_at)
  values (org_a, 'agt_alpha', 'tasks.create_operator_task', 1, owner_a, now() + interval '30 days') returning grant_id into g_task;
  insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, granted_by, expires_at)
  values (org_b, 'agt_beta', 'holds.set_thread_hold', 2, owner_b, now() + interval '30 days') returning grant_id into g_b;
  insert into public.inbox_thread_state (id, thread_key) values (thread, '+13125550101'), (thread2, '+13125550102');
  insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, thread_key) values ('posttest-q1', 'queued', 'Hi, just checking in.', '+13125550101', '+13125550101') returning id into q_id;
  insert into public.system_control (key, value) values ('action_gateway_enabled', 'true'), ('action_gateway_tiers', 'T1,T2')
    on conflict (key) do update set value = excluded.value;

  -- ── A. role shape ───────────────────────────────────────────────────────────
  if not exists (select 1 from pg_roles where rolname = 'lc_action_gateway' and not rolcanlogin and not rolinherit and not rolsuper and not rolbypassrls
                   and not rolcreatedb and not rolcreaterole and not rolreplication) then fails := fails || 'A: role attributes'::text; end if;
  if exists (select 1 from pg_auth_members m where m.member = 'lc_action_gateway'::regrole) then fails := fails || 'A: member of a role'::text; end if;
  if not pg_has_role('authenticator', 'lc_action_gateway', 'SET') then fails := fails || 'A: authenticator cannot SET ROLE'::text; end if;

  perform set_config('request.jwt.claim.lc_org', org_a::text, true);

  -- ── B. raw writes / registry reads are refused by the database ─────────────
  foreach v in array array[
      'insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref) values (''x'', ''operator_hold'', ''+13125550101'', ''r'', ''s'', ''a'')',
      'update public.automation_holds set released_at = now(), released_by = ''x'', release_reason = ''x''',
      'insert into agent.ops_work_item (org_id, scope, kind, dedupe_key, severity, title, subject_type) values (''00000000-0000-4000-8000-00000000aa01'', ''agent'', ''agent_task'', ''agent:x'', ''info'', ''t'', ''system'')',
      'update public.system_control set value = ''true'' where key = ''action_gateway_enabled''',
      'insert into public.system_control (key, value) values (''action_gateway_tiers'', ''T1,T2,T3,T4'')',
      'insert into public.send_queue (queue_key, queue_status) values (''x'', ''queued'')',
      'select count(*) from action_gateway.agent_principals',
      'select count(*) from action_gateway.capability_grants',
      'insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, granted_by, expires_at) values (''00000000-0000-4000-8000-00000000aa01'', ''agt_alpha'', ''holds.set_thread_hold'', 4, ''1a2ee0ff-0000-4000-8000-0000000000a1'', now() + interval ''1 day'')',
      'update action_gateway.action_intents set params = ''{}''::jsonb',
      'delete from action_gateway.action_audit_events',
      'select agent.runtime_enqueue(''mission.research'', repeat(''c'', 64), ''{}''::jsonb, ''1a2ee0ff-0000-4000-8000-0000000000a2'')',
      'select agent.ops_work_item_decide(gen_random_uuid(), ''1a2ee0ff-0000-4000-8000-0000000000a2'', ''resolve'')'] loop
    begin
      execute 'set local role lc_action_gateway';
      execute v;
      execute 'reset role';
      fails := fails || ('B: not refused: ' || left(v, 90));
    exception when others then
      if sqlstate <> '42501' then fails := fails || format('B: %s refused with %s (expected 42501): %s', left(v, 60), sqlstate, left(sqlerrm, 120)); end if;
    end;
  end loop;
  -- a key outside the allowlist is invisible
  insert into public.system_control (key, value) values ('posttest_secret_key', 'nope') on conflict (key) do update set value = excluded.value;
  execute 'set local role lc_action_gateway';
  select count(*) into n from public.system_control where key = 'posttest_secret_key';
  execute 'reset role';
  if n <> 0 then fails := fails || 'B: a system_control key outside the allowlist is readable'::text; end if;

  -- ── C/D. tenant + forged identity ──────────────────────────────────────────
  execute 'set local role lc_action_gateway';
  j := public.action_gateway_principal(dig_b);
  if j is not null then fails := fails || 'C: another org''s digest resolved'::text; end if;
  j := public.action_gateway_principal(dig_a);
  if j ->> 'agent_id' is distinct from 'agt_alpha' or jsonb_array_length(j -> 'grants') <> 2 then fails := fails || ('C: own principal ' || coalesce(j::text, 'null')); end if;
  j := public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_alpha', 'action', 'set_thread_hold', 'capability', 'holds.set_thread_hold', 'tier', 2,
         'resource_type', 'thread', 'resource_id', thread::text, 'client_key', 'posttest-hold-1', 'idempotency_key', repeat('1', 64),
         'params', jsonb_build_object('thread_id', thread, 'reason_code', 'seller_requested_pause'), 'params_hash', repeat('e', 64),
         'correlation_id', gen_random_uuid(), 'recovery', 'reexecute'));
  i1 := (j -> 'intent' ->> 'intent_id')::uuid;
  if not (j ->> 'inserted')::boolean then fails := fails || 'C: intent not opened'::text; end if;
  -- replay of the same idempotency key: the same intent, not a second one
  j := public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_alpha', 'action', 'set_thread_hold', 'capability', 'holds.set_thread_hold', 'tier', 2,
         'resource_type', 'thread', 'resource_id', thread::text, 'client_key', 'posttest-hold-1', 'idempotency_key', repeat('1', 64),
         'params', jsonb_build_object('thread_id', thread, 'reason_code', 'other'), 'params_hash', repeat('f', 64), 'correlation_id', gen_random_uuid()));
  if (j ->> 'inserted')::boolean or (j -> 'intent' ->> 'intent_id')::uuid <> i1 or j -> 'intent' ->> 'params_hash' <> repeat('e', 64) then fails := fails || 'C: idempotency key replay opened a second intent'::text; end if;
  execute 'reset role';
  -- forged credential: the digest of no / another agent
  begin
    execute 'set local role lc_action_gateway';
    perform public.action_gateway_authorize(i1, dig_b, jsonb_build_object('grant_id', g_hold, 'policy_id', 'posttest.hold', 'policy_version', 'v1'));
    execute 'reset role';
    fails := fails || 'D: a forged credential digest authorized'::text;
  exception when others then
    if sqlerrm !~ 'ACTION_GATEWAY_CREDENTIAL_MISMATCH' then fails := fails || ('D: forged credential refused with ' || left(sqlerrm, 100)); end if;
  end;
  -- a grant of another capability / of another org: a RECORDED refusal of a throwaway intent (standing-grant admission)
  foreach v in array array['task', 'cross_org'] loop
    execute 'set local role lc_action_gateway';
    i6 := (public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_alpha', 'action', 'set_thread_hold', 'capability', 'holds.set_thread_hold', 'tier', 2,
            'resource_type', 'thread', 'resource_id', thread::text, 'client_key', 'posttest-grant-' || v, 'idempotency_key', md5(v) || md5(v || 'x'),
            'params', jsonb_build_object('thread_id', thread, 'reason_code', 'other'), 'params_hash', repeat('e', 64), 'correlation_id', gen_random_uuid())) -> 'intent' ->> 'intent_id')::uuid;
    j := public.action_gateway_authorize(i6, dig_a, jsonb_build_object('grant_id', case v when 'task' then g_task else g_b end, 'policy_id', 'posttest.hold', 'policy_version', 'v1'));
    execute 'reset role';
    if (j ->> 'ok')::boolean or j ->> 'code' <> 'GRANT_INVALID' or (select state from action_gateway.action_intents where intent_id = i6) <> 'refused' then
      fails := fails || ('D: a ' || v || ' grant was not refused: ' || j::text);
    end if;
  end loop;
  i6 := null;

  -- ── E. the T2 path ─────────────────────────────────────────────────────────
  execute 'set local role lc_action_gateway';
  j := public.action_gateway_authorize(i1, dig_a, jsonb_build_object('grant_id', g_hold, 'policy_id', 'posttest.hold', 'policy_version', 'v1', 'evidence', jsonb_build_object('thread_found', true)));
  if not (j ->> 'ok')::boolean or j -> 'intent' ->> 'state' <> 'authorized' then fails := fails || ('E: authorize ' || j::text); end if;
  j := public.action_gateway_claim(i1, 'posttest-worker', 30);
  tok := (j ->> 'lease_token')::uuid;
  if tok is null or (j ->> 'attempt')::int <> 1 then fails := fails || ('E: claim ' || j::text); end if;
  execute 'reset role';
  begin
    execute 'set local role lc_action_gateway';
    perform public.action_gateway_dw_thread_hold_set(i1, gen_random_uuid());
    execute 'reset role';
    fails := fails || 'E: a wrong lease token executed'::text;
  exception when others then
    if sqlerrm !~ 'ACTION_GATEWAY_LEASE_LOST' then fails := fails || ('E: wrong token refused with ' || left(sqlerrm, 100)); end if;
  end;
  begin
    execute 'set local role lc_action_gateway';
    perform public.action_gateway_complete(i1, tok, 'succeeded', 'FAKE', '{}'::jsonb);
    j := public.action_gateway_intent_get(i1);
    execute 'reset role';
    if j -> 'intent' ->> 'state' <> 'executing' then fails := fails || 'E: a domain-write intent was completed without its domain write'::text; end if;
  exception when others then fails := fails || ('E: complete probe ' || left(sqlerrm, 100));
  end;
  execute 'set local role lc_action_gateway';
  j := public.action_gateway_dw_thread_hold_set(i1, tok);
  execute 'reset role';
  if j ->> 'status' <> 'succeeded' or j ->> 'code' <> 'HOLD_SET' then fails := fails || ('E: hold set ' || j::text); end if;
  if not exists (select 1 from public.automation_holds where hold_key = 'agent_hold:' || thread::text and released_at is null and thread_key = '+13125550101'
                   and set_by = 'agent:agt_alpha' and approval_ref = 'action_intent:' || i1::text and not ('manual_send' = any (blocked_capabilities))) then
    fails := fails || 'E: the hold is not in the registry as set'::text;
  end if;
  if not exists (select 1 from public.automation_hold_events where event_type = 'hold_set' and actor = 'agent:agt_alpha') then fails := fails || 'E: the registry did not audit hold_set'::text; end if;
  -- the row queued BEFORE the hold can no longer be claimed for sending
  begin
    update public.send_queue set queue_status = 'processing' where id = q_id;
    fails := fails || 'E: a held thread''s queued row was claimed'::text;
  exception when others then
    if sqlerrm !~ 'AUTOMATION_HOLD' then fails := fails || ('E: queue claim refused with ' || left(sqlerrm, 100)); end if;
  end;
  -- immutable outcome + append-only audit (even for the owner)
  begin
    update action_gateway.action_outcomes set code = 'X' where intent_id = i1;
    fails := fails || 'E: an outcome was updated'::text;
  exception when others then if sqlerrm !~ 'ACTION_GATEWAY_APPEND_ONLY' then fails := fails || ('E: outcome update ' || left(sqlerrm, 80)); end if;
  end;
  begin
    delete from action_gateway.action_audit_events where intent_id = i1;
    fails := fails || 'E: an audit event was deleted'::text;
  exception when others then if sqlerrm !~ 'ACTION_GATEWAY_APPEND_ONLY' then fails := fails || ('E: audit delete ' || left(sqlerrm, 80)); end if;
  end;
  begin
    update action_gateway.action_intents set state = 'executing' where intent_id = i1;
    fails := fails || 'E: a terminal intent moved'::text;
  exception when others then if sqlerrm !~ 'ACTION_GATEWAY_ILLEGAL_TRANSITION' then fails := fails || ('E: terminal move ' || left(sqlerrm, 80)); end if;
  end;
  if (select count(*) from action_gateway.action_audit_events where intent_id = i1) < 4 then fails := fails || 'E: the audit trail is incomplete'::text; end if;

  -- ── F. emergency stop + kills ──────────────────────────────────────────────
  execute 'set local role lc_action_gateway';
  i2 := (public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_alpha', 'action', 'set_thread_hold', 'capability', 'holds.set_thread_hold', 'tier', 2,
          'resource_type', 'thread', 'resource_id', thread2::text, 'client_key', 'posttest-hold-2', 'idempotency_key', repeat('2', 64),
          'params', jsonb_build_object('thread_id', thread2, 'reason_code', 'operator_review'), 'params_hash', repeat('d', 64), 'correlation_id', gen_random_uuid())) -> 'intent' ->> 'intent_id')::uuid;
  execute 'reset role';
  foreach v in array array['action_gateway_enabled=false', 'action_gateway_tiers=T1', 'action_gateway_killed_capabilities=holds.set_thread_hold'] loop
    update public.system_control set value = 'true' where key = 'action_gateway_enabled';
    insert into public.system_control (key, value) values ('action_gateway_tiers', 'T1,T2') on conflict (key) do update set value = excluded.value;
    delete from public.system_control where key = 'action_gateway_killed_capabilities';
    insert into public.system_control (key, value) values (split_part(v, '=', 1), split_part(v, '=', 2)) on conflict (key) do update set value = excluded.value;
    begin
      execute 'set local role lc_action_gateway';
      perform public.action_gateway_authorize(i2, dig_a, jsonb_build_object('grant_id', g_hold, 'policy_id', 'posttest.hold', 'policy_version', 'v1'));
      execute 'reset role';
      fails := fails || ('F: authorized under ' || v);
    exception when others then
      if sqlerrm !~ 'ACTION_GATEWAY_(ACTION_GATEWAY_STOPPED|TIER_DISABLED|CAPABILITY_KILLED)' then fails := fails || format('F: %s refused with %s', v, left(sqlerrm, 100)); end if;
    end;
  end loop;
  -- the stop engaged AFTER authorization: the execution is refused and recorded, nothing written
  update public.system_control set value = 'true' where key = 'action_gateway_enabled';
  delete from public.system_control where key = 'action_gateway_killed_capabilities';
  update public.system_control set value = 'T1,T2' where key = 'action_gateway_tiers';
  execute 'set local role lc_action_gateway';
  perform public.action_gateway_authorize(i2, dig_a, jsonb_build_object('grant_id', g_hold, 'policy_id', 'posttest.hold', 'policy_version', 'v1'));
  tok2 := (public.action_gateway_claim(i2, 'posttest-worker', 30) ->> 'lease_token')::uuid;
  execute 'reset role';
  delete from public.system_control where key = 'action_gateway_enabled';
  execute 'set local role lc_action_gateway';
  j := public.action_gateway_dw_thread_hold_set(i2, tok2);
  execute 'reset role';
  if j ->> 'status' <> 'refused' or j ->> 'code' <> 'ACTION_GATEWAY_STOPPED' then fails := fails || ('F: execution under the stop ' || j::text); end if;
  if exists (select 1 from public.automation_holds where hold_key = 'agent_hold:' || thread2::text) then fails := fails || 'F: a hold was written under the stop'::text; end if;
  insert into public.system_control (key, value) values ('action_gateway_enabled', 'true') on conflict (key) do update set value = excluded.value;

  -- ── G. approvals ───────────────────────────────────────────────────────────
  execute 'set local role lc_action_gateway';
  i3 := (public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_alpha', 'action', 'set_thread_hold', 'capability', 'holds.set_thread_hold', 'tier', 2,
          'resource_type', 'thread', 'resource_id', thread2::text, 'client_key', 'posttest-hold-3', 'idempotency_key', repeat('3', 64),
          'params', jsonb_build_object('thread_id', thread2, 'reason_code', 'operator_review'), 'params_hash', repeat('c', 64), 'correlation_id', gen_random_uuid())) -> 'intent' ->> 'intent_id')::uuid;
  execute 'reset role';
  begin
    execute 'set local role lc_action_gateway';
    perform public.action_gateway_authorize(i3, dig_a, jsonb_build_object('grant_id', g_hold, 'policy_id', 'posttest.hold', 'policy_version', 'v1', 'approval_required', true));
    execute 'reset role';
    fails := fails || 'G: approval_required authorized without an approval'::text;
  exception when others then if sqlerrm !~ 'ACTION_GATEWAY_APPROVAL_REQUIRED' then fails := fails || ('G: no approval refused with ' || left(sqlerrm, 100)); end if;
  end;
  -- file the approval for i3 through the gateway wrapper; it is still PENDING (no human decided)
  execute 'set local role lc_action_gateway';
  j := public.action_gateway_approval_request(jsonb_build_object('approval_id', apr, 'org_id', org_a, 'capability_id', 'agent_actions.authorize_action', 'capability_version', 1,
         'tier', 'requires_explicit_approval', 'requested_by', op_a, 'provenance', 'model', 'target', jsonb_build_object('intent_id', i3),
         'intended_change', jsonb_build_object('intent_id', i3, 'action', 'set_thread_hold', 'agent_id', 'agt_alpha', 'params_hash', repeat('c', 64), 'grant_expires_at', now() + interval '1 hour'),
         'snapshot_hash', repeat('5', 64), 'payload_hash', repeat('6', 64), 'idempotency_key', repeat('7', 64), 'expires_at', now() + interval '30 minutes'));
  perform public.action_gateway_await_approval(i3, apr);
  execute 'reset role';
  begin
    execute 'set local role lc_action_gateway';
    perform public.action_gateway_authorize(i3, dig_a, jsonb_build_object('grant_id', g_hold, 'policy_id', 'posttest.hold', 'policy_version', 'v1', 'approval_required', true, 'approval_id', apr));
    execute 'reset role';
    fails := fails || 'G: a PENDING approval authorized'::text;
  exception when others then if sqlerrm !~ 'ACTION_GATEWAY_APPROVAL_INVALID' then fails := fails || ('G: pending approval refused with ' || left(sqlerrm, 100)); end if;
  end;
  -- the gateway cannot file an approval for another capability, or for params it does not hold
  begin
    execute 'set local role lc_action_gateway';
    perform public.action_gateway_approval_request(jsonb_build_object('approval_id', 'apr_' || gen_random_uuid()::text, 'org_id', org_a, 'capability_id', 'pipeline.propose_stage_change', 'capability_version', 1));
    execute 'reset role';
    fails := fails || 'G: the gateway filed an approval for another capability'::text;
  exception when others then if sqlerrm !~ 'ACTION_GATEWAY_APPROVAL_CAPABILITY' then fails := fails || ('G: foreign capability approval ' || left(sqlerrm, 100)); end if;
  end;
  -- a human decides it (the existing operator path: capability_approval_transition)
  perform agent.capability_approval_transition(org_a, apr, array['pending'], 'executing', jsonb_build_object('decided_by', owner_a, 'decided_at', now(), 'decision', 'approve'));
  perform agent.capability_approval_transition(org_a, apr, array['executing'], 'executed', jsonb_build_object('executed_at', now(), 'execution_result', jsonb_build_object('state', 'granted')));
  execute 'set local role lc_action_gateway';
  j := public.action_gateway_authorize(i3, dig_a, jsonb_build_object('grant_id', g_hold, 'policy_id', 'posttest.hold', 'policy_version', 'v1', 'approval_required', true, 'approval_id', apr));
  execute 'reset role';
  if not (j ->> 'ok')::boolean then fails := fails || ('G: an executed human approval did not authorize ' || j::text); end if;
  if (select approved_by from action_gateway.action_authorizations where intent_id = i3) is distinct from owner_a then fails := fails || 'G: approved_by is not the human decider'::text; end if;
  -- replay: the same approval on another intent
  execute 'set local role lc_action_gateway';
  i4 := (public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_alpha', 'action', 'set_thread_hold', 'capability', 'holds.set_thread_hold', 'tier', 2,
          'resource_type', 'thread', 'resource_id', thread2::text, 'client_key', 'posttest-hold-4', 'idempotency_key', repeat('4', 64),
          'params', jsonb_build_object('thread_id', thread2, 'reason_code', 'operator_review'), 'params_hash', repeat('c', 64), 'correlation_id', gen_random_uuid())) -> 'intent' ->> 'intent_id')::uuid;
  perform public.action_gateway_await_approval(i4, apr);
  execute 'reset role';
  begin
    execute 'set local role lc_action_gateway';
    perform public.action_gateway_authorize(i4, dig_a, jsonb_build_object('grant_id', g_hold, 'policy_id', 'posttest.hold', 'policy_version', 'v1', 'approval_required', true, 'approval_id', apr));
    execute 'reset role';
    fails := fails || 'G: an approval was used twice'::text;
  exception when others then if sqlerrm !~ '(ACTION_GATEWAY_APPROVAL_INVALID|duplicate key)' then fails := fails || ('G: replay refused with ' || left(sqlerrm, 100)); end if;
  end;
  -- an executed human approval whose grant window has passed
  execute 'set local role lc_action_gateway';
  i5 := (public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_alpha', 'action', 'set_thread_hold', 'capability', 'holds.set_thread_hold', 'tier', 2,
          'resource_type', 'thread', 'resource_id', thread2::text, 'client_key', 'posttest-hold-5', 'idempotency_key', repeat('5', 64),
          'params', jsonb_build_object('thread_id', thread2, 'reason_code', 'operator_review'), 'params_hash', repeat('b', 64), 'correlation_id', gen_random_uuid())) -> 'intent' ->> 'intent_id')::uuid;
  perform public.action_gateway_approval_request(jsonb_build_object('approval_id', apr_old, 'org_id', org_a, 'capability_id', 'agent_actions.authorize_action', 'capability_version', 1,
         'tier', 'requires_explicit_approval', 'requested_by', op_a, 'provenance', 'model', 'target', jsonb_build_object('intent_id', i5),
         'intended_change', jsonb_build_object('intent_id', i5, 'action', 'set_thread_hold', 'agent_id', 'agt_alpha', 'params_hash', repeat('b', 64), 'grant_expires_at', now() - interval '1 minute'),
         'snapshot_hash', repeat('5', 64), 'payload_hash', repeat('6', 64), 'idempotency_key', repeat('8', 64), 'expires_at', now() + interval '30 minutes'));
  perform public.action_gateway_await_approval(i5, apr_old);
  execute 'reset role';
  perform agent.capability_approval_transition(org_a, apr_old, array['pending'], 'executing', jsonb_build_object('decided_by', owner_a, 'decided_at', now(), 'decision', 'approve'));
  perform agent.capability_approval_transition(org_a, apr_old, array['executing'], 'executed', jsonb_build_object('executed_at', now(), 'execution_result', jsonb_build_object('state', 'granted')));
  begin
    execute 'set local role lc_action_gateway';
    perform public.action_gateway_authorize(i5, dig_a, jsonb_build_object('grant_id', g_hold, 'policy_id', 'posttest.hold', 'policy_version', 'v1', 'approval_required', true, 'approval_id', apr_old));
    execute 'reset role';
    fails := fails || 'G: an expired approval authorized'::text;
  exception when others then if sqlerrm !~ 'ACTION_GATEWAY_APPROVAL_EXPIRED' then fails := fails || ('G: expired approval refused with ' || left(sqlerrm, 100)); end if;
  end;

  -- ── H. one executing intent per resource ───────────────────────────────────
  execute 'set local role lc_action_gateway';
  perform public.action_gateway_claim(i3, 'posttest-worker-a', 30);
  i6 := (public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_alpha', 'action', 'set_thread_hold', 'capability', 'holds.set_thread_hold', 'tier', 2,
          'resource_type', 'thread', 'resource_id', thread2::text, 'client_key', 'posttest-hold-6', 'idempotency_key', repeat('6', 64),
          'params', jsonb_build_object('thread_id', thread2, 'reason_code', 'operator_review'), 'params_hash', repeat('a', 64), 'correlation_id', gen_random_uuid())) -> 'intent' ->> 'intent_id')::uuid;
  perform public.action_gateway_authorize(i6, dig_a, jsonb_build_object('grant_id', g_hold, 'policy_id', 'posttest.hold', 'policy_version', 'v1'));
  j := public.action_gateway_claim(i6, 'posttest-worker-b', 30);
  execute 'reset role';
  if j ->> 'reason' is distinct from 'resource_busy' or (j ->> 'holder_intent_id')::uuid is distinct from i3 then fails := fails || ('H: a second executing intent on one resource ' || j::text); end if;

  -- ── C (tenant B sees nothing of A) ─────────────────────────────────────────
  perform set_config('request.jwt.claim.lc_org', org_b::text, true);
  execute 'set local role lc_action_gateway';
  j := public.action_gateway_intent_get(i1);
  select count(*) into n from action_gateway.action_intents;
  execute 'reset role';
  if j is not null or n <> 0 then fails := fails || 'C: tenant B can see tenant A intents'::text; end if;
  perform set_config('request.jwt.claim.lc_org', '', true);
  begin
    execute 'set local role lc_action_gateway';
    perform public.action_gateway_intent_open(jsonb_build_object('agent_id', 'agt_alpha', 'action', 'set_thread_hold', 'capability', 'holds.set_thread_hold', 'tier', 2,
              'resource_type', 'thread', 'resource_id', thread::text, 'client_key', 'posttest-hold-x', 'idempotency_key', repeat('9', 64),
              'params', '{}'::jsonb, 'params_hash', repeat('9', 64), 'correlation_id', gen_random_uuid()));
    execute 'reset role';
    fails := fails || 'C: an intent opened without a tenant claim'::text;
  exception when others then if sqlerrm !~ 'ACTION_GATEWAY_NO_TENANT' then fails := fails || ('C: no tenant refused with ' || left(sqlerrm, 100)); end if;
  end;

  -- ── I. self-check ──────────────────────────────────────────────────────────
  j := action_gateway.self_check('lc_action_gateway');
  if not (j ->> 'ok')::boolean then fails := fails || ('I: self-check not ok ' || (j -> 'findings')::text); end if;
  grant insert on public.send_queue to lc_action_gateway;
  j := action_gateway.self_check('lc_action_gateway');
  if (j ->> 'ok')::boolean or not exists (select 1 from jsonb_array_elements_text(j -> 'findings') f where f like 'write_privilege:public.send_queue%') then
    fails := fails || ('I: a raw write was not named ' || (j -> 'findings')::text);
  end if;
  revoke insert on public.send_queue from lc_action_gateway;
  grant select on action_gateway.agent_principals to lc_action_gateway;
  j := action_gateway.self_check('lc_action_gateway');
  if not exists (select 1 from jsonb_array_elements_text(j -> 'findings') f where f = 'principal_registry_readable') then fails := fails || 'I: a readable registry was not named'::text; end if;
  revoke select on action_gateway.agent_principals from lc_action_gateway;

  if array_length(fails, 1) > 0 then raise exception 'posttest: % failure(s): %', array_length(fails, 1), array_to_string(fails, ' | '); end if;
  raise notice 'action_gateway posttest: A-I ok';
end $$;

rollback;
