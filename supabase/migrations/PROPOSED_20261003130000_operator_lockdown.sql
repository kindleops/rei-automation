-- =============================================================================
-- Data-plane lockdown: anon out, operators only, no TRUNCATE
-- STATUS: PROPOSED. NOT APPLIED. Apply only with the owner present, IMMEDIATELY AFTER
--         20261003120000_operator_read_policies.sql (preflight refuses otherwise).
-- Pretest (rollback-only): supabase/tests/operator_lockdown_test.sql
-- Rollback:                supabase/rollbacks/PROPOSED_20261003130000_operator_lockdown.rollback.sql
--                          (exact: it replays the snapshot this migration takes in ops_lockdown.snapshot)
-- =============================================================================
--
-- STATE MEASURED ON PROD (lcppdrmrdfblstpcbgpf, 2026-10-03, read-only):
--   * anon (the key shipped in the public JS bundle) can SELECT 144 public relations:
--     34 tables, 109 views and 1 materialized view. These include properties and
--     master_owners (through anon_select_* policies), conversation_threads/turns,
--     follow_up_queue, human_escalations and operator_thread_state (through
--     "service role full access" policies that are actually TO public USING true),
--     and nine RLS-OFF tables (map_filter_property_prospect_links among them). The
--     96 owner-rights views run as postgres, so they bypass RLS entirely
--     (v_command_map_seller_pin_feed, v_seller_work_items, v_operator_inbox_threads,
--     inbox_*_hydrated, ...).
--   * anon can WRITE:
--       - inbox_thread_state, operator_entity_preferences and universal_lead_state_events
--         (anon ALL policies);
--       - buyer_match_candidates, buyer_match_runs, inbox_activity_events,
--         conversation_*, follow_up_queue, human_escalations and operator_thread_state
--         (public ALL USING true);
--       - every RLS-off table;
--       - and, through auto-updatable owner-rights views, the base tables behind them.
--   * anon can EXECUTE 31 postgres-owned SECURITY DEFINER functions (22 in public, among them
--     inbox_filter_field_options from 2026-06-19; 7 in private; 2 in comp_private), including
--     rebuild_map_filter_property_prospect_links(), exchange_rebuild_market_geography(),
--     reap_stale_campaign_target_graph_refresh_runs(), get_inbox_thread_dossier() and
--     get_property_map_vector_tile().
--   * anon and authenticated hold TRUNCATE on every table. RLS does not cover TRUNCATE.
--   * 72 policies grant "any authenticated user" (or public, or anon) USING true.
--     They include send_queue, message_events, buyers, sms_templates and textgrid_numbers.
--   * 13 SECURITY DEFINER map RPCs are executable by any authenticated user.
--
-- WHO NEEDS WHAT (code audit, branch feat/mobile-product-v1):
--   * apps/api, Cloudflare Worker, cron, webhooks: service_role or postgres. They
--     bypass RLS and keep every grant. Nothing server-side uses the anon key: it
--     appears only in secret-redaction lists.
--   * apps/dashboard: one Supabase client (src/lib/supabaseClient.ts). Pre-auth it
--     makes ZERO PostgREST/RPC/Realtime calls. AuthProvider uses only
--     auth.getSession/onAuthStateChange/signOut, LoginPage uses only
--     auth.signInWithPassword (GoTrue), Google OAuth comes back through
--     detectSessionInUrl (GoTrue), sw.js handles same-origin requests only, and the
--     manifest is static. Everything else renders behind <RequireAuth>.
--     => anon needs NO grant in public.
--   * Dashboard direct reads after sign-in: the ~60 relations listed in the
--     operator_read_policies audit. Direct writes: inbox_activity_events (insert) and
--     buyer_match_candidates (update). Realtime: inbox_thread_state, message_events,
--     send_queue, operator_thread_state, thread_ai_state, routing_decisions,
--     seller_state_snapshots, conversation_turns, seller_automation_executions/_steps.
--     Direct RPCs: the 9 definer map RPCs below plus 3 invoker RPCs
--     (get_command_map_seller_pins, get_comp_candidates_for_subject,
--     get_buyers_for_property).
--
-- WHAT THIS DOES:
--   0. Preflight, then a snapshot (ACLs, the policies it replaces, view and function
--      definitions, RLS flags) into ops_lockdown.snapshot, so the rollback is exact.
--   1. public.ops_read_allowed() returns true for a direct DB session (no JWT),
--      service_role, or an allowlisted operator. public.assert_ops_read_allowed()
--      raises 42501 otherwise.
--   2. Policies: each of the 72 "USING true" policies is dropped. If it covered
--      authenticated or public, it is replaced by the same command TO authenticated
--      USING/WITH CHECK ((select public.is_ops_operator())). anon-only policies and
--      the public "service role full access" policies are dropped with no
--      replacement, because service_role bypasses RLS anyway.
--   3. RLS is enabled on the 9 postgres-owned RLS-off tables. Only
--      map_filter_property_prospect_links (read by the dashboard Ownership Check)
--      gets an operator SELECT policy.
--   4. anon loses every privilege on every postgres-owned relation and sequence in
--      public, and EXECUTE on all 31 anon-executable postgres-owned SECURITY DEFINER
--      functions in public/private/comp_private (reviewed list; drift fails the apply).
--      private.is_org_* keep authenticated (tenant RLS); every other one becomes
--      service_role only (+comp_ingest for comp_private builders). Exception: inquiries and onboarding_events keep anon INSERT only.
--      Their WITH CHECK-scoped append policies serve a sign-up funnel that is not in
--      this repo, so that consumer is left as it was.
--   5. TRUNCATE is revoked from anon and authenticated on every postgres-owned table.
--   6. Views and matviews: authenticated loses INSERT/UPDATE/DELETE/TRUNCATE/
--      REFERENCES/TRIGGER on all of them, which closes the write-through-view hole.
--      authenticated loses SELECT on every owner-rights view or matview the
--      dashboard does not read. The 13 owner-rights views the dashboard does read
--      are rewritten as `select * from (<original>) _ops_gate where (select
--      public.ops_read_allowed())`. The gate is a one-time filter: same columns,
--      same plan below it. An authenticated non-operator gets 0 rows, while the API
--      (service_role) and cron (no JWT) are unaffected.
--   7. Definer map RPCs. CHOSEN APPROACH: an in-function check, because it keeps the
--      dashboard Map calling them directly. `PERFORM public.assert_ops_read_allowed();`
--      is injected right after the top-level BEGIN of the 9 the dashboard calls:
--      get_map_area_facts, get_map_area_intel, get_map_area_summary,
--      get_map_lens_areas, get_map_lens_points, get_map_sold_comp, get_map_sold_comps,
--      get_map_sold_comps_list, map_search. The injection is done at apply time from
--      the live definition, so recent edits are never reverted. The 3 that only the
--      API calls (get_map_bounds_property_count, get_map_market_aggregates,
--      get_map_spatial_clusters) instead lose authenticated EXECUTE and stay
--      service_role only. (The anon-executable definer functions are handled in 4.)
--   8. Default privileges for role postgres in schema public: new tables and
--      sequences are no longer granted to anon, and new tables no longer give
--      authenticated TRUNCATE.
--
-- NOT TOUCHED: send_queue/message_events write paths (service_role only, already
--   locked in RC 7.1); the "own row" tenant policies (profiles, organizations, ...);
--   PostGIS objects owned by supabase_admin; other schemas.
--   Invoker functions remain executable by anon, but with no table grants they reach
--   no data.
-- CONSEQUENCE FOR LOCAL DEV: a dev build with VITE_REQUIRE_AUTH != 'true' renders
--   without a session, i.e. as anon, and will now see nothing. Sign in locally.
-- LOCKS: ACCESS EXCLUSIVE on ~100 tables and views, briefly, inside one transaction.
--   lock_timeout 5s makes it fail fast and whole. Run off-peak, outside a feeder tick.
-- =============================================================================

