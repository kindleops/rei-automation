-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required (each production migration is
-- separately authorized).
--
-- LeadCommand Workforce × Agntei — the LeadCommand side (docs/WORKFORCE-AGNTEI.md §1–§5).
--
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT inside, so the runner can wrap it):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261022110000_workforce_agntei.sql
-- Pretest:          PROPOSED_20261022110000_workforce_agntei_pretest.sql
-- Posttest:         PROPOSED_20261022110000_workforce_agntei_posttest.sql
-- Rollback:         PROPOSED_20261022110000_workforce_agntei_rollback.sql
-- Rollback posttest PROPOSED_20261022110000_workforce_agntei_rollback_posttest.sql
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id workforce_agntei
-- ORDER: AFTER the Workforce foundation (PROPOSED_20261022100000_workforce_foundation.sql) AND the
--        Action Gateway chain (#26 PROPOSED_20261019160000_action_gateway.sql + #27
--        PROPOSED_20261020100000_action_gateway_t2.sql: the extension registry). The preconditions RAISE
--        when either is absent. It composes with #28 (it only ADDS registry rows, like #28).
--
-- WHAT IT ADDS (everything born OFF: no principal, no grant, no control key, no kind armed)
--   workforce.employee     employment_type (autonomous_ai | operator_ai | human; human ⇔ kind human),
--                          origin (workforce | agntei), external_system / external_install_id /
--                          external_agent_id / external_linked_at (ONE Agntei agent ⇔ one employee, ever:
--                          a partial UNIQUE), skills, property_specializations, availability, and the
--                          status pending_link. An Agntei employee is born pending_link, unbound and unlinked;
--                          the owner binds its Action Gateway principal (workforce.employee_bind_principal,
--                          owner-only) for a LINK WINDOW (link_expires_at: default 24 h, max 7 d) and a binding
--                          validity (binding_valid_until ≤ the principal credential's expiry); the agent links
--                          itself once, inside the window (workforce_link_self). workforce.employee_unbind (owner)
--                          revokes the binding at once. After expiry / revocation every workforce_* call of that
--                          principal is refused (BINDING_EXPIRED / BINDING_REVOKED, audited) and its open external
--                          leases are released for reaping (a lease never outlives the binding). A guard trigger
--                          makes origin / employment type / the external identity immutable.
--   workforce.mission      origin (workforce | agntei), stamped once at opening.
--   workforce.assignment   execution_mode internal | external, DERIVED from the assignee's employment type by
--                          a trigger (insert and every reassignment); external assignments are never
--                          claimed by workforce.assignment_claim (replaced: one predicate added), and a
--                          completed research job hands an external assignment BACK to its agent (ready)
--                          instead of completing it (workforce.assignment_resume_job replaced: one branch).
--                          An expired external lease is reaped back to ready for the SAME assignee (the mode never
--                          flips silently). on_external_timeout (wait | reassign_internal, default wait) +
--                          external_wait_seconds record the COO's policy for an external row nobody picks up:
--                          wait ⇒ escalate to the COO after the bounded wait; reassign_internal ⇒ the COO
--                          reassigns it to an internal employee (the engine applies it; every transition is an event).
--   workforce.budget       org / department / mission / employee × day / month caps (CEO-authored), read
--                          with their committed spend (agent.spend_ledger via the assignments' runtime jobs)
--                          by the authority engine before paid work (workforce.budget_status).
--   the gateway-side domain writers of the Workforce actions (T1, internal only):
--     public.action_gateway_dw_workforce(intent, lease)   ONE lease-bound SECURITY DEFINER writer for
--       workforce_link_self, workforce_open_mission, workforce_claim_assignment, workforce_report_progress,
--       workforce_complete_assignment, workforce_request_research, workforce_handoff, workforce_escalate.
--       It reads its parameters FROM the authorized intent and acts as the employee bound to the intent's
--       agent (workforce.employee.action_principal_id = the authenticated principal) — never an argument.
--     public.action_gateway_workforce_read(digest, kind, p)  the principal-bound read (whoami, assignments,
--       one mission, the policy context): the presented credential digest selects the principal, the kill
--       switches and a live grant are re-checked, nothing is written.
--   Both are registered in action_gateway.extensions (definer_function; the writes as domain_write_action),
--   so #26's self-check and action_gateway_complete read them without an edit.
--
-- HARD RULES (asserted by the posttest and tests/critical): nothing here inserts into send_queue, writes an
-- offer, a stage, a campaign or a suppression, or contacts anyone. The only runtime kinds it enqueues are
-- workforce.coo_plan (a mission opened through the gateway) and property.research (read-only research).
-- IDENTITY_MISMATCH (a second Agntei identity presented for a linked employee, or an identity already
-- linked to another employee) is refused, recorded (grant_note_failure) and SUSPENDS the principal's
-- Workforce grants (grant_suspend: only an owner reinstates).
-- ════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ── 0. preconditions (RAISE; nothing is created when one fails) ─────────────
do $$
begin
  if to_regnamespace('workforce') is null or to_regclass('workforce.employee') is null or to_regclass('workforce.assignment') is null or to_regclass('workforce.mission') is null
     or to_regprocedure('workforce.assignment_claim(uuid,text,integer,integer,timestamp with time zone)') is null
     or to_regprocedure('workforce.employee_upsert(uuid,jsonb,uuid)') is null
     or to_regprocedure('workforce.assignment_resume_job(uuid,text,text,text,jsonb,jsonb)') is null
     or to_regprocedure('workforce.emit(uuid,text,text,text,text,jsonb)') is null then
    raise exception 'workforce_agntei: the Workforce foundation (PROPOSED_20261022100000_workforce_foundation.sql) must be applied first';
  end if;
  if to_regnamespace('action_gateway') is null or to_regprocedure('action_gateway.self_check(name)') is null or to_regprocedure('action_gateway.dw_begin(uuid,uuid,text[])') is null
     or to_regprocedure('action_gateway.finish_intent(uuid,text,text,jsonb)') is null or to_regprocedure('action_gateway.grant_note_failure(uuid,text)') is null
     or to_regprocedure('action_gateway.grant_suspend(uuid,text)') is null or to_regprocedure('action_gateway.control_refusal(text,smallint)') is null then
    raise exception 'workforce_agntei: the Action Gateway (link #26, PROPOSED_20261019160000_action_gateway.sql) must be applied first';
  end if;
  if to_regclass('action_gateway.extensions') is null or to_regprocedure('action_gateway.extension_names(text)') is null then
    raise exception 'workforce_agntei: the Action Gateway extension registry (link #27, PROPOSED_20261020100000_action_gateway_t2.sql) must be applied first';
  end if;
  if to_regprocedure('agent.runtime_enqueue(text,text,jsonb,text,integer,integer,numeric,boolean,timestamp with time zone)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'agent' and table_name = 'runtime_limits' and column_name = 'emergency_stop')
     or not exists (select 1 from information_schema.columns where table_schema = 'agent' and table_name = 'spend_ledger' and column_name = 'job_id') then
    raise exception 'workforce_agntei: the R2 runtime (agent.runtime_enqueue, runtime_limits.emergency_stop, spend_ledger.job_id) is missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inbox_thread_state' and column_name = 'manual_override') then
    raise exception 'workforce_agntei: public.inbox_thread_state.manual_override (the human-ownership fact) is missing';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'workforce' and table_name = 'employee' and column_name = 'origin')
     or exists (select 1 from action_gateway.extensions where link = 'PROPOSED_20261022110000_workforce_agntei') then
    raise exception 'workforce_agntei: already applied';
  end if;
  if not (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) then
    raise exception 'workforce_agntei: applying role % must have BYPASSRLS (the SECURITY DEFINER writers run as it under FORCE RLS)', current_user;
  end if;
end
$$;

-- ── 1. helpers ──────────────────────────────────────────────────────────────
-- skill / specialization tags: lower-case slugs, ≤ 50, no NULL, no duplicate (the markets rule)
create or replace function workforce.tags_ok(p text[])
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select p is not null and cardinality(p) <= 50
     and not exists (select 1 from unnest(p) m where m is null or m !~ '^[a-z0-9][a-z0-9_.:-]{0,79}$')
     and cardinality(p) = (select count(distinct m) from unnest(p) m)
$$;

-- an assignment row as an agent may see it: never a lease token
create or replace function workforce.assignment_view(a workforce.assignment)
returns jsonb
language sql
stable
set search_path = pg_catalog
as $$
  select case when a.assignment_id is null then null else to_jsonb(a) - 'lease_token' - 'finished_token' end
$$;

-- ── 2. employee: one identity (§1) ─────────────────────────────────────────
alter table workforce.employee
  add column employment_type text,
  add column origin text not null default 'workforce' check (origin in ('workforce', 'agntei')),
  add column external_system text check (external_system is null or external_system = 'agntei'),
  add column external_install_id text check (external_install_id is null or external_install_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,79}$'),
  add column external_agent_id text check (external_agent_id is null or external_agent_id ~ '^agent_[A-Za-z0-9_-]{3,64}$'),
  add column external_linked_at timestamptz,
  add column skills text[] not null default '{}' check (workforce.tags_ok(skills)),
  add column property_specializations text[] not null default '{}' check (workforce.tags_ok(property_specializations)),
  add column availability text not null default 'unknown' check (availability in ('available', 'busy', 'off', 'unknown')),
  -- the operator-authorized, EXPIRING binding of an Agntei employee to its principal (owner: employee_bind_principal / employee_unbind)
  add column bound_by uuid,
  add column bound_at timestamptz,
  add column link_expires_at timestamptz,
  add column binding_valid_until timestamptz,
  add column binding_revoked_at timestamptz,
  add column binding_revoked_by uuid;
-- the existing rows: human ⇒ human, ai ⇒ autonomous_ai (the applying role owns the table: the write-path guard passes)
update workforce.employee set employment_type = case when kind = 'human' then 'human' else 'autonomous_ai' end;
alter table workforce.employee alter column employment_type set not null;
alter table workforce.employee
  add constraint employee_employment_type_check check (employment_type in ('autonomous_ai', 'operator_ai', 'human')),
  add constraint employee_employment_human check ((employment_type = 'human') = (kind = 'human')),
  -- an operator-directed AI is an Agntei agent, and an Agntei employee is an operator-directed AI
  add constraint employee_operator_ai_is_agntei check ((employment_type = 'operator_ai') = (origin = 'agntei')),
  add constraint employee_external_ref_shape check ((external_system is null) = (external_install_id is null) and (external_install_id is null) = (external_agent_id is null)
                                                    and (external_agent_id is null) = (external_linked_at is null)),
  add constraint employee_external_ref_origin check (external_system is null or origin = 'agntei'),
  add constraint employee_external_ids_clean check (agent.payload_string_violation(external_install_id, 'external_install_id', 0) is null
                                                    and agent.payload_string_violation(external_agent_id, 'external_agent_id', 0) is null),
  -- pending_link is the Agntei birth status; a working Agntei employee is linked
  add constraint employee_pending_link_shape check (status <> 'pending_link' or (origin = 'agntei' and external_agent_id is null)),
  add constraint employee_agntei_linked check (origin <> 'agntei' or status in ('pending_link', 'retired') or external_agent_id is not null),
  add constraint employee_binding_shape check (origin <> 'agntei' or ((action_principal_id is null) = (bound_at is null) and (bound_at is null) = (bound_by is null)
                                                                       and (bound_at is null) = (binding_valid_until is null) and (bound_at is null) = (link_expires_at is null))),
  add constraint employee_binding_window check (link_expires_at is null or (link_expires_at > bound_at and link_expires_at <= bound_at + interval '7 days')),
  add constraint employee_binding_revoke_pair check ((binding_revoked_at is null) = (binding_revoked_by is null));
alter table workforce.employee drop constraint employee_status_check;
alter table workforce.employee add constraint employee_status_check check (status in ('active', 'paused', 'retired', 'pending_link'));
-- one Agntei agent ⇔ one employee, ever (the reference survives retirement); one principal ⇔ one employee
create unique index employee_external_identity_uq on workforce.employee (org_id, external_system, external_install_id, external_agent_id) where external_agent_id is not null;
create unique index employee_action_principal_uq on workforce.employee (org_id, action_principal_id) where action_principal_id is not null;
comment on column workforce.employee.employment_type is 'autonomous_ai (the in-process engine), operator_ai (an Agntei agent: its assignments are external), human. docs/WORKFORCE-AGNTEI.md §1.';
comment on column workforce.employee.external_agent_id is 'The Agntei agent id (agent_…) this employee is, set ONCE by workforce_link_self through the Action Gateway (authenticated principal). Immutable.';

-- identity guard: origin / employment type immutable; the external identity is set once (link) and never changes;
-- an Agntei employee is born pending_link and unbound, its principal is bound once (owner) before the link
create or replace function workforce.employee_identity_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if new.external_agent_id is not null or new.external_system is not null then
      raise exception 'WF_ILLEGAL_TRANSITION: the external identity is set only by workforce_link_self' using errcode = 'check_violation';
    end if;
    if new.origin = 'agntei' and (new.status <> 'pending_link' or new.action_principal_id is not null) then
      raise exception 'WF_ILLEGAL_TRANSITION: an Agntei employee is born pending_link and unbound (the owner binds its principal)' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.origin is distinct from old.origin then raise exception 'WF_IMMUTABLE: an employee''s origin never changes' using errcode = 'check_violation'; end if;
  if new.employment_type is distinct from old.employment_type then raise exception 'WF_IMMUTABLE: an employee''s employment type never changes' using errcode = 'check_violation'; end if;
  if old.external_agent_id is not null
     and (new.external_system, new.external_install_id, new.external_agent_id, new.external_linked_at) is distinct from (old.external_system, old.external_install_id, old.external_agent_id, old.external_linked_at) then
    raise exception 'WF_IMMUTABLE: a linked external identity never changes' using errcode = 'check_violation';
  end if;
  if old.external_agent_id is null and new.external_agent_id is not null
     and (old.status <> 'pending_link' or old.action_principal_id is null or new.status <> 'active' or new.action_principal_id is distinct from old.action_principal_id
          or old.binding_revoked_at is not null or old.binding_valid_until <= clock_timestamp() or old.link_expires_at <= clock_timestamp()) then
    raise exception 'WF_ILLEGAL_TRANSITION: linking needs a live binding of a pending_link employee, inside its link window, and activates it' using errcode = 'check_violation';
  end if;
  if old.origin = 'agntei' and new.action_principal_id is distinct from old.action_principal_id then
    -- a principal is bound by the owner to an unbound employee, or REPLACES a binding that was revoked or expired
    if new.action_principal_id is null
       or (old.action_principal_id is not null and old.binding_revoked_at is null and old.binding_valid_until > clock_timestamp()) then
      raise exception 'WF_IMMUTABLE: an Agntei employee''s live binding is ended (employee_unbind) before another principal is bound' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from action_gateway.agent_principals p where p.agent_id = new.action_principal_id and p.org_id = new.org_id and p.status = 'active') then
      raise exception 'WF_NOT_FOUND: no active Action Gateway principal % in this org', new.action_principal_id using errcode = 'check_violation';
    end if;
  end if;
  if old.status = 'pending_link' and new.status not in ('pending_link', 'active', 'retired') then
    raise exception 'WF_ILLEGAL_TRANSITION: a pending_link employee is linked (active) or retired' using errcode = 'check_violation';
  end if;
  if old.status = 'pending_link' and new.status = 'active' and new.external_agent_id is null then
    raise exception 'WF_ILLEGAL_TRANSITION: only workforce_link_self activates an Agntei employee' using errcode = 'check_violation';
  end if;
  if old.status <> 'pending_link' and new.status = 'pending_link' then
    raise exception 'WF_ILLEGAL_TRANSITION: pending_link is a birth status' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger employee_identity_guard before insert or update on workforce.employee for each row execute function workforce.employee_identity_guard();

