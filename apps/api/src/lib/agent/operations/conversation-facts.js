// Conversation facts (8.5.20 part C) — one normalized shape for a row of
// CONVERSATION_FACTS_SQL, and the contact-permission verdict every consumer
// (recovery classifier, action center) reads BEFORE anything else.
//
// Pure. A field that was not read is null, never 0 / false-as-fact: `unknown`
// stays unknown (an unknown language is not English; an unread table is not
// "no rows").
import { encodePropertyRef } from '../missions/mission-codec.js'

const iso = (v) => {
  if (v == null || v === '') return null
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
const num = (v) => {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const int0 = (v) => { const n = num(v); return n == null ? 0 : Math.trunc(n) }
const lower = (v) => String(v ?? '').trim().toLowerCase()
const str = (v) => { const s = String(v ?? '').trim(); return s || null }
const bool = (v) => v === true || v === 't' || v === 'true'
export const ms = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : null }

/** Acquisition stage order (opportunity/stage-advance-guard.js). */
export const STAGES = Object.freeze(['ownership_confirmation', 'offer_interest', 'asking_price', 'property_condition', 'offer', 'formal_contract', 'disposition', 'under_contract', 'prepared_to_close', 'closed'])
export const stageRank = (s) => STAGES.indexOf(lower(s))

/** Intents that show the seller may sell (evidence only — never a stage by themselves). */
export const INTEREST_INTENTS = Object.freeze(['seller_interested', 'latent_interest', 'asks_offer', 'asking_price_provided', 'asking_price_implausible', 'condition_disclosed', 'callback_requested', 'contract_requested', 'need_time'])
export const OFFER_REQUEST_INTENTS = Object.freeze(['asks_offer', 'contract_requested'])
export const PRICE_INTENTS = Object.freeze(['asking_price_provided', 'asking_price_implausible'])
/** "No" to ownership — a PROPERTY-SCOPED denial (seller policy, locked). */
export const OWNERSHIP_DENIAL_INTENTS = Object.freeze(['property_specific_non_owner', 'property_correction', 'sold_property', 'former_owner_respondent', 'tenant_respondent'])
/** A third party answered (heir, agent, family, entity rep, referral): a person decides who to talk to. */
export const RELATIONSHIP_REVIEW_INTENTS = Object.freeze(['executor_heir_respondent', 'agent_representative_respondent', 'family_member_respondent', 'entity_representative_respondent', 'non_owner_referral', 'llc_corporation'])
export const HOSTILE_INTENTS = Object.freeze(['hostile_or_legal'])
export const NOT_INTERESTED_INTENTS = Object.freeze(['not_interested'])
/** Languages the outreach programs have copy for; anything else (or unknown) needs a person. */
export const SUPPORTED_LANGUAGES = Object.freeze(['en', 'english', 'es', 'spanish'])

/** Opportunity statuses that are no longer a live deal (closed-lost / closed). */
export const CLOSED_OPPORTUNITY_STATUSES = Object.freeze(['dead', 'lost', 'closed', 'suppressed', 'archived', 'closed_lost', 'closed_won', 'won'])
export const LIVE_OPPORTUNITY_STATUSES = Object.freeze(['active', 'nurture'])

/** Normalize one CONVERSATION_FACTS_SQL row (PostgreSQL numerics arrive as strings). */
export function normalizeConversationFacts(r = {}) {
  const intents = Array.isArray(r.inbound_intents) ? r.inbound_intents.map(lower).filter(Boolean) : typeof r.inbound_intents === 'string' ? r.inbound_intents.replace(/^\{|\}$/g, '').split(',').map((x) => lower(x.replace(/^"|"$/g, ''))).filter(Boolean) : []
  const opp = r.opportunity_id ? {
    opportunity_id: String(r.opportunity_id),
    stage: lower(r.opp_stage) || null,
    status: lower(r.opp_status) || null,
    temperature: lower(r.opp_temperature) || null,
    priority: str(r.opp_priority),
    next_action: str(r.opp_next_action),
    next_action_due: iso(r.opp_next_action_due),
    promotion_reason: str(r.opp_promotion_reason),
    asking_price: num(r.opp_asking_price),
    current_offer: num(r.opp_current_offer),
    stage_entered_at: iso(r.opp_stage_entered_at),
    last_activity_at: iso(r.opp_last_activity_at),
  } : null
  const valuation = r.pas_id ? {
    pas_id: String(r.pas_id), computed_at: iso(r.pas_computed_at), valuation_mid: num(r.valuation_mid), investor_ceiling_mid: num(r.investor_ceiling_mid),
    investor_ceiling_high: num(r.investor_ceiling_high), minimum_acceptable_offer: num(r.minimum_acceptable_offer), recommended_cash_offer: num(r.recommended_cash_offer), buyer_demand_score: num(r.buyer_demand_score),
  } : null
  return {
    conversation_id: String(r.conversation_id),
    // the keyset cursor, verbatim (microseconds): never round-tripped through Date
    cursor_at: r.cursor_at == null ? null : r.cursor_at instanceof Date ? r.cursor_at.toISOString() : String(r.cursor_at),
    property_id: str(r.property_id),
    property_ref: str(r.property_id) ? encodePropertyRef(String(r.property_id)) : null,
    market: str(r.market),
    thread: {
      seller_stage: lower(r.seller_stage) || null,
      disposition: lower(r.disposition) || null,
      contactability: lower(r.contactability_status) || null,
      is_suppressed: bool(r.is_suppressed),
      is_archived: bool(r.is_archived),
      archive_reason: str(r.archive_reason),
      is_read: bool(r.is_read),
      bucket: lower(r.inbox_bucket) || null,
      operational_status: lower(r.operational_status) || null,
      temperature: lower(r.lead_temperature) || null,
      is_hot: bool(r.is_hot_lead),
      last_intent: lower(r.last_intent) || null,
      next_action: str(r.next_action),
      next_action_at: iso(r.next_action_at),
      follow_up_at: iso(r.follow_up_at),
      snoozed_until: iso(r.snoozed_until),
      manual_override: bool(r.manual_override),
    },
    inbound: {
      count: int0(r.inbound_count),
      first_at: iso(r.first_inbound_at),
      any_opt_out: bool(r.any_opt_out),
      intents,
      last: r.last_inbound_id ? { message_event_id: String(r.last_inbound_id), at: iso(r.last_inbound_at), intent: lower(r.last_inbound_intent) || null, opt_out: bool(r.last_inbound_opt_out), language: lower(r.last_inbound_language) || null } : null,
      last_meaningful: r.last_meaningful_id ? { message_event_id: String(r.last_meaningful_id), at: iso(r.last_meaningful_at), intent: lower(r.last_meaningful_intent) || null } : null,
    },
    outbound: {
      last: r.last_outbound_id ? { message_event_id: String(r.last_outbound_id), at: iso(r.last_outbound_at), delivery: lower(r.last_outbound_delivery) || null, automated: bool(r.last_outbound_auto) } : null,
      after_inbound: int0(r.outbound_after_inbound),
      delivered_after_inbound: int0(r.delivered_after_inbound),
      failed_after_inbound: int0(r.failed_after_inbound),
    },
    queue: {
      pending: int0(r.pending_count),
      next_pending_at: iso(r.next_pending_at),
      failed_internal_after_inbound: int0(r.failed_internal_after_inbound),
      failed_provider_after_inbound: int0(r.failed_provider_after_inbound),
      held_after_inbound: int0(r.held_after_inbound),
    },
    suppression_listed: bool(r.suppression_listed),
    opportunity: opp,
    offers: { sent: int0(r.offers_sent), last_at: iso(r.last_offer_at) },
    live_closing_case: bool(r.live_closing_case),
    followup_state: { active: int0(r.followups_active), next_at: iso(r.followup_next_at) },
    valuation,
  }
}

/**
 * Contact permission, verified from the facts BEFORE any "eligible" label or any
 * state that implies outreach. Seller policy (locked):
 *   stop request / opt-out              → suppression (no contact, any property)
 *   wrong number                         → no owner outreach on this number
 *   "No" to ownership                    → property-scoped denial
 *   "No" to selling / not interested     → NOT a block (30-day follow-up)
 * @returns {{ permitted: boolean, blocks: string[], suppression: boolean, wrong_owner_or_number: boolean, ownership: 'confirmed'|'denied'|'unverified' }}
 */
export function verifyContactPermission(f) {
  const blocks = []
  const intents = new Set(f.inbound.intents)
  const disp = f.thread.disposition
  const contact = f.thread.contactability
  if (f.inbound.any_opt_out || f.inbound.last?.opt_out || intents.has('opt_out')) blocks.push('opt_out')
  if (f.thread.is_suppressed || disp === 'suppressed' || disp === 'opt_out') blocks.push('suppressed')
  if (f.suppression_listed) blocks.push('suppression_list')
  if (['opted_out', 'do_not_text', 'do_not_contact'].includes(contact)) blocks.push(`contactability_${contact}`)
  const suppression = blocks.length > 0
  if (intents.has('wrong_number') || disp === 'wrong_number' || disp === 'wrong_person' || contact === 'invalid_number') blocks.push('wrong_number')
  const denial = OWNERSHIP_DENIAL_INTENTS.some((i) => intents.has(i)) || disp === 'sold'
  if (denial) blocks.push('ownership_denied')
  const confirmed = intents.has('ownership_confirmed') || stageRank(f.thread.seller_stage) >= stageRank('offer_interest') || (f.opportunity && stageRank(f.opportunity.stage) >= stageRank('offer_interest')) || INTEREST_INTENTS.some((i) => intents.has(i))
  return {
    permitted: blocks.length === 0,
    blocks,
    suppression,
    wrong_owner_or_number: blocks.includes('wrong_number') || denial,
    ownership: denial ? 'denied' : confirmed ? 'confirmed' : 'unverified',
  }
}

/** Latest-of helper over ISO strings (null-safe). */
export function latest(...xs) {
  let best = null
  for (const x of xs) { const t = ms(x); if (t != null && (best == null || t > best)) best = t }
  return best == null ? null : new Date(best).toISOString()
}

/**
 * Did the seller speak last with something meaningful that nobody answered? An outbound
 * after it that FAILED is not an answer (the seller never received it).
 */
export function sellerWaiting(f) {
  const lm = f.inbound.last_meaningful
  if (!lm) return false
  const answered = f.outbound.after_inbound - f.outbound.failed_after_inbound > 0
  if (answered) return false
  const lmT = ms(lm.at)
  const lastIn = ms(f.inbound.last?.at)
  // the meaningful message is the latest seller word, or only non-meaningful ones followed it
  return lmT == null || lastIn == null || lmT <= lastIn
}

/** A seller message that does not reopen a closed deal ("no", stop, wrong number, denial, insults). */
export const NON_REOPENING_INTENTS = Object.freeze(['not_interested', 'opt_out', 'wrong_number', 'hostile_or_troll', 'reaction_only', 'acknowledgement', ...OWNERSHIP_DENIAL_INTENTS])

/**
 * The closed-deal verdict: closed, unless the seller wrote something meaningful and
 * non-negative AFTER the close (owner rule: a dead deal reopens on a new reply — a
 * "not interested" after the close is not one).
 */
export function closedVerdict(f) {
  const o = f.opportunity
  const closedOpp = o && (CLOSED_OPPORTUNITY_STATUSES.includes(o.status) || o.stage === 'closed')
  const closedDisp = ['sold', 'unqualified'].includes(f.thread.disposition)
  if (!closedOpp && !closedDisp) return { closed: false, reopened: false }
  const closedAt = o ? latest(o.stage_entered_at, o.last_activity_at) : null
  const lm = f.inbound.last_meaningful
  const reopened = Boolean(closedOpp && closedAt && lm && ms(lm.at) != null && ms(lm.at) > ms(closedAt) && !NON_REOPENING_INTENTS.includes(lm.intent))
  return { closed: !reopened, reopened, closed_at: closedAt, after_not_interested: NOT_INTERESTED_INTENTS.includes(lm?.intent) }
}

export function languageSupported(f) {
  const l = f.inbound.last?.language
  if (!l) return null // unknown is unknown
  return SUPPORTED_LANGUAGES.includes(l)
}
