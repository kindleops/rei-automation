-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- LeadCommand Intelligence 2.0 — R2 "Persistent intelligence runtime" (foundation).
--
-- APPLY IN ONE TRANSACTION (this file deliberately has no BEGIN/COMMIT so the
-- pretest can run it inside BEGIN … ROLLBACK):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261012140000_intel_runtime.sql
-- Run PROPOSED_20261012140000_intel_runtime_pretest.sql first (it applies this
-- file inside BEGIN … ROLLBACK and asserts every invariant).
-- Requires (applied in prod 10-10): PROPOSED_20261010120000_agent_s3_persistence.sql
-- and PROPOSED_20261010130000_agent_research_ro.sql.
--
-- ONE JOB SYSTEM. agent.research_job is EXTENDED into the mission table; no
-- second job table is created. Rows split into two families by `kind`:
--   kind 'research.*'  (runtime_managed = false) the existing Quick Scan / research
--                      jobs: owned by the JS store (runtime/pg-store.js), state
--                      graph unchanged (contracts/states.js RESEARCH_JOB_TRANSITIONS).
--   any other kind     (runtime_managed = true) missions run by the persistent
--                      runtime. Written ONLY through the agent.runtime_* SECURITY
--                      DEFINER functions below; a trigger refuses every direct
--                      write and every illegal transition.
-- Runtime rows carry run_id NULL and doc.runtime = true, so the S3 store's
-- org-wide run/job cache never loads them (pg-store filters doc.runtime).
--
-- WHY agent.job_event AND NOT agent.run_event: run_event requires one agent.run
-- per mission (a NAMED operator run, cached org-wide by every API process) and
-- serializes every insert on agent.store_head. A scheduled mission every few
-- minutes would grow that cache without bound and contend with every research
-- write. job_event is the same append-only shape (sanitized jsonb, guarded),
-- keyed by job.
--
-- REUSED: agent.runtime_limits (switches + limits), agent.spend_ledger +
-- agent.spend_ledger_guard (budget authority, extended so a reservation can name
-- a job — the guard still serializes and refuses every cap breach), agent.finding
-- (extended so a finding can belong to a job), agent.payload_is_clean (every
-- jsonb), agent.retention_policy (event_days ages out terminal runtime jobs).
--
-- DEFAULT OFF, three times: runtime_limits.runtime_enabled = false, every kind
-- absent from kind_limits (absent = paused), no schedule exists. Plus the Worker
-- flag CRON_AGENT_RUNTIME_ENABLED and the container ceiling AGENT_RUNTIME_ENABLED.
--
-- NOTHING here can send SMS or email or touch send_queue, campaigns,
-- campaign_targets or seller-stage state: the only reads outside schema agent are
-- agent.ops_health_snapshot() (8 fixed public.system_control keys + two LIMITed
-- send_queue counts); there are no writes outside schema agent.
--
-- FUTURE OBJECTS (S3 rule L6): every function/table below revokes PUBLIC, anon,
-- authenticated explicitly and grants agent_api / service_role by name.
-- ════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ── 0. small pure helpers ───────────────────────────────────────────────────
create or replace function agent.runtime_is_named_operator(p text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  -- Gate B: a mission is accountable to a NAMED operator (a Supabase auth uid), never a system identity
  select coalesce(p ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
$$;

create or replace function agent.runtime_kind_valid(p text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select coalesce(p ~ '^[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,40}){1,3}$' and p !~ '^research\.', false)
$$;

-- the ONE runtime state graph (mirrored by RUNTIME_JOB_TRANSITIONS in
-- apps/api/src/lib/agent/runtime/job-runtime.js; a pg test compares every pair)
create or replace function agent.runtime_transition_ok(p_from text, p_to text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select coalesce(case p_from
    when 'waiting_for_approval' then p_to in ('queued', 'cancelled')
    when 'queued'         then p_to in ('claimed', 'cancelled', 'paused')
    when 'claimed'        then p_to in ('running', 'retrying', 'dead_letter', 'cancelled', 'budget_blocked')
    when 'running'        then p_to in ('completed', 'failed', 'retrying', 'dead_letter', 'cancelled', 'budget_blocked', 'waiting_for_approval', 'paused')
    when 'retrying'       then p_to in ('claimed', 'cancelled', 'paused', 'dead_letter')
    when 'paused'         then p_to in ('queued', 'cancelled')
    when 'budget_blocked' then p_to in ('queued', 'cancelled')
    when 'failed'         then p_to in ('queued')
    when 'dead_letter'    then p_to in ('queued')
    else false
  end, false)
$$;

-- exponential backoff: base · 2^(attempt-1), capped
create or replace function agent.runtime_backoff(p_attempt integer, p_base_s integer, p_max_s integer)
returns interval
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select make_interval(secs => least(p_max_s::numeric, p_base_s::numeric * power(2::numeric, greatest(coalesce(p_attempt, 1), 1) - 1))::double precision)
$$;

-- kind_limits: {"<kind>": {"enabled": bool, "max_concurrency": 1..2, "armed_by": "<uuid>"}}
-- enabled=true requires a named armed_by (the operator accountable for event-triggered jobs)
create or replace function agent.runtime_kind_limits_valid(j jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, agent
as $$
declare k text; v jsonb;
begin
  if j is null or jsonb_typeof(j) <> 'object' then return false; end if;
  for k, v in select * from jsonb_each(j) loop
    if not agent.runtime_kind_valid(k) or jsonb_typeof(v) <> 'object' then return false; end if;
    if exists (select 1 from jsonb_object_keys(v) x where x not in ('enabled', 'max_concurrency', 'armed_by')) then return false; end if;
    if jsonb_typeof(v -> 'enabled') is distinct from 'boolean' then return false; end if;
    if v ? 'max_concurrency' and (jsonb_typeof(v -> 'max_concurrency') <> 'number' or (v ->> 'max_concurrency') !~ '^[12]$') then return false; end if;
    if v ? 'armed_by' and not agent.runtime_is_named_operator(v ->> 'armed_by') then return false; end if;
    if (v ->> 'enabled') = 'true' and not (v ? 'armed_by') then return false; end if;
  end loop;
  return true;
end
$$;

-- ── 1. switches + limits: agent.runtime_limits (existing row id = 1) ─────────
alter table agent.runtime_limits
  add column runtime_enabled boolean not null default false,
  add column emergency_stop boolean not null default false,
  add column emergency_stop_at timestamptz,
  add column emergency_stop_by text check (emergency_stop_by is null or length(emergency_stop_by) between 1 and 128),
  add column emergency_stop_reason text check (emergency_stop_reason is null or length(emergency_stop_reason) <= 240),
  add column max_concurrency_global integer not null default 2 check (max_concurrency_global between 1 and 4),
  add column kind_limits jsonb not null default '{}'::jsonb,
  add column lease_seconds integer not null default 60 check (lease_seconds between 15 and 300),
  add column backoff_base_seconds integer not null default 30 check (backoff_base_seconds between 5 and 3600),
  add column backoff_max_seconds integer not null default 3600 check (backoff_max_seconds between 60 and 86400),
  add column tick_max_jobs integer not null default 2 check (tick_max_jobs between 1 and 5),
  add column tick_budget_ms integer not null default 25000 check (tick_budget_ms between 1000 and 45000),
  add column statement_timeout_ms integer not null default 5000 check (statement_timeout_ms between 500 and 5000);
alter table agent.runtime_limits
  add constraint runtime_limits_kind_limits_valid check (agent.runtime_kind_limits_valid(kind_limits)),
  add constraint runtime_limits_stop_stamped check (emergency_stop = (emergency_stop_at is not null)),
  add constraint runtime_limits_backoff_order check (backoff_base_seconds <= backoff_max_seconds);
comment on column agent.runtime_limits.runtime_enabled is 'R2 runtime DB switch (default false). false ⇒ agent.runtime_claim claims nothing and schedules enqueue nothing.';
comment on column agent.runtime_limits.emergency_stop is 'R2 emergency stop: true ⇒ no claim, no schedule enqueue, workers stop at their next step. Anyone with agent.runtime_emergency_stop() may SET it; only service_role (owner path) may clear it.';
comment on column agent.runtime_limits.kind_limits is 'Per-kind switches: {"<kind>":{"enabled":bool,"max_concurrency":1|2,"armed_by":"<operator uuid>"}}. Absent or enabled=false ⇒ that kind claims nothing.';

-- ── 2. the mission table: agent.research_job, extended ─────────────────────
alter table agent.research_job
  add column kind text not null default 'research.quick',
  add column runtime_managed boolean generated always as (kind !~ '^research\.') stored,
  add column requested_by text,
  add column trigger_kind text,
  add column trigger_ref text,
  add column idempotency_key text,
  add column priority smallint not null default 100,
  add column attempt integer not null default 0,
  add column max_attempts integer not null default 3,
  add column next_attempt_at timestamptz,
  add column lease_token uuid,
  add column lease_owner text,
  add column lease_until timestamptz,
  add column claimed_at timestamptz,
  add column heartbeat_at timestamptz,
  add column finished_token uuid,
  add column cancel_requested_at timestamptz,
  add column cancel_requested_by text,
  add column budget_cap_usd numeric(10,4) not null default 0,
  add column input jsonb not null default '{}'::jsonb,
  add column progress jsonb not null default '{}'::jsonb,
  add column checkpoint jsonb not null default '{}'::jsonb,
  add column result jsonb,
  add column last_error jsonb,
  add column schedule_id bigint,
  add column schedule_slot timestamptz,
  add column updated_at timestamptz;

alter table agent.research_job
  alter column run_id drop not null,
  alter column depth drop not null,
  alter column scope_hash drop not null,
  alter column property_ids drop not null,
  alter column gen set default 0;

alter table agent.research_job drop constraint research_job_state_check;
alter table agent.research_job
  add constraint research_job_state_check check (
    (runtime_managed and state in ('queued','claimed','running','completed','waiting_for_approval','paused','retrying','failed','cancelled','budget_blocked','dead_letter'))
    or (not runtime_managed and state in ('draft','queued','running','paused','synthesizing','completed','completed_partial','budget_exhausted','cancelled','failed','expired'))),
  add constraint research_job_kind_shape check (kind ~ '^research\.[a-z_]{1,40}$' or agent.runtime_kind_valid(kind)),
  -- research rows keep every S3 column they always had
  add constraint research_job_research_shape check (runtime_managed or (run_id is not null and depth is not null and scope_hash is not null and property_ids is not null)),
  -- the store-cache marker: doc.runtime = true exactly on runtime rows
  add constraint research_job_doc_marker check ((coalesce(doc ->> 'runtime', '') = 'true') = runtime_managed),
  add constraint research_job_runtime_shape check (not runtime_managed or (
        run_id is null
    and agent.runtime_is_named_operator(requested_by)
    and idempotency_key ~ '^[0-9a-f]{64}$'
    and trigger_kind in ('manual','schedule','event')
    and trigger_ref ~ '^[a-z]{1,12}(:[A-Za-z0-9_.-]{1,80})?$'
    and job_id ~ '^mjob_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and updated_at is not null)),
  add constraint research_job_attempts check (attempt >= 0 and max_attempts between 1 and 10 and attempt <= max_attempts),
  add constraint research_job_priority check (priority between 0 and 1000),
  add constraint research_job_budget_cap check (budget_cap_usd >= 0 and budget_cap_usd <= 2.50),
  add constraint research_job_lease_shape check ((lease_token is null) = (lease_until is null) and (lease_token is null) = (lease_owner is null)),
  add constraint research_job_lease_owner_shape check (lease_owner is null or lease_owner ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  add constraint research_job_runtime_lease_iff_active check (not runtime_managed or ((state in ('claimed','running')) = (lease_token is not null))),
  add constraint research_job_runtime_due check (not runtime_managed or state not in ('queued','retrying') or next_attempt_at is not null),
  add constraint research_job_runtime_terminal_end check (not runtime_managed or ((state in ('completed','failed','cancelled','dead_letter')) = (ended_at is not null))),
  add constraint research_job_cancel_pair check ((cancel_requested_at is null) = (cancel_requested_by is null)),
  add constraint research_job_cancel_by_named check (cancel_requested_by is null or agent.runtime_is_named_operator(cancel_requested_by)),
  add constraint research_job_schedule_pair check ((schedule_id is null) = (schedule_slot is null)),
  add constraint research_job_input_clean check (agent.payload_is_clean(input) and pg_column_size(input) <= 16384),
  add constraint research_job_progress_clean check (agent.payload_is_clean(progress) and pg_column_size(progress) <= 8192),
  add constraint research_job_checkpoint_clean check (agent.payload_is_clean(checkpoint) and pg_column_size(checkpoint) <= 16384),
  add constraint research_job_result_clean check (agent.payload_is_clean(result) and (result is null or pg_column_size(result) <= 16384)),
  add constraint research_job_error_clean check (agent.payload_is_clean(last_error) and (last_error is null or pg_column_size(last_error) <= 4096));

-- idempotency: one job per (kind, key); one job per schedule slot
create unique index research_job_idem_uq on agent.research_job (kind, idempotency_key) where idempotency_key is not null;
create unique index research_job_schedule_slot_uq on agent.research_job (schedule_id, schedule_slot) where schedule_id is not null;
-- claim: due queued/retrying rows in priority order (tiny partial index)
create index research_job_runtime_due_idx on agent.research_job (priority, next_attempt_at) where state in ('queued','retrying') and runtime_managed;
-- reaper + live-concurrency count: leased rows only (≤ max_concurrency_global live)
create index research_job_runtime_leased_idx on agent.research_job (lease_until) where state in ('claimed','running') and runtime_managed;
-- status counts (non-terminal), schedule overlap check, retention
create index research_job_runtime_open_idx on agent.research_job (state) where runtime_managed and ended_at is null;
create index research_job_schedule_open_idx on agent.research_job (schedule_id) where schedule_id is not null and ended_at is null;
create index research_job_runtime_ended_idx on agent.research_job (ended_at) where runtime_managed and ended_at is not null;
create index research_job_runtime_recent_idx on agent.research_job (kind, created_at desc) where runtime_managed;

-- ── 3. the guard: legal transitions + write path, enforced in SQL ────────────
create or replace function agent.research_job_runtime_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, agent
as $$
declare
  v_owner text := (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = tg_relid);
begin
  if tg_op = 'DELETE' then
    -- runtime rows are deleted only by the owner (agent.runtime_purge / FK cascade); research rows as before
    if old.runtime_managed and current_user is distinct from v_owner then
      raise exception 'AGENT_JOB_RUNTIME_WRITE: runtime jobs are never deleted by % (retention only)', current_user using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and new.kind is distinct from old.kind then
    raise exception 'AGENT_JOB_IMMUTABLE: kind' using errcode = 'check_violation';
  end if;
  if not new.runtime_managed then
    return new;   -- research rows: unchanged S3 behaviour (JS state graph)
  end if;
  -- the ONLY write path for runtime rows is the agent.runtime_* SECURITY DEFINER functions (they run as the owner)
  if current_user is distinct from v_owner then
    raise exception 'AGENT_JOB_RUNTIME_WRITE: runtime jobs change only through agent.runtime_* functions (refused for %)', current_user using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.state not in ('queued','waiting_for_approval') or new.attempt <> 0 or new.lease_token is not null then
      raise exception 'AGENT_JOB_ILLEGAL_TRANSITION: a runtime job is born queued or waiting_for_approval (got %)', new.state using errcode = 'check_violation';
    end if;
    new.updated_at := clock_timestamp();
    return new;
  end if;
  if new.job_id <> old.job_id or new.org_id <> old.org_id or new.requested_by is distinct from old.requested_by
     or new.idempotency_key is distinct from old.idempotency_key or new.trigger_kind is distinct from old.trigger_kind
     or new.trigger_ref is distinct from old.trigger_ref or new.schedule_id is distinct from old.schedule_id
     or new.schedule_slot is distinct from old.schedule_slot or new.created_at <> old.created_at then
    raise exception 'AGENT_JOB_IMMUTABLE: identity columns never change' using errcode = 'check_violation';
  end if;
  if new.budget_cap_usd > old.budget_cap_usd then
    raise exception 'AGENT_JOB_BUDGET_RAISE: a mission cap may only be lowered' using errcode = 'check_violation';
  end if;
  if new.state <> old.state then
    if not agent.runtime_transition_ok(old.state, new.state) then
      raise exception 'AGENT_JOB_ILLEGAL_TRANSITION: % → %', old.state, new.state using errcode = 'check_violation';
    end if;
  elsif old.state in ('completed','failed','cancelled','dead_letter') then
    raise exception 'AGENT_JOB_TERMINAL: a % job is immutable (requeue it)', old.state using errcode = 'check_violation';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$$;
create trigger research_job_runtime_guard before insert or update or delete on agent.research_job
  for each row execute function agent.research_job_runtime_guard();

-- ── 4. append-only progress / evidence / audit stream per job ───────────────
create table agent.job_event (
  id bigint generated always as identity primary key,
  job_id text not null references agent.research_job(job_id) on delete cascade,
  org_id uuid not null references agent.org(org_id),
  at timestamptz not null default clock_timestamp(),
  type text not null check (type ~ '^job\.[a-z_]{1,40}(\.[a-z_]{1,40})?$'),
  state text not null check (state ~ '^[a-z_]{1,32}$'),
  attempt integer not null default 0 check (attempt >= 0),
  actor text not null check (actor ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  payload jsonb not null default '{}'::jsonb check (agent.payload_is_clean(payload) and pg_column_size(payload) <= 8192)
);
create index job_event_job_idx on agent.job_event (job_id, id);
create index job_event_org_idx on agent.job_event (org_id, id);

create or replace function agent.job_event_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, agent
as $$
begin
  -- DELETE only by the owner (retention / FK cascade from agent.runtime_purge); never UPDATE / TRUNCATE
  if tg_op = 'DELETE' and current_user = (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = tg_relid) then
    return old;
  end if;
  raise exception 'AGENT_JOB_EVENT_APPEND_ONLY: % refused for %', tg_op, current_user using errcode = 'insufficient_privilege';
end
$$;
create trigger job_event_guard_mut before update or delete on agent.job_event for each row execute function agent.job_event_guard();
create trigger job_event_no_truncate before truncate on agent.job_event for each statement execute function agent.job_event_guard();

-- ── 5. schedules (cron-like interval + watermark) ───────────────────────────
create table agent.runtime_schedule (
  schedule_id bigint generated always as identity primary key,
  org_id uuid not null default '00000000-0000-4000-8000-00000000a001' references agent.org(org_id),
  name text not null unique check (name ~ '^[a-z][a-z0-9_.-]{2,60}$'),
  kind text not null check (agent.runtime_kind_valid(kind)),
  interval_seconds integer not null check (interval_seconds between 60 and 604800),
  next_run_at timestamptz not null,
  enabled boolean not null default false,
  input jsonb not null default '{}'::jsonb check (agent.payload_is_clean(input) and pg_column_size(input) <= 16384),
  watermark jsonb not null default '{}'::jsonb check (agent.payload_is_clean(watermark) and pg_column_size(watermark) <= 16384),
  priority smallint not null default 100 check (priority between 0 and 1000),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  budget_cap_usd numeric(10,4) not null default 0 check (budget_cap_usd >= 0 and budget_cap_usd <= 2.50),
  created_by text not null check (agent.runtime_is_named_operator(created_by)),
  last_slot timestamptz,
  last_job_id text,
  last_outcome text check (last_outcome is null or last_outcome ~ '^[a-z_]{1,40}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index runtime_schedule_due_idx on agent.runtime_schedule (next_run_at) where enabled;
alter table agent.research_job add constraint research_job_schedule_fk foreign key (schedule_id) references agent.runtime_schedule(schedule_id);

-- ── 6. worker heartbeat (stale-worker monitoring) ───────────────────────────
create table agent.runtime_heartbeat (
  worker_id text primary key check (worker_id ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  first_seen_at timestamptz not null default clock_timestamp(),
  last_tick_at timestamptz not null default clock_timestamp(),
  ticks bigint not null default 0 check (ticks >= 0),
  last_summary jsonb not null default '{}'::jsonb check (agent.payload_is_clean(last_summary) and pg_column_size(last_summary) <= 8192)
);

-- ── 7. budget: a reservation may name a job (spend_ledger_guard still decides) ──
alter table agent.spend_ledger add column job_id text references agent.research_job(job_id);
alter table agent.spend_ledger alter column run_id drop not null;
alter table agent.spend_ledger add constraint spend_ledger_one_owner check ((run_id is null) <> (job_id is null));
create index spend_ledger_job on agent.spend_ledger (job_id) where job_id is not null;

-- The cap authority, extended. Run-owned rows: byte-for-byte the 10-10 rules.
-- Job-owned rows: the job must be a leased (claimed/running) runtime job, the
-- ledger operator must be the job's accountable operator, and the per-job cap is
-- min(research_limits.run_usd, job.budget_cap_usd). Day / cycle caps and the
-- research_limits.enabled kill switch apply to both, under the same advisory lock.
create or replace function agent.spend_ledger_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, agent
as $$
declare
  lim agent.research_limits%rowtype;
  v_now timestamptz := clock_timestamp();
  v_day date := (v_now at time zone 'utc')::date;
  v_cycle text := to_char(v_now at time zone 'utc', 'YYYY-MM');
  v_day_total numeric;
  v_cycle_total numeric;
  v_run_total numeric;
  v_esc_calls integer;
  v_esc_total numeric;
  v_run agent.research_run%rowtype;
  v_job agent.research_job%rowtype;
  v_owner_cap numeric;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'AGENT_SPEND_ISOLATION: spend reserves run under read committed only';
  end if;
  if tg_op = 'UPDATE' then
    if new.reserve_id <> old.reserve_id or new.run_id is distinct from old.run_id or new.job_id is distinct from old.job_id
       or new.operator_id <> old.operator_id or new.model <> old.model
       or new.purpose <> old.purpose or new.day <> old.day or new.cycle <> old.cycle or new.reserved_usd <> old.reserved_usd
       or new.created_at <> old.created_at then
      raise exception 'AGENT_SPEND_IMMUTABLE: only state / actual / usage / settled_at may change';
    end if;
    if not ((old.state = 'reserved' and new.state in ('settled','released','unknown'))
            or (old.state = 'unknown' and new.state = 'settled')
            or (old.state = new.state and old.state = 'reserved')) then
      raise exception 'AGENT_SPEND_TRANSITION: % → % refused', old.state, new.state;
    end if;
    if new.state <> old.state then new.settled_at := v_now; end if;
    return new;
  end if;
  -- INSERT: server time is the authority for day / cycle, never the client
  perform pg_advisory_xact_lock(hashtext('agent.spend_ledger'));
  select * into lim from agent.research_limits where id = 1;
  if not found or not lim.enabled then
    raise exception 'AGENT_RESEARCH_DISABLED: research model spend is switched off (agent.research_limits.enabled)';
  end if;
  if new.state <> 'reserved' or new.actual_usd is not null then
    raise exception 'AGENT_SPEND_TRANSITION: a ledger row is born reserved';
  end if;
  if (new.run_id is null) = (new.job_id is null) then
    raise exception 'AGENT_SPEND_OWNER: a reservation names exactly one of run_id / job_id';
  end if;
  if new.run_id is not null then
    select * into v_run from agent.research_run where run_id = new.run_id;
    if not found or v_run.state <> 'running' then
      raise exception 'AGENT_SPEND_RUN_NOT_RUNNING';
    end if;
    if v_run.operator_id <> new.operator_id then
      raise exception 'AGENT_SPEND_ACTOR_MISMATCH: ledger operator must equal the run operator';
    end if;
  else
    select * into v_job from agent.research_job where job_id = new.job_id;
    if not found or not v_job.runtime_managed or v_job.state not in ('claimed','running') then
      raise exception 'AGENT_SPEND_JOB_NOT_RUNNING';
    end if;
    if v_job.lease_until is null or v_job.lease_until <= v_now then
      raise exception 'AGENT_SPEND_JOB_LEASE_EXPIRED';
    end if;
    if v_job.cancel_requested_at is not null then
      raise exception 'AGENT_SPEND_JOB_CANCELLED';
    end if;
    if v_job.requested_by is distinct from new.operator_id then
      raise exception 'AGENT_SPEND_ACTOR_MISMATCH: ledger operator must equal the job operator';
    end if;
  end if;
  new.day := v_day;
  new.cycle := v_cycle;
  new.created_at := v_now;
  select coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)), 0) into v_day_total from agent.spend_ledger where day = v_day;
  if v_day_total + new.reserved_usd > lim.day_usd then
    raise exception 'AGENT_SPEND_CAP_DAY: committed % + reserve % > day cap %', v_day_total, new.reserved_usd, lim.day_usd;
  end if;
  select coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)), 0) into v_cycle_total from agent.spend_ledger where cycle = v_cycle;
  if v_cycle_total + new.reserved_usd > lim.cycle_usd then
    raise exception 'AGENT_SPEND_CAP_CYCLE: committed % + reserve % > cycle cap %', v_cycle_total, new.reserved_usd, lim.cycle_usd;
  end if;
  if new.run_id is not null then
    select coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)), 0),
           count(*) filter (where purpose = 'escalation' and state <> 'released'),
           coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)) filter (where purpose = 'escalation'), 0)
      into v_run_total, v_esc_calls, v_esc_total
      from agent.spend_ledger where run_id = new.run_id;
    if v_run_total + new.reserved_usd > lim.run_usd then
      raise exception 'AGENT_SPEND_CAP_RUN: committed % + reserve % > run cap %', v_run_total, new.reserved_usd, lim.run_usd;
    end if;
  else
    select coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)), 0),
           count(*) filter (where purpose = 'escalation' and state <> 'released'),
           coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)) filter (where purpose = 'escalation'), 0)
      into v_run_total, v_esc_calls, v_esc_total
      from agent.spend_ledger where job_id = new.job_id;
    v_owner_cap := least(lim.run_usd, v_job.budget_cap_usd);
    if v_run_total + new.reserved_usd > v_owner_cap then
      raise exception 'AGENT_SPEND_CAP_JOB: committed % + reserve % > job cap %', v_run_total, new.reserved_usd, v_owner_cap;
    end if;
  end if;
  if new.purpose = 'escalation' then
    if v_esc_calls + 1 > lim.escalation_calls_per_run then
      raise exception 'AGENT_ESCALATION_CAP_CALLS: % escalated call(s) already in this run (cap %)', v_esc_calls, lim.escalation_calls_per_run;
    end if;
    if v_esc_total + new.reserved_usd > lim.escalation_usd_per_run then
      raise exception 'AGENT_ESCALATION_CAP_USD: escalation committed % + reserve % > %', v_esc_total, new.reserved_usd, lim.escalation_usd_per_run;
    end if;
  end if;
  return new;
