-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED — NOT APPLIED. Home 2.0 · operator-private Home layouts.
--
-- Owner approval required before this moves to supabase/migrations/ and is
-- applied. Until then /api/cockpit/home/layouts answers home_store_unavailable
-- (503) and the dashboard keeps layouts in local storage under the same key
-- (lc.home.board.v1:<operator>), uploading them the first time the server
-- answers.
--
-- WHAT: one row per saved Home command board for one operator.
--   operator_id      the Supabase user id the Cloudflare Worker verified and
--                    stamped as x-ops-user-id (never taken from a body)
--   layout_id        client-generated stable id (the same id the local copy used)
--   name / is_default / profile ('desktop') / preset / primary_family
--   schema_version   document schema (client lifts older documents)
--   revision         bumped by the client on every change; the API refuses a
--                    write that is not newer than the stored row (409 + current)
--   widget_instances [{ id, type, ownerApp, size, geometry{family→cell},
--                     config, configVersion, context{mode,subject}, refreshMs,
--                     locked, stack }]
-- Layout is deliberately separate from theme / sound / environment settings.
--
-- ACCESS: same posture as the 2026-10-02 watchlist lockdown. RLS on; anon and
-- authenticated hold nothing (self-signup / Google sign-in exist on this
-- project, so an "own rows" authenticated policy would bypass the operator
-- allowlist the Worker enforces). Only service_role (the API) reads and
-- writes, always filtered by the Worker-verified operator id.
--
-- ROLLBACK: drop table public.operator_home_layouts; (no other object depends on it)
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.operator_home_layouts (
  operator_id      text        not null check (char_length(operator_id) between 1 and 128),
  layout_id        text        not null check (layout_id ~ '^[A-Za-z0-9_-]{4,64}$'),
  name             text        not null check (char_length(name) between 1 and 80),
  is_default       boolean     not null default false,
  profile          text        not null default 'desktop' check (profile in ('desktop')),
  schema_version   integer     not null default 1 check (schema_version between 1 and 100),
  revision         integer     not null default 0 check (revision >= 0),
  preset           text        null check (preset is null or preset in ('command', 'acquisitions', 'intelligence', 'closings', 'minimal')),
  primary_family   text        null check (primary_family is null or primary_family in ('narrow', 'standard', 'wide', 'ultra', 'wall')),
  widget_instances jsonb       not null default '[]'::jsonb
                               check (jsonb_typeof(widget_instances) = 'array'
                                      and jsonb_array_length(widget_instances) <= 64
                                      and octet_length(widget_instances::text) <= 200000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (operator_id, layout_id)
);

comment on table public.operator_home_layouts is
  'Home 2.0: operator-private saved Home command boards. Written only by the API (service role) for the Worker-verified operator.';

-- one default board per operator
create unique index if not exists operator_home_layouts_one_default
  on public.operator_home_layouts (operator_id) where is_default;

create index if not exists operator_home_layouts_recent
  on public.operator_home_layouts (operator_id, updated_at desc);

alter table public.operator_home_layouts enable row level security;
revoke all on public.operator_home_layouts from public, anon, authenticated;
grant select, insert, update, delete on public.operator_home_layouts to service_role;
drop policy if exists "home layouts service role" on public.operator_home_layouts;
create policy "home layouts service role" on public.operator_home_layouts
  for all to service_role using (true) with check (true);
