-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261022100000_workforce_foundation.sql (Workforce Phase A).
-- Runs AFTER the runner applied the migration; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id workforce_foundation
-- Expected last notice: "posttest(workforce_foundation): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;

-- ── grants, RLS, shape ──────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['settings', 'employee', 'mission', 'assignment', 'resource_claim', 'event', 'exec_message', 'memory_fact', 'authority_policy', 'kpi_snapshot'] loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = ('workforce.' || t)::regclass) then raise exception 'assert: RLS enabled + forced on workforce.%', t; end if;
    if has_table_privilege('anon', 'workforce.' || t, 'select') then raise exception 'assert: anon reads nothing (%)', t; end if;
    if has_table_privilege('agent_api', 'workforce.' || t, 'insert') or has_table_privilege('agent_api', 'workforce.' || t, 'update') or has_table_privilege('agent_api', 'workforce.' || t, 'delete') then
      raise exception 'assert: agent_api never writes workforce.% directly', t;
    end if;
    if has_table_privilege('authenticated', 'workforce.' || t, 'insert') or has_table_privilege('service_role', 'workforce.' || t, 'update') then raise exception 'assert: no write grant on workforce.%', t; end if;
    if not has_table_privilege('agent_api', 'workforce.' || t, 'select') or not has_table_privilege('authenticated', 'workforce.' || t, 'select') then raise exception 'assert: agent_api / authenticated read workforce.%', t; end if;
  end loop;
  if has_schema_privilege('anon', 'workforce', 'usage') then raise exception 'assert: anon has no usage on schema workforce'; end if;
  if not has_function_privilege('agent_api', 'workforce.assignment_claim(uuid, text, integer, integer, timestamptz)', 'execute') then raise exception 'assert: agent_api claims'; end if;
  if not has_function_privilege('agent_api', 'workforce.memory_assert(uuid, text, text, text, jsonb, text, numeric, jsonb, text, uuid)', 'execute') then raise exception 'assert: agent_api asserts memory'; end if;
  if has_function_privilege('agent_api', 'workforce.emit(uuid, text, text, text, text, jsonb)', 'execute') or has_function_privilege('agent_api', 'workforce.is_owner(uuid, uuid)', 'execute')
     or has_function_privilege('agent_api', 'workforce.release_claims_of(text, text)', 'execute') or has_function_privilege('agent_api', 'workforce.assignment_leased(uuid, text, uuid)', 'execute') then
    raise exception 'assert: internal helpers are not granted';
  end if;
  if has_function_privilege('anon', 'workforce.mission_open(uuid, text, text, uuid, text, integer, timestamptz, text)', 'execute')
     or has_function_privilege('authenticated', 'workforce.mission_open(uuid, text, text, uuid, text, integer, timestamptz, text)', 'execute') then
    raise exception 'assert: anon / authenticated execute nothing';
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'workforce'::regnamespace and p.prosecdef
               and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) then
    raise exception 'assert: every workforce SECURITY DEFINER function pins search_path';
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'workforce'::regnamespace
               and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)) then
    raise exception 'assert: PUBLIC executes no workforce function';
  end if;
  if (select exec_review_price_usd from workforce.settings where org_id = '00000000-0000-4000-8000-00000000a001') <> 5000000 then raise exception 'assert: settings seeded at 5,000,000'; end if;
  -- the state graphs (spot checks; the JS mirror is compared pair-by-pair in tests/critical)
  if not workforce.assignment_transition_ok('pending', 'ready') or workforce.assignment_transition_ok('pending', 'leased') or workforce.assignment_transition_ok('completed', 'ready')
     or not workforce.assignment_transition_ok('waiting_job', 'completed') or workforce.assignment_transition_ok('blocked', 'failed') then
    raise exception 'assert: assignment state graph';
  end if;
  if not workforce.mission_transition_ok('planning', 'active') or workforce.mission_transition_ok('planning', 'completed') or workforce.mission_transition_ok('blocked', 'completed') then
    raise exception 'assert: mission state graph';
  end if;
  raise notice 'posttest(workforce_foundation): grants OK';
end
$$;

