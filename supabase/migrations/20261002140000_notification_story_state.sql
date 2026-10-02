-- PROPOSED — Notification Center 2.0: persisted story state (READ ≠ RESOLVED)
-- and the incrementally maintained story projection (performance, brief F).
--
-- NOT APPLIED. Owner review required before apply (MCP apply_migration).
-- Pretest inside a rollback transaction first (begin; <this file>; rollback;).
-- After apply: POST /api/internal/notifications/stories/project?rebuild=1 once
-- (backfill), then the cron tick / emit points keep it current.
--
-- Stories are DERIVED (lib/domain/notifications/stories/): there is no second
-- event log. This table only remembers the operator's decisions about a story:
-- when it was read, when it was resolved and by whom, and an explicit reopen.
-- story_id is stable: hash(subject key + first trigger event id).
--
-- Until this is applied the read model degrades gracefully:
--   · stories with member notification_events rows persist through those rows'
--     own read_at / status (write-through — the old bell and the phone agree)
--   · stories without member alerts (campaign_events, workflow holds) report
--     persistence 'none' and the dashboard keeps their state locally
--
-- Security: RLS on, no policies → only the service role (the API) reads/writes.

create table if not exists public.notification_story_state (
  story_id        text primary key,
  operator_id     text not null default 'operator',
  subject_key     text,
  last_trigger_at timestamptz,
  read_at         timestamptz,
  unread_at       timestamptz,
  resolved_at     timestamptz,
  resolved_by     text,
  reopened        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.notification_story_state is
  'Notification Center 2.0 operator state per derived story (read / resolved / reopened). Service role only.';

create index if not exists notification_story_state_updated_idx
  on public.notification_story_state (updated_at desc);

alter table public.notification_story_state enable row level security;
revoke all on table public.notification_story_state from anon, authenticated;
grant select, insert, update, delete on table public.notification_story_state to service_role;


-- ── the story projection ────────────────────────────────────────────────
-- notification_stories: one row per derived story (story_id = the builder's
-- stable hash), rewritten in place when the story morphs. The read endpoint
-- filters / pages / counts on the narrow columns; `story` is the API payload.
-- partition_key: the unit a story depends on (a seller thread, else the subject);
-- the projector rebuilds whole partitions with the same builder, never a subset.

create table if not exists public.notification_stories (
  story_id          text primary key,
  partition_key     text not null,
  subject_key       text,
  lens              text not null check (lens in ('needs_you', 'now', 'resolved', 'system')),
  priority          text not null check (priority in ('critical', 'action', 'important', 'info')),
  requires_operator boolean not null default false,
  resolved          boolean not null default false,
  is_read           boolean not null default false,
  badge             boolean not null default false,
  updated_at        timestamptz not null,
  last_trigger_at   timestamptz,
  resolved_at       timestamptz,
  content_hash      text not null,
  story             jsonb not null,
  projected_at      timestamptz not null default now()
);

comment on table public.notification_stories is
  'Notification Center 2.0 story projection (derived from the platform event envelope + notification_events; rebuildable). Service role only.';

-- the plane's first page and keyset paging (all lenses, newest activity first)
create index if not exists notification_stories_updated_idx
  on public.notification_stories (updated_at desc, story_id desc);
-- one lens, newest first
create index if not exists notification_stories_lens_updated_idx
  on public.notification_stories (lens, updated_at desc, story_id desc);
-- incremental refresh: rows re-projected since the client's last read
create index if not exists notification_stories_projected_idx
  on public.notification_stories (projected_at desc);
-- partition rebuild diff
create index if not exists notification_stories_partition_idx
  on public.notification_stories (partition_key);

-- notification_story_inputs: the projector's window-bounded working copy of the
-- story-relevant source facts (envelope events / notification rows), keyed by
-- the canonical id the builder dedupes on. NOT an event log and never an
-- authority: pruned to the 7-day window, rebuildable from the sources.
create table if not exists public.notification_story_inputs (
  input_id       text primary key,
  kind           text not null check (kind in ('event', 'notification')),
  partition_key  text not null,
  occurred_at    timestamptz not null,
  payload        jsonb not null,
  updated_at     timestamptz not null default now()
);

comment on table public.notification_story_inputs is
  'Notification Center 2.0 projector working set (7-day window copy of story-relevant facts; not an authority). Service role only.';

create index if not exists notification_story_inputs_partition_idx
  on public.notification_story_inputs (partition_key, occurred_at);
create index if not exists notification_story_inputs_occurred_idx
  on public.notification_story_inputs (occurred_at);

-- notification_story_projector: the projector's cursor (one row, id 'stories').
create table if not exists public.notification_story_projector (
  id                     text primary key,
  events_through         timestamptz,
  notifications_through  timestamptz,
  rebuilt_at             timestamptz,
  projected_at           timestamptz,
  degraded               jsonb not null default '[]'::jsonb,
  stats                  jsonb not null default '{}'::jsonb
);

comment on table public.notification_story_projector is
  'Notification Center 2.0 story projector cursor. Service role only.';

alter table public.notification_stories enable row level security;
alter table public.notification_story_inputs enable row level security;
alter table public.notification_story_projector enable row level security;
revoke all on table public.notification_stories from anon, authenticated;
revoke all on table public.notification_story_inputs from anon, authenticated;
revoke all on table public.notification_story_projector from anon, authenticated;
grant select, insert, update, delete on table public.notification_stories to service_role;
grant select, insert, update, delete on table public.notification_story_inputs to service_role;
grant select, insert, update, delete on table public.notification_story_projector to service_role;
