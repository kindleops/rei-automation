-- DISPOSABLE DATABASE ONLY: test setup for PROPOSED_20261019150000_lc_mcp_reader.sql.
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
--   * rc-8.5.21 operations sources (read by the five lc_mcp_* operations functions, AS THE OWNER):
--     public.automation_holds + automation_hold_for (REAL body; invoker, authenticated / service_role
--     only), public.followup_intents + v_followup_intent_health / _reasons (REAL view bodies,
--     security_invoker), agent.finding, agent.conversation_action_state and
--     agent.ops_research_valuation_snapshot (definer, service_role only). Seeds carry phone-shaped
--     and free-text values on purpose: the functions must never return them.

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
create table public.inbox_thread_state (id uuid not null unique default gen_random_uuid(), thread_key text primary key, property_id text, master_owner_id text, latest_message_body text);
create table public.property_acquisition_scores (property_id text primary key, aos_score numeric, computed_at timestamptz);
create table public.eg_property_facts (property_id text primary key, market text, zip_code text);
create table public.campaign_target_graph (property_id text not null, canonical_e164 text, sms_eligible boolean);
create table public.acquisition_opportunities (id uuid primary key default gen_random_uuid(), primary_property_id text, primary_thread_key text);
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
insert into public.inbox_thread_state (id, thread_key, property_id, master_owner_id, latest_message_body) values
  ('00000000-0000-4000-8000-000000000101', '+15550100001', 'P1', 'O1', 'fixture message'),
  ('00000000-0000-4000-8000-000000000102', '+15550100002', 'P2', 'O2', 'fixture message two'),
  ('00000000-0000-4000-8000-000000000103', '+15550100003', 'P3', 'O3', 'fixture message three');
insert into public.property_acquisition_scores values ('P1', 71, now());
insert into public.eg_property_facts values ('P1', 'Fixture Metro, TX', '75001');
insert into public.campaign_target_graph values ('P1', '+15550100001', true);
insert into public.acquisition_opportunities (id, primary_property_id, primary_thread_key) values
  ('00000000-0000-4000-8000-000000000201', 'P1', '+15550100001'),
  ('00000000-0000-4000-8000-000000000202', 'P2', '+15550100002');
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

-- ------------------------------- holds registry + follow-up lifecycle (rc-8.5.21) ----
-- The P0 hold registry (PROPOSED_20261016200000_automation_holds_registry.sql) and the follow-up
-- lifecycle (PROPOSED_20261017120000_followup_intent_lifecycle.sql), reduced to the columns the
-- lc_mcp_* read functions touch; automation_hold_for and both views carry the REAL bodies.
-- Production grants: nothing to PUBLIC / anon; SELECT to authenticated behind is_ops_operator().
create table public.automation_holds (
  id uuid primary key default gen_random_uuid(), hold_key text not null, hold_type text not null,
  thread_key text, inbox_thread_id uuid, property_id text, opportunity_id uuid, master_owner_id text,
  blocked_capabilities text[] not null default array['offer_acceptance','offer_write','closing_case_create','stage_advance',
    'auto_reply','ai_action','follow_up','campaign','workflow','outbound_send','recovery','manual_send']::text[],
  reason text not null, set_by text not null, set_at timestamptz not null default now(), approval_ref text not null,
  released_at timestamptz, released_by text, release_reason text, metadata jsonb not null default '{}'::jsonb);
create function public.automation_hold_for(
  p_thread_key text default null, p_inbox_thread_id uuid default null, p_property_id text default null,
  p_opportunity_id uuid default null, p_master_owner_id text default null, p_capability text default null)
returns setof public.automation_holds
language sql stable security invoker set search_path = public, pg_temp as $fn$
  select h.*
    from public.automation_holds h
   where h.released_at is null
     and (p_capability is null or p_capability = any (h.blocked_capabilities))
     and (   (p_thread_key      is not null and h.thread_key      = p_thread_key)
          or (p_inbox_thread_id is not null and h.inbox_thread_id = p_inbox_thread_id)
          or (p_property_id     is not null and h.property_id     = p_property_id)
          or (p_opportunity_id  is not null and h.opportunity_id  = p_opportunity_id)
          or (p_master_owner_id is not null and h.master_owner_id = p_master_owner_id))
   order by h.set_at, h.id
