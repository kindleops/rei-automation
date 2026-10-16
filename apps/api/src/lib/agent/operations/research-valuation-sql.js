// 8.5.21-b — the supervisor's research / valuation / offer / negotiation read (ONE aggregate row).
//
// This text is the exact body of agent.ops_research_valuation_snapshot(p_now) in
// supabase/migrations/PROPOSED_20261016162000_ops_research_valuation_snapshot.sql
// (tests/critical/ops-research-valuation-sql-drift.test.mjs keeps them in step), and the live
// read-only proof runs the same text through a READ ONLY transaction. $1 = now (null ⇒ now()).
//
// Counts only; id lists are capped at 20 and carry ids (uuid / job ids) — never a phone, a name,
// an address or a message body. A relation that does not exist yet (negotiation tables, runtime)
// is reported as null ("unavailable"), never 0.
//
//   valuation     live opportunities (active / nurture) with a property: with an engine row,
//                 offer-ready tier (AUTO_HARD_OFFER / AUTO_RANGE_OFFER), by tier, stale (> 30 d),
//                 missing
//   offers        formal offers sent in 30 d; sent > 72 h ago with no seller message since and
//                 the opportunity still live ("overdue": a follow-up or a decision is owed)
//   negotiations  envelopes / live envelopes / ledger events (7 d) / send authorizations
// Research status (property.research / valuation.refresh jobs and findings) is NOT read here:
// the supervisor reads it from the runtime (activitySince) and the findings store, so this text
// references public relations only and runs unchanged on a database without the agent schema.
export const OFFER_READY_TIERS = Object.freeze(['AUTO_HARD_OFFER', 'AUTO_RANGE_OFFER'])

export const RESEARCH_VALUATION_SNAPSHOT_SQL = `
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
) as r`
