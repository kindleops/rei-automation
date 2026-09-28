-- ANALYTICS — period performance of the acquisition machine, current vs prior.
--
-- One bounded, index-driven aggregate. Definitions (the service documents each
-- metric's numerator / denominator / grain / window / source):
--
--   sends       send_queue rows created in the window (canary rows excluded:
--               internal test phones on thread/from/to, source internal_canary,
--               metadata internal_canary / exclude_from_kpis). Same row
--               predicates as war-room (is_sent / is_delivered / is_failed).
--   replies     inbound message_events in the window, canary excluded.
--               Attributed to the latest send_queue row on the same thread at
--               or before the reply (property → canonical market, campaign).
--   transitions acquisition_opportunity_history stage_transition events,
--               certification / probe / fixture rows excluded (Pipeline's
--               isSyntheticHistory rule). Created = opportunity_created events
--               (the June backfill has none and is not "created in period").
--   geography   property → properties.canonical_market_id (the canonical
--               market system); unresolved rows are counted, never assigned.
--   buyers      buyer-resolved recorded purchases (comp_private market-evidence
--               MV), ZIP → canonical market via reviewed market_zip_membership.
--
-- Pass p_market to scope every property-attributed metric to one market; the
-- per-market geography rows are always returned unscoped (the map needs all).

create or replace function public.analytics_performance(
  p_start timestamptz,
  p_end timestamptz,
  p_prev_start timestamptz,
  p_prev_end timestamptz,
  p_exclude text[] default '{}',
  p_positive text[] default '{}',
  p_optout text[] default '{}',
  p_market text default null,
  p_bucket text default 'day'
) returns jsonb
language sql
stable
security definer
set search_path = public, comp_private, pg_temp
as $$
with
sq as (
  select s.id, s.thread_key, s.queue_status, s.created_at, s.sent_at, s.campaign_id, s.property_id,
         coalesce(s.source, '') as source, coalesce(s.message_type, '') as message_type,
         coalesce(s.failed_reason, s.blocked_reason, s.guard_reason, '') as reason,
         case when s.created_at >= p_start and s.created_at < p_end then 'cur' else 'prev' end as per,
         (s.sent_at is not null or s.queue_status in ('sent', 'delivered')) as is_sent,
         (s.delivered_at is not null or s.queue_status = 'delivered' or lower(coalesce(s.delivery_confirmed, '')) in ('true', 'delivered', 'yes')) as is_delivered,
         s.queue_status in ('failed', 'failed_transport', 'undelivered') as is_failed,
         case when s.sent_at is not null and coalesce(s.scheduled_for_utc, s.scheduled_for) is not null
              then extract(epoch from (s.sent_at - coalesce(s.scheduled_for_utc, s.scheduled_for))) / 60 end as delay_min,
         p.canonical_market_id as mkt, left(p.property_address_zip, 5) as zip,
         p.latitude::float8 as lat, p.longitude::float8 as lng
  from send_queue s
  left join properties p on p.property_id = s.property_id
  where ((s.created_at >= p_start and s.created_at < p_end) or (s.created_at >= p_prev_start and s.created_at < p_prev_end))
    and not (coalesce(s.thread_key, '') = any(p_exclude) or coalesce(s.from_phone_number, '') = any(p_exclude) or coalesce(s.to_phone_number, '') = any(p_exclude))
    and s.source is distinct from 'internal_canary'
    and lower(coalesce(s.metadata ->> 'internal_canary', '')) not in ('true', '1', 'yes')
    and lower(coalesce(s.metadata ->> 'exclude_from_kpis', '')) not in ('true', '1', 'yes')
),
inb as (
  select m.id, m.thread_key, m.created_at, lower(coalesce(m.detected_intent, '')) as intent,
         (coalesce(m.is_opt_out, false) or m.opt_out_keyword is not null or lower(coalesce(m.detected_intent, '')) = any(p_optout)) as is_opt,
         lower(coalesce(m.detected_intent, '')) = any(p_positive) as is_pos,
         case when m.created_at >= p_start and m.created_at < p_end then 'cur' else 'prev' end as per,
         coalesce(pm.canonical_market_id, att.mkt) as mkt,
         coalesce(m.property_id, att.property_id) as property_id,
         coalesce(left(pm.property_address_zip, 5), att.zip) as zip,
         coalesce(pm.latitude::float8, att.lat) as lat, coalesce(pm.longitude::float8, att.lng) as lng,
         att.campaign_id
  from message_events m
  left join properties pm on pm.property_id = m.property_id
  left join lateral (
    select s.property_id, s.campaign_id, p.canonical_market_id as mkt, left(p.property_address_zip, 5) as zip,
           p.latitude::float8 as lat, p.longitude::float8 as lng
    from send_queue s left join properties p on p.property_id = s.property_id
    where s.thread_key = m.thread_key and s.created_at <= m.created_at
    order by s.created_at desc
    limit 1
  ) att on true
  where m.direction = 'inbound'
    and ((m.created_at >= p_start and m.created_at < p_end) or (m.created_at >= p_prev_start and m.created_at < p_prev_end))
    and not (coalesce(m.thread_key, '') = any(p_exclude) or coalesce(m.from_phone_number, '') = any(p_exclude) or coalesce(m.to_phone_number, '') = any(p_exclude))
    and lower(coalesce(m.metadata ->> 'internal_canary', '')) not in ('true', '1', 'yes')
),
hist as (
  select h.opportunity_id, h.event_type, h.previous_value as fr, h.new_value as tov, h.created_at,
         coalesce(h.source, '') as source, coalesce(h.actor, '') as actor, coalesce(h.reason, '') as reason
  from acquisition_opportunity_history h
  where h.event_type in ('stage_transition', 'opportunity_created')
    and coalesce(h.actor, '') !~* '(cert|probe|fixture|qa_|test)'
    and coalesce(h.reason, '') !~* '(certification|probe|fixture|restore test|regression)'
    and h.created_at < p_end
),
hist_t as (
  select x.*, o.primary_property_id as property_id, p.canonical_market_id as mkt,
         case when x.created_at >= p_start then 'cur' when x.created_at >= p_prev_start and x.created_at < p_prev_end then 'prev' end as per
  from (
    select hist.*,
           lag(created_at) over (partition by opportunity_id order by created_at) as prev_at
    from hist
  ) x
  join acquisition_opportunities o on o.id::text = x.opportunity_id::text
  left join properties p on p.property_id = o.primary_property_id
),
active as (
  select o.id, o.acquisition_stage as stage, o.stage_entered_at, o.last_activity_at, o.primary_property_id as property_id,
         p.canonical_market_id as mkt, p.latitude::float8 as lat, p.longitude::float8 as lng
  from acquisition_opportunities o
  left join properties p on p.property_id = o.primary_property_id
  where o.opportunity_status = 'active'
),
offers as (
  select so.offer_id, so.opportunity_id, so.property_id, so.direction, so.status, so.purchase_price, so.created_at, so.accepted_at,
         p.canonical_market_id as mkt,
         case when so.created_at >= p_start and so.created_at < p_end then 'cur' when so.created_at >= p_prev_start and so.created_at < p_prev_end then 'prev' end as per
  from seller_offers so
  left join properties p on p.property_id = so.property_id
  where (so.created_at >= p_prev_start and so.created_at < p_end)
),
closings as (
  select c.id, c.opportunity_id, c.property_id, c.closing_status, c.contract_signed_date, c.recording_date, c.funding_date, c.created_at,
         c.seller_contract_price, c.buyer_price, c.confirmed_gross_revenue, p.canonical_market_id as mkt
  from closing_cases c
  left join properties p on p.property_id = c.property_id
),
execs as (
  select e.status, coalesce(e.metadata ->> 'block_reason', '') as block_reason, p.canonical_market_id as mkt,
         case when e.created_at >= p_start and e.created_at < p_end then 'cur' else 'prev' end as per
  from seller_automation_executions e
  left join properties p on p.property_id = e.property_id
  where ((e.created_at >= p_start and e.created_at < p_end) or (e.created_at >= p_prev_start and e.created_at < p_prev_end))
    and not coalesce(e.replay_only, false)
),
decisions as (
  select d.action, p.canonical_market_id as mkt,
         case when d.created_at >= p_start and d.created_at < p_end then 'cur' else 'prev' end as per
  from seller_automation_decisions d
  left join properties p on p.property_id = d.property_id
  where (d.created_at >= p_start and d.created_at < p_end) or (d.created_at >= p_prev_start and d.created_at < p_prev_end)
),
buys as (
  select mv.buyer_id, mv.buyer_kind, coalesce(mv.buyer_acquisitions, 1) as acq, mv.zip, mv.lat, mv.lng, zm.canonical_market_id as mkt,
         case when mv.event_date >= p_start::date and mv.event_date < p_end::date then 'cur' else 'prev' end as per
  from comp_private.mv_comp_market_evidence mv
  left join market_zip_membership zm on zm.zip5 = mv.zip
  where mv.buyer_id is not null
    and ((mv.event_date >= p_start::date and mv.event_date < p_end::date) or (mv.event_date >= p_prev_start::date and mv.event_date < p_prev_end::date))
    and not coalesce(mv.nominal_price, false)
    and not coalesce(mv.distress_or_transfer_deed, false)
),
-- market-scoped views (p_market null = everything)
sqf as (select * from sq where p_market is null or mkt = p_market),
inbf as (select * from inb where p_market is null or mkt = p_market),
histf as (select * from hist_t where p_market is null or mkt = p_market),
activef as (select * from active where p_market is null or mkt = p_market),
offersf as (select * from offers where p_market is null or mkt = p_market),
closingsf as (select * from closings where p_market is null or mkt = p_market),
execsf as (select * from execs where p_market is null or mkt = p_market),
decisionsf as (select * from decisions where p_market is null or mkt = p_market),
buysf as (select * from buys where p_market is null or mkt = p_market),
per_tot as (
  select per.k as per, jsonb_build_object(
    'send_rows', (select count(*) from sqf where sqf.per = per.k),
    'sent', (select count(*) from sqf where sqf.per = per.k and is_sent),
    'delivered', (select count(*) from sqf where sqf.per = per.k and is_delivered),
    'delivered_conversations', (select count(distinct thread_key) from sqf where sqf.per = per.k and is_delivered),
    'failed', (select count(*) from sqf where sqf.per = per.k and is_failed),
    'failed_transport', (select count(*) from sqf where sqf.per = per.k and queue_status = 'failed_transport'),
    'health_guard_blocks', (select count(*) from sqf where sqf.per = per.k and queue_status = 'blocked_by_health_guard'),
    'content_blocks', (select count(*) from sqf where sqf.per = per.k and (reason ~* '(blank|content|filter|216)')),
    'expired', (select count(*) from sqf where sqf.per = per.k and queue_status = 'expired'),
    'cancelled', (select count(*) from sqf where sqf.per = per.k and queue_status = 'cancelled'),
    'median_send_delay_min', (select round(percentile_cont(0.5) within group (order by delay_min)::numeric, 1) from sqf where sqf.per = per.k and delay_min is not null and delay_min >= 0),
    'sends_automated', (select count(*) from sqf where sqf.per = per.k and is_sent and (source ~* '(campaign|orchestrator|auto_reply|autopilot|followup)' or message_type ~* 'follow')),
    'sends_operator', (select count(*) from sqf where sqf.per = per.k and is_sent and (source ~* '(inbox|manual|map_command)' or message_type ~* 'manual')),
    'reply_messages', (select count(*) from inbf where inbf.per = per.k),
    'replied_conversations', (select count(distinct thread_key) from inbf where inbf.per = per.k),
    'positive_conversations', (select count(distinct thread_key) from inbf where inbf.per = per.k and is_pos),
    'opt_out_conversations', (select count(distinct thread_key) from inbf where inbf.per = per.k and is_opt),
    'opportunities_created', (select count(*) from histf where histf.per = per.k and event_type = 'opportunity_created'),
    'stage_advancements', (select count(*) from histf where histf.per = per.k and event_type = 'stage_transition'),
    'offers_issued', (select count(*) from offersf where offersf.per = per.k and direction <> 'inbound'),
    'seller_counters', (select count(*) from offersf where offersf.per = per.k and direction = 'inbound'),
    'offers_accepted', (select count(*) from offers o2 where (p_market is null or o2.mkt = p_market) and o2.accepted_at is not null
                          and ((per.k = 'cur' and o2.accepted_at >= p_start and o2.accepted_at < p_end) or (per.k = 'prev' and o2.accepted_at >= p_prev_start and o2.accepted_at < p_prev_end))),
    'contracts', (select count(*) from closingsf where contract_signed_date is not null
                    and ((per.k = 'cur' and contract_signed_date >= p_start::date and contract_signed_date < p_end::date) or (per.k = 'prev' and contract_signed_date >= p_prev_start::date and contract_signed_date < p_prev_end::date))),
    'closed', (select count(*) from closingsf where coalesce(recording_date, funding_date) is not null
                 and ((per.k = 'cur' and coalesce(recording_date, funding_date) >= p_start::date and coalesce(recording_date, funding_date) < p_end::date) or (per.k = 'prev' and coalesce(recording_date, funding_date) >= p_prev_start::date and coalesce(recording_date, funding_date) < p_prev_end::date))),
    'automation_runs', (select count(*) from execsf where execsf.per = per.k),
    'automation_succeeded', (select count(*) from execsf where execsf.per = per.k and status = 'succeeded'),
    'automation_held_by_gate', (select count(*) from execsf where execsf.per = per.k and status = 'blocked' and block_reason = 'execution_gated'),
    'automation_needs_review', (select count(*) from execsf where execsf.per = per.k and status = 'blocked' and block_reason ~* '(review|unclear|missing_context|low_confidence)'),
    'automation_policy_blocks', (select count(*) from execsf where execsf.per = per.k and status = 'blocked' and block_reason !~* '(execution_gated|review|unclear|missing_context|low_confidence)'),
    'automation_failed', (select count(*) from execsf where execsf.per = per.k and status = 'failed'),
    'decisions', (select count(*) from decisionsf where decisionsf.per = per.k),
    'decisions_escalated', (select count(*) from decisionsf where decisionsf.per = per.k and action = 'escalate'),
    'buyer_purchases', (select count(*) from buysf where buysf.per = per.k),
    'buyer_entities', (select count(distinct buyer_id) from buysf where buysf.per = per.k),
    'repeat_buyer_purchases', (select count(*) from buysf where buysf.per = per.k and acq >= 2)
  ) as j
  from (values ('cur'), ('prev')) as per(k)
),
latency as (
  select percentile_cont(0.5) within group (order by mins) as med, count(*) as n
  from (
    select extract(epoch from (fi.t - ob.t)) / 60 as mins
    from (select thread_key, min(created_at) as t from inbf where per = 'cur' and thread_key is not null group by 1) fi
    cross join lateral (
      select coalesce(o.event_timestamp, o.sent_at, o.delivered_at, o.created_at) as t
      from message_events o
      where o.thread_key = fi.thread_key and lower(coalesce(o.direction, '')) like 'out%'
        and coalesce(o.event_timestamp, o.sent_at, o.delivered_at, o.created_at) < fi.t
      order by coalesce(o.event_timestamp, o.sent_at, o.delivered_at, o.created_at) desc, o.created_at desc, o.id desc
      limit 1
    ) ob
    where fi.t - ob.t < interval '30 days'
  ) x
),
buckets as (
  select generate_series(date_trunc(p_bucket, p_start), p_end - interval '1 second', ('1 ' || p_bucket)::interval) as b
),
series as (
  select jsonb_agg(jsonb_build_object(
    'at', b.b,
    'delivered', (select count(*) from sqf where per = 'cur' and is_delivered and date_trunc(p_bucket, created_at) = b.b),
    'failed', (select count(*) from sqf where per = 'cur' and is_failed and date_trunc(p_bucket, created_at) = b.b),
    'replied_conversations', (select count(distinct thread_key) from inbf where per = 'cur' and date_trunc(p_bucket, created_at) = b.b),
    'opt_outs', (select count(distinct thread_key) from inbf where per = 'cur' and is_opt and date_trunc(p_bucket, created_at) = b.b),
    'advancements', (select count(*) from histf where per = 'cur' and event_type = 'stage_transition' and date_trunc(p_bucket, created_at) = b.b)
  ) order by b.b) as j
  from buckets b
),
mkts as (
  select m.id, m.display_name, m.state from canonical_markets m
),
geo_cur as (
  select mkt, per,
         count(*) filter (where src = 'sq' and is_delivered) as delivered,
         count(distinct thread_key) filter (where src = 'sq' and is_delivered) as delivered_conv,
         count(*) filter (where src = 'sq' and is_failed) as failed,
         count(*) filter (where src = 'sq' and flag_content) as content_blocks,
         count(distinct thread_key) filter (where src = 'inb') as replied_conv,
         count(distinct thread_key) filter (where src = 'inb' and is_opt) as opt_out_conv,
         count(*) filter (where src = 'hist_c') as created,
         count(*) filter (where src = 'hist_t') as advanced,
         count(*) filter (where src = 'exec_x') as automation_exceptions,
         count(*) filter (where src = 'buy') as buyer_purchases,
         count(distinct buyer_id) filter (where src = 'buy') as buyer_entities,
         avg(lat) filter (where lat is not null) as lat, avg(lng) filter (where lng is not null) as lng
  from (
    select 'sq' as src, per, mkt, thread_key, is_delivered, is_failed, reason ~* '(blank|content|filter|216)' as flag_content, false as is_opt, null::text as buyer_id, lat, lng from sq
    union all select 'inb', per, mkt, thread_key, false, false, false, is_opt, null, lat, lng from inb
    union all select case when event_type = 'opportunity_created' then 'hist_c' else 'hist_t' end, per, mkt, null, false, false, false, false, null, null, null from hist_t where per is not null
    union all select 'exec_x', per, mkt, null, false, false, false, false, null, null, null from execs where status in ('failed') or (status = 'blocked' and block_reason ~* '(review|unclear|missing_context|low_confidence)')
    union all select 'buy', per, mkt, null, false, false, false, false, buyer_id, lat, lng from buys
  ) u
  where mkt is not null
  group by mkt, per
),
geo as (
  select jsonb_agg(jsonb_build_object(
    'id', mk.id, 'name', mk.display_name, 'state', mk.state,
    'lat', coalesce(c.lat, pv.lat, st.lat), 'lng', coalesce(c.lng, pv.lng, st.lng),
    'cur', jsonb_build_object('delivered', coalesce(c.delivered, 0), 'delivered_conversations', coalesce(c.delivered_conv, 0), 'failed', coalesce(c.failed, 0), 'content_blocks', coalesce(c.content_blocks, 0),
                              'replied_conversations', coalesce(c.replied_conv, 0), 'opt_out_conversations', coalesce(c.opt_out_conv, 0), 'opportunities_created', coalesce(c.created, 0),
                              'stage_advancements', coalesce(c.advanced, 0), 'automation_exceptions', coalesce(c.automation_exceptions, 0),
                              'buyer_purchases', coalesce(c.buyer_purchases, 0), 'buyer_entities', coalesce(c.buyer_entities, 0)),
    'prev', jsonb_build_object('delivered', coalesce(pv.delivered, 0), 'delivered_conversations', coalesce(pv.delivered_conv, 0), 'failed', coalesce(pv.failed, 0), 'content_blocks', coalesce(pv.content_blocks, 0),
                               'replied_conversations', coalesce(pv.replied_conv, 0), 'opt_out_conversations', coalesce(pv.opt_out_conv, 0), 'opportunities_created', coalesce(pv.created, 0),
                               'stage_advancements', coalesce(pv.advanced, 0), 'automation_exceptions', coalesce(pv.automation_exceptions, 0),
                               'buyer_purchases', coalesce(pv.buyer_purchases, 0), 'buyer_entities', coalesce(pv.buyer_entities, 0)),
    'active_opportunities', coalesce(st.active, 0), 'dormant_opportunities', coalesce(st.dormant, 0)
  )) as j
  from mkts mk
  left join geo_cur c on c.mkt = mk.id and c.per = 'cur'
  left join geo_cur pv on pv.mkt = mk.id and pv.per = 'prev'
  left join (select a.mkt, count(*) as active, count(*) filter (where a.last_activity_at < now() - interval '30 days' or a.last_activity_at is null) as dormant,
                    avg(a.lat) as lat, avg(a.lng) as lng from active a where a.mkt is not null group by a.mkt) st on st.mkt = mk.id
  where c.mkt is not null or pv.mkt is not null or st.mkt is not null
),
zips as (
  select jsonb_agg(z) as j from (
    select jsonb_build_object('zip', zip, 'market', max(mkt), 'lat', avg(lat), 'lng', avg(lng),
      'delivered', count(*) filter (where src = 'sq' and is_delivered),
      'replied_conversations', count(distinct thread_key) filter (where src = 'inb'),
      'failed', count(*) filter (where src = 'sq' and is_failed),
      'buyer_purchases', count(*) filter (where src = 'buy')) as z
    from (
      select 'sq' as src, zip, mkt, thread_key, is_delivered, is_failed, lat, lng from sq where per = 'cur'
      union all select 'inb', zip, mkt, thread_key, false, false, lat, lng from inb where per = 'cur'
      union all select 'buy', zip, mkt, null, false, false, lat, lng from buys where per = 'cur'
    ) u
    where zip is not null and lat is not null and (p_market is null or mkt = p_market)
    group by zip
    order by count(*) desc
    limit 400
  ) q
),
campaign_rows as (
  select jsonb_agg(r order by (r ->> 'delivered_conversations')::int desc) as j from (
    select jsonb_build_object(
      'id', c.id, 'name', c.name, 'status', c.status, 'market', c.market,
      'sends', count(*) filter (where s.src = 'sq'),
      'delivered', count(*) filter (where s.src = 'sq' and s.is_delivered),
      'failed', count(*) filter (where s.src = 'sq' and s.is_failed),
      'delivered_conversations', count(distinct s.thread_key) filter (where s.src = 'sq' and s.is_delivered),
      'replied_conversations', count(distinct s.thread_key) filter (where s.src = 'inb'),
      'positive_conversations', count(distinct s.thread_key) filter (where s.src = 'inb' and s.is_pos),
      'opt_out_conversations', count(distinct s.thread_key) filter (where s.src = 'inb' and s.is_opt)
    ) as r
    from (
      select 'sq' as src, campaign_id, thread_key, is_delivered, is_failed, false as is_pos, false as is_opt from sqf where per = 'cur' and campaign_id is not null
      union all select 'inb', campaign_id, thread_key, false, false, is_pos, is_opt from inbf where per = 'cur' and campaign_id is not null
    ) s
    join campaigns c on c.id = s.campaign_id
    group by c.id, c.name, c.status, c.market
  ) q
),
campaign_opps as (
  select jsonb_object_agg(cid, jsonb_build_object('opportunities', n, 'reached_asking_price', n3, 'reached_offer', n5)) as j from (
    select e.value #>> '{}' as cid, count(*) as n,
           count(*) filter (where o.acquisition_stage in ('asking_price', 'property_condition', 'offer', 'formal_contract', 'disposition', 'under_contract', 'prepared_to_close')) as n3,
           count(*) filter (where o.acquisition_stage in ('offer', 'formal_contract', 'disposition', 'under_contract', 'prepared_to_close')) as n5
    from acquisition_opportunities o
    cross join lateral jsonb_array_elements(case when jsonb_typeof(o.campaign_ids) = 'array' then o.campaign_ids else '[]'::jsonb end) e
    where o.opportunity_status = 'active'
    group by 1
  ) q
)
select jsonb_build_object(
  'totals', (select jsonb_object_agg(per, j) from per_tot),
  'latency', (select jsonb_build_object('median_minutes', round(med::numeric, 1), 'sample', n) from latency),
  'series', (select j from series),
  'transitions', (select coalesce(jsonb_agg(jsonb_build_object('opportunity_id', opportunity_id, 'type', event_type, 'from', fr, 'to', tov, 'at', created_at, 'prev_at', prev_at,
                     'source', source, 'reason', reason, 'market', mkt, 'property_id', property_id, 'per', per) order by created_at desc), '[]'::jsonb)
                  from histf where per is not null),
  'active', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'stage', stage, 'stage_entered_at', stage_entered_at, 'last_activity_at', last_activity_at,
                     'market', mkt, 'property_id', property_id, 'lat', lat, 'lng', lng)), '[]'::jsonb) from activef),
  'offers', (select coalesce(jsonb_agg(jsonb_build_object('offer_id', offer_id, 'opportunity_id', opportunity_id, 'property_id', property_id, 'direction', direction,
                     'status', status, 'price', purchase_price, 'at', created_at, 'accepted_at', accepted_at, 'market', mkt, 'per', per)), '[]'::jsonb) from offersf where per is not null),
  'closings', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'opportunity_id', opportunity_id, 'property_id', property_id, 'status', closing_status,
                     'contract_signed_date', contract_signed_date, 'recording_date', recording_date, 'funding_date', funding_date,
                     'seller_contract_price', seller_contract_price, 'buyer_price', buyer_price, 'confirmed_gross_revenue', confirmed_gross_revenue, 'market', mkt)), '[]'::jsonb) from closingsf),
  'automation_block_reasons', (select coalesce(jsonb_object_agg(block_reason, n), '{}'::jsonb) from (select block_reason, count(*) as n from execsf where per = 'cur' and status = 'blocked' group by 1) q),
  'decision_actions', (select coalesce(jsonb_object_agg(action, n), '{}'::jsonb) from (select coalesce(action, 'unknown') as action, count(*) as n from decisionsf where per = 'cur' group by 1) q),
  'backlog', (select jsonb_build_object('pending', count(*), 'oldest_scheduled', min(coalesce(scheduled_for_utc, scheduled_for))) from send_queue
              where lower(queue_status) in ('scheduled', 'queued', 'pending', 'approved', 'ready', 'processing', 'sending')),
  'markets', (select coalesce(j, '[]'::jsonb) from geo),
  'zips', (select coalesce(j, '[]'::jsonb) from zips),
  'campaigns', (select coalesce(j, '[]'::jsonb) from campaign_rows),
  'campaign_opportunities', (select coalesce(j, '{}'::jsonb) from campaign_opps),
  'buyer_data_through', (select max(event_date) from comp_private.mv_comp_market_evidence where buyer_id is not null),
  'unresolved', jsonb_build_object(
    'send_rows', (select count(*) from sq where per = 'cur' and mkt is null),
    'replies', (select count(*) from inb where per = 'cur' and mkt is null),
    'transitions', (select count(*) from hist_t where per = 'cur' and mkt is null),
    'buyer_purchases', (select count(*) from buys where per = 'cur' and mkt is null)),
  'reply_cohort', (select coalesce(jsonb_agg(r), '[]'::jsonb) from (
      select jsonb_build_object('thread_key', thread_key, 'at', max(created_at), 'intent', (array_agg(intent order by created_at desc))[1],
                                'opt_out', bool_or(is_opt), 'positive', bool_or(is_pos), 'market', max(mkt), 'property_id', max(property_id)) as r
      from inbf where per = 'cur' and thread_key is not null group by thread_key order by max(created_at) desc limit 120) q)
);
$$;

revoke all on function public.analytics_performance(timestamptz, timestamptz, timestamptz, timestamptz, text[], text[], text[], text, text) from public, anon, authenticated;
grant execute on function public.analytics_performance(timestamptz, timestamptz, timestamptz, timestamptz, text[], text[], text[], text, text) to service_role;