set local lock_timeout = '5s';

-- ------------------------------------------------------------ 0. preflight ----
do $$
declare
  missing text;
  extra text;
  already boolean;
begin
  if to_regprocedure('public.is_ops_operator()') is null then
    raise exception 'operator_lockdown: apply 20261003120000_operator_read_policies.sql first';
  end if;
  if not exists (select 1 from public.ops_operators) then
    raise exception 'operator_lockdown: public.ops_operators is empty; this would lock every operator out';
  end if;
  if to_regclass('ops_lockdown.snapshot') is not null then
    execute 'select exists (select 1 from ops_lockdown.snapshot where migration = ''20261003130000'')' into already;
    if already then
      raise exception 'operator_lockdown: already applied (snapshot present)';
    end if;
  end if;

  -- The policy set this migration replaces was reviewed by name. If prod drifted,
  -- stop: the lead re-reviews rather than this silently switching something new.
  with expected(t, p) as (values
    ('acquisition_opportunities','acquisition_opportunities_authenticated_read'),
    ('acquisition_opportunity_history','acquisition_opportunity_history_authenticated_read'),
    ('acquisition_score_snapshots','acquisition_score_snapshots_authenticated_read'),
    ('ai_decisions','Allow authenticated select on ai_decisions'),
    ('buyer_activity_geo_rollups','Allow read buyer activity geo rollups'),
    ('buyer_agreements','buyer_agreements_authenticated_read'),
    ('buyer_comp_import_batches_v2','Authenticated read buyer comp batches v2'),
    ('buyer_comp_properties_v2','Authenticated read buyer comp properties v2'),
    ('buyer_comp_raw_v2','Authenticated read buyer comp raw v2'),
    ('buyer_contacts_v2','Authenticated read buyer contacts v2'),
    ('buyer_entities_v2','Authenticated read buyer entities v2'),
    ('buyer_geo_rollups_v2','Authenticated read buyer geo rollups v2'),
    ('buyer_match_candidates','buyer_match_candidates_all'),
    ('buyer_match_runs','buyer_match_runs_all'),
    ('buyer_offers','buyer_offers_authenticated_read'),
    ('buyer_property_matches_v2','Authenticated read buyer property matches v2'),
    ('buyer_purchase_events_v2','Authenticated read buyer purchase events v2'),
    ('campaign_daily_limits','Authenticated users can manage campaign_daily_limits'),
    ('campaign_touch_plan','Authenticated users can read campaign_touch_plan'),
    ('canonical_markets','canonical_markets_read'),
    ('census_geo_metrics','Allow read census geo metrics'),
    ('contact_outreach_state','Authenticated users can manage contact_outreach_state'),
    ('contact_property_resolution','contact_property_resolution_authenticated_read'),
    ('conversation_threads','Allow authenticated read on threads'),
    ('conversation_threads','Allow service role full access on threads'),
    ('conversation_turns','Allow authenticated read on turns'),
    ('conversation_turns','Allow service role full access on turns'),
    ('daily_goal_targets','Authenticated users can manage daily_goal_targets'),
    ('deal_context_index','deal_context_index_anon_select'),
    ('deal_context_index','deal_context_index_authenticated_select'),
    ('deal_marker_taxonomy','deal_marker_taxonomy_select'),
    ('emd_receipts','emd_receipts_authenticated_read'),
    ('exchange_market_geography','exchange_market_geography_read'),
    ('follow_up_queue','Allow service role full access on queue'),
    ('human_escalations','Allow authenticated full access on escalations'),
    ('human_escalations','Allow service role full access on escalations'),
    ('inbox_activity_events','Allow all for authenticated'),
    ('inbox_thread_state','Allow anon to manage inbox_thread_state'),
    ('inbox_thread_state','Authenticated users can manage inbox_thread_state'),
    ('inbox_thread_state','anon_select_inbox_thread_state'),
    ('map_layer_cache','Allow read map layer cache'),
    ('market_aliases','market_aliases_read'),
    ('market_county_membership','market_county_membership_read'),
    ('market_zip_membership','market_zip_membership_read'),
    ('master_owners','anon_select_master_owners'),
    ('message_events','Authenticated users can read message_events'),
    ('negotiation_events','Allow authenticated select on negotiation_events'),
    ('operator_entity_preferences','anon_manage_operator_entity_preferences'),
    ('operator_entity_preferences','authenticated_manage_operator_entity_preferences'),
    ('operator_thread_state','Allow authenticated read write'),
    ('operator_thread_state','Allow service role full access'),
    ('properties','anon_select_properties'),
    ('property_valuation_snapshots','Allow authenticated access to property_valuation_snapshots'),
    ('queue_canary_authorizations','queue_canary_authorizations_authenticated_read'),
    ('queue_global_execution_lock','queue_global_execution_lock_authenticated_read'),
    ('routing_decisions','Allow authenticated select on routing_decisions'),
    ('seller_automation_execution_steps','seller_automation_execution_steps_authenticated_read'),
    ('seller_automation_executions','seller_automation_executions_authenticated_read'),
    ('seller_followup_state','seller_followup_state_authenticated_read'),
    ('seller_state_snapshots','Allow authenticated select on seller_state_snapshots'),
    ('send_queue','Authenticated users can read send_queue'),
    ('settlement_records','settlement_records_authenticated_read'),
    ('smart_inbox_views','smart_inbox_views_select'),
    ('sms_templates','sms_templates_authenticated_read'),
    ('state_geo_bounds','Authenticated users can read state_geo_bounds'),
    ('textgrid_numbers','Authenticated users can read textgrid_numbers'),
    ('textgrid_numbers','anon_select_textgrid_numbers'),
    ('thread_identity_binding','thread_identity_binding_authenticated_read'),
    ('thread_resolution_queue','thread_resolution_queue_select'),
    ('universal_lead_state_events','anon_manage_universal_lead_state_events'),
    ('universal_lead_state_events','authenticated_manage_universal_lead_state_events'),
    ('workflow_scheduled_tasks','workflow_scheduled_tasks_authenticated_read')
  ), actual as (
    select tablename::text t, policyname::text p from pg_policies
    where schemaname = 'public' and roles && array['anon','authenticated','public']::name[]
      and coalesce(qual, 'true') = 'true' and coalesce(with_check, 'true') = 'true'
  )
  select string_agg(e.t || '.' || e.p, ', ') filter (where a.t is null),
         string_agg(a.t || '.' || a.p, ', ') filter (where e.t is null)
    into missing, extra
  from expected e full join actual a on a.t = e.t and a.p = e.p;
  if missing is not null or extra is not null then
    raise exception 'operator_lockdown: policy drift. missing=[%] unexpected=[%]', missing, extra;
  end if;
