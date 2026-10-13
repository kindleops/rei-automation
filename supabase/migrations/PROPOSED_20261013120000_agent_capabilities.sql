-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- LeadCommand Intelligence Command 2.0 — increment B: capability approvals +
-- the capability audit (apps/api/src/lib/agent/capabilities/**).
--
-- APPLY IN ONE TRANSACTION (no BEGIN/COMMIT here so the pretest can run it
-- inside BEGIN … ROLLBACK):
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261013120000_agent_capabilities.sql
-- Run PROPOSED_20261013120000_agent_capabilities_pretest.sql first.
-- Requires (applied in prod 10-10): PROPOSED_20261010120000_agent_s3_persistence.sql
-- (agent.org, agent.operator_membership, agent.payload_is_clean, role agent_api).
-- Independent of PROPOSED_20261012140000_intel_runtime.sql (R2); missions.create
-- needs R2 at call time and refuses cleanly without it.
--
-- REUSED, not duplicated: agent.operator_membership (who may request / decide),
-- agent.payload_is_clean (every jsonb column), agent.org (tenancy).
-- EVALUATED, not reused: the S1 approval service (agent/approvals) keeps its
-- approvals in the run store and pg-store refuses to persist them; its exact
-- payload-hash rule is reused in JS. public ops approval requests
-- (proactive-notifications) are Discord campaign alerts, not state-bound.
--
-- agent.approval_request — one pending human decision: target, exact intended
-- state change, current-state snapshot hash, payload hash, expiry, approver,
-- decision, execution result, idempotency key. Written ONLY through the two
-- SECURITY DEFINER functions below; a trigger enforces the state graph,
-- immutability, membership of the decider and refuses DELETE.
-- agent.capability_audit — append-only record of every capability decision.
--
-- No phone numbers, names or message text are stored: thread references are
-- sealed (thr_<letters>), message bodies are hashed, and the CHECKs re-verify.
-- Nothing here can send, launch, enqueue or touch any public.* table.
--
-- FUTURE OBJECTS (S3 rule L6): every object revokes PUBLIC, anon, authenticated
-- explicitly and grants agent_api / service_role by name.
-- ════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ── approval requests ────────────────────────────────────────────────────────
create table agent.approval_request (
  approval_id text primary key check (approval_id ~ '^apr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  org_id uuid not null references agent.org(org_id),
  capability_id text not null check (capability_id ~ '^[a-z][a-z_]*\.[a-z][a-z0-9_]*$' and length(capability_id) <= 80),
  capability_version integer not null check (capability_version between 1 and 10000),
  tier text not null check (tier in ('within_approved_policy', 'requires_explicit_approval')),
  requested_by uuid not null,
  provenance text not null check (provenance in ('operator', 'model', 'untrusted_content')),
  target jsonb not null check (jsonb_typeof(target) = 'object' and octet_length(target::text) <= 4000 and agent.payload_is_clean(target)),
  intended_change jsonb not null check (jsonb_typeof(intended_change) = 'object' and octet_length(intended_change::text) <= 8000 and agent.payload_is_clean(intended_change)),
  summary jsonb not null default '[]'::jsonb check (jsonb_typeof(summary) = 'array' and jsonb_array_length(summary) <= 12 and octet_length(summary::text) <= 4000 and agent.payload_is_clean(summary)),
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null check (idempotency_key ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending', 'executing', 'executed', 'failed', 'denied', 'expired', 'refused_drift', 'cancelled')),
  expires_at timestamptz not null,
  decided_by uuid,
  decided_at timestamptz,
  decision text check (decision in ('approve', 'deny')),
  execution_result jsonb check (execution_result is null or (octet_length(execution_result::text) <= 4000 and agent.payload_is_clean(execution_result))),
  executed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key),
  check (expires_at > created_at and expires_at <= created_at + interval '1 day'),
  check (state = 'pending' or state = 'cancelled' or (decided_by is not null and decided_at is not null and decision is not null)),
  check ((state in ('executed', 'failed')) = (executed_at is not null))
);
create index approval_request_org_state_idx on agent.approval_request (org_id, state, created_at desc);
comment on table agent.approval_request is 'Capability approvals (Intelligence 2.0 B): one exact intended change bound to a current-state snapshot hash. Written only by agent.capability_approval_insert / agent.capability_approval_transition. Approve re-reads state (drift ⇒ refused_drift), then executes through the existing UI service path.';

create or replace function agent.capability_approval_transition_ok(p_from text, p_to text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  -- mirrored by APPROVAL_TRANSITIONS in apps/api/src/lib/agent/capabilities/stores.js
  select coalesce(case p_from
    when 'pending'   then p_to in ('executing', 'denied', 'expired', 'refused_drift', 'cancelled')
    when 'executing' then p_to in ('executed', 'failed')
    else false end, false)
$$;

create or replace function agent.approval_request_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, agent
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'agent.approval_request is never deleted (decision history is kept)' using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'pending' then raise exception 'an approval is born pending' using errcode = 'check_violation'; end if;
    if not exists (select 1 from agent.operator_membership m where m.org_id = new.org_id and m.user_id = new.requested_by) then
      raise exception 'requested_by is not a member of the org' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- UPDATE: immutable request, legal transition, decider is a member
  if (new.approval_id, new.org_id, new.capability_id, new.capability_version, new.tier, new.requested_by, new.provenance,
      new.target, new.intended_change, new.summary, new.snapshot_hash, new.payload_hash, new.idempotency_key, new.expires_at, new.created_at)
     is distinct from
     (old.approval_id, old.org_id, old.capability_id, old.capability_version, old.tier, old.requested_by, old.provenance,
      old.target, old.intended_change, old.summary, old.snapshot_hash, old.payload_hash, old.idempotency_key, old.expires_at, old.created_at) then
    raise exception 'approval request fields are immutable' using errcode = 'check_violation';
  end if;
  if new.state is distinct from old.state and not agent.capability_approval_transition_ok(old.state, new.state) then
    raise exception 'illegal approval transition % → %', old.state, new.state using errcode = 'check_violation';
  end if;
  if new.state = old.state then
    raise exception 'an approval update must change state' using errcode = 'check_violation';
  end if;
  if old.decided_by is not null and new.decided_by is distinct from old.decided_by then
    raise exception 'the decider is immutable once recorded' using errcode = 'check_violation';
  end if;
  if new.decided_by is not null and not exists (select 1 from agent.operator_membership m where m.org_id = new.org_id and m.user_id = new.decided_by) then
    raise exception 'decided_by is not a member of the org' using errcode = 'check_violation';
  end if;
  if new.state = 'executing' and now() > old.expires_at then
    raise exception 'approval expired' using errcode = 'check_violation';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$$;
create trigger approval_request_guard before insert or update or delete on agent.approval_request
  for each row execute function agent.approval_request_guard();

-- insert (dedupe on org + idempotency key). Returns {inserted, row}.
create or replace function agent.capability_approval_insert(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare v agent.approval_request%rowtype;
begin
  insert into agent.approval_request (approval_id, org_id, capability_id, capability_version, tier, requested_by, provenance,
                                      target, intended_change, summary, snapshot_hash, payload_hash, idempotency_key, expires_at, created_at)
  values (p ->> 'approval_id', (p ->> 'org_id')::uuid, p ->> 'capability_id', (p ->> 'capability_version')::int, p ->> 'tier',
          (p ->> 'requested_by')::uuid, p ->> 'provenance', p -> 'target', p -> 'intended_change', coalesce(p -> 'summary', '[]'::jsonb),
          p ->> 'snapshot_hash', p ->> 'payload_hash', p ->> 'idempotency_key', (p ->> 'expires_at')::timestamptz,
          least(coalesce((p ->> 'created_at')::timestamptz, now()), now() + interval '5 seconds'))
  on conflict (org_id, idempotency_key) do nothing
  returning * into v;
  if v.approval_id is not null then
    return jsonb_build_object('inserted', true, 'row', to_jsonb(v));
  end if;
  select * into v from agent.approval_request where org_id = (p ->> 'org_id')::uuid and idempotency_key = p ->> 'idempotency_key';
  return jsonb_build_object('inserted', false, 'row', to_jsonb(v));
end
$$;

-- compare-and-set transition; patch keys limited to the decision / execution fields
create or replace function agent.capability_approval_transition(p_org uuid, p_id text, p_from text[], p_to text, p_patch jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare v agent.approval_request%rowtype; k text;
begin
  for k in select jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) loop
    if k not in ('decided_by', 'decided_at', 'decision', 'execution_result', 'executed_at') then
      raise exception 'patch key % not allowed', k using errcode = 'check_violation';
    end if;
  end loop;
  update agent.approval_request
     set state = p_to,
         decided_by = coalesce((p_patch ->> 'decided_by')::uuid, decided_by),
         decided_at = coalesce((p_patch ->> 'decided_at')::timestamptz, decided_at),
         decision = coalesce(p_patch ->> 'decision', decision),
         execution_result = case when p_patch ? 'execution_result' then p_patch -> 'execution_result' else execution_result end,
         executed_at = coalesce((p_patch ->> 'executed_at')::timestamptz, executed_at)
   where org_id = p_org and approval_id = p_id and state = any (p_from)
  returning * into v;
  if v.approval_id is null then return null; end if;
  return to_jsonb(v);
end
$$;

-- ── capability audit (append-only) ───────────────────────────────────────────
create table agent.capability_audit (
  id bigint generated always as identity primary key,
  org_id uuid not null references agent.org(org_id),
  capability_id text not null check (length(capability_id) <= 80),
  capability_version integer,
  actor uuid not null,
  source text not null check (source in ('model', 'operator', 'approval')),
  tier text check (tier in ('autonomous_internal', 'within_approved_policy', 'requires_explicit_approval', 'never')),
  decision text not null check (decision in ('read', 'executed', 'approval_requested', 'refused', 'failed')),
  code text check (code is null or (length(code) <= 80 and code ~ '^[A-Za-z0-9_.:-]+$')),
  idempotency_key text check (idempotency_key is null or idempotency_key ~ '^[0-9a-f]{64}$'),
  input_hash text check (input_hash is null or input_hash ~ '^[0-9a-f]{64}$'),
  approval_id text,
  summary jsonb not null default '{}'::jsonb check (octet_length(summary::text) <= 4000 and agent.payload_is_clean(summary)),
  at timestamptz not null default now()
);
create index capability_audit_actor_idx on agent.capability_audit (org_id, actor, capability_id, at desc);
create index capability_audit_idem_idx on agent.capability_audit (org_id, idempotency_key) where idempotency_key is not null;
comment on table agent.capability_audit is 'Capability decisions (Intelligence 2.0 B): every read, executed write, prepared approval, refusal and failure. Append-only; drives per-day caps and write idempotency replay.';

create or replace function agent.capability_audit_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, agent
as $$
begin
  raise exception 'agent.capability_audit is append-only' using errcode = 'check_violation';
end
$$;
create trigger capability_audit_append_only before update or delete on agent.capability_audit
  for each row execute function agent.capability_audit_guard();

-- ── grants + RLS ─────────────────────────────────────────────────────────────
revoke all on agent.approval_request, agent.capability_audit from public, anon, authenticated, service_role;
revoke all on sequence agent.capability_audit_id_seq from public, anon, authenticated, service_role;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text sig from pg_proc p
            where p.pronamespace = 'agent'::regnamespace
              and p.proname in ('capability_approval_transition_ok', 'approval_request_guard', 'capability_approval_insert', 'capability_approval_transition', 'capability_audit_guard')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
grant execute on function agent.capability_approval_transition_ok(text, text) to agent_api, service_role;
grant execute on function agent.capability_approval_insert(jsonb), agent.capability_approval_transition(uuid, text, text[], text, jsonb) to agent_api, service_role;

-- approvals: read-only for the API role; every write goes through the two functions above
grant select on agent.approval_request to agent_api, service_role;
-- audit: read + append
grant select, insert on agent.capability_audit to agent_api, service_role;
grant usage on sequence agent.capability_audit_id_seq to agent_api, service_role;
-- authenticated: own org read (no write grant)
grant select on agent.approval_request, agent.capability_audit to authenticated;

alter table agent.approval_request enable row level security;
alter table agent.approval_request force row level security;
alter table agent.capability_audit enable row level security;
alter table agent.capability_audit force row level security;
-- SINGLE-TENANT (same S4 gate as the S3 policies): agent_api policies are using (true)
create policy agent_api_select on agent.approval_request for select to agent_api using (true);
create policy agent_api_select on agent.capability_audit for select to agent_api using (true);
create policy agent_api_insert on agent.capability_audit for insert to agent_api with check (true);
create policy approval_request_read on agent.approval_request for select to authenticated using (agent.can_read_org(org_id));
create policy capability_audit_read on agent.capability_audit for select to authenticated using (agent.can_read_org(org_id));