$fn$;
revoke all on function public.automation_hold_for(text, uuid, text, uuid, text, text) from public, anon;
grant execute on function public.automation_hold_for(text, uuid, text, uuid, text, text) to authenticated, service_role;
-- thread 1: the ambiguous-property ownership hold (ownership-attribution-hold.js); thread 2: an operator hold
-- on its opportunity; thread 3: a RELEASED hold only (not held)
insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref, set_at) values
  ('ownership_unresolved:+15550100001', 'operator_hold', '+15550100001', 'ownership_denial_property_unresolved', 'system:ownership_attribution',
   'owner_rule_2026-10-17:ambiguous_property_thread_hold', '2026-10-17T10:00:00Z');
insert into public.automation_holds (hold_key, hold_type, opportunity_id, reason, set_by, approval_ref, set_at, blocked_capabilities) values
  ('fixture_operator_hold:opp2', 'operator_hold', '00000000-0000-4000-8000-000000000202', 'Fixture Person asked to pause, call +15550100002', 'operator:fixture',
   'fixture_approval', '2026-10-16T09:00:00Z', array['offer_acceptance','stage_advance']);
insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref, set_at, released_at, released_by, release_reason) values
  ('fixture_released:+15550100003', 'operator_hold', '+15550100003', 'fixture', 'operator:fixture', 'fixture_approval', '2026-10-15T09:00:00Z',
   '2026-10-15T10:00:00Z', 'operator:fixture', 'resolved');

