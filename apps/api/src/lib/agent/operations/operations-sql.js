// Operations read SQL (8.5.20 part C) — ONE text per read, shared by every path:
//
//   production runtime   agent.ops_* SECURITY DEFINER functions (PROPOSED migration
//                        PROPOSED_20261016140000_operations_action_center.sql) whose plpgsql
//                        bodies embed these exact texts; called over the agent_api pool
//   read-only proof      the same text run under BEGIN READ ONLY over the pooler
//   disposable PG tests  the functions, as agent_api
// tests/critical/operations-sql-drift.test.mjs fails when a migration body and its
// text here diverge.
//
// Every text is a single SELECT: bounded (LIMIT ≤ 500 or aggregate-only), served by
// existing indexes (thread_key on message_events / send_queue, primary_thread_key on
// acquisition_opportunities, updated_at on inbox_thread_state). NO phone, name,
// address or message body is selected into the output: a conversation is its
// inbox_thread_state.id (uuid); thread_key / canonical_e164 are used for joins only.

/** Inbound intents that are not, on their own, something to answer. */
export const NON_MEANINGFUL_INTENTS = Object.freeze(['reaction_only', 'acknowledgement'])
/** send_queue statuses that are still going to be attempted (idx_send_queue_pending_thread). */
export const PENDING_QUEUE_STATUSES = Object.freeze(['scheduled', 'queued', 'pending', 'approved', 'ready', 'processing', 'sending'])
/** Interest / price / offer / condition intents: a "qualified" reply (ownership confirmation alone is not). */
export const QUALIFIED_INTENTS = Object.freeze(['seller_interested', 'latent_interest', 'asks_offer', 'asking_price_provided', 'asking_price_implausible', 'condition_disclosed', 'callback_requested', 'contract_requested', 'need_time', 'tenant_occupied'])
/** send_queue message types that are follow-ups. */
export const FOLLOWUP_MESSAGE_TYPES = Object.freeze(['followup', 'follow-up', 'reengagement', 'nurture_not_interested', 'no_response_followup'])
const q = (xs) => xs.map((x) => `'${x}'`).join(', ')

