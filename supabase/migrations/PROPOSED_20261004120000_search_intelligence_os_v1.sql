-- SEARCH INTELLIGENCE OS V1 — cross-brand search domain. PROPOSED 2026-10-04, NOT APPLIED.
--
-- STATUS: proposal only. Do not apply without owner approval. The PROPOSED_
-- prefix keeps it outside `supabase db push`. Rollback:
-- PROPOSED_20261004120000_search_intelligence_os_v1_rollback.sql.
--
-- SUPERSEDES apps/api/supabase/migrations/PROPOSED_20261001130000_search_intelligence.sql
-- (also never applied). Apply THIS file or that one, never both. What changed and why:
--   * search_sites (one row per provider property) conflated the brand/site with its
--     provider connection. Split into search_properties (the web property, its lifecycle)
--     and search_property_connections (one row per provider, state + secret REFERENCE).
--     A property exists, and is useful, before any provider does — pre-launch is first-class.
--   * search_page_families → a text `family` on search_pages. Families differ per property
--     (Prominent: market-state/county/city/situation; Reivesti: state/metro/role/wholesale-metro)
--     and a new brand must not need a migration; the canonical family list lives in each
--     property's own source registry.
--   * search_geo_targets → search_geographies, shared across properties (one Miami, many
--     brands), with search_page_geographies as the M:N link.
--   * search_queries → search_keywords, now planned objects too (source PLANNED / OPERATOR /
--     IMPORT / SEARCH_CONSOLE / EXTERNAL_RESEARCH), grouped by search_keyword_clusters, with
--     canonical ownership ENFORCED by a unique index (search_keyword_page_ownership).
--   * search_pages gains the URL-OS fields (registry stage facts, status, copy + copy_state,
--     launch wave, primary cluster) and search_page_aliases guards duplicate routes/aliases.
--   * search_issues → search_health_checks (same shape, broader: technical + registry checks).
--   * search_performance_daily and search_sync_runs are kept unchanged in spirit.
--   * New: search_launch_waves, search_page_relationships, search_page_metrics_daily
--     (analytics grain), search_events (first-party telemetry, privacy-checked),
--     search_keyword_research (optional external vendors).
--
-- DESIGN RULES (unchanged from the 10-01 proposal)
-- * EXTRACTABLE: every object is prefixed search_, references only search_* objects, and
--   carries no FK into seller / campaign / deal / property / send tables. Geography links to
--   LeadCommand only through a SOFT text key (search_geographies.canonical_market_id).
--     pg_dump -t 'public.search_*' -t 'public.search_touch_updated_at'
-- * PROVIDER-NEUTRAL FACTS: every fact row carries provider + sync run; a day with no row is
--   "not yet reported", never zero. Nothing in this schema defaults a measure to 0.
-- * NO SECRETS IN ROWS: search_property_connections.secret_ref is the NAME of a server-side
--   secret (e.g. SI_GSC_PROMINENT); a check rejects anything shaped like key material.
-- * PRIVATE: RLS on, no policies, anon/authenticated revoked. service_role only (apps/api).
-- * PLANS ARE DATA: pages/clusters/waves may exist with no provider at all.
--
-- LOCKS / BACKFILL: new objects only; no existing table touched; no backfill. Seeding from
-- the planning snapshots (apps/dashboard/src/modules/search-intelligence/data/snapshots/*)
-- would be a separate, reviewed data migration.

begin;

create or replace function public.search_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ── properties ──────────────────────────────────────────────────────────────
create table if not exists public.search_properties (
  id            text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),   -- 'prominent', 'offerr', …
  brand         text not null,
  domain        text not null unique,                 -- apex, e.g. prominentcashoffer.com
  origin        text not null check (origin ~ '^https://'),
  strategy      text not null,                        -- free text: new brands need no migration
  thesis        text,
  lifecycle     text not null default 'PLANNED' check (lifecycle in
                  ('PLANNED','BUILDING','READY_FOR_VERIFICATION','LIVE','CONNECTED','BASELINE_COLLECTION','ACTIVE_INTELLIGENCE')),
  lifecycle_note text,
  launched_at   date,
  excluded_hosts text[] not null default '{}',        -- e.g. {ops.leadcommand.ai}
  display_order integer not null default 100,
  sources       jsonb not null default '[]'::jsonb,   -- provenance of the plan (repo, branch, commit)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.search_property_connections (
  id            uuid primary key default gen_random_uuid(),
  property_id   text not null references public.search_properties(id) on delete cascade,
  provider      text not null check (provider in ('SEARCH_CONSOLE','GA4','FIRST_PARTY','CLOUDFLARE','EXTERNAL_RESEARCH','LEADCOMMAND')),
  vendor        text,                                 -- DATAFORSEO | SEMRUSH | AHREFS for EXTERNAL_RESEARCH
  state         text not null default 'NOT_CONFIGURED' check (state in
                  ('NOT_CONFIGURED','AWAITING_SITE','AWAITING_ACCESS','VERIFYING','CONNECTED','SYNCING','DEGRADED','ERROR','PAUSED','NOT_APPLICABLE')),
  provider_property text,                             -- e.g. sc-domain:reivesti.com, properties/123 — identifiers, not secrets
  secret_ref    text check (secret_ref is null or (secret_ref ~ '^SI_[A-Z0-9_]{2,60}$')),  -- NAME of a server-side secret only (apps/api secret-store.js)
  last_sync_at  timestamptz,
  data_through  date,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (property_id, provider, vendor)
);

-- ── plans ───────────────────────────────────────────────────────────────────
create table if not exists public.search_launch_waves (
  id            text primary key,                     -- 'pco:w:1', 'rv:w:0'
  property_id   text not null references public.search_properties(id) on delete cascade,
  label         text not null,
  wave_order    integer not null,
  status        text not null default 'PLANNED' check (status in ('PLANNED','IN_PROGRESS','READY','LAUNCHED','BLOCKED')),
  target_date   date,
  depends_on    text[] not null default '{}',
  blockers      text[] not null default '{}',
  notes         text,
  source        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (property_id, wave_order)
);

-- Shared geography. canonical_market_id is a SOFT key to LeadCommand (no FK).
create table if not exists public.search_geographies (
  id            text primary key,                     -- 'us', 'us-fl', 'us-fl-miami-dade-county', 'us-fl-miami'
  kind          text not null check (kind in ('COUNTRY','STATE','METRO','COUNTY','CITY')),
  name          text not null,
  code          text,                                 -- USPS for states, FIPS for counties when known
  parent_id     text references public.search_geographies(id) on delete restrict,
  state_code    text,
  lat           numeric(8, 5),
  lng           numeric(8, 5),
  canonical_market_id text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists search_geographies_parent_idx on public.search_geographies (parent_id);

create table if not exists public.search_keyword_clusters (
  id            text primary key,
  property_id   text not null references public.search_properties(id) on delete cascade,
  label         text not null,
  primary_keyword text,                               -- null = family named, not yet researched
  parent_topic  text,
  intent        text,
  geo_level     text check (geo_level is null or geo_level in ('COUNTRY','STATE','METRO','COUNTY','CITY')),
  owner_ref     text,                                 -- the owner as the plan names it, even if unregistered
  priority      text check (priority is null or priority in ('P0','P1','P2','P3')),
  wave_id       text references public.search_launch_waves(id) on delete set null,
  source        text not null default 'PLANNED' check (source in ('PLANNED','SEARCH_CONSOLE','EXTERNAL_RESEARCH','OPERATOR','IMPORT')),
  provenance    jsonb not null default '{}'::jsonb,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists search_keyword_clusters_primary_uniq
  on public.search_keyword_clusters (property_id, lower(primary_keyword)) where primary_keyword is not null;

-- The URL OS: one canonical registry row per URL.
create table if not exists public.search_pages (
  id            text primary key,
  property_id   text not null references public.search_properties(id) on delete cascade,
  path          text not null check (path ~ '^/' and (path = '/' or path !~ '/$')),   -- normalised: leading slash, no trailing slash
  family        text not null,
  parent_id     text references public.search_pages(id) on delete set null,
  intent        text,
  primary_cluster_id text references public.search_keyword_clusters(id) on delete set null,
  primary_keyword text,
  secondary_keywords text[] not null default '{}',
  -- copy is displayed only from the governed source; approval is a recorded fact
  title         text,
  h1            text,
  meta_description text,
  copy_state    text not null default 'NOT_WRITTEN' check (copy_state in ('APPROVED','SOURCE_UNAPPROVED','NOT_WRITTEN')),
  copy_approved_by text,
  copy_approved_at timestamptz,
  canonical_path text,
  schema_types  text[] not null default '{}',
  indexability  text not null default 'UNDECIDED' check (indexability in ('INDEX','NOINDEX','COMPUTED_BY_GATE','UNDECIDED')),
  robots        text,
  in_sitemap    boolean,
  launch_wave_id text references public.search_launch_waves(id) on delete set null,
  status        text not null default 'PLANNED' check (status in
                  ('PLANNED','RESEARCHED','COPY_READY','BUILDING','QA','READY','PUBLISHED','INDEXED','NEEDS_WORK')),
  -- the four registry facts, recorded separately and never inferred from each other
  is_planned    boolean not null default true,
  is_built_route boolean not null default false,
  is_published  boolean not null default false,
  is_indexed    boolean,                              -- null until Search Console reports
  thesis        text,
  notes         text,
  source        jsonb not null default '{}'::jsonb,
  source_fields jsonb not null default '[]'::jsonb,
  legacy_evidence jsonb,                              -- labelled, windowed historical export; never a live measure
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint search_pages_copy_approval check (copy_state <> 'APPROVED' or (copy_approved_by is not null and copy_approved_at is not null)),
  constraint search_pages_published_built check (not is_published or is_built_route)
);
-- one route per property, case-insensitive: duplicate routes and case aliases are rejected
create unique index if not exists search_pages_route_uniq on public.search_pages (property_id, lower(path));
create index if not exists search_pages_parent_idx on public.search_pages (parent_id);
create index if not exists search_pages_wave_idx   on public.search_pages (launch_wave_id);
create index if not exists search_pages_cluster_idx on public.search_pages (primary_cluster_id);

-- Paths that must redirect to a page. An alias may not also be a page or another page's alias.
create table if not exists public.search_page_aliases (
  property_id   text not null references public.search_properties(id) on delete cascade,
  alias_path    text not null check (alias_path ~ '^/'),
  page_id       text not null references public.search_pages(id) on delete cascade,
  disposition   text not null default 'redirect-301' check (disposition in ('redirect-301','redirect-302','canonical-only')),
  created_at    timestamptz not null default now(),
  primary key (property_id, alias_path)
);
create unique index if not exists search_page_aliases_ci_uniq on public.search_page_aliases (property_id, lower(alias_path));

create or replace function public.search_alias_not_a_page()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.search_pages p where p.property_id = new.property_id and lower(p.path) = lower(new.alias_path)) then
    raise exception 'alias % is a registered page of %', new.alias_path, new.property_id;
  end if;
  return new;
end $$;
drop trigger if exists search_page_aliases_not_page on public.search_page_aliases;
create trigger search_page_aliases_not_page before insert or update on public.search_page_aliases
  for each row execute function public.search_alias_not_a_page();

create table if not exists public.search_page_relationships (
  from_page_id  text not null references public.search_pages(id) on delete cascade,
  to_page_id    text not null references public.search_pages(id) on delete cascade,
  kind          text not null check (kind in ('parent','related','nav','content','planned')),
  anchor_cluster_id text references public.search_keyword_clusters(id) on delete set null,
  source        text not null default 'registry',     -- registry | link-audit | crawl | operator
  created_at    timestamptz not null default now(),
  primary key (from_page_id, to_page_id, kind),
  check (from_page_id <> to_page_id)
);
create index if not exists search_page_relationships_to_idx on public.search_page_relationships (to_page_id);

create table if not exists public.search_page_geographies (
  page_id       text not null references public.search_pages(id) on delete cascade,
  geography_id  text not null references public.search_geographies(id) on delete restrict,
  role          text not null default 'primary' check (role in ('primary','secondary')),
  primary key (page_id, geography_id)
);
create index if not exists search_page_geographies_geo_idx on public.search_page_geographies (geography_id);

create table if not exists public.search_keywords (
  id            text primary key,
  property_id   text not null references public.search_properties(id) on delete cascade,
  query         text not null check (char_length(query) between 1 and 512),
  cluster_id    text references public.search_keyword_clusters(id) on delete set null,
  intent        text,
  geography_id  text references public.search_geographies(id) on delete set null,
  assigned_page_id text references public.search_pages(id) on delete set null,
  status        text not null default 'PLANNED' check (status in ('PLANNED','MAPPED','TARGETED','RANKING','RETIRED')),
  priority      text check (priority is null or priority in ('P0','P1','P2','P3')),
  source        text not null check (source in ('PLANNED','SEARCH_CONSOLE','EXTERNAL_RESEARCH','OPERATOR','IMPORT')),
  provenance    jsonb not null default '{}'::jsonb,
  first_seen_on date,                                 -- SEARCH_CONSOLE-sourced rows only
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists search_keywords_query_uniq on public.search_keywords (property_id, lower(query));
create index if not exists search_keywords_cluster_idx on public.search_keywords (cluster_id);

-- Canonical ownership, enforced: at most ONE primary owner per cluster per geography.
-- Templated clusters ("{state} …") carry a geography_id per owner; national clusters use null.
create table if not exists public.search_keyword_page_ownership (
  cluster_id    text not null references public.search_keyword_clusters(id) on delete cascade,
  page_id       text not null references public.search_pages(id) on delete cascade,
  geography_id  text references public.search_geographies(id) on delete cascade,
  role          text not null check (role in ('PRIMARY','SUPPORTING')),
  decided_by    text,
  decided_at    timestamptz not null default now(),
  primary key (cluster_id, page_id)
);
create unique index if not exists search_ownership_one_primary
  on public.search_keyword_page_ownership (cluster_id, geography_id) nulls not distinct where role = 'PRIMARY';

-- ── provider facts ──────────────────────────────────────────────────────────
create table if not exists public.search_sync_runs (
  id            uuid primary key default gen_random_uuid(),
  property_id   text not null references public.search_properties(id) on delete cascade,
  provider      text not null,
  scope         text not null check (scope in ('performance','pages','sitemaps','inspection','analytics','research','events')),
  window_start  date,
  window_end    date,
  data_through  date,
  status        text not null default 'running' check (status in ('running','succeeded','failed','partial')),
  rows_written  integer not null default 0,
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists search_sync_runs_property_started_idx on public.search_sync_runs (property_id, started_at desc);

-- Search Console facts at provider grain (query × page × day × device × country).
-- page_id/keyword_id NULL = the provider's aggregate row for that cut (never a sum of children:
-- Search Console anonymises rare queries). position aggregates as sum(position*impressions)/sum(impressions).
create table if not exists public.search_performance_daily (
  id            bigint generated always as identity primary key,
  property_id   text not null references public.search_properties(id) on delete cascade,
  provider      text not null default 'SEARCH_CONSOLE',
  day           date not null,
  search_type   text not null default 'web',
  page_id       text references public.search_pages(id) on delete cascade,
  page_url      text,                                 -- as reported, for URLs not (yet) in the registry
  keyword_id    text references public.search_keywords(id) on delete cascade,
  country       text,
  device        text,
  clicks        integer not null check (clicks >= 0),
  impressions   integer not null check (impressions >= 0),
  position      numeric(8, 3) check (position is null or position >= 1),
  sync_run_id   uuid references public.search_sync_runs(id) on delete set null,
  ingested_at   timestamptz not null default now(),
  constraint search_performance_daily_grain_key unique nulls not distinct
    (property_id, provider, day, search_type, page_id, page_url, keyword_id, country, device)
);
create index if not exists search_performance_daily_property_day_idx on public.search_performance_daily (property_id, day);
create index if not exists search_performance_daily_page_day_idx on public.search_performance_daily (page_id, day) where page_id is not null;
create index if not exists search_performance_daily_keyword_day_idx on public.search_performance_daily (keyword_id, day) where keyword_id is not null;

-- Analytics facts per page per day per provider (GA4 / FIRST_PARTY / CLOUDFLARE). Nullable = not reported.
create table if not exists public.search_page_metrics_daily (
  id            bigint generated always as identity primary key,
  property_id   text not null references public.search_properties(id) on delete cascade,
  provider      text not null check (provider in ('GA4','FIRST_PARTY','CLOUDFLARE')),
  day           date not null,
  page_id       text references public.search_pages(id) on delete cascade,
  page_url      text,
  source_medium text,
  region        text,
  sessions      integer check (sessions is null or sessions >= 0),
  users         integer check (users is null or users >= 0),
  conversions   integer check (conversions is null or conversions >= 0),
  sync_run_id   uuid references public.search_sync_runs(id) on delete set null,
  ingested_at   timestamptz not null default now(),
  constraint search_page_metrics_daily_grain_key unique nulls not distinct (property_id, provider, day, page_id, page_url, source_medium, region)
);
create index if not exists search_page_metrics_daily_property_day_idx on public.search_page_metrics_daily (property_id, day);

-- First-party telemetry (designed, not deployed). Opaque random ids only; contact data is rejected.
create table if not exists public.search_events (
  id            bigint generated always as identity primary key,
  property_id   text not null references public.search_properties(id) on delete cascade,
  event         text not null check (event in ('page_view','cta_click','form_start','form_submit','address_entered','valuation_started',
                  'valuation_completed','offer_presented','lead_created','conversation_started','offer_created','contract_created','deal_closed')),
  origin        text not null default 'site' check (origin in ('site','leadcommand-bridge')),
  anonymous_id  text not null check (anonymous_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  session_id    text not null check (session_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  page_id       text references public.search_pages(id) on delete set null,
  path          text,
  occurred_at   timestamptz not null,
  received_at   timestamptz not null default now(),
  props         jsonb not null default '{}'::jsonb,
  constraint search_events_no_contact_fields check (not (props ?| array[
    'email','phone','tel','mobile','name','first_name','last_name','full_name','address','street','raw_address','ip','ip_address','lat','lng','latitude','longitude','user_agent'])),
  -- bridge outcomes may only arrive from the bridge
  constraint search_events_outcome_origin check (
    origin = 'leadcommand-bridge' or event not in ('lead_created','conversation_started','offer_created','contract_created','deal_closed'))
);
create index if not exists search_events_property_time_idx on public.search_events (property_id, occurred_at desc);
create index if not exists search_events_session_idx on public.search_events (session_id);

-- Optional external research (DataForSEO / Semrush / Ahrefs). Dated; never required by any surface.
create table if not exists public.search_keyword_research (
  id            bigint generated always as identity primary key,
  keyword_id    text not null references public.search_keywords(id) on delete cascade,
  vendor        text not null check (vendor in ('DATAFORSEO','SEMRUSH','AHREFS','KEYWORD_PLANNER')),
  location      text not null,
  language      text not null default 'en',
  volume        integer check (volume is null or volume >= 0),
  difficulty    numeric(5, 2),
  serp          jsonb,
  fetched_at    timestamptz not null,
  sync_run_id   uuid references public.search_sync_runs(id) on delete set null,
  unique (keyword_id, vendor, location, language, fetched_at)
);

-- Technical, indexing and registry checks (crawler, provider, registry validator).
create table if not exists public.search_health_checks (
  id            uuid primary key default gen_random_uuid(),
  property_id   text not null references public.search_properties(id) on delete cascade,
  page_id       text references public.search_pages(id) on delete cascade,
  check_type    text not null,                        -- duplicate_route | accidental_alias | conflicting_canonical | orphan | not_indexed | http_error …
  severity      text not null check (severity in ('BLOCKER','HIGH','MEDIUM','LOW')),
  source        text not null,                        -- registry_validator | link_audit | provider | crawler
  details       jsonb not null default '{}'::jsonb,
  detected_at   timestamptz not null default now(),
  resolved_at   timestamptz,
  sync_run_id   uuid references public.search_sync_runs(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists search_health_checks_open_uniq
  on public.search_health_checks (property_id, page_id, check_type) nulls not distinct where resolved_at is null;

-- Deterministic opportunities. rule_id + evidence make every row reproducible; `why` is the rule's reason.
create table if not exists public.search_opportunities (
  id            text primary key,                     -- rule + subject, stable
  property_id   text not null references public.search_properties(id) on delete cascade,
  rule_id       text not null,
  phase         text not null check (phase in ('PRE_LAUNCH','LIVE')),
  severity      text not null check (severity in ('BLOCKER','HIGH','MEDIUM','LOW')),
  title         text not null,
  why           text not null,
  evidence      jsonb not null default '[]'::jsonb,
  subject_kind  text not null check (subject_kind in ('property','page','keyword','cluster','geography','wave','opportunity')),
  subject_id    text not null,
  related       jsonb not null default '[]'::jsonb,
  engine_version text not null,
  status        text not null default 'open' check (status in ('open','accepted','dismissed','done')),
  computed_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists search_opportunities_property_open_idx on public.search_opportunities (property_id, severity) where status = 'open';

-- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['search_properties','search_property_connections','search_launch_waves','search_geographies',
                           'search_keyword_clusters','search_pages','search_keywords','search_health_checks','search_opportunities'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.search_touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- Access: service_role only.
do $$
declare t text;
begin
  foreach t in array array['search_properties','search_property_connections','search_launch_waves','search_geographies',
                           'search_keyword_clusters','search_pages','search_page_aliases','search_page_relationships',
                           'search_page_geographies','search_keywords','search_keyword_page_ownership','search_sync_runs',
                           'search_performance_daily','search_page_metrics_daily','search_events','search_keyword_research',
                           'search_health_checks','search_opportunities'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;
revoke all on function public.search_touch_updated_at() from public, anon, authenticated;
revoke all on function public.search_alias_not_a_page() from public, anon, authenticated;

commit;
