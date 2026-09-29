-- WORKFLOW ORCHESTRATOR — immutable versions, durable runs, waits, approvals.
--
-- Namespaced wf_* so it sits beside (not inside) the Workflow V2 tables, whose
-- runs execute a mutable graph. Here a run is pinned to an immutable published
-- version; editing a workflow creates a new version and never changes a
-- running one. Every action a run takes goes through a capability that calls
-- the owning domain authority — no table in this file is a domain table.
--
-- Off by default: system_control.workflow_orchestrator_enabled = 'false'.

create table if not exists public.wf_workflows (
  workflow_key   text primary key check (workflow_key ~ '^[a-z0-9_]{3,64}$'),
  name           text not null,
  domain         text,
  status         text not null default 'draft' check (status in ('draft', 'armed', 'paused', 'archived')),
  live_version   integer,
  reentry        text not null default 'after_complete' check (reentry in ('once', 'after_complete', 'always')),
  owner          text,
  status_changed_by text,
  status_changed_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint wf_workflows_armed_has_version check (status <> 'armed' or live_version is not null)
);

create table if not exists public.wf_versions (
  id            uuid primary key default gen_random_uuid(),
  workflow_key  text not null references public.wf_workflows(workflow_key),
  version       integer not null check (version >= 1),
  graph         jsonb not null,
  graph_hash    text not null,
  description   text not null,
  validation    jsonb not null,
  change_note   text,
  published_by  text not null,
  published_at  timestamptz not null default now(),
  unique (workflow_key, version)
);

alter table public.wf_workflows
  drop constraint if exists wf_workflows_live_version_fk;
alter table public.wf_workflows
  add constraint wf_workflows_live_version_fk foreign key (workflow_key, live_version)
  references public.wf_versions(workflow_key, version) deferrable initially deferred;

-- Published versions are immutable.
create or replace function public.wf_versions_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'WF_VERSION_IMMUTABLE' using errcode = 'P0001';
end $$;
drop trigger if exists wf_versions_immutable on public.wf_versions;
create trigger wf_versions_immutable before update or delete on public.wf_versions
  for each row execute function public.wf_versions_immutable();

create table if not exists public.wf_runs (
  id                  uuid primary key default gen_random_uuid(),
  workflow_key        text not null,
  version             integer not null,
  subject_kind        text not null,
  subject_id          text not null,
  trigger_event_type  text,
  trigger_event_id    text,
  start_key           text not null unique,
  state               text not null default 'running'
                        check (state in ('running', 'waiting', 'awaiting_approval', 'held', 'completed', 'failed', 'cancelled')),
  cursor              text,
  wake_at             timestamptz,
  context             jsonb not null default '{}'::jsonb,
  outcome             text,
  reason              text,
  lease_owner         text,
  lease_until         timestamptz,
  started_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  finished_at         timestamptz,
  foreign key (workflow_key, version) references public.wf_versions(workflow_key, version),
  constraint wf_runs_terminal_finished check (state not in ('completed', 'failed', 'cancelled') or finished_at is not null),
  constraint wf_runs_held_has_reason check (state <> 'held' or reason is not null)
);
-- One live run per workflow × subject (re-entry policy 'after_complete').
create unique index if not exists wf_runs_one_active
  on public.wf_runs (workflow_key, subject_kind, subject_id)
  where state in ('running', 'waiting', 'awaiting_approval', 'held');
create index if not exists wf_runs_due_idx on public.wf_runs (wake_at) where state in ('running', 'waiting');
create index if not exists wf_runs_workflow_idx on public.wf_runs (workflow_key, started_at desc);
create index if not exists wf_runs_subject_idx on public.wf_runs (subject_kind, subject_id);

create table if not exists public.wf_run_steps (
  id               bigint generated always as identity primary key,
  run_id           uuid not null references public.wf_runs(id),
  node_id          text not null,
  kind             text not null,
  status           text not null check (status in ('succeeded', 'blocked', 'retrying', 'failed', 'waiting', 'resolved', 'held', 'skipped')),
  exit             text,
  reason           text,
  preview          text,
  capability       text,
  idempotency_key  text,
  outputs          jsonb,
  attempt          integer not null default 1,
  at               timestamptz not null default now()
);
-- A logical action succeeds at most once, whatever the retries or crashes.
create unique index if not exists wf_run_steps_action_once
  on public.wf_run_steps (idempotency_key) where status = 'succeeded' and idempotency_key is not null;
create index if not exists wf_run_steps_run_idx on public.wf_run_steps (run_id, id);

create or replace function public.wf_run_steps_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'WF_RUN_STEPS_APPEND_ONLY' using errcode = 'P0001';
end $$;
drop trigger if exists wf_run_steps_append_only on public.wf_run_steps;
create trigger wf_run_steps_append_only before update or delete on public.wf_run_steps
  for each row execute function public.wf_run_steps_append_only();

create table if not exists public.wf_waits (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.wf_runs(id),
  node_id       text not null,
  kind          text not null check (kind in ('event', 'approval', 'loop_stop')),
  event_type    text,
  subject_kind  text,
  subject_id    text,
  title         text,
  timeout_at    timestamptz,
  status        text not null default 'open' check (status in ('open', 'resolved', 'timed_out', 'cancelled')),
  resolution    text,
  resolved_by   text,
  resolved_at   timestamptz,
  payload       jsonb,
  created_at    timestamptz not null default now(),
  unique (run_id, node_id),
  constraint wf_waits_resolved_has_actor check (status = 'open' or resolved_at is not null)
);
create index if not exists wf_waits_open_event_idx on public.wf_waits (event_type, subject_kind, subject_id) where status = 'open';
create index if not exists wf_waits_open_approval_idx on public.wf_waits (created_at) where status = 'open' and kind = 'approval';

-- Lease-based claim: a run is processed by one worker at a time; an expired
-- lease (crashed worker) is reclaimable.
create or replace function public.wf_claim_runs(p_limit integer, p_worker text, p_now timestamptz default now(), p_lease_seconds integer default 120)
returns setof public.wf_runs language plpgsql as $$
begin
  return query
  update public.wf_runs r
     set lease_owner = p_worker, lease_until = p_now + make_interval(secs => p_lease_seconds), updated_at = p_now
   where r.id in (
     select id from public.wf_runs
      where (state = 'running' or (state in ('waiting', 'awaiting_approval') and wake_at is not null and wake_at <= p_now))
        and (lease_until is null or lease_until < p_now)
      order by coalesce(wake_at, started_at)
      limit greatest(1, least(p_limit, 200))
      for update skip locked)
  returning r.*;
end $$;

alter table public.wf_workflows enable row level security;
alter table public.wf_versions  enable row level security;
alter table public.wf_runs      enable row level security;
alter table public.wf_run_steps enable row level security;
alter table public.wf_waits     enable row level security;
revoke all on public.wf_workflows, public.wf_versions, public.wf_runs, public.wf_run_steps, public.wf_waits from anon, authenticated;
revoke all on function public.wf_claim_runs(integer, text, timestamptz, integer) from public, anon, authenticated;

insert into public.system_control (key, value)
values ('workflow_orchestrator_enabled', 'false')
on conflict (key) do nothing;
