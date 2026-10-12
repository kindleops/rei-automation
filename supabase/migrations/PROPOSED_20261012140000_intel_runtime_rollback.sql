-- PROPOSED ONLY — rollback for PROPOSED_20261012140000_intel_runtime.sql.
--   psql "$DB" -v ON_ERROR_STOP=1 -f PROPOSED_20261012140000_intel_runtime_rollback.sql
-- Restores the 10-10 schema exactly: agent.research_job / agent.finding /
-- agent.spend_ledger / agent.runtime_limits columns and constraints, and the
-- original bodies of agent.spend_ledger_guard() and agent.finding_actor_guard().
--
-- Refuses:
--   * always, while any agent.spend_ledger row names a job (spend history is never discarded);
--   * while a runtime job is claimed/running (stop it first: emergency stop + wait one lease);
--   * with persisted runtime jobs, unless   set agent.rollback_discard_data = 'on'
--     is set in the session (export first: pg_dump -n agent -t agent.job_event -t agent.runtime_schedule
--     -t agent.runtime_heartbeat, plus  select * from agent.research_job where runtime_managed).
begin;
set local lock_timeout = '5s';
do $$
declare n_jobs bigint; n_live bigint; n_spend bigint;
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'agent' and table_name = 'research_job' and column_name = 'runtime_managed') then
    raise notice 'rollback(intel_runtime): nothing to do';
    return;
  end if;
  select count(*) into n_spend from agent.spend_ledger where job_id is not null;
  if n_spend > 0 then
    raise exception 'rollback(intel_runtime) refused: % spend_ledger row(s) name a runtime job; spend history is never discarded', n_spend;
  end if;
  select count(*), count(*) filter (where state in ('claimed','running')) into n_jobs, n_live from agent.research_job where runtime_managed;
  if n_live > 0 then
    raise exception 'rollback(intel_runtime) refused: % runtime job(s) still leased (set the emergency stop and wait one lease)', n_live;
  end if;
  if n_jobs > 0 and coalesce(current_setting('agent.rollback_discard_data', true), 'off') <> 'on' then
    raise exception 'rollback(intel_runtime) refused: % persisted runtime job(s); export then set agent.rollback_discard_data = on', n_jobs;
  end if;
end
$$;

-- runtime rows go first (owner delete; job_event + job findings cascade)
delete from agent.research_job where kind !~ '^research\.';

-- functions (runtime + helpers)
drop function if exists agent.ops_health_snapshot(integer, integer);
drop function if exists agent.runtime_purge(integer);
drop function if exists agent.runtime_status();
drop function if exists agent.runtime_heartbeat(text, jsonb);
drop function if exists agent.runtime_disable_schedule(text, text);
drop function if exists agent.runtime_upsert_schedule(text, text, integer, text, jsonb, boolean, timestamptz, numeric);
drop function if exists agent.runtime_pause_kind(text, text);
drop function if exists agent.runtime_emergency_stop(text, text);
drop function if exists agent.runtime_pause(text, text);
drop function if exists agent.runtime_approve(text, text);
drop function if exists agent.runtime_requeue(text, text);
drop function if exists agent.runtime_cancel(text, text);
drop function if exists agent.runtime_schedule_watermark(text, uuid, jsonb);
drop function if exists agent.runtime_record_finding(text, uuid, text, text, jsonb, text, numeric, text);
drop function if exists agent.runtime_settle(text, uuid, uuid, numeric, jsonb);
drop function if exists agent.runtime_reserve(text, uuid, text, numeric, text);
drop function if exists agent.runtime_reap(integer);
drop function if exists agent.runtime_finish(text, uuid, text, jsonb, jsonb);
drop function if exists agent.runtime_checkpoint(text, uuid, jsonb, jsonb, text, jsonb);
drop function if exists agent.runtime_start(text, uuid);
drop function if exists agent.runtime_leased(text, uuid);
drop function if exists agent.runtime_claim(text, integer, text[]);
drop function if exists agent.runtime_enqueue_due_schedules(integer);
drop function if exists agent.runtime_enqueue_event(text, text, jsonb, integer);
drop function if exists agent.runtime_enqueue(text, text, jsonb, text, integer, integer, numeric, boolean, timestamptz);
drop function if exists agent.runtime_enqueue_core(text, text, jsonb, text, text, text, integer, integer, numeric, boolean, bigint, timestamptz, timestamptz);
drop function if exists agent.runtime_stop_reason(text);
drop function if exists agent.runtime_emit(agent.research_job, text, text, jsonb);

-- new tables
drop table if exists agent.job_event;
drop function if exists agent.job_event_guard();
drop table if exists agent.runtime_heartbeat;
alter table agent.research_job drop constraint if exists research_job_schedule_fk;
drop table if exists agent.runtime_schedule;

