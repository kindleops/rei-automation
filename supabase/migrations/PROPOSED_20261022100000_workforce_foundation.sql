-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required (each production migration is
-- separately authorized).
--
-- LeadCommand Workforce — Phase A foundation (docs/WORKFORCE.md §2, §9, §11).
--
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT inside, so the runner can wrap it):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261022100000_workforce_foundation.sql
-- Pretest:          PROPOSED_20261022100000_workforce_foundation_pretest.sql
-- Posttest:         PROPOSED_20261022100000_workforce_foundation_posttest.sql
-- Rollback:         PROPOSED_20261022100000_workforce_foundation_rollback.sql
-- Rollback posttest PROPOSED_20261022100000_workforce_foundation_rollback_posttest.sql
-- Seed (separate, owner path, born safe): PROPOSED_20261022100100_workforce_seed.sql
--   node scripts/db/run-migration-test.mjs --pg-bin <dir> --id workforce_foundation
-- ORDER: after PROPOSED_20261010120000_agent_s3_persistence.sql (schema agent, payload CHECKs,
--        agent.can_read_org, agent.operator_membership) and PROPOSED_20261012140000_intel_runtime.sql
--        (agent.runtime_is_named_operator, agent.runtime_schedule). The preconditions below RAISE.
--
-- WHAT IT ADDS (a NEW schema `workforce`; nothing in schema agent or public is created or altered):
--   employee, mission, assignment, resource_claim, event, exec_message, memory_fact,
--   authority_policy, settings, kpi_snapshot — coordination state only. Workforce never owns a
--   business record and nothing here can send, queue, offer, launch or change a stage.
--   Every write goes through a workforce.* SECURITY DEFINER function (pinned search_path); a
--   guard trigger on every table refuses any other write path. The assignment and mission state
--   graphs are enforced in SQL (workforce.assignment_transition_ok / workforce.mission_transition_ok,
--   identical to ASSIGNMENT_TRANSITIONS / MISSION_TRANSITIONS in
--   apps/api/src/lib/workforce/store/transitions.js — a test compares them).
-- Access: revoke-all; RLS ENABLED + FORCED; agent_api reads (single-tenant using (true), as S3) and
--   calls the writers; authenticated reads only through agent.can_read_org(org_id); anon nothing.
-- Hard data guarantee: agent.payload_is_clean on every jsonb column; agent.payload_string_violation
--   (s, 'text', 0) IS NULL on every human-text column (titles, directive, exec_message.content,
--   display names): no phone, email, JWT or credential can be stored.
-- BORN OFF: nothing here is scheduled or claimed. The seed defines the 'workforce-dispatch'
--   schedule disabled; workforce.* kinds stay absent from agent.runtime_limits.kind_limits.
-- ════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ── 0. preconditions (RAISE; nothing is created when one fails) ─────────────
do $$
begin
  if to_regnamespace('agent') is null then
    raise exception 'workforce_foundation: schema agent is missing (apply PROPOSED_20261010120000_agent_s3_persistence first)';
  end if;
  if to_regprocedure('agent.payload_is_clean(jsonb)') is null or to_regprocedure('agent.payload_string_violation(text,text,integer)') is null
     or to_regprocedure('agent.can_read_org(uuid)') is null or to_regclass('agent.operator_membership') is null or to_regclass('agent.org') is null then
    raise exception 'workforce_foundation: the S3 functions (payload_is_clean, payload_string_violation, can_read_org) / operator_membership are missing';
  end if;
  if to_regprocedure('agent.runtime_is_named_operator(text)') is null
     or to_regprocedure('agent.runtime_upsert_schedule(text,text,integer,text,jsonb,boolean,timestamptz,numeric)') is null
     or to_regclass('agent.runtime_schedule') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'agent' and table_name = 'research_job' and column_name = 'runtime_managed') then
    raise exception 'workforce_foundation: the R2 runtime (PROPOSED_20261012140000_intel_runtime) is missing';
  end if;
  if to_regnamespace('workforce') is not null then
    raise exception 'workforce_foundation: schema workforce already exists (already applied?)';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'agent_api' and not (rolsuper or rolbypassrls)) then
    raise exception 'workforce_foundation: role agent_api missing or privileged';
  end if;
  if not (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) then
    raise exception 'workforce_foundation: applying role % must have BYPASSRLS (the SECURITY DEFINER writers run as it under FORCE RLS)', current_user;
  end if;
  if not exists (select 1 from agent.org where org_id = '00000000-0000-4000-8000-00000000a001') then
    raise exception 'workforce_foundation: the LeadCommand org row is missing';
  end if;
end
$$;

-- ── 1. schema + default privileges ─────────────────────────────────────────
create schema workforce;
revoke all on schema workforce from public, anon, authenticated;
grant usage on schema workforce to agent_api, service_role, authenticated;   -- authenticated: RLS-scoped reads only
-- a per-schema default cannot cancel a database-wide default grant: every object below is also revoked explicitly
alter default privileges in schema workforce revoke all on tables from public, anon, authenticated;
alter default privileges in schema workforce revoke all on sequences from public, anon, authenticated;
alter default privileges in schema workforce revoke all on functions from public, anon, authenticated;
comment on schema workforce is 'LeadCommand Workforce (Phase A): coordination state only — employees, missions, assignments, resource claims, events, the executive conversation, memory, authority policies, settings, KPIs. docs/WORKFORCE.md.';

