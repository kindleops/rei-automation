-- DISPOSABLE DATABASE ONLY: test setup for PROPOSED_20261016120000_lc_mcp_reader.sql.
-- NEVER run against Supabase. Every object here already exists in production, or stands
-- in for one. The runner (scripts/db/run-migration-test.mjs) applies it after
-- apps/api/tests/pg/supabase-shim.sql. The shim provides anon, authenticated,
-- service_role (BYPASSRLS) and authenticator, plus default privileges that are WORSE
-- than production: ALL on new tables, sequences and functions to anon and authenticated.
--
-- Production facts this emulation follows (all recorded in the repo):
--   * RLS is enabled on every postgres-owned public table (operator lockdown, 20261003130000);
--     anon holds nothing in public;
--   * probate_status / preforeclosure_status_v2 are emulated as owner-rights views, and
--     eg_buyer_index / mv_map_market_sales as materialized views (their real kinds);
--   * entity_graph_property_records and campaign_entity_contact_review_flags are STABLE
--     SECURITY DEFINER functions with EXECUTE revoked from PUBLIC (service_role only);
--   * write-capable functions: SECURITY DEFINER writers that are service_role only after the
--     lockdown (reap_stale_*); an emulated raw-SQL definer function (exec_sql) that is
--     service_role only; and INVOKER writers that PUBLIC can still EXECUTE
--     (log_message_event, run_sql), as listed in the 20261001121000 audit;
--   * PostGIS st_estimatedextent: a STABLE SECURITY DEFINER function that PUBLIC can execute;
--   * schema agent: PUBLIC holds nothing; FORCE RLS; definer writer sync_operator_membership.

-- recorded-documents source behind the definer RPC
create schema if not exists seller;
revoke all on schema seller from public, anon, authenticated;
create table seller.property_mortgage (property_id text not null, lender text, amount numeric);

-- ---------------------------------------------------------------- inventory ----
create table public.properties (property_id text primary key, master_owner_id text, property_address_full text, property_address_zip text, latitude numeric, longitude numeric, market text, units_count int);
create table public.master_owners (master_owner_id text primary key, display_name text);
create table public.prospects (prospect_id text primary key, master_owner_id text, full_name text);
create table public.phones (phone_id text primary key, master_owner_id text, canonical_e164 text);
create table public.emails (email_id text primary key, master_owner_id text, email text);
create table public.inbox_thread_state (thread_key text primary key, property_id text, latest_message_body text);
create table public.property_acquisition_scores (property_id text primary key, aos_score numeric, computed_at timestamptz);
create table public.eg_property_facts (property_id text primary key, market text, zip_code text);
create table public.campaign_target_graph (property_id text not null, canonical_e164 text, sms_eligible boolean);
create table public.acquisition_opportunities (id bigserial primary key, primary_property_id text);
create table public.campaigns (id uuid primary key, name text, status text);
create table public.campaign_targets (id uuid primary key, campaign_id uuid references public.campaigns(id), property_id text, target_status text);
create table public.mi_rollup_builds (build_id int primary key, status text);
create table public.mi_geo_period_rollup (build_id int not null, geo_key text, period text, sale_count int);
create table public.census_geo_metrics (zcta text, source_year int);
create table public.sms_suppression_list (id uuid primary key, phone_e164 text, phone_number text, is_active boolean, suppression_type text, suppression_reason text);
create table public.probate_case (property_id text primary key, status text);
create table public.preforeclosure_case (property_id text primary key, status text);
create view public.probate_status as select property_id, status from public.probate_case;
create view public.preforeclosure_status_v2 as select property_id, status from public.preforeclosure_case;

-- ------------------------------------------------- sentinel write targets ----
create table public.send_queue (id bigserial primary key, to_e164 text, body text);
create table public.sms_templates (id uuid primary key, body text);
create table public.system_control (key text primary key, value text);
create table public.message_events (id bigserial primary key, body text);
-- an invoker view outside the inventory (prod: email_* views are security_invoker)
create view public.email_message_engagement with (security_invoker = true) as select id, body from public.message_events;

-- ------------------------------------------------------------------ seeds ----
insert into public.properties values ('P1', 'O1', '1 Fixture St', '75001', 32.9, -96.8, 'Fixture Metro, TX', 1);
insert into public.master_owners values ('O1', 'Fixture Owner');
insert into public.prospects values ('R1', 'O1', 'Fixture Person');
insert into public.phones values ('PH1', 'O1', '+15550100001');
insert into public.emails values ('E1', 'O1', 'fixture@example.invalid');
insert into public.inbox_thread_state values ('+15550100001', 'P1', 'fixture message');
insert into public.property_acquisition_scores values ('P1', 71, now());
insert into public.eg_property_facts values ('P1', 'Fixture Metro, TX', '75001');
insert into public.campaign_target_graph values ('P1', '+15550100001', true);
insert into public.acquisition_opportunities (primary_property_id) values ('P1');
insert into public.campaigns values ('00000000-0000-4000-8000-0000000000c1', 'Fixture Spring', 'active');
insert into public.campaign_targets values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', 'P1', 'sent');
insert into public.mi_rollup_builds values (42, 'ready');
insert into public.mi_geo_period_rollup values (42, '75001', '1y', 12);
insert into public.census_geo_metrics values ('75001', 2023);
insert into public.sms_suppression_list values ('00000000-0000-4000-8000-0000000000e1', '+15550100009', '+15550100009', true, 'opt_out', 'stop');
insert into public.probate_case values ('P1', 'verified');
insert into public.preforeclosure_case values ('P1', 'none');
insert into public.send_queue (to_e164, body) values ('+15550100001', 'fixture');
insert into public.sms_templates values ('00000000-0000-4000-8000-0000000000f1', 'fixture template');
insert into public.system_control values ('queue_processor_mode', 'off');
insert into seller.property_mortgage values ('P1', 'Fixture Bank', 100000);

