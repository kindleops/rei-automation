-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261022110000_workforce_agntei.sql (Workforce × Agntei).
-- Run only with the owner's approval, like the apply. Tested on disposable PostgreSQL 17 only: the runner
-- proves apply → rollback restores the pre-apply catalog fingerprint exactly.
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261022110000_workforce_agntei_rollback.sql
-- REFUSES (nothing is dropped) while:
--   * any Workforce gateway intent is pending (received / awaiting_approval / authorized / executing): drain it;
--   * any EXTERNAL assignment is not terminal: hand it off / finish / cancel it first;
--   * any employee is pending_link (the foundation's status CHECK has no such status): retire it first.
-- Then deletes this link's rows of #27's extension registry, drops exactly what the apply created (the gateway
-- reader / writer and helpers, the Workforce helpers, workforce.budget, the triggers, the new columns and
-- indexes) and restores the foundation's employee status CHECK and the three replaced writers
-- (employee_upsert, assignment_claim, assignment_resume_job) VERBATIM. The Agntei identity columns of the
-- employees are dropped with them (export first: pg_dump -n workforce). Gateway intents, outcomes and audit
-- rows of the Workforce actions STAY (append-only history).
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'workforce' and table_name = 'employee' and column_name = 'origin') then
    raise exception 'rollback(workforce_agntei) precondition: the migration is not applied';
  end if;
  if exists (select 1 from action_gateway.action_intents where action like 'workforce\_%' and state in ('received', 'awaiting_approval', 'authorized', 'executing')) then
    raise exception 'rollback(workforce_agntei) refused: Workforce gateway intents are still pending; drain them first';
  end if;
  if exists (select 1 from workforce.assignment where execution_mode = 'external' and status not in ('completed', 'failed', 'cancelled')) then
    raise exception 'rollback(workforce_agntei) refused: external assignments are still open; finish, hand off or cancel them first';
  end if;
  if exists (select 1 from workforce.employee where status = 'pending_link') then
    raise exception 'rollback(workforce_agntei) refused: pending_link employees exist; retire them first';
  end if;
end $$;

delete from action_gateway.extensions where link = 'PROPOSED_20261022110000_workforce_agntei';

-- the gateway side
drop function public.action_gateway_dw_workforce(uuid, uuid);
drop function public.action_gateway_workforce_read(text, text, jsonb);
drop function action_gateway.wf_identity_anomaly(action_gateway.action_intents, text, text);
drop function action_gateway.wf_resolve_evidence(uuid, text, text, jsonb);
drop function action_gateway.wf_assignment_json(workforce.assignment, boolean);
drop function action_gateway.wf_principal(text);

-- budgets + history
drop function workforce.employee_gateway_audit(uuid, text, integer);
drop function workforce.budget_status(uuid, text, text, timestamptz);
drop function workforce.budget_revoke(uuid, uuid, uuid);
drop function workforce.budget_put(uuid, jsonb, uuid);
drop table workforce.budget;

-- execution modes
drop function workforce.assignment_handoff(uuid, text, text, text, text, text);
drop function workforce.assignment_external_lease(uuid, text, text, text);
drop function workforce.assignment_claim_external(uuid, text, text, text, integer);
drop trigger assignment_mode_event on workforce.assignment;
drop trigger assignment_mode_sync on workforce.assignment;
drop function workforce.assignment_mode_event();
drop function workforce.assignment_mode_sync();
drop function workforce.assignment_set_external_policy(uuid, text, text, integer, text);
drop index workforce.assignment_external_idx;
alter table workforce.assignment drop column execution_mode, drop column on_external_timeout, drop column external_wait_seconds;

-- mission origin
drop trigger mission_origin_guard on workforce.mission;
drop function workforce.mission_origin_guard();
alter table workforce.mission drop column origin;