end
$$;

-- ── 8. findings may belong to a job (no run, no property) ───────────────────
alter table agent.finding add column job_id text references agent.research_job(job_id) on delete cascade;
alter table agent.finding alter column run_id drop not null, alter column property_id drop not null;
alter table agent.finding
  add constraint finding_owner check (run_id is not null or job_id is not null),
  add constraint finding_run_has_property check (run_id is null or property_id is not null);
create unique index finding_job_key_uq on agent.finding (job_id, finding_type, key) where job_id is not null;
create index finding_job_recent_idx on agent.finding (finding_type, retrieved_at desc) where job_id is not null;

create or replace function agent.finding_actor_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, agent
as $$
begin
  if new.run_id is not null then
    if new.actor_user_id is distinct from (select r.operator_id from agent.run r where r.run_id = new.run_id) then
      raise exception 'finding actor mismatch: a finding is stamped with its run''s operator' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- job findings: written only by agent.runtime_record_finding (owner), stamped with the job's operator
  if current_user is distinct from (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = tg_relid) then
    raise exception 'AGENT_JOB_RUNTIME_WRITE: job findings are written only through agent.runtime_record_finding' using errcode = 'insufficient_privilege';
  end if;
  if new.actor_user_id is distinct from (select j.requested_by from agent.research_job j where j.job_id = new.job_id) then
    raise exception 'finding actor mismatch: a job finding is stamped with its job''s operator' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