end
$$;

-- ------------------------------------------------------------- snapshot ----
create schema if not exists ops_lockdown;
revoke all on schema ops_lockdown from public, anon, authenticated;
create table if not exists ops_lockdown.snapshot (
  id          bigserial primary key,
  migration   text not null,
  kind        text not null,
  object      text not null,
  payload     jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  unique (migration, kind, object)
);
revoke all on ops_lockdown.snapshot from public, anon, authenticated;

-- Relation ACLs (every postgres-owned relation in public that has an explicit ACL).
insert into ops_lockdown.snapshot (migration, kind, object, payload)
select '20261003130000', 'rel_acl', c.oid::regclass::text,
       jsonb_build_object('relkind', c.relkind, 'acl', to_jsonb(c.relacl::text[]))
from pg_class c
where c.relnamespace = 'public'::regnamespace
  and c.relkind in ('r','p','v','m','f','S')
  and c.relowner = 'postgres'::regrole
  and c.relacl is not null;

-- Function ACLs (postgres-owned functions in public, private, comp_private).
insert into ops_lockdown.snapshot (migration, kind, object, payload)
select '20261003130000', 'func_acl', p.oid::regprocedure::text,
       jsonb_build_object('acl', to_jsonb(p.proacl::text[]))
from pg_proc p
where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace, 'comp_private'::regnamespace)
  and p.proowner = 'postgres'::regrole
  and p.prokind = 'f';

