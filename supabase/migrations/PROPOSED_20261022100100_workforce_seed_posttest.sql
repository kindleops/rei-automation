-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261022100100_workforce_seed.sql (Workforce Phase A seed).
-- The seed takes a psql variable (owner_id) and carries its own BEGIN/COMMIT, so the runner cannot
-- apply it as written; this fixture executes the SAME statements (the employee list between the
-- markers is verbatim; tests/critical/workforce-migration-pg.test.mjs compares it) with a test owner
-- inside BEGIN … ROLLBACK and asserts the seed is born safe: the executive staff exists with exactly
-- one CEO (human, the owner), no acquisition agent and no market; the workforce-dispatch schedule is
-- disabled; no workforce.* kind is armed; nothing is enqueued.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- Expected last notice: "posttest(workforce_seed): ALL OK (rolled back)".
\set ON_ERROR_STOP on
begin;
insert into agent.operator_membership (org_id, user_id, role, added_by)
values ('00000000-0000-4000-8000-00000000a001', '11111111-1111-4111-8111-111111111111', 'owner', 'posttest');
select set_config('workforce.seed_owner_id', '11111111-1111-4111-8111-111111111111', true);
do $$
declare
  v_org constant uuid := '00000000-0000-4000-8000-00000000a001';
  v_owner uuid := current_setting('workforce.seed_owner_id')::uuid;
  e jsonb;
  n int;
  r jsonb;
