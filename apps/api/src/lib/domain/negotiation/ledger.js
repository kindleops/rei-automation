// ─── NEGOTIATION LEDGER + STATE MACHINE (8.5.19 Phase 8) ─────────────────────
// Every offer and counteroffer for one scope (thread + property), in order, with
// its SOURCE (seller / engine / operator) and AUTHORITY (seller_stated /
// within_envelope / operator_direct). The ledger is append-only and gap-free
// (PROPOSED public.negotiation_offer_events; the DB re-checks the envelope bound).
//
// AUTHORITY OF RECORD. public.seller_offers stays THE formal-offer authority (one
// active offer, versions, terms hash; written by seller-offer-authority.js before
// any send). A formal offer event here links seller_offers.offer_id; it never
// copies or replaces it. reconcileWithSellerOffers() reports formal offers that
// exist in seller_offers without a ledger event (e.g. pre-8.5.19 engine offers):
// they count as our last offer and are flagged, never silently trusted as authority.
//
// States
//   open               nothing priced yet
//   seller_priced      the seller stated a number, we have not
//   offer_out          our latest priced move is the last word
//   seller_countered   the seller answered our number with another
//   agreed             the seller accepted our latest number (evidence only — a
//                      contract is a Closing Desk act, never a ledger event)
//   rejected           the seller rejected; we may still move within authority
//   withdrawn | expired  terminal for priced moves
import { hashCanonical } from '../../agent/runtime/canonical.js'
import { envelopeStatus } from './envelope.js'

export const LEDGER_CONTRACT_VERSION = 'negotiation.ledger.v1'
export const SELLER_EVENTS = Object.freeze(['seller_ask', 'seller_counter', 'seller_accept', 'seller_reject', 'seller_terms_request'])
export const OUR_PRICED_EVENTS = Object.freeze(['our_anchor', 'our_offer', 'our_counter', 'our_final'])
export const OTHER_EVENTS = Object.freeze(['withdrawn', 'expired', 'escalated'])
export const EVENT_TYPES = Object.freeze([...SELLER_EVENTS, ...OUR_PRICED_EVENTS, ...OTHER_EVENTS])
export const ACTORS = Object.freeze(['seller', 'engine', 'operator'])
export const AUTHORITIES = Object.freeze(['seller_stated', 'within_envelope', 'operator_direct', 'none'])
export const STATES = Object.freeze(['open', 'seller_priced', 'offer_out', 'seller_countered', 'agreed', 'rejected', 'withdrawn', 'expired'])
const TERMINAL = new Set(['withdrawn', 'expired'])
const PRICED = new Set(['seller_ask', 'seller_counter', ...OUR_PRICED_EVENTS])

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function emptyLedgerState(scope_key = null) {
  return {
    scope_key, seq: 0, status: 'open',
    last_seller_amount: null, last_our_amount: null, last_our_event_type: null, last_actor: null,
    our_amounts: [], seller_amounts: [], engine_moves_by_envelope: {},
    accepted: null, flags: [], history: [],
  }
}

/**
 * Validate one event against the current state (and, for engine moves, the envelope).
 * @returns {{ ok: true } | { ok: false, code: string }}
 */