-- employee identity
drop function workforce.employee_link_external(uuid, text, text, text);
drop function workforce.binding_refusal(workforce.employee);
drop function workforce.release_external_leases(uuid, text, timestamptz);
drop function workforce.employee_unbind(uuid, text, uuid, text);
drop function workforce.employee_bind_principal(uuid, text, text, uuid, interval, timestamptz);
drop trigger employee_identity_guard on workforce.employee;
drop function workforce.employee_identity_guard();
drop index workforce.employee_action_principal_uq;
drop index workforce.employee_external_identity_uq;
alter table workforce.employee drop constraint employee_status_check;
alter table workforce.employee add constraint employee_status_check check (status in ('active', 'paused', 'retired'));
alter table workforce.employee
  drop column employment_type, drop column origin, drop column external_system, drop column external_install_id, drop column external_agent_id,
  drop column external_linked_at, drop column skills, drop column property_specializations, drop column availability,
  drop column bound_by, drop column bound_at, drop column link_expires_at, drop column binding_valid_until, drop column binding_revoked_at, drop column binding_revoked_by;
drop function workforce.assignment_view(workforce.assignment);
drop function workforce.tags_ok(text[]);

-- the foundation's three writers, VERBATIM (create or replace keeps their grants)
create or replace function workforce.employee_upsert(p_org uuid, p_employee jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce, agent
as $$
declare
  e workforce.employee%rowtype;
  v_id text := p_employee ->> 'employee_id';
  v_created boolean := false;
  v_markets text[];
  v_cycle boolean;
begin
  if not workforce.is_owner(p_org, p_actor) then raise exception 'WF_FORBIDDEN: employees are CEO-authored (actor is not an owner of the org)'; end if;
  if p_employee is null or jsonb_typeof(p_employee) <> 'object' then raise exception 'WF_PAYLOAD_REFUSED: employee must be an object'; end if;
  if exists (select 1 from jsonb_object_keys(p_employee) k where k not in ('employee_id', 'kind', 'role_key', 'department_key', 'display_name', 'employee_code',
             'manager_employee_id', 'user_id', 'action_principal_id', 'status', 'markets', 'segments', 'tier_ceiling', 'spend_day_cap_usd')) then
    raise exception 'WF_PAYLOAD_REFUSED: unknown employee field';
  end if;
  if v_id is null then raise exception 'WF_PAYLOAD_REFUSED: employee_id required'; end if;
  if p_employee ? 'markets' then
    if jsonb_typeof(p_employee -> 'markets') <> 'array' then raise exception 'WF_PAYLOAD_REFUSED: markets must be an array'; end if;
    v_markets := array(select jsonb_array_elements_text(p_employee -> 'markets'));
  end if;
  select * into e from workforce.employee where employee_id = v_id for update;
  if found then
    if e.org_id <> p_org then raise exception 'WF_NOT_FOUND: employee %', v_id; end if;
    if p_employee ? 'kind' and (p_employee ->> 'kind') is distinct from e.kind then raise exception 'WF_CONFLICT: an employee''s kind never changes'; end if;
    update workforce.employee set
      role_key = case when p_employee ? 'role_key' then p_employee ->> 'role_key' else role_key end,
      department_key = case when p_employee ? 'department_key' then p_employee ->> 'department_key' else department_key end,
      display_name = case when p_employee ? 'display_name' then p_employee ->> 'display_name' else display_name end,
      employee_code = case when p_employee ? 'employee_code' then p_employee ->> 'employee_code' else employee_code end,
      manager_employee_id = case when p_employee ? 'manager_employee_id' then p_employee ->> 'manager_employee_id' else manager_employee_id end,
      user_id = case when p_employee ? 'user_id' then (p_employee ->> 'user_id')::uuid else user_id end,
      action_principal_id = case when p_employee ? 'action_principal_id' then p_employee ->> 'action_principal_id' else action_principal_id end,
      status = case when p_employee ? 'status' then p_employee ->> 'status' else status end,
      markets = case when p_employee ? 'markets' then v_markets else markets end,
      segments = case when p_employee ? 'segments' then coalesce(p_employee -> 'segments', '{}'::jsonb) else segments end,
      tier_ceiling = case when p_employee ? 'tier_ceiling' then p_employee ->> 'tier_ceiling' else tier_ceiling end,
      spend_day_cap_usd = case when p_employee ? 'spend_day_cap_usd' then (p_employee ->> 'spend_day_cap_usd')::numeric else spend_day_cap_usd end,
      updated_at = clock_timestamp()
    where employee_id = v_id returning * into e;
  else
    insert into workforce.employee (employee_id, org_id, kind, role_key, department_key, display_name, employee_code, manager_employee_id, user_id,
                                    action_principal_id, status, markets, segments, tier_ceiling, spend_day_cap_usd, created_by)
    values (v_id, p_org, p_employee ->> 'kind', p_employee ->> 'role_key', p_employee ->> 'department_key', p_employee ->> 'display_name',
            p_employee ->> 'employee_code', p_employee ->> 'manager_employee_id', (p_employee ->> 'user_id')::uuid, p_employee ->> 'action_principal_id',
            coalesce(p_employee ->> 'status', 'active'), coalesce(v_markets, '{}'), coalesce(p_employee -> 'segments', '{}'::jsonb),
            coalesce(p_employee ->> 'tier_ceiling', 'T1'), coalesce((p_employee ->> 'spend_day_cap_usd')::numeric, 0), p_actor)
    returning * into e;
    v_created := true;
  end if;
  if e.manager_employee_id is not null then
    if not exists (select 1 from workforce.employee m where m.employee_id = e.manager_employee_id and m.org_id = p_org) then
      raise exception 'WF_NOT_FOUND: manager %', e.manager_employee_id;
    end if;
    with recursive chain(id, depth) as (
      select e.manager_employee_id, 1
      union all
      select m.manager_employee_id, c.depth + 1 from chain c join workforce.employee m on m.employee_id = c.id
       where m.manager_employee_id is not null and c.depth < 64)
    select exists (select 1 from chain where id = e.employee_id) into v_cycle;
    if v_cycle then raise exception 'WF_CONFLICT: the manager chain of % would be a cycle', e.employee_id; end if;
  end if;
  perform workforce.emit(p_org, 'wf.employee.upserted', null, null, e.employee_id, jsonb_build_object('created', v_created, 'role', e.role_key, 'status', e.status));
  return to_jsonb(e);
end
$$;

create or replace function workforce.assignment_claim(p_org uuid, p_owner text, p_limit integer, p_lease_seconds integer, p_now timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  r record;
  a workforce.assignment%rowtype;
  v_out jsonb := '[]'::jsonb;
begin
  if p_owner is null or p_owner !~ '^[A-Za-z0-9_.:-]{1,80}$' then raise exception 'WF_PAYLOAD_REFUSED: lease owner must match ^[A-Za-z0-9_.:-]{1,80}$'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 15 and 3600 then raise exception 'WF_PAYLOAD_REFUSED: lease_seconds must be 15..3600'; end if;
  if p_limit is null or p_limit not between 1 and 50 then raise exception 'WF_PAYLOAD_REFUSED: limit must be 1..50'; end if;
  -- 1. dependency resolution (pending → ready | cancelled)
  for r in
    select a0.assignment_id, a0.depends_on,
           (select count(*) from workforce.assignment d where d.mission_id = a0.mission_id and d.step_key = any (a0.depends_on) and d.status = 'completed')::int as n_done,
           (select min(d.step_key) from workforce.assignment d where d.mission_id = a0.mission_id and d.step_key = any (a0.depends_on) and d.status in ('failed', 'cancelled')) as dead_dep
      from workforce.assignment a0 join workforce.mission m on m.mission_id = a0.mission_id
     where a0.org_id = p_org and a0.status = 'pending' and m.status in ('active', 'waiting')
     order by a0.created_at, a0.assignment_id
     limit 500
     for update of a0 skip locked
  loop
    if r.dead_dep is not null then
      update workforce.assignment set status = 'cancelled', finished_at = v_now,
             last_error = jsonb_build_object('code', 'DEPENDENCY_FAILED', 'step', r.dead_dep)
       where assignment_id = r.assignment_id returning * into a;
      perform workforce.emit_assignment(a, 'pending', 'dependency_failed');
    elsif r.n_done = cardinality(r.depends_on) then
      update workforce.assignment set status = 'ready' where assignment_id = r.assignment_id returning * into a;
      perform workforce.emit_assignment(a, 'pending', 'dependencies_completed');
    end if;
  end loop;
  -- 2. lease the due ready rows
  for r in
    select a0.assignment_id
      from workforce.assignment a0
      join workforce.mission m on m.mission_id = a0.mission_id
      join workforce.employee e on e.employee_id = a0.assignee_employee_id
     where a0.org_id = p_org and a0.status = 'ready' and (a0.next_attempt_at is null or a0.next_attempt_at <= v_now)
       and m.status in ('active', 'waiting') and e.status = 'active'
       and not exists (select 1 from workforce.assignment d where d.mission_id = a0.mission_id and d.step_key = any (a0.depends_on) and d.status <> 'completed')
     order by m.priority desc, a0.next_attempt_at nulls first, a0.created_at, a0.assignment_id
     limit p_limit
     for update of a0 skip locked
  loop
    update workforce.assignment
       set status = 'leased', lease_token = gen_random_uuid(), lease_owner = p_owner, lease_until = v_now + make_interval(secs => p_lease_seconds),
           lease_seconds = p_lease_seconds, claimed_at = v_now, finished_token = null
     where assignment_id = r.assignment_id returning * into a;
    perform workforce.emit_assignment(a, 'ready');
    v_out := v_out || jsonb_build_array(to_jsonb(a));
  end loop;
  return v_out;
end
$$;

create or replace function workforce.assignment_resume_job(p_org uuid, p_assignment_id text, p_runtime_job_id text, p_job_state text, p_result jsonb, p_error jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare a workforce.assignment%rowtype; v_attempt integer;
begin
  select * into a from workforce.assignment where assignment_id = p_assignment_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: assignment %', p_assignment_id; end if;
  if a.status <> 'waiting_job' or a.runtime_job_id is distinct from p_runtime_job_id then
    return jsonb_build_object('changed', false, 'assignment', to_jsonb(a));
  end if;
  if p_job_state = 'completed' then
    update workforce.assignment
       set status = 'completed', outcome_class = 'verified', output = coalesce(p_result, '{}'::jsonb),
           evidence = evidence || jsonb_build_array(jsonb_build_object('source', 'agent.research_job', 'job_id', p_runtime_job_id)),
           finished_at = clock_timestamp()
     where assignment_id = p_assignment_id returning * into a;
    perform workforce.release_claims_of(a.assignment_id, 'finished');
    perform workforce.emit_assignment(a, 'waiting_job', 'job_completed');
  elsif p_job_state in ('failed', 'dead_letter', 'cancelled') then
    v_attempt := a.attempt + 1;
    update workforce.assignment
       set status = case when v_attempt >= max_attempts then 'failed' else 'ready' end,
           attempt = v_attempt,
           next_attempt_at = case when v_attempt >= max_attempts then next_attempt_at else clock_timestamp() + workforce.backoff(v_attempt) end,
           runtime_job_id = case when v_attempt >= max_attempts then runtime_job_id else null end,
           last_error = coalesce(p_error, '{}'::jsonb) || jsonb_build_object('code', 'RUNTIME_JOB_' || upper(p_job_state), 'job_id', p_runtime_job_id),
           finished_at = case when v_attempt >= max_attempts then clock_timestamp() else null end
     where assignment_id = p_assignment_id returning * into a;
    if a.status = 'failed' then perform workforce.release_claims_of(a.assignment_id, 'finished'); end if;
    perform workforce.emit_assignment(a, 'waiting_job', 'job_' || p_job_state);
  else
    return jsonb_build_object('changed', false, 'assignment', to_jsonb(a));
  end if;
  return jsonb_build_object('changed', true, 'assignment', to_jsonb(a));
end
$$;

do $$
begin
  if exists (select 1 from action_gateway.extensions where link = 'PROPOSED_20261022110000_workforce_agntei') then raise exception 'postcondition: registry rows remain'; end if;
  if not coalesce((action_gateway.self_check('lc_action_gateway') ->> 'ok')::boolean, false) then raise exception 'postcondition: the gateway self-check refuses after the rollback'; end if;
end $$;

notify pgrst, 'reload schema';
