-- LIVING MAP WORLD PROVIDERS + CAMERA NETWORK — public roadway cameras from
-- official agency feeds, normalised behind one LeadCommand model, on a shared
-- provider registry/heartbeat that public-safety and weather sources reuse.
--
-- Metadata only. No imagery is stored anywhere in this schema: stills are
-- fetched on demand for the one camera an operator opens and are never
-- persisted; video is played from the provider's own stream. The inventory is
-- kept (and marked missing / retired, never deleted on a failed pull) so one
-- provider outage cannot empty a state.
--
-- Service role only: RLS on, no policies, anon/authenticated revoked.

-- ONE registry + heartbeat for every Living Map world source (cameras,
-- public safety, weather alerts). Domain data lives in domain tables; this
-- table owns health, cadence, leases and counts so a source that silently
-- stops is visible in one place.
create table if not exists public.map_world_providers (
  provider_id           text primary key check (provider_id ~ '^[a-z0-9_]{3,64}$'),
  domain                text not null check (domain in ('cameras', 'public_safety', 'weather')),
  name                  text not null,
  jurisdiction          text,
  state                 text check (state is null or state ~ '^[A-Z]{2}$'),
  region                text,
  provider_type         text not null check (provider_type in ('state_dot', 'state_511', 'regional', 'municipal', 'county', 'federal', 'police', 'fire_ems', 'cad_911', 'regional_911', 'emergency_management')),
  adapter_type          text not null,
  coverage_status       text not null default 'UNKNOWN' check (coverage_status in ('FULL', 'PARTIAL', 'METRO_ONLY', 'METADATA_ONLY', 'HISTORICAL_ONLY', 'NO_PUBLIC_FEED', 'UNKNOWN')),
  enabled               boolean not null default false,
  requires_api_key      boolean not null default false,
  attribution           text,
  terms_url             text,
  image_policy          text check (image_policy is null or image_policy in ('proxy', 'direct', 'link_only')),
  refresh_interval_sec  integer not null default 3600 check (refresh_interval_sec >= 120),
  source_cadence_sec    integer check (source_cadence_sec is null or source_cadence_sec > 0),
  health_state          text not null default 'unknown' check (health_state in ('healthy', 'degraded', 'failing', 'disabled', 'unknown')),
  last_attempt_at       timestamptz,
  last_success_at       timestamptz,
  last_failure_at       timestamptz,
  failure_reason        text,
  consecutive_failures  integer not null default 0,
  next_refresh_at       timestamptz,
  lease_owner           text,
  lease_until           timestamptz,
  item_count            integer not null default 0,
  stats                 jsonb not null default '{}'::jsonb,
  last_latency_ms       integer,
  updated_at            timestamptz not null default now()
);
create index if not exists map_world_providers_domain_idx on public.map_world_providers (domain);

