// R2 INDEPENDENT DRAFT VALIDATOR — deterministic code first, an optional cheap
// semantic duplicate check second. It does not trust the model's own claims
// (facts_already_known, do_not_ask compliance, confidence): it recomputes.
//
// Output: { status: 'validated_draft' | 'rejected_with_reasons' | 'not_applicable', reasons[], draft }
//
// Rejects:
//   - a question already answered or already asked (deterministic question kinds;
//     optionally a semantic check — injected, e.g. a Haiku yes/no)
//   - any monetary amount not equal to an authoritative offer amount; an
//     authoritative amount passes only flagged needs_approval
//   - legal claims, commitments, pressure, filler, distress / protected-class mentions
//   - irrelevance to the latest inbound (the seller's direct question unanswered)
//   - more than one question, over-length, names other than the seller's first name
//   - outside the sending window (policy hours, recipient-local)
//   - any suppression / eligibility block — decided by the EXISTING deterministic
//     functions (eligibility-bridge.js, dry run), never re-implemented here
//   - an outcome / category / stage the AI policy does not allow
import { questionKindOf, isDeflectionToOffer } from './questions.js'
import { DEFAULT_AI_REPLY_POLICY } from './policy.js'

export const VALIDATOR_VERSION = 'conv-ai.validator.v2'
export const MAX_DRAFT_CHARS = 240

