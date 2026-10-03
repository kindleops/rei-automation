-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED — NOT APPLIED. Browser 1.0 · Save Source (phase 1).
--
-- Owner approval required before this moves to supabase/migrations/ and is
-- applied. Until then /api/cockpit/research/sources answers
-- research_store_unavailable (503) and the dashboard keeps saved sources on
-- the device (localStorage lc.browser.sources.v1), labelled as such.
--
-- WHAT: a research source is a POINTER — a URL the operator chose to attach to
-- a property or company as evidence. It is observational: saving one never
-- changes an owner, value, tax amount or any property fact. (Capture Fact /
-- provenance / IC extraction / Time Machine are future seams, not built.)
--
--   research_sources        one row per attached source
--     research_source_id    uuid
--     object_type           'property' | 'company'
--     object_id             canonical id (properties.property_id, organization id)
--     url                   http(s) only, ≤ 4000 chars
--     page_title            the title the Browser showed (untrusted, display only)
--     destination_type      registry kind (ASSESSOR, GIS, …) when known
--     captured_at / captured_by   captured_by = the Worker-verified operator
--     removed_at            soft remove (the audit keeps the history)
--
--   PROVENANCE ONLY: URL, title, source type, linked object, timestamp,
--   operator. No page content, no notes, no browsing history.
--   OPERATOR-PRIVATE: every read and write is filtered by captured_by; one
--   operator never sees another's saved sources.
--
--   research_source_audit   attach / remove / report_broken / registry_edit
--                           — the same provenance columns plus the action;
--                           no free-form payload (navigation is NEVER audited)
--
-- ACCESS: same posture as operator_home_layouts. RLS on; anon and
-- authenticated hold nothing (self-signup exists on this project, so an "own
-- rows" authenticated policy would bypass the Worker's operator allowlist).
-- Only service_role (the API) reads and writes; the operator id always comes
-- from x-ops-user-id, never from a request body.
--
-- MACHINE FEED: the platform-events `research` adapter reads
-- research_source_audit (action = 'attach') → `research.source_saved`.
--
-- ROLLBACK: 20261002230000_research_sources.rollback.sql (same folder)
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.research_sources (
  research_source_id uuid        primary key default gen_random_uuid(),
  object_type        text        not null check (object_type in ('property', 'company')),
  object_id          text        not null check (char_length(object_id) between 1 and 128),
  url                text        not null check (char_length(url) between 8 and 4000 and url ~* '^https?://'),
  page_title         text        null check (page_title is null or char_length(page_title) <= 300),
  destination_type   text        null check (destination_type is null or destination_type in (
                                   'WEB_SEARCH', 'ASSESSOR', 'TAX', 'RECORDER', 'GIS', 'PERMITS', 'CODE', 'ZILLOW',
                                   'REDFIN', 'REALTOR', 'GOOGLE_MAPS', 'STREET_VIEW', 'COUNTY_PROPERTY_SEARCH', 'STATE_CORPORATE')),
  captured_at        timestamptz not null default now(),
  captured_by        text        not null check (char_length(captured_by) between 1 and 128),
  removed_at         timestamptz null
);

comment on table public.research_sources is
  'Browser 1.0: research pages an operator attached to a property/company. Observational pointers only — never facts. Written only by the API (service role).';

-- one live attachment per (operator, object, url) — sources are operator-private
create unique index if not exists research_sources_live_unique
  on public.research_sources (captured_by, object_type, object_id, url) where removed_at is null;

create index if not exists research_sources_operator_object_recent
  on public.research_sources (captured_by, object_type, object_id, captured_at desc) where removed_at is null;

create table if not exists public.research_source_audit (
  id                 bigint      generated always as identity primary key,
  action             text        not null check (action in ('attach', 'remove', 'report_broken', 'registry_edit')),
  research_source_id uuid        null references public.research_sources (research_source_id) on delete set null,
  object_type        text        null check (object_type is null or object_type in ('property', 'company')),
  object_id          text        null,
  url                text        null check (url is null or char_length(url) <= 4000),
  destination_id     text        null check (destination_id is null or char_length(destination_id) <= 80),
  destination_type   text        null check (destination_type is null or char_length(destination_type) <= 40),
  page_title         text        null check (page_title is null or char_length(page_title) <= 300),
  actor              text        not null check (char_length(actor) between 1 and 128),
  created_at         timestamptz not null default now()
);

comment on table public.research_source_audit is
  'Browser 1.0: attach / remove / report_broken / registry_edit. Navigation is never recorded.';

create index if not exists research_source_audit_recent on public.research_source_audit (created_at desc, id desc);
create index if not exists research_source_audit_object on public.research_source_audit (object_type, object_id, created_at desc);

alter table public.research_sources enable row level security;
alter table public.research_source_audit enable row level security;
revoke all on public.research_sources from public, anon, authenticated;
revoke all on public.research_source_audit from public, anon, authenticated;
grant select, insert, update on public.research_sources to service_role;
grant select, insert on public.research_source_audit to service_role;

drop policy if exists "research sources service role" on public.research_sources;
create policy "research sources service role" on public.research_sources
  for all to service_role using (true) with check (true);
drop policy if exists "research source audit service role" on public.research_source_audit;
create policy "research source audit service role" on public.research_source_audit
  for all to service_role using (true) with check (true);
