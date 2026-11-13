// Production-shaped fixtures for the Workforce engine tests: deal-context rows (with REAL-looking
// thread keys, so a leak would be caught by the fake store's contact refusal), Decision Engine rows,
// action states, holds and suppression — and stubbed services with the SAME signatures the wiring
// binds (lib/ai/workforce-runtime-wiring.js createWorkforceReadServices). No network, no provider.
import { encodePropertyRef } from '../../src/lib/agent/missions/mission-codec.js'

export const T0 = Date.parse('2026-10-21T15:00:00.000Z')
export const DAY = 86_400_000
export const OWNER = '11111111-1111-4111-8111-111111111111'
export const OPERATOR = '22222222-2222-4222-8222-222222222222'
export const ORG = '00000000-0000-4000-8000-00000000a001'
export const HARTFORD = Object.freeze({ property_id: '225438557', opportunity_id: '9b690ce3-ff88-400b-b56e-69e9bd0055b0', conversation_id: '596a9368-6ef8-40f8-97cb-fcc46e6672d3' })
export const MAXWELL = Object.freeze({ property_id: '251027062', opportunity_id: '47da7121-c39d-425a-b608-046750e35027', conversation_id: '58d05df2-561d-4c9e-9226-ab3de105d773' })

const hex = (n, w) => n.toString(16).padStart(w, '0')
export const uuidN = (n, p = 'a') => `${hex(n, 8)}-${p.repeat(4)}-4${hex(n, 3)}-8${hex(n, 3)}-${hex(n, 12)}`

/** A Decision Engine row (property_acquisition_scores shape) the real predicates accept or reject. */
export function makeScore({ property_id, tier = 'AUTO_HARD_OFFER', value = 250_000, offer = 160_000, mao = 175_000, repairs = 30_000, comps = 6, compAgeMonths = 4, computedDaysAgo = 3, confidence = 0.78, fee = 15_000, identityConflict = false, now = T0 } = {}) {
  const sale = new Date(now - compAgeMonths * 30.44 * DAY).toISOString().slice(0, 10)
  return {
    property_id: String(property_id), decision_tier: tier, recommended_cash_offer: offer, minimum_acceptable_offer: offer ? offer - 10_000 : null, expected_assignment_fee: fee,
    valuation_low: value * 0.9, valuation_mid: value, valuation_high: value * 1.1, valuation_confidence: confidence, estimated_repairs: repairs, comp_count: comps, confidence, aos_score: 70,
    computed_at: new Date(now - computedDaysAgo * DAY).toISOString(),
    evidence: {
      offer_calculation: { effective_authorized_ceiling: mao },
      selected_comps: Array.from({ length: comps }, (_, i) => ({ comp_id: `c${i}`, sale_date: sale, distance_miles: 0.4 + i * 0.1 })),
      valuation_calculation_summary: { dispersion_ratio: 0.12 },
      subject: { asset_identity_conflict: identityConflict },
    },
  }
}

/**
 * One opportunity spec → everything the services return for it.
 * @param {number} i
 * @param {object} o  overrides: market, stage, seller_spoke_last, intent, score (object|null), ask, action_state, suppressed, held, …
 */
export function opp(i, o = {}) {
  const property_id = o.property_id || String(700_000_000 + i)
  return {
    property_id,
    property_ref: encodePropertyRef(property_id),
    thread_key: o.thread_key || `+1214555${String(1000 + i).slice(-4)}`,
    conversation_id: o.conversation_id || uuidN(i, 'c'),
    opportunity_id: o.opportunity_id || uuidN(i, 'b'),
    market: o.market || 'Dallas',
    stage: o.stage || 'asking_price',
    status: o.status || 'active',
    seller_spoke_last: o.seller_spoke_last ?? (i % 2 === 0),
    intent: o.intent ?? (i % 3 === 0 ? 'asks_offer' : 'seller_interested'),
    last_inbound_at: o.last_inbound_at || new Date(T0 - (i + 1) * 3_600_000).toISOString(),
    last_outbound_at: o.last_outbound_at || new Date(T0 - (i + 2) * 3_600_000).toISOString(),
    score: o.score === undefined ? makeScore({ property_id }) : o.score,
    ask: o.ask === undefined ? 190_000 : o.ask,
    action_state: o.action_state || (o.seller_spoke_last ?? (i % 2 === 0) ? 'needs_attention' : 'waiting_on_seller'),
    verified_stage: o.verified_stage || o.stage || 'asking_price',
    suppressed: o.suppressed === true,
    held: o.held === true,
    suppression_status: o.suppression_status || null,
  }
}

