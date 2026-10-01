-- SIGNAL CENTER — PROPOSED 2026-10-01, NOT APPLIED.
--
-- STATUS: proposal only (RC 7.1 workstream C2). Owner approval required.
-- No feature is built on this yet.
--
-- WHAT EXISTS (prod, 2026-10-01)
--   public.notification_watchlist (migration 20260516145431): 3 rows, all
--   watch_type='thread'; watch_key formats are inconsistent
--   ('phone:+1…' and bare '+1…'). Unique (watch_type, watch_key).
--   Policies are anon-only (anon SELECT/INSERT/UPDATE/DELETE USING true);
--   there is NO authenticated policy. The dashboard writes it directly
--   (apps/dashboard/src/lib/data/watchlistData.ts) and, since the auth gate
--   made every dashboard request `authenticated`, those reads return nothing
--   and writes fail RLS — the watchlist is silently broken for signed-in
--   operators while staying world-writable with the public anon key.
--
-- WHAT THIS DOES
--   1. Formalises notification_watchlist (EXTEND, not replace):
--      + watchlist_id  -> new public.signal_watchlists (named lists; NULL = default list)
--      + entity_type / entity_id  (canonical target; watch_type/watch_key kept for the
--        current dashboard code)
--      + created_by (auth user id)
--      Backfill (3 rows): entity_type := watch_type, entity_id := watch_key with a
--      leading 'phone:' stripped. Then entity_type/entity_id are NOT NULL.
--   2. Access: anon policies dropped and anon revoked; authenticated gets
--      SELECT/INSERT/UPDATE/DELETE (the dashboard's existing direct path keeps
--      working — and actually starts working). service_role ALL.
--      Follow-up (not here): move watchlist writes behind apps/api and drop the
--      authenticated write policy.
--   3. New: signal_rules (what to watch for), signal_rule_state (per rule ×
--      entity evaluation state, for edge-triggering + cooldown), signals (fired
--      signal ledger, deduped). service_role only; the UI reads through apps/api.
--      Rules may reference an Analytics Lab metric id (text, validated in the
--      API against METRICS_BY_ID) or an automation_events event type.
--
-- WRITES TO EXISTING ROWS: yes — 3 notification_watchlist rows (backfill).
-- LOCKS: ALTER TABLE ADD COLUMN (nullable, no default) + SET NOT NULL on a
--   3-row table: ACCESS EXCLUSIVE for milliseconds.
--
-- ROLLBACK:
--   begin;
--   drop table if exists public.signals, public.signal_rule_state, public.signal_rules cascade;
--   drop policy if exists "watchlist authenticated read"   on public.notification_watchlist;
--   drop policy if exists "watchlist authenticated write"  on public.notification_watchlist;
--   drop policy if exists "watchlist authenticated update" on public.notification_watchlist;
--   drop policy if exists "watchlist authenticated delete" on public.notification_watchlist;
--   drop policy if exists "watchlist service role"         on public.notification_watchlist;
--   create policy "anon read watchlist"   on public.notification_watchlist for select to anon using (true);
--   create policy "anon write watchlist"  on public.notification_watchlist for insert to anon with check (true);
--   create policy "anon update watchlist" on public.notification_watchlist for update to anon using (true) with check (true);
--   create policy "anon delete watchlist" on public.notification_watchlist for delete to anon using (true);
--   grant all on public.notification_watchlist to anon;
--   drop trigger if exists notification_watchlist_derive_entity on public.notification_watchlist;
--   drop function if exists public.notification_watchlist_derive_entity();
--   alter table public.notification_watchlist
--     drop constraint if exists notification_watchlist_entity_type_check,
--     drop column if exists watchlist_id, drop column if exists entity_type,
--     drop column if exists entity_id, drop column if exists created_by;
--   drop table if exists public.signal_watchlists;
--   drop function if exists public.signal_touch_updated_at();
--   commit;

begin;
set local lock_timeout = '5s';

create or replace function public.signal_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.signal_touch_updated_at() from public, anon, authenticated;