-- --------------------------------------------------------- 1. helpers ----
create or replace function public.ops_read_allowed()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
begin
  -- PostgREST and Realtime always set claims for the two browser-facing roles. Anything
  -- else is server-side: no JWT at all (pg_cron, migrations, psql, Studio) or
  -- service_role (the API and the Worker). A JWT carrying any other role can only be
  -- minted with the project JWT secret.
  if v_role is null or v_role not in ('anon', 'authenticated') then
    return true;
  end if;
  return v_role = 'authenticated' and public.is_ops_operator();
end
$$;
comment on function public.ops_read_allowed() is
  'True for direct DB sessions, service_role, and allowlisted operators. Gate for owner-rights views and definer RPCs the dashboard reads.';
revoke all on function public.ops_read_allowed() from public, anon;
grant execute on function public.ops_read_allowed() to authenticated, service_role;

create or replace function public.assert_ops_read_allowed()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.ops_read_allowed() then
    raise exception 'operator access required' using errcode = '42501';
  end if;
end
$$;
revoke all on function public.assert_ops_read_allowed() from public, anon;
grant execute on function public.assert_ops_read_allowed() to authenticated, service_role;

-- --------------------------------------------------- 2. policy switch ----
do $$
declare
  r record;
  pname text;
  gate constant text := '((select public.is_ops_operator()))';
  pols jsonb;
