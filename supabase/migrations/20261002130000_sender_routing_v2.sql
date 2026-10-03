-- SENDER ROUTING 2.0 — PROPOSED, NOT APPLIED (2026-10-02).
--
-- STATUS: proposal only. Owner approval required. Applying it changes NO
-- routing: the router reads these tables only when BOTH gates are on
-- (env SENDER_ROUTING_V2_ENABLED='true' AND system_control.sender_routing_v2_enabled),
-- and this migration seeds that switch 'false'. The tables start EMPTY; the
-- proposed initial graph is a separate, owner-approved file
-- (20261002130100_sender_routing_v2_seed_proposed_graph.sql).
--
-- PURPOSE (owner brief "Sender Routing 2.0" §A/§B)
--   Market-affinity routing: each canonical market has an ORDERED list of
--   sender pools (sending hubs) with an affinity tier. Geography decides the
--   pool; the existing allocator picks the number within it. Versioned and
--   audited: graph edits, onboarding, activation, overrides, mid-thread sender
--   changes, retirement, wake runs.
--   Code: apps/api/src/lib/domain/routing/sender-routing/** ·
--   GET/POST /api/cockpit/routing/sender-coverage · POST /api/internal/sender-routing/wake
--
-- WHAT EXISTS (prod, measured 2026-10-02, read-only)
--   textgrid_numbers: 16 rows; status CHECK (active|paused); health_state CHECK
--     (active_healthy|cooling|paused|blocked|disabled|unverified);
--     registration_status NULL on every row. RLS on.
--   market_routing_rules: 27 STATE-based rows (state -> target market). No code
--     reads it (the feeder carries its own state table, REGIONAL_ROUTING_RULES).
--     It cannot express market -> ordered pools, so it is left untouched.
--   workflow_sender_pools / _members: 9 / 5 rows, all Workflow Studio dry-run
--     pools keyed to workflows ("Default Dry-Run Pool"), not sending hubs.
--     Not reused: different concept, different owner.
--   canonical_markets: 58 active markets (text slug ids) — the registry the
--     graph keys on.
--
-- SECURITY
--   RLS enabled on every table with NO policies; anon, authenticated and PUBLIC
--   hold no privileges; service_role only. The one write function
--   (sender_routing_replace_market_routes) is SECURITY DEFINER, EXECUTE revoked
--   from PUBLIC/anon/authenticated and granted to service_role only. The
--   dashboard reads and writes through /api/cockpit/routing/sender-coverage
--   (operator auth), whose save path is additionally gated by
--   SENDER_ROUTING_GRAPH_WRITES + system_control.sender_routing_graph_writes.
--
-- ROLLBACK: supabase/rollbacks/20261002130000_sender_routing_v2_ROLLBACK.sql
--   (drops the function and tables, deletes the three system_control keys).

-- gen_random_uuid() is core since PostgreSQL 13; no extension needed.

create or replace function public.sender_routing_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ── pools (sending hubs) ────────────────────────────────────────────────────
create table if not exists public.sender_pools (
  id uuid primary key default gen_random_uuid(),
  pool_key text not null unique check (pool_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  display_name text not null check (length(btrim(display_name)) > 0),
  home_market_id text references public.canonical_markets(id),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.sender_pools is 'Sender Routing 2.0: sending hubs. home_market_id = the market whose own (LOCAL) pool this is.';

-- ── pool membership: a number belongs to exactly ONE pool ───────────────────
create table if not exists public.sender_pool_numbers (
  id uuid primary key default gen_random_uuid(),
  sender_pool_id uuid not null references public.sender_pools(id) on delete cascade,
  textgrid_number_id uuid not null unique references public.textgrid_numbers(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sender_pool_numbers_pool_idx on public.sender_pool_numbers (sender_pool_id);
comment on table public.sender_pool_numbers is 'Sender Routing 2.0: pool membership. UNIQUE(textgrid_number_id): no number is in two pools. Never hard-delete a number: retire it (textgrid_numbers.metadata.lifecycle_state) and set membership inactive.';

-- ── market -> ordered pools ─────────────────────────────────────────────────
create table if not exists public.market_sender_routes (
  id uuid primary key default gen_random_uuid(),
  market_id text not null references public.canonical_markets(id),
  sender_pool_id uuid not null references public.sender_pools(id) on delete restrict,
  priority integer not null check (priority > 0),
  affinity_tier text not null check (affinity_tier in ('primary', 'preferred_fallback', 'regional_fallback', 'last_resort', 'blocked_never')),
  enabled boolean not null default true,
  provenance text not null default 'operator' check (provenance in ('owner', 'proposal', 'confirm', 'operator')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_sender_routes_market_pool_key unique (market_id, sender_pool_id),
  constraint market_sender_routes_market_priority_key unique (market_id, priority)
);
create index if not exists market_sender_routes_pool_idx on public.market_sender_routes (sender_pool_id);
comment on table public.market_sender_routes is 'Sender Routing 2.0: each canonical market''s ordered pools. Walked by priority; geography before load balancing. blocked_never = this pool may never serve this market (not even by override).';

-- ── audit + graph version ───────────────────────────────────────────────────
create sequence if not exists public.sender_routing_graph_version_seq;

create table if not exists public.sender_routing_audit (
  id bigint generated always as identity primary key,
  graph_version bigint,
  event_type text not null check (event_type in ('graph_seed', 'graph_edit', 'pool_edit', 'pool_member_edit', 'onboarding', 'activation', 'override', 'thread_reroute', 'retirement', 'wake_run')),
  actor text not null check (length(btrim(actor)) > 0),
  reason text,
  subject jsonb not null default '{}'::jsonb,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index if not exists sender_routing_audit_event_idx on public.sender_routing_audit (event_type, created_at desc);
create index if not exists sender_routing_audit_version_idx on public.sender_routing_audit (graph_version desc) where graph_version is not null;
comment on table public.sender_routing_audit is 'Sender Routing 2.0 audit. graph_version (from sender_routing_graph_version_seq) is stamped on every graph change; the router reads max(graph_version).';

-- ── explicit, audited operator overrides ("use the Dallas pool for this seller")
create table if not exists public.sender_routing_overrides (
  id uuid primary key default gen_random_uuid(),
  scope_kind text not null check (scope_kind in ('thread', 'seller', 'queue_row')),
  scope_key text not null check (length(btrim(scope_key)) > 0),
  sender_pool_id uuid not null references public.sender_pools(id),
  actor text not null check (length(btrim(actor)) > 0),
  reason text not null check (length(btrim(reason)) > 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz not null default now()
);
create unique index if not exists sender_routing_overrides_live_key on public.sender_routing_overrides (scope_kind, scope_key) where revoked_at is null;

drop trigger if exists sender_pools_touch on public.sender_pools;
create trigger sender_pools_touch before update on public.sender_pools for each row execute function public.sender_routing_touch_updated_at();
drop trigger if exists sender_pool_numbers_touch on public.sender_pool_numbers;
create trigger sender_pool_numbers_touch before update on public.sender_pool_numbers for each row execute function public.sender_routing_touch_updated_at();
drop trigger if exists market_sender_routes_touch on public.market_sender_routes;
create trigger market_sender_routes_touch before update on public.market_sender_routes for each row execute function public.sender_routing_touch_updated_at();

-- ── RLS: service_role only ──────────────────────────────────────────────────
alter table public.sender_pools enable row level security;
alter table public.sender_pool_numbers enable row level security;
alter table public.market_sender_routes enable row level security;
alter table public.sender_routing_audit enable row level security;
alter table public.sender_routing_overrides enable row level security;

revoke all on public.sender_pools, public.sender_pool_numbers, public.market_sender_routes, public.sender_routing_audit, public.sender_routing_overrides from public, anon, authenticated;
revoke all on sequence public.sender_routing_graph_version_seq from public, anon, authenticated;
grant all on public.sender_pools, public.sender_pool_numbers, public.market_sender_routes, public.sender_routing_audit, public.sender_routing_overrides to service_role;
grant usage, select on sequence public.sender_routing_graph_version_seq to service_role;
revoke all on function public.sender_routing_touch_updated_at() from public, anon, authenticated;

-- ── the one write path: replace a market's routes atomically, audited, versioned
create or replace function public.sender_routing_replace_market_routes(
  p_market_id text,
  p_routes jsonb,
  p_actor text,
  p_reason text
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version bigint;
  v_before jsonb;
  v_after jsonb;
  v_unknown text;
begin
  if coalesce(btrim(p_actor), '') = '' then raise exception 'actor required' using errcode = '22023'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  if not exists (select 1 from canonical_markets where id = p_market_id and is_active) then
    raise exception 'market % is not an active canonical market', p_market_id using errcode = '22023';
  end if;
  if jsonb_typeof(p_routes) <> 'array' then raise exception 'routes must be an array' using errcode = '22023'; end if;
  select r->>'pool_key' into v_unknown
    from jsonb_array_elements(p_routes) r
   where not exists (select 1 from sender_pools p where p.pool_key = r->>'pool_key')
   limit 1;
  if v_unknown is not null then raise exception 'unknown pool %', v_unknown using errcode = '22023'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('pool_key', p.pool_key, 'priority', m.priority, 'affinity_tier', m.affinity_tier, 'enabled', m.enabled) order by m.priority), '[]'::jsonb)
    into v_before
    from market_sender_routes m join sender_pools p on p.id = m.sender_pool_id
   where m.market_id = p_market_id;

  delete from market_sender_routes where market_id = p_market_id;

  insert into market_sender_routes (market_id, sender_pool_id, priority, affinity_tier, enabled, provenance, notes)
  select p_market_id, p.id, (r->>'priority')::int, r->>'affinity_tier', coalesce((r->>'enabled')::boolean, true), 'operator', nullif(r->>'notes', '')
    from jsonb_array_elements(p_routes) r
    join sender_pools p on p.pool_key = r->>'pool_key';

  select coalesce(jsonb_agg(jsonb_build_object('pool_key', p.pool_key, 'priority', m.priority, 'affinity_tier', m.affinity_tier, 'enabled', m.enabled) order by m.priority), '[]'::jsonb)
    into v_after
    from market_sender_routes m join sender_pools p on p.id = m.sender_pool_id
   where m.market_id = p_market_id;

  v_version := nextval('sender_routing_graph_version_seq');
  insert into sender_routing_audit (graph_version, event_type, actor, reason, subject, before, after)
  values (v_version, 'graph_edit', p_actor, p_reason, jsonb_build_object('market_id', p_market_id), v_before, v_after);
  return v_version;
end $$;

revoke all on function public.sender_routing_replace_market_routes(text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.sender_routing_replace_market_routes(text, jsonb, text, text) to service_role;

-- ── runtime switches (all OFF) ──────────────────────────────────────────────
insert into public.system_control (key, value, updated_at) values
  ('sender_routing_v2_enabled', 'false', now()),
  ('sender_routing_wake_apply', 'false', now()),
  ('sender_routing_graph_writes', 'false', now())
on conflict (key) do nothing;