create materialized view public.mv_map_market_sales as
  select 'C1'::text as comp_id, 'P2'::text as property_id, date '2026-06-01' as sold_on, 250000::numeric as price, 32.91::numeric as lat, -96.81::numeric as lng;
create materialized view public.eg_buyer_index as
  select 'B1'::text as buyer_id, array['75001']::text[] as zips, 'active'::text as activity_status;

-- -------------------------------------------------- RLS, as in production ----
do $$ declare t text; begin
  for t in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
create policy operator_read on public.properties for select to authenticated using (true);
create policy "Service role has full access to templates" on public.sms_templates for all to public
  using ((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role') = 'service_role');
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- ------------------------------------------------------------- agent plane ----
create schema agent;
revoke all on schema agent from public, anon, authenticated;
create table agent.org (org_id uuid primary key);
create table agent.operator_membership (org_id uuid not null references agent.org(org_id), user_id uuid not null, role text not null check (role in ('operator', 'owner')), primary key (org_id, user_id));
create table agent.run (id text primary key, org_id uuid not null);
insert into agent.org values ('00000000-0000-4000-8000-0000000000a1');
insert into agent.operator_membership values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'owner');
insert into agent.run values ('run_fixture', '00000000-0000-4000-8000-0000000000a1');
alter table agent.org enable row level security;
alter table agent.org force row level security;
alter table agent.operator_membership enable row level security;
alter table agent.operator_membership force row level security;
alter table agent.run enable row level security;
alter table agent.run force row level security;
revoke all on all tables in schema agent from public, anon, authenticated, service_role;
grant select on agent.operator_membership to authenticated;

-- ---------------------------------------------------------------- functions ----
create function public.entity_graph_property_records(p_property_id text) returns jsonb
language sql stable security definer set search_path = public, seller, pg_temp
as $$ select jsonb_build_object('mortgages', coalesce((select jsonb_agg(to_jsonb(m) - 'property_id') from seller.property_mortgage m where m.property_id = p_property_id), '[]'::jsonb)) $$;
revoke all on function public.entity_graph_property_records(text) from public, anon, authenticated;
grant execute on function public.entity_graph_property_records(text) to service_role;

create function public.campaign_entity_contact_review_flags(p_property_ids text[])
returns table (property_id text, requires_review boolean, exclusion_reasons text[])
language sql stable security definer set search_path = public, pg_temp
as $$ select g.property_id, false, '{}'::text[] from public.campaign_target_graph g where g.property_id = any(p_property_ids) $$;
revoke all on function public.campaign_entity_contact_review_flags(text[]) from public, anon, authenticated;
grant execute on function public.campaign_entity_contact_review_flags(text[]) to service_role;

-- write-capable definer functions, service_role only (post-lockdown)
create function public.reap_stale_campaign_target_graph_refresh_runs(p_age interval) returns integer
language plpgsql volatile security definer set search_path = public, pg_temp
as $$ declare n int; begin delete from public.campaign_target_graph where false; get diagnostics n = row_count; return n; end $$;
revoke all on function public.reap_stale_campaign_target_graph_refresh_runs(interval) from public, anon, authenticated;
grant execute on function public.reap_stale_campaign_target_graph_refresh_runs(interval) to service_role;

create function public.exec_sql(q text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp
as $$ begin execute q; end $$;
revoke all on function public.exec_sql(text) from public, anon, authenticated;
grant execute on function public.exec_sql(text) to service_role;

-- invoker writers PUBLIC can execute (production reality before 20261001121000)
create function public.log_message_event(p_body text) returns void
language sql volatile security invoker
as $$ insert into public.message_events (body) values (p_body) $$;
create function public.run_sql(q text) returns void
language plpgsql volatile security invoker
as $$ begin execute q; end $$;

-- PostGIS metadata stand-in: STABLE, SECURITY DEFINER, PUBLIC-executable (accepted by name AND volatility)
create function public.st_estimatedextent(p_table text, p_column text) returns text
language sql stable security definer set search_path = pg_catalog
as $$ select null::text $$;

create function agent.sync_operator_membership(p_org uuid, p_user uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, agent
as $$ begin delete from agent.operator_membership where org_id = p_org and user_id = p_user; end $$;
revoke all on function agent.sync_operator_membership(uuid, uuid) from public, anon, authenticated;
grant execute on function agent.sync_operator_membership(uuid, uuid) to service_role;