begin
  select jsonb_agg(to_jsonb(x)) into pols from (
    select tablename::text, policyname::text, permissive::text, roles::text[] as roles, cmd::text, qual, with_check
    from pg_policies
    where schemaname = 'public' and roles && array['anon','authenticated','public']::name[]
      and coalesce(qual, 'true') = 'true' and coalesce(with_check, 'true') = 'true'
    order by tablename, policyname
  ) x;

  for r in select * from jsonb_to_recordset(pols)
             as t(tablename text, policyname text, permissive text, roles text[], cmd text, qual text, with_check text)
  loop
    insert into ops_lockdown.snapshot (migration, kind, object, payload)
    values ('20261003130000', 'policy', r.tablename || '.' || r.policyname,
            jsonb_build_object('table', r.tablename, 'name', r.policyname, 'permissive', r.permissive,
                               'roles', r.roles, 'cmd', r.cmd, 'qual', r.qual, 'with_check', r.with_check));
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);

    continue when r.roles = array['anon'];
    continue when r.roles = array['public'] and r.policyname ilike '%service role%';

    pname := case r.cmd when 'SELECT' then 'ops_operator_read' when 'ALL' then 'ops_operator_all'
                        when 'INSERT' then 'ops_operator_insert' when 'UPDATE' then 'ops_operator_update'
                        when 'DELETE' then 'ops_operator_delete' end;
    continue when exists (select 1 from pg_policies where schemaname = 'public'
                            and tablename = r.tablename and policyname = pname);
    execute format('create policy %I on public.%I as permissive for %s to authenticated %s %s',
      pname, r.tablename, r.cmd,
      case when r.cmd = 'INSERT' then '' else 'using ' || gate end,
      case when r.cmd in ('ALL','INSERT','UPDATE') then 'with check ' || gate else '' end);
    insert into ops_lockdown.snapshot (migration, kind, object)
    values ('20261003130000', 'created_policy', r.tablename || '.' || pname);
  end loop;
end
$$;