-- Named watchlists ------------------------------------------------------------
create table if not exists public.signal_watchlists (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  owner_user_id uuid,                               -- auth.users.id; NULL = shared
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists signal_watchlists_owner_name_uniq
  on public.signal_watchlists (owner_user_id, lower(name)) nulls not distinct;
create trigger signal_watchlists_touch before update on public.signal_watchlists
  for each row execute function public.signal_touch_updated_at();

-- notification_watchlist: formalise -------------------------------------------
alter table public.notification_watchlist
  add column if not exists watchlist_id uuid references public.signal_watchlists(id) on delete set null,
  add column if not exists entity_type  text,
  add column if not exists entity_id    text,
  add column if not exists created_by   uuid;

update public.notification_watchlist
   set entity_type = watch_type,
       entity_id   = regexp_replace(watch_key, '^phone:', '')
 where entity_type is null or entity_id is null;

-- The current dashboard insert (watchlistData.ts) sends only watch_type/watch_key;
-- derive the canonical pair so that path keeps working under NOT NULL.
create or replace function public.notification_watchlist_derive_entity()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.entity_type := coalesce(new.entity_type, new.watch_type);
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
  alter column entity_id   set not null,
  add constraint notification_watchlist_entity_type_check
    check (entity_type in ('seller', 'property', 'thread', 'prospect', 'owner', 'campaign', 'market', 'buyer', 'closing', 'opportunity'));

create unique index if not exists notification_watchlist_list_entity_uniq
  on public.notification_watchlist (watchlist_id, entity_type, entity_id) nulls not distinct;
create index if not exists notification_watchlist_entity_active_idx
  on public.notification_watchlist (entity_type, entity_id) where is_active;

drop policy if exists "anon read watchlist"   on public.notification_watchlist;
drop policy if exists "anon write watchlist"  on public.notification_watchlist;
drop policy if exists "anon update watchlist" on public.notification_watchlist;
drop policy if exists "anon delete watchlist" on public.notification_watchlist;
revoke all on public.notification_watchlist from anon;
revoke truncate, references, trigger on public.notification_watchlist from authenticated;
grant select, insert, update, delete on public.notification_watchlist to authenticated;
create policy "watchlist authenticated read"   on public.notification_watchlist for select to authenticated using (true);
create policy "watchlist authenticated write"  on public.notification_watchlist for insert to authenticated with check (true);
create policy "watchlist authenticated update" on public.notification_watchlist for update to authenticated using (true) with check (true);
create policy "watchlist authenticated delete" on public.notification_watchlist for delete to authenticated using (true);
create policy "watchlist service role"         on public.notification_watchlist for all to service_role using (true) with check (true);

-- Rules ----------------------------------------------------------------------
create table if not exists public.signal_rules (
  id            uuid primary key default gen_random_uuid(),
  rule_key      text not null unique check (rule_key ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  label         text not null,
  description   text,
  source_kind   text not null check (source_kind in ('metric', 'event', 'state')),
  metric_id     text,                                 -- Analytics Lab metric id when source_kind='metric'
  event_type    text,                                 -- automation_events type when source_kind='event'
  entity_type   text,                                 -- NULL = global rule
  watchlist_id  uuid references public.signal_watchlists(id) on delete cascade,  -- NULL = all watched / global
  condition     jsonb not null,                       -- e.g. {"op":"gte","value":3,"window":"P1D"}
  severity      text not null check (severity in ('critical', 'high', 'medium', 'low', 'info')),
  cooldown_seconds integer not null default 3600 check (cooldown_seconds >= 0),
  is_enabled    boolean not null default false,       -- rules start disarmed
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((source_kind = 'metric') = (metric_id is not null)),
  check ((source_kind = 'event')  = (event_type is not null))
);
create index if not exists signal_rules_enabled_idx on public.signal_rules (source_kind) where is_enabled;
create trigger signal_rules_touch before update on public.signal_rules
  for each row execute function public.signal_touch_updated_at();

-- Per rule × entity evaluation state (edge trigger + cooldown) ----------------
create table if not exists public.signal_rule_state (
  rule_id       uuid not null references public.signal_rules(id) on delete cascade,
  entity_type   text not null default '*',            -- '*' for global rules
  entity_id     text not null default '*',
  state         text not null check (state in ('ok', 'firing', 'cooldown', 'muted', 'unknown')),
  last_value    numeric,
  last_evaluated_at timestamptz,
  last_fired_at timestamptz,
  muted_until   timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (rule_id, entity_type, entity_id)
);
create index if not exists signal_rule_state_firing_idx on public.signal_rule_state (rule_id) where state = 'firing';
create trigger signal_rule_state_touch before update on public.signal_rule_state
  for each row execute function public.signal_touch_updated_at();

-- Fired signals (append-mostly ledger) ----------------------------------------
create table if not exists public.signals (
  id            uuid primary key default gen_random_uuid(),
  rule_id       uuid references public.signal_rules(id) on delete set null,
  signal_type   text not null,
  severity      text not null check (severity in ('critical', 'high', 'medium', 'low', 'info')),
  entity_type   text,
  entity_id     text,
  watchlist_id  uuid references public.signal_watchlists(id) on delete set null,
  title         text not null,
  body          text,
  evidence      jsonb not null default '{}'::jsonb,   -- values, window, source rows
  source_ref    text,                                 -- e.g. automation_events.id / message_events.id
  dedupe_key    text not null unique,
  fired_at      timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists signals_fired_idx  on public.signals (fired_at desc);
create index if not exists signals_entity_idx on public.signals (entity_type, entity_id, fired_at desc);
create index if not exists signals_open_idx   on public.signals (severity, fired_at desc) where resolved_at is null;

do $$
declare t text;
begin
  foreach t in array array['signal_watchlists', 'signal_rules', 'signal_rule_state', 'signals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

commit;
