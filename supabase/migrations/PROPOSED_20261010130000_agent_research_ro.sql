-- PROPOSED ONLY — read-only research agent (owner GO 10-10: Gates B–F collapsed
-- into one approval for a STRICTLY READ-ONLY agent). NOT applied by this file's
-- presence; the coordinator applies it after PROPOSED_20261010120000_agent_s3_persistence.sql.
--
-- Adds, inside schema agent only:
--   agent.research_limits   1 row: DB kill switch + HARD spend caps (lower-only CHECKs:
--                           ≤ $10 / UTC day, ≤ $150 / UTC calendar month, ≤ $2.50 / run,
--                           ≤ 2 escalated calls and ≤ $2 escalation spend per run)
--   agent.research_run      one row per question (operator = verified Supabase user)
--   agent.research_audit    append-only audit: who, what tool, params hash, rows, cost
--   agent.spend_ledger      reserve → settle ledger for every model call; the INSERT
--                           trigger serializes writers and refuses any reserve that
--                           would cross a day / cycle / run / escalation cap.
--
-- Nothing here grants anon or authenticated anything. agent_api (the API's
-- least-privilege role, created by the S3 migration) gets select/insert/update on
-- the run + ledger, insert-only on the audit, and SELECT on the limits row. Only
-- service_role (owner path) may change research_limits, and only DOWN to the
-- code ceilings enforced by CHECK.
--
-- Inherent limits, stated plainly:
--   * actual_usd is the provider-reported usage × the price table; a settle can
--     exceed its reserve only if the provider bills more tokens than the bound
--     (prompt UTF-8 bytes + max_tokens), which is not expected; it is recorded, never hidden.
--   * a reserve whose outcome is unknown (crash, network error after send) stays
--     counted at its reserved value forever — the ledger never under-records.
begin;

create table agent.research_limits (
  id smallint primary key check (id = 1),
  enabled boolean not null default false,                         -- DB kill switch: false ⇒ every reserve is refused
  day_usd numeric(10,4) not null default 10 check (day_usd >= 0 and day_usd <= 10),
  cycle_usd numeric(10,4) not null default 150 check (cycle_usd >= 0 and cycle_usd <= 150),
  run_usd numeric(10,4) not null default 2.50 check (run_usd >= 0 and run_usd <= 2.50),
  escalation_calls_per_run smallint not null default 2 check (escalation_calls_per_run between 0 and 2),
  escalation_usd_per_run numeric(10,4) not null default 2 check (escalation_usd_per_run >= 0 and escalation_usd_per_run <= 2),
  updated_at timestamptz not null default now(),
  updated_by text not null default 'migration' check (length(updated_by) between 1 and 128)
);
insert into agent.research_limits (id) values (1);

create table agent.research_run (
  run_id text primary key check (run_id ~ '^ask_[A-Za-z0-9_-]{8,80}$'),
  org_id uuid not null references agent.org(org_id),
  operator_id text not null check (length(operator_id) between 1 and 128),
  state text not null check (state in ('running','completed','refused','failed','cancelled')),
  question_sha256 text not null check (question_sha256 ~ '^[0-9a-f]{64}$'),
  question_chars integer not null check (question_chars between 1 and 4000),
  created_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  default_model text check (default_model is null or default_model ~ '^claude-[a-z0-9-]{3,60}$'),
  escalation_model text check (escalation_model is null or escalation_model ~ '^claude-[a-z0-9-]{3,60}$'),
  model_calls integer not null default 0 check (model_calls between 0 and 16),
  escalated_calls integer not null default 0 check (escalated_calls between 0 and 2),
  escalated_usd numeric(12,6) not null default 0 check (escalated_usd >= 0 and escalated_usd <= 2),
  tool_calls integer not null default 0 check (tool_calls between 0 and 48),
  cost_usd numeric(12,6) not null default 0 check (cost_usd >= 0 and cost_usd <= 2.50),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  outcome text check (outcome is null or outcome ~ '^[A-Za-z0-9_:.-]{1,80}$'),
  answer jsonb check (agent.payload_is_clean(answer)),
  doc jsonb not null default '{}'::jsonb check (agent.payload_is_clean(doc)),
  constraint research_run_terminal_has_end check ((state = 'running') = (ended_at is null)),
  constraint research_run_operator_named check (operator_id !~* '^(principal:|system:|service[:_-]?|service_role$|anon$|authenticated$|ops[-_]dashboard|shared[:_-])')
);
create index research_run_operator_day on agent.research_run (operator_id, created_at desc);

