// 8.5.20 part C test fixtures: raw rows in the exact shapes of operations-sql.js
// (CONVERSATION_FACTS_SQL / PIPELINE_FACTS_SQL / SUPERVISOR_SNAPSHOT_SQL / BRIEF_FACTS_SQL).
// Synthetic ids only; no real phone, name or address.
export const T0 = Date.parse('2026-10-15T15:00:00Z')
export const H = 3_600_000
export const D = 86_400_000
export const at = (ms) => new Date(ms).toISOString()

let seq = 0
export const uuid = (n = ++seq) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** A conversation where the seller said they are interested and we answered (inside the reply window). */
export function conv(o = {}) {
  const id = o.conversation_id || uuid()
  const li = o.last_inbound_id || uuid()
  return {
    conversation_id: id, cursor_at: at(T0 - 2 * H), property_id: '2124415662', market: 'Dallas, TX',
    seller_stage: 'offer_interest', disposition: null, contactability_status: 'contactable', is_suppressed: false, is_archived: false, archive_reason: null,
    is_read: false, inbox_bucket: 'new_replies', operational_status: 'active_communication', lead_temperature: 'warm', is_hot_lead: false, last_intent: 'seller_interested',
    next_action: null, next_action_at: null, follow_up_at: null, snoozed_until: null, manual_override: false,
    inbound_count: 2, first_inbound_at: at(T0 - 3 * D), any_opt_out: false, inbound_intents: ['ownership_confirmed', 'seller_interested'],
    last_inbound_id: li, last_inbound_at: at(T0 - 5 * H), last_inbound_intent: 'seller_interested', last_inbound_opt_out: false, last_inbound_language: 'english',
    last_meaningful_id: li, last_meaningful_at: at(T0 - 5 * H), last_meaningful_intent: 'seller_interested',
    last_outbound_id: uuid(), last_outbound_at: at(T0 - 4 * H), last_outbound_delivery: 'delivered', last_outbound_auto: true,
    outbound_after_inbound: 1, delivered_after_inbound: 1, failed_after_inbound: 0,
    pending_count: 0, next_pending_at: null, failed_internal_after_inbound: 0, failed_provider_after_inbound: 0, held_after_inbound: 0,
    suppression_listed: false,
    opportunity_id: null, opp_stage: null, opp_status: null, opp_temperature: null, opp_priority: null, opp_next_action: null, opp_next_action_due: null,
    opp_promotion_reason: null, opp_asking_price: null, opp_current_offer: null, opp_stage_entered_at: null, opp_last_activity_at: null,
    offers_sent: 0, last_offer_at: null, live_closing_case: false, followups_active: 0, followup_next_at: null,
    pas_id: null, pas_computed_at: null, valuation_mid: null, investor_ceiling_mid: null, investor_ceiling_high: null, minimum_acceptable_offer: null, recommended_cash_offer: null, buyer_demand_score: null,
    ...o,
  }
}
/** The seller wrote last (meaningful) and nobody answered. */
export const waiting = (o = {}) => conv({ last_outbound_at: at(T0 - 6 * H), outbound_after_inbound: 0, delivered_after_inbound: 0, ...o })

export function opp(o = {}) {
  return {
    opportunity_id: o.opportunity_id || uuid(), acquisition_stage: 'asking_price', opportunity_status: 'active', priority: 'high', temperature: 'warm',
    next_action: 'Ask about condition', next_action_due: at(T0 + D), promotion_reason: 'asking_price_provided', blocker: null,
    asking_price: 180000, current_offer: null, estimated_value: 240000, arv: 280000, stage_entered_at: at(T0 - 2 * D), last_activity_at: at(T0 - D),
    last_contact_at: at(T0 - D), updated_at: at(T0 - D), created_at: at(T0 - 10 * D), property_id: '2124415662', market: 'Dallas, TX', approval_state: null,
    has_assigned_operator: false, latest_intent: 'asking_price_provided', conversation_id: uuid(), thread_stage: 'asking_price', thread_last_inbound_at: at(T0 - D),
    thread_last_outbound_at: at(T0 - D), thread_suppressed: false, thread_contactability: 'contactable', offer_rows: [], live_closing_case: false,
    pas_id: uuid(), pas_computed_at: at(T0 - 3 * D), ...o,
  }
}

export function snapshot(o = {}) {
  return {
    at: at(T0),
    queue: { created: 120, failed: 0, failed_internal: 0, failed_provider: 0, blocked: 0, paused: 0, followups_failed: 0, top_failure_reasons: [], overdue_pending: 0, ...(o.queue || {}) },
    delivery: { sent_24h: 200, delivered_24h: 190, failed_24h: 5, sent_7d: 1400, delivered_7d: 1330, failed_7d: 40, sent_prev_7d: 1500, delivered_prev_7d: 1420, ...(o.delivery || {}) },
    inbound: { inbound_7d: 140, inbound_prev_7d: 150, opt_out_7d: 10, opt_out_prev_7d: 11, qualified_7d: 12, ...(o.inbound || {}) },
    senders: { numbers: 10, active: 10, cooling: 0, spam_flagged: 0, by_health_state: { healthy: 10 }, rates_7d: [{ sender_id: uuid(), health_state: 'healthy', sent_7d: 300, failed_7d: 6, delivered_7d: 290 }], unmatched_sent_7d: 0, ...(o.senders || {}) },
    campaigns_30d: o.campaigns_30d || [{ campaign_id: uuid(), status: 'active', delivered: 900, threads: 880, replied_threads: 60, qualified_threads: 9 }],
    revenue: { closings_with_revenue: 0, closing_cases: 0, confirmed_gross_revenue: 0, ...(o.revenue || {}) },
    pipeline: { live: 40, stagnant_14d: 0, missing_next_action: 0, missing_due: 0, overdue: 0, hot: 2, hot_without_current_action: 0, missing_valuation: 0, negotiations: 6, negotiations_stalled_7d: 0, by_stage: {}, ...(o.pipeline || {}) },
    followups: { expired_followup_dates: 0, scheduled_followup_dates: 20, followup_state_due: 0, followup_state_active: 0, ...(o.followups || {}) },
    hot_threads: 3,
  }
}

export const health = (o = {}) => ({
  at: at(T0),
  keys: { queue_processor_heartbeat_at: at(T0 - 60_000), campaign_feeder_heartbeat_at: at(T0 - 120_000), followup_no_response_heartbeat_at: at(T0 - 600_000), seller_state_reconcile_heartbeat_at: at(T0 - 120_000), webhook_delivery_recovery_last_at: at(T0 - 120_000), queue_processor_mode: 'live', ...(o.keys || {}) },
  deliveries: { last_delivered_at: at(T0 - 700_000) },
  queue: {},
})

export const briefFacts = (o = {}) => ({
  since: at(T0 - D), until: at(T0),
  offers_prepared: { count: 1, record_ids: [uuid()], sent: 0 },
  negotiations_advanced: { count: 1, rows: [{ opportunity_id: uuid(), from: 'offer_interest', to: 'asking_price' }] },
  followups_completed: { count: 2, record_ids: [uuid(), uuid()] },
  campaign_changes: { count: 0, rows: [] },
  sender_changes: { count: 1, rows: [{ sender_id: uuid(), health_state: 'cooling' }] },
  inbound: { count: 12, qualified: 2 },
  ...o,
})