// $1 after_at timestamptz | null, $2 after_id uuid | null, $3 limit (keyset on (updated_at, id)).
// cursor_at is returned as TEXT: full microsecond precision, so the keyset never re-reads a row.
export const CONVERSATION_FACTS_SQL = `
with thr as (
  select t.id, t.thread_key, t.canonical_e164, coalesce(t.updated_at, t.created_at, timestamptz 'epoch') as cursor_at,
         t.property_id, t.market, t.seller_stage, t.disposition, t.contactability_status,
         coalesce(t.is_suppressed, false) as is_suppressed, coalesce(t.is_archived, false) as is_archived, t.archive_reason,
         coalesce(t.is_read, false) as is_read, t.inbox_bucket, t.operational_status, t.lead_temperature,
         coalesce(t.is_hot_lead, false) as is_hot_lead, t.last_intent, nullif(btrim(t.next_action), '') as next_action,
         t.next_action_at, t.follow_up_at, t.snoozed_until, coalesce(t.manual_override, false) as manual_override
    from public.inbox_thread_state t
   where t.thread_key is not null
     and ($1::timestamptz is null
          or (coalesce(t.updated_at, t.created_at, timestamptz 'epoch'), t.id) > ($1::timestamptz, coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)))
     and exists (select 1 from public.message_events m0 where m0.thread_key = t.thread_key and m0.direction = 'inbound')
   order by coalesce(t.updated_at, t.created_at, timestamptz 'epoch'), t.id
   limit least(greatest(coalesce($3::int, 200), 1), 500)
)
select thr.id::text as conversation_id, thr.cursor_at::text as cursor_at, thr.property_id, thr.market, thr.seller_stage, thr.disposition,
       thr.contactability_status, thr.is_suppressed, thr.is_archived, thr.archive_reason, thr.is_read, thr.inbox_bucket,
       thr.operational_status, thr.lead_temperature, thr.is_hot_lead, thr.last_intent, thr.next_action, thr.next_action_at,
       thr.follow_up_at, thr.snoozed_until, thr.manual_override,
       ev.inbound_count, ev.first_inbound_at, ev.any_opt_out, ev.inbound_intents,
       li.last_inbound_id, li.last_inbound_at, li.last_inbound_intent, li.last_inbound_opt_out, li.last_inbound_language,
       lm.last_meaningful_id, lm.last_meaningful_at, lm.last_meaningful_intent,
       lo.last_outbound_id, lo.last_outbound_at, lo.last_outbound_delivery, lo.last_outbound_auto,
       coalesce(oa.outbound_after_inbound, 0) as outbound_after_inbound, coalesce(oa.delivered_after_inbound, 0) as delivered_after_inbound,
       coalesce(oa.failed_after_inbound, 0) as failed_after_inbound,
       sq.pending_count, sq.next_pending_at, sq.failed_internal_after_inbound, sq.failed_provider_after_inbound, sq.held_after_inbound,
       exists (select 1 from public.sms_suppression_list s where s.phone_e164 = thr.canonical_e164 and coalesce(s.is_active, true)) as suppression_listed,
       op.opportunity_id, op.opp_stage, op.opp_status, op.opp_temperature, op.opp_priority, op.opp_next_action, op.opp_next_action_due,
       op.opp_promotion_reason, op.opp_asking_price, op.opp_current_offer, op.opp_stage_entered_at, op.opp_last_activity_at,
       coalesce(so.offers_sent, 0) as offers_sent, so.last_offer_at,
       (op.opportunity_id is not null and exists (
          select 1 from public.closing_cases c
           where c.opportunity_id = op.opportunity_id::uuid
             and lower(coalesce(c.closing_status, '')) not in ('cancelled', 'canceled', 'voided', 'void', 'terminated', 'dead')
             and lower(coalesce(c.contract_status, '')) not in ('cancelled', 'canceled', 'voided', 'void', 'terminated', 'dead'))) as live_closing_case,
       coalesce(fu.followups_active, 0) as followups_active, fu.followup_next_at,
       pas.pas_id, pas.pas_computed_at, pas.valuation_mid, pas.investor_ceiling_mid, pas.investor_ceiling_high,
       pas.minimum_acceptable_offer, pas.recommended_cash_offer, pas.buyer_demand_score
  from thr
  left join lateral (
    select count(*)::int as inbound_count,
           min(coalesce(m.event_timestamp, m.received_at, m.created_at)) as first_inbound_at,
           coalesce(bool_or(coalesce(m.is_opt_out, false) or m.detected_intent = 'opt_out'), false) as any_opt_out,
           coalesce(array_agg(distinct m.detected_intent) filter (where coalesce(m.detected_intent, '') <> ''), array[]::text[]) as inbound_intents
      from public.message_events m
     where m.thread_key = thr.thread_key and m.direction = 'inbound'
  ) ev on true
  left join lateral (
    select m.id::text as last_inbound_id, coalesce(m.event_timestamp, m.received_at, m.created_at) as last_inbound_at,
           nullif(m.detected_intent, '') as last_inbound_intent, coalesce(m.is_opt_out, false) as last_inbound_opt_out,
           nullif(m.language, '') as last_inbound_language
      from public.message_events m
     where m.thread_key = thr.thread_key and m.direction = 'inbound'
     order by coalesce(m.event_timestamp, m.received_at, m.created_at) desc, m.id desc
     limit 1
  ) li on true
  left join lateral (
    select m.id::text as last_meaningful_id, coalesce(m.event_timestamp, m.received_at, m.created_at) as last_meaningful_at,
           nullif(m.detected_intent, '') as last_meaningful_intent
      from public.message_events m
     where m.thread_key = thr.thread_key and m.direction = 'inbound'
       and coalesce(m.detected_intent, '') not in (${q(NON_MEANINGFUL_INTENTS)})
     order by coalesce(m.event_timestamp, m.received_at, m.created_at) desc, m.id desc
     limit 1
  ) lm on true
  left join lateral (
    select m.id::text as last_outbound_id, coalesce(m.event_timestamp, m.sent_at, m.created_at) as last_outbound_at,
           lower(coalesce(nullif(m.delivery_status, ''), nullif(m.provider_delivery_status, ''), '')) as last_outbound_delivery,
           (coalesce(m.auto_reply_status, '') <> '') as last_outbound_auto
      from public.message_events m
     where m.thread_key = thr.thread_key and m.direction = 'outbound'
     order by coalesce(m.event_timestamp, m.sent_at, m.created_at) desc, m.id desc
     limit 1
  ) lo on true
  left join lateral (
    select count(*)::int as outbound_after_inbound,
           count(*) filter (where m.delivered_at is not null or lower(coalesce(m.delivery_status, '')) = 'delivered')::int as delivered_after_inbound,
           count(*) filter (where coalesce(m.is_final_failure, false) or lower(coalesce(m.delivery_status, '')) in ('failed', 'undelivered'))::int as failed_after_inbound
      from public.message_events m
     where m.thread_key = thr.thread_key and m.direction = 'outbound'
       and coalesce(m.event_timestamp, m.sent_at, m.created_at) > li.last_inbound_at
  ) oa on true
  left join lateral (
    select count(*) filter (where lower(q.queue_status) in (${q(PENDING_QUEUE_STATUSES)}))::int as pending_count,
           min(coalesce(q.scheduled_for_utc, q.scheduled_for)) filter (where lower(q.queue_status) in (${q(PENDING_QUEUE_STATUSES)})) as next_pending_at,
           count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport') and q.created_at > li.last_inbound_at and q.provider_message_id is null)::int as failed_internal_after_inbound,
           count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport') and q.created_at > li.last_inbound_at and q.provider_message_id is not null)::int as failed_provider_after_inbound,
           count(*) filter (where (lower(q.queue_status) like 'blocked%' or lower(q.queue_status) like 'paused%' or lower(q.queue_status) = 'duplicate_blocked') and q.created_at > li.last_inbound_at)::int as held_after_inbound
      from public.send_queue q
     where q.thread_key = thr.thread_key
  ) sq on true
  left join lateral (
    select o.id::text as opportunity_id, o.acquisition_stage as opp_stage, o.opportunity_status as opp_status, o.temperature as opp_temperature,
           o.priority as opp_priority, nullif(btrim(o.next_action), '') as opp_next_action, o.next_action_due as opp_next_action_due,
           nullif(btrim(o.promotion_reason), '') as opp_promotion_reason, o.asking_price as opp_asking_price, o.current_offer as opp_current_offer,
           o.stage_entered_at as opp_stage_entered_at, o.last_activity_at as opp_last_activity_at
      from public.acquisition_opportunities o
     where o.primary_thread_key = thr.thread_key
     order by (lower(coalesce(o.opportunity_status, '')) in ('active', 'nurture')) desc, o.updated_at desc nulls last
     limit 1
  ) op on true
  left join lateral (
    select count(*) filter (where s.sent_at is not null and lower(coalesce(s.status, '')) in ('active', 'accepted', 'sent', 'superseded'))::int as offers_sent,
           max(s.sent_at) as last_offer_at
      from public.seller_offers s
     where s.thread_key = thr.thread_key
  ) so on true
  left join lateral (
    select count(*)::int as followups_active, min(f.next_follow_up_at) as followup_next_at
      from public.seller_followup_state f
     where f.thread_key = thr.thread_key and f.resolved_at is null and f.status in ('active', 'due')
  ) fu on true
  left join lateral (
    select p.id::text as pas_id, p.computed_at as pas_computed_at, p.valuation_mid, p.investor_ceiling_mid, p.investor_ceiling_high,
           p.minimum_acceptable_offer, p.recommended_cash_offer, p.buyer_demand_score
      from public.property_acquisition_scores p
     where thr.property_id is not null and p.property_id = thr.property_id
     order by p.computed_at desc nulls last
     limit 1
  ) pas on true
 order by thr.cursor_at, thr.id`

