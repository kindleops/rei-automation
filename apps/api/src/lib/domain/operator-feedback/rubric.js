// ─── SCORING RUBRIC (8.5.19 Phase 10) ────────────────────────────────────────
// Offline scoring of an AI turn against reviewed expectations. Pure functions;
// every score is in [0, 1] or null (not applicable / no expectation recorded).
//
//   intent                     predicted intent == reviewer's expected intent
//   next_action                predicted next objective / outcome == expected
//   known_facts_used           the draft does not ask for a fact already on record
//   tone_match                 token overlap of the AI draft with what the operator sent
//   repetition                 the draft does not repeat one of our earlier messages
//   question_usefulness        the draft's question advances the expected objective
//   authorization_respected    every amount in the draft is the position's authorized amount
//   economic_mismatch          the turn does not push an offer on PASS / NURTURE economics
//   escalation_appropriate     escalated iff the position / reviewer says escalate
//   model_cost                 within the per-decision budget
import { questionKindOf } from '../conversation-ai/questions.js'

export const RUBRIC_VERSION = 'ai-rubric.v1'
export const RUBRIC_DIMENSIONS = Object.freeze(['intent', 'next_action', 'known_facts_used', 'tone_match', 'repetition', 'question_usefulness', 'authorization_respected', 'economic_mismatch', 'escalation_appropriate', 'model_cost'])
export const DEFAULT_COST_BUDGET_USD = 0.02

const tokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^\p{L}\p{N}$\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1))
export function jaccard(a, b) {
  const A = tokens(a)
  const B = tokens(b)
  if (!A.size && !B.size) return 1
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / (A.size + B.size - inter)
}
const r3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000)

const MONEY_RE = /\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s?(k|m)?\b|\b([0-9]{1,3}(?:,[0-9]{3})+)\b|\b([0-9]+(?:\.[0-9]+)?)\s?(k|m)\b/gi
/** Dollar amounts stated in a draft. */
export function amountsIn(text) {
  const out = []
  for (const m of String(text || '').matchAll(MONEY_RE)) {
    const raw = m[1] || m[3] || m[4]
    const unit = (m[2] || m[5] || '').toLowerCase()
    let v = Number(String(raw).replace(/,/g, ''))
    if (unit === 'k') v *= 1_000
    if (unit === 'm') v *= 1_000_000
    if (Number.isFinite(v) && v >= 1_000) out.push(Math.round(v))
  }
  return out
}

export const scoreIntent = (predicted, expected) => (expected == null ? null : predicted === expected ? 1 : 0)
export const scoreNextAction = (predicted, expected) => (expected == null ? null : predicted === expected ? 1 : 0)

/** 0 when the draft asks for a fact already known / blocked (do_not_ask), else 1. */
export function scoreKnownFactsUsed({ draft, known_facts = [], do_not_ask = [] }) {
  if (!draft) return null
  const kind = questionKindOf({ body: draft })
  if (kind === 'none' || kind === 'other') return 1
  return known_facts.includes(kind) || do_not_ask.includes(kind) ? 0 : 1
}

/** 1 = sent unchanged; edited drafts score their overlap; rejected = 0. */
export function scoreToneMatch({ draft, final, verdict }) {
  if (verdict === 'rejected') return 0
  if (!draft || !final) return verdict === 'approved' ? 1 : null
  return r3(jaccard(draft, final))
}

/** 1 − max overlap with our earlier outbound messages (≥ 0.8 overlap ⇒ 0). */
export function scoreRepetition({ draft, prior_outbound = [] }) {
  if (!draft) return null
  const worst = prior_outbound.reduce((m, p) => Math.max(m, jaccard(draft, p)), 0)
  return worst >= 0.8 ? 0 : r3(1 - worst)
}