-- finding: back to run-owned, property-scoped only; original guard body (10-10)
drop index if exists agent.finding_job_key_uq;
drop index if exists agent.finding_job_recent_idx;
alter table agent.finding drop constraint if exists finding_owner, drop constraint if exists finding_run_has_property;
alter table agent.finding drop column if exists job_id;
alter table agent.finding alter column run_id set not null, alter column property_id set not null;
create or replace function agent.finding_actor_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, agent
as $$
begin
  if new.actor_user_id is distinct from (select r.operator_id from agent.run r where r.run_id = new.run_id) then
    raise exception 'finding actor mismatch: a finding is stamped with its run''s operator' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

-- spend_ledger: back to run-owned only; original guard body (10-10)
drop index if exists agent.spend_ledger_job;
alter table agent.spend_ledger drop constraint if exists spend_ledger_one_owner;
alter table agent.spend_ledger drop column if exists job_id;
alter table agent.spend_ledger alter column run_id set not null;
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
revoke all on function agent.spend_ledger_guard() from public, anon, authenticated;
revoke all on function agent.finding_actor_guard() from public, anon, authenticated;

-- research_job: back to the S3 shape
drop trigger if exists research_job_runtime_guard on agent.research_job;
drop function if exists agent.research_job_runtime_guard();
drop index if exists agent.research_job_idem_uq;
drop index if exists agent.research_job_schedule_slot_uq;
drop index if exists agent.research_job_runtime_due_idx;
drop index if exists agent.research_job_runtime_leased_idx;
drop index if exists agent.research_job_runtime_open_idx;
drop index if exists agent.research_job_schedule_open_idx;
drop index if exists agent.research_job_runtime_ended_idx;
drop index if exists agent.research_job_runtime_recent_idx;
alter table agent.research_job
  drop constraint if exists research_job_state_check,
  drop constraint if exists research_job_kind_shape,
  drop constraint if exists research_job_research_shape,
  drop constraint if exists research_job_doc_marker,
  drop constraint if exists research_job_runtime_shape,
  drop constraint if exists research_job_attempts,
  drop constraint if exists research_job_priority,
  drop constraint if exists research_job_budget_cap,
  drop constraint if exists research_job_lease_shape,
  drop constraint if exists research_job_lease_owner_shape,
  drop constraint if exists research_job_runtime_lease_iff_active,
  drop constraint if exists research_job_runtime_due,
  drop constraint if exists research_job_runtime_terminal_end,
  drop constraint if exists research_job_cancel_pair,
  drop constraint if exists research_job_cancel_by_named,
  drop constraint if exists research_job_schedule_pair,
  drop constraint if exists research_job_input_clean,
  drop constraint if exists research_job_progress_clean,
  drop constraint if exists research_job_checkpoint_clean,
  drop constraint if exists research_job_result_clean,
  drop constraint if exists research_job_error_clean;
alter table agent.research_job
  drop column if exists runtime_managed,
  drop column if exists kind,
  drop column if exists requested_by,
  drop column if exists trigger_kind,
  drop column if exists trigger_ref,
  drop column if exists idempotency_key,
  drop column if exists priority,
  drop column if exists attempt,
  drop column if exists max_attempts,
  drop column if exists next_attempt_at,
  drop column if exists lease_token,
  drop column if exists lease_owner,
  drop column if exists lease_until,
  drop column if exists claimed_at,
  drop column if exists heartbeat_at,
  drop column if exists finished_token,
  drop column if exists cancel_requested_at,
  drop column if exists cancel_requested_by,
  drop column if exists budget_cap_usd,
  drop column if exists input,
  drop column if exists progress,
  drop column if exists checkpoint,
  drop column if exists result,
  drop column if exists last_error,
  drop column if exists schedule_id,
  drop column if exists schedule_slot,
  drop column if exists updated_at;
alter table agent.research_job
  alter column run_id set not null,
  alter column depth set not null,
  alter column scope_hash set not null,
  alter column property_ids set not null,
  alter column gen drop default;
alter table agent.research_job add constraint research_job_state_check check (state in ('draft','queued','running','paused','synthesizing','completed','completed_partial',
    'budget_exhausted','cancelled','failed','expired'));

-- runtime_limits: back to the single S3 column
alter table agent.runtime_limits
  drop constraint if exists runtime_limits_kind_limits_valid,
  drop constraint if exists runtime_limits_stop_stamped,
  drop constraint if exists runtime_limits_backoff_order;
alter table agent.runtime_limits
  drop column if exists runtime_enabled,
  drop column if exists emergency_stop,
  drop column if exists emergency_stop_at,
  drop column if exists emergency_stop_by,
  drop column if exists emergency_stop_reason,
  drop column if exists max_concurrency_global,
  drop column if exists kind_limits,
  drop column if exists lease_seconds,
  drop column if exists backoff_base_seconds,
  drop column if exists backoff_max_seconds,
  drop column if exists tick_max_jobs,
  drop column if exists tick_budget_ms,
  drop column if exists statement_timeout_ms;

drop function if exists agent.runtime_kind_limits_valid(jsonb);
drop function if exists agent.runtime_backoff(integer, integer, integer);
drop function if exists agent.runtime_transition_ok(text, text);
drop function if exists agent.runtime_kind_valid(text);
drop function if exists agent.runtime_is_named_operator(text);
commit;