begin
  -- a non-owner cannot seed
  begin
    perform workforce.employee_upsert(v_org, '{"employee_id": "emp_x_nope", "kind": "ai", "role_key": "coo", "department_key": "executive", "display_name": "X"}'::jsonb, '22222222-2222-4222-8222-222222222222');
    raise exception 'assert: a non-owner cannot author employees';
  exception when others then
    if sqlerrm not like 'WF_FORBIDDEN:%' then raise; end if;
  end;
  for e in select x from jsonb_array_elements(
/*seed:employees*/
'[
  {"employee_id": "emp_ceo", "kind": "human", "role_key": "ceo", "department_key": "executive", "display_name": "CEO", "employee_code": "EXE-01"},
  {"employee_id": "emp_coo", "kind": "ai", "role_key": "coo", "department_key": "executive", "display_name": "Atlas", "employee_code": "EXE-02", "manager_employee_id": "emp_ceo"},
  {"employee_id": "emp_cfo", "kind": "ai", "role_key": "cfo", "department_key": "finance", "display_name": "Ledger", "employee_code": "FIN-01", "manager_employee_id": "emp_ceo"},
  {"employee_id": "emp_head_acquisitions", "kind": "ai", "role_key": "head_acquisitions", "department_key": "acquisitions", "display_name": "Head of Acquisitions", "employee_code": "ACQ-00", "manager_employee_id": "emp_coo"},
  {"employee_id": "emp_head_marketing", "kind": "ai", "role_key": "head_marketing", "department_key": "marketing", "display_name": "Head of Marketing", "employee_code": "MKT-00", "manager_employee_id": "emp_coo"},
  {"employee_id": "emp_head_dispositions", "kind": "ai", "role_key": "head_dispositions", "department_key": "dispositions", "display_name": "Head of Dispositions", "employee_code": "DSP-00", "manager_employee_id": "emp_coo"},
  {"employee_id": "emp_head_data", "kind": "ai", "role_key": "head_data_intelligence", "department_key": "data_intelligence", "display_name": "Head of Data Intelligence", "employee_code": "DAT-00", "manager_employee_id": "emp_coo"},
  {"employee_id": "emp_ops_supervisor", "kind": "ai", "role_key": "ops_supervisor", "department_key": "operations", "display_name": "Operations and Quality Supervisor", "employee_code": "OPS-00", "manager_employee_id": "emp_coo"},
  {"employee_id": "emp_research_01", "kind": "ai", "role_key": "research_analyst", "department_key": "data_intelligence", "display_name": "Research Analyst", "employee_code": "DAT-01", "manager_employee_id": "emp_head_data"}
]'::jsonb
/*end*/
  ) x loop
    if e ->> 'role_key' = 'ceo' then e := e || jsonb_build_object('user_id', v_owner); end if;
    perform workforce.employee_upsert(v_org, e, v_owner);
  end loop;
  perform agent.runtime_upsert_schedule('workforce-dispatch', 'workforce.dispatch', 60, v_owner::text, '{}'::jsonb, false, null, 0);
  -- idempotent: a second run changes nothing
  for e in select x from jsonb_array_elements(
/*seed:employees*/
'[
  {"employee_id": "emp_ceo", "kind": "human", "role_key": "ceo", "department_key": "executive", "display_name": "CEO", "employee_code": "EXE-01"},
  {"employee_id": "emp_coo", "kind": "ai", "role_key": "coo", "department_key": "executive", "display_name": "Atlas", "employee_code": "EXE-02", "manager_employee_id": "emp_ceo"},
  {"employee_id": "emp_cfo", "kind": "ai", "role_key": "cfo", "department_key": "finance", "display_name": "Ledger", "employee_code": "FIN-01", "manager_employee_id": "emp_ceo"},
  {"employee_id": "emp_head_acquisitions", "kind": "ai", "role_key": "head_acquisitions", "department_key": "acquisitions", "display_name": "Head of Acquisitions", "employee_code": "ACQ-00", "manager_employee_id": "emp_coo"},
  {"employee_id": "emp_head_marketing", "kind": "ai", "role_key": "head_marketing", "department_key": "marketing", "display_name": "Head of Marketing", "employee_code": "MKT-00", "manager_employee_id": "emp_coo"},
  {"employee_id": "emp_head_dispositions", "kind": "ai", "role_key": "head_dispositions", "department_key": "dispositions", "display_name": "Head of Dispositions", "employee_code": "DSP-00", "manager_employee_id": "emp_coo"},
  {"employee_id": "emp_head_data", "kind": "ai", "role_key": "head_data_intelligence", "department_key": "data_intelligence", "display_name": "Head of Data Intelligence", "employee_code": "DAT-00", "manager_employee_id": "emp_coo"},
  {"employee_id": "emp_ops_supervisor", "kind": "ai", "role_key": "ops_supervisor", "department_key": "operations", "display_name": "Operations and Quality Supervisor", "employee_code": "OPS-00", "manager_employee_id": "emp_coo"},
  {"employee_id": "emp_research_01", "kind": "ai", "role_key": "research_analyst", "department_key": "data_intelligence", "display_name": "Research Analyst", "employee_code": "DAT-01", "manager_employee_id": "emp_head_data"}
]'::jsonb
/*end*/
  ) x loop
    if e ->> 'role_key' = 'ceo' then e := e || jsonb_build_object('user_id', v_owner); end if;
    perform workforce.employee_upsert(v_org, e, v_owner);
  end loop;
  perform agent.runtime_upsert_schedule('workforce-dispatch', 'workforce.dispatch', 60, v_owner::text, '{}'::jsonb, false, null, 0);

  select count(*) into n from workforce.employee where org_id = v_org;
  if n <> 9 then raise exception 'assert: nine seeded employees (got %)', n; end if;
  if (select count(*) from workforce.employee where role_key = 'ceo') <> 1 then raise exception 'assert: exactly one CEO'; end if;
  if not exists (select 1 from workforce.employee where employee_id = 'emp_ceo' and kind = 'human' and user_id = v_owner and manager_employee_id is null) then
    raise exception 'assert: the CEO is the human owner row';
  end if;
  if not exists (select 1 from workforce.employee where employee_id = 'emp_coo' and display_name = 'Atlas' and kind = 'ai' and manager_employee_id = 'emp_ceo') then raise exception 'assert: COO Atlas'; end if;
  if not exists (select 1 from workforce.employee where employee_id = 'emp_cfo' and display_name = 'Ledger' and department_key = 'finance') then raise exception 'assert: CFO Ledger'; end if;
  if exists (select 1 from workforce.employee where role_key = 'acquisition_agent' or cardinality(markets) > 0) then raise exception 'assert: no acquisition agent and no market is seeded'; end if;
  if exists (select 1 from workforce.employee where tier_ceiling <> 'T1' or spend_day_cap_usd <> 0) then raise exception 'assert: every seeded employee is T1 with a $0 cap'; end if;
  if not exists (select 1 from agent.runtime_schedule where name = 'workforce-dispatch' and kind = 'workforce.dispatch' and interval_seconds = 60 and not enabled) then
    raise exception 'assert: workforce-dispatch is defined, every 60 s, DISABLED';
  end if;
  if exists (select 1 from agent.runtime_limits, jsonb_object_keys(kind_limits) k where k like 'workforce.%') then raise exception 'assert: no workforce.* kind is armed'; end if;
  -- the runtime claims nothing and a due disabled schedule enqueues nothing
  update agent.runtime_schedule set next_run_at = clock_timestamp() - interval '1 minute' where name = 'workforce-dispatch';
  r := agent.runtime_enqueue_due_schedules(10);
  if exists (select 1 from agent.research_job where runtime_managed and kind like 'workforce.%') then raise exception 'assert: a disabled schedule enqueues nothing (%)', r; end if;
  raise notice 'posttest(workforce_seed): ALL OK (rolled back)';
end
$$;
rollback;
