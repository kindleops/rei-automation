-- SEARCH INTELLIGENCE — extractable domain. PROPOSED 2026-10-01, NOT APPLIED.
--
-- STATUS: proposal only (RC 7.1 workstream C2). Do not apply without owner
-- approval. The PROPOSED_ prefix keeps it outside `supabase db push`.
-- No feature reads or writes these tables yet; nothing is built on them.
--
-- DESIGN RULES
-- * EXTRACTABLE: every table is prefixed search_, references ONLY other
--   search_* tables, and has its own updated_at trigger function. No foreign
--   key into or out of seller / campaign / deal / property / send tables, and
--   no SEO column is added to any existing table. Geography links to the
--   operation only through a soft text key (search_geo_targets.canonical_market_id)
--   so the whole domain can be dumped with
--     pg_dump -t 'public.search_*' -t 'public.search_touch_updated_at'
--   and moved to its own project/schema later without breaking the operation.
--   (Alternative considered: a dedicated `search` schema. Rejected for now:
--   apps/api reads through supabase-js/PostgREST, which would need the schema
--   exposed in API settings. Revisit at extraction time.)
-- * Provider-neutral: every fact row carries provider + source + the sync run
--   that wrote it, and the run carries the provider's own data-through date
--   (Search Console lags 2–3 days; a day with no row is "not yet reported",
--   never zero).
-- * Private: RLS on, no policies, anon/authenticated revoked. Access is
--   service_role only (apps/api), matching the operator-allowlist gate.
-- * Goals are NOT a separate search table: Search goals are operator_goals
--   rows whose metric_id is a Lab external metric (gsc_clicks, gsc_impressions,
--   gsc_ctr, gsc_position — apps/api/src/lib/domain/analytics/lab/metric-registry.js
--   EXTERNAL_SOURCES) scoped to a site. See PROPOSED_20261001132000_operator_goals.sql.
--
-- Table names after schema review (brief names kept except search_goals,
-- folded into operator_goals):
--   search_sites, search_page_families, search_geo_targets, search_pages,
--   search_queries, search_performance_daily, search_issues,
--   search_opportunities, search_sync_runs
--
-- LOCKS / BACKFILL: new objects only; no existing table touched; no backfill.
-- ROLLBACK:
--   drop table if exists public.search_opportunities, public.search_issues,
--     public.search_performance_daily, public.search_pages, public.search_queries,
--     public.search_geo_targets, public.search_page_families, public.search_sync_runs,
--     public.search_sites cascade;
--   drop function if exists public.search_touch_updated_at();

begin;