export function validateLedgerEvent(state, ev, { envelope = null, envelope_meta = {}, now = Date.now(), replay = false } = {}) {
  const s = state || emptyLedgerState()
  if (!EVENT_TYPES.includes(ev?.event_type)) return { ok: false, code: 'EVENT_TYPE_INVALID' }
  if (!ACTORS.includes(ev.actor)) return { ok: false, code: 'ACTOR_INVALID' }
  if (!AUTHORITIES.includes(ev.authority)) return { ok: false, code: 'AUTHORITY_INVALID' }
  if (s.scope_key && ev.scope_key && ev.scope_key !== s.scope_key) return { ok: false, code: 'SCOPE_MISMATCH' }
  if (Number(ev.seq) !== s.seq + 1) return { ok: false, code: 'SEQ_OUT_OF_ORDER' }
  const amount = num(ev.amount)
  if (amount != null && !(amount > 0 && amount < 1e9)) return { ok: false, code: 'AMOUNT_INVALID' }
  if (PRICED.has(ev.event_type) && amount == null) return { ok: false, code: 'AMOUNT_REQUIRED' }
  if ((ev.actor === 'seller') !== (ev.authority === 'seller_stated')) return { ok: false, code: 'SELLER_AUTHORITY_MISMATCH' }
  if (SELLER_EVENTS.includes(ev.event_type) && ev.actor !== 'seller') return { ok: false, code: 'SELLER_EVENT_NOT_BY_SELLER' }
  if (OUR_PRICED_EVENTS.includes(ev.event_type) && ev.actor === 'seller') return { ok: false, code: 'OUR_EVENT_BY_SELLER' }
  if (TERMINAL.has(s.status) && PRICED.has(ev.event_type)) return { ok: false, code: `LEDGER_${s.status.toUpperCase()}` }

  if (OUR_PRICED_EVENTS.includes(ev.event_type)) {
    if (ev.actor === 'engine') {
      if (ev.authority !== 'within_envelope' || !ev.envelope_id) return { ok: false, code: 'ENGINE_MOVE_NEEDS_ENVELOPE' }
      // replay: the envelope bound was enforced when the row was written (and by the DB trigger)
      if (!replay) {
        if (!envelope || envelope.envelope_id !== ev.envelope_id) return { ok: false, code: 'ENVELOPE_NOT_LOADED' }
        const st = envelopeStatus(envelope, { scope_key: s.scope_key || ev.scope_key, now, revoked: envelope_meta.revoked, latest_version: envelope_meta.latest_version })
        if (!st.live) return { ok: false, code: `ENVELOPE_${st.reason.toUpperCase()}` }
        if (amount > num(envelope.max_price)) return { ok: false, code: 'ABOVE_ENVELOPE_MAX' }
        const used = s.engine_moves_by_envelope[envelope.envelope_id] || 0
        if (used >= Number(envelope.max_moves || 3)) return { ok: false, code: 'ENVELOPE_MOVES_EXHAUSTED' }
      }
      // the engine never walks its own number back down (a reduction is an operator act)
      if (s.last_our_amount != null && amount < s.last_our_amount && ev.event_type !== 'our_anchor') return { ok: false, code: 'ENGINE_MOVE_BELOW_PRIOR_OFFER' }
    } else if (ev.actor === 'operator') {
      if (!String(ev.operator_id || '').trim()) return { ok: false, code: 'OPERATOR_ID_REQUIRED' }
      if (!['operator_direct', 'within_envelope'].includes(ev.authority)) return { ok: false, code: 'OPERATOR_AUTHORITY_INVALID' }
    }
    if (ev.event_type === 'our_offer' && s.our_amounts.length) return { ok: false, code: 'USE_OUR_COUNTER_AFTER_FIRST_OFFER' }
    if (ev.event_type === 'our_counter' && !s.our_amounts.length) return { ok: false, code: 'NO_PRIOR_OFFER_TO_COUNTER' }
  }
  if (ev.event_type === 'seller_accept') {
    if (s.last_our_amount == null) return { ok: false, code: 'NOTHING_TO_ACCEPT' }
    if (s.status !== 'offer_out') return { ok: false, code: 'ACCEPT_MUST_FOLLOW_OUR_LATEST_OFFER' }
  }
  if (ev.event_type === 'seller_counter' && s.last_our_amount == null) return { ok: false, code: 'COUNTER_WITHOUT_OUR_OFFER_IS_AN_ASK' }
  return { ok: true }
}

/** Apply a VALIDATED event. Pure. */
export function applyLedgerEvent(state, ev) {
  const s = structuredClone(state || emptyLedgerState(ev.scope_key || null))
  if (!s.scope_key) s.scope_key = ev.scope_key || null
  s.seq = Number(ev.seq)
  s.last_actor = ev.actor
  const amount = num(ev.amount)
  switch (ev.event_type) {
    case 'seller_ask':
      s.last_seller_amount = amount; s.seller_amounts.push(amount)
      if (!['offer_out', 'seller_countered', 'agreed', 'rejected'].includes(s.status)) s.status = 'seller_priced'
      else s.status = s.last_our_amount != null ? 'seller_countered' : 'seller_priced'
      break
    case 'seller_counter':
      s.last_seller_amount = amount; s.seller_amounts.push(amount); s.status = 'seller_countered'
      break
    case 'seller_accept':
      s.status = 'agreed'; s.accepted = { amount: s.last_our_amount, seq: s.seq }
      break
    case 'seller_reject':
      s.status = 'rejected'
      break
    case 'seller_terms_request':
      break
    case 'withdrawn': s.status = 'withdrawn'; break
    case 'expired': s.status = 'expired'; break
    case 'escalated': break
    default:
      if (OUR_PRICED_EVENTS.includes(ev.event_type)) {
        s.last_our_amount = amount
        s.last_our_event_type = ev.event_type
        s.our_amounts.push(amount)
        s.status = 'offer_out'
        s.accepted = null
        if (ev.actor === 'engine' && ev.envelope_id) s.engine_moves_by_envelope[ev.envelope_id] = (s.engine_moves_by_envelope[ev.envelope_id] || 0) + 1
      }
  }
  s.history.push({ seq: s.seq, event_type: ev.event_type, actor: ev.actor, authority: ev.authority, amount, envelope_id: ev.envelope_id || null, seller_offer_id: ev.seller_offer_id || null, at: ev.created_at || null })
  return s
}

