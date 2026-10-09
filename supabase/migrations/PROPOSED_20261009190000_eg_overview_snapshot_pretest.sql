-- PROPOSED pretest for PROPOSED_20261009190000_eg_overview_snapshot.sql. Read-only checks, then a dry run
-- of the migration inside a transaction that is rolled back.
begin;
set local statement_timeout = '30s';

-- 1. not applied yet (expect: true)
select to_regclass('public.eg_overview_snapshot') is null as snapshot_absent;

-- 2. the relations the snapshot is computed from exist (expect: view true; facts true once its migration is applied)
select to_regclass('public.v_entity_graph_properties') is not null as view_present,
       to_regclass('public.eg_property_facts') is not null as facts_present,
       to_regclass('public.eg_refresh_log') is not null as refresh_log_present;

-- 3. dry run: create the table, write one synthetic row, read it the way the API does, roll everything back
create table public.eg_overview_snapshot (
  tab text not null, section text not null, registry_version text not null, payload jsonb not null,
  total bigint not null, source_relation text not null, refreshed_at timestamptz not null default now(),
  primary key (tab, section, refreshed_at)
);
insert into public.eg_overview_snapshot (tab, section, registry_version, payload, total, source_relation)
values ('properties', 'pinned', 'pretest', '{"id":"pinned","label":"Pinned","fields":[]}'::jsonb, 0, 'v_entity_graph_properties');
select distinct on (section) section, payload ->> 'id' as id
  from public.eg_overview_snapshot
 where tab = 'properties' and section = any(array['pinned']) and registry_version = 'pretest'
 order by section, refreshed_at desc;  -- expect 1 row: pinned | pinned

rollback;
