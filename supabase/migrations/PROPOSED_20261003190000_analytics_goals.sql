-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED — NOT APPLIED. Analytics Goals (Platform 7.0 §2.3, Refinement 8.4 #7).
--
-- Owner approval required before this is renamed (drop the PROPOSED_ prefix)
-- and applied. Until then /api/cockpit/analytics/goals answers
-- goals_store_unavailable (503) and the dashboard keeps goals on the device
-- (localStorage lc.analytics.goals.v1:<operator>), uploading them the first
-- time the server answers — the same posture Home layouts had.
--
-- WHAT: one row per operator-set target on a canonical Analytics Lab metric.
--   operator_id   the Supabase user id the Cloudflare Worker verified and
--                 stamped as x-ops-user-id (never taken from a body)
--   goal_id       client-generated stable id (the same id the local copy used)
--   metric_id     an Analytics Lab registry id (METRICS_BY_ID); the API accepts
--                 only the goal catalogue (goal-model.js GOAL_METRIC_IDS)
--   market        canonical_market_id, or NULL = all markets
--   period_kind   week | month | quarter — RECURRING: judged against the
--                 current calendar period in `timezone` on every read
--   comparator    at_least | at_most;  target_value  count, or a 0–1 share
--   status        active | archived (archive is a soft retire; no hard delete path)
--   revision      bumped by the client; the API refuses a write that is not
--                 newer than the stored row (409 + current)
--
-- THE VALUE IS NEVER STORED. Progress is computed at read time by the Lab
-- engine (evaluate / series over the period-to-date, market as a Lab filter):
-- no current_value / progress / achieved column exists, so a target can never
-- drift from the metric definition Analytics shows.
--
-- RELATION TO EXISTING OBJECTS: public.daily_goal_targets (1 legacy row,
-- unreferenced) is untouched. Supersedes the 2026-10-01 proposal
-- apps/api/supabase/migrations/PROPOSED_20261001132000_operator_goals.sql
-- (team-level, fixed-date periods, md5(scope) key) — do not apply both.
--
-- ACCESS: same posture as operator_home_layouts / the 2026-10-02 watchlist
-- lockdown. RLS on; anon and authenticated hold nothing (self-signup / Google
-- sign-in exist on this project, so an "own rows" authenticated policy would
-- bypass the operator allowlist the Worker enforces). Only service_role (the
-- API) reads and writes, always filtered by the Worker-verified operator id.
--
-- LOCKS / BACKFILL / WRITES TO EXISTING ROWS: none (new table only).
-- ROLLBACK: PROPOSED_20261003190000_analytics_goals_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════

begin;

create table if not exists public.analytics_goals (
  operator_id   text        not null check (char_length(operator_id) between 1 and 128),
  goal_id       text        not null check (goal_id ~ '^[A-Za-z0-9_-]{4,64}$'),
  metric_id     text        not null check (metric_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  label         text        null check (label is null or char_length(label) between 1 and 120),
  market        text        null check (market is null or market ~* '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
  market_label  text        null check (market_label is null or char_length(market_label) between 1 and 120),
  period_kind   text        not null check (period_kind in ('week', 'month', 'quarter')),
  comparator    text        not null check (comparator in ('at_least', 'at_most')),
  target_value  numeric     not null check (target_value >= 0),
  timezone      text        not null default 'America/Chicago' check (char_length(timezone) between 1 and 64),
  status        text        not null default 'active' check (status in ('active', 'archived')),
  revision      integer     not null default 1 check (revision >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (operator_id, goal_id)
);

comment on table public.analytics_goals is
  'Analytics Goals: operator-private targets on Analytics Lab metrics. Progress is derived at read time by the Lab engine; never stored. Written only by the API (service role) for the Worker-verified operator.';

-- one active goal per operator × metric × market × period
create unique index if not exists analytics_goals_one_active
  on public.analytics_goals (operator_id, metric_id, coalesce(market, ''), period_kind)
  where status = 'active';

create index if not exists analytics_goals_recent
  on public.analytics_goals (operator_id, updated_at desc);

alter table public.analytics_goals enable row level security;
revoke all on public.analytics_goals from public, anon, authenticated;
grant select, insert, update, delete on public.analytics_goals to service_role;
drop policy if exists "analytics goals service role" on public.analytics_goals;
create policy "analytics goals service role" on public.analytics_goals
  for all to service_role using (true) with check (true);

commit;
