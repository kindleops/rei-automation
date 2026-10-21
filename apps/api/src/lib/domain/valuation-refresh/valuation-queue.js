// ─── VALUATION REFRESH QUEUE (8.5.21-b, owner directive item 2) ──────────────
// A bounded, prioritized list of properties that need a Decision Engine valuation.
// PRIORITY ORDER (binding, owner):
//   1 active_negotiation              an offer is out / the deal is at condition or offer stage
//   2 offer_request                   the seller asked for our offer
//   3 motivated_plausible_ask         a plausible seller-stated ask (interest / motivation on record)
//   4 recoverable_conversation        a recovery sweep surfaced it (research_worthy / human review)
//   5 investigate_missing_financials  everything else that is live and has no current engine row
// Within a class: most recent activity first. One entry per property (its best class).
//
// "Needs a valuation" = no engine row, a row older than the freshness horizon (30 d), a row
// older than the seller's latest stated ask, or a row from another engine version. A current
// row is never re-queued (the engine would reuse it anyway).
// EXCLUDED (never queued): suppressed / opt-out threads, wrong number, a property-scoped
// ownership denial, closed deals without a recovery finding.
// Pure: no I/O. The runner (dry-run.js) calls the EXISTING engine entry point.
import { assessDealAmount } from '../opportunity/stage-advance-guard.js'
import { CURRENT_ENGINE_VERSION, DEFAULT_MAX_AGE_DAYS } from '../../acquisition/decisionAuthority.js'
import { OFFER_POLICY_EPOCH } from '../../acquisition/offerReadiness.js'

export const VALUATION_QUEUE_VERSION = 'valuation-refresh-queue.v1'
export const VALUATION_PRIORITY_CLASSES = Object.freeze(['active_negotiation', 'offer_request', 'motivated_plausible_ask', 'recoverable_conversation', 'investigate_missing_financials'])
export const VALUATION_QUEUE_LIMITS = Object.freeze({ default_limit: 50, max_limit: 200 })
export const OFFER_READY_TIERS = Object.freeze(['AUTO_HARD_OFFER', 'AUTO_RANGE_OFFER'])

const OFFER_REQUEST = new Set(['asks_offer', 'contract_requested'])
const INTEREST = new Set(['seller_interested', 'latent_interest', 'asking_price_provided', 'condition_disclosed', 'need_time', 'callback_requested', 'asks_offer', 'contract_requested'])
const DENIAL = new Set(['property_specific_non_owner', 'property_correction', 'sold_property', 'former_owner_respondent', 'tenant_respondent'])
const LIVE = new Set(['active', 'nurture'])
const NEGOTIATION_STAGES = new Set(['property_condition', 'offer', 'formal_contract'])
const RECOVERABLE = new Set(['research_worthy', 'needs_human_review', 'eligible_for_approved_followup'])

const lower = (v) => String(v ?? '').trim().toLowerCase()
const num = (v) => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const ms = (v) => { const t = v instanceof Date ? v.getTime() : Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : null }
const intentsOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.replace(/^\{|\}$/g, '').split(',') : []).map((x) => lower(String(x).replace(/^"|"$/g, ''))).filter(Boolean)