create or replace function public.search_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- A site we measure (one per verified provider property).
create table if not exists public.search_sites (
  id            uuid primary key default gen_random_uuid(),
  site_key      text not null unique check (site_key ~ '^[a-z0-9][a-z0-9_.-]{1,63}$'),
  domain        text not null,                       -- e.g. reivesti.com
  provider      text not null check (provider in ('google_search_console', 'bing_webmaster', 'manual')),
  provider_property text not null,                   -- e.g. sc-domain:reivesti.com
  serving_codebase text,                             -- which deploy answers the domain (evidence, free text)
  status        text not null default 'pending' check (status in ('pending', 'connected', 'paused', 'retired')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (provider, provider_property)
);

-- Template families (state page, market page, article, tool …).
create table if not exists public.search_page_families (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.search_sites(id) on delete cascade,
  family_key    text not null check (family_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  label         text not null,
  url_pattern   text,                                -- route pattern, e.g. /sell/{state}/{city}
  source        text not null default 'registry',    -- registry | crawl | manual
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (site_id, family_key)
);

-- Geography a page targets. canonical_market_id is a SOFT reference
-- (text, no FK) to the operation's canonical market so the domain stays extractable.
create table if not exists public.search_geo_targets (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.search_sites(id) on delete cascade,
  geo_type      text not null check (geo_type in ('country', 'state', 'county', 'city', 'zip', 'neighborhood', 'market')),
  geo_key       text not null,                       -- normalised key, e.g. tx/dallas
  label         text not null,
  canonical_market_id text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (site_id, geo_type, geo_key)
);

-- Known URLs.
create table if not exists public.search_pages (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.search_sites(id) on delete cascade,
  url           text not null,
  path          text not null,
  page_family_id uuid references public.search_page_families(id) on delete set null,
  geo_target_id  uuid references public.search_geo_targets(id) on delete set null,
  canonical_url text,
  in_sitemap    boolean,
  index_status  text check (index_status is null or index_status in ('indexed', 'not_indexed', 'excluded', 'unknown')),
  http_status   integer,
  source        text not null default 'sitemap',     -- sitemap | provider | crawl | registry
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz,
  last_checked_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (site_id, url)
);
create index if not exists search_pages_family_idx on public.search_pages (page_family_id);
create index if not exists search_pages_geo_idx    on public.search_pages (geo_target_id);

-- Distinct search queries seen for a site.
create table if not exists public.search_queries (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.search_sites(id) on delete cascade,
  query         text not null check (char_length(query) between 1 and 512),
  first_seen_on date,
  created_at    timestamptz not null default now(),
  unique (site_id, query)
);

-- Provider sync runs (what was asked, what came back, data-through date).
create table if not exists public.search_sync_runs (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.search_sites(id) on delete cascade,
  provider      text not null,
  scope         text not null check (scope in ('performance', 'pages', 'sitemaps', 'inspection', 'issues')),
  window_start  date,
  window_end    date,
  data_through  date,                                -- provider's own last complete day
  status        text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'partial')),
  rows_written  integer not null default 0,
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists search_sync_runs_site_started_idx on public.search_sync_runs (site_id, started_at desc);

-- Daily performance facts at provider grain. page_id/query_id NULL = the
-- provider's aggregate row for that dimension cut (kept distinct from a
-- sum of children; Search Console anonymises rare queries). position is the
-- provider's impression-weighted average; aggregate it as
-- sum(position * impressions) / sum(impressions).
create table if not exists public.search_performance_daily (
  id            bigint generated always as identity primary key,
  site_id       uuid not null references public.search_sites(id) on delete cascade,
  provider      text not null,
  day           date not null,
  search_type   text not null default 'web',         -- web | image | video | news | discover
  page_id       uuid references public.search_pages(id) on delete cascade,
  query_id      uuid references public.search_queries(id) on delete cascade,
  country       text,                                -- ISO-3166 alpha-3 as reported
  device        text,                                -- desktop | mobile | tablet
  clicks        integer not null check (clicks >= 0),
  impressions   integer not null check (impressions >= 0),
  position      numeric(8, 3) check (position is null or position >= 1),
  sync_run_id   uuid references public.search_sync_runs(id) on delete set null,
  ingested_at   timestamptz not null default now(),
  constraint search_performance_daily_grain_key unique nulls not distinct
    (site_id, provider, day, search_type, page_id, query_id, country, device)
);
create index if not exists search_performance_daily_site_day_idx  on public.search_performance_daily (site_id, day);
create index if not exists search_performance_daily_page_day_idx  on public.search_performance_daily (page_id, day) where page_id is not null;
create index if not exists search_performance_daily_query_day_idx on public.search_performance_daily (query_id, day) where query_id is not null;

-- Technical / indexing issues (from provider or our own checks).
create table if not exists public.search_issues (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.search_sites(id) on delete cascade,
  page_id       uuid references public.search_pages(id) on delete cascade,
  issue_type    text not null,                       -- e.g. not_indexed, canonical_mismatch, http_error, missing_from_sitemap
  severity      text not null check (severity in ('blocker', 'high', 'medium', 'low')),
  source        text not null,                       -- provider | crawler | registry_check
  details       jsonb not null default '{}'::jsonb,
  detected_at   timestamptz not null default now(),
  resolved_at   timestamptz,
  sync_run_id   uuid references public.search_sync_runs(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists search_issues_open_uniq
  on public.search_issues (site_id, page_id, issue_type) nulls not distinct where resolved_at is null;
create index if not exists search_issues_site_open_idx on public.search_issues (site_id, severity) where resolved_at is null;

-- Computed opportunities (striking-distance queries, uncovered geos …).
-- Always derived from facts; evidence + model_version make them reproducible.
create table if not exists public.search_opportunities (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.search_sites(id) on delete cascade,
  opportunity_type text not null,                    -- striking_distance | low_ctr | uncovered_geo | cannibalisation
  page_id       uuid references public.search_pages(id) on delete cascade,
  query_id      uuid references public.search_queries(id) on delete cascade,
  geo_target_id uuid references public.search_geo_targets(id) on delete cascade,
  score         numeric(6, 3),
  evidence      jsonb not null default '{}'::jsonb,  -- window, clicks, impressions, position used
  model_version text not null,
  status        text not null default 'open' check (status in ('open', 'accepted', 'dismissed', 'done')),
  computed_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists search_opportunities_open_uniq
  on public.search_opportunities (site_id, opportunity_type, page_id, query_id, geo_target_id) nulls not distinct
  where status = 'open';

-- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['search_sites', 'search_page_families', 'search_geo_targets', 'search_pages',
                           'search_issues', 'search_opportunities'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.search_touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- Access: service_role only.
do $$
declare t text;
begin
  foreach t in array array['search_sites', 'search_page_families', 'search_geo_targets', 'search_pages',
                           'search_queries', 'search_sync_runs', 'search_performance_daily',
                           'search_issues', 'search_opportunities'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;
revoke all on function public.search_touch_updated_at() from public, anon, authenticated;

commit;