create table public.followup_intents (
  id uuid primary key default gen_random_uuid(), intent_key text not null unique, thread_key text not null, property_id text,
  kind text not null, intent text not null, due_at timestamptz not null, state text not null default 'planned', reason text,
  writer text not null, attempts integer not null default 0, lease_until timestamptz, outcome text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create view public.v_followup_intent_health with (security_invoker = true) as
select
  count(*) filter (where state in ('planned', 'materializing', 'ready', 'dispatched'))                    as scheduled_executable,
  count(*) filter (where state = 'planned')                                                               as planned,
  count(*) filter (where state = 'planned' and due_at < now())                                            as planned_overdue,
  count(*) filter (where state = 'planned' and attempts > 0)                                              as retrying,
  count(*) filter (where state = 'materializing')                                                         as materializing,
  count(*) filter (where state = 'materializing' and lease_until < now())                                 as materializing_stale,
  count(*) filter (where state = 'ready')                                                                 as ready,
  count(*) filter (where state = 'ready' and due_at < now() - interval '6 hours')                         as ready_overdue,
  count(*) filter (where state = 'dispatched')                                                            as dispatched,
  count(*) filter (where state = 'dispatched' and updated_at < now() - interval '1 hour')                 as dispatched_stale,
  count(*) filter (where state = 'provider_accepted')                                                     as provider_accepted,
  count(*) filter (where state = 'provider_accepted' and updated_at < now() - interval '6 hours')         as accepted_unconfirmed,
  count(*) filter (where state = 'delivered')                                                             as delivered,
  count(*) filter (where state = 'failed')                                                                as failed,
  count(*) filter (where state = 'failed' and outcome = 'failed_after_accept')                            as failed_after_accept,
  count(*) filter (where state = 'failed' and outcome = 'failed_ambiguous')                               as failed_ambiguous,
  count(*) filter (where state = 'not_executable')                                                        as not_executable,
  count(*) filter (where state = 'not_executable' and updated_at > now() - interval '24 hours')           as not_executable_24h,
  count(*) filter (where state = 'held')                                                                  as held,
  count(*) filter (where state = 'cancelled')                                                             as cancelled,
  count(*) filter (where state = 'superseded')                                                            as superseded,
  now()                                                                                                   as computed_at
from public.followup_intents;
create view public.v_followup_intent_reasons with (security_invoker = true) as
select state, kind, coalesce(reason, '') as reason, writer, count(*)::int as n, min(due_at) as earliest_due, max(updated_at) as last_change
  from public.followup_intents
 where state in ('not_executable', 'held', 'failed', 'cancelled', 'superseded') or (state = 'planned' and attempts > 0)
 group by state, kind, coalesce(reason, ''), writer;
revoke all on public.v_followup_intent_health, public.v_followup_intent_reasons from public, anon;
grant select on public.v_followup_intent_health, public.v_followup_intent_reasons to authenticated, service_role;
insert into public.followup_intents (intent_key, thread_key, property_id, kind, intent, due_at, state, reason, writer, attempts) values
  ('fx:1', '+15550100001', 'P1', 's2_silence', 'follow_up', now() + interval '1 day', 'planned', null, 'followup_planner', 0),
  ('fx:2', '+15550100002', 'P2', 'not_interested_30d', 'follow_up', now() - interval '2 days', 'planned', 'render_failed', 'followup_planner', 2),
  ('fx:3', '+15550100003', 'P3', 's2_silence', 'follow_up', now() - interval '1 day', 'held', 'automation_hold', 'followup_planner', 0),
  ('fx:4', '+15550100001', 'P1', 'offer_silence', 'follow_up', now() - interval '3 days', 'delivered', null, 'followup_planner', 1);

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
-- operations read model (rc-8.5.20 C / 8.5.21-b), reduced to the columns the lc_mcp_* read functions touch
insert into agent.org values ('00000000-0000-4000-8000-0000000000a9'); -- a second org: its findings must never be read for org a1
create table agent.finding (finding_id text primary key, org_id uuid not null references agent.org(org_id), job_id text, finding_type text not null,
  key text not null, value jsonb, retrieved_at timestamptz not null default now());
create index finding_job_recent_idx on agent.finding (finding_type, retrieved_at desc) where job_id is not null;
insert into agent.finding values
  ('fnd_1', '00000000-0000-4000-8000-0000000000a1', 'job_sup_1', 'supervisor.summary', 'summary', '{"counts":{"ok":18,"warn":2,"critical":0,"unavailable":1},"all_clear":false,"escalations":0,"statuses":{"followup_lifecycle":"warn","automation_holds":"ok"}}', '2026-10-18T08:00:00Z'),
  ('fnd_2', '00000000-0000-4000-8000-0000000000a1', 'job_sup_0', 'supervisor.summary', 'summary', '{"counts":{"ok":1},"all_clear":true,"escalations":0,"statuses":{}}', '2026-10-17T08:00:00Z'),
  ('fnd_3', '00000000-0000-4000-8000-0000000000a1', 'job_rec_1', 'recovery.batch', 'batch', '{"scanned":40,"by_class":{"research_worthy":3},"actionable":3}', '2026-10-18T07:00:00Z'),
  ('fnd_4', '00000000-0000-4000-8000-0000000000a1', 'job_rec_1', 'recovery.linkage', 'batch', '{"research":{"requested":2},"valuation_requests":[{"property_ref":"pr_x"}],"by_next_action":{"research":2}}', '2026-10-18T07:00:01Z'),
  ('fnd_5', '00000000-0000-4000-8000-0000000000a1', 'job_rec_1', 'recovery.candidate', 'conv.x', '{"conversation_id":"00000000-0000-4000-8000-000000000101","note":"call +15550100001"}', '2026-10-18T07:00:02Z'),
  ('fnd_6', '00000000-0000-4000-8000-0000000000a9', 'job_other', 'supervisor.summary', 'summary', '{"counts":{"ok":0},"all_clear":true,"other_org":true}', '2026-10-19T08:00:00Z');
create table agent.conversation_action_state (conversation_id uuid primary key, org_id uuid not null, state text not null, owner text not null,
  verified_stage text, stage_verified boolean not null, stage_note text, next_action text not null, due_at timestamptz, priority_reason text not null,
  evidence_refs jsonb not null default '[]'::jsonb, pending_approvals jsonb not null default '[]'::jsonb, reasons jsonb not null default '[]'::jsonb,
  lost boolean not null default false, opportunity_id uuid, property_ref text, last_inbound_at timestamptz, last_outbound_at timestamptz,
  state_since timestamptz not null, computed_at timestamptz not null, job_id text not null, version text not null);
insert into agent.conversation_action_state (conversation_id, org_id, state, owner, verified_stage, stage_verified, next_action, due_at, priority_reason,
  evidence_refs, pending_approvals, reasons, lost, opportunity_id, property_ref, last_inbound_at, last_outbound_at, state_since, computed_at, job_id, version) values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-0000000000a1', 'needs_attention', 'unassigned', 'ownership_confirmation', false, 'reply_to_seller', null,
   'unowned_conversation', '[{"source":"public.message_events","record_id":"me_1"}]', '[]', '["seller_spoke_last"]', true, '00000000-0000-4000-8000-000000000201', 'pr_1',
   '2026-10-18T06:00:00Z', '2026-10-17T06:00:00Z', '2026-10-18T06:00:00Z', '2026-10-18T08:00:00Z', 'job_ac_1', 'action-center.v1'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-0000000000a1', 'waiting_on_seller', 'ai', 'asking_price', true, 'await_seller_reply', null,
   'routine', '[]', '["approval_1"]', '[]', false, null, null, '2026-10-16T06:00:00Z', '2026-10-17T06:00:00Z', '2026-10-17T06:00:00Z', '2026-10-18T08:00:00Z', 'job_ac_1', 'action-center.v1'),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-0000000000a1', 'scheduled_follow_up', 'ai', null, false, 'follow_up_scheduled', '2026-10-20T15:00:00Z',
   'routine', '[]', '[]', '[]', false, null, null, null, '2026-10-17T06:00:00Z', '2026-10-17T06:00:00Z', '2026-10-18T08:00:00Z', 'job_ac_1', 'action-center.v1');
