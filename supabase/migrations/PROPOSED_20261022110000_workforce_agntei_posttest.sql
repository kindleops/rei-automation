-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261022110000_workforce_agntei.sql (Workforce × Agntei).
-- Runs AFTER the runner applied the migration; every write rolls back.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id workforce_agntei
-- Expected last notice: "posttest(workforce_agntei): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;

-- ── grants, registry, static shape ──────────────────────────────────────────
do $$
declare v jsonb; f record;
begin
  v := action_gateway.self_check('lc_action_gateway');
  if not coalesce((v ->> 'ok')::boolean, false) then raise exception 'assert: the gateway self-check is ok (%)', v -> 'findings'; end if;
  if not has_function_privilege('lc_action_gateway', 'public.action_gateway_dw_workforce(uuid, uuid)', 'execute')
     or not has_function_privilege('lc_action_gateway', 'public.action_gateway_workforce_read(text, text, jsonb)', 'execute') then
    raise exception 'assert: the gateway role executes its two Workforce entry points';
  end if;
  if has_schema_privilege('lc_action_gateway', 'workforce', 'usage') then raise exception 'assert: the gateway role has no usage on schema workforce'; end if;
  if has_function_privilege('agent_api', 'workforce.employee_bind_principal(uuid, text, text, uuid, interval, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'workforce.employee_bind_principal(uuid, text, text, uuid, interval, timestamptz)', 'execute')
     or has_function_privilege('agent_api', 'workforce.employee_unbind(uuid, text, uuid, text)', 'execute') then
    raise exception 'assert: binding a principal is owner-only (service_role)';
  end if;
  if not has_function_privilege('service_role', 'workforce.employee_bind_principal(uuid, text, text, uuid, interval, timestamptz)', 'execute') then raise exception 'assert: the owner path binds'; end if;
  if has_function_privilege('agent_api', 'workforce.assignment_claim_external(uuid, text, text, text, integer)', 'execute')
     or has_function_privilege('agent_api', 'workforce.assignment_handoff(uuid, text, text, text, text, text)', 'execute')
     or has_function_privilege('agent_api', 'action_gateway.wf_resolve_evidence(uuid, text, text, jsonb)', 'execute')
     or has_function_privilege('lc_action_gateway', 'action_gateway.wf_identity_anomaly(action_gateway.action_intents, text, text)', 'execute') then
    raise exception 'assert: the internal helpers are not granted';
  end if;
  if not has_function_privilege('agent_api', 'workforce.assignment_claim(uuid, text, integer, integer, timestamptz)', 'execute')
     or not has_function_privilege('agent_api', 'workforce.employee_upsert(uuid, jsonb, uuid)', 'execute') then raise exception 'assert: the replaced writers keep their grants'; end if;
  for f in select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname in ('workforce', 'action_gateway', 'public')) and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)
              and (p.proname in ('action_gateway_dw_workforce', 'action_gateway_workforce_read') or p.proname like 'wf\_%' or (n.nspname = 'workforce' and p.proname in ('budget_put', 'budget_status', 'employee_bind_principal', 'assignment_claim_external', 'assignment_handoff')))
  loop raise exception 'assert: PUBLIC executes %', f.sig; end loop;
  if (select count(*) from action_gateway.extensions where link = 'PROPOSED_20261022110000_workforce_agntei' and kind = 'domain_write_action') <> 8
     or (select count(*) from action_gateway.extensions where link = 'PROPOSED_20261022110000_workforce_agntei' and kind = 'definer_function') <> 2
     or exists (select 1 from action_gateway.extensions where link = 'PROPOSED_20261022110000_workforce_agntei' and kind = 'standing_t2_action') then
    raise exception 'assert: the registry rows (8 domain writes, 2 definer functions, no standing T2 action)';
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'workforce.budget'::regclass) then raise exception 'assert: RLS forced on workforce.budget'; end if;
  if has_table_privilege('agent_api', 'workforce.budget', 'insert') or has_table_privilege('anon', 'workforce.budget', 'select') then raise exception 'assert: budget writes through the functions only'; end if;
  -- STATIC: the Workforce side reaches no seller-facing write (send_queue, offers, stage, campaigns, suppression, holds)
  for f in select p.oid::regprocedure::text sig, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'public' and p.proname in ('action_gateway_dw_workforce', 'action_gateway_workforce_read'))
               or (n.nspname = 'action_gateway' and p.proname like 'wf\_%')
               or (n.nspname = 'workforce' and p.proname in ('assignment_claim_external', 'assignment_external_lease', 'assignment_handoff', 'employee_link_external', 'employee_bind_principal', 'budget_status'))
  loop
    if f.prosrc ~* '(insert\s+into|update|delete\s+from)\s+public\.' or f.prosrc ~* 'send_queue|seller_offers|negotiation_|campaign_transition|followup_intent_plan|automation_holds\s*\(|sms_suppression|acquisition_stage\s*='
       or f.prosrc ~* 'runtime_enqueue\(\s*''(?!workforce\.coo_plan|property\.research)' then
      raise exception 'assert: % reaches a seller-facing write', f.sig;
    end if;
  end loop;
  if (select count(*) from workforce.employee where employment_type is null) > 0 then raise exception 'assert: every employee has an employment type'; end if;
  raise notice 'posttest(workforce_agntei): grants + registry + static OK';