-- ── behaviour (as agent_api: the API's least-privilege role) ────────────────
insert into agent.operator_membership (org_id, user_id, role, added_by)
values ('00000000-0000-4000-8000-00000000a001', '11111111-1111-4111-8111-111111111111', 'owner', 'posttest'),
       ('00000000-0000-4000-8000-00000000a001', '33333333-3333-4333-8333-333333333333', 'operator', 'posttest');
do $$
declare
  org constant uuid := '00000000-0000-4000-8000-00000000a001';
  op constant uuid := '11111111-1111-4111-8111-111111111111';
  operator2 constant uuid := '33333333-3333-4333-8333-333333333333';
  r jsonb; m text; a1 text; a2 text; tok uuid; c jsonb; n int; f1 uuid; f2 uuid;
begin
  set local role agent_api;
  perform workforce.employee_upsert(org, jsonb_build_object('employee_id', 'emp_ceo', 'kind', 'human', 'role_key', 'ceo', 'department_key', 'executive', 'display_name', 'CEO', 'user_id', op), op);
  perform workforce.employee_upsert(org, '{"employee_id": "emp_coo", "kind": "ai", "role_key": "coo", "department_key": "executive", "display_name": "Atlas", "manager_employee_id": "emp_ceo"}', op);
  perform workforce.employee_upsert(org, '{"employee_id": "emp_head_acquisitions", "kind": "ai", "role_key": "head_acquisitions", "department_key": "acquisitions", "display_name": "Head of Acquisitions", "manager_employee_id": "emp_coo"}', op);
  -- employees are CEO-authored; one CEO; role ↔ department
  begin perform workforce.employee_upsert(org, '{"employee_id": "emp_x01", "kind": "ai", "role_key": "cfo", "department_key": "finance", "display_name": "X"}', operator2); raise exception 'assert: an operator is not the CEO';
  exception when others then if sqlerrm not like 'WF_FORBIDDEN:%' then raise; end if; end;
  begin perform workforce.employee_upsert(org, jsonb_build_object('employee_id', 'emp_ceo2', 'kind', 'human', 'role_key', 'ceo', 'department_key', 'executive', 'display_name', 'Two', 'user_id', operator2), op); raise exception 'assert: one CEO';
  exception when unique_violation then null; end;
  begin perform workforce.employee_upsert(org, '{"employee_id": "emp_x02", "kind": "ai", "role_key": "cfo", "department_key": "marketing", "display_name": "X"}', op); raise exception 'assert: role ↔ department';
  exception when check_violation then null; end;
  -- a mission is idempotent per org; a phone in the directive is refused
  r := workforce.mission_open(org, 'Triage', 'find the 10 most promising sellers and get them moving', op, 'emp_coo', 60, null, 'req-1');
  m := r -> 'mission' ->> 'mission_id';
  if not (r ->> 'created')::boolean then raise exception 'assert: created'; end if;
  r := workforce.mission_open(org, 'Triage again', 'something else', op, 'emp_coo', 10, null, 'req-1');
  if (r ->> 'created')::boolean or r -> 'mission' ->> 'mission_id' <> m then raise exception 'assert: a replayed submission returns the same mission'; end if;
  begin perform workforce.mission_open(org, 'Call', 'call the seller at 612-555-0147 today', op, 'emp_coo', 50, null, 'req-2'); raise exception 'assert: a phone in the directive is refused';
  exception when check_violation then null; end;
  begin perform workforce.mission_open(org, 'Mail', 'email rosa@example.com', op, 'emp_coo', 50, null, 'req-3'); raise exception 'assert: an email in the directive is refused';
  exception when check_violation then null; end;
  -- optimistic plan version
  perform workforce.mission_set_plan(org, m, '{"intent": "opportunity_triage"}', 'opportunity_triage', '{"steps": [{"step": "find"}]}', 0);
  begin perform workforce.mission_set_plan(org, m, null, null, '{}', 0); raise exception 'assert: stale plan version';
  exception when others then if sqlerrm not like 'WF_VERSION_MISMATCH:%' then raise; end if; end;
  begin perform workforce.mission_set_plan(org, m, null, null, '{"steps": [{"message_body": "hi"}]}', 1); raise exception 'assert: a message-body key in jsonb is refused';
  exception when check_violation then null; end;
  -- assignments: idempotent per (mission, step); dependency-gated claim
  a1 := workforce.assignment_create(org, m, 'find', 'intel.active_opportunities', 'emp_head_acquisitions', 'emp_coo', '{}', '{}', null, null, 2, null) -> 'assignment' ->> 'assignment_id';
  a2 := workforce.assignment_create(org, m, 'rank', 'acq.rank_opportunities', 'emp_head_acquisitions', 'emp_coo', array['find'], '{}', 'property', 'pid_ghijklmnop', 3, a1) -> 'assignment' ->> 'assignment_id';
  if workforce.assignment_create(org, m, 'find', 'intel.active_opportunities', 'emp_head_acquisitions', null, '{}', '{}', null, null, 2, null) ->> 'created' <> 'false' then raise exception 'assert: idempotent step'; end if;
  begin perform workforce.assignment_create(org, m, 'raw', 'intel.conversation_state', 'emp_head_acquisitions', null, '{}', '{}', 'property', '2124415662', 3, null); raise exception 'assert: a raw property id (digit run) is refused';
  exception when check_violation then null; end;
  if jsonb_array_length(workforce.assignment_claim(org, 'posttest', 5, 60)) <> 0 then raise exception 'assert: a planning mission is never claimed'; end if;
  perform workforce.mission_transition(org, m, 'active');
  c := workforce.assignment_claim(org, 'posttest', 5, 60);
  if jsonb_array_length(c) <> 1 or c -> 0 ->> 'assignment_id' <> a1 then raise exception 'assert: only the dependency-free step is claimed (%)', c; end if;
  tok := (c -> 0 ->> 'lease_token')::uuid;
  begin perform workforce.assignment_progress(org, a1, gen_random_uuid(), '{"status": "running"}'); raise exception 'assert: a wrong token is LEASE_LOST';
  exception when others then if sqlerrm not like 'WF_LEASE_LOST:%' then raise; end if; end;
  perform workforce.assignment_progress(org, a1, tok, '{"status": "running", "output": {"candidates": 3}}');
  perform workforce.assignment_finish(org, a1, tok, 'completed', '{"done": true}', 'verified', '[{"source": "deal_context"}]', null, null);
  if (workforce.assignment_finish(org, a1, tok, 'completed', null, 'verified', null, null, null) ->> 'status') <> 'completed' then raise exception 'assert: an idempotent finish replay'; end if;
  c := workforce.assignment_claim(org, 'posttest', 5, 60);
  if jsonb_array_length(c) <> 1 or c -> 0 ->> 'assignment_id' <> a2 then raise exception 'assert: the dependent step is promoted and claimed (%)', c; end if;
  -- exclusive resource claims
  perform workforce.resource_claim_acquire(org, 'property', 'pid_ghijklmnop', 'emp_head_acquisitions', a2, 300);
  begin perform workforce.resource_claim_acquire(org, 'property', 'pid_ghijklmnop', 'emp_coo', null, 300); raise exception 'assert: CLAIM_HELD';
  exception when others then if sqlerrm not like 'WF_CLAIM_HELD:%' then raise; end if; end;
  -- reap: the lease expires → ready (attempt 1); the claim expires → reaped
  r := workforce.assignment_reap(org, clock_timestamp() + interval '2 hours');
  if (r ->> 'requeued')::int <> 1 then raise exception 'assert: reaped (%)', r; end if;
  if workforce.resource_claim_reap(org, clock_timestamp() + interval '2 hours') <> 1 then raise exception 'assert: expired claim reaped'; end if;
  -- memory: verified needs a source; ceo_policy only by an owner; supersede
  begin perform workforce.memory_assert(org, 'company', 'company', 'kpi.target', '{"n": 1}', 'verified', 1, '[]', 'emp_coo', null); raise exception 'assert: verified without a source';
  exception when others then if sqlerrm not like 'WF_PAYLOAD_REFUSED:%' then raise; end if; end;
  begin perform workforce.memory_assert(org, 'company', 'company', 'policy.offers', '"never above MAO"', 'ceo_policy', null, '[]', null, operator2); raise exception 'assert: ceo_policy by a non-owner';
  exception when others then if sqlerrm not like 'WF_FORBIDDEN:%' then raise; end if; end;
  f1 := (workforce.memory_assert(org, 'company', 'company', 'policy.offers', '"never above MAO"', 'ceo_policy', null, '[]', null, op) ->> 'fact_id')::uuid;
  f2 := (workforce.memory_assert(org, 'company', 'company', 'policy.offers', '"never above MAO; T1 only"', 'ceo_policy', null, '[]', null, op) ->> 'fact_id')::uuid;
  reset role;
  if (select superseded_by from workforce.memory_fact where fact_id = f1) <> f2 then raise exception 'assert: supersede links old → new'; end if;
  if (select count(*) from workforce.memory_fact where fact_key = 'policy.offers' and superseded_at is null) <> 1 then raise exception 'assert: one live fact'; end if;
  -- the write path: even agent_api / the owner cannot bypass the guards
  set local role agent_api;
  begin update workforce.assignment set status = 'completed' where assignment_id = a2; raise exception 'assert: agent_api cannot update directly';
  exception when insufficient_privilege then null; end;
  reset role;
  begin update workforce.event set type = 'wf.x' where true; raise exception 'assert: events are append-only (UPDATE)';
  exception when insufficient_privilege then null; end;
  begin delete from workforce.event where true; raise exception 'assert: events are append-only (DELETE)';
  exception when insufficient_privilege then null; end;
  begin update workforce.assignment set status = 'pending' where assignment_id = a1; raise exception 'assert: a terminal assignment is immutable';
  exception when check_violation then null; end;
  begin update workforce.memory_fact set value = '"x"' where fact_id = f2; raise exception 'assert: memory is supersede-only';
  exception when check_violation then null; end;
  select count(*) into n from workforce.event where mission_id = m;
  if n < 6 then raise exception 'assert: the operations feed recorded the mission (% events)', n; end if;
  -- RLS: authenticated sees rows only through agent.can_read_org (a member), nothing without a session
  perform set_config('request.jwt.claim.sub', operator2::text, true);
  set local role authenticated;
  if (select count(*) from workforce.mission) <> 1 then raise exception 'assert: a member reads its org'; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);
  set local role authenticated;
  if (select count(*) from workforce.mission) <> 0 or (select count(*) from workforce.event) <> 0 then raise exception 'assert: a non-member reads nothing'; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  raise notice 'posttest(workforce_foundation): behaviour OK';
end
$$;
do $$ begin raise notice 'posttest(workforce_foundation): ALL OK (rolled back)'; end $$;
rollback;