create table agent.research_audit (
  id bigint generated always as identity primary key,
  run_id text not null references agent.research_run(run_id),
  at timestamptz not null default clock_timestamp(),
  actor_user_id text not null check (length(actor_user_id) between 1 and 128),
  kind text not null check (kind in ('run_start','tool_call','tool_refused','model_call','model_refused','escalation','escalation_declined','budget_refused','run_end')),
  name text check (name is null or name ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  params_sha256 text check (params_sha256 is null or params_sha256 ~ '^[0-9a-f]{64}$'),
  rows_returned integer check (rows_returned is null or rows_returned >= 0),
  cost_usd numeric(12,6) check (cost_usd is null or cost_usd >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  outcome text check (outcome is null or outcome ~ '^[A-Za-z0-9_:.-]{1,80}$'),
  doc jsonb not null default '{}'::jsonb check (agent.payload_is_clean(doc))
);
create index research_audit_run on agent.research_audit (run_id, id);

create table agent.spend_ledger (
  reserve_id uuid primary key default gen_random_uuid(),
  run_id text not null references agent.research_run(run_id),
  operator_id text not null check (length(operator_id) between 1 and 128),
  model text not null check (model ~ '^claude-[a-z0-9-]{3,60}$'),
  purpose text not null check (purpose in ('default','escalation')),
  day date not null,
  cycle text not null check (cycle ~ '^[0-9]{4}-[0-9]{2}$'),
  reserved_usd numeric(12,6) not null check (reserved_usd > 0 and reserved_usd <= 2.50),
  actual_usd numeric(12,6) check (actual_usd is null or actual_usd >= 0),
  state text not null check (state in ('reserved','settled','released','unknown')),
  usage jsonb check (agent.payload_is_clean(usage)),
  price_ref text check (price_ref is null or price_ref ~ '^[A-Za-z0-9_.:@-]{1,80}$'),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  constraint spend_ledger_settled_has_actual check ((state = 'settled') = (actual_usd is not null))
);
create index spend_ledger_day on agent.spend_ledger (day);
create index spend_ledger_cycle on agent.spend_ledger (cycle);
create index spend_ledger_run on agent.spend_ledger (run_id);

-- committed value of a ledger row: settled ⇒ actual, released ⇒ 0, reserved / unknown ⇒ the reserve
create or replace function agent.spend_committed(p_state text, p_reserved numeric, p_actual numeric)
returns numeric
language sql
immutable
set search_path = pg_catalog
as $$ select case p_state when 'settled' then p_actual when 'released' then 0 else p_reserved end $$;

-- The cap authority. Every reserve takes one transaction-scoped advisory lock, so
-- concurrent reserves (any number of API instances) are serialized; under READ
-- COMMITTED each statement after the lock sees every reserve committed before it.
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
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'AGENT_SPEND_ISOLATION: spend reserves run under read committed only';
  end if;
  if tg_op = 'UPDATE' then
    if new.reserve_id <> old.reserve_id or new.run_id <> old.run_id or new.operator_id <> old.operator_id or new.model <> old.model
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
  select * into v_run from agent.research_run where run_id = new.run_id;
  if not found or v_run.state <> 'running' then
    raise exception 'AGENT_SPEND_RUN_NOT_RUNNING';
  end if;
  if v_run.operator_id <> new.operator_id then
    raise exception 'AGENT_SPEND_ACTOR_MISMATCH: ledger operator must equal the run operator';
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
  select coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)), 0),
         count(*) filter (where purpose = 'escalation' and state <> 'released'),
         coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)) filter (where purpose = 'escalation'), 0)
    into v_run_total, v_esc_calls, v_esc_total
    from agent.spend_ledger where run_id = new.run_id;
  if v_run_total + new.reserved_usd > lim.run_usd then
    raise exception 'AGENT_SPEND_CAP_RUN: committed % + reserve % > run cap %', v_run_total, new.reserved_usd, lim.run_usd;
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
create trigger spend_ledger_guard_ins before insert on agent.spend_ledger for each row execute function agent.spend_ledger_guard();
create trigger spend_ledger_guard_upd before update on agent.spend_ledger for each row execute function agent.spend_ledger_guard();

-- the audit is append-only, and every row is attributed to the run's operator
create or replace function agent.research_audit_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, agent
as $$
declare v_op text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'AGENT_AUDIT_APPEND_ONLY';
  end if;
  select operator_id into v_op from agent.research_run where run_id = new.run_id;
  if v_op is null or v_op <> new.actor_user_id then
    raise exception 'AGENT_AUDIT_ACTOR_MISMATCH: audit actor must equal the run operator';
  end if;
  new.at := clock_timestamp();
  return new;