create function agent.ops_research_valuation_snapshot(p_now timestamptz default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $fn$ begin
  return jsonb_build_object('at', coalesce(p_now, now()),
    'valuation', jsonb_build_object('live', 2, 'with_score', 1, 'offer_ready', 1, 'missing', 1, 'stale_30d', 0, 'by_tier', jsonb_build_object('A', 1)),
    'offers', jsonb_build_object('sent_30d', 1, 'overdue_no_reply_72h', 1, 'overdue_opportunity_ids', jsonb_build_array('00000000-0000-4000-8000-000000000201')),
    'negotiations', jsonb_build_object('envelopes', null, 'live_envelopes', null, 'ledger_events_7d', null, 'send_authorizations', null, 'in_negotiation_stage', 1));
end $fn$;
revoke all on function agent.ops_research_valuation_snapshot(timestamptz) from public, anon, authenticated;
grant execute on function agent.ops_research_valuation_snapshot(timestamptz) to service_role;
alter table agent.finding enable row level security;
alter table agent.finding force row level security;
alter table agent.conversation_action_state enable row level security;
alter table agent.conversation_action_state force row level security;
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
-- The lc_mcp_reader self-check now treats a reachable dynamic-SQL (plpgsql EXECUTE) function as an INDIRECT-egress
-- finding (public.lc_reachable_egress_indirect): as SECURITY INVOKER running AS lc_mcp_reader it can reach
-- net.http_post through PUBLIC's pg_net grants and exfiltrate. So PUBLIC EXECUTE on such a wrapper must be revoked
-- before the credential is safe; mirrored here. A posture test (action-gateway-pg-net-posture-pg.test.mjs) re-grants
-- it and asserts the self-check then refuses with dynamic_sql_function:public.run_sql(text).
revoke all on function public.run_sql(text) from public, anon, authenticated;

-- PostGIS metadata stand-in: STABLE, SECURITY DEFINER, PUBLIC-executable (accepted by name AND volatility)
create function public.st_estimatedextent(p_table text, p_column text) returns text
language sql stable security definer set search_path = pg_catalog
as $$ select null::text $$;

create function agent.sync_operator_membership(p_org uuid, p_user uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, agent
as $$ begin delete from agent.operator_membership where org_id = p_org and user_id = p_user; end $$;
revoke all on function agent.sync_operator_membership(uuid, uuid) from public, anon, authenticated;
grant execute on function agent.sync_operator_membership(uuid, uuid) to service_role;
