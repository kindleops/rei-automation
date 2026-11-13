-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- LeadCommand 8.5.21 part B — the operations supervisor reads research / valuation coverage,
-- overdue offers and negotiation progress (owner directive "LEADCOMMAND 8.5.21", Phase 10).
--
-- ONE read function (SECURITY DEFINER, pinned search_path, bounded, ids only):
--   agent.ops_research_valuation_snapshot(now)   one aggregate jsonb:
--     valuation     live opportunities with / without an engine row, offer-ready tier, by tier, stale
--     offers        formal offers sent (30 d) and offers sent > 72 h ago with no seller reply since
--     negotiations  envelopes / live envelopes / ledger events / send authorizations (null when the
--                   8.5.19 / 8.5.21 tables are not applied: unavailable, never 0)
-- Its SQL is the exact text of apps/api/src/lib/agent/operations/research-valuation-sql.js
-- (tests/critical/ops-research-valuation-sql-drift.test.mjs). Nothing here writes.
--
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016162000_ops_research_valuation_snapshot.sql
-- ORDER: after PROPOSED_20261016140000_operations_action_center.sql.
-- Pretest:  PROPOSED_20261016162000_ops_research_valuation_snapshot_pretest.sql
-- Posttest: PROPOSED_20261016162000_ops_research_valuation_snapshot_posttest.sql
-- Rollback: PROPOSED_20261016162000_ops_research_valuation_snapshot_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function agent.ops_research_valuation_snapshot(p_now timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
begin
  return (select r from (
/*sql:research_valuation_snapshot*/
with p as (select coalesce($1::timestamptz, now()) as now),
live as (
  select o.id, o.primary_property_id, o.primary_thread_key, o.acquisition_stage
    from public.acquisition_opportunities o
   where o.opportunity_status in ('active', 'nurture') and o.primary_property_id is not null
),
scored as (
  select l.id, s.decision_tier, s.computed_at
    from live l
    left join lateral (select x.decision_tier, x.computed_at from public.property_acquisition_scores x
                        where x.property_id = l.primary_property_id order by x.computed_at desc nulls last limit 1) s on true
),
valuation as (
  select jsonb_build_object(
    'live', count(*)::int,
    'with_score', count(*) filter (where computed_at is not null)::int,
    'offer_ready', count(*) filter (where decision_tier in ('AUTO_HARD_OFFER', 'AUTO_RANGE_OFFER'))::int,
    'stale_30d', count(*) filter (where computed_at is not null and computed_at < (select now from p) - interval '30 days')::int,
    'missing', count(*) filter (where computed_at is null)::int,
    'by_tier', coalesce((select jsonb_object_agg(t, n) from (select coalesce(decision_tier, 'none') t, count(*)::int n from scored group by 1) z), '{}'::jsonb)
  ) as v from scored
),
sent as (
  select so.id, so.opportunity_id, so.thread_key, so.sent_at
    from public.seller_offers so
   where so.sent_at is not null and so.sent_at >= (select now from p) - interval '30 days'
),
overdue as (
  select s.id, s.opportunity_id
    from sent s
    join public.acquisition_opportunities o on o.id = s.opportunity_id and o.opportunity_status in ('active', 'nurture')
   where s.sent_at < (select now from p) - interval '72 hours'
     and not exists (select 1 from public.message_events m
                      where m.thread_key = s.thread_key and m.direction = 'inbound'
                        and coalesce(m.event_timestamp, m.created_at) > s.sent_at)
),
offers as (
  select jsonb_build_object(
    'sent_30d', (select count(*)::int from sent),
    'overdue_no_reply_72h', (select count(*)::int from overdue),
    'overdue_opportunity_ids', coalesce((select jsonb_agg(x.opportunity_id) from (select distinct opportunity_id from overdue order by opportunity_id limit 20) x), '[]'::jsonb)
  ) as v
),
negotiations as (
  select jsonb_build_object(
    'envelopes', case when to_regclass('public.negotiation_envelopes') is null then null
                      else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.negotiation_envelopes', false, true, '')))[1]::text::int end,
    'live_envelopes', case when to_regclass('public.negotiation_envelopes') is null then null
                      else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.negotiation_envelopes e where e.expires_at > now() and not exists (select 1 from public.negotiation_envelope_revocations r where r.envelope_id = e.envelope_id) and not exists (select 1 from public.negotiation_envelopes n2 where n2.scope_key = e.scope_key and n2.version > e.version)', false, true, '')))[1]::text::int end,
    'ledger_events_7d', case when to_regclass('public.negotiation_offer_events') is null then null
                      else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.negotiation_offer_events where created_at > now() - interval ''7 days''', false, true, '')))[1]::text::int end,
    'send_authorizations', case when to_regclass('public.negotiation_send_authorizations') is null then null
                      else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.negotiation_send_authorizations', false, true, '')))[1]::text::int end,
    'in_negotiation_stage', (select count(*)::int from live where acquisition_stage in ('asking_price', 'property_condition', 'offer'))
  ) as v
)
select jsonb_build_object(
  'at', (select now from p),
  'valuation', (select v from valuation),
  'offers', (select v from offers),
  'negotiations', (select v from negotiations)
) as r
/*end*/
  ) z);
end
$fn$;
comment on function agent.ops_research_valuation_snapshot(timestamptz) is 'Operations supervisor (8.5.21-b): valuation coverage, overdue offers, negotiation progress. Counts and ids only.';
revoke all on function agent.ops_research_valuation_snapshot(timestamptz) from public, anon, authenticated;
grant execute on function agent.ops_research_valuation_snapshot(timestamptz) to agent_api, service_role;