end
$$;
create trigger research_audit_guard_ins before insert on agent.research_audit for each row execute function agent.research_audit_guard();
create trigger research_audit_guard_mut before update or delete on agent.research_audit for each row execute function agent.research_audit_guard();

-- a run's identity never changes; a terminal run never reopens
create or replace function agent.research_run_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, agent
as $$
begin
  if tg_op = 'DELETE' then raise exception 'AGENT_RUN_NO_DELETE'; end if;
  if new.run_id <> old.run_id or new.operator_id <> old.operator_id or new.org_id <> old.org_id
     or new.question_sha256 <> old.question_sha256 or new.created_at <> old.created_at then
    raise exception 'AGENT_RUN_IMMUTABLE';
  end if;
  if old.state <> 'running' and (new.state <> old.state or new.answer is distinct from old.answer) then
    raise exception 'AGENT_RUN_TERMINAL';
  end if;
  return new;
end
$$;
create trigger research_run_guard_mut before update or delete on agent.research_run for each row execute function agent.research_run_guard();

-- limits change only through the owner path, are stamped, and are lower-only by CHECK
create or replace function agent.research_limits_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, agent
as $$
begin
  if tg_op = 'DELETE' then raise exception 'AGENT_LIMITS_NO_DELETE'; end if;
  new.updated_at := clock_timestamp();
  return new;
end
$$;
create trigger research_limits_guard_mut before update or delete on agent.research_limits for each row execute function agent.research_limits_guard();

-- ── EXECUTE: revoke every new function from everyone, grant nothing (triggers fire regardless) ──
revoke all on function agent.spend_committed(text, numeric, numeric) from public, anon, authenticated;
revoke all on function agent.spend_ledger_guard() from public, anon, authenticated;
revoke all on function agent.research_audit_guard() from public, anon, authenticated;
revoke all on function agent.research_run_guard() from public, anon, authenticated;
revoke all on function agent.research_limits_guard() from public, anon, authenticated;
grant execute on function agent.spend_committed(text, numeric, numeric) to agent_api, service_role;

-- ── RLS (enabled + forced) and grants ───────────────────────────────────────
alter table agent.research_limits enable row level security;
alter table agent.research_run enable row level security;
alter table agent.research_audit enable row level security;
alter table agent.spend_ledger enable row level security;
alter table agent.research_limits force row level security;
alter table agent.research_run force row level security;
alter table agent.research_audit force row level security;
alter table agent.spend_ledger force row level security;

revoke all on agent.research_limits, agent.research_run, agent.research_audit, agent.spend_ledger from public, anon, authenticated, service_role;
revoke all on sequence agent.research_audit_id_seq from public, anon, authenticated, service_role;

grant select on agent.research_limits to agent_api, service_role;
grant update on agent.research_limits to service_role;
grant select, insert, update on agent.research_run, agent.spend_ledger to agent_api, service_role;
grant select, insert on agent.research_audit to agent_api, service_role;
grant usage on sequence agent.research_audit_id_seq to agent_api, service_role;

-- single-tenant, like the S3 agent_api policies (per-org policies before a second org exists)
create policy agent_api_select on agent.research_limits for select to agent_api using (true);
create policy agent_api_select on agent.research_run for select to agent_api using (true);
create policy agent_api_insert on agent.research_run for insert to agent_api with check (true);
create policy agent_api_update on agent.research_run for update to agent_api using (true) with check (true);
create policy agent_api_select on agent.research_audit for select to agent_api using (true);
create policy agent_api_insert on agent.research_audit for insert to agent_api with check (true);
create policy agent_api_select on agent.spend_ledger for select to agent_api using (true);
create policy agent_api_insert on agent.spend_ledger for insert to agent_api with check (true);
create policy agent_api_update on agent.spend_ledger for update to agent_api using (true) with check (true);
-- service_role has BYPASSRLS (pretest asserts it); no policy needed for it.

comment on table agent.research_limits is 'Read-only research agent: DB kill switch + hard spend caps (≤ $10/day, ≤ $150/UTC month, ≤ $2.50/run, ≤ 2 escalations and ≤ $2 escalation per run). Lower-only by CHECK.';
comment on table agent.spend_ledger is 'reserve → settle ledger for every model call; the insert trigger serializes and refuses any reserve that crosses a cap. Unknown outcomes stay counted at the reserve.';

commit;