-- employee_upsert (replaced): the descriptive fields of §1 (employment_type, origin at birth, skills,
-- property_specializations, availability). The external identity is never upsertable; an Agntei
-- employee's principal is bound only by workforce.employee_bind_principal.
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
  v_skills text[];
  v_specs text[];
  v_cycle boolean;
  v_origin text;
  v_kind text;
begin
  if not workforce.is_owner(p_org, p_actor) then raise exception 'WF_FORBIDDEN: employees are CEO-authored (actor is not an owner of the org)'; end if;
  if p_employee is null or jsonb_typeof(p_employee) <> 'object' then raise exception 'WF_PAYLOAD_REFUSED: employee must be an object'; end if;
  if exists (select 1 from jsonb_object_keys(p_employee) k where k not in ('employee_id', 'kind', 'role_key', 'department_key', 'display_name', 'employee_code',
             'manager_employee_id', 'user_id', 'action_principal_id', 'status', 'markets', 'segments', 'tier_ceiling', 'spend_day_cap_usd',
             'employment_type', 'origin', 'skills', 'property_specializations', 'availability')) then
    raise exception 'WF_PAYLOAD_REFUSED: unknown employee field';
  end if;
  if v_id is null then raise exception 'WF_PAYLOAD_REFUSED: employee_id required'; end if;
  if p_employee ? 'markets' then
    if jsonb_typeof(p_employee -> 'markets') <> 'array' then raise exception 'WF_PAYLOAD_REFUSED: markets must be an array'; end if;
    v_markets := array(select jsonb_array_elements_text(p_employee -> 'markets'));
  end if;
  if p_employee ? 'skills' then
    if jsonb_typeof(p_employee -> 'skills') <> 'array' then raise exception 'WF_PAYLOAD_REFUSED: skills must be an array'; end if;
    v_skills := array(select jsonb_array_elements_text(p_employee -> 'skills'));
  end if;
  if p_employee ? 'property_specializations' then
    if jsonb_typeof(p_employee -> 'property_specializations') <> 'array' then raise exception 'WF_PAYLOAD_REFUSED: property_specializations must be an array'; end if;
    v_specs := array(select jsonb_array_elements_text(p_employee -> 'property_specializations'));
  end if;
  select * into e from workforce.employee where employee_id = v_id for update;
  if found then
    if e.org_id <> p_org then raise exception 'WF_NOT_FOUND: employee %', v_id; end if;
    if p_employee ? 'kind' and (p_employee ->> 'kind') is distinct from e.kind then raise exception 'WF_CONFLICT: an employee''s kind never changes'; end if;
    if p_employee ? 'origin' and (p_employee ->> 'origin') is distinct from e.origin then raise exception 'WF_CONFLICT: an employee''s origin never changes'; end if;
    if p_employee ? 'employment_type' and (p_employee ->> 'employment_type') is distinct from e.employment_type then raise exception 'WF_CONFLICT: an employee''s employment type never changes'; end if;
    if e.origin = 'agntei' and p_employee ? 'action_principal_id' and (p_employee ->> 'action_principal_id') is distinct from e.action_principal_id then
      raise exception 'WF_FORBIDDEN: an Agntei employee is bound to its principal only by workforce.employee_bind_principal (owner)';
    end if;
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
      skills = case when p_employee ? 'skills' then v_skills else skills end,
      property_specializations = case when p_employee ? 'property_specializations' then v_specs else property_specializations end,
      availability = case when p_employee ? 'availability' then p_employee ->> 'availability' else availability end,
      updated_at = clock_timestamp()
    where employee_id = v_id returning * into e;
  else
    v_kind := p_employee ->> 'kind';
    v_origin := coalesce(p_employee ->> 'origin', 'workforce');
    if v_origin = 'agntei' and (p_employee ->> 'action_principal_id') is not null then
      raise exception 'WF_FORBIDDEN: an Agntei employee is bound to its principal only by workforce.employee_bind_principal (owner)';
    end if;
    insert into workforce.employee (employee_id, org_id, kind, role_key, department_key, display_name, employee_code, manager_employee_id, user_id,
                                    action_principal_id, status, markets, segments, tier_ceiling, spend_day_cap_usd, created_by,
                                    employment_type, origin, skills, property_specializations, availability)
    values (v_id, p_org, v_kind, p_employee ->> 'role_key', p_employee ->> 'department_key', p_employee ->> 'display_name',
            p_employee ->> 'employee_code', p_employee ->> 'manager_employee_id', (p_employee ->> 'user_id')::uuid, p_employee ->> 'action_principal_id',
            coalesce(p_employee ->> 'status', case when v_origin = 'agntei' then 'pending_link' else 'active' end), coalesce(v_markets, '{}'), coalesce(p_employee -> 'segments', '{}'::jsonb),
            coalesce(p_employee ->> 'tier_ceiling', 'T1'), coalesce((p_employee ->> 'spend_day_cap_usd')::numeric, 0), p_actor,
            coalesce(p_employee ->> 'employment_type', case when v_kind = 'human' then 'human' when v_origin = 'agntei' then 'operator_ai' else 'autonomous_ai' end),
            v_origin, coalesce(v_skills, '{}'), coalesce(v_specs, '{}'), coalesce(p_employee ->> 'availability', 'unknown'))
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

