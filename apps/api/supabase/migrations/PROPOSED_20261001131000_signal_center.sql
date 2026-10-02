-- SIGNAL CENTER v1 — PROPOSED, NOT APPLIED. Revised 2026-10-02 (Platform 7.0).
--
-- STATUS: proposal only. Owner approval required. The lead applies it with the
-- owner (MCP apply_migration); nothing in the application turns on because it
-- exists — the evaluator is triple-gated (see "ACTIVATION" below) and every
-- seeded rule starts DISARMED.
--
-- PURPOSE
--   Watchlists + deterministic watch rules → signals → the EXISTING notification
--   center (notification_events, domain 'signals'). Signal Center stores the
--   trigger and its evidence; the notification is the operator-facing awareness.
--   Code: apps/api/src/lib/domain/signals/** · routes /api/cockpit/signals/**,
--   POST /api/internal/signals/evaluate (cron auth).
--
-- WHAT EXISTS (prod, measured 2026-10-02)
--   public.notification_watchlist (migration 20260516145431): 3 rows (1 active),
--   all watch_type='thread', watch_key 'phone:+1…' or bare '+1…'. Unique
--   (watch_type, watch_key). Policies are anon-only USING (true) for
--   SELECT/INSERT/UPDATE/DELETE; no authenticated policy; anon AND authenticated
--   hold ALL table grants. The public anon key can read and rewrite it; signed-in
--   operators cannot use it. notification_events: 2,139 rows; no CHECK on domain.
--   No signal_* table exists.
--
-- CHANGES vs the 2026-10-01 proposal
--   1. NO authenticated policy on notification_watchlist. Self-signup / Google
--      sign-in produce `authenticated` users; the operator allowlist lives in the
--      Worker/API, not in RLS. Service role only; the dashboard reads and writes
--      through /api/cockpit/signals/watches (already shipped with this proposal).
--      The same lockdown is also proposed alone (PROPOSED_20261002100000_
--      notification_watchlist_lockdown.sql) so the hole can close before the rest
--      is approved; both are idempotent, either order.
--   2. Rules read the PLATFORM EVENT ENVELOPE (event_source = envelope
--      source_system, event_types = envelope event types), not automation_events.
--      source_kind gains 'monitor' (IC monitor metrics; no monitor rule is seeded
--      or armed until the intelligence schema exists and writes monitor rows).
--   3. ONE severity vocabulary — the envelope's: info | attention | warning |
--      critical. Mapped to notification_events.severity in exactly one function
--      (signal-vocabulary.js toNotificationSeverity). The 10-01 high/medium/low
--      vocabulary is gone.
--   4. signals.notification_event_id (the notification it raised),
--      signals.evidence_hash, signal_rule_state.last_evidence_hash. Dedupe =
--      state transition + cooldown + new evidence.
--   5. signal_evaluator_checkpoints: the incremental envelope cursor
--      (evaluated_through + resumable keyset cursor). A restart resumes; it never
--      replays history as new signals.
--   6. signal_watchlists (named lists) deferred: one default list. watchlist_id
--      stays as a nullable, FK-less reserved column.
--   7. Rules are seeded here, DISARMED, from the code registry
--      (signal-rules.js BUILT_IN_RULES). Code owns semantics; the row owns
--      is_enabled and condition overrides.
--
-- RLS: enabled on every table touched. anon and authenticated: REVOKE ALL, no
--   policies. service_role: explicit ALL policy (it bypasses RLS anyway). The
--   only readers/writers are apps/api routes behind ensureMutationAuth (Worker
--   session + OPS_ALLOWED_USER_IDS allowlist) and the cron route (CRON_SECRET).
--
-- VOLUME (expected)
--   signals: one row per fired transition / watched event. Today: 2 active
--     campaigns, ~950 sends/7d, 1 active watch → tens of rows per week once rules
--     are armed; hard ceiling ≈ rules × subjects × (1 / cooldown).
--   signal_rule_state: ≤ rules × subjects (campaigns + sender numbers) — low
--     hundreds. signal_rules: 12 seeded rows. checkpoints: ≤ 3 rows.
--   notification_watchlist: +4 columns on 3 rows.
--
-- LOCK RISK
--   notification_watchlist (3 rows): ADD COLUMN (nullable, no default), one
--   UPDATE of 3 rows, CHECK constraint swap, SET NOT NULL, a trigger, two small
--   indexes — ACCESS EXCLUSIVE for milliseconds. Nothing else writes the table
--   (no server writer exists; the dashboard path is broken under RLS).
--   New tables: no contention. lock_timeout 5s aborts rather than queues.
--
-- WRITES TO EXISTING ROWS: 3 notification_watchlist rows (entity backfill) and
--   one system_control row inserted ('signal_center_enabled' = 'false',
--   on conflict do nothing).
--
-- ACTIVATION (none of it happens here)
--   The evaluator runs only when ALL are true:
--     Worker cron flag   CRON_SIGNAL_EVALUATE_ENABLED = 'true'  (registers the tick)
--     Worker ceiling     SIGNAL_CENTER_ENABLED = 'true'          (container env)
--     Control plane      system_control.signal_center_enabled = 'true'
--   and then evaluates only rules with is_enabled = true. Legacy notification
--   scans a rule replaces are skipped only while that rule is armed AND the gate
--   is open (no double alerts, no gap).
--
-- ROLLBACK
--   begin;
--   drop table if exists public.signals, public.signal_rule_state,
--     public.signal_rules, public.signal_evaluator_checkpoints cascade;
--   drop trigger if exists notification_watchlist_derive_entity on public.notification_watchlist;
--   drop function if exists public.notification_watchlist_derive_entity();
--   drop function if exists public.signal_touch_updated_at();
--   drop index if exists public.notification_watchlist_entity_active_idx;
--   alter table public.notification_watchlist
--     drop constraint if exists notification_watchlist_entity_type_check,
--     drop constraint if exists notification_watchlist_watch_type_check,
--     drop column if exists watchlist_id, drop column if exists entity_type,
--     drop column if exists entity_id, drop column if exists created_by;
--   alter table public.notification_watchlist add constraint notification_watchlist_watch_type_check
--     check (watch_type in ('seller', 'property', 'thread', 'prospect', 'owner'));
--   delete from public.system_control where key = 'signal_center_enabled';
--   commit;
--   -- The watchlist lockdown is NOT rolled back (re-opening anon write is never
--   -- the right rollback; the API path keeps working without it).

begin;
set local lock_timeout = '5s';

create or replace function public.signal_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.signal_touch_updated_at() from public, anon, authenticated;

-- 1. notification_watchlist: formalise + lock down ---------------------------
alter table public.notification_watchlist
  add column if not exists watchlist_id uuid,          -- reserved: named lists (deferred)
  add column if not exists entity_type  text,
  add column if not exists entity_id    text,
  add column if not exists created_by   uuid;          -- operator (x-ops-user-id)

-- Campaign watches (Inspector "Watch" on a campaign) need watch_type 'campaign'.
alter table public.notification_watchlist drop constraint if exists notification_watchlist_watch_type_check;
alter table public.notification_watchlist add constraint notification_watchlist_watch_type_check
  check (watch_type in ('seller', 'property', 'thread', 'prospect', 'owner', 'campaign'));

-- Canonical subject = the envelope's subject vocabulary: a thread is a seller
-- (id = thread_key, which is the bare E.164 today; legacy keys carry 'phone:').
update public.notification_watchlist
   set entity_type = case watch_type when 'thread' then 'seller' else watch_type end,
       entity_id   = regexp_replace(watch_key, '^phone:', '')
 where entity_type is null or entity_id is null;

create or replace function public.notification_watchlist_derive_entity()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.entity_type := coalesce(new.entity_type, case new.watch_type when 'thread' then 'seller' else new.watch_type end);
  new.entity_id   := coalesce(new.entity_id, regexp_replace(new.watch_key, '^phone:', ''));
  return new;
end $$;
revoke all on function public.notification_watchlist_derive_entity() from public, anon, authenticated;
drop trigger if exists notification_watchlist_derive_entity on public.notification_watchlist;
create trigger notification_watchlist_derive_entity
  before insert or update on public.notification_watchlist
  for each row execute function public.notification_watchlist_derive_entity();

alter table public.notification_watchlist
  alter column entity_type set not null,
  alter column entity_id   set not null;
alter table public.notification_watchlist drop constraint if exists notification_watchlist_entity_type_check;
alter table public.notification_watchlist add constraint notification_watchlist_entity_type_check
  check (entity_type in ('seller', 'property', 'campaign', 'prospect', 'owner'));
-- Not unique: legacy 'phone:+1X' and '+1X' rows may name the same seller.
create index if not exists notification_watchlist_entity_active_idx
  on public.notification_watchlist (entity_type, entity_id) where is_active;

alter table public.notification_watchlist enable row level security;
drop policy if exists "anon read watchlist"   on public.notification_watchlist;
drop policy if exists "anon write watchlist"  on public.notification_watchlist;
drop policy if exists "anon update watchlist" on public.notification_watchlist;
drop policy if exists "anon delete watchlist" on public.notification_watchlist;
drop policy if exists "watchlist service role" on public.notification_watchlist;
revoke all on public.notification_watchlist from anon, authenticated;
grant select, insert, update, delete on public.notification_watchlist to service_role;
create policy "watchlist service role" on public.notification_watchlist
  for all to service_role using (true) with check (true);

-- 2. Rules --------------------------------------------------------------------
create table if not exists public.signal_rules (
  id               uuid primary key default gen_random_uuid(),
  rule_key         text not null unique check (rule_key ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  label            text not null,
  description      text,
  source_kind      text not null check (source_kind in ('event', 'metric', 'state', 'monitor')),
  event_source     text,                -- envelope source_system (event rules)
  event_types      text[],              -- envelope event types (event rules)
  metric_id        text,                -- Analytics Lab metric id (metric rules)
  dimension        text,                -- Lab dimension the metric is evaluated per (campaign | sender)
  state_id         text,                -- canonical state read (state rules)
  monitor_metric   text,                -- intelligence.monitor_metrics key (monitor rules; none armed in v1)
  scope            text not null default 'global' check (scope in ('watched', 'campaign', 'dimension', 'global')),
  condition        jsonb not null default '{}'::jsonb,   -- overrides over the code defaults
  severity         text not null check (severity in ('info', 'attention', 'warning', 'critical')),
  cooldown_seconds integer not null default 3600 check (cooldown_seconds >= 0),
  replaces_legacy  text[] not null default '{}',          -- notification-scanners event types this rule retires
  is_enabled       boolean not null default false,        -- rules start disarmed
  updated_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check ((source_kind = 'event')   = (event_source is not null and coalesce(cardinality(event_types), 0) > 0)),
  check ((source_kind = 'metric')  = (metric_id is not null and dimension is not null)),
  check ((source_kind = 'state')   = (state_id is not null)),
  check ((source_kind = 'monitor') = (monitor_metric is not null))
);
create index if not exists signal_rules_enabled_idx on public.signal_rules (source_kind) where is_enabled;
drop trigger if exists signal_rules_touch on public.signal_rules;
create trigger signal_rules_touch before update on public.signal_rules
  for each row execute function public.signal_touch_updated_at();

-- 3. Per rule × subject evaluation state (edge trigger + cooldown + evidence) --
create table if not exists public.signal_rule_state (
  rule_id            uuid not null references public.signal_rules(id) on delete cascade,
  subject_key        text not null default '*',   -- '*' global · 'campaign:<id>' · 'sender:<id>' · 'seller:<thread_key>'
  state              text not null check (state in ('ok', 'firing', 'unknown')),
  last_value         numeric,
  last_evidence_hash text,
  last_reason        text,
  last_evaluated_at  timestamptz,
  last_fired_at      timestamptz,
  last_resolved_at   timestamptz,
  fire_count         integer not null default 0,
  updated_at         timestamptz not null default now(),
  primary key (rule_id, subject_key)
);
create index if not exists signal_rule_state_firing_idx on public.signal_rule_state (rule_id) where state = 'firing';
drop trigger if exists signal_rule_state_touch on public.signal_rule_state;
create trigger signal_rule_state_touch before update on public.signal_rule_state
  for each row execute function public.signal_touch_updated_at();

-- 4. Fired signals (append-mostly ledger) ---------------------------------------
create table if not exists public.signals (
  id                    uuid primary key default gen_random_uuid(),
  rule_id               uuid references public.signal_rules(id) on delete set null,
  rule_key              text not null,
  severity              text not null check (severity in ('info', 'attention', 'warning', 'critical')),
  subject_type          text,                 -- envelope subject vocabulary: seller | property | campaign | sender | queue | inbox
  subject_id            text,
  title                 text not null,
  body                  text,
  evidence              jsonb not null default '{}'::jsonb,   -- values, windows, sample sizes, source event ids
  evidence_hash         text not null,
  source_event_id       text,                 -- envelope event_id for event rules ('me:…', 'mv:…')
  deep_link             text,
  dedupe_key            text not null unique,
  status                text not null default 'new' check (status in ('new', 'acknowledged', 'resolved')),
  fired_at              timestamptz not null default now(),
  acknowledged_at       timestamptz,
  acknowledged_by       uuid,
  resolved_at           timestamptz,
  resolved_by           uuid,                 -- NULL with resolve_reason 'condition_cleared' = the evaluator
  resolve_reason        text,
  notification_event_id uuid references public.notification_events(id) on delete set null,
  created_at            timestamptz not null default now()
);
create index if not exists signals_fired_idx   on public.signals (fired_at desc);
create index if not exists signals_subject_idx on public.signals (subject_type, subject_id, fired_at desc);
create index if not exists signals_open_idx    on public.signals (rule_key, subject_type, subject_id) where status <> 'resolved';

-- 5. Evaluator checkpoints (restart-safe incremental cursor) -------------------
create table if not exists public.signal_evaluator_checkpoints (
  source            text primary key check (source in ('envelope', 'metrics', 'state')),
  evaluated_through timestamptz,           -- envelope events at or before this instant are evaluated
  cursor            text,                  -- keyset cursor when a window was only partly drained
  window_since      timestamptz,
  window_until      timestamptz,
  last_run_at       timestamptz,
  last_summary      jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now()
);
drop trigger if exists signal_evaluator_checkpoints_touch on public.signal_evaluator_checkpoints;
create trigger signal_evaluator_checkpoints_touch before update on public.signal_evaluator_checkpoints
  for each row execute function public.signal_touch_updated_at();

do $$
declare t text;
begin
  foreach t in array array['signal_rules', 'signal_rule_state', 'signals', 'signal_evaluator_checkpoints'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || ' service role', t);
    execute format('create policy %I on public.%I for all to service_role using (true) with check (true)', t || ' service role', t);
  end loop;
end $$;

-- 6. Seed rules — DISARMED. Mirrors signal-rules.js BUILT_IN_RULES. ------------
insert into public.signal_rules
  (rule_key, label, description, source_kind, event_source, event_types, metric_id, dimension, state_id, scope, severity, cooldown_seconds, replaces_legacy)
values
  ('watch.seller_replied', 'Watched seller replied', 'A watched seller or property replied, asked for a call, opted out, or the reply was hostile / wrong person.',
     'event', 'inbox', array['seller.replied','seller.call_request','seller.hostile','seller.wrong_person','seller.opted_out'], null, null, null, 'watched', 'attention', 0, '{}'),
  ('watch.message_failed', 'Message to a watched seller failed', 'A conversation message to a watched seller or property failed to send or deliver.',
     'event', 'queue', array['message.failed'], null, null, null, 'watched', 'warning', 0, '{}'),
  ('watch.deal_movement', 'Watched deal moved', 'Stage moved, a deal opened, an offer was set or the seller countered on a watched seller or property.',
     'event', 'pipeline', array['stage.advanced','stage.regressed','deal.opened','deal.status_changed','offer.generated','offer.countered'], null, null, null, 'watched', 'info', 0, '{}'),
  ('watch.campaign_lifecycle', 'Watched campaign changed state', 'A watched campaign was blocked, paused, failed or completed.',
     'event', 'campaign', array['campaign.blocked','campaign.paused','campaign.failed','campaign.completed'], null, null, null, 'watched', 'attention', 0, '{}'),
  ('campaign.execution_exception', 'Campaign execution needs an operator', 'The campaign execution observatory reported a campaign run held, stalled, start-missed or failed.',
     'event', 'workflow', array['workflow.held','workflow.failed'], null, null, null, 'campaign', 'warning', 3600, array['campaign_stale_heartbeat','campaign_no_sends_despite_active']),
  ('campaign.delivery_rate_drop', 'Campaign delivery rate dropped', 'Carrier-confirmed delivery over the trailing window fell below the floor, or significantly below the campaign''s own baseline.',
     'metric', null, null, 'delivery_rate', 'campaign', null, 'dimension', 'warning', 21600, array['campaign_delivery_rate_falling']),
  ('campaign.opt_out_rate_spike', 'Campaign opt-out rate spiked', 'Reached sellers opting out over the trailing window rose above the ceiling, or significantly above the campaign''s own baseline.',
     'metric', null, null, 'opt_out_rate', 'campaign', null, 'dimension', 'warning', 21600, array['campaign_opt_out_spike']),
  ('campaign.content_filter_spike', 'Campaign content filtering spiked', 'Carrier spam/content filtering over the trailing window rose above the ceiling, or significantly above the campaign''s own baseline.',
     'metric', null, null, 'content_filter_rate', 'campaign', null, 'dimension', 'warning', 21600, '{}'),
  ('sender.delivery_degraded', 'Sender number delivery degraded', 'A sender number''s carrier-confirmed delivery fell below the floor or significantly below its own baseline.',
     'metric', null, null, 'delivery_rate', 'sender', null, 'dimension', 'warning', 21600, array['sender_delivery_spike_failure']),
  ('sender.content_filter_spike', 'Sender number content filtering spiked', 'A sender number''s carrier spam/content filtering rose above the ceiling or significantly above its own baseline.',
     'metric', null, null, 'content_filter_rate', 'sender', null, 'dimension', 'critical', 21600, array['sender_content_filter_spike']),
  ('queue.stalled', 'Send queue stalled', 'Due sends are lagging or stale while the queue processor is live (queue processor health: degraded).',
     'state', null, null, null, null, 'queue_processor', 'global', 'critical', 3600, array['platform_queue_processor_degraded','campaign_pacing_behind']),
  ('inbox.new_replies_backlog', 'New Replies backlog', 'Seller replies are waiting in New Replies longer than the allowed wait.',
     'state', null, null, null, null, 'new_replies_backlog', 'global', 'attention', 3600, '{}')
on conflict (rule_key) do nothing;

insert into public.system_control (key, value) values ('signal_center_enabled', 'false')
on conflict (key) do nothing;

commit;