create table if not exists public.map_cameras (
  camera_id             text primary key,
  provider_id           text not null references public.map_world_providers(provider_id) on delete cascade,
  external_camera_id    text not null,
  name                  text,
  state                 text,
  county                text,
  city                  text,
  road                  text,
  route                 text,
  direction             text check (direction is null or direction in ('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'BOTH')),
  mile_marker           double precision,
  latitude              double precision not null check (latitude between -90 and 90),
  longitude             double precision not null check (longitude between -180 and 180),
  geom                  geometry(Point, 4326) generated always as (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)) stored,
  status                text not null default 'UNKNOWN' check (status in ('LIVE', 'STALE', 'OFFLINE', 'UNKNOWN', 'MAINTENANCE', 'BLOCKED_BY_PROVIDER')),
  feed_type             text not null default 'UNAVAILABLE' check (feed_type in ('STILL_IMAGE', 'REFRESHING_STILL', 'MJPEG', 'HLS', 'VIDEO_STREAM', 'PROVIDER_PAGE_ONLY', 'UNAVAILABLE')),
  still_url             text,
  stream_url            text,
  thumbnail_url         text,
  provider_page_url     text,
  snapshot_cadence_sec  integer,
  provider_updated_at   timestamptz,
  timezone              text,
  corridor_key          text,
  corridor_rank         double precision,
  duplicate_of          text,
  metadata              jsonb not null default '{}'::jsonb,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  leadcommand_refreshed_at timestamptz not null default now(),
  missing_since         timestamptz,
  retired_at            timestamptz,
  unique (provider_id, external_camera_id)
);

-- The viewport, grid and nearby queries only ever read active, primary cameras.
create index if not exists map_cameras_active_geom_gix on public.map_cameras using gist (geom)
  where retired_at is null and duplicate_of is null;
create index if not exists map_cameras_corridor_idx on public.map_cameras (corridor_key, corridor_rank)
  where retired_at is null and duplicate_of is null;
create index if not exists map_cameras_provider_seen_idx on public.map_cameras (provider_id, last_seen_at);

create table if not exists public.map_world_provider_runs (
  id                 bigint generated always as identity primary key,
  provider_id        text not null,
  domain             text not null,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  ok                 boolean,
  items_received     integer,
  items_normalized   integer,
  items_upserted     integer,
  items_missing      integer,
  items_retired      integer,
  duplicates_marked  integer,
  schema_errors      integer,
  latency_ms         integer,
  error              text
);
create index if not exists map_world_provider_runs_provider_idx on public.map_world_provider_runs (provider_id, started_at desc);

-- ── bounded reads ──────────────────────────────────────────────────────────

-- Cameras inside a viewport. The caller bounds the box; this bounds the rows.
create or replace function public.map_cameras_in_bbox(
  p_west double precision, p_south double precision, p_east double precision, p_north double precision,
  p_limit integer default 2500
) returns table (
  camera_id text, provider_id text, name text, road text, direction text,
  latitude double precision, longitude double precision, status text, feed_type text,
  provider_updated_at timestamptz, snapshot_cadence_sec integer, corridor_key text
) language sql stable set search_path = public as $$
  select c.camera_id, c.provider_id, c.name, c.road, c.direction, c.latitude, c.longitude, c.status, c.feed_type,
         c.provider_updated_at, c.snapshot_cadence_sec, c.corridor_key
  from public.map_cameras c
  where c.retired_at is null and c.duplicate_of is null
    and c.geom && ST_MakeEnvelope(p_west, p_south, p_east, p_north, 4326)
  limit least(greatest(coalesce(p_limit, 2500), 1), 5000);
$$;

-- Coverage at state / region scale: counts per grid cell, never individual cameras.
create or replace function public.map_camera_grid(
  p_west double precision, p_south double precision, p_east double precision, p_north double precision,
  p_cell_deg double precision default 0.5
) returns table (lng double precision, lat double precision, cameras integer, live integer)
language sql stable set search_path = public as $$
  select avg(c.longitude), avg(c.latitude), count(*)::integer,
         count(*) filter (where c.status = 'LIVE')::integer
  from public.map_cameras c
  where c.retired_at is null and c.duplicate_of is null
    and c.geom && ST_MakeEnvelope(p_west, p_south, p_east, p_north, 4326)
  group by floor(c.longitude / greatest(p_cell_deg, 0.01)), floor(c.latitude / greatest(p_cell_deg, 0.01));
$$;

-- Nearest cameras to a point (a selected property), true distance in metres.
create or replace function public.map_cameras_nearby(
  p_lat double precision, p_lng double precision, p_radius_m double precision default 5000, p_limit integer default 6
) returns table (
  camera_id text, provider_id text, name text, road text, direction text,
  latitude double precision, longitude double precision, status text, feed_type text,
  provider_updated_at timestamptz, snapshot_cadence_sec integer, distance_m double precision
) language sql stable set search_path = public as $$
  with pt as (select ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326) as g),
  candidates as (
    select c.*, ST_DistanceSphere(c.geom, pt.g) as d
    from public.map_cameras c, pt
    where c.retired_at is null and c.duplicate_of is null
    order by c.geom <-> pt.g
    limit least(greatest(coalesce(p_limit, 6), 1), 50) * 4
  )
  select camera_id, provider_id, name, road, direction, latitude, longitude, status, feed_type,
         provider_updated_at, snapshot_cadence_sec, d
  from candidates
  where d <= least(greatest(coalesce(p_radius_m, 5000), 50), 80000)
  order by d
  limit least(greatest(coalesce(p_limit, 6), 1), 50);
$$;

-- Candidate duplicate devices: this provider's cameras within a small radius of
-- another provider's. The service decides (road, direction, name, priority).
create or replace function public.map_camera_duplicate_pairs(p_provider_id text, p_radius_m double precision default 40)
returns table (
  camera_id text, provider_id text, name text, road text, direction text, feed_type text, status text, provider_updated_at timestamptz,
  other_camera_id text, other_provider_id text, other_name text, other_road text, other_direction text, other_feed_type text, other_status text, other_provider_updated_at timestamptz,
  distance_m double precision
) language sql stable set search_path = public as $$
  select a.camera_id, a.provider_id, a.name, a.road, a.direction, a.feed_type, a.status, a.provider_updated_at,
         b.camera_id, b.provider_id, b.name, b.road, b.direction, b.feed_type, b.status, b.provider_updated_at,
         ST_DistanceSphere(a.geom, b.geom)
  from public.map_cameras a
  join public.map_cameras b
    on b.provider_id <> a.provider_id
   and b.retired_at is null
   and ST_DWithin(a.geom, b.geom, least(greatest(coalesce(p_radius_m, 40), 5), 200) / 111000.0)
  where a.provider_id = p_provider_id and a.retired_at is null
    and ST_DistanceSphere(a.geom, b.geom) <= least(greatest(coalesce(p_radius_m, 40), 5), 200);
$$;

alter table public.map_world_providers     enable row level security;
alter table public.map_world_provider_runs enable row level security;
alter table public.map_cameras             enable row level security;
revoke all on public.map_world_providers, public.map_world_provider_runs, public.map_cameras from anon, authenticated;
revoke all on function public.map_cameras_in_bbox(double precision, double precision, double precision, double precision, integer) from public, anon, authenticated;
revoke all on function public.map_camera_grid(double precision, double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function public.map_cameras_nearby(double precision, double precision, double precision, integer) from public, anon, authenticated;
revoke all on function public.map_camera_duplicate_pairs(text, double precision) from public, anon, authenticated;
grant execute on function public.map_cameras_in_bbox(double precision, double precision, double precision, double precision, integer) to service_role;
grant execute on function public.map_camera_grid(double precision, double precision, double precision, double precision, double precision) to service_role;
grant execute on function public.map_cameras_nearby(double precision, double precision, double precision, integer) to service_role;
grant execute on function public.map_camera_duplicate_pairs(text, double precision) to service_role;