// $1 after_id uuid | null, $2 limit
export const PIPELINE_FACTS_SQL = `
select o.id::text as opportunity_id, o.acquisition_stage, o.opportunity_status, o.priority, o.temperature,
       nullif(btrim(o.next_action), '') as next_action, o.next_action_due, nullif(btrim(o.promotion_reason), '') as promotion_reason,
       nullif(btrim(o.blocker), '') as blocker, o.asking_price, o.current_offer, o.estimated_value, o.arv,
       o.stage_entered_at, o.last_activity_at, o.last_contact_at, o.updated_at, o.created_at, o.primary_property_id as property_id,
       o.market, o.approval_state, (nullif(btrim(o.assigned_operator), '') is not null) as has_assigned_operator, o.latest_intent,
       t.id::text as conversation_id, t.seller_stage as thread_stage, t.last_inbound_at as thread_last_inbound_at,
       t.last_outbound_at as thread_last_outbound_at, coalesce(t.is_suppressed, false) as thread_suppressed,
       t.contactability_status as thread_contactability,
       coalesce(so.offers, '[]'::jsonb) as offer_rows,
       exists (select 1 from public.closing_cases c
                where c.opportunity_id = o.id
                  and lower(coalesce(c.closing_status, '')) not in ('cancelled', 'canceled', 'voided', 'void', 'terminated', 'dead')
                  and lower(coalesce(c.contract_status, '')) not in ('cancelled', 'canceled', 'voided', 'void', 'terminated', 'dead')) as live_closing_case,
       pas.pas_id, pas.pas_computed_at
  from public.acquisition_opportunities o
  left join public.inbox_thread_state t on t.thread_key = o.primary_thread_key
  left join lateral (
    select jsonb_agg(jsonb_build_object('offer_id', s.id::text, 'status', s.status, 'sent_at', s.sent_at, 'purchase_price', s.purchase_price,
             'policy_version', s.policy_version, 'ade_snapshot_id', s.ade_snapshot_id, 'valuation_mid', s.valuation_mid,
             'authorized_ceiling', s.authorized_ceiling, 'offer_event', s.metadata -> 'offer_event') order by s.created_at desc) as offers
      from (select * from public.seller_offers s0 where s0.opportunity_id = o.id order by s0.created_at desc limit 20) s
  ) so on true
  left join lateral (
    select p.id::text as pas_id, p.computed_at as pas_computed_at
      from public.property_acquisition_scores p
     where o.primary_property_id is not null and p.property_id = o.primary_property_id
     order by p.computed_at desc nulls last
     limit 1
  ) pas on true
 where lower(coalesce(o.opportunity_status, '')) in ('active', 'nurture')
   and ($1::uuid is null or o.id > $1::uuid)
 order by o.id
 limit least(greatest(coalesce($2::int, 200), 1), 500)`

