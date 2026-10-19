-- DISPOSABLE DATABASE ONLY: setup for the OPTIONAL lc_mcp_reader link (#26) of the rc-8.5.21 release
-- chain (scripts/db/migration-tests.manifest.mjs, rc_8_5_21_release_chain and its production-state
-- twin). NEVER run against Supabase.
--
-- The chain's own fixtures model the public tables the chain migrations touch. lc_mcp_reader needs
-- the MCP read inventory (20 relations, 2 app RPCs) on top. This file creates ONLY what is still
-- missing after the chain's setup, minimally and idempotently (if not exists / to_regclass guards),
-- so a chain fixture's production-shaped definition always wins. Tables it creates get RLS enabled,
-- as in production since the operator lockdown. census_geo_metrics is deliberately NOT created:
-- the migration's optional-relation path runs in the chain.
do $do$
declare
  t text;
  created text[] := '{}';
  ddl constant jsonb := jsonb_build_object(
    'properties', 'create table public.properties (property_id text primary key, master_owner_id text, property_address_full text, property_address_zip text, latitude numeric, longitude numeric, market text, units_count int)',
    'master_owners', 'create table public.master_owners (master_owner_id text primary key, display_name text)',
    'prospects', 'create table public.prospects (prospect_id text primary key, master_owner_id text, full_name text)',
    'phones', 'create table public.phones (phone_id text primary key, master_owner_id text, canonical_e164 text)',
    'emails', 'create table public.emails (email_id text primary key, master_owner_id text, email text)',
    'property_acquisition_scores', 'create table public.property_acquisition_scores (property_id text primary key, aos_score numeric, computed_at timestamptz)',
    'eg_property_facts', 'create table public.eg_property_facts (property_id text primary key, market text, zip_code text)',
    'campaign_target_graph', 'create table public.campaign_target_graph (property_id text not null, canonical_e164 text, sms_eligible boolean)',
    'campaigns', 'create table public.campaigns (id uuid primary key, name text, status text)',
    'campaign_targets', 'create table public.campaign_targets (id uuid primary key, campaign_id uuid, property_id text, target_status text)',
    'mi_rollup_builds', 'create table public.mi_rollup_builds (build_id int primary key, status text)',
    'mi_geo_period_rollup', 'create table public.mi_geo_period_rollup (build_id int not null, geo_key text, period text, sale_count int)',
    'sms_suppression_list', 'create table public.sms_suppression_list (id uuid primary key, phone_e164 text, is_active boolean)'
  );
begin
  for t in select jsonb_object_keys(ddl) loop
    if to_regclass(format('public.%I', t)) is null then
      execute ddl ->> t;
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on public.%I from anon', t);
      created := created || t;
    end if;
  end loop;
  -- owner-rights views (their production kind) and materialized views
  if to_regclass('public.probate_status') is null then
    execute 'create view public.probate_status as select null::text as property_id, null::text as status where false';
    created := created || 'probate_status'::text;
  end if;
  if to_regclass('public.preforeclosure_status_v2') is null then
    execute 'create view public.preforeclosure_status_v2 as select null::text as property_id, null::text as status where false';
    created := created || 'preforeclosure_status_v2'::text;
  end if;
  if to_regclass('public.mv_map_market_sales') is null then
    execute 'create materialized view public.mv_map_market_sales as select null::text as comp_id, null::text as property_id, null::date as sold_on where false';
    created := created || 'mv_map_market_sales'::text;
  end if;
  if to_regclass('public.eg_buyer_index') is null then
    execute 'create materialized view public.eg_buyer_index as select null::text as buyer_id, null::text[] as zips where false';
    created := created || 'eg_buyer_index'::text;
  end if;
  -- the two app RPCs: STABLE SECURITY DEFINER, EXECUTE revoked from PUBLIC (service_role only)
  if to_regprocedure('public.entity_graph_property_records(text)') is null then
    execute $f$create function public.entity_graph_property_records(p_property_id text) returns jsonb
      language sql stable security definer set search_path = pg_catalog as $b$ select '{}'::jsonb $b$$f$;
    execute 'revoke all on function public.entity_graph_property_records(text) from public, anon, authenticated';
    execute 'grant execute on function public.entity_graph_property_records(text) to service_role';
    created := created || 'entity_graph_property_records()'::text;
  end if;
  if to_regprocedure('public.campaign_entity_contact_review_flags(text[])') is null then
    execute $f$create function public.campaign_entity_contact_review_flags(p_property_ids text[])
      returns table (property_id text, requires_review boolean, exclusion_reasons text[])
      language sql stable security definer set search_path = pg_catalog as $b$ select null::text, false, '{}'::text[] where false $b$$f$;
    execute 'revoke all on function public.campaign_entity_contact_review_flags(text[]) from public, anon, authenticated';
    execute 'grant execute on function public.campaign_entity_contact_review_flags(text[]) to service_role';
    created := created || 'campaign_entity_contact_review_flags()'::text;
  end if;
  raise notice 'lc_mcp_reader chain baseline: created %', array_to_string(created, ', ');
end $do$;

-- PRODUCTION ACLs of the campaign-graph SECURITY DEFINER functions. The chain fixture
-- scripts/db/fixtures/campaign_target_graph_live_functions_baseline.sql carries their LIVE bodies but not
-- their ACLs, so on the disposable database PUBLIC can EXECUTE them (the PostgreSQL default), and
-- lc_mcp_reader's self-check correctly refuses (reachable definer writers). Production does not grant them
-- to PUBLIC: the operator lockdown (20261003130000) swept every anon-executable postgres-owned definer on
-- 2026-10-03, revoked PUBLIC / anon / authenticated and granted service_role (refresh_campaign_target_graph_seller_batch
-- was in that set; the stage / fallback batches were already not anon-executable, or its expected-set check
-- would have aborted it), and campaign_audience_completeness (20261003220000) revoked PUBLIC on
-- campaign_target_graph_enrich_rows. PROPOSED_20261016155000 re-creates them with CREATE OR REPLACE,
-- which keeps the ACL. The owner's apply re-checks the real catalog and refuses atomically if this is wrong.
do $acl$
declare r record;
begin
  for r in select p.oid::regprocedure sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prosecdef
              and p.proname in ('refresh_campaign_target_graph_seller_batch', 'refresh_campaign_target_graph_stage_batch',
                                'refresh_campaign_target_graph_fallback_batch', 'campaign_target_graph_enrich_rows')
              and has_function_privilege('public', p.oid, 'EXECUTE') loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    raise notice 'lc_mcp_reader chain baseline: production ACL applied to %', r.sig;
  end loop;
end $acl$;
