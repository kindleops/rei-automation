-- PROPOSED — NOT APPLIED. Owner approval required (EG9 §4.4, D8).
--
-- Entity Graph Overview snapshot: the UNFILTERED universe Overview (every section + the headline),
-- computed by buildOverviewSnapshotRows() (apps/api/src/lib/domain/entity-graph/entity-graph-overview-service.js)
-- right after a successful eg_property_facts refresh (PROPOSED_20261009180000_eg_property_facts.sql:
-- after refresh_entity_graph_read_model at 09:17 UTC and after property imports, outside 11:15–14:30 UTC).
-- The default Overview open (no filters) then reads one row per section instead of scanning the universe:
-- measured 2026-10-09 on prod, the unfiltered pinned band costs 16–17 s on a cold cache through
-- v_entity_graph_properties (the properties heap is ~350 MB) and is the only Overview request that needs it.
--
-- Additive only: one new table. No existing object changes. Reads: service role (direct-PG pool) only.
-- A row is used only while its registry_version equals the API's current field registry (a deploy that
-- changes the registry ignores old rows until the next refresh); filtered cohorts never read it.
-- Rollback: PROPOSED_20261009190000_eg_overview_snapshot_rollback.sql
-- Pretest:  PROPOSED_20261009190000_eg_overview_snapshot_pretest.sql
begin;

create table if not exists public.eg_overview_snapshot (
  tab              text        not null,
  section          text        not null,
  registry_version text        not null,
  payload          jsonb       not null,
  total            bigint      not null,
  source_relation  text        not null,
  refreshed_at     timestamptz not null default now(),
  primary key (tab, section, refreshed_at)
);
create index if not exists eg_overview_snapshot_latest_idx
  on public.eg_overview_snapshot (tab, section, registry_version, refreshed_at desc);

alter table public.eg_overview_snapshot enable row level security;
revoke all on public.eg_overview_snapshot from anon, authenticated;

comment on table public.eg_overview_snapshot is
  'Entity Graph Overview (EG9 §4.4): the unfiltered universe Overview per section, written after each successful eg_property_facts refresh. Never an estimate: each payload is the exact Overview response for that section at refreshed_at. Keep the last 7 days.';

-- The refresh job (after the eg_refresh_log row for eg_property_facts reaches status ok):
--   rows = await buildOverviewSnapshotRows({ query })
--   insert into public.eg_overview_snapshot (tab, section, registry_version, payload, total, source_relation)
--   values ($1, $2, $3, $4::jsonb, $5, $6)  -- one per row, one transaction
--   delete from public.eg_overview_snapshot where refreshed_at < now() - interval '7 days';

commit;