/**
 * Rebuild the state from stored events (ordered by seq). A stored ledger that
 * fails validation is reported, not repaired: { ok:false, state up to the break }.
 * Envelope bounds were enforced at write time (and by the DB); replay checks order,
 * actors and transitions.
 */
export function replayLedger(events = [], { scope_key = null } = {}) {
  let state = emptyLedgerState(scope_key)
  const sorted = [...events].sort((a, b) => Number(a.seq) - Number(b.seq))
  for (const ev of sorted) {
    const v = validateLedgerEvent(state, ev, { replay: true })
    if (!v.ok) return { ok: false, code: v.code, at_seq: Number(ev.seq), state }
    state = applyLedgerEvent(state, ev)
  }
  return { ok: true, state }
}

/**
 * Formal offers in seller_offers (THE formal-offer authority) vs the ledger.
 * An outbound offer without a ledger event is a pre-8.5.19 / out-of-band offer:
 * it is our last offer on record (the seller saw it) and it is flagged.
 */
export function reconcileWithSellerOffers(state, sellerOffers = []) {
  const s = structuredClone(state || emptyLedgerState())
  const linked = new Set(s.history.map((h) => h.seller_offer_id).filter(Boolean))
  const live = (sellerOffers || []).filter((o) => o && ['active', 'accepted', 'superseded'].includes(String(o.status || '').toLowerCase()))
  const unbound = live.filter((o) => String(o.direction || '').toLowerCase() === 'outbound' && !linked.has(o.offer_id))
  for (const o of unbound) s.flags.push({ code: 'formal_offer_without_ledger_authority', offer_id: o.offer_id || null, amount: num(o.purchase_price), status: o.status })
  const activeOutbound = live.filter((o) => String(o.direction || '').toLowerCase() === 'outbound').sort((a, b) => Number(b.offer_version || 0) - Number(a.offer_version || 0))[0]
  if (activeOutbound && s.last_our_amount == null) {
    s.last_our_amount = num(activeOutbound.purchase_price)
    s.our_amounts.push(s.last_our_amount)
    if (s.status === 'open' || s.status === 'seller_priced') s.status = 'offer_out'
  }
  const inbound = live.filter((o) => String(o.direction || '').toLowerCase() === 'inbound').sort((a, b) => Number(b.offer_version || 0) - Number(a.offer_version || 0))[0]
  if (inbound && s.last_seller_amount == null) s.last_seller_amount = num(inbound.purchase_price)
  return s
}

/** A storable event row. Idempotency: same scope + seq + type + amount + source message ⇒ same key. */
export function buildLedgerEventRow({ scope, seq, event_type, actor, amount = null, terms = {}, authority, envelope_id = null, operator_id = null, quote_type = null, source_message_id = null, seller_offer_id = null, justification = [], now = Date.now() }) {
  const row = {
    contract_version: LEDGER_CONTRACT_VERSION,
    scope_key: scope.scope_key,
    seq,
    thread_ref: scope.thread_ref,
    property_id: scope.property_id,
    opportunity_id: scope.opportunity_id || null,
    event_type, actor,
    amount: num(amount),
    terms: terms || {},
    authority,
    envelope_id,
    operator_id,
    quote_type,
    source_message_id,
    seller_offer_id,
    justification: Array.isArray(justification) ? justification.slice(0, 12).map((j) => String(j).slice(0, 240)) : [],
    created_at: new Date(typeof now === 'number' ? now : Date.parse(now)).toISOString(),
  }
  row.idempotency_key = `nle:${hashCanonical({ s: row.scope_key, q: seq, t: event_type, a: row.amount, m: source_message_id, o: seller_offer_id }).slice(0, 48)}`
  return row
}

/** seller_offers persistence arguments for a formal engine move (the SEND path calls persistActiveOffer; this module never does). */
export function toSellerOfferArgs({ event, envelope, opportunity_id, thread_key, property_id }) {
  return {
    opportunity_id, thread_key, property_id,
    purchase_price: num(event.amount),
    offer_type: event.event_type === 'our_final' ? 'final_offer' : event.event_type === 'our_counter' ? 'counter_offer' : 'initial_offer',
    direction: 'outbound',
    authorized_ceiling: num(envelope?.max_price),
    closing_window_days: num(event.terms?.closing_days),
    emd_amount: num(event.terms?.earnest_money),
    metadata: { offer_event: { source: event.actor, quote_type: event.quote_type || 'FORMAL_OFFER', envelope_id: envelope?.envelope_id || null, envelope_version: envelope?.version ?? null, operator_id: event.operator_id || null } },
  }
}