-- ── 9. runtime functions (SECURITY DEFINER; the only write path) ────────────
-- internal: append one event (no grant)
create or replace function agent.runtime_emit(p_job agent.research_job, p_type text, p_actor text, p_payload jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = pg_catalog, agent
as $$
  insert into agent.job_event (job_id, org_id, type, state, attempt, actor, payload)
  values (p_job.job_id, p_job.org_id, p_type, p_job.state, p_job.attempt, p_actor, coalesce(p_payload, '{}'::jsonb))
$$;

-- internal: the stop reason a worker must honour between steps (NULL = keep going)
create or replace function agent.runtime_stop_reason(p_kind text)
returns text
language sql
stable
security definer
set search_path = pg_catalog, agent
as $$
  select case
    when l.id is null then 'runtime_limits_missing'
    when l.emergency_stop then 'emergency_stop'
    when not l.runtime_enabled then 'runtime_disabled'
    when coalesce((l.kind_limits -> p_kind ->> 'enabled')::boolean, false) is not true then 'kind_disabled'
    else null end
  from (select 1) x left join agent.runtime_limits l on l.id = 1
$$;

-- internal: one enqueue (manual / event / schedule); idempotent on (kind, idempotency_key) and (schedule_id, slot)
create or replace function agent.runtime_enqueue_core(
  p_kind text, p_idempotency_key text, p_input jsonb, p_requested_by text,
  p_trigger_kind text, p_trigger_ref text, p_priority integer, p_max_attempts integer,
  p_budget_cap_usd numeric, p_require_approval boolean, p_schedule_id bigint, p_schedule_slot timestamptz,
  p_not_before timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare
  v_id text := 'mjob_' || gen_random_uuid()::text;
  v_job agent.research_job%rowtype;
begin
  if not agent.runtime_kind_valid(p_kind) then return jsonb_build_object('ok', false, 'reason', 'kind_invalid'); end if;
  if not agent.runtime_is_named_operator(p_requested_by) then return jsonb_build_object('ok', false, 'reason', 'requested_by_not_named_operator'); end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'reason', 'idempotency_key_must_be_sha256_hex'); end if;
  insert into agent.research_job (job_id, org_id, kind, state, requested_by, trigger_kind, trigger_ref, idempotency_key,
                                  priority, attempt, max_attempts, next_attempt_at, budget_cap_usd, input,
                                  schedule_id, schedule_slot, created_at, gen, doc)
  values (v_id, '00000000-0000-4000-8000-00000000a001', p_kind,
          case when p_require_approval then 'waiting_for_approval' else 'queued' end,
          p_requested_by, p_trigger_kind, p_trigger_ref, p_idempotency_key,
          coalesce(p_priority, 100), 0, coalesce(p_max_attempts, 3), greatest(coalesce(p_not_before, clock_timestamp()), clock_timestamp()),
          coalesce(p_budget_cap_usd, 0), coalesce(p_input, '{}'::jsonb), p_schedule_id, p_schedule_slot, clock_timestamp(), 0,
          jsonb_build_object('runtime', true, 'kind', p_kind))
  on conflict do nothing
  returning * into v_job;
  if v_job.job_id is null then
    select * into v_job from agent.research_job
     where (kind = p_kind and idempotency_key = p_idempotency_key)
        or (p_schedule_id is not null and schedule_id = p_schedule_id and schedule_slot = p_schedule_slot)
     limit 1;
    return jsonb_build_object('ok', true, 'deduped', true, 'job_id', v_job.job_id, 'state', v_job.state);
  end if;
  perform agent.runtime_emit(v_job, 'job.enqueued', 'enqueue:' || p_trigger_kind,
    jsonb_build_object('trigger_kind', p_trigger_kind, 'trigger_ref', p_trigger_ref, 'priority', v_job.priority,
                       'max_attempts', v_job.max_attempts, 'budget_cap_usd', v_job.budget_cap_usd, 'requires_approval', coalesce(p_require_approval, false)));
  return jsonb_build_object('ok', true, 'deduped', false, 'job_id', v_job.job_id, 'state', v_job.state);
end
$$;

-- manual enqueue by a named operator (the API route verifies the operator)
create or replace function agent.runtime_enqueue(
  p_kind text, p_idempotency_key text, p_input jsonb, p_requested_by text,
  p_priority integer default 100, p_max_attempts integer default 3, p_budget_cap_usd numeric default 0,
  p_require_approval boolean default false, p_not_before timestamptz default null)
returns jsonb
language sql
security definer
set search_path = pg_catalog, agent
as $$
  select agent.runtime_enqueue_core(p_kind, p_idempotency_key, p_input, p_requested_by, 'manual', 'manual',
    p_priority, p_max_attempts, p_budget_cap_usd, p_require_approval, null, null, p_not_before)
$$;

-- event trigger (no LLM): e.g. an inbound message. The raw event key is hashed and
-- never stored; the job is accountable to the operator who ARMED the kind.
create or replace function agent.runtime_enqueue_event(p_kind text, p_event_key text, p_input jsonb default '{}'::jsonb, p_priority integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare v_armed text;
begin
  if p_event_key is null or length(p_event_key) not between 1 and 200 then return jsonb_build_object('ok', false, 'reason', 'event_key_invalid'); end if;
  select kind_limits -> p_kind ->> 'armed_by' into v_armed from agent.runtime_limits where id = 1;
  if v_armed is null then return jsonb_build_object('ok', false, 'reason', 'kind_not_armed'); end if;
  return agent.runtime_enqueue_core(p_kind, encode(sha256(convert_to('event:' || p_kind || ':' || p_event_key, 'UTF8')), 'hex'),
    p_input, v_armed, 'event', 'event:' || p_kind, p_priority, 3, 0, false, null, null, null);
end
$$;

-- tick: enqueue every due schedule slot at most once; missed slots coalesce into one
create or replace function agent.runtime_enqueue_due_schedules(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare
  s agent.runtime_schedule%rowtype;
  v_now timestamptz := clock_timestamp();
  v_next timestamptz;
  v_stop text;
  v_r jsonb;
  v_outcome text;
  n_enq integer := 0; n_dedup integer := 0; n_skip integer := 0;
begin
  for s in
    select * from agent.runtime_schedule
     where enabled and next_run_at <= v_now
     order by next_run_at
     limit least(greatest(coalesce(p_limit, 10), 1), 50)
     for update skip locked
  loop
    v_next := s.next_run_at + make_interval(secs => s.interval_seconds * (floor(extract(epoch from (v_now - s.next_run_at)) / s.interval_seconds) + 1));
    v_stop := agent.runtime_stop_reason(s.kind);
    v_r := null;
    if v_stop is not null then
      v_outcome := 'skipped_' || v_stop;                                      -- no pile-up while stopped
      n_skip := n_skip + 1;
    elsif exists (select 1 from agent.research_job j where j.schedule_id = s.schedule_id and j.ended_at is null) then
      v_outcome := 'skipped_overlap';                                         -- previous slot still open
      n_skip := n_skip + 1;
    else
      v_r := agent.runtime_enqueue_core(s.kind,
        encode(sha256(convert_to('schedule:' || s.schedule_id || ':' || to_char(s.next_run_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS'), 'UTF8')), 'hex'),
        s.input || jsonb_build_object('schedule_watermark', s.watermark), s.created_by, 'schedule', 'schedule:' || s.schedule_id,
        s.priority, s.max_attempts, s.budget_cap_usd, false, s.schedule_id, s.next_run_at, null);
      if (v_r ->> 'deduped')::boolean then v_outcome := 'deduped'; n_dedup := n_dedup + 1;
      else v_outcome := 'enqueued'; n_enq := n_enq + 1; end if;
    end if;
    update agent.runtime_schedule
       set next_run_at = v_next, last_slot = s.next_run_at,
           last_job_id = coalesce(v_r ->> 'job_id', last_job_id), last_outcome = v_outcome, updated_at = clock_timestamp()
     where schedule_id = s.schedule_id;
  end loop;
  return jsonb_build_object('enqueued', n_enq, 'deduped', n_dedup, 'skipped', n_skip);
end
$$;

-- claim ≤ p_limit due jobs: FOR UPDATE SKIP LOCKED, bounded by the global and per-kind
-- live-lease counts (serialized on one advisory lock so the counts are exact)
create or replace function agent.runtime_claim(p_worker text, p_limit integer default 1, p_kinds text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare
  lim agent.runtime_limits%rowtype;
  v_now timestamptz;
  v_kinds text[];
  v_active jsonb;
  v_total integer;
  v_slots integer;
  v_cap integer;
  v_out jsonb := '[]'::jsonb;
  v_n integer := 0;
  r record;
  j agent.research_job%rowtype;
begin
  if p_worker is null or p_worker !~ '^[A-Za-z0-9_.:-]{1,80}$' then return jsonb_build_object('ok', false, 'reason', 'worker_invalid', 'claimed', '[]'::jsonb); end if;
  select * into lim from agent.runtime_limits where id = 1;
  if not found then return jsonb_build_object('ok', true, 'blocked', 'runtime_limits_missing', 'claimed', '[]'::jsonb); end if;
  if lim.emergency_stop then return jsonb_build_object('ok', true, 'blocked', 'emergency_stop', 'claimed', '[]'::jsonb); end if;
  if not lim.runtime_enabled then return jsonb_build_object('ok', true, 'blocked', 'runtime_disabled', 'claimed', '[]'::jsonb); end if;
  select coalesce(array_agg(k order by k), '{}') into v_kinds
    from jsonb_each(lim.kind_limits) e(k, v)
   where (v ->> 'enabled')::boolean and (p_kinds is null or k = any (p_kinds));
  if cardinality(v_kinds) = 0 then return jsonb_build_object('ok', true, 'blocked', 'no_kind_enabled', 'claimed', '[]'::jsonb); end if;
  perform pg_advisory_xact_lock(hashtext('agent.runtime_claim'));
  v_now := clock_timestamp();
  select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb), coalesce(sum(n), 0)::int into v_active, v_total
    from (select kind, count(*)::int n from agent.research_job
           where state in ('claimed','running') and runtime_managed and lease_until > v_now group by kind) x;
  v_slots := least(greatest(coalesce(p_limit, 1), 0), lim.tick_max_jobs, lim.max_concurrency_global - v_total);
  if v_slots <= 0 then return jsonb_build_object('ok', true, 'blocked', 'concurrency', 'active', v_total, 'claimed', '[]'::jsonb); end if;
  for r in
    select job_id, kind from agent.research_job
     where state in ('queued','retrying') and runtime_managed and next_attempt_at <= v_now
       and kind = any (v_kinds) and cancel_requested_at is null and attempt < max_attempts
     order by priority, next_attempt_at, job_id
     limit v_slots * 4
     for update skip locked
  loop
    v_cap := coalesce((lim.kind_limits -> r.kind ->> 'max_concurrency')::int, 1);
    if coalesce((v_active ->> r.kind)::int, 0) >= v_cap then continue; end if;
    update agent.research_job
       set state = 'claimed', attempt = attempt + 1, lease_token = gen_random_uuid(), lease_owner = p_worker,
           lease_until = v_now + make_interval(secs => lim.lease_seconds), claimed_at = v_now, heartbeat_at = v_now,
           finished_token = null
     where job_id = r.job_id
     returning * into j;
    perform agent.runtime_emit(j, 'job.claimed', p_worker, jsonb_build_object('lease_seconds', lim.lease_seconds));
    v_active := jsonb_set(v_active, array[r.kind], to_jsonb(coalesce((v_active ->> r.kind)::int, 0) + 1));
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'job_id', j.job_id, 'kind', j.kind, 'lease_token', j.lease_token, 'lease_until', j.lease_until, 'attempt', j.attempt,
      'max_attempts', j.max_attempts, 'input', j.input, 'checkpoint', j.checkpoint, 'budget_cap_usd', j.budget_cap_usd,
      'requested_by', j.requested_by, 'schedule_id', j.schedule_id));
    v_n := v_n + 1;
    exit when v_n >= v_slots;
  end loop;
  return jsonb_build_object('ok', true, 'blocked', null, 'claimed', v_out);
end
$$;

-- internal: lock the leased row or return NULL (lease lost)
create or replace function agent.runtime_leased(p_job_id text, p_token uuid)
returns agent.research_job
language sql
security definer
set search_path = pg_catalog, agent
as $$
  select * from agent.research_job
   where job_id = p_job_id and runtime_managed and lease_token = p_token and state in ('claimed','running')
   for update
$$;

-- claimed → running (cancel / stop are honoured before the first step)
create or replace function agent.runtime_start(p_job_id text, p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare j agent.research_job%rowtype; v_stop text;
begin
  j := agent.runtime_leased(p_job_id, p_token);
  if j.job_id is null then return jsonb_build_object('ok', false, 'reason', 'lease_lost'); end if;
  v_stop := agent.runtime_stop_reason(j.kind);
  if j.state = 'claimed' then
    update agent.research_job set state = 'running', heartbeat_at = clock_timestamp() where job_id = p_job_id returning * into j;
    perform agent.runtime_emit(j, 'job.started', j.lease_owner, '{}'::jsonb);
  end if;
  return jsonb_build_object('ok', true, 'state', j.state, 'cancel_requested', j.cancel_requested_at is not null, 'stop', v_stop);
end
$$;

-- between steps: heartbeat + extend lease + progress/checkpoint (+ optional event); returns cancel/stop flags
create or replace function agent.runtime_checkpoint(p_job_id text, p_token uuid, p_progress jsonb default null, p_checkpoint jsonb default null,
                                                    p_event_type text default null, p_event_payload jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare j agent.research_job%rowtype; v_lease integer; v_stop text;
begin
  j := agent.runtime_leased(p_job_id, p_token);
  if j.job_id is null or j.state <> 'running' then return jsonb_build_object('ok', false, 'reason', 'lease_lost'); end if;
  v_stop := agent.runtime_stop_reason(j.kind);
  if j.cancel_requested_at is not null or v_stop is not null then
    -- the worker must stop: record nothing for a step that will not run
    return jsonb_build_object('ok', true, 'cancel_requested', j.cancel_requested_at is not null, 'stop', v_stop, 'lease_until', j.lease_until);
  end if;
  select lease_seconds into v_lease from agent.runtime_limits where id = 1;
  update agent.research_job
     set heartbeat_at = clock_timestamp(), lease_until = clock_timestamp() + make_interval(secs => coalesce(v_lease, 60)),
         progress = coalesce(p_progress, progress), checkpoint = coalesce(p_checkpoint, checkpoint)
   where job_id = p_job_id returning * into j;
  if p_event_type is not null then
    perform agent.runtime_emit(j, p_event_type, j.lease_owner, coalesce(p_event_payload, '{}'::jsonb));
  end if;
  return jsonb_build_object('ok', true, 'cancel_requested', false, 'stop', null, 'lease_until', j.lease_until);
end
$$;

-- end of an attempt. Outcomes: completed | failed | retry | cancelled | release | waiting_for_approval | paused.
-- Idempotent: repeating the same finish with the same token returns the recorded state.
-- Any still-open reservation of the job becomes 'unknown' (stays counted; never under-records).
create or replace function agent.runtime_finish(p_job_id text, p_token uuid, p_outcome text, p_result jsonb default null, p_error jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare
  j agent.research_job%rowtype;
  lim agent.runtime_limits%rowtype;
  v_to text;
  v_attempt integer;
  v_next timestamptz;
begin
  select * into j from agent.research_job where job_id = p_job_id and runtime_managed for update;
  if j.job_id is null then return jsonb_build_object('ok', false, 'reason', 'job_not_found'); end if;
  if j.finished_token is not distinct from p_token and j.lease_token is null then
    return jsonb_build_object('ok', true, 'idempotent', true, 'state', j.state);
  end if;
  if j.lease_token is distinct from p_token or j.state not in ('claimed','running') then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost', 'state', j.state);
  end if;
  select * into lim from agent.runtime_limits where id = 1;
  v_attempt := j.attempt;
  v_next := null;
  v_to := case p_outcome
    when 'completed' then 'completed'
    when 'failed' then 'failed'
    when 'cancelled' then 'cancelled'
    when 'waiting_for_approval' then 'waiting_for_approval'
    when 'paused' then 'paused'
    when 'retry' then case when j.attempt >= j.max_attempts then 'dead_letter' else 'retrying' end
    when 'release' then 'retrying'
    else null end;
  if v_to is null then return jsonb_build_object('ok', false, 'reason', 'outcome_invalid'); end if;
  if p_outcome = 'retry' and v_to = 'retrying' then
    v_next := clock_timestamp() + agent.runtime_backoff(j.attempt, lim.backoff_base_seconds, lim.backoff_max_seconds);
  elsif p_outcome = 'release' then
    v_attempt := greatest(j.attempt - 1, 0);   -- a stop/deadline release does not burn an attempt
    v_next := clock_timestamp() + make_interval(secs => lim.backoff_base_seconds);
  end if;
  update agent.spend_ledger set state = 'unknown' where job_id = p_job_id and state = 'reserved';
  update agent.research_job
     set state = v_to, attempt = v_attempt, next_attempt_at = coalesce(v_next, next_attempt_at),
         lease_token = null, lease_owner = null, lease_until = null, finished_token = p_token,
         result = coalesce(p_result, result), last_error = coalesce(p_error, last_error),
         ended_at = case when v_to in ('completed','failed','cancelled','dead_letter') then clock_timestamp() else null end,
         progress = case when v_to = 'completed' then progress || jsonb_build_object('pct', 100) else progress end
   where job_id = p_job_id returning * into j;
  perform agent.runtime_emit(j, 'job.' || v_to, coalesce(p_outcome, 'finish'),
    jsonb_build_object('outcome', p_outcome) || case when p_error is not null then jsonb_build_object('error', p_error) else '{}'::jsonb end
      || case when v_next is not null then jsonb_build_object('next_attempt_at', v_next) else '{}'::jsonb end);
  return jsonb_build_object('ok', true, 'idempotent', false, 'state', j.state, 'next_attempt_at', v_next);
end
$$;

-- reaper: expired leases → retrying (backoff) or dead_letter (attempts exhausted) or cancelled (cancel requested)
create or replace function agent.runtime_reap(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare
  lim agent.runtime_limits%rowtype;
  r agent.research_job%rowtype;
  j agent.research_job%rowtype;
  v_to text;
  n_retry integer := 0; n_dead integer := 0; n_cancel integer := 0;
begin
  select * into lim from agent.runtime_limits where id = 1;
  for r in
    select * from agent.research_job
     where state in ('claimed','running') and runtime_managed and lease_until < clock_timestamp()
     order by lease_until
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
     for update skip locked
  loop
    update agent.spend_ledger set state = 'unknown' where job_id = r.job_id and state = 'reserved';
    v_to := case when r.cancel_requested_at is not null then 'cancelled'
                 when r.attempt >= r.max_attempts then 'dead_letter'
                 else 'retrying' end;
    update agent.research_job
       set state = v_to, lease_token = null, lease_owner = null, lease_until = null,
           next_attempt_at = case when v_to = 'retrying' then clock_timestamp() + agent.runtime_backoff(r.attempt, coalesce(lim.backoff_base_seconds, 30), coalesce(lim.backoff_max_seconds, 3600)) else next_attempt_at end,
           ended_at = case when v_to in ('cancelled','dead_letter') then clock_timestamp() else null end,
           last_error = jsonb_build_object('code', 'LEASE_EXPIRED', 'attempt', r.attempt)
     where job_id = r.job_id returning * into j;
    perform agent.runtime_emit(j, 'job.lease_expired', 'reaper', jsonb_build_object('to', v_to, 'attempt', r.attempt, 'max_attempts', r.max_attempts));
    if v_to = 'retrying' then n_retry := n_retry + 1; elsif v_to = 'dead_letter' then n_dead := n_dead + 1; else n_cancel := n_cancel + 1; end if;
  end loop;
  return jsonb_build_object('retrying', n_retry, 'dead_letter', n_dead, 'cancelled', n_cancel);
end
$$;

-- mission budget: reserve through the existing ledger. A refusal by
-- spend_ledger_guard (switch off / day / cycle / job / escalation cap) parks the
-- job in budget_blocked; any other error propagates.
create or replace function agent.runtime_reserve(p_job_id text, p_token uuid, p_model text, p_reserved_usd numeric, p_purpose text default 'default')
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare j agent.research_job%rowtype; v_id uuid; v_code text;
begin
  j := agent.runtime_leased(p_job_id, p_token);
  if j.job_id is null then return jsonb_build_object('ok', false, 'reason', 'lease_lost'); end if;
  begin
    insert into agent.spend_ledger (run_id, job_id, operator_id, model, purpose, day, cycle, reserved_usd, state)
    values (null, p_job_id, j.requested_by, p_model, coalesce(p_purpose, 'default'), (clock_timestamp() at time zone 'utc')::date,
            to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM'), p_reserved_usd, 'reserved')
    returning reserve_id into v_id;
  exception when others then
    v_code := substring(sqlerrm from '^(AGENT_[A-Z_]+)');
    if v_code is null then raise; end if;
    update agent.spend_ledger set state = 'unknown' where job_id = p_job_id and state = 'reserved';
    update agent.research_job
       set state = 'budget_blocked', lease_token = null, lease_owner = null, lease_until = null, finished_token = p_token,
           last_error = jsonb_build_object('code', v_code)
     where job_id = p_job_id returning * into j;
    perform agent.runtime_emit(j, 'job.budget_blocked', 'spend_ledger_guard', jsonb_build_object('code', v_code, 'requested_usd', p_reserved_usd));
    return jsonb_build_object('ok', false, 'reason', v_code, 'state', 'budget_blocked');
  end;
  perform agent.runtime_emit(j, 'job.budget_reserved', j.lease_owner, jsonb_build_object('reserve_id', v_id, 'reserved_usd', p_reserved_usd, 'model', p_model));
  return jsonb_build_object('ok', true, 'reserve_id', v_id);
end
$$;

create or replace function agent.runtime_settle(p_job_id text, p_token uuid, p_reserve_id uuid, p_actual_usd numeric, p_usage jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare j agent.research_job%rowtype; n integer;
begin
  j := agent.runtime_leased(p_job_id, p_token);
  if j.job_id is null then return jsonb_build_object('ok', false, 'reason', 'lease_lost'); end if;
  if p_actual_usd is null then
    update agent.spend_ledger set state = 'released' where reserve_id = p_reserve_id and job_id = p_job_id and state = 'reserved';
  else
    update agent.spend_ledger set state = 'settled', actual_usd = p_actual_usd, usage = p_usage
     where reserve_id = p_reserve_id and job_id = p_job_id and state in ('reserved','unknown');
  end if;
  get diagnostics n = row_count;
  if n = 1 then
    perform agent.runtime_emit(j, case when p_actual_usd is null then 'job.budget_released' else 'job.budget_settled' end, j.lease_owner,
      jsonb_build_object('reserve_id', p_reserve_id, 'actual_usd', p_actual_usd));
  end if;
  return jsonb_build_object('ok', n = 1);
end
$$;

-- evidence: one finding per (job, finding_type, key); a retry of the same job overwrites, never duplicates
create or replace function agent.runtime_record_finding(p_job_id text, p_token uuid, p_finding_type text, p_key text, p_value jsonb,
                                                        p_source_id text, p_confidence numeric default 1, p_citation text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare j agent.research_job%rowtype; v_id text;
begin
  j := agent.runtime_leased(p_job_id, p_token);
  if j.job_id is null or j.state <> 'running' then return jsonb_build_object('ok', false, 'reason', 'lease_lost'); end if;
  if p_finding_type !~ '^[a-z]{2,20}\.[a-z_]{2,60}$' or p_key !~ '^[a-z][a-z0-9_.:-]{0,79}$' or p_source_id !~ '^[a-z][a-z0-9_.:-]{0,79}$' then
    return jsonb_build_object('ok', false, 'reason', 'finding_shape_invalid');
  end if;
  insert into agent.finding (finding_id, run_id, job_id, org_id, property_id, finding_type, key, evidence_status, source_class, source_id,
                             citation, value, confidence, retrieved_at, actor_user_id, gen, doc)
  values ('fnd_' || gen_random_uuid()::text, null, j.job_id, j.org_id, null, p_finding_type, p_key, 'internal_record', 'internal_record', p_source_id,
          p_citation, p_value, coalesce(p_confidence, 1), clock_timestamp(), j.requested_by, 0,
          jsonb_build_object('finding_type', p_finding_type, 'key', p_key, 'source_id', p_source_id))
  on conflict (job_id, finding_type, key) where job_id is not null
  do update set value = excluded.value, confidence = excluded.confidence, retrieved_at = excluded.retrieved_at, citation = excluded.citation
  returning finding_id into v_id;
  perform agent.runtime_emit(j, 'job.finding', j.lease_owner, jsonb_build_object('finding_id', v_id, 'finding_type', p_finding_type, 'key', p_key));
  return jsonb_build_object('ok', true, 'finding_id', v_id);
end
$$;

-- a schedule handler advances its watermark (checkpoint across runs)
create or replace function agent.runtime_schedule_watermark(p_job_id text, p_token uuid, p_watermark jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare j agent.research_job%rowtype;
begin
  j := agent.runtime_leased(p_job_id, p_token);
  if j.job_id is null or j.schedule_id is null then return jsonb_build_object('ok', false, 'reason', 'lease_lost_or_unscheduled'); end if;
  update agent.runtime_schedule set watermark = coalesce(p_watermark, '{}'::jsonb), updated_at = clock_timestamp() where schedule_id = j.schedule_id;
  return jsonb_build_object('ok', true);
end
$$;

-- ── operator controls (named operator; the API verifies the session) ────────
create or replace function agent.runtime_cancel(p_job_id text, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare j agent.research_job%rowtype;
begin
  if not agent.runtime_is_named_operator(p_by) then return jsonb_build_object('ok', false, 'reason', 'by_not_named_operator'); end if;
  select * into j from agent.research_job where job_id = p_job_id and runtime_managed for update;
  if j.job_id is null then return jsonb_build_object('ok', false, 'reason', 'job_not_found'); end if;
  if j.state in ('completed','failed','cancelled','dead_letter') then return jsonb_build_object('ok', true, 'noop', true, 'state', j.state); end if;
  if j.state in ('claimed','running') then
    -- cooperative: the worker sees cancel_requested at its next step (or the reaper cancels at lease expiry)
    update agent.research_job set cancel_requested_at = coalesce(cancel_requested_at, clock_timestamp()), cancel_requested_by = coalesce(cancel_requested_by, p_by)
     where job_id = p_job_id returning * into j;
    perform agent.runtime_emit(j, 'job.cancel_requested', 'operator', '{}'::jsonb);
    return jsonb_build_object('ok', true, 'pending', true, 'state', j.state);
  end if;
  update agent.research_job
     set state = 'cancelled', ended_at = clock_timestamp(),
         cancel_requested_at = coalesce(cancel_requested_at, clock_timestamp()), cancel_requested_by = coalesce(cancel_requested_by, p_by)
   where job_id = p_job_id returning * into j;
  perform agent.runtime_emit(j, 'job.cancelled', 'operator', '{}'::jsonb);
  return jsonb_build_object('ok', true, 'pending', false, 'state', j.state);
end
$$;

create or replace function agent.runtime_requeue(p_job_id text, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare j agent.research_job%rowtype; v_from text;
begin
  if not agent.runtime_is_named_operator(p_by) then return jsonb_build_object('ok', false, 'reason', 'by_not_named_operator'); end if;
  select * into j from agent.research_job where job_id = p_job_id and runtime_managed for update;
  if j.job_id is null then return jsonb_build_object('ok', false, 'reason', 'job_not_found'); end if;
  if j.state not in ('dead_letter','failed','budget_blocked','paused') then return jsonb_build_object('ok', false, 'reason', 'not_requeueable', 'state', j.state); end if;
  v_from := j.state;
  update agent.research_job
     set state = 'queued', attempt = 0, next_attempt_at = clock_timestamp(), ended_at = null,
         cancel_requested_at = null, cancel_requested_by = null, finished_token = null
   where job_id = p_job_id returning * into j;
  perform agent.runtime_emit(j, 'job.requeued', 'operator', jsonb_build_object('from', v_from));
  return jsonb_build_object('ok', true, 'state', j.state, 'from', v_from);
end
$$;

create or replace function agent.runtime_approve(p_job_id text, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare j agent.research_job%rowtype;
begin
  if not agent.runtime_is_named_operator(p_by) then return jsonb_build_object('ok', false, 'reason', 'by_not_named_operator'); end if;
  select * into j from agent.research_job where job_id = p_job_id and runtime_managed for update;
  if j.job_id is null or j.state <> 'waiting_for_approval' then return jsonb_build_object('ok', false, 'reason', 'not_waiting_for_approval', 'state', j.state); end if;
  update agent.research_job set state = 'queued', next_attempt_at = clock_timestamp() where job_id = p_job_id returning * into j;
  perform agent.runtime_emit(j, 'job.approved', 'operator', '{}'::jsonb);
  return jsonb_build_object('ok', true, 'state', j.state);
end
$$;

create or replace function agent.runtime_pause(p_job_id text, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare j agent.research_job%rowtype;
begin
  if not agent.runtime_is_named_operator(p_by) then return jsonb_build_object('ok', false, 'reason', 'by_not_named_operator'); end if;
  select * into j from agent.research_job where job_id = p_job_id and runtime_managed for update;
  if j.job_id is null or j.state not in ('queued','retrying') then return jsonb_build_object('ok', false, 'reason', 'not_pausable', 'state', j.state); end if;
  update agent.research_job set state = 'paused' where job_id = p_job_id returning * into j;
  perform agent.runtime_emit(j, 'job.paused', 'operator', '{}'::jsonb);
  return jsonb_build_object('ok', true, 'state', j.state);
end
$$;

-- stopping is always safe, so the API role may SET the emergency stop / pause a kind;
-- clearing either is an owner act (service_role UPDATE on agent.runtime_limits)
create or replace function agent.runtime_emergency_stop(p_by text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
begin
  if not agent.runtime_is_named_operator(p_by) then return jsonb_build_object('ok', false, 'reason', 'by_not_named_operator'); end if;
  update agent.runtime_limits
     set emergency_stop = true, emergency_stop_at = coalesce(emergency_stop_at, clock_timestamp()),
         emergency_stop_by = coalesce(emergency_stop_by, p_by), emergency_stop_reason = coalesce(emergency_stop_reason, left(p_reason, 240)),
         updated_at = now(), updated_by = p_by
   where id = 1;
  return jsonb_build_object('ok', true, 'emergency_stop', true);
end
$$;

create or replace function agent.runtime_pause_kind(p_kind text, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
begin
  if not agent.runtime_is_named_operator(p_by) then return jsonb_build_object('ok', false, 'reason', 'by_not_named_operator'); end if;
  update agent.runtime_limits
     set kind_limits = jsonb_set(kind_limits, array[p_kind, 'enabled'], 'false'::jsonb), updated_at = now(), updated_by = p_by
   where id = 1 and kind_limits ? p_kind;
  return jsonb_build_object('ok', true, 'kind', p_kind, 'enabled', false);
end
$$;

-- owner path: create / update a schedule (born disabled unless p_enabled)
create or replace function agent.runtime_upsert_schedule(p_name text, p_kind text, p_interval_seconds integer, p_created_by text,
                                                         p_input jsonb default '{}'::jsonb, p_enabled boolean default false,
                                                         p_first_run_at timestamptz default null, p_budget_cap_usd numeric default 0)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare v_id bigint;
begin
  insert into agent.runtime_schedule (name, kind, interval_seconds, next_run_at, enabled, input, created_by, budget_cap_usd)
  values (p_name, p_kind, p_interval_seconds, coalesce(p_first_run_at, clock_timestamp()), coalesce(p_enabled, false), coalesce(p_input, '{}'::jsonb), p_created_by, coalesce(p_budget_cap_usd, 0))
  on conflict (name) do update set kind = excluded.kind, interval_seconds = excluded.interval_seconds, enabled = excluded.enabled,
                                   input = excluded.input, created_by = excluded.created_by, budget_cap_usd = excluded.budget_cap_usd, updated_at = clock_timestamp()
  returning schedule_id into v_id;
  return jsonb_build_object('ok', true, 'schedule_id', v_id);
end
$$;

create or replace function agent.runtime_disable_schedule(p_name text, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
begin
  if not agent.runtime_is_named_operator(p_by) then return jsonb_build_object('ok', false, 'reason', 'by_not_named_operator'); end if;
  update agent.runtime_schedule set enabled = false, updated_at = clock_timestamp() where name = p_name;
  return jsonb_build_object('ok', found);
end
$$;

create or replace function agent.runtime_heartbeat(p_worker text, p_summary jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
begin
  insert into agent.runtime_heartbeat (worker_id, last_tick_at, ticks, last_summary)
  values (p_worker, clock_timestamp(), 1, coalesce(p_summary, '{}'::jsonb))
  on conflict (worker_id) do update set last_tick_at = clock_timestamp(), ticks = agent.runtime_heartbeat.ticks + 1, last_summary = excluded.last_summary;
  return jsonb_build_object('ok', true);
end
$$;

-- read model for the UI / monitoring (bounded: open rows by state via partial index, last-24h terminal via ended_at index)
create or replace function agent.runtime_status()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, agent
as $$
  select jsonb_build_object(
    'at', clock_timestamp(),
    'limits', (select jsonb_build_object('runtime_enabled', runtime_enabled, 'emergency_stop', emergency_stop, 'emergency_stop_at', emergency_stop_at,
                                         'max_concurrency_global', max_concurrency_global, 'kind_limits', kind_limits, 'lease_seconds', lease_seconds,
                                         'tick_max_jobs', tick_max_jobs, 'tick_budget_ms', tick_budget_ms) from agent.runtime_limits where id = 1),
    'open', (select coalesce(jsonb_object_agg(state, n), '{}'::jsonb) from (select state, count(*) n from agent.research_job where runtime_managed and ended_at is null group by state) x),
    'ended_24h', (select coalesce(jsonb_object_agg(state, n), '{}'::jsonb) from (select state, count(*) n from agent.research_job where runtime_managed and ended_at is not null and ended_at > clock_timestamp() - interval '24 hours' group by state) x),
    'heartbeats', (select coalesce(jsonb_agg(jsonb_build_object('worker_id', worker_id, 'last_tick_at', last_tick_at, 'ticks', ticks, 'age_s', round(extract(epoch from clock_timestamp() - last_tick_at))) order by last_tick_at desc), '[]'::jsonb)
                     from (select * from agent.runtime_heartbeat order by last_tick_at desc limit 10) h),
    'schedules', (select coalesce(jsonb_agg(jsonb_build_object('schedule_id', schedule_id, 'name', name, 'kind', kind, 'enabled', enabled, 'interval_seconds', interval_seconds,
                                                              'next_run_at', next_run_at, 'last_slot', last_slot, 'last_outcome', last_outcome) order by schedule_id), '[]'::jsonb)
                    from (select * from agent.runtime_schedule order by schedule_id limit 50) s))
$$;

-- retention: terminal runtime jobs older than retention_policy.event_days (events + findings cascade);
-- jobs that own spend_ledger rows are kept (the ledger never loses history)
create or replace function agent.runtime_purge(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare n integer;
begin
  delete from agent.research_job
   where job_id in (
     select j.job_id from agent.research_job j
      where j.runtime_managed and j.ended_at is not null
        and j.ended_at < clock_timestamp() - make_interval(days => (select event_days from agent.retention_policy where id = 1))
        and not exists (select 1 from agent.spend_ledger l where l.job_id = j.job_id)
      order by j.ended_at
      limit least(greatest(coalesce(p_limit, 200), 1), 1000));
  get diagnostics n = row_count;
  if n > 0 then
    insert into agent.deletion_log (kind, requested_by, counts) values ('retention', 'agent.runtime_purge', jsonb_build_object('runtime_jobs', n));
  end if;
  return jsonb_build_object('runtime_jobs', n);
end
$$;

-- ops.health_check input: 8 fixed system_control keys + two LIMITed send_queue counts.
-- Reads only; every query hits a unique/btree index (system_control_pkey,
-- idx_send_queue_status_sched, idx_send_queue_queue_status) and is capped at 1000 rows.
create or replace function agent.ops_health_snapshot(p_overdue_minutes integer default 15, p_processing_stale_minutes integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, agent
as $$
declare v_keys jsonb; v_overdue integer; v_stuck integer;
begin
  select coalesce(jsonb_object_agg(key, left(value, 64)), '{}'::jsonb) into v_keys
    from public.system_control
   where key = any (array['queue_processor_heartbeat_at','campaign_feeder_heartbeat_at','followup_no_response_heartbeat_at',
                          'seller_state_reconcile_heartbeat_at','webhook_delivery_recovery_last_at',
                          'queue_processor_mode','queue_execution_mode','queue_emergency_stop_at']);
  select count(*)::int into v_overdue from (
    select 1 from public.send_queue
     where queue_status in ('queued','retry') and scheduled_for < now() - make_interval(mins => greatest(p_overdue_minutes, 1))
     limit 1000) s;
  select count(*)::int into v_stuck from (
    select 1 from public.send_queue
     where queue_status = 'processing' and scheduled_for < now() - make_interval(mins => greatest(p_processing_stale_minutes, 1))
     limit 1000) s;
  return jsonb_build_object('at', now(), 'keys', v_keys,
    'queue', jsonb_build_object('overdue_queued_or_retry', v_overdue, 'stale_processing', v_stuck, 'cap', 1000,
                                'overdue_minutes', p_overdue_minutes, 'processing_stale_minutes', p_processing_stale_minutes));
end
$$;

-- ── 10. EXECUTE grants: revoke every new function from everyone, then grant by name ──
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text sig from pg_proc p
     where p.pronamespace = 'agent'::regnamespace
       and p.proname in ('runtime_is_named_operator','runtime_kind_valid','runtime_transition_ok','runtime_backoff','runtime_kind_limits_valid',
                         'research_job_runtime_guard','job_event_guard','spend_ledger_guard','finding_actor_guard',
                         'runtime_emit','runtime_stop_reason','runtime_enqueue_core','runtime_enqueue','runtime_enqueue_event',
                         'runtime_enqueue_due_schedules','runtime_claim','runtime_leased','runtime_start','runtime_checkpoint',
                         'runtime_finish','runtime_reap','runtime_reserve','runtime_settle','runtime_record_finding',
                         'runtime_schedule_watermark','runtime_cancel','runtime_requeue','runtime_approve','runtime_pause',
                         'runtime_emergency_stop','runtime_pause_kind','runtime_upsert_schedule','runtime_disable_schedule',
                         'runtime_heartbeat','runtime_status','runtime_purge','ops_health_snapshot')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- pure helpers (used inside CHECKs evaluated as the writing role)
grant execute on function agent.runtime_is_named_operator(text), agent.runtime_kind_valid(text), agent.runtime_transition_ok(text, text),
  agent.runtime_backoff(integer, integer, integer), agent.runtime_kind_limits_valid(jsonb) to agent_api, service_role;
-- the worker (tick) and the API (operator controls, event triggers, status)
grant execute on function
  agent.runtime_enqueue(text, text, jsonb, text, integer, integer, numeric, boolean, timestamptz),
  agent.runtime_enqueue_event(text, text, jsonb, integer),
  agent.runtime_enqueue_due_schedules(integer),
  agent.runtime_claim(text, integer, text[]),
  agent.runtime_start(text, uuid),
  agent.runtime_checkpoint(text, uuid, jsonb, jsonb, text, jsonb),
  agent.runtime_finish(text, uuid, text, jsonb, jsonb),
  agent.runtime_reap(integer),
  agent.runtime_reserve(text, uuid, text, numeric, text),
  agent.runtime_settle(text, uuid, uuid, numeric, jsonb),
  agent.runtime_record_finding(text, uuid, text, text, jsonb, text, numeric, text),
  agent.runtime_schedule_watermark(text, uuid, jsonb),
  agent.runtime_cancel(text, text),
  agent.runtime_requeue(text, text),
  agent.runtime_approve(text, text),
  agent.runtime_pause(text, text),
  agent.runtime_emergency_stop(text, text),
  agent.runtime_pause_kind(text, text),
  agent.runtime_disable_schedule(text, text),
  agent.runtime_heartbeat(text, jsonb),
  agent.runtime_status(),
  agent.runtime_purge(integer),
  agent.ops_health_snapshot(integer, integer)
to agent_api, service_role;
-- owner path only
grant execute on function agent.runtime_upsert_schedule(text, text, integer, text, jsonb, boolean, timestamptz, numeric) to service_role;
-- runtime_emit, runtime_stop_reason, runtime_enqueue_core, runtime_leased and the trigger functions: no grant (internal)

-- ── 11. RLS + table grants ──────────────────────────────────────────────────
alter table agent.job_event enable row level security;
alter table agent.runtime_schedule enable row level security;
alter table agent.runtime_heartbeat enable row level security;
alter table agent.job_event force row level security;
alter table agent.runtime_schedule force row level security;
alter table agent.runtime_heartbeat force row level security;

revoke all on agent.job_event, agent.runtime_schedule, agent.runtime_heartbeat from public, anon, authenticated, service_role;
revoke all on sequence agent.job_event_id_seq, agent.runtime_schedule_schedule_id_seq from public, anon, authenticated, service_role;

-- read-only for the API roles: every write goes through the functions above
grant select on agent.job_event, agent.runtime_schedule, agent.runtime_heartbeat to agent_api, service_role;
grant select on agent.job_event to authenticated;
create policy agent_api_select on agent.job_event for select to agent_api using (true);
create policy agent_api_select on agent.runtime_schedule for select to agent_api using (true);
create policy agent_api_select on agent.runtime_heartbeat for select to agent_api using (true);
create policy job_event_read on agent.job_event for select to authenticated using (agent.can_read_org(org_id));

comment on table agent.job_event is 'R2 runtime: append-only progress / evidence / audit stream per runtime job. Written only by agent.runtime_* (SECURITY DEFINER). The UI reads these rows; nothing animates state that is not here.';
comment on table agent.runtime_schedule is 'R2 runtime: interval schedules. A tick enqueues each due slot at most once (unique (schedule_id, schedule_slot) + sha256 idempotency key). Born disabled.';
comment on table agent.runtime_heartbeat is 'R2 runtime: one row per tick worker (last_tick_at) for stale-worker monitoring.';