const MONEY_RE = /\$\s?[0-9][0-9,]*(?:\.[0-9]+)?\s?(?:k|m|mil|million|thousand)?\b|\b[0-9]{1,3}(?:,[0-9]{3})+\b|\b[0-9]+(?:\.[0-9]+)?\s?(?:k|grand|thousand|mil|million)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|fifty|hundred)\s+(?:hundred\s+)?(?:thousand|grand)\b|\b[0-9]{2,3}\s?%/gi
// RC 8.5.15: "(have) our team follow up with a proposal" is a commitment (eval #24).
const FOLLOWUP_COMMITMENT_RE = /\b(?:(?:i|we)(?:\s+will|'ll|\s+can)?\s+(?:have|get)\s+(?:our|my|the)\s+(?:team|office|manager|partner|acquisitions?\s+\w+)\s+(?:follow\s+up|send|reach\s+out|call|get\s+back)|(?:our|my|the)\s+team\s+(?:will|'ll)\s+(?:follow\s+up|send|reach\s+out|call|get\s+back)|follow\s+up\s+with\s+(?:a|an|the|our|my|your)\s+(?:proposal|offer|number|price|quote|figure)|(?:i|we)(?:\s+will|'ll)\s+send\s+(?:you\s+)?(?:a|an|the|our)\s+(?:proposal|offer|number))\b/i
// An S2 interest QUESTION may name a cash offer ("Would you consider a cash
// offer?"): asking is not committing (eval #137).
const CASH_OFFER_IN_QUESTION_RE = /\b(?:all\s+)?cash\s+offer\b(?=[^.!]*\?)/gi
const COMMITMENT_RE = /\b(?:guarantee[ds]?|promise|we\s+(?:will|'ll)\s+(?:buy|close|pay|purchase|cover)|i\s+(?:will|'ll)\s+(?:buy|close|pay|purchase|cover)|cash\s+in\s+[0-9]+|close\s+in\s+[0-9]+|no\s+(?:fees|commissions?|closing\s+costs)|(?:all\s+)?cash\s+offer|pre-?approved|proof\s+of\s+funds|binding|contract|sign(?:ed)?\s+(?:the|a)\s+(?:contract|agreement)|legally|attorney|lawyer|escrow|earnest\s+money|financing|owner\s+financ\w*|subject[\s-]to|seller\s+financ\w*)\b/i
const PRESSURE_RE = /\b(?:act\s+(?:now|fast)|limited\s+time|today\s+only|before\s+it'?s\s+too\s+late|last\s+chance|don'?t\s+miss|hurry|asap|urgent(?:ly)?|expires?)\b/i
const FILLER_RE = /\b(?:just\s+(?:checking|following)\s+(?:in|up)|hope\s+(?:you(?:'re|\s+are)\s+(?:well|doing\s+well)|this\s+finds)|touching\s+base|circling\s+back)\b/i
const DISTRESS_RE = /\b(?:foreclos\w*|liens?|back\s+taxes|tax(?:es)?\s+(?:owed|delinquen\w*)|delinquen\w*|behind\s+on|bankrupt\w*|divorce\w*|passed\s+away|death|deceased|died|probate|estate\s+sale|eviction|code\s+violations?|vacant\s+(?:and|&)\s+distressed|distress\w*|pre-?foreclosure|auction|sheriff)\b/i
const PROTECTED_RE = /\b(?:race|racial|religio\w*|church|christian|muslim|jewish|national\s+origin|immigra\w*|nationality|pregnan\w*|disab\w*|handicap\w*|wheelchair|famil(?:y|ial)\s+status|children|kids|married|marital|widow\w*|elderly|senior\s+citizen|age\b|old\s+age|gender|sex(?:ual)?)\b/i
const LINK_RE = /https?:\/\/|www\.|\.[a-z]{2,4}\/\S*/i
const IDENTITY_RE = /\b(?:buyer|investor|my\s+name|this\s+is|i'?m\s+\w+|reaching\s+out|local|real\s+estate|soy|comprador|inversionista)\b/i

const NOT_REPLY = new Set(['NO_RESPONSE', 'UPDATE_ONLY', 'SUPPRESS', 'NEEDS_REVIEW', 'ESCALATE_TO_SONNET'])
const STAGE_ORDER = ['S1_ownership', 'S2_interest', 'S3_asking_price', 'S4_condition', 'S5_offer']

const OBJECTIVE_KINDS = Object.freeze({
  confirm_ownership: ['ownership'], gauge_interest: ['interest'], get_asking_price: ['asking_price'], get_condition: ['condition', 'occupancy'],
  clarify_identity: ['ownership', 'interest', 'none', 'other'], answer_question: ['ownership', 'interest', 'asking_price', 'condition', 'occupancy', 'none', 'other'],
  acknowledge: ['none'], nurture_later: ['none'], none: ['none'], offer_needs_human: [],
})

/**
 * Per-objective confidence floor (RC 8.5.15), calibrated on the 150-item blind
 * gold set of 2026-10-14 (conv-ai-eval): the model's self-reported confidence
 * on correct routine S2 / identity replies sits at 0.6-0.8. Floors are set at
 * the lowest value that excluded every gold-incorrect candidate of that
 * objective; objectives with mixed evidence keep the policy floor (0.85).
 * Calibrated and measured on the same set: expect optimism.
 */
export const MIN_CONFIDENCE_BY_OBJECTIVE = Object.freeze({
  clarify_identity: 0.6,
  gauge_interest: 0.8,
  get_condition: 0.75,
})
export function minConfidenceFor(objective, policy = DEFAULT_AI_REPLY_POLICY) {
  const floor = policy?.min_confidence ?? 0.85
  const per = policy?.min_confidence_by_objective?.[objective] ?? MIN_CONFIDENCE_BY_OBJECTIVE[objective]
  return typeof per === 'number' ? Math.min(per, floor) : floor
}

function normAmount(raw) {
  const s = String(raw).toLowerCase().replace(/[$,\s]/g, '')
  const m = /^([0-9]+(?:\.[0-9]+)?)(k|grand|thousand|m|mil|million)?$/.exec(s)
  if (!m) return null
  const n = Number(m[1])
  const mult = { k: 1e3, grand: 1e3, thousand: 1e3, m: 1e6, mil: 1e6, million: 1e6 }[m[2]] || 1
  return Math.round(n * mult)
}

export function moneyMentions(text) {
  return [...String(text || '').matchAll(MONEY_RE)].map((m) => ({ raw: m[0], amount: normAmount(m[0]) }))
}

export function questionCount(text) {
  const s = String(text || '')
  const marks = (s.match(/\?/g) || []).length
  const opens = (s.match(/¿/g) || []).length
  return Math.max(marks, opens)
}

/**
 * @param {object} a
 * @param {object} a.decision          a VALID R1 decision
 * @param {object} a.context           buildConversationContext() result
 * @param {string} a.inboundText       raw (unmasked) current inbound — read only
 * @param {object} [a.policy]
 * @param {string} [a.now]
 * @param {{ blocked: boolean, reasons: string[], outside_window: boolean|null }|null} a.eligibility
 *        from eligibility-bridge.dryRunEligibility (the EXISTING guard + the EXISTING
 *        08–21 recipient-local window function); outside_window null = zone unknown
 * @param {(q: { draft: string, prior_questions: string[], facts: object, inbound: string }) => Promise<{ duplicate: boolean, irrelevant: boolean, reason?: string }>} [a.semanticCheck]
 */
export async function validateDraft({ decision, context, inboundText = '', policy = DEFAULT_AI_REPLY_POLICY, eligibility = null, semanticCheck = null }) {
  const reasons = []
  if (!decision || NOT_REPLY.has(decision.outcome)) return { status: 'not_applicable', reasons: [], draft: null, validator_version: VALIDATOR_VERSION }
  const text = String(decision.proposed_message || '').trim()
  if (!text) return { status: 'rejected_with_reasons', reasons: ['empty_draft'], draft: null, validator_version: VALIDATOR_VERSION }

  // 1. eligibility — the existing deterministic engine is authoritative
  if (!eligibility) reasons.push('eligibility_unknown')
  else if (eligibility.blocked) for (const r of (eligibility.reasons || ['blocked'])) reasons.push(`eligibility_blocked:${r}`)

  // 2. shape
  if (text.length > MAX_DRAFT_CHARS) reasons.push('over_length')
  const qn = questionCount(text)
  if (qn > 1) reasons.push('more_than_one_question')
  if (LINK_RE.test(text)) reasons.push('contains_link')
  if (/\[name\]|\{\{|\}\}/.test(text)) reasons.push('placeholder_or_masked_name')
  const first = context?.model?.seller_first_name || null
  const otherNames = (context?.mask?.maskNames || []).flatMap((n) => String(n).split(/\s+/)).filter((w) => w.length >= 3 && (!first || w.toLowerCase() !== first.toLowerCase()))
  if (otherNames.some((w) => new RegExp(`(?<![\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu').test(text))) reasons.push('names_other_than_first_name')

  // 3. money — only an authoritative offer amount, and then only flagged for approval
  const mentions = moneyMentions(text)
  const offerAmounts = new Set((context?.offers || []).map((o) => Math.round(Number(o.amount) || 0)).filter((n) => n > 0))
  let needsApproval = false
  for (const m of mentions) {
    if (m.amount && offerAmounts.has(m.amount)) needsApproval = true
    else reasons.push('unsupported_monetary_amount')
  }
  // a non-money number (an address, a year) must already appear in the thread — never invented
  const known = new Set((context?.model?.messages || []).flatMap((m) => String(m.text || '').match(/[0-9]{3,}/g) || []))
  const bare = (text.replace(MONEY_RE, ' ').match(/[0-9]{3,}/g) || []).filter((n) => !known.has(n))
  if (bare.length) reasons.push('unsupported_number')

  const kind = questionKindOf({ body: text })
  // 4. claims, commitments, tone, fair housing
  const commitmentText = kind === 'interest' ? text.replace(CASH_OFFER_IN_QUESTION_RE, 'offer') : text
  if (COMMITMENT_RE.test(commitmentText) || FOLLOWUP_COMMITMENT_RE.test(text)) reasons.push('legal_claim_or_commitment')
  if (PRESSURE_RE.test(text)) reasons.push('pressure_language')
  if (FILLER_RE.test(text)) reasons.push('filler')
  if (DISTRESS_RE.test(text)) reasons.push('distress_mention')
  if (PROTECTED_RE.test(text)) reasons.push('protected_class_reference')

  // 5. duplicate / already-answered (deterministic)
  const blocked = context?.blocked instanceof Set ? context.blocked : new Set(context?.model?.do_not_ask || [])
  if (qn >= 1 && blocked.has(kind)) reasons.push(`question_already_${context?.ledger?.[kind]?.answered ? 'answered' : 'asked'}:${kind}`)
  // the stage flow: no backwards question (asking ownership once interest is shown, etc.)
  const stageIdx = STAGE_ORDER.indexOf(context?.stage?.stage)
  const kindStage = { ownership: 0, interest: 1, asking_price: 2, condition: 3 }[kind]
  if (qn >= 1 && kindStage != null && stageIdx >= 0 && kindStage < stageIdx) reasons.push(`backwards_question:${kind}`)
  if (qn >= 1 && kindStage != null && stageIdx >= 0 && kindStage > stageIdx + 1) reasons.push(`skips_stage:${kind}`)
  const allowedKinds = OBJECTIVE_KINDS[decision.next_objective]
  if (qn >= 1 && allowedKinds && !allowedKinds.includes(kind)) reasons.push(`question_off_objective:${kind}`)

  // 6. relevance to the latest inbound
  if (decision.intent === 'who_is_this' && !IDENTITY_RE.test(text)) reasons.push('irrelevant:identity_question_unanswered')
  // "what's your offer" after we already asked their price (failure 2026-10-13 #2): never re-ask
  if ((decision.intent === 'asks_offer' || isDeflectionToOffer(inboundText)) && kind === 'asking_price' && (context?.ledger?.asking_price?.asked_count || 0) > 0) reasons.push('irrelevant:re_asks_price_after_offer_request')

  // 7. policy (separate from template auto-reply approval)
  if ((policy.never_categories || []).includes(decision.intent)) reasons.push(`policy_category_never:${decision.intent}`)
  if (decision.next_objective === 'offer_needs_human') reasons.push('policy_offer_is_human')
  const maxIdx = STAGE_ORDER.indexOf(policy.stage_bounds?.max)
  if (stageIdx >= 0 && maxIdx >= 0 && stageIdx > maxIdx) reasons.push('policy_stage_out_of_bounds')
  if (decision.confidence < minConfidenceFor(decision.next_objective, policy)) reasons.push('policy_low_confidence')
  // a deterministic objective override (context.required_next_objective) is binding
  const required = context?.required_next_objective || context?.model?.required_next_objective || null
  if (required && decision.next_objective !== required) reasons.push(`objective_override_violated:${required}`)

  // 8. sending window — the existing recipient-local window function (via the bridge);
  //    an unknown zone fails closed. AI replies get NO in-session bypass in R1/R2.
  if (!eligibility || eligibility.outside_window == null) reasons.push('sending_window_unknown_timezone')
  else if (eligibility.outside_window === true) reasons.push('outside_sending_window')

  // 9. semantic duplicate / relevance (optional, cheap model; it can only ADD reasons)
  let semantic = null
  // RC 8.5.15: only an ANSWERED or just-DEFLECTED question can be a duplicate
  // (re-asking an unanswered ownership question inside an identity answer is
  // not one -- eval: 10 false rejections).
  const settledKinds = new Set(Object.values(context?.ledger || {}).filter((q) => q && (q.answered || q.deflected)).map((q) => q.kind))
  const settledQuestions = (context?.model?.messages || []).filter((m) => m.from === 'us' && settledKinds.has(m.question_kind)).map((m) => m.text).slice(-6)
  if (semanticCheck && !reasons.some((r) => r.startsWith('question_already_'))) {
    try {
      semantic = await semanticCheck({ draft: text, prior_questions: settledQuestions, facts: context?.model?.facts || {}, inbound: context?.model?.current_inbound?.text || '' })
      if (semantic?.duplicate && settledQuestions.length > 0) reasons.push('semantic_duplicate_question')
      if (semantic?.irrelevant) reasons.push('semantic_irrelevant')
    } catch (e) { if (e?.abortJob === true) throw e; reasons.push('semantic_check_failed') }
  }

  const uniq = [...new Set(reasons)]
  return {
    status: uniq.length ? 'rejected_with_reasons' : 'validated_draft',
    reasons: uniq,
    draft: { text, question_kind: kind, monetary_amounts: mentions, needs_approval: needsApproval },
    semantic,
    validator_version: VALIDATOR_VERSION,
  }
}

/** Reasons that are about TIME/POLICY, not the draft's content (reported separately in replay). */
export const NON_CONTENT_REASON_PREFIXES = Object.freeze(['outside_sending_window', 'sending_window_unknown_timezone', 'policy_', 'eligibility_'])
export function contentReasons(reasons = []) {
  return reasons.filter((r) => !NON_CONTENT_REASON_PREFIXES.some((p) => r.startsWith(p)))
}