-- ------------------------------------------- 3. RLS on RLS-off tables ----
do $$
declare t text;
begin
  for t in
    select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
      and c.relowner = 'postgres'::regrole and not c.relrowsecurity
    order by 1
  loop
    insert into ops_lockdown.snapshot (migration, kind, object) values ('20261003130000', 'rls_enabled', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end
$$;
drop policy if exists ops_operator_read on public.map_filter_property_prospect_links;
create policy ops_operator_read on public.map_filter_property_prospect_links
  as permissive for select to authenticated using ((select public.is_ops_operator()));
insert into ops_lockdown.snapshot (migration, kind, object)
values ('20261003130000', 'created_policy', 'map_filter_property_prospect_links.ops_operator_read')
on conflict do nothing;

-- ---------------------------------------------------- 4. anon out ----
do $$
declare r record; missing_fn text; extra_fn text;
begin
  for r in
    select c.relname, c.relkind from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f','S')
      and c.relowner = 'postgres'::regrole
  loop
    if r.relkind = 'S' then
      execute format('revoke all on sequence public.%I from anon', r.relname);
    elsif r.relname in ('inquiries', 'onboarding_events') then
      execute format('revoke select, update, delete, truncate, references, trigger, maintain on public.%I from anon', r.relname);
    else
      execute format('revoke all on public.%I from anon', r.relname);
    end if;
  end loop;

  -- Every postgres-owned SECURITY DEFINER function that anon can EXECUTE, in public,
  -- private and comp_private. Swept from the prod catalog on 2026-10-03; the expected
  -- set is checked first, so anything new fails the apply instead of being missed.
  -- anon gets EXECUTE through PUBLIC, so PUBLIC is revoked too.
  with expected(sig) as (values
    ('public.campaign_entity_contact_review_flags(text[])'),
    ('public.campaign_global_inventory()'),
    ('public.campaign_market_inventory(integer)'),
    ('public.campaign_preview_sender_route_map()'),
    ('public.entity_graph_browse_zips(integer,integer,boolean)'),
    ('public.entity_graph_zip_distinct_count()'),
    ('public.exchange_flood_polygons(double precision,double precision,double precision,double precision,double precision,integer)'),
    ('public.exchange_rebuild_market_geography()'),
    ('public.exchange_trend_hpi_series(text[],integer)'),
    ('public.get_inbox_thread_dossier(text)'),
    ('public.get_property_coordinates(text[])'),
    ('public.get_property_map_dot_tile(integer,integer,integer)'),
    ('public.get_property_map_tile_feature_count(integer,integer,integer)'),
    ('public.get_property_map_vector_tile(integer,integer,integer)'),
    ('public.get_thread_enrichment(text[])'),
    ('public.inbox_filter_field_options(text,text,jsonb,text,text[])'),
    ('public.inbox_filter_match_count(jsonb)'),
    ('public.reap_stale_campaign_target_graph_refresh_runs(interval)'),
    ('public.rebuild_map_filter_property_prospect_links()'),
    ('public.refresh_campaign_target_graph_seller_batch(uuid,integer,integer)'),
    ('public.sync_map_filter_property_prospect_links()'),
    ('public.acquisition_score_snapshots_immutable()'),
    ('private.is_org_member(uuid)'),
    ('private.is_org_admin(uuid)'),
    ('private.is_org_creator(uuid)'),
    ('private.handle_new_user()'),
    ('private.identity_is_verified(text,jsonb,uuid)'),
    ('private.sync_member_identity()'),
    ('private.forget_member_identity()'),
    ('comp_private.build_market_capital_cells(date,text)'),
    ('comp_private.build_market_ownership_cells(date,text)')
  ), actual as (
    select p.oid::regprocedure::text as sig from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace, 'comp_private'::regnamespace)
      and p.proowner = 'postgres'::regrole and p.prokind = 'f' and p.prosecdef
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and p.proname not in ('get_map_area_facts','get_map_area_intel','get_map_area_summary',
                            'get_map_lens_areas','get_map_lens_points','get_map_sold_comp',
                            'get_map_sold_comps','get_map_sold_comps_list','map_search',
                            'ops_read_allowed','assert_ops_read_allowed','is_ops_operator')
  )
  select string_agg(e.sig, ', ') filter (where a.sig is null), string_agg(a.sig, ', ') filter (where e.sig is null)
    into missing_fn, extra_fn
  from expected e full join actual a on a.sig = regexp_replace(e.sig, '^public\.', '');
  if extra_fn is not null then
    raise exception 'operator_lockdown: unreviewed anon-executable definer function(s): %', extra_fn;
  end if;
  if missing_fn is not null then
    raise notice 'operator_lockdown: already not anon-executable (skipped): %', missing_fn;
  end if;

  for r in
    select p.oid::regprocedure as sig, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private', 'comp_private')
      and p.proowner = 'postgres'::regrole and p.prokind = 'f' and p.prosecdef
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and p.proname not in ('get_map_area_facts','get_map_area_intel','get_map_area_summary',
                            'get_map_lens_areas','get_map_lens_points','get_map_sold_comp',
                            'get_map_sold_comps','get_map_sold_comps_list','map_search',
                            'ops_read_allowed','assert_ops_read_allowed','is_ops_operator')
  loop
    if r.nspname = 'private' and r.proname in ('is_org_member', 'is_org_admin', 'is_org_creator') then
      -- Evaluated inside the tenant RLS policies as authenticated: keep authenticated.
      execute format('revoke execute on function %s from public, anon', r.sig);
      execute format('grant execute on function %s to authenticated, service_role', r.sig);
    else
      -- Service-side only. The dashboard calls none of these. The Advanced Filters
      -- options (inbox_filter_field_options / inbox_filter_match_count) go through
      -- apps/api inbox-hydrated-filter-service.js with the service_role client
      -- (7e0f2f7a). Trigger functions still fire: EXECUTE is not checked at fire
      -- time. pg_cron runs as the owner.
      execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
      execute format('grant execute on function %s to service_role', r.sig);
      if r.nspname = 'comp_private' then
        execute format('grant execute on function %s to comp_ingest', r.sig);
      end if;
    end if;
  end loop;