-- ── 2. pure helpers ─────────────────────────────────────────────────────────
-- the ONE assignment state graph (mirrored by ASSIGNMENT_TRANSITIONS in
-- apps/api/src/lib/workforce/store/transitions.js; tests compare every pair)
create or replace function workforce.assignment_transition_ok(p_from text, p_to text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select coalesce(case p_from
    when 'pending'          then p_to in ('ready', 'cancelled')
    when 'ready'            then p_to in ('leased', 'cancelled')
    when 'leased'           then p_to in ('running', 'ready', 'completed', 'failed', 'waiting_job', 'waiting_approval', 'blocked', 'cancelled')
    when 'running'          then p_to in ('completed', 'failed', 'ready', 'waiting_job', 'waiting_approval', 'blocked', 'cancelled')
    when 'waiting_job'      then p_to in ('ready', 'completed', 'failed', 'cancelled')
    when 'waiting_approval' then p_to in ('ready', 'cancelled', 'failed')
    when 'blocked'          then p_to in ('ready', 'cancelled')
    else false
  end, false)
$$;

-- the ONE mission state graph (mirrored by MISSION_TRANSITIONS)
create or replace function workforce.mission_transition_ok(p_from text, p_to text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select coalesce(case p_from
    when 'planning' then p_to in ('active', 'failed', 'cancelled')
    when 'active'   then p_to in ('waiting', 'blocked', 'completed', 'failed', 'cancelled')
    when 'waiting'  then p_to in ('active', 'completed', 'failed', 'cancelled')
    when 'blocked'  then p_to in ('active', 'cancelled', 'failed')
    else false
  end, false)
$$;

-- role → department (mirrored by ROLE_DEPARTMENTS in store/transitions.js)
create or replace function workforce.role_department_ok(p_role text, p_dept text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select coalesce(case p_role
    when 'ceo' then p_dept = 'executive'
    when 'coo' then p_dept = 'executive'
    when 'cfo' then p_dept = 'finance'
    when 'head_acquisitions' then p_dept = 'acquisitions'
    when 'acquisition_agent' then p_dept = 'acquisitions'
    when 'head_marketing' then p_dept = 'marketing'
    when 'campaign_manager' then p_dept = 'marketing'
    when 'head_dispositions' then p_dept = 'dispositions'
    when 'dispositions_agent' then p_dept = 'dispositions'
    when 'head_data_intelligence' then p_dept = 'data_intelligence'
    when 'research_analyst' then p_dept = 'data_intelligence'
    when 'ops_supervisor' then p_dept = 'operations'
    when 'human_staff' then p_dept in ('executive', 'finance', 'acquisitions', 'marketing', 'dispositions', 'data_intelligence', 'operations')
    else false
  end, false)
$$;

-- market keys: lower-case slugs, ≤ 50, no NULL, no duplicate
create or replace function workforce.markets_ok(p text[])
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

-- depends_on step keys: ≤ 50, step-key shaped, no NULL, no duplicate
create or replace function workforce.step_keys_ok(p text[])
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select p is not null and cardinality(p) <= 50
     and not exists (select 1 from unnest(p) s where s is null or s !~ '^[a-z][a-z0-9_.:-]{0,79}$')
     and cardinality(p) = (select count(distinct s) from unnest(p) s)
$$;

-- retry backoff: 30 s · 2^(attempt-1), capped at 1 h (mirrored by backoffSeconds in the memory twin)
create or replace function workforce.backoff(p_attempt integer)
returns interval
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select make_interval(secs => least(3600::numeric, 30::numeric * power(2::numeric, greatest(coalesce(p_attempt, 1), 1) - 1))::double precision)
$$;

-- ── 3. tables ───────────────────────────────────────────────────────────────
create table workforce.settings (
  org_id uuid primary key references agent.org(org_id),
  exec_review_price_usd numeric(14,2) not null default 5000000 check (exec_review_price_usd > 0 and exec_review_price_usd <= 1000000000),
  escalation jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by text not null default 'migration' check (updated_by = 'migration' or agent.runtime_is_named_operator(updated_by)),
  constraint settings_escalation_clean check (jsonb_typeof(escalation) = 'object' and octet_length(escalation::text) <= 4096 and agent.payload_is_clean(escalation))
);
comment on table workforce.settings is 'Workforce: the CEO-configurable escalation thresholds (exec_review_price_usd default 5,000,000). Written only by workforce.settings_put (owner).';

create table workforce.employee (
  employee_id text primary key check (employee_id ~ '^emp_[a-z0-9_]{3,40}$'),
  org_id uuid not null references agent.org(org_id),
  kind text not null check (kind in ('ai', 'human')),
  role_key text not null check (role_key in ('ceo', 'coo', 'cfo', 'head_acquisitions', 'acquisition_agent', 'head_marketing', 'campaign_manager',
                                             'head_dispositions', 'dispositions_agent', 'head_data_intelligence', 'research_analyst', 'ops_supervisor', 'human_staff')),
  department_key text not null check (department_key in ('executive', 'finance', 'acquisitions', 'marketing', 'dispositions', 'data_intelligence', 'operations')),
  display_name text not null check (length(display_name) between 1 and 80),
  employee_code text check (employee_code is null or employee_code ~ '^[A-Z]{2,6}-[0-9]{2,3}$'),
  manager_employee_id text references workforce.employee(employee_id),
  user_id uuid,
  action_principal_id text check (action_principal_id is null or action_principal_id ~ '^agt_[a-z0-9][a-z0-9_]{2,40}$'),
  status text not null default 'active' check (status in ('active', 'paused', 'retired')),
  markets text[] not null default '{}' check (workforce.markets_ok(markets)),
  segments jsonb not null default '{}'::jsonb,
  tier_ceiling text not null default 'T1' check (tier_ceiling in ('T1', 'T2')),          -- Phase A max T2
  spend_day_cap_usd numeric(8,2) not null default 0 check (spend_day_cap_usd between 0 and 5),
  heartbeat_at timestamptz,
  last_activity_at timestamptz,
  created_by uuid not null,                                                              -- the named operator (owner)
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint employee_display_name_clean check (agent.payload_string_violation(display_name, 'text', 0) is null),
  constraint employee_segments_clean check (jsonb_typeof(segments) = 'object' and octet_length(segments::text) <= 4096 and agent.payload_is_clean(segments)),
  constraint employee_role_department check (workforce.role_department_ok(role_key, department_key)),
  constraint employee_ceo_is_human check (role_key <> 'ceo' or (kind = 'human' and user_id is not null)),
  constraint employee_ai_has_no_user check (kind = 'human' or user_id is null),
  constraint employee_no_self_manager check (manager_employee_id is distinct from employee_id)
);
-- the CEO row is the only ceo row (per org)
create unique index employee_one_ceo_uq on workforce.employee (org_id) where role_key = 'ceo';
create unique index employee_code_uq on workforce.employee (org_id, employee_code) where employee_code is not null;
create index employee_org_status_idx on workforce.employee (org_id, status, department_key);
create index employee_manager_idx on workforce.employee (manager_employee_id) where manager_employee_id is not null;
comment on table workforce.employee is 'Workforce: AI and human employees and the org hierarchy. The CEO row (kind human, role ceo, user_id = the owner) is unique. Written only by workforce.employee_upsert (owner) and workforce.employee_heartbeat.';

create table workforce.mission (
  mission_id text primary key check (mission_id ~ '^wfm_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  org_id uuid not null references agent.org(org_id),
  title text not null check (length(title) between 1 and 200),
  directive text not null check (length(directive) between 1 and 8000),
  objective jsonb not null default '{}'::jsonb,
  playbook_key text check (playbook_key is null or playbook_key ~ '^[a-z][a-z0-9_]{1,60}$'),
  owner_employee_id text not null references workforce.employee(employee_id),
  requested_by uuid not null,                                                            -- the named operator who issued the directive
  status text not null default 'planning' check (status in ('planning', 'active', 'waiting', 'blocked', 'completed', 'failed', 'cancelled')),
  priority integer not null default 50 check (priority between 0 and 100),
  due_at timestamptz,
  plan jsonb not null default '{}'::jsonb,
  plan_version integer not null default 0 check (plan_version >= 0),
  report jsonb,
  idempotency_key text not null check (idempotency_key ~ '^[0-9a-f]{64}$'),           -- sha256 of (org, caller key): no raw key is stored
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,                                                              -- set when the mission reaches ANY terminal status
  constraint mission_title_clean check (agent.payload_string_violation(title, 'text', 0) is null),
  constraint mission_directive_clean check (agent.payload_string_violation(directive, 'text', 0) is null),
  constraint mission_objective_clean check (jsonb_typeof(objective) = 'object' and octet_length(objective::text) <= 8192 and agent.payload_is_clean(objective)),
  constraint mission_plan_clean check (jsonb_typeof(plan) = 'object' and octet_length(plan::text) <= 65536 and agent.payload_is_clean(plan)),
  constraint mission_report_clean check (report is null or (jsonb_typeof(report) = 'object' and octet_length(report::text) <= 65536 and agent.payload_is_clean(report))),
  constraint mission_terminal_stamp check ((status in ('completed', 'failed', 'cancelled')) = (completed_at is not null))
);
-- one directive submission = one mission (per org)
create unique index mission_idem_uq on workforce.mission (org_id, idempotency_key);
create index mission_org_created_idx on workforce.mission (org_id, created_at desc, mission_id desc);
create index mission_org_status_idx on workforce.mission (org_id, status) where status in ('planning', 'active', 'waiting', 'blocked');
comment on table workforce.mission is 'Workforce: one CEO directive = one mission (idempotent per org). The plan is a versioned DAG (optimistic plan_version); the report carries verified results only (docs/WORKFORCE.md §6).';

create table workforce.assignment (
  assignment_id text primary key check (assignment_id ~ '^wfa_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  org_id uuid not null references agent.org(org_id),
  mission_id text not null references workforce.mission(mission_id),
  parent_assignment_id text references workforce.assignment(assignment_id),
  step_key text not null check (step_key ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  capability_key text not null check (capability_key ~ '^[a-z][a-z0-9_]{1,30}\.[a-z][a-z0-9_]{1,60}$'),
  assignee_employee_id text not null references workforce.employee(employee_id),
  delegated_by_employee_id text references workforce.employee(employee_id),
  status text not null default 'pending' check (status in ('pending', 'ready', 'leased', 'running', 'waiting_job', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled')),
  depends_on text[] not null default '{}' check (workforce.step_keys_ok(depends_on)),
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  outcome_class text check (outcome_class is null or outcome_class in ('verified', 'partial', 'unknown', 'refused')),
  evidence jsonb not null default '[]'::jsonb,
  runtime_job_id text check (runtime_job_id is null or runtime_job_id ~ '^mjob_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  resource_type text check (resource_type is null or resource_type in ('thread', 'property', 'opportunity', 'campaign')),
  resource_key text check (resource_key is null or resource_key ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  attempt integer not null default 0,
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_owner text check (lease_owner is null or lease_owner ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  lease_until timestamptz,
  lease_seconds integer check (lease_seconds is null or lease_seconds between 15 and 3600),
  claimed_at timestamptz,
  finished_token uuid,
  last_error jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  constraint assignment_step_uq unique (mission_id, step_key),
  constraint assignment_attempts check (attempt between 0 and max_attempts),
  constraint assignment_lease_shape check ((lease_token is null) = (lease_until is null) and (lease_token is null) = (lease_owner is null) and (lease_token is null) = (lease_seconds is null)),
  constraint assignment_lease_iff_active check ((status in ('leased', 'running')) = (lease_token is not null)),
  constraint assignment_waiting_job_has_job check (status <> 'waiting_job' or runtime_job_id is not null),
  constraint assignment_completed_has_outcome check (status <> 'completed' or outcome_class is not null),
  constraint assignment_terminal_stamp check ((status in ('completed', 'failed', 'cancelled')) = (finished_at is not null)),
  constraint assignment_resource_pair check ((resource_type is null) = (resource_key is null)),
  constraint assignment_no_self_dependency check (not (step_key = any (depends_on))),
  constraint assignment_no_self_parent check (parent_assignment_id is distinct from assignment_id),
  -- property ids are pid_-encoded (missions/mission-codec.js): a raw digit run is refused like a phone
  constraint assignment_resource_key_clean check (resource_key is null or agent.payload_string_violation(resource_key, 'resource_key', 0) is null),
  constraint assignment_input_clean check (jsonb_typeof(input) = 'object' and octet_length(input::text) <= 16384 and agent.payload_is_clean(input)),
  constraint assignment_output_clean check (output is null or (jsonb_typeof(output) = 'object' and octet_length(output::text) <= 32768 and agent.payload_is_clean(output))),
  constraint assignment_evidence_clean check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) <= 100 and octet_length(evidence::text) <= 16384
                                               and agent.payload_is_clean(jsonb_build_object('evidence_refs', evidence))),
  constraint assignment_last_error_clean check (last_error is null or (jsonb_typeof(last_error) = 'object' and octet_length(last_error::text) <= 4096 and agent.payload_is_clean(last_error)))
);
-- claim / promotion: due pending + ready rows (small partial index)
create index assignment_claimable_idx on workforce.assignment (org_id, status, next_attempt_at) where status in ('pending', 'ready');
-- reaper: live leases only
create index assignment_leased_idx on workforce.assignment (lease_until) where status in ('leased', 'running');
create index assignment_waiting_job_idx on workforce.assignment (org_id, runtime_job_id) where status = 'waiting_job';
create index assignment_mission_idx on workforce.assignment (mission_id, status);
create index assignment_assignee_idx on workforce.assignment (assignee_employee_id, status);
comment on table workforce.assignment is 'Workforce: the durable unit of delegated work. Born pending; workforce.assignment_claim promotes pending→ready when every depends_on step is completed and leases ready rows FOR UPDATE SKIP LOCKED. Lease-token bound writers; reaped leases retry (attempt+1) or fail past max_attempts. The state graph is enforced by workforce.assignment_guard.';

create table workforce.resource_claim (
  claim_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agent.org(org_id),
  resource_type text not null check (resource_type in ('thread', 'property', 'opportunity', 'campaign')),
  resource_key text not null check (resource_key ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  employee_id text not null references workforce.employee(employee_id),
  assignment_id text references workforce.assignment(assignment_id),
  claimed_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  released_at timestamptz,
  release_reason text check (release_reason is null or release_reason in ('released', 'expired', 'finished', 'cancelled')),
  constraint resource_claim_expiry_after_claim check (expires_at > claimed_at),
  constraint resource_claim_release_pair check ((released_at is null) = (release_reason is null)),
  constraint resource_claim_resource_key_clean check (agent.payload_string_violation(resource_key, 'resource_key', 0) is null)
);
-- two agents can never hold one seller / property / opportunity / campaign at once
create unique index resource_claim_active_uq on workforce.resource_claim (org_id, resource_type, resource_key) where released_at is null;
create index resource_claim_expiry_idx on workforce.resource_claim (expires_at) where released_at is null;
create index resource_claim_assignment_idx on workforce.resource_claim (assignment_id) where released_at is null;
comment on table workforce.resource_claim is 'Workforce: exclusive resource ownership. One active claim per (org, resource_type, resource_key); expired claims are reapable (workforce.resource_claim_reap) and are taken over on acquire.';

create table workforce.event (
  event_id bigint generated always as identity primary key,
  org_id uuid not null references agent.org(org_id),
  at timestamptz not null default clock_timestamp(),
  mission_id text references workforce.mission(mission_id),
  assignment_id text references workforce.assignment(assignment_id),
  employee_id text references workforce.employee(employee_id),
  type text not null check (type ~ '^wf\.[a-z_.]+$' and length(type) <= 80),
  payload jsonb not null default '{}'::jsonb,
  constraint event_payload_clean check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8192 and agent.payload_is_clean(payload))
);
create index event_org_idx on workforce.event (org_id, event_id);
create index event_mission_idx on workforce.event (mission_id, event_id) where mission_id is not null;
comment on table workforce.event is 'Workforce: the append-only Operations feed (guard trigger: no UPDATE / DELETE / TRUNCATE for anyone). Written only by the workforce.* functions.';

create table workforce.exec_message (
  message_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agent.org(org_id),
  mission_id text references workforce.mission(mission_id),
  author text not null check (author in ('ceo', 'coo')),
  author_user_id uuid,
  author_employee_id text references workforce.employee(employee_id),
  content text not null check (length(content) between 1 and 8000),
  refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint exec_message_author_ceo check ((author = 'ceo') = (author_user_id is not null)),
  constraint exec_message_author_coo check ((author = 'coo') = (author_employee_id is not null)),
  constraint exec_message_content_clean check (agent.payload_string_violation(content, 'text', 0) is null),
  constraint exec_message_refs_clean check (jsonb_typeof(refs) = 'array' and jsonb_array_length(refs) <= 50 and octet_length(refs::text) <= 8192
                                             and agent.payload_is_clean(jsonb_build_object('record_refs', refs)))
);
create index exec_message_org_idx on workforce.exec_message (org_id, created_at desc, message_id);
create index exec_message_mission_idx on workforce.exec_message (mission_id, created_at desc) where mission_id is not null;
comment on table workforce.exec_message is 'Workforce: the Executive Command conversation (CEO ↔ COO). Append-only. Not seller SMS: no phone / email can be stored.';

create table workforce.memory_fact (
  fact_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agent.org(org_id),
  scope text not null check (scope in ('company', 'department', 'employee', 'mission', 'property', 'market')),
  scope_key text not null check (scope_key ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  fact_key text not null check (fact_key ~ '^[a-z][a-z0-9_.:-]{1,80}$'),
  value jsonb not null,
  epistemic text not null check (epistemic in ('verified', 'interpretation', 'ceo_policy')),
  confidence numeric(4,3) check (confidence is null or confidence between 0 and 1),
  source_refs jsonb not null default '[]'::jsonb,
  author_employee_id text references workforce.employee(employee_id),
  author_user_id uuid,
  valid_from timestamptz not null default clock_timestamp(),
  superseded_by uuid references workforce.memory_fact(fact_id) deferrable initially deferred,
  superseded_at timestamptz,
  constraint memory_fact_supersede_pair check ((superseded_by is null) = (superseded_at is null)),
  constraint memory_fact_has_author check (author_employee_id is not null or author_user_id is not null),
  constraint memory_fact_verified_has_source check (epistemic <> 'verified' or jsonb_array_length(source_refs) >= 1),
  constraint memory_fact_policy_by_user check (epistemic <> 'ceo_policy' or author_user_id is not null),
  constraint memory_fact_scope_key_clean check (agent.payload_string_violation(scope_key, 'scope_key', 0) is null),
  constraint memory_fact_value_clean check (octet_length(value::text) <= 8192 and agent.payload_is_clean(jsonb_build_object('value', value))),
  constraint memory_fact_source_refs_clean check (jsonb_typeof(source_refs) = 'array' and jsonb_array_length(source_refs) <= 50 and octet_length(source_refs::text) <= 8192
                                                   and agent.payload_is_clean(jsonb_build_object('source_refs', source_refs)))
);
-- one live fact per identity
create unique index memory_fact_live_uq on workforce.memory_fact (org_id, scope, scope_key, fact_key, epistemic) where superseded_at is null;
create index memory_fact_scope_idx on workforce.memory_fact (org_id, scope, scope_key, valid_from desc);
comment on table workforce.memory_fact is 'Workforce: organizational memory. Supersede-only (value never changes); one live fact per (org, scope, scope_key, fact_key, epistemic); verified ⇒ ≥ 1 source ref; ceo_policy only by an owner user.';

create table workforce.authority_policy (
  policy_id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agent.org(org_id),
  role_key text check (role_key is null or role_key in ('ceo', 'coo', 'cfo', 'head_acquisitions', 'acquisition_agent', 'head_marketing', 'campaign_manager',
                                                        'head_dispositions', 'dispositions_agent', 'head_data_intelligence', 'research_analyst', 'ops_supervisor', 'human_staff')),
  employee_id text references workforce.employee(employee_id),
  action_key text not null check (action_key ~ '^[a-z][a-z0-9_]{1,30}(\.[a-z][a-z0-9_]{1,60}){1,3}$'),
  scope jsonb not null default '{}'::jsonb,
  limits jsonb not null default '{}'::jsonb,
  risk text not null default 'low' check (risk in ('low', 'medium', 'high')),
  min_confidence numeric(4,3) check (min_confidence is null or min_confidence between 0 and 1),
  review text not null default 'ceo' check (review in ('ceo', 'coo', 'none')),
  valid_from timestamptz not null default clock_timestamp(),
  valid_until timestamptz,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revoked_by uuid,
  version integer not null default 1 check (version >= 1),
  supersedes uuid references workforce.authority_policy(policy_id),
  constraint authority_policy_subject check ((role_key is null) <> (employee_id is null)),
  constraint authority_policy_window check (valid_until is null or valid_until > valid_from),
  constraint authority_policy_revoke_pair check ((status = 'revoked') = (revoked_at is not null) and (revoked_at is null) = (revoked_by is null)),
  constraint authority_policy_version_chain check ((version = 1) = (supersedes is null)),
  constraint authority_policy_scope_clean check (jsonb_typeof(scope) = 'object' and octet_length(scope::text) <= 4096 and agent.payload_is_clean(scope)),
  constraint authority_policy_limits_clean check (jsonb_typeof(limits) = 'object' and octet_length(limits::text) <= 4096 and agent.payload_is_clean(limits))
);
create index authority_policy_active_idx on workforce.authority_policy (org_id, action_key) where status = 'active';
comment on table workforce.authority_policy is 'Workforce: the Delegation & Authority Engine policy table. DECLARATIVE in Phase A: it is evaluated for internal (T1) capabilities and renders proposed Action Gateway capability_grants; it never creates a grant. Written only by workforce.policy_put / policy_revoke (owner).';

create table workforce.kpi_snapshot (
  org_id uuid not null references agent.org(org_id),
  subject_type text not null check (subject_type in ('employee', 'department', 'org')),
  subject_key text not null check (subject_key ~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
  kpi_key text not null check (kpi_key ~ '^[a-z][a-z0-9_.]{1,80}$'),
  "window" text not null check ("window" ~ '^[a-z0-9_]{1,20}$'),
  value numeric,
  status text not null check (status in ('known', 'unknown')),
  source jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default clock_timestamp(),
  constraint kpi_snapshot_pk primary key (org_id, subject_type, subject_key, kpi_key, "window"),
  -- unknown is a first-class value, never 0
  constraint kpi_snapshot_unknown_has_no_value check ((status = 'unknown') = (value is null)),
  constraint kpi_snapshot_source_clean check (jsonb_typeof(source) = 'object' and octet_length(source::text) <= 4096 and agent.payload_is_clean(source))
);
comment on table workforce.kpi_snapshot is 'Workforce: the latest KPI value per (subject, kpi, window). status unknown ⇔ value NULL: an unknown KPI is never rendered as 0.';

-- the single LeadCommand org (single-tenant today)
insert into workforce.settings (org_id) values ('00000000-0000-4000-8000-00000000a001');

-- ── 4. guards: legal transitions + the write path, enforced in SQL ──────────
-- every table: only the workforce.* SECURITY DEFINER functions (they run as the owner) write
create or replace function workforce.write_path_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if current_user is distinct from (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = tg_relid) then
    raise exception 'WF_WRITE_PATH: workforce.% changes only through the workforce.* functions (% refused for %)', tg_table_name, tg_op, current_user
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

-- append-only tables (event, exec_message): INSERT through the functions only; never UPDATE / DELETE / TRUNCATE
create or replace function workforce.append_only_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if current_user is distinct from (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = tg_relid) then
      raise exception 'WF_WRITE_PATH: workforce.% is appended only through the workforce.* functions (refused for %)', tg_table_name, current_user
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  raise exception 'WF_APPEND_ONLY: workforce.% is append-only (% refused for %)', tg_table_name, tg_op, current_user using errcode = 'insufficient_privilege';
end
$$;

create or replace function workforce.mission_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, workforce
as $$
begin
  if current_user is distinct from (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = tg_relid) then
    raise exception 'WF_WRITE_PATH: missions change only through the workforce.* functions (% refused for %)', tg_op, current_user using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'DELETE' then return old; end if;   -- owner break-glass only; the API never connects as the owner
  if tg_op = 'INSERT' then
    if new.status <> 'planning' or new.plan_version <> 0 or new.report is not null then
      raise exception 'WF_ILLEGAL_TRANSITION: a mission is born planning (plan_version 0, no report)' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.mission_id <> old.mission_id or new.org_id <> old.org_id or new.requested_by <> old.requested_by or new.idempotency_key <> old.idempotency_key
     or new.created_at <> old.created_at or new.directive <> old.directive or new.title <> old.title or new.owner_employee_id <> old.owner_employee_id then
    raise exception 'WF_IMMUTABLE: mission identity, directive and owner never change' using errcode = 'check_violation';
  end if;
  if old.status in ('completed', 'failed', 'cancelled') then
    raise exception 'WF_ILLEGAL_TRANSITION: a % mission is terminal', old.status using errcode = 'check_violation';
  end if;
  if new.status <> old.status and not workforce.mission_transition_ok(old.status, new.status) then
    raise exception 'WF_ILLEGAL_TRANSITION: mission % → %', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.plan_version not in (old.plan_version, old.plan_version + 1) then
    raise exception 'WF_VERSION_MISMATCH: plan_version moves by one' using errcode = 'check_violation';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$$;

create or replace function workforce.assignment_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, workforce
as $$
begin
  if current_user is distinct from (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = tg_relid) then
    raise exception 'WF_WRITE_PATH: assignments change only through the workforce.* functions (% refused for %)', tg_op, current_user using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'DELETE' then return old; end if;   -- owner break-glass only
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.attempt <> 0 or new.lease_token is not null or new.output is not null or new.finished_at is not null then
      raise exception 'WF_ILLEGAL_TRANSITION: an assignment is born pending (attempt 0, no lease, no output)' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.assignment_id <> old.assignment_id or new.org_id <> old.org_id or new.mission_id <> old.mission_id or new.step_key <> old.step_key
     or new.capability_key <> old.capability_key or new.parent_assignment_id is distinct from old.parent_assignment_id
     or new.depends_on <> old.depends_on or new.input <> old.input or new.max_attempts <> old.max_attempts or new.created_at <> old.created_at then
    raise exception 'WF_IMMUTABLE: assignment identity, dependencies, input and max_attempts never change' using errcode = 'check_violation';
  end if;
  if old.status in ('completed', 'failed', 'cancelled') then
    raise exception 'WF_ILLEGAL_TRANSITION: a % assignment is terminal', old.status using errcode = 'check_violation';
  end if;
  if new.status <> old.status and not workforce.assignment_transition_ok(old.status, new.status) then
    raise exception 'WF_ILLEGAL_TRANSITION: assignment % → %', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.attempt < old.attempt then
    raise exception 'WF_IMMUTABLE: attempt never decreases' using errcode = 'check_violation';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$$;

create or replace function workforce.resource_claim_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if current_user is distinct from (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = tg_relid) then
    raise exception 'WF_WRITE_PATH: resource claims change only through the workforce.* functions (% refused for %)', tg_op, current_user using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' then
    if new.released_at is not null then raise exception 'WF_ILLEGAL_TRANSITION: a claim is born active' using errcode = 'check_violation'; end if;
    return new;
  end if;
  if new.claim_id <> old.claim_id or new.org_id <> old.org_id or new.resource_type <> old.resource_type or new.resource_key <> old.resource_key
     or new.employee_id <> old.employee_id or new.assignment_id is distinct from old.assignment_id or new.claimed_at <> old.claimed_at then
    raise exception 'WF_IMMUTABLE: claim identity never changes' using errcode = 'check_violation';
  end if;
  if old.released_at is not null then
    raise exception 'WF_ILLEGAL_TRANSITION: a released claim is immutable' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create or replace function workforce.memory_fact_guard()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'WF_APPEND_ONLY: memory facts are superseded, never deleted (refused for %)', current_user using errcode = 'insufficient_privilege';
  end if;
  if current_user is distinct from (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = tg_relid) then
    raise exception 'WF_WRITE_PATH: memory changes only through workforce.memory_assert (% refused for %)', tg_op, current_user using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.superseded_at is not null or new.superseded_by is not null then
      raise exception 'WF_ILLEGAL_TRANSITION: a fact is born live' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- supersede-only: the ONLY change is superseded_by / superseded_at, once
  if old.superseded_at is not null or new.superseded_at is null
     or (to_jsonb(new) - 'superseded_by' - 'superseded_at') <> (to_jsonb(old) - 'superseded_by' - 'superseded_at') then
    raise exception 'WF_IMMUTABLE: a memory fact is never updated, only superseded once' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger settings_guard before insert or update or delete on workforce.settings for each row execute function workforce.write_path_guard();
create trigger employee_guard before insert or update or delete on workforce.employee for each row execute function workforce.write_path_guard();
create trigger authority_policy_guard before insert or update or delete on workforce.authority_policy for each row execute function workforce.write_path_guard();
create trigger kpi_snapshot_guard before insert or update or delete on workforce.kpi_snapshot for each row execute function workforce.write_path_guard();
create trigger mission_guard before insert or update or delete on workforce.mission for each row execute function workforce.mission_guard();
create trigger assignment_guard before insert or update or delete on workforce.assignment for each row execute function workforce.assignment_guard();
create trigger resource_claim_guard before insert or update or delete on workforce.resource_claim for each row execute function workforce.resource_claim_guard();
create trigger memory_fact_guard before insert or update or delete on workforce.memory_fact for each row execute function workforce.memory_fact_guard();
create trigger event_guard before insert or update or delete on workforce.event for each row execute function workforce.append_only_guard();
create trigger event_no_truncate before truncate on workforce.event for each statement execute function workforce.append_only_guard();
create trigger exec_message_guard before insert or update or delete on workforce.exec_message for each row execute function workforce.append_only_guard();
create trigger exec_message_no_truncate before truncate on workforce.exec_message for each statement execute function workforce.append_only_guard();

-- ── 5. internal helpers (no grant) ──────────────────────────────────────────
-- one event (the Operations feed)
create or replace function workforce.emit(p_org uuid, p_type text, p_mission text, p_assignment text, p_employee text, p_payload jsonb default '{}'::jsonb)
returns bigint
language sql
security definer
set search_path = pg_catalog, workforce
as $$
  insert into workforce.event (org_id, type, mission_id, assignment_id, employee_id, payload)
  values (p_org, p_type, p_mission, p_assignment, p_employee, coalesce(p_payload, '{}'::jsonb))
  returning event_id
$$;

-- an owner of the org (agent.operator_membership role 'owner'): the CEO authority
create or replace function workforce.is_owner(p_org uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, agent
as $$
  select coalesce(p_user is not null and exists (
    select 1 from agent.operator_membership m where m.org_id = p_org and m.user_id = p_user and m.role = 'owner'), false)
$$;

-- an acting party: an employee of the org (emp_…) or a named operator (auth uid)
create or replace function workforce.actor_ok(p_org uuid, p_actor text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, workforce, agent
as $$
  select coalesce(agent.runtime_is_named_operator(p_actor)
      or exists (select 1 from workforce.employee e where e.employee_id = p_actor and e.org_id = p_org), false)
$$;

-- release every active claim an assignment holds (it reached a terminal state)
create or replace function workforce.release_claims_of(p_assignment text, p_reason text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare c workforce.resource_claim%rowtype; n integer := 0;
begin
  for c in select * from workforce.resource_claim where assignment_id = p_assignment and released_at is null order by claim_id for update loop
    update workforce.resource_claim set released_at = greatest(clock_timestamp(), c.claimed_at + interval '1 microsecond'), release_reason = p_reason where claim_id = c.claim_id;
    perform workforce.emit(c.org_id, 'wf.resource.released', null, p_assignment, c.employee_id,
      jsonb_build_object('resource_type', c.resource_type, 'resource', c.resource_key, 'reason', p_reason));
    n := n + 1;
  end loop;
  return n;
end
$$;

-- one assignment state change event
create or replace function workforce.emit_assignment(a workforce.assignment, p_from text, p_reason text default null)
returns void
language sql
security definer
set search_path = pg_catalog, workforce
as $$
  select workforce.emit(a.org_id, 'wf.assignment.transitioned', a.mission_id, a.assignment_id, a.assignee_employee_id,
    jsonb_build_object('from', p_from, 'to', a.status, 'attempt', a.attempt, 'step', a.step_key)
      || case when p_reason is not null then jsonb_build_object('reason', p_reason) else '{}'::jsonb end)
$$;

-- ── 6. writers (SECURITY DEFINER; the only write path) ──────────────────────
-- Errors RAISE with a 'WF_<CODE>:' message prefix (the store maps it to WorkforceStoreError):
-- NOT_FOUND, CONFLICT, LEASE_LOST, ILLEGAL_TRANSITION, PAYLOAD_REFUSED, CLAIM_HELD,
-- VERSION_MISMATCH, FORBIDDEN. A refused CHECK (23514) is a PAYLOAD_REFUSED.

-- org / employees ─────────────────────────────────────────────────────────────
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

create or replace function workforce.employee_heartbeat(p_org uuid, p_employee_id text, p_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
begin
  update workforce.employee set heartbeat_at = coalesce(p_at, clock_timestamp()) where employee_id = p_employee_id and org_id = p_org;
  if not found then raise exception 'WF_NOT_FOUND: employee %', p_employee_id; end if;
end
$$;

-- missions ────────────────────────────────────────────────────────────────────
-- idempotent: one (org, idempotency_key) = one mission; a replay returns the same mission (created = false)
create or replace function workforce.mission_open(p_org uuid, p_title text, p_directive text, p_requested_by uuid, p_owner_employee_id text,
                                                  p_priority integer, p_due_at timestamptz, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare v_key text; m workforce.mission%rowtype;
begin
  if p_requested_by is null then raise exception 'WF_FORBIDDEN: requested_by must be the named operator'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 200 then raise exception 'WF_PAYLOAD_REFUSED: idempotency_key required (1..200 chars)'; end if;
  v_key := encode(sha256(convert_to('workforce.mission' || chr(31) || p_org::text || chr(31) || p_idempotency_key, 'UTF8')), 'hex');
  select * into m from workforce.mission where org_id = p_org and idempotency_key = v_key;
  if found then return jsonb_build_object('mission', to_jsonb(m), 'created', false); end if;
  if not exists (select 1 from workforce.employee where employee_id = p_owner_employee_id and org_id = p_org) then
    raise exception 'WF_NOT_FOUND: owner employee %', p_owner_employee_id;
  end if;
  insert into workforce.mission (mission_id, org_id, title, directive, owner_employee_id, requested_by, priority, due_at, idempotency_key)
  values ('wfm_' || gen_random_uuid()::text, p_org, p_title, p_directive, p_owner_employee_id, p_requested_by, coalesce(p_priority, 50), p_due_at, v_key)
  on conflict (org_id, idempotency_key) do nothing
  returning * into m;
  if m.mission_id is null then
    select * into m from workforce.mission where org_id = p_org and idempotency_key = v_key;
    return jsonb_build_object('mission', to_jsonb(m), 'created', false);
  end if;
  perform workforce.emit(p_org, 'wf.mission.opened', m.mission_id, null, m.owner_employee_id, jsonb_build_object('status', m.status, 'priority', m.priority));
  return jsonb_build_object('mission', to_jsonb(m), 'created', true);
end
$$;

-- optimistic plan version: the caller names the version it planned against
create or replace function workforce.mission_set_plan(p_org uuid, p_mission_id text, p_objective jsonb, p_playbook_key text, p_plan jsonb, p_expected_version integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare m workforce.mission%rowtype;
begin
  select * into m from workforce.mission where mission_id = p_mission_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: mission %', p_mission_id; end if;
  if m.status in ('completed', 'failed', 'cancelled') then raise exception 'WF_ILLEGAL_TRANSITION: a % mission cannot be re-planned', m.status; end if;
  if p_expected_version is null or m.plan_version <> p_expected_version then
    raise exception 'WF_VERSION_MISMATCH: plan_version is %, expected %', m.plan_version, p_expected_version;
  end if;
  update workforce.mission
     set objective = coalesce(p_objective, objective), playbook_key = coalesce(p_playbook_key, playbook_key),
         plan = coalesce(p_plan, '{}'::jsonb), plan_version = plan_version + 1
   where mission_id = p_mission_id returning * into m;
  perform workforce.emit(p_org, 'wf.mission.plan_set', m.mission_id, null, m.owner_employee_id, jsonb_build_object('plan_version', m.plan_version, 'playbook', m.playbook_key));
  return to_jsonb(m);
end
$$;

-- a repeat of the current status is a no-op (replay-safe); anything else follows the state graph
create or replace function workforce.mission_transition(p_org uuid, p_mission_id text, p_to text, p_report jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare m workforce.mission%rowtype; v_from text;
begin
  select * into m from workforce.mission where mission_id = p_mission_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: mission %', p_mission_id; end if;
  if m.status = p_to then return to_jsonb(m); end if;
  if not workforce.mission_transition_ok(m.status, p_to) then raise exception 'WF_ILLEGAL_TRANSITION: mission % → %', m.status, p_to; end if;
  v_from := m.status;
  update workforce.mission
     set status = p_to, report = coalesce(p_report, report),
         completed_at = case when p_to in ('completed', 'failed', 'cancelled') then clock_timestamp() else null end
   where mission_id = p_mission_id returning * into m;
  perform workforce.emit(p_org, 'wf.mission.transitioned', m.mission_id, null, m.owner_employee_id, jsonb_build_object('from', v_from, 'to', m.status));
  return to_jsonb(m);
end
$$;

-- assignments ─────────────────────────────────────────────────────────────────
-- idempotent on (mission, step_key); born pending (workforce.assignment_claim promotes it)
create or replace function workforce.assignment_create(p_org uuid, p_mission_id text, p_step_key text, p_capability_key text, p_assignee_employee_id text,
                                                       p_delegated_by_employee_id text, p_depends_on text[], p_input jsonb, p_resource_type text,
                                                       p_resource_key text, p_max_attempts integer, p_parent_assignment_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare m workforce.mission%rowtype; a workforce.assignment%rowtype; v_status text;
begin
  select * into m from workforce.mission where mission_id = p_mission_id and org_id = p_org for share;
  if not found then raise exception 'WF_NOT_FOUND: mission %', p_mission_id; end if;
  select * into a from workforce.assignment where mission_id = p_mission_id and step_key = p_step_key;
  if found then return jsonb_build_object('assignment', to_jsonb(a), 'created', false); end if;
  if m.status in ('completed', 'failed', 'cancelled') then raise exception 'WF_ILLEGAL_TRANSITION: a % mission takes no new assignment', m.status; end if;
  select status into v_status from workforce.employee where employee_id = p_assignee_employee_id and org_id = p_org;
  if v_status is null then raise exception 'WF_NOT_FOUND: assignee %', p_assignee_employee_id; end if;
  if v_status = 'retired' then raise exception 'WF_CONFLICT: assignee % is retired', p_assignee_employee_id; end if;
  if p_delegated_by_employee_id is not null and not exists (select 1 from workforce.employee where employee_id = p_delegated_by_employee_id and org_id = p_org) then
    raise exception 'WF_NOT_FOUND: delegating employee %', p_delegated_by_employee_id;
  end if;
  if p_parent_assignment_id is not null and not exists (select 1 from workforce.assignment where assignment_id = p_parent_assignment_id and mission_id = p_mission_id) then
    raise exception 'WF_NOT_FOUND: parent assignment % (same mission)', p_parent_assignment_id;
  end if;
  insert into workforce.assignment (assignment_id, org_id, mission_id, parent_assignment_id, step_key, capability_key, assignee_employee_id,
                                    delegated_by_employee_id, depends_on, input, resource_type, resource_key, max_attempts)
  values ('wfa_' || gen_random_uuid()::text, p_org, p_mission_id, p_parent_assignment_id, p_step_key, p_capability_key, p_assignee_employee_id,
          p_delegated_by_employee_id, coalesce(p_depends_on, '{}'), coalesce(p_input, '{}'::jsonb), p_resource_type, p_resource_key, coalesce(p_max_attempts, 3))
  on conflict (mission_id, step_key) do nothing
  returning * into a;
  if a.assignment_id is null then
    select * into a from workforce.assignment where mission_id = p_mission_id and step_key = p_step_key;
    return jsonb_build_object('assignment', to_jsonb(a), 'created', false);
  end if;
  perform workforce.emit(p_org, 'wf.assignment.created', a.mission_id, a.assignment_id, a.assignee_employee_id,
    jsonb_build_object('step', a.step_key, 'capability', a.capability_key, 'depends_on', to_jsonb(a.depends_on)));
  return jsonb_build_object('assignment', to_jsonb(a), 'created', true);
end
$$;

-- claim ≤ p_limit due assignments: FOR UPDATE SKIP LOCKED. First, inside the same call, every
-- pending row of a live mission whose depends_on steps are ALL completed becomes ready, and a
-- pending row with a failed / cancelled dependency is cancelled (it can never run). Only rows of
-- an active / waiting mission whose assignee is active are claimed.
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

-- internal: the leased row (locked) or LEASE_LOST / NOT_FOUND
create or replace function workforce.assignment_leased(p_org uuid, p_assignment_id text, p_token uuid)
returns workforce.assignment
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare a workforce.assignment%rowtype;
begin
  select * into a from workforce.assignment where assignment_id = p_assignment_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: assignment %', p_assignment_id; end if;
  if p_token is null or a.lease_token is distinct from p_token or a.status not in ('leased', 'running') then
    raise exception 'WF_LEASE_LOST: assignment % is % (lease not held)', p_assignment_id, a.status;
  end if;
  return a;
end
$$;

-- heartbeat + progress under the lease: patch { status?: 'running', output? (merged), evidence? (appended) }; extends the lease
create or replace function workforce.assignment_progress(p_org uuid, p_assignment_id text, p_token uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare a workforce.assignment%rowtype; v_from text; v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
begin
  if jsonb_typeof(v_patch) <> 'object' or exists (select 1 from jsonb_object_keys(v_patch) k where k not in ('status', 'output', 'evidence')) then
    raise exception 'WF_PAYLOAD_REFUSED: patch keys are status, output, evidence';
  end if;
  if v_patch ? 'status' and (v_patch ->> 'status') is distinct from 'running' then raise exception 'WF_ILLEGAL_TRANSITION: progress moves only to running'; end if;
  if v_patch ? 'output' and jsonb_typeof(v_patch -> 'output') <> 'object' then raise exception 'WF_PAYLOAD_REFUSED: output must be an object'; end if;
  if v_patch ? 'evidence' and jsonb_typeof(v_patch -> 'evidence') <> 'array' then raise exception 'WF_PAYLOAD_REFUSED: evidence must be an array'; end if;
  a := workforce.assignment_leased(p_org, p_assignment_id, p_token);
  v_from := a.status;
  update workforce.assignment
     set status = case when v_patch ? 'status' then 'running' else status end,
         output = case when v_patch ? 'output' then coalesce(output, '{}'::jsonb) || (v_patch -> 'output') else output end,
         evidence = case when v_patch ? 'evidence' then evidence || (v_patch -> 'evidence') else evidence end,
         lease_until = greatest(lease_until, clock_timestamp() + make_interval(secs => lease_seconds))
   where assignment_id = p_assignment_id returning * into a;
  if a.status <> v_from then perform workforce.emit_assignment(a, v_from); end if;
  update workforce.employee set last_activity_at = clock_timestamp() where employee_id = a.assignee_employee_id;
  return to_jsonb(a);
end
$$;

-- end of an attempt under the lease. status: completed | failed | ready (alias retry) | waiting_approval | blocked | cancelled.
-- A retry burns an attempt (attempt + 1) and fails once attempt reaches max_attempts. Replaying the
-- same finish with the same token returns the recorded row.
create or replace function workforce.assignment_finish(p_org uuid, p_assignment_id text, p_token uuid, p_status text, p_output jsonb, p_outcome_class text,
                                                       p_evidence jsonb, p_error jsonb, p_retry_after_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare a workforce.assignment%rowtype; v_to text; v_from text; v_attempt integer; v_next timestamptz;
begin
  select * into a from workforce.assignment where assignment_id = p_assignment_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: assignment %', p_assignment_id; end if;
  if p_token is not null and a.finished_token is not distinct from p_token and a.lease_token is null then
    return to_jsonb(a);   -- idempotent replay
  end if;
  v_to := case p_status when 'retry' then 'ready' else p_status end;
  if v_to is null or v_to not in ('completed', 'failed', 'ready', 'waiting_approval', 'blocked', 'cancelled') then
    raise exception 'WF_PAYLOAD_REFUSED: finish status must be completed, failed, ready (retry), waiting_approval, blocked or cancelled';
  end if;
  if v_to = 'completed' and p_outcome_class is null then raise exception 'WF_PAYLOAD_REFUSED: a completed assignment names its outcome_class'; end if;
  if p_output is not null and jsonb_typeof(p_output) <> 'object' then raise exception 'WF_PAYLOAD_REFUSED: output must be an object'; end if;
  if p_evidence is not null and jsonb_typeof(p_evidence) <> 'array' then raise exception 'WF_PAYLOAD_REFUSED: evidence must be an array'; end if;
  if p_retry_after_seconds is not null and p_retry_after_seconds not between 0 and 86400 then raise exception 'WF_PAYLOAD_REFUSED: retry_after_seconds must be 0..86400'; end if;
  a := workforce.assignment_leased(p_org, p_assignment_id, p_token);
  v_from := a.status;
  v_attempt := a.attempt;
  if v_to = 'ready' then
    v_attempt := a.attempt + 1;
    if v_attempt >= a.max_attempts then
      v_to := 'failed';
    else
      v_next := clock_timestamp() + coalesce(make_interval(secs => p_retry_after_seconds), workforce.backoff(v_attempt));
    end if;
  end if;
  update workforce.assignment
     set status = v_to, attempt = v_attempt, next_attempt_at = case when v_to = 'ready' then v_next else next_attempt_at end,
         output = case when p_output is not null then coalesce(output, '{}'::jsonb) || p_output else output end,
         outcome_class = coalesce(p_outcome_class, outcome_class),
         evidence = case when p_evidence is not null then evidence || p_evidence else evidence end,
         last_error = coalesce(p_error, last_error),
         lease_token = null, lease_owner = null, lease_until = null, lease_seconds = null, finished_token = p_token,
         finished_at = case when v_to in ('completed', 'failed', 'cancelled') then clock_timestamp() else null end
   where assignment_id = p_assignment_id returning * into a;
  if v_to in ('completed', 'failed', 'cancelled') then perform workforce.release_claims_of(a.assignment_id, case when v_to = 'cancelled' then 'cancelled' else 'finished' end); end if;
  perform workforce.emit_assignment(a, v_from, case when p_status = 'retry' or (p_status = 'ready') then 'retry' else null end);
  update workforce.employee set last_activity_at = clock_timestamp() where employee_id = a.assignee_employee_id;
  return to_jsonb(a);
end
$$;

-- park the assignment on an R2 runtime job (lease released); resumed by workforce.assignment_resume_job
create or replace function workforce.assignment_wait_job(p_org uuid, p_assignment_id text, p_token uuid, p_runtime_job_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare a workforce.assignment%rowtype; v_from text;
begin
  select * into a from workforce.assignment where assignment_id = p_assignment_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: assignment %', p_assignment_id; end if;
  if a.status = 'waiting_job' and a.finished_token is not distinct from p_token and a.runtime_job_id is not distinct from p_runtime_job_id then
    return to_jsonb(a);   -- idempotent replay
  end if;
  if p_runtime_job_id is null or p_runtime_job_id !~ '^mjob_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'WF_PAYLOAD_REFUSED: runtime_job_id must be an R2 job id (mjob_<uuid>)';
  end if;
  a := workforce.assignment_leased(p_org, p_assignment_id, p_token);
  v_from := a.status;
  update workforce.assignment
     set status = 'waiting_job', runtime_job_id = p_runtime_job_id,
         lease_token = null, lease_owner = null, lease_until = null, lease_seconds = null, finished_token = p_token
   where assignment_id = p_assignment_id returning * into a;
  perform workforce.emit_assignment(a, v_from);
  return to_jsonb(a);
end
$$;

-- resolve a waiting_job assignment from its runtime job's terminal state:
--   completed                      → completed, outcome verified, output = the job result
--   failed | dead_letter | cancelled → ready (attempt + 1, backoff) or failed past max_attempts
-- Any other job state, a different job id or a row that is no longer waiting: no change (changed = false).
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

-- a held assignment (waiting_approval / blocked) is released by a named actor: → ready | cancelled | failed (state graph)
create or replace function workforce.assignment_resolve_hold(p_org uuid, p_assignment_id text, p_to text, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare a workforce.assignment%rowtype; v_from text;
begin
  if not workforce.actor_ok(p_org, p_actor) then raise exception 'WF_FORBIDDEN: actor must be an employee of the org or a named operator'; end if;
  select * into a from workforce.assignment where assignment_id = p_assignment_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: assignment %', p_assignment_id; end if;
  if a.status not in ('waiting_approval', 'blocked') or not workforce.assignment_transition_ok(a.status, p_to) then
    raise exception 'WF_ILLEGAL_TRANSITION: assignment % → %', a.status, p_to;
  end if;
  v_from := a.status;
  update workforce.assignment
     set status = p_to, next_attempt_at = case when p_to = 'ready' then clock_timestamp() else next_attempt_at end,
         finished_at = case when p_to in ('failed', 'cancelled') then clock_timestamp() else null end
   where assignment_id = p_assignment_id returning * into a;
  if p_to in ('failed', 'cancelled') then perform workforce.release_claims_of(a.assignment_id, case when p_to = 'cancelled' then 'cancelled' else 'finished' end); end if;
  perform workforce.emit(p_org, 'wf.assignment.transitioned', a.mission_id, a.assignment_id, a.assignee_employee_id,
    jsonb_build_object('from', v_from, 'to', a.status, 'attempt', a.attempt, 'step', a.step_key, 'reason', 'hold_resolved', 'actor_id', p_actor));
  return to_jsonb(a);
end
$$;

-- reaper: expired leases → ready (attempt + 1, backoff) or failed once attempt reaches max_attempts
create or replace function workforce.assignment_reap(p_org uuid, p_now timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  r workforce.assignment%rowtype;
  a workforce.assignment%rowtype;
  v_attempt integer;
  n_requeued integer := 0; n_failed integer := 0;
begin
  for r in
    select * from workforce.assignment
     where org_id = p_org and status in ('leased', 'running') and lease_until < v_now
     order by lease_until, assignment_id
     limit 200
     for update skip locked
  loop
    v_attempt := r.attempt + 1;
    update workforce.assignment
       set status = case when v_attempt >= max_attempts then 'failed' else 'ready' end,
           attempt = v_attempt,
           next_attempt_at = case when v_attempt >= max_attempts then next_attempt_at else v_now + workforce.backoff(v_attempt) end,
           lease_token = null, lease_owner = null, lease_until = null, lease_seconds = null,
           last_error = jsonb_build_object('code', 'LEASE_EXPIRED', 'attempt', v_attempt, 'max_attempts', r.max_attempts),
           finished_at = case when v_attempt >= max_attempts then v_now else null end
     where assignment_id = r.assignment_id returning * into a;
    if a.status = 'failed' then
      perform workforce.release_claims_of(a.assignment_id, 'finished');
      n_failed := n_failed + 1;
    else
      n_requeued := n_requeued + 1;
    end if;
    perform workforce.emit_assignment(a, r.status, 'lease_expired');
  end loop;
  return jsonb_build_object('requeued', n_requeued, 'failed', n_failed);
end
$$;

-- transfer = re-assign + event (never while leased / running / waiting on a job)
create or replace function workforce.assignment_transfer(p_org uuid, p_assignment_id text, p_to_employee_id text, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare a workforce.assignment%rowtype; v_from_emp text; v_status text;
begin
  if not workforce.actor_ok(p_org, p_actor) then raise exception 'WF_FORBIDDEN: actor must be an employee of the org or a named operator'; end if;
  select * into a from workforce.assignment where assignment_id = p_assignment_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: assignment %', p_assignment_id; end if;
  if a.status in ('completed', 'failed', 'cancelled') then raise exception 'WF_ILLEGAL_TRANSITION: a % assignment cannot be transferred', a.status; end if;
  if a.status in ('leased', 'running', 'waiting_job') then raise exception 'WF_CONFLICT: a % assignment cannot be transferred (release it first)', a.status; end if;
  select status into v_status from workforce.employee where employee_id = p_to_employee_id and org_id = p_org;
  if v_status is null then raise exception 'WF_NOT_FOUND: employee %', p_to_employee_id; end if;
  if v_status = 'retired' then raise exception 'WF_CONFLICT: employee % is retired', p_to_employee_id; end if;
  if a.assignee_employee_id = p_to_employee_id then return to_jsonb(a); end if;
  v_from_emp := a.assignee_employee_id;
  update workforce.assignment set assignee_employee_id = p_to_employee_id where assignment_id = p_assignment_id returning * into a;
  perform workforce.emit(p_org, 'wf.assignment.transferred', a.mission_id, a.assignment_id, a.assignee_employee_id,
    jsonb_build_object('from_employee_id', v_from_emp, 'to_employee_id', p_to_employee_id, 'actor_id', p_actor));
  return to_jsonb(a);
end
$$;

-- cancel every non-terminal assignment of a mission (leases dropped, claims released)
create or replace function workforce.assignment_cancel_mission(p_org uuid, p_mission_id text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare r workforce.assignment%rowtype; a workforce.assignment%rowtype; n integer := 0;
begin
  if not exists (select 1 from workforce.mission where mission_id = p_mission_id and org_id = p_org) then raise exception 'WF_NOT_FOUND: mission %', p_mission_id; end if;
  for r in
    select * from workforce.assignment
     where mission_id = p_mission_id and org_id = p_org and status not in ('completed', 'failed', 'cancelled')
     order by created_at, assignment_id
     for update
  loop
    update workforce.assignment
       set status = 'cancelled', lease_token = null, lease_owner = null, lease_until = null, lease_seconds = null, finished_at = clock_timestamp()
     where assignment_id = r.assignment_id returning * into a;
    perform workforce.release_claims_of(a.assignment_id, 'cancelled');
    perform workforce.emit_assignment(a, r.status, 'mission_cancelled');
    n := n + 1;
  end loop;
  return n;
end
$$;

-- resource ownership ──────────────────────────────────────────────────────────
-- exclusive: CLAIM_HELD while another live holder exists; the same (employee, assignment) renews;
-- an expired claim is released ('expired') and taken over
create or replace function workforce.resource_claim_acquire(p_org uuid, p_resource_type text, p_resource_key text, p_employee_id text, p_assignment_id text, p_ttl_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare c workforce.resource_claim%rowtype; v_now timestamptz := clock_timestamp();
begin
  if p_ttl_seconds is null or p_ttl_seconds not between 1 and 86400 then raise exception 'WF_PAYLOAD_REFUSED: ttl_seconds must be 1..86400'; end if;
  if not exists (select 1 from workforce.employee where employee_id = p_employee_id and org_id = p_org) then raise exception 'WF_NOT_FOUND: employee %', p_employee_id; end if;
  if p_assignment_id is not null and not exists (select 1 from workforce.assignment where assignment_id = p_assignment_id and org_id = p_org) then
    raise exception 'WF_NOT_FOUND: assignment %', p_assignment_id;
  end if;
  select * into c from workforce.resource_claim where org_id = p_org and resource_type = p_resource_type and resource_key = p_resource_key and released_at is null for update;
  if found then
    if c.expires_at <= v_now then
      update workforce.resource_claim set released_at = greatest(v_now, c.claimed_at + interval '1 microsecond'), release_reason = 'expired' where claim_id = c.claim_id;
      perform workforce.emit(p_org, 'wf.resource.released', null, c.assignment_id, c.employee_id,
        jsonb_build_object('resource_type', c.resource_type, 'resource', c.resource_key, 'reason', 'expired'));
    elsif c.employee_id = p_employee_id and c.assignment_id is not distinct from p_assignment_id then
      update workforce.resource_claim set expires_at = greatest(expires_at, v_now + make_interval(secs => p_ttl_seconds)) where claim_id = c.claim_id returning * into c;
      return to_jsonb(c);
    else
      raise exception 'WF_CLAIM_HELD: % % is held by % until %', p_resource_type, p_resource_key, c.employee_id, c.expires_at;
    end if;
  end if;
  begin
    insert into workforce.resource_claim (org_id, resource_type, resource_key, employee_id, assignment_id, claimed_at, expires_at)
    values (p_org, p_resource_type, p_resource_key, p_employee_id, p_assignment_id, v_now, v_now + make_interval(secs => p_ttl_seconds))
    returning * into c;
  exception when unique_violation then
    raise exception 'WF_CLAIM_HELD: % % was claimed concurrently', p_resource_type, p_resource_key;
  end;
  perform workforce.emit(p_org, 'wf.resource.claimed', null, p_assignment_id, p_employee_id,
    jsonb_build_object('resource_type', p_resource_type, 'resource', p_resource_key, 'expires_at', c.expires_at));
  return to_jsonb(c);
end
$$;

-- release the live claim held by this assignment (no-op when it holds none)
create or replace function workforce.resource_claim_release(p_org uuid, p_resource_type text, p_resource_key text, p_assignment_id text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare c workforce.resource_claim%rowtype;
begin
  select * into c from workforce.resource_claim
   where org_id = p_org and resource_type = p_resource_type and resource_key = p_resource_key and released_at is null
     and assignment_id is not distinct from p_assignment_id
   for update;
  if not found then return false; end if;
  update workforce.resource_claim set released_at = greatest(clock_timestamp(), c.claimed_at + interval '1 microsecond'), release_reason = 'released' where claim_id = c.claim_id;
  perform workforce.emit(p_org, 'wf.resource.released', null, c.assignment_id, c.employee_id,
    jsonb_build_object('resource_type', c.resource_type, 'resource', c.resource_key, 'reason', 'released'));
  return true;
end
$$;

create or replace function workforce.resource_claim_reap(p_org uuid, p_now timestamptz default null)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare v_now timestamptz := coalesce(p_now, clock_timestamp()); c workforce.resource_claim%rowtype; n integer := 0;
begin
  for c in
    select * from workforce.resource_claim where org_id = p_org and released_at is null and expires_at <= v_now
     order by expires_at, claim_id limit 500 for update skip locked
  loop
    update workforce.resource_claim set released_at = greatest(v_now, c.claimed_at + interval '1 microsecond'), release_reason = 'expired' where claim_id = c.claim_id;
    perform workforce.emit(p_org, 'wf.resource.released', null, c.assignment_id, c.employee_id,
      jsonb_build_object('resource_type', c.resource_type, 'resource', c.resource_key, 'reason', 'expired'));
    n := n + 1;
  end loop;
  return n;
end
$$;

-- events / conversation / memory ──────────────────────────────────────────────
create or replace function workforce.event_append(p_org uuid, p_type text, p_mission_id text, p_assignment_id text, p_employee_id text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare e workforce.event%rowtype;
begin
  if p_mission_id is not null and not exists (select 1 from workforce.mission where mission_id = p_mission_id and org_id = p_org) then raise exception 'WF_NOT_FOUND: mission %', p_mission_id; end if;
  if p_assignment_id is not null and not exists (select 1 from workforce.assignment where assignment_id = p_assignment_id and org_id = p_org) then raise exception 'WF_NOT_FOUND: assignment %', p_assignment_id; end if;
  if p_employee_id is not null and not exists (select 1 from workforce.employee where employee_id = p_employee_id and org_id = p_org) then raise exception 'WF_NOT_FOUND: employee %', p_employee_id; end if;
  insert into workforce.event (org_id, type, mission_id, assignment_id, employee_id, payload)
  values (p_org, p_type, p_mission_id, p_assignment_id, p_employee_id, coalesce(p_payload, '{}'::jsonb))
  returning * into e;
  return to_jsonb(e);
end
$$;

-- author ceo: an owner of the org; author coo: the org's COO employee
create or replace function workforce.exec_message_append(p_org uuid, p_author text, p_author_user_id uuid, p_author_employee_id text, p_content text, p_refs jsonb, p_mission_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare x workforce.exec_message%rowtype;
begin
  if p_author = 'ceo' then
    if p_author_employee_id is not null or not workforce.is_owner(p_org, p_author_user_id) then raise exception 'WF_FORBIDDEN: a CEO message is authored by an owner of the org'; end if;
  elsif p_author = 'coo' then
    if p_author_user_id is not null or not exists (select 1 from workforce.employee where employee_id = p_author_employee_id and org_id = p_org and role_key = 'coo') then
      raise exception 'WF_FORBIDDEN: a COO message is authored by the COO employee';
    end if;
  else
    raise exception 'WF_PAYLOAD_REFUSED: author must be ceo or coo';
  end if;
  if p_mission_id is not null and not exists (select 1 from workforce.mission where mission_id = p_mission_id and org_id = p_org) then raise exception 'WF_NOT_FOUND: mission %', p_mission_id; end if;
  insert into workforce.exec_message (org_id, mission_id, author, author_user_id, author_employee_id, content, refs)
  values (p_org, p_mission_id, p_author, p_author_user_id, p_author_employee_id, p_content, coalesce(p_refs, '[]'::jsonb))
  returning * into x;
  return to_jsonb(x);
end
$$;

-- supersede semantics: the new fact supersedes the live fact of the same identity (an identical
-- assertion returns the live fact unchanged). verified ⇒ ≥ 1 source ref; ceo_policy only by an owner.
create or replace function workforce.memory_assert(p_org uuid, p_scope text, p_scope_key text, p_fact_key text, p_value jsonb, p_epistemic text,
                                                   p_confidence numeric, p_source_refs jsonb, p_author_employee_id text, p_author_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare live workforce.memory_fact%rowtype; f workforce.memory_fact%rowtype; v_id uuid := gen_random_uuid(); v_refs jsonb := coalesce(p_source_refs, '[]'::jsonb);
begin
  if p_epistemic = 'ceo_policy' and not workforce.is_owner(p_org, p_author_user_id) then
    raise exception 'WF_FORBIDDEN: a ceo_policy fact is authored only by an owner of the org';
  end if;
  if jsonb_typeof(v_refs) <> 'array' then raise exception 'WF_PAYLOAD_REFUSED: source_refs must be an array'; end if;
  if p_epistemic = 'verified' and jsonb_array_length(v_refs) < 1 then raise exception 'WF_PAYLOAD_REFUSED: a verified fact needs at least one source ref'; end if;
  if p_value is null then raise exception 'WF_PAYLOAD_REFUSED: value required'; end if;
  if p_author_employee_id is null and p_author_user_id is null then raise exception 'WF_PAYLOAD_REFUSED: a fact names its author'; end if;
  if p_author_employee_id is not null and not exists (select 1 from workforce.employee where employee_id = p_author_employee_id and org_id = p_org) then
    raise exception 'WF_NOT_FOUND: author employee %', p_author_employee_id;
  end if;
  -- one writer per identity at a time (the partial unique index is the backstop)
  perform pg_advisory_xact_lock(hashtext('workforce.memory' || chr(31) || p_org::text || chr(31) || coalesce(p_scope, '') || chr(31) || coalesce(p_scope_key, '') || chr(31) || coalesce(p_fact_key, '') || chr(31) || coalesce(p_epistemic, '')));
  select * into live from workforce.memory_fact
   where org_id = p_org and scope = p_scope and scope_key = p_scope_key and fact_key = p_fact_key and epistemic = p_epistemic and superseded_at is null
   for update;
  if found and live.value = p_value and live.source_refs = v_refs and live.confidence is not distinct from p_confidence::numeric(4,3)
     and live.author_employee_id is not distinct from p_author_employee_id and live.author_user_id is not distinct from p_author_user_id then
    return to_jsonb(live);   -- identical assertion: no new version
  end if;
  if live.fact_id is not null then
    update workforce.memory_fact set superseded_by = v_id, superseded_at = clock_timestamp() where fact_id = live.fact_id;
  end if;
  insert into workforce.memory_fact (fact_id, org_id, scope, scope_key, fact_key, value, epistemic, confidence, source_refs, author_employee_id, author_user_id)
  values (v_id, p_org, p_scope, p_scope_key, p_fact_key, p_value, p_epistemic, p_confidence, v_refs, p_author_employee_id, p_author_user_id)
  returning * into f;
  perform workforce.emit(p_org, 'wf.memory.asserted', null, null, p_author_employee_id,
    jsonb_build_object('fact_id', f.fact_id, 'scope', f.scope, 'fact', f.fact_key, 'epistemic', f.epistemic, 'superseded_fact_id', live.fact_id));
  return to_jsonb(f);
end
$$;

-- authority / settings / KPIs ─────────────────────────────────────────────────
-- CEO only. With policy_id: a NEW version supersedes it (the old row is revoked). Without: version 1.
create or replace function workforce.policy_put(p_org uuid, p_policy jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare v_old workforce.authority_policy%rowtype; p workforce.authority_policy%rowtype; v_now timestamptz := clock_timestamp();
begin
  if not workforce.is_owner(p_org, p_actor) then raise exception 'WF_FORBIDDEN: authority policies are CEO-authored'; end if;
  if p_policy is null or jsonb_typeof(p_policy) <> 'object' then raise exception 'WF_PAYLOAD_REFUSED: policy must be an object'; end if;
  if exists (select 1 from jsonb_object_keys(p_policy) k where k not in ('policy_id', 'role_key', 'employee_id', 'action_key', 'scope', 'limits', 'risk',
             'min_confidence', 'review', 'valid_from', 'valid_until')) then
    raise exception 'WF_PAYLOAD_REFUSED: unknown policy field';
  end if;
  if p_policy ->> 'employee_id' is not null and not exists (select 1 from workforce.employee where employee_id = p_policy ->> 'employee_id' and org_id = p_org) then
    raise exception 'WF_NOT_FOUND: employee %', p_policy ->> 'employee_id';
  end if;
  if p_policy ->> 'policy_id' is not null then
    select * into v_old from workforce.authority_policy where policy_id = (p_policy ->> 'policy_id')::uuid and org_id = p_org for update;
    if not found then raise exception 'WF_NOT_FOUND: policy %', p_policy ->> 'policy_id'; end if;
    if v_old.status <> 'active' then raise exception 'WF_CONFLICT: policy % is revoked (put a new one)', v_old.policy_id; end if;
    update workforce.authority_policy set status = 'revoked', revoked_at = v_now, revoked_by = p_actor where policy_id = v_old.policy_id;
  end if;
  insert into workforce.authority_policy (org_id, role_key, employee_id, action_key, scope, limits, risk, min_confidence, review, valid_from, valid_until,
                                          created_by, version, supersedes)
  values (p_org, p_policy ->> 'role_key', p_policy ->> 'employee_id', p_policy ->> 'action_key', coalesce(p_policy -> 'scope', '{}'::jsonb),
          coalesce(p_policy -> 'limits', '{}'::jsonb), coalesce(p_policy ->> 'risk', 'low'), (p_policy ->> 'min_confidence')::numeric,
          coalesce(p_policy ->> 'review', 'ceo'), coalesce((p_policy ->> 'valid_from')::timestamptz, v_now), (p_policy ->> 'valid_until')::timestamptz,
          p_actor, coalesce(v_old.version, 0) + 1, v_old.policy_id)
  returning * into p;
  perform workforce.emit(p_org, 'wf.policy.put', null, null, p.employee_id, jsonb_build_object('policy_id', p.policy_id, 'action', p.action_key, 'version', p.version, 'supersedes_id', v_old.policy_id));
  return to_jsonb(p);
end
$$;

create or replace function workforce.policy_revoke(p_org uuid, p_policy_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare p workforce.authority_policy%rowtype;
begin
  if not workforce.is_owner(p_org, p_actor) then raise exception 'WF_FORBIDDEN: authority policies are CEO-authored'; end if;
  select * into p from workforce.authority_policy where policy_id = p_policy_id and org_id = p_org for update;
  if not found then raise exception 'WF_NOT_FOUND: policy %', p_policy_id; end if;
  if p.status = 'revoked' then return to_jsonb(p); end if;
  update workforce.authority_policy set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_actor where policy_id = p_policy_id returning * into p;
  perform workforce.emit(p_org, 'wf.policy.revoked', null, null, p.employee_id, jsonb_build_object('policy_id', p.policy_id, 'action', p.action_key));
  return to_jsonb(p);
end
$$;

create or replace function workforce.settings_put(p_org uuid, p_patch jsonb, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
declare s workforce.settings%rowtype;
begin
  if not workforce.is_owner(p_org, p_actor) then raise exception 'WF_FORBIDDEN: settings are CEO-authored'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('exec_review_price_usd', 'escalation')) then
    raise exception 'WF_PAYLOAD_REFUSED: settings patch keys are exec_review_price_usd, escalation';
  end if;
  insert into workforce.settings (org_id) values (p_org) on conflict (org_id) do nothing;
  update workforce.settings
     set exec_review_price_usd = case when p_patch ? 'exec_review_price_usd' then (p_patch ->> 'exec_review_price_usd')::numeric else exec_review_price_usd end,
         escalation = case when p_patch ? 'escalation' then coalesce(p_patch -> 'escalation', '{}'::jsonb) else escalation end,
         updated_by = p_actor::text, updated_at = clock_timestamp()
   where org_id = p_org returning * into s;
  perform workforce.emit(p_org, 'wf.settings.updated', null, null, null, jsonb_build_object('keys', (select jsonb_agg(k order by k) from jsonb_object_keys(p_patch) k)));
  return to_jsonb(s);
end
$$;

-- the latest value per (subject, kpi, window); unknown ⇔ value NULL
create or replace function workforce.kpi_put(p_org uuid, p_subject_type text, p_subject_key text, p_kpi_key text, p_window text, p_value numeric, p_status text, p_source jsonb)
returns void
language plpgsql
security definer
set search_path = pg_catalog, workforce
as $$
begin
  insert into workforce.kpi_snapshot (org_id, subject_type, subject_key, kpi_key, "window", value, status, source, computed_at)
  values (p_org, p_subject_type, p_subject_key, p_kpi_key, p_window, p_value, p_status, coalesce(p_source, '{}'::jsonb), clock_timestamp())
  on conflict (org_id, subject_type, subject_key, kpi_key, "window")
  do update set value = excluded.value, status = excluded.status, source = excluded.source, computed_at = excluded.computed_at;
end
$$;

-- ── 7. EXECUTE grants: revoke every workforce function from everyone, then grant by name ──
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text sig from pg_proc p where p.pronamespace = 'workforce'::regnamespace loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, agent_api', f.sig);
  end loop;
end $$;

-- pure helpers
grant execute on function workforce.assignment_transition_ok(text, text), workforce.mission_transition_ok(text, text),
  workforce.role_department_ok(text, text), workforce.markets_ok(text[]), workforce.step_keys_ok(text[]), workforce.backoff(integer)
to agent_api, service_role;
-- the writers (the API / the Workforce engine through the store)
grant execute on function
  workforce.employee_upsert(uuid, jsonb, uuid),
  workforce.employee_heartbeat(uuid, text, timestamptz),
  workforce.mission_open(uuid, text, text, uuid, text, integer, timestamptz, text),
  workforce.mission_set_plan(uuid, text, jsonb, text, jsonb, integer),
  workforce.mission_transition(uuid, text, text, jsonb),
  workforce.assignment_create(uuid, text, text, text, text, text, text[], jsonb, text, text, integer, text),
  workforce.assignment_claim(uuid, text, integer, integer, timestamptz),
  workforce.assignment_progress(uuid, text, uuid, jsonb),
  workforce.assignment_finish(uuid, text, uuid, text, jsonb, text, jsonb, jsonb, integer),
  workforce.assignment_wait_job(uuid, text, uuid, text),
  workforce.assignment_resume_job(uuid, text, text, text, jsonb, jsonb),
  workforce.assignment_resolve_hold(uuid, text, text, text),
  workforce.assignment_reap(uuid, timestamptz),
  workforce.assignment_transfer(uuid, text, text, text),
  workforce.assignment_cancel_mission(uuid, text),
  workforce.resource_claim_acquire(uuid, text, text, text, text, integer),
  workforce.resource_claim_release(uuid, text, text, text),
  workforce.resource_claim_reap(uuid, timestamptz),
  workforce.event_append(uuid, text, text, text, text, jsonb),
  workforce.exec_message_append(uuid, text, uuid, text, text, jsonb, text),
  workforce.memory_assert(uuid, text, text, text, jsonb, text, numeric, jsonb, text, uuid),
  workforce.policy_put(uuid, jsonb, uuid),
  workforce.policy_revoke(uuid, uuid, uuid),
  workforce.settings_put(uuid, jsonb, uuid),
  workforce.kpi_put(uuid, text, text, text, text, numeric, text, jsonb)
to agent_api, service_role;
-- emit, emit_assignment, is_owner, actor_ok, release_claims_of, assignment_leased and the guards: no grant (internal)

-- ── 8. RLS + table grants ───────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['settings', 'employee', 'mission', 'assignment', 'resource_claim', 'event', 'exec_message', 'memory_fact', 'authority_policy', 'kpi_snapshot'] loop
    execute format('alter table workforce.%I enable row level security', t);
    execute format('alter table workforce.%I force row level security', t);
    execute format('revoke all on workforce.%I from public, anon, authenticated, service_role, agent_api', t);
    execute format('grant select on workforce.%I to agent_api, service_role, authenticated', t);
    -- agent_api: SINGLE-TENANT using (true), exactly as the S3 agent_api policies (the store binds every query to its org)
    execute format('create policy agent_api_select on workforce.%I for select to agent_api using (true)', t);
    execute format('create policy service_role_select on workforce.%I for select to service_role using (true)', t);
    -- authenticated: read-only, own org (owner: every org)
    execute format('create policy %I on workforce.%I for select to authenticated using (agent.can_read_org(org_id))', t || '_read', t);
  end loop;
end $$;
revoke all on all sequences in schema workforce from public, anon, authenticated, service_role, agent_api;