-- §1 step 2: the OWNER binds an Agntei employee to its minted Action Gateway principal, for a LINK WINDOW
-- (p_link_window: default 24 h, 1 min … 7 d; workforce_link_self succeeds only inside it) and a binding VALIDITY
-- (p_binding_valid_until: default = the principal credential's expiry, never later). The principal must be active, of
-- this org, sponsored by the CEO user, and bound to no other employee. A re-bind (same principal: a renewal; another
-- principal: only after the live binding was revoked or expired) is a NEW owner authorization. Owner path only
-- (service_role / the SQL editor): never granted to agent_api.
create or replace function workforce.employee_bind_principal(p_org uuid, p_employee_id text, p_agent_id text, p_actor uuid,
                                                             p_link_window interval default interval '24 hours', p_binding_valid_until timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce, agent
as $$
declare e workforce.employee%rowtype; pr action_gateway.agent_principals%rowtype; v_ceo uuid; v_now timestamptz := clock_timestamp(); v_until timestamptz;
begin
  if not workforce.is_owner(p_org, p_actor) then raise exception 'WF_FORBIDDEN: only an owner binds an employee to its principal'; end if;
  if p_link_window is null or p_link_window < interval '1 minute' or p_link_window > interval '7 days' then raise exception 'WF_PAYLOAD_REFUSED: the link window is 1 minute .. 7 days'; end if;
  select * into e from workforce.employee where employee_id = p_employee_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: employee %', p_employee_id; end if;
  if e.origin <> 'agntei' then raise exception 'WF_CONFLICT: % is not an Agntei employee', p_employee_id; end if;
  if e.status = 'retired' then raise exception 'WF_CONFLICT: % is retired', p_employee_id; end if;
  if e.action_principal_id is not null and e.action_principal_id <> p_agent_id and e.binding_revoked_at is null and e.binding_valid_until > v_now then
    raise exception 'WF_CONFLICT: % has a live binding to another principal (employee_unbind first)', p_employee_id;
  end if;
  select * into pr from action_gateway.agent_principals where agent_id = p_agent_id and org_id = p_org;
  if pr.agent_id is null then raise exception 'WF_NOT_FOUND: Action Gateway principal % (mint and register it first)', p_agent_id; end if;
  if pr.status <> 'active' or pr.credential_expires_at <= v_now then raise exception 'WF_CONFLICT: principal % is not active', p_agent_id; end if;
  select user_id into v_ceo from workforce.employee where org_id = p_org and role_key = 'ceo';
  if v_ceo is null or pr.sponsor_user_id is distinct from v_ceo then raise exception 'WF_FORBIDDEN: the principal''s sponsor must be the CEO user'; end if;
  if exists (select 1 from workforce.employee x where x.org_id = p_org and x.action_principal_id = p_agent_id and x.employee_id <> p_employee_id) then
    raise exception 'WF_CONFLICT: principal % is bound to another employee', p_agent_id;
  end if;
  v_until := coalesce(p_binding_valid_until, pr.credential_expires_at);
  if v_until <= v_now or v_until > pr.credential_expires_at then raise exception 'WF_PAYLOAD_REFUSED: binding_valid_until must be in the future and no later than the credential expiry (%)', pr.credential_expires_at; end if;
  update workforce.employee
     set action_principal_id = p_agent_id, bound_by = p_actor, bound_at = v_now, link_expires_at = v_now + p_link_window, binding_valid_until = v_until,
         binding_revoked_at = null, binding_revoked_by = null, updated_at = v_now
   where employee_id = p_employee_id returning * into e;
  perform workforce.emit(p_org, 'wf.employee.principal_bound', null, null, e.employee_id,
    jsonb_build_object('agent_id', p_agent_id, 'actor_id', p_actor, 'link_expires_at', e.link_expires_at, 'binding_valid_until', e.binding_valid_until));
  return to_jsonb(e);
end
$$;

-- the OWNER ends a binding at once: every workforce_* call of that principal is then refused (BINDING_REVOKED), and the
-- open external leases it holds are released and reaped back to ready for the SAME assignee (never a mode change)
create or replace function workforce.employee_unbind(p_org uuid, p_employee_id text, p_actor uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare e workforce.employee%rowtype; v_now timestamptz := clock_timestamp(); n int;
begin
  if not workforce.is_owner(p_org, p_actor) then raise exception 'WF_FORBIDDEN: only an owner ends a binding'; end if;
  -- FOR NO KEY UPDATE: the leases released below are assignment rows the dispatch pass may hold (see action_gateway_dw_workforce)
  select * into e from workforce.employee where employee_id = p_employee_id and org_id = p_org for no key update;
  if not found then raise exception 'WF_NOT_FOUND: employee %', p_employee_id; end if;
  if e.action_principal_id is null or e.origin <> 'agntei' then raise exception 'WF_CONFLICT: % has no binding', p_employee_id; end if;
  if e.binding_revoked_at is null then
    update workforce.employee set binding_revoked_at = v_now, binding_revoked_by = p_actor, updated_at = v_now where employee_id = p_employee_id returning * into e;
  end if;
  n := workforce.release_external_leases(p_org, p_employee_id, v_now);
  perform workforce.emit(p_org, 'wf.employee.binding_revoked', null, null, e.employee_id,
    jsonb_build_object('agent_id', e.action_principal_id, 'actor_id', p_actor, 'leases_released', n)
      || case when p_reason is not null then jsonb_build_object('reason', left(p_reason, 200)) else '{}'::jsonb end);
  return to_jsonb(e) || jsonb_build_object('leases_released', n);
end
$$;

-- internal: end the external leases of an employee NOW and reap them (the reaper's own rules: back to ready for the
-- same assignee with attempt + 1, or failed past max_attempts); returns how many leases were ended
create or replace function workforce.release_external_leases(p_org uuid, p_employee_id text, p_at timestamptz)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare n int;
begin
  update workforce.assignment set lease_until = least(lease_until, p_at - interval '1 millisecond')
   where org_id = p_org and assignee_employee_id = p_employee_id and execution_mode = 'external' and status in ('leased', 'running') and lease_until >= p_at;
  get diagnostics n = row_count;
  if n > 0 then perform workforce.assignment_reap(p_org, p_at); end if;
  return n;
end
$$;

-- the binding verdict of an employee for a gateway call: null (live) | BINDING_REVOKED | BINDING_EXPIRED | NOT_AN_AGNTEI_EMPLOYEE
create or replace function workforce.binding_refusal(e workforce.employee)
returns text
language sql
stable
set search_path = pg_catalog
as $$
  select case when e.employee_id is null then 'NOT_REGISTERED' when e.origin <> 'agntei' then 'NOT_AN_AGNTEI_EMPLOYEE'
              when e.binding_revoked_at is not null then 'BINDING_REVOKED' when e.binding_valid_until is null or e.binding_valid_until <= clock_timestamp() then 'BINDING_EXPIRED'
              else null end
$$;

-- internal: §1 step 4 (called by the gateway writer for the authenticated principal only)
create or replace function workforce.employee_link_external(p_org uuid, p_employee_id text, p_install_id text, p_agent_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare e workforce.employee%rowtype; v_now timestamptz := clock_timestamp();
begin
  update workforce.employee
     set external_system = 'agntei', external_install_id = p_install_id, external_agent_id = p_agent_id, external_linked_at = v_now,
         status = 'active', heartbeat_at = v_now, updated_at = v_now
   where employee_id = p_employee_id and org_id = p_org
  returning * into e;
  if e.employee_id is null then raise exception 'WF_NOT_FOUND: employee %', p_employee_id; end if;
  perform workforce.emit(p_org, 'wf.employee.linked', null, null, e.employee_id, jsonb_build_object('external_system', 'agntei', 'external_agent_id', p_agent_id));
  return to_jsonb(e);
end
$$;

-- ── 3. mission origin ───────────────────────────────────────────────────────
alter table workforce.mission add column origin text not null default 'workforce' check (origin in ('workforce', 'agntei'));
comment on column workforce.mission.origin is 'workforce (opened in Workforce) or agntei (a CEO directive relayed by an operator-directed Agntei agent through the Action Gateway). Stamped once at opening.';
create or replace function workforce.mission_origin_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if new.origin <> 'workforce' then raise exception 'WF_ILLEGAL_TRANSITION: a mission is opened by workforce.mission_open; the gateway stamps its origin' using errcode = 'check_violation'; end if;
    return new;
  end if;
  if new.origin is distinct from old.origin
     and not (old.origin = 'workforce' and new.origin = 'agntei' and old.status = 'planning' and old.plan_version = 0 and old.report is null) then
    raise exception 'WF_IMMUTABLE: a mission''s origin is stamped once, at opening' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger mission_origin_guard before insert or update on workforce.mission for each row execute function workforce.mission_origin_guard();

-- ── 4. execution modes (§3) ────────────────────────────────────────────────
alter table workforce.assignment
  add column execution_mode text not null default 'internal' check (execution_mode in ('internal', 'external')),
  -- the COO's recorded policy for an external row nobody picks up within external_wait_seconds
  add column on_external_timeout text not null default 'wait' check (on_external_timeout in ('wait', 'reassign_internal')),
  add column external_wait_seconds integer not null default 3600 check (external_wait_seconds between 60 and 604800);
comment on column workforce.assignment.on_external_timeout is 'wait (default): after external_wait_seconds without its agent, the assignment is escalated to the COO; reassign_internal: the COO reassigns it to an internal employee. The ONLY ways besides an explicit handoff the mode changes; every transition is an event.';
comment on column workforce.assignment.execution_mode is 'internal: claimed by workforce.dispatch (assignment_claim). external: never claimed by dispatch; the assignee''s Agntei agent claims it through workforce_claim_assignment. Derived from the assignee''s employment type (trigger).';
create index assignment_external_idx on workforce.assignment (org_id, assignee_employee_id, status) where execution_mode = 'external';

-- the mode is never written by a caller: insert and every update re-derive it from the assignee
create or replace function workforce.assignment_mode_sync()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.execution_mode := coalesce((select case when e.employment_type = 'operator_ai' then 'external' else 'internal' end
                                    from workforce.employee e where e.employee_id = new.assignee_employee_id), 'internal');
  return new;
end
$$;
create trigger assignment_mode_sync before insert or update on workforce.assignment for each row execute function workforce.assignment_mode_sync();

create or replace function workforce.assignment_mode_event()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform workforce.emit(new.org_id, 'wf.assignment.mode_changed', new.mission_id, new.assignment_id, new.assignee_employee_id,
    jsonb_build_object('from', old.execution_mode, 'to', new.execution_mode, 'from_employee_id', old.assignee_employee_id));
  return null;
end
$$;
create trigger assignment_mode_event after update on workforce.assignment for each row
  when (old.execution_mode is distinct from new.execution_mode) execute function workforce.assignment_mode_event();

-- assignment_claim (replaced: ONE predicate added in step 2 — only internal rows are leased by dispatch;
-- external rows still get their pending → ready / cancelled dependency resolution in step 1)
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
  -- 2. lease the due ready rows (INTERNAL only: an external assignment waits for its agent)
  for r in
    select a0.assignment_id
      from workforce.assignment a0
      join workforce.mission m on m.mission_id = a0.mission_id
      join workforce.employee e on e.employee_id = a0.assignee_employee_id
     where a0.org_id = p_org and a0.status = 'ready' and (a0.next_attempt_at is null or a0.next_attempt_at <= v_now)
       and a0.execution_mode = 'internal'
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

-- assignment_resume_job (replaced: ONE branch added — a completed job hands an EXTERNAL assignment back to its
-- agent as ready with the job referenced; the agent then completes it with its evidence. Internal: unchanged)
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
  if p_job_state = 'completed' and a.execution_mode = 'external' then
    update workforce.assignment
       set status = 'ready', next_attempt_at = clock_timestamp(),
           output = coalesce(output, '{}'::jsonb) || jsonb_build_object('research', jsonb_build_object('job_id', p_runtime_job_id, 'state', 'completed',
                      'result', case when octet_length(coalesce(p_result, '{}'::jsonb)::text) <= 12000 then coalesce(p_result, '{}'::jsonb) else jsonb_build_object('withheld', 'too_large') end)),
           evidence = evidence || jsonb_build_array(jsonb_build_object('source', 'agent.research_job', 'job_id', p_runtime_job_id))
     where assignment_id = p_assignment_id returning * into a;
    perform workforce.emit_assignment(a, 'waiting_job', 'job_completed_returned_to_agent');
  elsif p_job_state = 'completed' then
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

-- internal: an EXTERNAL assignment leased by ITS employee's agent. Reaps expired leases first (the reaper's own
-- rules: attempt + 1, backoff, failed past max). Refuses: not the assignee, not external, the employee or the
-- mission not active, a dependency not completed, not due, HUMAN_OWNED (a thread under a manual override, or a
-- resource a person holds), CLAIM_HELD (another employee holds the resource). Never returns the lease token.
create or replace function workforce.assignment_claim_external(p_org uuid, p_assignment_id text, p_employee_id text, p_owner text, p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare
  a workforce.assignment%rowtype; v_now timestamptz; v_emp_status text; v_mission_status text; n_done int; v_dead text;
  v_job_state text; v_job_result jsonb; v_job_error jsonb;
begin
  if p_owner is null or p_owner !~ '^[A-Za-z0-9_.:-]{1,80}$' then raise exception 'WF_PAYLOAD_REFUSED: lease owner shape'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 15 and 3600 then raise exception 'WF_PAYLOAD_REFUSED: lease_seconds must be 15..3600'; end if;
  perform workforce.assignment_reap(p_org, clock_timestamp());
  v_now := clock_timestamp();
  select * into a from workforce.assignment where assignment_id = p_assignment_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: assignment %', p_assignment_id; end if;
  if a.assignee_employee_id <> p_employee_id then raise exception 'WF_NOT_ASSIGNEE: assignment % is assigned to another employee', p_assignment_id; end if;
  if a.execution_mode <> 'external' then raise exception 'WF_NOT_EXTERNAL: assignment % is executed by the Workforce engine', p_assignment_id; end if;
  select status into v_emp_status from workforce.employee where employee_id = p_employee_id;
  if v_emp_status is distinct from 'active' then raise exception 'WF_EMPLOYEE_NOT_ACTIVE: employee % is %', p_employee_id, v_emp_status; end if;
  select status into v_mission_status from workforce.mission where mission_id = a.mission_id;
  if v_mission_status not in ('active', 'waiting') then raise exception 'WF_MISSION_NOT_ACTIVE: mission is %', v_mission_status; end if;
  if a.status in ('leased', 'running') then
    if a.lease_owner = p_owner and a.lease_until > v_now then
      return jsonb_build_object('assignment', workforce.assignment_view(a), 'already_held', true);
    end if;
    raise exception 'WF_CLAIM_HELD: assignment % is leased by another worker until %', p_assignment_id, a.lease_until;
  end if;
  -- waiting on a research job: its TERMINAL state hands the assignment back now (the dispatcher's resume rule,
  -- workforce.assignment_resume_job) — the agent never waits for a dispatch tick; a running job is not due yet
  if a.status = 'waiting_job' then
    select j.state, j.result, j.last_error into v_job_state, v_job_result, v_job_error from agent.research_job j where j.job_id = a.runtime_job_id;
    if v_job_state is null then v_job_state := 'failed'; v_job_error := jsonb_build_object('code', 'JOB_NOT_FOUND'); end if;
    if v_job_state in ('completed', 'failed', 'dead_letter', 'cancelled') then
      perform workforce.assignment_resume_job(p_org, a.assignment_id, a.runtime_job_id, v_job_state, v_job_result,
                                              case when v_job_error is null then null else jsonb_build_object('code', left(coalesce(v_job_error ->> 'code', 'RUNTIME_JOB_ERROR'), 60)) end);
      select * into a from workforce.assignment where assignment_id = p_assignment_id for update;
      v_now := clock_timestamp();
    else
      raise exception 'WF_WAITING_ON_JOB: research job % is %', a.runtime_job_id, v_job_state;
    end if;
  end if;
  if a.status = 'pending' then
    select count(*) filter (where d.status = 'completed'), min(d.step_key) filter (where d.status in ('failed', 'cancelled')) into n_done, v_dead
      from workforce.assignment d where d.mission_id = a.mission_id and d.step_key = any (a.depends_on);
    if v_dead is not null then raise exception 'WF_DEPENDENCY_FAILED: step % failed', v_dead; end if;
    if coalesce(n_done, 0) <> cardinality(a.depends_on) then raise exception 'WF_DEPENDENCIES_PENDING: an upstream step is not completed'; end if;
    update workforce.assignment set status = 'ready' where assignment_id = a.assignment_id returning * into a;
    perform workforce.emit_assignment(a, 'pending', 'dependencies_completed');
  end if;
  -- not claimable / not due yet: an ANSWER, not an exception, so a reap or a job resume done above is kept
  if a.status <> 'ready' then return jsonb_build_object('refused', 'NOT_CLAIMABLE', 'assignment', workforce.assignment_view(a)); end if;
  if a.next_attempt_at is not null and a.next_attempt_at > v_now then return jsonb_build_object('refused', 'NOT_DUE', 'assignment', workforce.assignment_view(a)); end if;
  -- human ownership (§3): a manual override on the conversation, or a resource a person holds
  if a.resource_type = 'thread' and a.resource_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     and exists (select 1 from public.inbox_thread_state t where t.id = a.resource_key::uuid and coalesce(t.manual_override, false)) then
    raise exception 'WF_HUMAN_OWNED: a person owns this conversation (manual override)';
  end if;
  if a.resource_type is not null and exists (
       select 1 from workforce.resource_claim c join workforce.employee h on h.employee_id = c.employee_id
        where c.org_id = p_org and c.resource_type = a.resource_type and c.resource_key = a.resource_key and c.released_at is null and c.expires_at > v_now and h.kind = 'human') then
    raise exception 'WF_HUMAN_OWNED: a person holds this resource';
  end if;
  update workforce.assignment
     set status = 'leased', lease_token = gen_random_uuid(), lease_owner = p_owner, lease_until = v_now + make_interval(secs => p_lease_seconds),
         lease_seconds = p_lease_seconds, claimed_at = v_now, finished_token = null
   where assignment_id = a.assignment_id returning * into a;
  perform workforce.emit_assignment(a, 'ready', 'claimed_by_external_agent');
  -- one owner per seller / property: the resource claim (CLAIM_HELD when another employee holds it)
  if a.resource_type is not null then
    perform workforce.resource_claim_acquire(p_org, a.resource_type, a.resource_key, p_employee_id, a.assignment_id, 86400);
  end if;
  update workforce.employee set heartbeat_at = v_now, last_activity_at = v_now where employee_id = p_employee_id;
  return jsonb_build_object('assignment', workforce.assignment_view(a), 'already_held', false);
end
$$;

-- internal: the live lease of an EXTERNAL assignment held by this agent (locked row) or LEASE_LOST / NOT_ASSIGNEE
create or replace function workforce.assignment_external_lease(p_org uuid, p_assignment_id text, p_employee_id text, p_owner text)
returns workforce.assignment
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare a workforce.assignment%rowtype;
begin
  select * into a from workforce.assignment where assignment_id = p_assignment_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: assignment %', p_assignment_id; end if;
  if a.assignee_employee_id <> p_employee_id then raise exception 'WF_NOT_ASSIGNEE: assignment % is assigned to another employee', p_assignment_id; end if;
  if a.status not in ('leased', 'running') or a.lease_owner is distinct from p_owner then
    raise exception 'WF_LEASE_LOST: assignment % is % (claim it first)', p_assignment_id, a.status;
  end if;
  if a.lease_until <= clock_timestamp() then raise exception 'WF_LEASE_LOST: the lease of % expired (claim it again)', p_assignment_id; end if;
  return a;
end
$$;

-- internal: §3 handoff — the assignment moves to another employee (or back to the COO's choice). A held lease is
-- released (ready, no attempt burned), its resource claims are released, the mode is re-derived (trigger), output
-- and evidence are preserved. A recorded wf.assignment.handed_off event + a COO exec_message. Never seller-facing.
create or replace function workforce.assignment_handoff(p_org uuid, p_assignment_id text, p_from_employee_id text, p_to_employee_id text, p_lease_owner text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare
  a workforce.assignment%rowtype; v_from_status text; v_from_mode text; v_to workforce.employee%rowtype; v_from workforce.employee%rowtype; v_coo text;
begin
  select * into a from workforce.assignment where assignment_id = p_assignment_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: assignment %', p_assignment_id; end if;
  if a.assignee_employee_id <> p_from_employee_id then raise exception 'WF_NOT_ASSIGNEE: assignment % is assigned to another employee', p_assignment_id; end if;
  if a.status in ('completed', 'failed', 'cancelled') then raise exception 'WF_ILLEGAL_TRANSITION: a % assignment cannot be handed off', a.status; end if;
  if a.status = 'waiting_job' then raise exception 'WF_WAITING_ON_JOB: hand it off after its research job returns'; end if;
  if a.status in ('leased', 'running') and a.lease_owner is distinct from p_lease_owner then raise exception 'WF_CLAIM_HELD: another worker holds the lease of %', p_assignment_id; end if;
  select * into v_to from workforce.employee where employee_id = p_to_employee_id and org_id = p_org;
  if v_to.employee_id is null then raise exception 'WF_NOT_FOUND: employee %', p_to_employee_id; end if;
  if v_to.status <> 'active' then raise exception 'WF_TARGET_NOT_ACTIVE: employee % is %', p_to_employee_id, v_to.status; end if;
  if v_to.employee_id = p_from_employee_id then raise exception 'WF_CONFLICT: the assignment is already assigned to %', p_to_employee_id; end if;
  select * into v_from from workforce.employee where employee_id = p_from_employee_id;
  v_from_status := a.status;
  v_from_mode := a.execution_mode;
  if a.status in ('leased', 'running') then
    update workforce.assignment
       set status = 'ready', lease_token = null, lease_owner = null, lease_until = null, lease_seconds = null, finished_token = null, next_attempt_at = clock_timestamp()
     where assignment_id = a.assignment_id returning * into a;
    perform workforce.release_claims_of(a.assignment_id, 'released');
    perform workforce.emit_assignment(a, v_from_status, 'handed_off');
  end if;
  update workforce.assignment set assignee_employee_id = p_to_employee_id where assignment_id = a.assignment_id returning * into a;
  perform workforce.emit(p_org, 'wf.assignment.handed_off', a.mission_id, a.assignment_id, a.assignee_employee_id,
    jsonb_build_object('from_employee_id', p_from_employee_id, 'to_employee_id', p_to_employee_id, 'from_mode', v_from_mode, 'to_mode', a.execution_mode,
                       'actor_id', p_from_employee_id) || case when p_note is not null then jsonb_build_object('note', p_note) else '{}'::jsonb end);
  select employee_id into v_coo from workforce.employee where org_id = p_org and role_key = 'coo' order by employee_id limit 1;
  if v_coo is not null then
    perform workforce.exec_message_append(p_org, 'coo', null, v_coo,
      format('%s handed off the step %s to %s (%s).', v_from.display_name, a.step_key, v_to.display_name, case when a.execution_mode = 'external' then 'Agntei' else 'Workforce' end),
      jsonb_build_array(jsonb_build_object('type', 'assignment', 'id', a.assignment_id), jsonb_build_object('type', 'employee', 'id', p_from_employee_id),
                        jsonb_build_object('type', 'employee', 'id', p_to_employee_id)), a.mission_id);
  end if;
  return jsonb_build_object('assignment', workforce.assignment_view(a), 'from_mode', v_from_mode);
end
$$;

-- the COO / CEO records the external-timeout policy of an assignment (wait | reassign_internal, bounded wait)
create or replace function workforce.assignment_set_external_policy(p_org uuid, p_assignment_id text, p_policy text, p_wait_seconds integer, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare a workforce.assignment%rowtype; v_from text;
begin
  if not workforce.actor_ok(p_org, p_actor) then raise exception 'WF_FORBIDDEN: actor must be an employee of the org or a named operator'; end if;
  if p_policy is null or p_policy not in ('wait', 'reassign_internal') then raise exception 'WF_PAYLOAD_REFUSED: policy is wait or reassign_internal'; end if;
  if p_wait_seconds is not null and p_wait_seconds not between 60 and 604800 then raise exception 'WF_PAYLOAD_REFUSED: wait_seconds is 60 .. 604800'; end if;
  select * into a from workforce.assignment where assignment_id = p_assignment_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: assignment %', p_assignment_id; end if;
  if a.status in ('completed', 'failed', 'cancelled') then raise exception 'WF_ILLEGAL_TRANSITION: a % assignment takes no policy', a.status; end if;
  v_from := a.on_external_timeout;
  update workforce.assignment set on_external_timeout = p_policy, external_wait_seconds = coalesce(p_wait_seconds, external_wait_seconds)
   where assignment_id = p_assignment_id returning * into a;
  perform workforce.emit(p_org, 'wf.assignment.external_policy_set', a.mission_id, a.assignment_id, a.assignee_employee_id,
    jsonb_build_object('from', v_from, 'to', a.on_external_timeout, 'wait_seconds', a.external_wait_seconds, 'actor_id', p_actor));
  return to_jsonb(a) - 'lease_token' - 'finished_token';
end
$$;

-- ── 5. budgets (§5) ────────────────────────────────────────────────────────
create table workforce.budget (
  budget_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agent.org(org_id),
  scope text not null check (scope in ('org', 'department', 'mission', 'employee')),
  scope_key text not null check (scope_key ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  period text not null check (period in ('day', 'month')),
  cap_usd numeric(10,2) not null check (cap_usd >= 0 and cap_usd <= 1000),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revoked_by uuid,
  constraint budget_revoke_pair check ((status = 'revoked') = (revoked_at is not null) and (revoked_at is null) = (revoked_by is null)),
  constraint budget_scope_key_shape check (case scope when 'org' then scope_key = org_id::text when 'department' then scope_key in ('executive', 'finance', 'acquisitions', 'marketing', 'dispositions', 'data_intelligence', 'operations')
                                               when 'mission' then scope_key ~ '^wfm_[0-9a-f-]{36}$' else scope_key ~ '^emp_[a-z0-9_]{3,40}$' end)
);
create unique index budget_one_active_uq on workforce.budget (org_id, scope, scope_key, period) where status = 'active';
create trigger budget_guard before insert or update or delete on workforce.budget for each row execute function workforce.write_path_guard();
comment on table workforce.budget is 'Workforce budgets (docs/WORKFORCE-AGNTEI.md §5): org / department / mission / employee × day / month caps, CEO-authored. The spend is agent.spend_ledger (reserve / settle) of the runtime jobs Workforce assignments wait on; the authority engine reads workforce.budget_status before paid work.';

create or replace function workforce.budget_put(p_org uuid, p_budget jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare b workforce.budget%rowtype; v_now timestamptz := clock_timestamp();
begin
  if not workforce.is_owner(p_org, p_actor) then raise exception 'WF_FORBIDDEN: budgets are CEO-authored'; end if;
  if p_budget is null or jsonb_typeof(p_budget) <> 'object' or exists (select 1 from jsonb_object_keys(p_budget) k where k not in ('scope', 'scope_key', 'period', 'cap_usd')) then
    raise exception 'WF_PAYLOAD_REFUSED: budget keys are scope, scope_key, period, cap_usd';
  end if;
  update workforce.budget set status = 'revoked', revoked_at = v_now, revoked_by = p_actor
   where org_id = p_org and scope = p_budget ->> 'scope' and scope_key = p_budget ->> 'scope_key' and period = p_budget ->> 'period' and status = 'active';
  insert into workforce.budget (org_id, scope, scope_key, period, cap_usd, created_by)
  values (p_org, p_budget ->> 'scope', p_budget ->> 'scope_key', p_budget ->> 'period', (p_budget ->> 'cap_usd')::numeric, p_actor)
  returning * into b;
  perform workforce.emit(p_org, 'wf.budget.put', null, null, null, jsonb_build_object('budget_id', b.budget_id, 'scope', b.scope, 'period', b.period, 'cap_usd', b.cap_usd));
  return to_jsonb(b);
end
$$;

create or replace function workforce.budget_revoke(p_org uuid, p_budget_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare b workforce.budget%rowtype;
begin
  if not workforce.is_owner(p_org, p_actor) then raise exception 'WF_FORBIDDEN: budgets are CEO-authored'; end if;
  select * into b from workforce.budget where budget_id = p_budget_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: budget %', p_budget_id; end if;
  if b.status = 'revoked' then return to_jsonb(b); end if;
  update workforce.budget set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_actor where budget_id = p_budget_id returning * into b;
  perform workforce.emit(p_org, 'wf.budget.revoked', null, null, null, jsonb_build_object('budget_id', b.budget_id));
  return to_jsonb(b);
end
$$;

-- the active budgets that apply to (employee, mission) with their committed spend in the current window
create or replace function workforce.budget_status(p_org uuid, p_employee_id text, p_mission_id text, p_now timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, workforce, agent
as $$
  with e as (select department_key from workforce.employee where employee_id = p_employee_id and org_id = p_org),
       b as (select * from workforce.budget b
              where b.org_id = p_org and b.status = 'active'
                and (b.scope = 'org' or (b.scope = 'department' and b.scope_key = (select department_key from e))
                     or (b.scope = 'mission' and b.scope_key = p_mission_id) or (b.scope = 'employee' and b.scope_key = p_employee_id)))
  select coalesce(jsonb_agg(jsonb_build_object('budget_id', b.budget_id, 'scope', b.scope, 'scope_id', b.scope_key, 'period', b.period, 'cap_usd', b.cap_usd,
           'spent_usd', (select coalesce(sum(agent.spend_committed(l.state, l.reserved_usd, l.actual_usd)), 0)
                           from agent.spend_ledger l
                          where l.job_id is not null
                            and l.created_at >= date_trunc(b.period, coalesce(p_now, clock_timestamp()))
                            and l.job_id in (select a.runtime_job_id from workforce.assignment a join workforce.employee x on x.employee_id = a.assignee_employee_id
                                              where a.org_id = p_org and a.runtime_job_id is not null
                                                and case b.scope when 'org' then true when 'department' then x.department_key = b.scope_key
                                                                 when 'mission' then a.mission_id = b.scope_key else a.assignee_employee_id = b.scope_key end)))
           order by b.scope, b.period), '[]'::jsonb)
    from b
$$;

-- the per-employee action history the dashboard shows: the gateway audit of the employee's bound principal
-- (codes and ids only; append-only rows of action_gateway.action_audit_events)
create or replace function workforce.employee_gateway_audit(p_org uuid, p_employee_id text, p_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, workforce, action_gateway
as $$
  select coalesce(jsonb_agg(x order by x.event_id desc), '[]'::jsonb) from (
    select ev.event_id, ev.at, ev.event_type, ev.action, ev.capability, ev.tier, ev.code, ev.intent_id
      from workforce.employee e
      join action_gateway.action_audit_events ev on ev.org_id = e.org_id and ev.agent_id = e.action_principal_id
     where e.org_id = p_org and e.employee_id = p_employee_id and e.action_principal_id is not null
     order by ev.event_id desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200)) x
$$;

-- ── 6. the gateway side (§2): reads + ONE domain writer ────────────────────
-- the principal of a presented credential digest in the request tenant (active, unexpired, sponsor a member) or null
create or replace function action_gateway.wf_principal(p_digest text)
returns action_gateway.agent_principals
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select p.* from action_gateway.agent_principals p
   where p_digest ~ '^[0-9a-f]{64}$' and p.credential_digest = p_digest and p.org_id = action_gateway.request_org()
     and p.status = 'active' and p.credential_expires_at > now()
     and exists (select 1 from agent.operator_membership m where m.org_id = p.org_id and m.user_id = p.sponsor_user_id)
$$;

-- an assignment summary for the agent (its own rows carry input / output / evidence; a peer row does not)
create or replace function action_gateway.wf_assignment_json(a workforce.assignment, p_full boolean)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select case when a.assignment_id is null then null
    when p_full then workforce.assignment_view(a) || jsonb_build_object('mission_title', (select m.title from workforce.mission m where m.mission_id = a.mission_id))
    else jsonb_build_object('assignment_id', a.assignment_id, 'mission_id', a.mission_id, 'step_key', a.step_key, 'capability_key', a.capability_key, 'status', a.status,
                            'execution_mode', a.execution_mode, 'assignee_employee_id', a.assignee_employee_id, 'outcome_class', a.outcome_class, 'updated_at', a.updated_at) end
$$;

-- THE principal-bound read: the presented digest selects the principal; kills + a live grant re-checked
create or replace function public.action_gateway_workforce_read(p_credential_digest text, p_kind text, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  pr action_gateway.agent_principals%rowtype; e workforce.employee%rowtype; a workforce.assignment%rowtype; m workforce.mission%rowtype;
  v_cap text; v_code text; v_now timestamptz := clock_timestamp(); v_out jsonb; v_lim int;
begin
  if action_gateway.request_org() is null then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_NO_TENANT'; end if;
  pr := action_gateway.wf_principal(p_credential_digest);
  if pr.agent_id is null then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_PRINCIPAL_INACTIVE'; end if;
  v_cap := case p_kind when 'whoami' then 'workforce.whoami' when 'assignments' then 'workforce.list_assignments' when 'mission' then 'workforce.get_mission'
                       when 'context' then p ->> 'capability' else null end;
  if v_cap is null or v_cap !~ '^workforce\.[a-z_]{3,40}$' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_GRANT_INVALID: unknown workforce read'; end if;
  v_code := action_gateway.control_refusal(v_cap, 1::smallint);
  if v_code is not null then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_' || v_code; end if;
  if not exists (select 1 from action_gateway.capability_grants g where g.org_id = pr.org_id and g.agent_id = pr.agent_id and g.capability = v_cap and g.max_tier >= 1
                   and g.revoked_at is null and g.suspended_at is null and g.valid_from <= now() and g.expires_at > now()) then
    raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_GRANT_INVALID: no live grant for ' || v_cap;
  end if;
  select * into e from workforce.employee where org_id = pr.org_id and action_principal_id = pr.agent_id;
  if e.employee_id is null then return jsonb_build_object('registered', false, 'agent_id', pr.agent_id); end if;
  -- the operator-authorized binding (BINDING_REVOKED / BINDING_EXPIRED refuse every read; the policy context answers with it)
  v_code := workforce.binding_refusal(e);
  if v_code is not null and p_kind <> 'context' then raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_' || v_code; end if;
  case p_kind
    when 'whoami' then
      return jsonb_build_object('registered', true, 'agent_id', pr.agent_id, 'tier_ceiling', pr.tier_ceiling,
        'employee', to_jsonb(e) - 'created_by' - 'user_id' - 'segments',
        'manager', (select jsonb_build_object('employee_id', x.employee_id, 'display_name', x.display_name, 'role_key', x.role_key) from workforce.employee x where x.employee_id = e.manager_employee_id),
        'open_assignments', (select coalesce(jsonb_agg(action_gateway.wf_assignment_json(x, true) order by x.created_at, x.assignment_id), '[]'::jsonb) from workforce.assignment x
                              where x.org_id = e.org_id and x.assignee_employee_id = e.employee_id and x.status in ('pending', 'ready', 'leased', 'running', 'waiting_job', 'waiting_approval', 'blocked')));
    when 'assignments' then
      v_lim := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 100);
      v_out := jsonb_build_object('registered', true, 'employee_id', e.employee_id,
        'assignments', (select coalesce(jsonb_agg(action_gateway.wf_assignment_json(x, true) order by x.updated_at desc, x.assignment_id), '[]'::jsonb) from (
            select * from workforce.assignment x where x.org_id = e.org_id and x.assignee_employee_id = e.employee_id
               and (p ->> 'status' is null or x.status = p ->> 'status') and (p ->> 'mission_id' is null or x.mission_id = p ->> 'mission_id')
               and (p ->> 'assignment_id' is null or x.assignment_id = p ->> 'assignment_id')
             order by x.updated_at desc, x.assignment_id limit v_lim) x));
      if coalesce((p ->> 'include_mission_peers')::boolean, false) then
        v_out := v_out || jsonb_build_object('mission_peers', (select coalesce(jsonb_agg(action_gateway.wf_assignment_json(x, false) order by x.mission_id, x.step_key), '[]'::jsonb) from (
            select * from workforce.assignment x where x.org_id = e.org_id and x.assignee_employee_id <> e.employee_id
               and x.mission_id in (select y.mission_id from workforce.assignment y where y.org_id = e.org_id and y.assignee_employee_id = e.employee_id)
               and (p ->> 'mission_id' is null or x.mission_id = p ->> 'mission_id')
             order by x.mission_id, x.step_key limit 200) x));
      end if;
      return v_out;
    when 'mission' then
      select * into m from workforce.mission where mission_id = p ->> 'mission_id' and org_id = e.org_id;
      if m.mission_id is null or not (m.requested_by = pr.sponsor_user_id
           or exists (select 1 from workforce.assignment y where y.mission_id = m.mission_id and y.assignee_employee_id = e.employee_id)) then
        return jsonb_build_object('registered', true, 'found', false);
      end if;
      return jsonb_build_object('registered', true, 'found', true,
        'visible_because', case when exists (select 1 from workforce.assignment y where y.mission_id = m.mission_id and y.assignee_employee_id = e.employee_id) then 'participant' else 'sponsor_requested' end,
        'mission', to_jsonb(m) - 'idempotency_key',
        'assignments', (select coalesce(jsonb_agg(action_gateway.wf_assignment_json(x, x.assignee_employee_id = e.employee_id) order by x.created_at, x.assignment_id), '[]'::jsonb)
                          from workforce.assignment x where x.mission_id = m.mission_id));
    when 'context' then
      if p ->> 'assignment_id' is not null then
        select * into a from workforce.assignment where assignment_id = p ->> 'assignment_id' and org_id = e.org_id;
        if a.assignment_id is not null then select * into m from workforce.mission where mission_id = a.mission_id; end if;
      end if;
      return jsonb_build_object('registered', true, 'now', v_now, 'agent_id', pr.agent_id, 'sponsor_user_id', pr.sponsor_user_id, 'binding_refusal', v_code,
        'employee', to_jsonb(e) - 'created_by' - 'segments',
        'assignment', workforce.assignment_view(a),
        'mission', case when m.mission_id is null then null else to_jsonb(m) - 'idempotency_key' - 'plan' - 'report' end,
        'mission_assignments', (select coalesce(jsonb_agg(jsonb_build_object('assignment_id', x.assignment_id, 'step_key', x.step_key, 'capability_key', x.capability_key,
                                   'status', x.status, 'outcome_class', x.outcome_class, 'input', x.input, 'output', x.output, 'runtime_job_id', x.runtime_job_id,
                                   'assignee_employee_id', x.assignee_employee_id) order by x.created_at, x.assignment_id), '[]'::jsonb)
                                  from workforce.assignment x where m.mission_id is not null and x.mission_id = m.mission_id),
        'employee_assignments', (select coalesce(jsonb_agg(jsonb_build_object('assignment_id', x.assignment_id, 'capability_key', x.capability_key, 'status', x.status, 'created_at', x.created_at)), '[]'::jsonb)
                                   from workforce.assignment x where x.org_id = e.org_id and x.assignee_employee_id = e.employee_id and x.created_at >= date_trunc('day', v_now)),
        'policies', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from workforce.authority_policy x where x.org_id = e.org_id and x.status = 'active'),
        'settings', (select to_jsonb(s) from workforce.settings s where s.org_id = e.org_id),
        'emergency_stop', coalesce((select l.emergency_stop from agent.runtime_limits l where l.id = 1), true),
        'budgets', workforce.budget_status(e.org_id, e.employee_id, m.mission_id, v_now),
        'roster', (select coalesce(jsonb_agg(jsonb_build_object('employee_id', x.employee_id, 'role_key', x.role_key, 'kind', x.kind, 'employment_type', x.employment_type,
                     'status', x.status, 'markets', to_jsonb(x.markets), 'display_name', x.display_name,
                     'open_assignments', (select count(*) from workforce.assignment y where y.assignee_employee_id = x.employee_id and y.status in ('pending', 'ready', 'leased', 'running', 'waiting_job', 'waiting_approval', 'blocked')))
                     order by x.employee_id), '[]'::jsonb) from workforce.employee x where x.org_id = e.org_id and x.status = 'active'));
    else
      raise exception using errcode = 'P0001', message = 'ACTION_GATEWAY_GRANT_INVALID: unknown workforce read';
  end case;
end
$fn$;

-- evidence resolution for a verified completion (§2): a ref resolves when it is
--   job       a COMPLETED runtime job of this mission (an assignment of the mission waits / waited on it), or one
--             this principal enqueued through a succeeded gateway intent;
--   intent    a SUCCEEDED gateway intent of this principal (not a Workforce bookkeeping action; a research
--             intent counts once its job completed);
--   thread / property / opportunity   a canonical record this principal read through a logged gateway tool
--             call (an action_read / context_read audit event naming it).
create or replace function action_gateway.wf_resolve_evidence(p_org uuid, p_agent text, p_mission text, p_refs jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare r jsonb; t text; v_id text; ok boolean; via text; v_out jsonb := '[]'::jsonb; n int := 0; ai action_gateway.action_intents%rowtype; v_job text; v_state text;
begin
  for r in select value from jsonb_array_elements(coalesce(p_refs, '[]'::jsonb)) limit 20 loop
    t := r ->> 'type'; v_id := r ->> 'id'; ok := false; via := null;
    if t = 'job' and v_id ~ '^mjob_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select j.state into v_state from agent.research_job j where j.job_id = v_id;
      if v_state = 'completed' then
        if exists (select 1 from workforce.assignment x where x.org_id = p_org and x.mission_id = p_mission and x.runtime_job_id = v_id) then ok := true; via := 'mission_job';
        elsif exists (select 1 from agent.research_job j join action_gateway.action_intents i on i.intent_id::text = j.input ->> 'action_intent_id'
                       where j.job_id = v_id and i.org_id = p_org and i.agent_id = p_agent and i.state = 'succeeded') then ok := true; via := 'principal_job';
        end if;
      end if;
    elsif t = 'intent' and v_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into ai from action_gateway.action_intents i where i.intent_id = v_id::uuid and i.org_id = p_org and i.agent_id = p_agent and i.state = 'succeeded'
         and i.action not in ('workforce_link_self', 'workforce_open_mission', 'workforce_claim_assignment', 'workforce_report_progress', 'workforce_complete_assignment', 'workforce_handoff', 'workforce_escalate');
      if ai.intent_id is not null then
        if ai.action in ('create_research_job', 'request_property_valuation', 'workforce_request_research') then
          select o.result ->> 'job_id' into v_job from action_gateway.action_outcomes o where o.intent_id = ai.intent_id;
          if exists (select 1 from agent.research_job j where j.job_id = v_job and j.state = 'completed') then ok := true; via := 'principal_intent_job'; end if;
        else
          ok := true; via := 'principal_intent';
        end if;
      end if;
    elsif t in ('thread', 'property', 'opportunity') and v_id ~ '^[A-Za-z0-9_.:-]{1,80}$' then
      if exists (select 1 from action_gateway.action_audit_events ev where ev.org_id = p_org and ev.agent_id = p_agent and ev.event_type in ('action_read', 'context_read')
                   and ev.at > clock_timestamp() - interval '30 days' and ev.detail -> 'record_refs' @> jsonb_build_array(jsonb_build_object('type', t, 'id', v_id))) then
        ok := true; via := 'logged_read';
      end if;
    end if;
    if ok then n := n + 1; end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('type', t, 'id', v_id, 'resolved', ok, 'via', via, 'source', 'agntei')
                                        || case when r ? 'note' then jsonb_build_object('note', r ->> 'note') else '{}'::jsonb end);
  end loop;
  return jsonb_build_object('refs', v_out, 'resolved', n, 'total', jsonb_array_length(v_out));
end
$fn$;

-- an identity anomaly (§1 step 4): recorded against the intent's grant and every live Workforce grant of the
-- principal is SUSPENDED (only an owner reinstates); the refusal is the intent's outcome
create or replace function action_gateway.wf_identity_anomaly(p_intent action_gateway.action_intents, p_employee_id text, p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare g uuid; n int := 0;
begin
  perform action_gateway.grant_note_failure(p_intent.intent_id, p_code);
  for g in select c.grant_id from action_gateway.capability_grants c where c.org_id = p_intent.org_id and c.agent_id = p_intent.agent_id
              and c.capability like 'workforce.%' and c.revoked_at is null and c.suspended_at is null loop
    perform action_gateway.grant_suspend(g, 'ANOMALY_IDENTITY_MISMATCH');
    n := n + 1;
  end loop;
  if p_employee_id is not null then
    perform workforce.emit(p_intent.org_id, 'wf.employee.identity_refused', null, null, p_employee_id, jsonb_build_object('code', p_code, 'agent_id', p_intent.agent_id, 'grants_suspended', n));
  end if;
  return action_gateway.finish_intent(p_intent.intent_id, 'refused', p_code, jsonb_build_object('stage', 'domain_write', 'grants_suspended', n));
end
$fn$;

-- THE lease-bound domain writer of the Workforce actions. Parameters come FROM the authorized intent; the acting
-- employee is the one bound to the intent's (authenticated) agent. A Workforce refusal (WF_<CODE>) is a REFUSED
-- outcome with that code in the same transaction; anything unexpected is FAILED (counted against the grant).
create or replace function public.action_gateway_dw_workforce(p_intent_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $fn$
declare
  b jsonb; i action_gateway.action_intents%rowtype; p jsonb; e workforce.employee%rowtype; v_sponsor uuid; v_owner text; r jsonb; a workforce.assignment%rowtype;
  v_code text; v_ev jsonb; v_outcome text; v_req text; v_coo text; v_ceo text; v_key text; v_mid text; v_job jsonb; v_pref text; v_prop text; v_input jsonb;
begin
  b := action_gateway.dw_begin(p_intent_id, p_lease_token, array['workforce_link_self', 'workforce_open_mission', 'workforce_claim_assignment', 'workforce_report_progress',
                                                                   'workforce_complete_assignment', 'workforce_request_research', 'workforce_handoff', 'workforce_escalate']);
  if b ? 'refused' then return b -> 'outcome'; end if;
  i := jsonb_populate_record(null::action_gateway.action_intents, b -> 'intent');
  v_sponsor := (b ->> 'sponsor_user_id')::uuid;
  p := i.params;
  v_owner := 'gw:' || i.agent_id;
  begin
    -- the employee IS the authenticated principal's (never a tool argument). FOR NO KEY UPDATE, not FOR UPDATE: it still
    -- serializes this principal's writes, but never blocks a foreign-key check (KEY SHARE) of an event or resource claim
    -- naming the employee — the Workforce dispatch pass locks assignments FIRST and then writes those, so FOR UPDATE here
    -- deadlocked a claim against it (40P01, found by the milestone E2E; tests/critical/workforce-agntei-lock-order-pg)
    select * into e from workforce.employee where org_id = i.org_id and action_principal_id = i.agent_id for no key update;
    if e.employee_id is null then return action_gateway.finish_intent(i.intent_id, 'refused', 'NOT_REGISTERED', jsonb_build_object('stage', 'domain_write')); end if;
    -- the operator-authorized, expiring binding: refused (audited by finish_intent) and the principal's open external leases released
    v_code := workforce.binding_refusal(e);
    if v_code is not null then
      if v_code in ('BINDING_EXPIRED', 'BINDING_REVOKED') then perform workforce.release_external_leases(i.org_id, e.employee_id, clock_timestamp()); end if;
      return action_gateway.finish_intent(i.intent_id, 'refused', v_code, jsonb_build_object('stage', 'binding'));
    end if;

    if i.action = 'workforce_link_self' then
      if e.status = 'retired' then return action_gateway.finish_intent(i.intent_id, 'refused', 'EMPLOYEE_RETIRED', '{}'::jsonb); end if;
      if e.external_agent_id is not null then
        if e.external_install_id = p ->> 'external_install_id' and e.external_agent_id = p ->> 'external_agent_id' then
          return action_gateway.finish_intent(i.intent_id, 'succeeded', 'ALREADY_LINKED', jsonb_build_object('employee_id', e.employee_id, 'status', e.status, 'linked', true, 'changed', false));
        end if;
        return action_gateway.wf_identity_anomaly(i, e.employee_id, 'IDENTITY_MISMATCH');
      end if;
      if exists (select 1 from workforce.employee x where x.org_id = i.org_id and x.external_system = 'agntei' and x.external_install_id = p ->> 'external_install_id'
                   and x.external_agent_id = p ->> 'external_agent_id') then
        return action_gateway.wf_identity_anomaly(i, e.employee_id, 'EXTERNAL_REF_ALREADY_LINKED');
      end if;
      -- the first link happens only inside the owner's link window
      if e.link_expires_at is null or e.link_expires_at <= clock_timestamp() then
        return action_gateway.finish_intent(i.intent_id, 'refused', 'LINK_WINDOW_CLOSED', jsonb_build_object('link_expires_at', e.link_expires_at));
      end if;
      r := workforce.employee_link_external(i.org_id, e.employee_id, p ->> 'external_install_id', p ->> 'external_agent_id');
      return action_gateway.finish_intent(i.intent_id, 'succeeded', 'LINKED', jsonb_build_object('employee_id', e.employee_id, 'status', r ->> 'status', 'linked', true, 'changed', true));
    end if;

    -- every other action: a linked, active employee
    if e.status <> 'active' or e.external_agent_id is null then
      return action_gateway.finish_intent(i.intent_id, 'refused', case when e.external_agent_id is null then 'NOT_LINKED' else 'EMPLOYEE_NOT_ACTIVE' end, jsonb_build_object('status', e.status));
    end if;

    case i.action
      when 'workforce_open_mission' then
        if coalesce((select l.emergency_stop from agent.runtime_limits l where l.id = 1), true) then
          return action_gateway.finish_intent(i.intent_id, 'refused', 'EMERGENCY_STOP', '{}'::jsonb);
        end if;
        select employee_id into v_coo from workforce.employee where org_id = i.org_id and role_key = 'coo' and status = 'active' order by employee_id limit 1;
        if v_coo is null then return action_gateway.finish_intent(i.intent_id, 'refused', 'COO_UNAVAILABLE', '{}'::jsonb); end if;
        -- requested_by = the principal's sponsor (a named human); one intent = one mission (a replay returns it)
        v_key := encode(sha256(convert_to('workforce.mission' || chr(31) || v_sponsor::text || chr(31) || 'agntei:' || i.intent_id::text, 'UTF8')), 'hex');
        r := workforce.mission_open(i.org_id, p ->> 'title', p ->> 'directive', v_sponsor, v_coo, 50, null, v_key);
        v_mid := r -> 'mission' ->> 'mission_id';
        if coalesce((r ->> 'created')::boolean, false) then
          update workforce.mission set origin = 'agntei' where mission_id = v_mid;
          perform workforce.emit(i.org_id, 'wf.mission.relayed', v_mid, null, e.employee_id, jsonb_build_object('via', 'agntei', 'agent_id', i.agent_id, 'intent_id', i.intent_id));
        end if;
        if r -> 'mission' ->> 'status' = 'planning' then
          v_job := agent.runtime_enqueue('workforce.coo_plan', encode(sha256(convert_to('workforce' || chr(31) || 'workforce.coo_plan' || chr(31) || v_mid, 'UTF8')), 'hex'),
                     jsonb_build_object('mission_id', v_mid) || case when coalesce((p ->> 'assign_to_self')::boolean, false) then jsonb_build_object('assign_first_to', e.employee_id) else '{}'::jsonb end,
                     v_sponsor::text, 90, 3, 0, false, null);
          if not coalesce((v_job ->> 'ok')::boolean, false) then
            perform workforce.emit(i.org_id, 'wf.mission.plan_enqueue_failed', v_mid, null, null, jsonb_build_object('reason', left(coalesce(v_job ->> 'reason', 'runtime_refused'), 60)));
          end if;
        end if;
        return action_gateway.finish_intent(i.intent_id, 'succeeded', 'MISSION_OPENED',
          jsonb_build_object('mission_id', v_mid, 'created', coalesce((r ->> 'created')::boolean, false), 'origin', 'agntei', 'owner_employee_id', v_coo,
                             'plan_job_id', v_job ->> 'job_id', 'plan_enqueued', coalesce((v_job ->> 'ok')::boolean, false)));

      when 'workforce_claim_assignment' then
        r := workforce.assignment_claim_external(i.org_id, p ->> 'assignment_id', e.employee_id, v_owner, coalesce((p ->> 'lease_seconds')::int, 900));
        -- a lease never outlives the binding: at expiry it is reapable like any other
        if not (r ? 'refused') then
          update workforce.assignment x set lease_until = least(x.lease_until, e.binding_valid_until)
           where x.assignment_id = r -> 'assignment' ->> 'assignment_id' and x.status in ('leased', 'running') and x.lease_until > e.binding_valid_until
          returning workforce.assignment_view(x) into v_input;
          if v_input is not null then r := jsonb_set(r, '{assignment}', v_input); end if;
        end if;
        if r ? 'refused' then
          return action_gateway.finish_intent(i.intent_id, 'refused', r ->> 'refused',
            jsonb_build_object('assignment_id', r -> 'assignment' ->> 'assignment_id', 'status', r -> 'assignment' ->> 'status', 'next_attempt_at', r -> 'assignment' ->> 'next_attempt_at',
                               'attempt', (r -> 'assignment' ->> 'attempt')::int));
        end if;
        return action_gateway.finish_intent(i.intent_id, 'succeeded', case when (r ->> 'already_held')::boolean then 'ALREADY_HELD' else 'CLAIMED' end,
          jsonb_build_object('assignment_id', r -> 'assignment' ->> 'assignment_id', 'mission_id', r -> 'assignment' ->> 'mission_id', 'status', r -> 'assignment' ->> 'status',
                             'lease_until', r -> 'assignment' ->> 'lease_until', 'attempt', (r -> 'assignment' ->> 'attempt')::int, 'execution_mode', r -> 'assignment' ->> 'execution_mode',
                             -- the lease generation to pass to report / complete / research, by its own name: the gateway envelope also carries an
                             -- `attempt` (the intent's), and a live model passed that one (LEASE_LOST); this field is unambiguous
                             'claim_attempt', (r -> 'assignment' ->> 'attempt')::int));

      when 'workforce_report_progress' then
        a := workforce.assignment_external_lease(i.org_id, p ->> 'assignment_id', e.employee_id, v_owner);
        -- the lease GENERATION this call acts under (a reaped lease bumps the attempt: a late call is LEASE_LOST, its output never applied)
        if (p ->> 'claim_attempt')::int is distinct from a.attempt then return action_gateway.finish_intent(i.intent_id, 'refused', 'LEASE_LOST', jsonb_build_object('stage', 'lease_generation', 'attempt', a.attempt)); end if;
        r := workforce.assignment_progress(i.org_id, a.assignment_id, a.lease_token,
               jsonb_build_object('status', 'running') || case when p ? 'output' then jsonb_build_object('output', p -> 'output') else '{}'::jsonb end
                 || case when jsonb_array_length(coalesce(p -> 'evidence', '[]'::jsonb)) > 0 then jsonb_build_object('evidence', p -> 'evidence') else '{}'::jsonb end);
        update workforce.assignment set lease_until = least(lease_until, e.binding_valid_until) where assignment_id = a.assignment_id and lease_until > e.binding_valid_until;
        perform workforce.employee_heartbeat(i.org_id, e.employee_id, null);
        return action_gateway.finish_intent(i.intent_id, 'succeeded', 'PROGRESS_RECORDED',
          jsonb_build_object('assignment_id', a.assignment_id, 'status', r ->> 'status', 'lease_until', r ->> 'lease_until'));

      when 'workforce_complete_assignment' then
        a := workforce.assignment_external_lease(i.org_id, p ->> 'assignment_id', e.employee_id, v_owner);
        if (p ->> 'claim_attempt')::int is distinct from a.attempt then return action_gateway.finish_intent(i.intent_id, 'refused', 'LEASE_LOST', jsonb_build_object('stage', 'lease_generation', 'attempt', a.attempt)); end if;
        v_ev := action_gateway.wf_resolve_evidence(i.org_id, i.agent_id, a.mission_id, p -> 'evidence');
        v_req := coalesce(p ->> 'outcome_class', 'verified');
        -- verified needs >= 1 RESOLVED ref; otherwise partial (with output) / unknown, never verified
        v_outcome := case when v_req = 'verified' and (v_ev ->> 'resolved')::int > 0 then 'verified'
                          when v_req in ('verified', 'partial') and coalesce(p -> 'output', '{}'::jsonb) <> '{}'::jsonb then 'partial'
                          else 'unknown' end;
        r := workforce.assignment_finish(i.org_id, a.assignment_id, a.lease_token, 'completed', coalesce(p -> 'output', '{}'::jsonb), v_outcome, v_ev -> 'refs', null, null);
        perform workforce.employee_heartbeat(i.org_id, e.employee_id, null);
        return action_gateway.finish_intent(i.intent_id, 'succeeded', 'ASSIGNMENT_COMPLETED',
          jsonb_build_object('assignment_id', a.assignment_id, 'status', r ->> 'status', 'outcome_class', v_outcome, 'requested_outcome', v_req,
                             'evidence_resolved', (v_ev ->> 'resolved')::int, 'evidence_total', (v_ev ->> 'total')::int));

      when 'workforce_request_research' then
        a := workforce.assignment_external_lease(i.org_id, p ->> 'assignment_id', e.employee_id, v_owner);
        if (p ->> 'claim_attempt')::int is distinct from a.attempt then return action_gateway.finish_intent(i.intent_id, 'refused', 'LEASE_LOST', jsonb_build_object('stage', 'lease_generation', 'attempt', a.attempt)); end if;
        v_pref := coalesce(case when a.resource_type = 'property' then a.resource_key end, p ->> 'property_ref', a.input ->> 'property_ref');
        -- a property ref is its pid_ encoding (a numeric id) or the opaque id itself (letters + digits, no phone-shaped run): the SAME
        -- rule as encodePropertyRef / the Workforce PROPERTY_ID (an alphanumeric id was refused here only, found by the live milestone)
        if v_pref is null or not (v_pref ~ '^pid_[g-p]{1,20}$' or (v_pref ~ '^[A-Za-z0-9_-]{1,64}$' and v_pref ~ '[A-Za-z]' and v_pref !~ '[0-9]{7,}')) then
          return action_gateway.finish_intent(i.intent_id, 'refused', 'PROPERTY_REQUIRED', '{}'::jsonb);
        end if;
        v_prop := case when v_pref ~ '^pid_[g-p]{1,20}$' then translate(substr(v_pref, 5), 'ghijklmnop', '0123456789') else v_pref end;
        v_code := action_gateway.t2_never_revive(null, v_prop, null);
        if v_code is not null then return action_gateway.finish_intent(i.intent_id, 'refused', v_code, jsonb_build_object('stage', 'domain_write')); end if;
        -- the SAME job identity as the in-process research.property capability: ONE job per mission × property, so a retry after a
        -- crash (or a reassignment to the engine) returns that job, never a second one
        v_job := agent.runtime_enqueue('property.research', encode(sha256(convert_to('workforce' || chr(31) || 'property.research' || chr(31) || a.mission_id || chr(31) || v_pref, 'UTF8')), 'hex'),
                   jsonb_build_object('property_ref', v_pref, 'trigger', 'valuation_stale_or_missing', 'web', false), v_sponsor::text, 120, 3,
                   least(greatest(coalesce((p ->> 'budget_usd')::numeric, 0), 0), 2.5), false, null);
        if not coalesce((v_job ->> 'ok')::boolean, false) then
          return action_gateway.finish_intent(i.intent_id, 'refused', upper(left(coalesce(v_job ->> 'reason', 'ENQUEUE_REFUSED'), 60)), '{}'::jsonb);
        end if;
        perform workforce.assignment_progress(i.org_id, a.assignment_id, a.lease_token,
                  jsonb_build_object('output', jsonb_build_object('research', jsonb_build_object('job_id', v_job ->> 'job_id', 'state', 'requested', 'deduped', coalesce((v_job ->> 'deduped')::boolean, false)))));
        r := workforce.assignment_wait_job(i.org_id, a.assignment_id, a.lease_token, v_job ->> 'job_id');
        perform workforce.employee_heartbeat(i.org_id, e.employee_id, null);
        return action_gateway.finish_intent(i.intent_id, 'succeeded', 'RESEARCH_REQUESTED',
          jsonb_build_object('assignment_id', a.assignment_id, 'job_id', v_job ->> 'job_id', 'deduped', coalesce((v_job ->> 'deduped')::boolean, false), 'status', r ->> 'status',
                             'runtime_kind', 'property.research'));

      when 'workforce_handoff' then
        r := workforce.assignment_handoff(i.org_id, p ->> 'assignment_id', e.employee_id, p ->> 'to_employee_id', v_owner, p ->> 'note');
        return action_gateway.finish_intent(i.intent_id, 'succeeded', 'HANDED_OFF',
          jsonb_build_object('assignment_id', r -> 'assignment' ->> 'assignment_id', 'to_employee_id', r -> 'assignment' ->> 'assignee_employee_id',
                             'status', r -> 'assignment' ->> 'status', 'from_mode', r ->> 'from_mode', 'execution_mode', r -> 'assignment' ->> 'execution_mode'));

      when 'workforce_escalate' then
        select * into a from workforce.assignment where assignment_id = p ->> 'assignment_id' and org_id = i.org_id for update;
        if a.assignment_id is null then return action_gateway.finish_intent(i.intent_id, 'refused', 'NOT_FOUND', '{}'::jsonb); end if;
        if a.assignee_employee_id <> e.employee_id then return action_gateway.finish_intent(i.intent_id, 'refused', 'NOT_ASSIGNEE', '{}'::jsonb); end if;
        select employee_id into v_ceo from workforce.employee where org_id = i.org_id and role_key = 'ceo';
        if v_ceo is null then return action_gateway.finish_intent(i.intent_id, 'refused', 'CEO_UNAVAILABLE', '{}'::jsonb); end if;
        v_input := jsonb_build_object('follow_on', true, 'task', 'escalation', 'reasons', coalesce(p -> 'reasons', '[]'::jsonb), 'escalated_step', a.step_key, 'capability', a.capability_key,
                                      'property_ref', a.input -> 'property_ref', 'opportunity_id', a.input -> 'opportunity_id', 'conversation_id', a.input -> 'conversation_id', 'source', 'agntei')
                   || case when p ? 'note' then jsonb_build_object('note', p ->> 'note') else '{}'::jsonb end;
        -- the SAME CEO queue item shape as the in-process authority escalation (one item per escalated step)
        r := workforce.assignment_create(i.org_id, a.mission_id, left(a.step_key, 76) || '.esc', 'work.assign', v_ceo, e.employee_id, '{}'::text[], v_input, null, null, 1, a.assignment_id);
        perform workforce.emit(i.org_id, 'wf.assignment.escalated', a.mission_id, a.assignment_id, e.employee_id,
          jsonb_build_object('reasons', coalesce(p -> 'reasons', '[]'::jsonb), 'escalation_assignment_id', r -> 'assignment' ->> 'assignment_id', 'via', 'agntei'));
        return action_gateway.finish_intent(i.intent_id, 'succeeded', 'ESCALATED',
          jsonb_build_object('assignment_id', a.assignment_id, 'escalation_assignment_id', r -> 'assignment' ->> 'assignment_id', 'created', coalesce((r ->> 'created')::boolean, false)));
      else
        return action_gateway.finish_intent(i.intent_id, 'refused', 'WRONG_EXECUTOR', '{}'::jsonb);
    end case;
  exception when others then
    v_code := substring(sqlerrm from '^WF_([A-Z_]+):');
    if v_code is not null then
      return action_gateway.finish_intent(i.intent_id, 'refused', v_code, jsonb_build_object('stage', 'workforce'));
    end if;
    if sqlstate = '23514' then return action_gateway.finish_intent(i.intent_id, 'refused', 'PAYLOAD_REFUSED', jsonb_build_object('stage', 'workforce')); end if;
    return action_gateway.finish_intent(i.intent_id, 'failed', 'DOMAIN_WRITE_FAILED', jsonb_build_object('sqlstate', sqlstate));
  end;
end
$fn$;

-- ── 7. privileges, RLS, registration ───────────────────────────────────────
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'workforce' and p.proname in ('tags_ok', 'assignment_view', 'employee_identity_guard', 'employee_bind_principal', 'employee_unbind', 'release_external_leases', 'binding_refusal',
                     'assignment_set_external_policy', 'employee_link_external', 'mission_origin_guard',
                     'assignment_mode_sync', 'assignment_mode_event', 'assignment_claim_external', 'assignment_external_lease', 'assignment_handoff', 'budget_put', 'budget_revoke',
                     'budget_status', 'employee_gateway_audit'))
               or (n.nspname = 'action_gateway' and p.proname in ('wf_principal', 'wf_assignment_json', 'wf_resolve_evidence', 'wf_identity_anomaly'))
               or (n.nspname = 'public' and p.proname in ('action_gateway_workforce_read', 'action_gateway_dw_workforce')) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, agent_api', f.sig);
  end loop;
end $$;
-- the replaced writers keep their original grants (create or replace keeps the ACL); re-assert them
grant execute on function workforce.employee_upsert(uuid, jsonb, uuid), workforce.assignment_claim(uuid, text, integer, integer, timestamptz),
  workforce.assignment_resume_job(uuid, text, text, text, jsonb, jsonb) to agent_api, service_role;
grant execute on function workforce.tags_ok(text[]) to agent_api, service_role;
-- budgets + the action history: the API (agent_api) and the owner path
grant execute on function workforce.budget_put(uuid, jsonb, uuid), workforce.budget_revoke(uuid, uuid, uuid), workforce.budget_status(uuid, text, text, timestamptz),
  workforce.employee_gateway_audit(uuid, text, integer) to agent_api, service_role;
-- the OWNER binds an Agntei employee to its principal (service_role / the SQL editor), never the API
grant execute on function workforce.employee_bind_principal(uuid, text, text, uuid, interval, timestamptz), workforce.employee_unbind(uuid, text, uuid, text) to service_role;
-- the COO / CEO records the external-timeout policy (the engine reads it in every dispatch pass)
grant execute on function workforce.assignment_set_external_policy(uuid, text, text, integer, text) to agent_api, service_role;
-- the gateway role: exactly its two entry points (both registered below for #26's self-check)
grant execute on function public.action_gateway_workforce_read(text, text, jsonb), public.action_gateway_dw_workforce(uuid, uuid) to lc_action_gateway;

alter table workforce.budget enable row level security;
alter table workforce.budget force row level security;
revoke all on workforce.budget from public, anon, authenticated, service_role, agent_api;
grant select on workforce.budget to agent_api, service_role, authenticated;
create policy agent_api_select on workforce.budget for select to agent_api using (true);
create policy service_role_select on workforce.budget for select to service_role using (true);
create policy budget_read on workforce.budget for select to authenticated using (agent.can_read_org(org_id));

insert into action_gateway.extensions (kind, name, link, basis) values
  ('definer_function', 'public.action_gateway_workforce_read(text,text,jsonb)', 'PROPOSED_20261022110000_workforce_agntei', null),
  ('definer_function', 'public.action_gateway_dw_workforce(uuid,uuid)', 'PROPOSED_20261022110000_workforce_agntei', null),
  ('domain_write_action', 'workforce_link_self', 'PROPOSED_20261022110000_workforce_agntei', null),
  ('domain_write_action', 'workforce_open_mission', 'PROPOSED_20261022110000_workforce_agntei', null),
  ('domain_write_action', 'workforce_claim_assignment', 'PROPOSED_20261022110000_workforce_agntei', null),
  ('domain_write_action', 'workforce_report_progress', 'PROPOSED_20261022110000_workforce_agntei', null),
  ('domain_write_action', 'workforce_complete_assignment', 'PROPOSED_20261022110000_workforce_agntei', null),
  ('domain_write_action', 'workforce_request_research', 'PROPOSED_20261022110000_workforce_agntei', null),
  ('domain_write_action', 'workforce_handoff', 'PROPOSED_20261022110000_workforce_agntei', null),
  ('domain_write_action', 'workforce_escalate', 'PROPOSED_20261022110000_workforce_agntei', null);

-- ── 8. the apply refuses unless the gateway role is still exactly its allowlist ──
do $$
declare v jsonb;
begin
  v := action_gateway.self_check('lc_action_gateway');
  if not coalesce((v ->> 'ok')::boolean, false) then
    raise exception 'workforce_agntei: the Action Gateway self-check refused the role: %', v -> 'findings';
  end if;
  if has_schema_privilege('lc_action_gateway', 'workforce', 'usage') then raise exception 'postcondition: lc_action_gateway reaches schema workforce only through its two definer entry points'; end if;
  if has_function_privilege('agent_api', 'workforce.employee_bind_principal(uuid, text, text, uuid, interval, timestamptz)', 'execute')
     or has_function_privilege('agent_api', 'workforce.employee_unbind(uuid, text, uuid, text)', 'execute') then raise exception 'postcondition: binding / unbinding is owner-only'; end if;
end $$;

notify pgrst, 'reload schema';
