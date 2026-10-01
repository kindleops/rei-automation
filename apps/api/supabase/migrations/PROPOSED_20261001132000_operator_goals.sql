-- OPERATOR GOALS — PROPOSED 2026-10-01, NOT APPLIED.
--
-- STATUS: proposal only (RC 7.1 workstream C2). Owner approval required.
-- No feature is built on this yet.
--
-- MODEL
--   A goal = (Analytics Lab metric id, scope, period, target). The TARGET is
--   user-defined and stored. The VALUE is never stored: it is derived at read
--   time by the Lab metric engine for the goal's metric/scope/period
--   (apps/api/src/lib/domain/analytics/lab/metric-registry.js METRICS_BY_ID and
--   EXTERNAL_SOURCES metric ids, e.g. 'sellers_reached', 'gsc_clicks'). There
--   is deliberately no current_value / progress / achieved column — a stored
--   value would drift from the metric definition and is exactly the kind of
--   fabricated number the product forbids. metric_id is plain text (the
--   registry lives in code); apps/api must validate it against METRICS_BY_ID
--   on write and render "metric retired" if it later disappears.
--   Search goals are rows with a gsc_* metric and scope {"site_key": "..."}.
--
-- RELATION TO public.daily_goal_targets (prod: 1 row, wide target_* columns,
--   one row per day). Not touched. operator_goals supersedes it for new work;
--   retire it separately once nothing reads it.
--
-- LOCKS / BACKFILL / WRITES TO EXISTING ROWS: none (new table only).
-- ACCESS: RLS on, no policies, service_role only (reads/writes via apps/api).
-- ROLLBACK:
--   drop table if exists public.operator_goals;
--   drop function if exists public.operator_goals_touch_updated_at();

begin;

create or replace function public.operator_goals_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.operator_goals_touch_updated_at() from public, anon, authenticated;

create table if not exists public.operator_goals (
  id            uuid primary key default gen_random_uuid(),
  metric_id     text not null check (metric_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  label         text check (label is null or char_length(label) between 1 and 120),
  scope         jsonb not null default '{}'::jsonb,   -- Lab query-contract filters (market, campaign, site_key …)
  period_kind   text not null check (period_kind in ('day', 'week', 'month', 'quarter', 'year', 'custom')),
  period_start  date not null,
  period_end    date not null,                        -- inclusive
  timezone      text not null default 'America/Chicago',
  comparator    text not null check (comparator in ('at_least', 'at_most')),
  target_value  numeric not null,
  unit          text,                                 -- copied from the registry for display; not authoritative
  owner_user_id uuid,                                 -- auth.users.id; NULL = team goal
  status        text not null default 'active' check (status in ('active', 'archived')),
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (period_end >= period_start),
  check (jsonb_typeof(scope) = 'object')
);

-- One active goal per metric × scope × period × owner.
create unique index if not exists operator_goals_active_uniq
  on public.operator_goals (metric_id, md5(scope::text), period_kind, period_start, owner_user_id) nulls not distinct
  where status = 'active';
create index if not exists operator_goals_period_idx on public.operator_goals (period_start, period_end) where status = 'active';
create index if not exists operator_goals_metric_idx on public.operator_goals (metric_id);

create trigger operator_goals_touch before update on public.operator_goals
  for each row execute function public.operator_goals_touch_updated_at();

alter table public.operator_goals enable row level security;
revoke all on public.operator_goals from anon, authenticated;
grant select, insert, update, delete on public.operator_goals to service_role;

commit;