end
$$;

-- ── behaviour (as the owner: the SECURITY DEFINER writers are the only write path) ──
insert into agent.operator_membership (org_id, user_id, role, added_by)
values ('00000000-0000-4000-8000-00000000a001', '11111111-1111-4111-8111-111111111111', 'owner', 'posttest'),
       ('00000000-0000-4000-8000-00000000a001', '33333333-3333-4333-8333-333333333333', 'operator', 'posttest');
do $$
declare
  v_org constant uuid := '00000000-0000-4000-8000-00000000a001';
  v_owner constant uuid := '11111111-1111-4111-8111-111111111111';
  v_op constant uuid := '33333333-3333-4333-8333-333333333333';
  r jsonb; v_mission text; v_ext text; v_int text; v_raised boolean; n int;
begin
  -- the CEO + COO + one autonomous analyst (foundation writer path)
  perform workforce.employee_upsert(v_org, '{"employee_id":"emp_ceo","kind":"human","role_key":"ceo","department_key":"executive","display_name":"CEO","user_id":"11111111-1111-4111-8111-111111111111"}'::jsonb, v_owner);
  perform workforce.employee_upsert(v_org, '{"employee_id":"emp_coo","kind":"ai","role_key":"coo","department_key":"executive","display_name":"Atlas","manager_employee_id":"emp_ceo"}'::jsonb, v_owner);
  perform workforce.employee_upsert(v_org, '{"employee_id":"emp_research_01","kind":"ai","role_key":"research_analyst","department_key":"data_intelligence","display_name":"Research Analyst"}'::jsonb, v_owner);
  if (select employment_type from workforce.employee where employee_id = 'emp_ceo') <> 'human' or (select employment_type from workforce.employee where employee_id = 'emp_coo') <> 'autonomous_ai' then
    raise exception 'assert: employment types default from the kind';
  end if;
  -- an Agntei employee is born pending_link, unbound
  r := workforce.employee_upsert(v_org, '{"employee_id":"emp_scout","kind":"ai","role_key":"research_analyst","department_key":"data_intelligence","display_name":"Scout","origin":"agntei","skills":["probate","title_research"]}'::jsonb, v_owner);
  if r ->> 'status' <> 'pending_link' or r ->> 'employment_type' <> 'operator_ai' or r ->> 'origin' <> 'agntei' then raise exception 'assert: Agntei birth (%)', r; end if;
  begin perform workforce.employee_upsert(v_org, '{"employee_id":"emp_scout2","kind":"ai","role_key":"research_analyst","department_key":"data_intelligence","display_name":"Scout Two","origin":"agntei","action_principal_id":"agt_scout"}'::jsonb, v_owner); v_raised := false;
  exception when others then v_raised := sqlerrm like 'WF_FORBIDDEN%'; end;
  if not v_raised then raise exception 'assert: an Agntei employee is never born bound'; end if;
  begin perform workforce.employee_upsert(v_org, '{"employee_id":"emp_scout","external_agent_id":"agent_x"}'::jsonb, v_owner); v_raised := false;
  exception when others then v_raised := sqlerrm like 'WF_PAYLOAD_REFUSED%'; end;
  if not v_raised then raise exception 'assert: the external identity is never upsertable'; end if;
  begin perform workforce.employee_upsert(v_org, '{"employee_id":"emp_scout","status":"active"}'::jsonb, v_owner); v_raised := false;
  exception when others then v_raised := sqlerrm like 'WF_ILLEGAL_TRANSITION%'; end;
  if not v_raised then raise exception 'assert: only the link activates an Agntei employee'; end if;
  begin perform workforce.employee_upsert(v_org, '{"employee_id":"emp_coo","origin":"agntei"}'::jsonb, v_owner); v_raised := false;
  exception when others then v_raised := sqlerrm like 'WF_CONFLICT%'; end;
  if not v_raised then raise exception 'assert: origin never changes'; end if;
  begin perform workforce.employee_upsert(v_org, '{"employee_id":"emp_bad","kind":"ai","role_key":"research_analyst","department_key":"data_intelligence","display_name":"Bad","status":"pending_link"}'::jsonb, v_owner); v_raised := false;
  exception when others then v_raised := true; end;
  if not v_raised then raise exception 'assert: pending_link is an Agntei status only'; end if;

  -- the owner binds the principal (sponsor = the CEO user); an operator-sponsored principal is refused
  insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, created_by)
  values ('agt_scout', v_org, 'Scout', v_owner, repeat('a', 64), now() + interval '30 days', 1, v_owner),
         ('agt_other', v_org, 'Other', v_op, repeat('b', 64), now() + interval '30 days', 1, v_owner);
  begin perform workforce.employee_bind_principal(v_org, 'emp_scout', 'agt_other', v_owner); v_raised := false; exception when others then v_raised := sqlerrm like 'WF_FORBIDDEN%'; end;
  if not v_raised then raise exception 'assert: the principal''s sponsor must be the CEO'; end if;
  begin perform workforce.employee_bind_principal(v_org, 'emp_scout', 'agt_scout', v_op); v_raised := false; exception when others then v_raised := sqlerrm like 'WF_FORBIDDEN%'; end;
  if not v_raised then raise exception 'assert: an operator cannot bind'; end if;
  r := workforce.employee_bind_principal(v_org, 'emp_scout', 'agt_scout', v_owner);
  if r ->> 'action_principal_id' <> 'agt_scout' or r ->> 'status' <> 'pending_link' then raise exception 'assert: bound and still pending_link'; end if;
  r := workforce.employee_bind_principal(v_org, 'emp_scout', 'agt_scout', v_owner);   -- idempotent
  begin update workforce.employee set action_principal_id = 'agt_other' where employee_id = 'emp_scout'; v_raised := false; exception when others then v_raised := sqlerrm like 'WF_IMMUTABLE%'; end;
  if not v_raised then raise exception 'assert: a principal is bound once'; end if;

  -- link (the gateway's internal writer): activates; the identity is immutable and unique
  r := workforce.employee_link_external(v_org, 'emp_scout', 'inst_a1b2c3d4e5f6', 'agent_scout01');
  if r ->> 'status' <> 'active' or r ->> 'external_agent_id' <> 'agent_scout01' then raise exception 'assert: linked + active'; end if;
  begin update workforce.employee set external_agent_id = 'agent_other1' where employee_id = 'emp_scout'; v_raised := false; exception when others then v_raised := sqlerrm like 'WF_IMMUTABLE%'; end;
  if not v_raised then raise exception 'assert: a linked identity never changes'; end if;
  perform workforce.employee_upsert(v_org, '{"employee_id":"emp_scout_b","kind":"ai","role_key":"research_analyst","department_key":"data_intelligence","display_name":"Scout B","origin":"agntei"}'::jsonb, v_owner);
  insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, created_by)
  values ('agt_scout_b', v_org, 'Scout B', v_owner, repeat('c', 64), now() + interval '30 days', 1, v_owner);
  perform workforce.employee_bind_principal(v_org, 'emp_scout_b', 'agt_scout_b', v_owner);
  begin perform workforce.employee_link_external(v_org, 'emp_scout_b', 'inst_a1b2c3d4e5f6', 'agent_scout01'); v_raised := false; exception when unique_violation then v_raised := true; end;
  if not v_raised then raise exception 'assert: one Agntei agent ⇔ one employee'; end if;
  perform workforce.employee_link_external(v_org, 'emp_scout_b', 'inst_a1b2c3d4e5f6', 'agent_scout02');
  -- the binding: owner-authorized, expiring, revocable; a new principal only after the live binding ends
  if (select binding_valid_until from workforce.employee where employee_id = 'emp_scout') <> (select credential_expires_at from action_gateway.agent_principals where agent_id = 'agt_scout')
     or (select link_expires_at - bound_at from workforce.employee where employee_id = 'emp_scout') <> interval '24 hours' then raise exception 'assert: default window 24 h, validity = the credential expiry'; end if;
  begin perform workforce.employee_bind_principal(v_org, 'emp_scout', 'agt_scout', v_owner, interval '8 days', null); v_raised := false; exception when others then v_raised := sqlerrm like 'WF_PAYLOAD_REFUSED%'; end;
  if not v_raised then raise exception 'assert: the link window is at most 7 days'; end if;
  begin perform workforce.employee_bind_principal(v_org, 'emp_scout', 'agt_scout', v_owner, interval '1 hour', now() + interval '400 days'); v_raised := false; exception when others then v_raised := sqlerrm like 'WF_PAYLOAD_REFUSED%'; end;
  if not v_raised then raise exception 'assert: the binding never outlives the credential'; end if;
  if workforce.binding_refusal((select x from workforce.employee x where x.employee_id = 'emp_scout')) is not null then raise exception 'assert: a live binding'; end if;
  r := workforce.employee_unbind(v_org, 'emp_scout_b', v_owner, 'posttest');
  if workforce.binding_refusal((select x from workforce.employee x where x.employee_id = 'emp_scout_b')) <> 'BINDING_REVOKED' then raise exception 'assert: revoked'; end if;
  r := workforce.employee_bind_principal(v_org, 'emp_scout_b', 'agt_scout_b', v_owner, interval '1 hour', null);
  if workforce.binding_refusal((select x from workforce.employee x where x.employee_id = 'emp_scout_b')) is not null then raise exception 'assert: a re-bind is a new owner authorization'; end if;
  begin perform workforce.employee_bind_principal(v_org, 'emp_scout_b', 'agt_other', v_owner, interval '1 hour', null); v_raised := false; exception when others then v_raised := true; end;
  if not v_raised then raise exception 'assert: a live binding is never silently replaced'; end if;

  -- execution modes: derived from the assignee; dispatch never leases an external row; a transfer re-derives
  r := workforce.mission_open(v_org, 'Posttest mission', 'Find the 3 most promising opportunities', v_owner, 'emp_coo', 50, null, 'posttest-agntei-1');
  v_mission := r -> 'mission' ->> 'mission_id';
  if r -> 'mission' ->> 'origin' <> 'workforce' then raise exception 'assert: a Workforce-opened mission has origin workforce'; end if;
  perform workforce.mission_transition(v_org, v_mission, 'active', null);
  begin update workforce.mission set origin = 'agntei' where mission_id = v_mission; v_raised := false; exception when others then v_raised := sqlerrm like 'WF_IMMUTABLE%'; end;
  if not v_raised then raise exception 'assert: origin is stamped only at opening'; end if;
  r := workforce.assignment_create(v_org, v_mission, 'res.c01', 'research.property', 'emp_scout', 'emp_coo', '{}', '{"property_ref":"pid_ghij"}'::jsonb, 'property', 'pid_ghij', 3, null);
  v_ext := r -> 'assignment' ->> 'assignment_id';
  if r -> 'assignment' ->> 'execution_mode' <> 'external' then raise exception 'assert: an operator_ai assignee ⇒ external'; end if;
  r := workforce.assignment_create(v_org, v_mission, 'res.c02', 'research.property', 'emp_research_01', 'emp_coo', '{}', '{"property_ref":"pid_ghik"}'::jsonb, 'property', 'pid_ghik', 3, null);
  v_int := r -> 'assignment' ->> 'assignment_id';
  if r -> 'assignment' ->> 'execution_mode' <> 'internal' then raise exception 'assert: an autonomous assignee ⇒ internal'; end if;
  r := workforce.assignment_claim(v_org, 'posttest-dispatch', 10, 60, null);
  if jsonb_array_length(r) <> 1 or r -> 0 ->> 'assignment_id' <> v_int then raise exception 'assert: dispatch leases the internal row only (%)', r; end if;
  if (select status from workforce.assignment where assignment_id = v_ext) <> 'ready' then raise exception 'assert: the external row is promoted to ready (dependency resolution) but not leased'; end if;
  update workforce.assignment set execution_mode = 'internal' where assignment_id = v_ext;
  if (select execution_mode from workforce.assignment where assignment_id = v_ext) <> 'external' then raise exception 'assert: the mode is never written by a caller'; end if;
  perform workforce.assignment_transfer(v_org, v_ext, 'emp_research_01', 'emp_coo');
  if (select execution_mode from workforce.assignment where assignment_id = v_ext) <> 'internal' then raise exception 'assert: a reassignment re-derives the mode'; end if;
  if not exists (select 1 from workforce.event where assignment_id = v_ext and type = 'wf.assignment.mode_changed' and payload ->> 'to' = 'internal') then raise exception 'assert: wf.assignment.mode_changed'; end if;
  perform workforce.assignment_transfer(v_org, v_ext, 'emp_scout', 'emp_coo');

  -- the external claim: the assignee's agent only; HUMAN_OWNED; CLAIM_HELD
  begin perform workforce.assignment_claim_external(v_org, v_ext, 'emp_scout_b', 'gw:agt_scout_b', 600); v_raised := false; exception when others then v_raised := sqlerrm like 'WF_NOT_ASSIGNEE%'; end;
  if not v_raised then raise exception 'assert: only the assignee claims'; end if;
  begin perform workforce.assignment_claim_external(v_org, v_int, 'emp_research_01', 'gw:agt_x', 600); v_raised := false; exception when others then v_raised := sqlerrm like 'WF_NOT_EXTERNAL%'; end;
  if not v_raised then raise exception 'assert: an internal row is never claimed externally'; end if;
  perform workforce.resource_claim_acquire(v_org, 'property', 'pid_ghij', 'emp_ceo', null, 600);
  begin perform workforce.assignment_claim_external(v_org, v_ext, 'emp_scout', 'gw:agt_scout', 600); v_raised := false; exception when others then v_raised := sqlerrm like 'WF_HUMAN_OWNED%'; end;
  if not v_raised then raise exception 'assert: a resource a person holds is HUMAN_OWNED'; end if;
  perform workforce.resource_claim_release(v_org, 'property', 'pid_ghij', null);
  perform workforce.resource_claim_acquire(v_org, 'property', 'pid_ghij', 'emp_research_01', v_int, 600);
  begin perform workforce.assignment_claim_external(v_org, v_ext, 'emp_scout', 'gw:agt_scout', 600); v_raised := false; exception when others then v_raised := sqlerrm like 'WF_CLAIM_HELD%'; end;
  if not v_raised then raise exception 'assert: another employee holds the resource ⇒ CLAIM_HELD'; end if;
  perform workforce.resource_claim_release(v_org, 'property', 'pid_ghij', v_int);
  r := workforce.assignment_claim_external(v_org, v_ext, 'emp_scout', 'gw:agt_scout', 600);
  if r -> 'assignment' ->> 'status' <> 'leased' or r -> 'assignment' ? 'lease_token' then raise exception 'assert: leased, and the token is never returned (%)', r; end if;
  r := workforce.assignment_claim_external(v_org, v_ext, 'emp_scout', 'gw:agt_scout', 600);
  if not (r ->> 'already_held')::boolean then raise exception 'assert: a re-claim by the holder is idempotent'; end if;

  -- a completed job hands an external assignment back to its agent (ready), never completing it
  update workforce.assignment set status = 'waiting_job', runtime_job_id = 'mjob_00000000-0000-4000-8000-000000000001', lease_token = null, lease_owner = null, lease_until = null, lease_seconds = null
   where assignment_id = v_ext;
  r := workforce.assignment_resume_job(v_org, v_ext, 'mjob_00000000-0000-4000-8000-000000000001', 'completed', '{"summary":"done"}'::jsonb, null);
  if r -> 'assignment' ->> 'status' <> 'ready' or r -> 'assignment' -> 'output' -> 'research' ->> 'job_id' <> 'mjob_00000000-0000-4000-8000-000000000001' then raise exception 'assert: returned to the agent (%)', r; end if;

  -- handoff: lease released (no attempt burned), mode re-derived, output preserved, event + COO message
  r := workforce.assignment_claim_external(v_org, v_ext, 'emp_scout', 'gw:agt_scout', 600);
  n := (r -> 'assignment' ->> 'attempt')::int;
  r := workforce.assignment_handoff(v_org, v_ext, 'emp_scout', 'emp_research_01', 'gw:agt_scout', 'over to the analyst');
  if r -> 'assignment' ->> 'status' <> 'ready' or r -> 'assignment' ->> 'execution_mode' <> 'internal' or (r -> 'assignment' ->> 'attempt')::int <> n
     or r -> 'assignment' -> 'output' -> 'research' ->> 'state' <> 'completed' then raise exception 'assert: handoff (%)', r; end if;
  if not exists (select 1 from workforce.event where assignment_id = v_ext and type = 'wf.assignment.handed_off') or not exists (select 1 from workforce.exec_message where mission_id = v_mission and author = 'coo') then
    raise exception 'assert: the handoff is recorded (event + COO message)';
  end if;

  -- budgets: CEO-authored; the status reads the committed spend
  r := workforce.budget_put(v_org, '{"scope":"employee","scope_key":"emp_scout","period":"day","cap_usd":0.10}'::jsonb, v_owner);
  begin perform workforce.budget_put(v_org, '{"scope":"org","scope_key":"00000000-0000-4000-8000-00000000a001","period":"month","cap_usd":5}'::jsonb, v_op); v_raised := false; exception when others then v_raised := sqlerrm like 'WF_FORBIDDEN%'; end;
  if not v_raised then raise exception 'assert: budgets are CEO-authored'; end if;
  r := workforce.budget_status(v_org, 'emp_scout', v_mission, null);
  if jsonb_array_length(r) <> 1 or (r -> 0 ->> 'spent_usd')::numeric <> 0 or (r -> 0 ->> 'cap_usd')::numeric <> 0.10 then raise exception 'assert: budget status (%)', r; end if;
  raise notice 'posttest(workforce_agntei): behaviour OK';
end
$$;

do $$ begin raise notice 'posttest(workforce_agntei): ALL OK (rolled back)'; end $$;
rollback;
