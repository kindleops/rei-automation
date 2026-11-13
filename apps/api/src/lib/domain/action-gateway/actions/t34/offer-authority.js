// The READ-ONLY offer authority the T4 family stands on (prepare / submit / execute), over the gateway's own data
// path (lc_action_gateway): the Decision Engine row (definer read action_gateway_offer_authority), the property,
// the thread's canonical fact ledger, the negotiation scope state (definer read action_gateway_negotiation_state:
// envelope, ledger events, send authorization + its DURABLE use count) and seller_offers. Then the EXISTING
// services, unchanged:
//   assessOpportunityEconomics (economics class, MAO metric)   opportunity-economics/economics-service.js
//   planOffer (lane-labelled values, MAO = ceiling, opening strictly below it)   property-research/offer-plan.js
//   laneValuation (a pure cross-check when lane inputs — property facts + comps — are supplied)   acquisition/laneValuation.js
//   preparePosition → composerView (the negotiation position, composer projection only)   negotiation/*
// Nothing here writes, sends or persists.
import { hashCanonical } from '../../../../agent/runtime/canonical.js'
import { assessOpportunityEconomics, askFromLedger, ECONOMICS_PROPERTY_FIELDS } from '../../../opportunity-economics/economics-service.js'
import { factSummaryOf } from '../../../conversation-ai/ledger.js'
import { planOffer } from '../../../property-research/offer-plan.js'
import { laneValuation } from '../../../../acquisition/laneValuation.js'
import { loadThreadFactLedger, preparePosition } from '../../../negotiation/negotiation-service.js'
import { composerView } from '../../../negotiation/seller-facing-guard.js'
import { num } from './shared.js'

export const OFFER_AUTHORITY_VERSION = 'action-gateway.offer-authority.v1'

/** A client whose ONE read of property_acquisition_scores is answered by the definer read (the table keeps its ACL). */
function withEngineRow(db, row) {
  const answer = async () => ({ data: row ? [row] : [], error: null })
  const builder = () => {
    const b = { select: () => b, eq: () => b, limit: () => b, order: () => b, maybeSingle: async () => ({ data: row || null, error: null }), then: (res, rej) => answer().then(res, rej) }
    return b
  }
  return { from: (t) => (t === 'property_acquisition_scores' ? builder() : db.from(t)), rpc: (...a) => db.rpc(...a) }
}

/** The negotiation store contract (latestEnvelope / listEvents / sellerOffers) over ONE scope's state, read-only. */
export function negotiationStoreFrom(state, sellerOffers = []) {
  const env = state?.envelope || null
  return Object.freeze({
    kind: 'gateway_read',
    async latestEnvelope() { return env ? { envelope: env, revoked: env.revoked === true, latest_version: num(env.latest_version) ?? num(env.version) } : { envelope: null, revoked: false, latest_version: null } },
    async listEvents() { return Array.isArray(state?.events) ? state.events : [] },
    async sellerOffers() { return sellerOffers },
  })
}

/** The fields of a plan the submission binds (time-free: the same engine row and ask give the same hash). */
export function planHash(plan, property_id) {
  return hashCanonical({ v: OFFER_AUTHORITY_VERSION, property_id: String(property_id), available: Boolean(plan?.available), mao: plan?.mao?.amount ?? null, target: plan?.target?.amount ?? null,
    opening: plan?.opening?.recommended ?? null, range: plan?.opening?.range ?? null, snapshot: plan?.engine?.snapshot_id ?? null, computed_at: plan?.engine?.computed_at ?? null, lane: plan?.lane ?? null })
}

async function propertyRow(reads, id) {
  try {
    const r = await reads.client.from('properties').select(ECONOMICS_PROPERTY_FIELDS.join(',')).eq('property_id', String(id)).limit(1)
    if (!r?.error && r?.data?.[0]) return r.data[0]
  } catch { /* fall back to the narrow read */ }
  return reads.property(id)
}

/**
 * @param {{ reads, store, services, property_id: string, thread?: object|null, now: number, seller_request?: object }} a
 */
export async function loadOfferAuthority({ reads, store, services = {}, property_id, thread = null, now = Date.now(), seller_request = {} }) {
  const pid = String(property_id)
  const [valuation, property] = await Promise.all([store.offerAuthority(pid), propertyRow(reads, pid)])
  let ledger = {}
  let canonical = null
  if (thread?.thread_key) {
    try { const l = await loadThreadFactLedger({ supabase: reads.client, thread_key: thread.thread_key, now: new Date(now) }); ledger = l.ledger; canonical = l.canonical } catch { ledger = {} }
  }
  const { ask, history } = askFromLedger(ledger)
  let economics = null
  try { economics = await assessOpportunityEconomics({ supabase: withEngineRow(reads.client, valuation), property_id: pid, ledger, thread_key: thread?.thread_key || null, now: new Date(now) }) } catch { economics = null }
  const state = thread?.id ? await store.negotiationState(thread.id, pid) : null
  const plan = planOffer({ valuation, property: property || { property_id: pid }, ask, ask_history: history, facts: factSummaryOf(ledger), envelope: state?.envelope && state.envelope.revoked !== true ? state.envelope : null, now })
  // the lane cross-check (pure; only when LeadCommand supplies property facts + comps for it)
  let lane = { available: false, reason: 'lane_inputs_not_supplied' }
  if (typeof services.laneInputs === 'function') {
    try {
      const li = await services.laneInputs({ property_id: pid })
      if (li?.property) lane = { available: true, ...laneValuation({ ...li, now: new Date(now) }) }
    } catch { lane = { available: false, reason: 'lane_valuation_failed' } }
  }
  let position = null
  if (thread?.thread_key) {
    const offers = (await reads.sellerOffers(thread.thread_key).catch(() => [])).filter((o) => !o.property_id || String(o.property_id) === pid)
    position = await preparePosition({ thread_key: thread.thread_key, property_id: pid, fact_ledger: canonical || ledger, economics, offer_plan: plan, seller_request, now }, { store: negotiationStoreFrom(state, offers) }).catch(() => null)
  }
  return { valuation, property, ledger, economics, plan, lane, state, position, view: position ? composerView(position) : null, ask }
}

/** "Uneconomic ⇒ no HOT": the class is never HOT when the plan cannot open strictly below an engine ceiling. */
export function economicsClassOf(economics, plan) {
  const c = economics?.class || 'INVESTIGATE'
  if (c === 'HOT' && !(plan?.available === true)) return 'INVESTIGATE'
  return c
}