// $1 now | null — one row; every section is an aggregate (no row-level PII).
export const SUPERVISOR_SNAPSHOT_SQL = `
with p as (select coalesce($1::timestamptz, now()) as now),
q24 as (
  select count(*)::int as created,
         count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport'))::int as failed,
         count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport') and q.provider_message_id is null)::int as failed_internal,
         count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport') and q.provider_message_id is not null)::int as failed_provider,
         count(*) filter (where lower(q.queue_status) like 'blocked%' or lower(q.queue_status) = 'duplicate_blocked')::int as blocked,
         count(*) filter (where lower(q.queue_status) like 'paused%')::int as paused,
         count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport') and lower(coalesce(q.message_type, '')) in (${q(FOLLOWUP_MESSAGE_TYPES)}))::int as followups_failed
    from public.send_queue q, p
   where q.created_at >= p.now - interval '24 hours'
),
qreasons as (
  select coalesce(jsonb_agg(jsonb_build_object('reason', r, 'count', n) order by n desc), '[]'::jsonb) as top
    from (select regexp_replace(lower(left(coalesce(nullif(q.failed_reason, ''), q.queue_status, 'unknown'), 40)), '[0-9]', '#', 'g') as r, count(*)::int as n
            from public.send_queue q, p
           where q.created_at >= p.now - interval '24 hours' and lower(q.queue_status) in ('failed', 'failed_transport')
           group by 1 order by 2 desc limit 5) x
),
overdue as (
  select count(*)::int as n from (
    select 1 from public.send_queue q, p
     where lower(q.queue_status) in (${q(PENDING_QUEUE_STATUSES)})
       and coalesce(q.scheduled_for_utc, q.scheduled_for) < p.now - interval '15 minutes'
     limit 1000) s
),
del as (
  select count(*) filter (where q.sent_at >= p.now - interval '24 hours')::int as sent_24h,
         count(*) filter (where q.sent_at >= p.now - interval '24 hours' and (q.delivered_at is not null or lower(q.queue_status) = 'delivered'))::int as delivered_24h,
         count(*) filter (where q.sent_at >= p.now - interval '24 hours' and lower(q.queue_status) in ('failed', 'failed_transport', 'undelivered'))::int as failed_24h,
         count(*) filter (where q.sent_at >= p.now - interval '7 days')::int as sent_7d,
         count(*) filter (where q.sent_at >= p.now - interval '7 days' and (q.delivered_at is not null or lower(q.queue_status) = 'delivered'))::int as delivered_7d,
         count(*) filter (where q.sent_at >= p.now - interval '7 days' and lower(q.queue_status) in ('failed', 'failed_transport', 'undelivered'))::int as failed_7d,
         count(*) filter (where q.sent_at < p.now - interval '7 days')::int as sent_prev_7d,
         count(*) filter (where q.sent_at < p.now - interval '7 days' and (q.delivered_at is not null or lower(q.queue_status) = 'delivered'))::int as delivered_prev_7d
    from public.send_queue q, p
   where q.sent_at >= p.now - interval '14 days' and q.sent_at <= p.now
),
inb as (
  select count(*) filter (where coalesce(m.event_timestamp, m.created_at) >= p.now - interval '7 days')::int as inbound_7d,
         count(*) filter (where coalesce(m.event_timestamp, m.created_at) < p.now - interval '7 days')::int as inbound_prev_7d,
         count(*) filter (where coalesce(m.event_timestamp, m.created_at) >= p.now - interval '7 days' and (coalesce(m.is_opt_out, false) or m.detected_intent = 'opt_out'))::int as opt_out_7d,
         count(*) filter (where coalesce(m.event_timestamp, m.created_at) < p.now - interval '7 days' and (coalesce(m.is_opt_out, false) or m.detected_intent = 'opt_out'))::int as opt_out_prev_7d,
         count(*) filter (where coalesce(m.event_timestamp, m.created_at) >= p.now - interval '7 days' and m.detected_intent in (${q(QUALIFIED_INTENTS)}))::int as qualified_7d
    from public.message_events m, p
   where m.direction = 'inbound' and coalesce(m.event_timestamp, m.created_at) >= p.now - interval '14 days'
     and coalesce(m.event_timestamp, m.created_at) <= p.now
),
senders as (
  select count(*)::int as numbers,
         count(*) filter (where lower(coalesce(n.status, '')) = 'active')::int as active,
         count(*) filter (where n.cooling_until is not null and n.cooling_until > p.now)::int as cooling,
         count(*) filter (where n.spam_flagged_at is not null)::int as spam_flagged
    from public.textgrid_numbers n, p
),
sender_health as (
  select coalesce(jsonb_object_agg(h, c), '{}'::jsonb) as by_health_state
    from (select coalesce(nullif(n.health_state, ''), 'unknown') as h, count(*)::int as c from public.textgrid_numbers n group by 1) x
),
sender_rates as (
  select coalesce(jsonb_agg(jsonb_build_object('sender_id', sender_id, 'health_state', health_state, 'sent_7d', sent, 'failed_7d', failed, 'delivered_7d', delivered) order by sent desc), '[]'::jsonb) as rows,
         coalesce(sum(sent) filter (where sender_id is null), 0)::int as unmatched_sent
    from (select n.id::text as sender_id, n.health_state, count(*)::int as sent,
                 count(*) filter (where lower(q.queue_status) in ('failed', 'failed_transport', 'undelivered'))::int as failed,
                 count(*) filter (where q.delivered_at is not null or lower(q.queue_status) = 'delivered')::int as delivered
            from public.send_queue q cross join p
            left join public.textgrid_numbers n on n.phone_number = q.from_phone_number
           where q.sent_at >= p.now - interval '7 days' and q.sent_at <= p.now
           group by 1, 2 order by 3 desc limit 40) x
),
campaigns as (
  select coalesce(jsonb_agg(jsonb_build_object('campaign_id', campaign_id, 'status', status, 'delivered', delivered, 'threads', threads, 'replied_threads', replied, 'qualified_threads', qualified) order by delivered desc), '[]'::jsonb) as rows
    from (select q.campaign_id::text as campaign_id, c.status,
                 count(*) filter (where q.delivered_at is not null or lower(q.queue_status) = 'delivered')::int as delivered,
                 count(distinct q.thread_key) filter (where q.delivered_at is not null or lower(q.queue_status) = 'delivered')::int as threads,
                 count(distinct q.thread_key) filter (where exists (select 1 from public.message_events m where m.thread_key = q.thread_key and m.direction = 'inbound' and coalesce(m.event_timestamp, m.created_at) > q.sent_at))::int as replied,
                 count(distinct q.thread_key) filter (where exists (select 1 from public.message_events m where m.thread_key = q.thread_key and m.direction = 'inbound' and coalesce(m.event_timestamp, m.created_at) > q.sent_at and m.detected_intent in (${q(QUALIFIED_INTENTS)})))::int as qualified
            from public.send_queue q cross join p
            left join public.campaigns c on c.id = q.campaign_id
           where q.campaign_id is not null and q.sent_at >= p.now - interval '30 days' and q.sent_at <= p.now
           group by 1, 2 order by 3 desc limit 20) x
),
revenue as (
  select count(*) filter (where c.confirmed_gross_revenue is not null)::int as closings_with_revenue,
         count(*)::int as closing_cases,
         coalesce(sum(c.confirmed_gross_revenue), 0) as confirmed_gross_revenue
    from public.closing_cases c
),
pipe as (
  select count(*)::int as live,
         count(*) filter (where o.stage_entered_at is null or o.stage_entered_at < p.now - interval '14 days')::int as stagnant_14d,
         count(*) filter (where nullif(btrim(o.next_action), '') is null)::int as missing_next_action,
         count(*) filter (where o.next_action_due is null)::int as missing_due,
         count(*) filter (where o.next_action_due < p.now)::int as overdue,
         count(*) filter (where lower(coalesce(o.temperature, '')) = 'hot')::int as hot,
         count(*) filter (where lower(coalesce(o.temperature, '')) = 'hot' and (o.next_action_due is null or o.next_action_due < p.now))::int as hot_without_current_action,
         count(*) filter (where o.primary_property_id is not null and not exists (select 1 from public.property_acquisition_scores s where s.property_id = o.primary_property_id))::int as missing_valuation,
         count(*) filter (where o.acquisition_stage in ('asking_price', 'property_condition', 'offer'))::int as negotiations,
         count(*) filter (where o.acquisition_stage in ('asking_price', 'property_condition', 'offer') and (o.last_activity_at is null or o.last_activity_at < p.now - interval '7 days'))::int as negotiations_stalled_7d
    from public.acquisition_opportunities o, p
   where lower(coalesce(o.opportunity_status, '')) in ('active', 'nurture')
),
pipe_stage as (
  select coalesce(jsonb_object_agg(stage, jsonb_build_object('live', n, 'stagnant_14d', st)), '{}'::jsonb) as by_stage
    from (select coalesce(o.acquisition_stage, 'unknown') as stage, count(*)::int as n,
                 count(*) filter (where o.stage_entered_at is null or o.stage_entered_at < p.now - interval '14 days')::int as st
            from public.acquisition_opportunities o, p
           where lower(coalesce(o.opportunity_status, '')) in ('active', 'nurture') group by 1) x
),
fups as (
  select count(*) filter (where t.follow_up_at < p.now and not exists (
            select 1 from public.send_queue q where q.thread_key = t.thread_key and lower(q.queue_status) in (${q(PENDING_QUEUE_STATUSES)})))::int as expired_followup_dates,
         count(*) filter (where t.follow_up_at >= p.now)::int as scheduled_followup_dates
    from public.inbox_thread_state t, p
   where t.follow_up_at is not null and not coalesce(t.is_suppressed, false)
     and coalesce(t.contactability_status, 'contactable') not in ('opted_out', 'do_not_text', 'do_not_contact', 'invalid_number')
),
fstate as (
  select count(*) filter (where f.next_follow_up_at < p.now)::int as due, count(*)::int as active
    from public.seller_followup_state f, p
   where f.resolved_at is null and f.status in ('active', 'due')
),
hot_threads as (
  select count(*)::int as n from public.inbox_thread_state t where coalesce(t.is_hot_lead, false) and not coalesce(t.is_suppressed, false)
)
select p.now as at,
       to_jsonb(q24) || jsonb_build_object('top_failure_reasons', qreasons.top, 'overdue_pending', overdue.n) as queue,
       to_jsonb(del) as delivery,
       to_jsonb(inb) as inbound,
       to_jsonb(senders) || jsonb_build_object('by_health_state', sender_health.by_health_state, 'rates_7d', sender_rates.rows, 'unmatched_sent_7d', sender_rates.unmatched_sent) as senders,
       campaigns.rows as campaigns_30d,
       to_jsonb(revenue) as revenue,
       to_jsonb(pipe) || jsonb_build_object('by_stage', pipe_stage.by_stage) as pipeline,
       to_jsonb(fups) || jsonb_build_object('followup_state_due', fstate.due, 'followup_state_active', fstate.active) as followups,
       hot_threads.n as hot_threads
  from p, q24, qreasons, overdue, del, inb, senders, sender_health, sender_rates, campaigns, revenue, pipe, pipe_stage, fups, fstate, hot_threads`

