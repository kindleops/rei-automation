-- PROPOSED ONLY. NOT APPLIED. OWNER PATH (service_role / owner session). Separately authorized.
--
-- Workforce Phase A seed (docs/WORKFORCE.md §1, §9) — BORN SAFE:
--   * the executive staff: the CEO (a HUMAN row bound to the owner's auth uid), COO "Atlas",
--     CFO "Ledger", one head per department, the Operations & Quality Supervisor and one research
--     analyst. NO acquisition agent and NO market is seeded: the CEO creates those per market.
--   * the 'workforce-dispatch' runtime schedule (kind workforce.dispatch, every 60 s), DISABLED.
--     Defining it runs nothing: a slot is enqueued only when the schedule is enabled AND
--     agent.runtime_limits.runtime_enabled AND workforce.dispatch is enabled + armed in kind_limits
--     (it is absent), and the handler exists only with WORKFORCE_ENABLED=1.
--
--   psql "$DB" -v ON_ERROR_STOP=1 -v owner_id=<owner auth uuid> -f PROPOSED_20261022100100_workforce_seed.sql
--
-- Requires PROPOSED_20261022100000_workforce_foundation.sql, and owner_id must already be an OWNER in
-- agent.operator_membership for the LeadCommand org (the membership sync, gate B): employees are
-- CEO-authored, so the seed RAISES otherwise. Idempotent: re-running it re-asserts the same rows and
-- leaves the schedule disabled.
-- The employee list between the seed:employees / end markers is repeated verbatim in
-- PROPOSED_20261022100100_workforce_seed_posttest.sql (a test compares them).
\set ON_ERROR_STOP on
begin;
select set_config('workforce.seed_owner_id', :'owner_id', true);
do $$
declare
  v_org constant uuid := '00000000-0000-4000-8000-00000000a001';
  v_owner uuid := current_setting('workforce.seed_owner_id')::uuid;
  e jsonb;
begin
  if to_regnamespace('workforce') is null then raise exception 'workforce_seed: apply PROPOSED_20261022100000_workforce_foundation first'; end if;
  if not workforce.is_owner(v_org, v_owner) then raise exception 'workforce_seed: owner_id % is not an owner in agent.operator_membership', v_owner; end if;
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
end
$$;
select employee_id, kind, role_key, department_key, display_name, manager_employee_id, status from workforce.employee order by department_key, role_key, employee_id;
select name, kind, enabled, interval_seconds, next_run_at from agent.runtime_schedule where name = 'workforce-dispatch';
commit;