end
$$;

-- ------------------------------------------------ 5. no TRUNCATE ----
do $$
declare t text;
begin
  for t in
    select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
      and c.relowner = 'postgres'::regrole
  loop
    execute format('revoke truncate on public.%I from anon, authenticated', t);
  end loop;
end
$$;

-- --------------------------------------------------------- 6. views ----
do $$
declare
  r record;
  def text;
  keep constant text[] := array[
    'v_command_map_seller_pin_feed', 'v_map_property_pins', 'v_operator_inbox_threads',
    'v_recent_sold_comps', 'v_seller_work_items', 'v_universal_inbox_threads',
    'property_participant_graph', 'performance_message_events_v', 'number_performance_kpis_v',
    'template_performance_kpis_v', 'top_buyer_profiles', 'buyer_profiles_computed',
    'recently_sold_properties_computed'];
begin
  for r in
    select c.oid, c.relname, c.relkind,
           coalesce(array_to_string(c.reloptions, ','), '') like '%security_invoker=true%' as invoker
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')
      and c.relowner = 'postgres'::regrole
    order by c.relname
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger, maintain on public.%I from authenticated', r.relname);
    if r.relkind = 'm' or (not r.invoker and not (r.relname = any (keep))) then
      execute format('revoke select on public.%I from authenticated', r.relname);
    end if;
  end loop;

  -- Gate the 13 owner-rights views the dashboard reads.
  for r in
    select c.oid, c.relname, c.reloptions from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'v' and c.relname = any (keep)
    order by c.relname
  loop
    if r.reloptions is not null then
      raise exception 'operator_lockdown: % has reloptions %; gate wrapper would drop them', r.relname, r.reloptions;
    end if;
    def := regexp_replace(pg_get_viewdef(r.oid), ';\s*$', '');
    if def ~ '_ops_gate' then
      raise exception 'operator_lockdown: % already gated', r.relname;
    end if;
    insert into ops_lockdown.snapshot (migration, kind, object, payload)
    values ('20261003130000', 'view_def', r.relname, jsonb_build_object('def', def));
    execute format('create or replace view public.%I as select * from (%s) _ops_gate where (select public.ops_read_allowed())',
                   r.relname, def);
  end loop;
  if (select count(*) from ops_lockdown.snapshot where migration = '20261003130000' and kind = 'view_def') <> 13 then
    raise exception 'operator_lockdown: expected to gate 13 views';
  end if;
end
$$;

-- ---------------------------------------------- 7. definer map RPCs ----
do $$
declare
  r record;
  def text;
  gated text;
  marker constant text := '-- ops_operator_gate';
begin
  for r in
    select p.oid, p.oid::regprocedure::text as sig from pg_proc p join pg_language l on l.oid = p.prolang
    where p.pronamespace = 'public'::regnamespace and p.prosecdef and l.lanname = 'plpgsql'
      and p.proname in ('get_map_area_facts','get_map_area_intel','get_map_area_summary',
                        'get_map_lens_areas','get_map_lens_points','get_map_sold_comp',
                        'get_map_sold_comps','get_map_sold_comps_list','map_search')
  loop
    def := pg_get_functiondef(r.oid);
    if position(marker in def) > 0 then
      raise exception 'operator_lockdown: % already gated', r.sig;
    end if;
    gated := regexp_replace(def, '(\$function\$.*?\mBEGIN\M)',
                            '\1' || chr(10) || '  PERFORM public.assert_ops_read_allowed(); ' || marker, 'i');
    if gated = def or (length(gated) - length(replace(gated, marker, ''))) / length(marker) <> 1 then
      raise exception 'operator_lockdown: could not place the gate in %', r.sig;
    end if;
    insert into ops_lockdown.snapshot (migration, kind, object, payload)
    values ('20261003130000', 'func_def', r.sig, jsonb_build_object('def', def));
    execute gated;
  end loop;
  if (select count(*) from ops_lockdown.snapshot where migration = '20261003130000' and kind = 'func_def') <> 9 then
    raise exception 'operator_lockdown: expected to gate 9 map RPCs';
  end if;
