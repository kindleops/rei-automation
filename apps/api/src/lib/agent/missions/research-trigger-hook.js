// ─── RESEARCH TRIGGER HOOK (8.5.21-b, owner directive Phase 7) ────────────────
// Contract: lc.research-trigger-hook.v1 — documented in docs/research-trigger-hook.md.
//
// The 8.5.21-a turn engine calls ONE pure function after it has understood an inbound:
//
//   researchTriggerFromTurn(event) → { trigger, property_id, discriminator, priority, reason } | { trigger: null, reason }
//
// and, when it wants the job enqueued, the thin wrapper
//
//   enqueueResearchForTurn(event, { store, env }) → enqueuePropertyResearch(...) result
//
// MEANINGFUL INBOUND EVENTS (strongest first; exactly one trigger per event):
//   counteroffer          the seller states a number AFTER we put one to them (or the
//                         understanding says the seller countered)
//   offer_request         the seller asks for our offer ("what would you pay?")
//   asking_price_revealed the seller's stated asking price is new or changed
//   seller_interest       the seller says they may sell (no price yet)
// NEVER a trigger: stop / opt-out, wrong number, an ownership denial, hostile or legal
// language, or a plan that suppresses — and no property in scope.
//
// Pure: no I/O, no clock read (now is an input), no model. The wrapper is OFF unless
// PROPERTY_RESEARCH_ENABLED=1 AND the runtime has property.research armed (the DB refuses
// otherwise). The event key dedupes: one job per (trigger, property, discriminator).
import { enqueuePropertyResearch, propertyResearchEnabled } from './property-research-triggers.js'
import { askFromLedger } from '../../domain/opportunity-economics/economics-service.js'

export const RESEARCH_TRIGGER_HOOK_VERSION = 'lc.research-trigger-hook.v1'

export const TURN_RESEARCH_TRIGGERS = Object.freeze(['counteroffer', 'offer_request', 'asking_price_revealed', 'seller_interest'])
/** Lower = claimed first (runtime claim order). */
export const TURN_RESEARCH_PRIORITY = Object.freeze({ counteroffer: 100, offer_request: 105, asking_price_revealed: 110, seller_interest: 130 })

const INTEREST = new Set(['seller_interested', 'latent_interest', 'need_time', 'callback_requested', 'condition_disclosed'])
const OFFER_REQUEST = new Set(['asks_offer', 'contract_requested', 'offer_request'])
const COUNTER = new Set(['counter_offer', 'seller_counter', 'counteroffer'])
const BLOCKING = new Set(['opt_out', 'stop', 'wrong_number', 'hostile_or_legal', 'hostile_or_troll', 'property_specific_non_owner', 'property_correction', 'sold_property', 'former_owner_respondent', 'tenant_respondent'])
const BLOCKING_ACTIONS = new Set(['SUPPRESS'])

const lower = (v) => String(v ?? '').trim().toLowerCase()
const pos = (v) => { const n = Number(v); return v != null && v !== '' && typeof v !== 'boolean' && Number.isFinite(n) && n > 0 ? n : null }
const day = (now) => {
  const t = typeof now === 'number' ? now : Date.parse(String(now ?? ''))
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : 'unknown-day'
}
const askOf = (ledger, explicit) => pos(explicit) ?? pos(ledger ? askFromLedger(ledger).ask?.amount : null)

/**
 * @param {object} e
 * @param {string|number|null} e.property_id        the ONE property in scope (null ⇒ no trigger)
 * @param {string[]} [e.intents]                     deterministic + understood intents of THIS inbound
 * @param {Array<{type:string}>} [e.actions]         the decision plan's actions (SUPPRESS ⇒ no trigger)
 * @param {string|null} [e.decision_outcome]         e.g. 'PREPARE_OFFER' | 'NEGOTIATE_WITHIN_AUTHORITY'
 * @param {{ kind?: string, amount?: number|null }} [e.seller_request]  the understanding's seller request this turn
 * @param {object|null} [e.ledger_before]            thread ledger before this inbound (canonical or facts view)
 * @param {object|null} [e.ledger_after]             thread ledger after it
 * @param {number|null} [e.ask_before] [e.ask_after] explicit asks (override the ledgers)
 * @param {number|null} [e.our_last_offer]           our last amount on record (counter detection)
 * @param {number|string} e.now                      the turn clock (day bucket for interest / offer requests)
 */