const OBJECTIVE_KIND = Object.freeze({ confirm_ownership: 'ownership', gauge_interest: 'interest', get_asking_price: 'asking_price', get_condition: 'condition' })
/** Does the draft's question serve the expected objective? */
export function scoreQuestionUsefulness({ draft, expected_objective = null, do_not_ask = [] }) {
  if (!draft || !expected_objective) return null
  const kind = questionKindOf({ body: draft })
  if (do_not_ask.includes(kind)) return 0
  const want = OBJECTIVE_KIND[expected_objective]
  if (!want) return kind === 'none' || kind === 'other' ? 1 : 0.5
  return kind === want ? 1 : kind === 'none' ? 0.25 : 0
}

/** Every amount in the draft must equal the authorized move amount of a within_authority position. */
export function scoreAuthorizationRespected({ draft, position = null }) {
  if (!draft) return null
  const amounts = amountsIn(draft)
  if (!amounts.length) return 1
  if (position?.status !== 'within_authority' || position?.move?.amount == null) return 0
  return amounts.every((a) => a === Math.round(position.move.amount)) ? 1 : 0
}

/** Offering into PASS / NURTURE economics (or not offering on HOT when asked) is a mismatch. */
export function scoreEconomicMismatch({ economics_class = null, proposes_offer = false, seller_asked_for_offer = false }) {
  if (!economics_class) return null
  if (proposes_offer && ['PASS', 'NURTURE', 'INVESTIGATE'].includes(economics_class)) return 0
  if (!proposes_offer && economics_class === 'HOT' && seller_asked_for_offer) return 0.5
  return 1
}

export function scoreEscalation({ escalated, expected_escalation = null, position_status = null }) {
  const expected = expected_escalation ?? (position_status ? position_status === 'escalate' : null)
  if (expected == null) return null
  return Boolean(escalated) === Boolean(expected) ? 1 : 0
}

export function scoreModelCost(cost_usd, budget = DEFAULT_COST_BUDGET_USD) {
  if (cost_usd == null) return null
  const c = Number(cost_usd)
  if (c <= budget) return 1
  if (c >= budget * 3) return 0
  return r3(1 - (c - budget) / (budget * 2))
}

/**
 * Score one eval item. `turn` is what the AI produced (from the 8.5.16 record), `item` the
 * reviewed eval-set item (labels = expectations).
 */
export function scoreItem({ item = {}, turn = {} }) {
  const L = item.labels || {}
  const draft = turn.draft ?? item.draft ?? null
  const scores = {
    intent: scoreIntent(turn.intent ?? null, L.expected_intent ?? null),
    next_action: scoreNextAction(turn.next_action ?? null, L.expected_next_action ?? null),
    known_facts_used: scoreKnownFactsUsed({ draft, known_facts: turn.known_facts || [], do_not_ask: turn.do_not_ask || [] }),
    tone_match: scoreToneMatch({ draft, final: item.final ?? null, verdict: item.verdict }),
    repetition: scoreRepetition({ draft, prior_outbound: turn.prior_outbound || [] }),
    question_usefulness: scoreQuestionUsefulness({ draft, expected_objective: L.expected_next_action ?? turn.expected_objective ?? null, do_not_ask: turn.do_not_ask || [] }),
    authorization_respected: scoreAuthorizationRespected({ draft, position: turn.position || null }),
    economic_mismatch: scoreEconomicMismatch({ economics_class: turn.economics_class ?? null, proposes_offer: Boolean(turn.proposes_offer ?? amountsIn(draft).length), seller_asked_for_offer: Boolean(turn.seller_asked_for_offer) }),
    escalation_appropriate: scoreEscalation({ escalated: turn.escalated, expected_escalation: L.expected_escalation ?? null, position_status: turn.position?.status ?? null }),
    model_cost: scoreModelCost(turn.cost_usd ?? item.cost_usd ?? null),
  }
  const vals = Object.values(scores).filter((v) => v != null)
  const hardFail = scores.authorization_respected === 0
  return { rubric_version: RUBRIC_VERSION, item_id: item.item_id ?? null, scores, applicable: vals.length, mean: vals.length ? r3(vals.reduce((s, v) => s + v, 0) / vals.length) : null, hard_fail: hardFail ? ['authorization_respected'] : [] }
}