end
$$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname in ('get_map_area_facts','get_map_area_intel','get_map_area_summary',
                               'get_map_lens_areas','get_map_lens_points','get_map_sold_comp',
                               'get_map_sold_comps','get_map_sold_comps_list','map_search') loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end
$$;

revoke execute on function public.get_map_bounds_property_count(double precision, double precision, double precision, double precision, text[], text[]) from public, anon, authenticated;
revoke execute on function public.get_map_market_aggregates(text[], text[]) from public, anon, authenticated;
revoke execute on function public.get_map_spatial_clusters(double precision, double precision, double precision, double precision, double precision) from public, anon, authenticated;
grant execute on function public.get_map_bounds_property_count(double precision, double precision, double precision, double precision, text[], text[]) to service_role;
grant execute on function public.get_map_market_aggregates(text[], text[]) to service_role;
grant execute on function public.get_map_spatial_clusters(double precision, double precision, double precision, double precision, double precision) to service_role;

-- The three INVOKER RPCs the dashboard calls stay executable by authenticated.
-- They now read only operator-gated tables and views. anon loses them.
revoke execute on function public.get_command_map_seller_pins(double precision, double precision, double precision, double precision, integer, integer) from public, anon;
revoke execute on function public.get_comp_candidates_for_subject(text, numeric, integer, integer) from public, anon;
revoke execute on function public.get_buyers_for_property(text, integer) from public, anon;
grant execute on function public.get_command_map_seller_pins(double precision, double precision, double precision, double precision, integer, integer) to authenticated, service_role;
grant execute on function public.get_comp_candidates_for_subject(text, numeric, integer, integer) to authenticated, service_role;
grant execute on function public.get_buyers_for_property(text, integer) to authenticated, service_role;

-- ----------------------------------------------- 8. default privileges ----
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke truncate on tables from authenticated;

-- ------------------------------------------------------- postflight ----
do $$
begin
  if exists (
    select 1 from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relowner = 'postgres'::regrole
      and c.relkind in ('r','p','v','m','f')
      and c.relname not in ('inquiries','onboarding_events')
      and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT')
           or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE'))) then
    raise exception 'operator_lockdown postflight: anon still holds a relation privilege';
  end if;
  if exists (
    select 1 from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relowner = 'postgres'::regrole and c.relkind in ('r','p')
      and (has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRUNCATE'))) then
    raise exception 'operator_lockdown postflight: TRUNCATE still granted';
  end if;
  if exists (
    select 1 from pg_policies where schemaname = 'public'
      and roles && array['anon','authenticated','public']::name[]
      and coalesce(qual, 'true') = 'true' and coalesce(with_check, 'true') = 'true') then
    raise exception 'operator_lockdown postflight: a USING-true policy for anon/authenticated/public remains';
  end if;
  if exists (select 1 from pg_proc p
             where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace, 'comp_private'::regnamespace)
               and p.proowner = 'postgres'::regrole and p.prosecdef
               and has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception 'operator_lockdown postflight: anon can still execute a definer function';
  end if;
  if has_function_privilege('anon', 'public.inbox_filter_field_options(text,text,jsonb,text,text[])', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.inbox_filter_field_options(text,text,jsonb,text,text[])', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.inbox_filter_field_options(text,text,jsonb,text,text[])', 'EXECUTE') then
    raise exception 'operator_lockdown postflight: inbox_filter_field_options must be service_role only';
  end if;
end
$$;