// $1 since, $2 until — the daily brief's public-schema facts (ids only, ≤ 20 each).
export const BRIEF_FACTS_SQL = `
with w as (select $1::timestamptz as since, coalesce($2::timestamptz, now()) as until),
offers as (
  select count(*)::int as n, coalesce(jsonb_agg(id) filter (where rn <= 20), '[]'::jsonb) as record_ids
    from (select s.id::text as id, row_number() over (order by s.created_at desc) as rn
            from public.seller_offers s, w where s.created_at >= w.since and s.created_at < w.until) x
),
offers_sent as (
  select count(*)::int as n from public.seller_offers s, w where s.sent_at >= w.since and s.sent_at < w.until
),
advanced as (
  select count(*)::int as n, coalesce(jsonb_agg(jsonb_build_object('opportunity_id', opportunity_id, 'from', previous_value, 'to', new_value)) filter (where rn <= 20), '[]'::jsonb) as rows
    from (select h.opportunity_id::text as opportunity_id, h.previous_value, h.new_value, row_number() over (order by h.created_at desc) as rn
            from public.acquisition_opportunity_history h, w
           where h.field_name = 'acquisition_stage' and h.created_at >= w.since and h.created_at < w.until
             and h.new_value in ('asking_price', 'property_condition', 'offer', 'formal_contract', 'disposition', 'under_contract', 'prepared_to_close')) x
),
followups as (
  select count(*)::int as n, coalesce(jsonb_agg(id) filter (where rn <= 20), '[]'::jsonb) as record_ids
    from (select q.id::text as id, row_number() over (order by q.delivered_at desc) as rn
            from public.send_queue q, w
           where q.delivered_at >= w.since and q.delivered_at < w.until
             and lower(coalesce(q.message_type, '')) in (${q(FOLLOWUP_MESSAGE_TYPES)})) x
),
campaign_changes as (
  select count(*)::int as n, coalesce(jsonb_agg(jsonb_build_object('campaign_id', id, 'status', status, 'from', last_transition_from)) filter (where rn <= 20), '[]'::jsonb) as rows
    from (select c.id::text as id, c.status, c.last_transition_from, row_number() over (order by c.last_transition_at desc) as rn
            from public.campaigns c, w where c.last_transition_at >= w.since and c.last_transition_at < w.until) x
),
sender_changes as (
  select count(*)::int as n, coalesce(jsonb_agg(jsonb_build_object('sender_id', id, 'health_state', health_state)) filter (where rn <= 20), '[]'::jsonb) as rows
    from (select n.id::text as id, n.health_state, row_number() over (order by n.health_changed_at desc) as rn
            from public.textgrid_numbers n, w where n.health_changed_at >= w.since and n.health_changed_at < w.until) x
),
inbound as (
  select count(*)::int as n,
         count(*) filter (where m.detected_intent in (${q(QUALIFIED_INTENTS)}))::int as qualified
    from public.message_events m, w
   where m.direction = 'inbound' and coalesce(m.event_timestamp, m.created_at) >= w.since and coalesce(m.event_timestamp, m.created_at) < w.until
)
select w.since, w.until,
       jsonb_build_object('count', offers.n, 'record_ids', offers.record_ids, 'sent', offers_sent.n) as offers_prepared,
       jsonb_build_object('count', advanced.n, 'rows', advanced.rows) as negotiations_advanced,
       jsonb_build_object('count', followups.n, 'record_ids', followups.record_ids) as followups_completed,
       jsonb_build_object('count', campaign_changes.n, 'rows', campaign_changes.rows) as campaign_changes,
       jsonb_build_object('count', sender_changes.n, 'rows', sender_changes.rows) as sender_changes,
       jsonb_build_object('count', inbound.n, 'qualified', inbound.qualified) as inbound
  from w, offers, offers_sent, advanced, followups, campaign_changes, sender_changes, inbound`

export const OPERATIONS_SQL = Object.freeze({
  conversation_facts: CONVERSATION_FACTS_SQL,
  pipeline_facts: PIPELINE_FACTS_SQL,
  supervisor_snapshot: SUPERVISOR_SNAPSHOT_SQL,
  brief_facts: BRIEF_FACTS_SQL,
})

/** Whitespace-normalized text (the drift test compares the migration bodies with this). */
export const normalizeSql = (s) => String(s).replace(/\s+/g, ' ').trim()