export function researchTriggerFromTurn(e = {}) {
  const pid = String(e.property_id ?? '').trim()
  if (!pid) return { trigger: null, reason: 'no_property_in_scope' }
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(pid)) return { trigger: null, reason: 'property_id_invalid' }
  const intents = new Set((Array.isArray(e.intents) ? e.intents : []).map(lower).filter(Boolean))
  for (const i of intents) if (BLOCKING.has(i)) return { trigger: null, reason: `blocking_intent:${i}` }
  for (const a of Array.isArray(e.actions) ? e.actions : []) if (BLOCKING_ACTIONS.has(String(a?.type))) return { trigger: null, reason: 'plan_suppresses' }

  const req = e.seller_request || {}
  const kind = lower(req.kind)
  const before = askOf(e.ledger_before, e.ask_before)
  const after = askOf(e.ledger_after, e.ask_after) ?? pos(req.amount)
  const ourLast = pos(e.our_last_offer)
  const out = (trigger, discriminator, reason) => ({ trigger, property_id: pid, discriminator, priority: TURN_RESEARCH_PRIORITY[trigger], reason, version: RESEARCH_TRIGGER_HOOK_VERSION })

  // 1 counteroffer: a seller number after ours (or the understanding says so)
  if (kind === 'counter' || [...intents].some((i) => COUNTER.has(i)) || (ourLast && after && (pos(req.amount) || after !== before))) {
    const amt = pos(req.amount) ?? after
    if (amt) return out('counteroffer', `counter:${Math.round(amt)}`, kind === 'counter' ? 'seller_request_counter' : ourLast ? 'seller_number_after_our_offer' : 'counter_intent')
  }
  // 2 offer request
  if (kind === 'asks_offer' || lower(e.decision_outcome) === 'prepare_offer' || [...intents].some((i) => OFFER_REQUEST.has(i))) {
    return out('offer_request', `offer_request:${day(e.now)}`, kind === 'asks_offer' ? 'seller_request_asks_offer' : lower(e.decision_outcome) === 'prepare_offer' ? 'decision_prepare_offer' : 'offer_request_intent')
  }
  // 3 asking price revealed / changed
  if (after && after !== before) return out('asking_price_revealed', `ask:${Math.round(after)}`, before ? 'asking_price_changed' : 'asking_price_new')
  // a price intent with the SAME ask as before is not a new event (that ask was already researched)
  // 4 interest without a price
  if ([...intents].some((i) => INTEREST.has(i))) return out('seller_interest', `interest:${day(e.now)}`, 'interest_intent')
  return { trigger: null, reason: 'no_meaningful_research_signal' }
}

/**
 * Hook + enqueue. OFF unless PROPERTY_RESEARCH_ENABLED=1; the runtime refuses unless the kind is armed.
 * @param {object} event  researchTriggerFromTurn input
 * @param {{ store: { enqueueEvent: Function }, env?: object, web?: boolean }} deps
 */
export async function enqueueResearchForTurn(event, { store, env = process.env, web = true } = {}) {
  if (!propertyResearchEnabled(env)) return { ok: false, reason: 'PROPERTY_RESEARCH_DISABLED' }
  const t = researchTriggerFromTurn(event)
  if (!t.trigger) return { ok: false, reason: 'NO_TRIGGER', detail: t.reason }
  const r = await enqueuePropertyResearch({ store, env, trigger: t.trigger, property_id: t.property_id, discriminator: t.discriminator, priority: t.priority, web, now: event.now })
  return { ...r, trigger: t.trigger }
}