/** Why (or whether) this property needs an engine valuation now. */
export function valuationNeed(row = {}, { now = Date.now(), maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  const at = ms(row.score_computed_at)
  if (at == null) return { needs: true, reason: 'no_engine_row' }
  if (at < Date.parse(OFFER_POLICY_EPOCH)) return { needs: true, reason: 'engine_row_predates_offer_policy' }
  if (now - at > maxAgeDays * 864e5) return { needs: true, reason: 'engine_row_stale_30d' }
  const askAt = ms(row.ask_updated_at ?? row.updated_at)
  if (num(row.asking_price) > 0 && askAt != null && askAt > at) return { needs: true, reason: 'ask_newer_than_engine_row' }
  if (row.engine_version && String(row.engine_version) !== CURRENT_ENGINE_VERSION) return { needs: true, reason: `engine_version_${String(row.engine_version).slice(0, 12)}` }
  return { needs: false, reason: 'engine_row_current' }
}

/**
 * @param {object} row  candidate (SQL source shape): property_id, opportunity_id, stage, status, asking_price,
 *   current_offer, offers_sent, intents[], is_suppressed, disposition, contactability_status, latest_intent,
 *   score_computed_at, decision_tier, engine_version, last_activity_at, updated_at, recovery_class?, economics_class?
 */
export function classifyValuationCandidate(row = {}, { now = Date.now() } = {}) {
  const pid = String(row.property_id ?? '').trim()
  if (!pid) return { queued: false, reason: 'no_property' }
  const intents = new Set([...intentsOf(row.intents), lower(row.latest_intent)].filter(Boolean))
  const disp = lower(row.disposition)
  const contact = lower(row.contactability_status)
  if (row.is_suppressed === true || intents.has('opt_out') || ['suppressed', 'opt_out'].includes(disp) || ['opted_out', 'do_not_text', 'do_not_contact'].includes(contact)) return { queued: false, reason: 'excluded:suppressed' }
  if (intents.has('wrong_number') || ['wrong_number', 'wrong_person'].includes(disp)) return { queued: false, reason: 'excluded:wrong_number' }
  if ([...intents].some((i) => DENIAL.has(i)) || disp === 'sold') return { queued: false, reason: 'excluded:ownership_denied' }
  const recovery = lower(row.recovery_class)
  const live = LIVE.has(lower(row.status))
  if (!live && !RECOVERABLE.has(recovery)) return { queued: false, reason: 'excluded:not_live_no_recovery_finding' }
  const need = valuationNeed(row, { now })
  if (!need.needs) return { queued: false, reason: `current:${need.reason}` }

  const ask = num(row.asking_price)
  const plausible = ask > 0 ? assessDealAmount(ask, { estimated_value: null, arv: null }).plausible : false
  const reasons = [need.reason]
  let cls = 'investigate_missing_financials'
  if (live && (NEGOTIATION_STAGES.has(lower(row.stage)) || num(row.offers_sent) > 0 || num(row.current_offer) > 0)) { cls = 'active_negotiation'; reasons.push(num(row.offers_sent) > 0 ? 'offer_on_record' : `stage:${lower(row.stage)}`) }
  else if (live && [...intents].some((i) => OFFER_REQUEST.has(i))) { cls = 'offer_request'; reasons.push('seller_asked_for_offer') }
  else if (live && plausible && ([...intents].some((i) => INTEREST.has(i)) || lower(row.stage) === 'asking_price')) { cls = 'motivated_plausible_ask'; reasons.push('plausible_seller_stated_ask') }
  else if (RECOVERABLE.has(recovery)) { cls = 'recoverable_conversation'; reasons.push(`recovery:${recovery}`) }
  else reasons.push(row.economics_class ? `economics:${lower(row.economics_class)}` : 'no_current_financials')
  return { queued: true, class: cls, rank: VALUATION_PRIORITY_CLASSES.indexOf(cls), reasons, need: need.reason, activity_at: ms(row.last_activity_at ?? row.updated_at) }
}

/**
 * @param {Array<object>} rows       candidates (duplicates per property allowed; the best class wins)
 * @param {{ now?: number, limit?: number }} [o]
 * @returns {{ version, entries: Array<{ property_id, opportunity_id, class, rank, reasons, need }>, excluded: Record<string, number>, by_class: Record<string, number>, considered: number }}
 */
export function buildValuationQueue(rows = [], { now = Date.now(), limit = VALUATION_QUEUE_LIMITS.default_limit } = {}) {
  const cap = Math.min(Math.max(Math.trunc(Number(limit) || VALUATION_QUEUE_LIMITS.default_limit), 1), VALUATION_QUEUE_LIMITS.max_limit)
  const best = new Map()
  const excluded = {}
  for (const r of rows) {
    const c = classifyValuationCandidate(r, { now })
    if (!c.queued) { excluded[c.reason] = (excluded[c.reason] || 0) + 1; continue }
    const pid = String(r.property_id)
    const prev = best.get(pid)
    if (!prev || c.rank < prev.rank || (c.rank === prev.rank && (c.activity_at ?? 0) > (prev.activity_at ?? 0))) best.set(pid, { property_id: pid, opportunity_id: r.opportunity_id ? String(r.opportunity_id) : null, ...c })
  }
  const all = [...best.values()].sort((a, b) => a.rank - b.rank || (b.activity_at ?? 0) - (a.activity_at ?? 0) || (a.property_id < b.property_id ? -1 : 1))
  const by_class = Object.fromEntries(VALUATION_PRIORITY_CLASSES.map((k) => [k, 0]))
  for (const e of all) by_class[e.class] += 1
  return {
    version: VALUATION_QUEUE_VERSION,
    considered: rows.length,
    needing: all.length,
    by_class,
    excluded,
    entries: all.slice(0, cap).map(({ activity_at, queued, ...e }) => e),
  }
}

/** Is a (real or dry-run) engine row offer-ready by tier? (the full gate is evaluateOfferReadiness) */
export const isOfferReadyTier = (tier) => OFFER_READY_TIERS.includes(String(tier || ''))