/** The stubbed read services (the wiring's names and signatures). `calls` counts every call. */
export function makeServices(opps, { calls = {}, fail = {}, holdsFail = false, researchEnabled = true, calibration = null } = {}) {
  const by = new Map(opps.map((x) => [x.property_id, x]))
  const byThread = new Map(opps.map((x) => [x.thread_key, x]))
  const hit = (k) => { calls[k] = (calls[k] || 0) + 1; if (fail[k]) throw Object.assign(new Error(`${k} failed`), { code: 'SOURCE_UNAVAILABLE' }) }
  const row = (x) => ({
    property_id: x.property_id, thread_key: x.thread_key, market: x.market, universal_stage: x.stage, universal_status: x.status, suppression_status: x.suppression_status,
    latest_message_direction: x.seller_spoke_last ? 'inbound' : 'outbound', last_intent: x.intent, opportunity_id: x.opportunity_id, inbox_thread_id: x.conversation_id,
    last_inbound_at: x.last_inbound_at, last_outbound_at: x.last_outbound_at, acquisition_decision: x.score ? { computed_at: x.score.computed_at } : null,
    canonical_e164: x.thread_key, best_phone: x.thread_key, owner_name: `Owner ${x.property_id}`, thread_state_data: { id: x.conversation_id, is_suppressed: x.suppressed },
  })
  return {
    calls,
    async listDealContexts(params = {}) { hit('listDealContexts'); return { rows: opps.filter((x) => !params.market || x.market === params.market).map(row), total: opps.length } },
    async getDealContextByProperty(id) { hit('getDealContextByProperty'); const x = by.get(String(id)); return x ? row(x) : null },
    async getPipelineCommandOverview() { hit('getPipelineCommandOverview'); return { generatedAt: new Date(T0).toISOString(), totals: { opportunities: opps.length, working: opps.length - 1, dormant: 1, stalled: 2, attention: 3, offersOut: 0, needsYou: 3, blocked: 0 }, stages: [{ code: 'asking_price', count: opps.length, stalled: 2, dormant: 1, attention: 3 }], stalled: { by: { seller_silent: 2 } } } },
    async loadThreadContext({ thread_key }) {
      hit('loadThreadContext')
      const x = byThread.get(thread_key)
      if (!x) return { thread_key, context: { selected_thread: { message_events: [] } } }
      return { thread_key, context: { selected_thread: { message_events: [
        { direction: 'inbound', event_timestamp: x.last_inbound_at, message_body: 'call me at 214-555-0199', from_phone_number: x.thread_key },
        { direction: 'outbound', event_timestamp: x.last_outbound_at, message_body: 'Hi, is this the owner?', to_phone_number: x.thread_key },
      ] } } }
    },
    async getDealDecision({ propertyId }) {
      hit('getDealDecision')
      const x = by.get(String(propertyId))
      if (!x) return null
      return { decision: x.score ? { status: 'available', tier: x.score.decision_tier, confidence: x.score.confidence, computedAt: x.score.computed_at } : { status: 'not_run' }, offer: { negotiation: { ask: x.ask } }, contact: { phone: x.thread_key } }
    },
    async loadAcquisitionScore({ property_id }) { hit('loadAcquisitionScore'); return by.get(String(property_id))?.score ?? null },
    async listActiveHolds() {
      hit('listActiveHolds')
      if (holdsFail) return { ok: false, holds: [], error: 'down' }
      return { ok: true, holds: opps.filter((x) => x.held).map((x) => ({ id: uuidN(9000 + Number(x.property_id.slice(-3)), 'd'), hold_key: `hold:${x.property_id}`, hold_type: 'operator_hold', property_id: x.property_id, released_at: null, blocked_capabilities: [] })) }
    },
    async checkHold({ propertyId }) { hit('checkHold'); const x = by.get(String(propertyId)); return x?.held ? { held: true, hold_type: 'operator_hold', fail_closed: false } : { held: false } },
    async checkSuppression({ thread_key }) { hit('checkSuppression'); const x = byThread.get(thread_key); return { suppressed: Boolean(x?.suppressed), lookup_error: null } },
    async storedActionState({ property_ref }) {
      hit('storedActionState')
      const x = opps.find((o) => o.property_ref === property_ref)
      if (!x) return null
      return { state: x.action_state, owner: x.action_state === 'needs_attention' ? 'none' : 'seller', verified_stage: x.verified_stage, stage_verified: true, next_action: x.action_state === 'needs_attention' ? 'answer the seller' : 'await seller reply', reasons: ['fixture'], lost: false, pending_approvals: [], last_inbound_at: x.last_inbound_at, last_outbound_at: x.last_outbound_at }
    },
    researchEnabled: () => researchEnabled,
    closeCalibration: calibration ? async () => calibration : null,
  }
}

/** A runtime memory store armed for the Workforce kinds + property.research (tests only). */
export const ARMED_KINDS = Object.freeze({
  'workforce.coo_plan': { enabled: true, armed_by: OWNER, max_concurrency: 1 },
  'workforce.dispatch': { enabled: true, armed_by: OWNER, max_concurrency: 1 },
  'workforce.mission_review': { enabled: true, armed_by: OWNER, max_concurrency: 1 },
  'property.research': { enabled: true, armed_by: OWNER, max_concurrency: 2 },
})
