-- PROPOSED — Notification Center 2.0: persisted story state (READ ≠ RESOLVED).
--
-- NOT APPLIED. Owner review required before apply (MCP apply_migration).
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
