// R1 CANONICAL CONTEXT BUILDER — pure, bounded, single-thread.
//
// Input: rows already read (by context-loader.js in prod shadow, by the replay
// harness offline). Output: one model-facing context object, masked, with every
// message carrying its id, plus the deterministic ledgers the validator reuses.
//
// It NEVER mixes threads, phones or properties: every message must carry the
// inbound's thread_key and seller phone; a row that does not is a hard error
// (CONTEXT_MIXED) — the caller fails closed to NEEDS_REVIEW, it never "filters
// and continues", because a mixed read means the loader is wrong.
import { buildFactLedger, factSummary } from './facts.js'
import { blockedQuestionKinds, isDeflectionToOffer, questionKindOf, questionLedger } from './questions.js'
import { firstNameOnly, maskText, threadRef } from './pii.js'

export const CONTEXT_VERSION = 'conv-ai.context.v1'
export const MAX_THREAD_MESSAGES = 16
export const MAX_MESSAGE_CHARS = 480

export class ContextError extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail }
}

const digits = (p) => String(p ?? '').replace(/[^0-9]/g, '').slice(-10)

/**
 * Evidence-based conversation stage (S1–S5) from facts, questions and offers.
 * A projection, not a stored stage: every step names the evidence ids.
 */
export function deriveStageEvidence({ facts, ledger, offers = [] }) {
  const ev = (slot) => (slot?.current?.source_message_id ? [slot.current.source_message_id] : [])
  const own = facts.ownership?.current?.value
  if (own === 'denied') return { stage: 'closed', evidence_message_ids: ev(facts.ownership), rationale: 'respondent denied ownership / wrong person' }
  const interest = facts.seller_interest?.current?.value
  if (interest === 'not_interested') return { stage: 'nurture', evidence_message_ids: ev(facts.seller_interest), rationale: 'latest seller statement is not interested (30-day nurture, not suppressed)' }
  if (offers.some((o) => o.amount > 0)) return { stage: 'S5_offer', evidence_message_ids: [], rationale: `authoritative offer record(s): ${offers.length}` }
  const priceKnown = facts.asking_price?.current != null
  const priceDeflected = ledger.asking_price.deflected
  const conditionKnown = facts.condition?.current != null
  if ((priceKnown || priceDeflected) && conditionKnown) return { stage: 'S5_offer', evidence_message_ids: [...ev(facts.asking_price), ...ev(facts.condition), ...ledger.asking_price.deflection_message_ids].slice(0, 12), rationale: 'asking price (or deflection) and condition both on record; offer is a human step' }
  if (priceKnown || priceDeflected) return { stage: 'S4_condition', evidence_message_ids: [...ev(facts.asking_price), ...ledger.asking_price.deflection_message_ids].slice(0, 12), rationale: priceKnown ? 'asking price stated' : 'seller deflected the asking-price question (never re-ask)' }
  if (interest === 'interested' || interest === 'conditional' || ledger.asking_price.asked_count > 0) return { stage: 'S3_asking_price', evidence_message_ids: ev(facts.seller_interest), rationale: 'interest shown or asking price already requested' }
  if (own === 'confirmed' || ledger.interest.asked_count > 0) return { stage: 'S2_interest', evidence_message_ids: ev(facts.ownership), rationale: own === 'confirmed' ? 'ownership confirmed' : 'interest question already asked' }
  return { stage: 'S1_ownership', evidence_message_ids: [], rationale: 'no ownership evidence yet' }
}

/**
 * @param {object} a
 * @param {{ id: string, body: string, at: string, thread_key: string, from_phone: string, property_id?: string|null }} a.inbound
 * @param {Array<{ id: string, direction: 'inbound'|'outbound', body: string, at: string, thread_key: string, seller_phone: string, use_case?: string|null, property_id?: string|null, intent?: string|null }>} a.thread chronological; may include the inbound
 * @param {Array<{ property_id: string, property_type?: string|null, units?: number|null, city?: string|null, state?: string|null }>} [a.properties]
 * @param {Array<{ id: string, amount: number|null, status?: string|null, created_at?: string|null, source_table: string }>} [a.offers] authoritative offer rows only
 * @param {Array<{ use_case: string, due_at: string, status?: string }>} [a.followups]
 * @param {{ blocked: boolean, reasons: string[], window_open?: boolean|null }} [a.eligibility] from the deterministic engine
 * @param {{ intent: string|null, confidence: number|null }} [a.deterministic]
 * @param {{ full_names?: string[], first_name?: string|null }} [a.names]
 * @param {string|null} [a.language]
 * @param {string} [a.now]
 */
export function buildConversationContext({
  inbound, thread = [], properties = [], offers = [], followups = [], eligibility = null, deterministic = null,
  names = {}, language = null, recordFacts = {}, now = new Date().toISOString(),
}) {
  if (!inbound?.id || !inbound.thread_key) throw new ContextError('INBOUND_REQUIRED')
  const phone = digits(inbound.from_phone)
  const rows = [...thread]
  if (!rows.some((m) => m.id === inbound.id)) rows.push({ ...inbound, direction: 'inbound', seller_phone: inbound.from_phone })
  for (const m of rows) {
    if (m.thread_key !== inbound.thread_key) throw new ContextError('CONTEXT_MIXED', { reason: 'thread_key' })
    if (phone && digits(m.seller_phone) && digits(m.seller_phone) !== phone) throw new ContextError('CONTEXT_MIXED', { reason: 'phone' })
  }
  const propIds = new Set(properties.map((p) => String(p.property_id)))
  if (inbound.property_id && propIds.size && !propIds.has(String(inbound.property_id))) throw new ContextError('CONTEXT_MIXED', { reason: 'property' })
  for (const o of offers) if (o.property_id && propIds.size && !propIds.has(String(o.property_id))) throw new ContextError('CONTEXT_MIXED', { reason: 'offer_property' })

  // chronological, bounded to the inbound and what came before it (never a later message)
  const t = (x) => Date.parse(x.at || 0) || 0
  const inboundAt = t(inbound)
  const ordered = rows.filter((m) => t(m) <= inboundAt || m.id === inbound.id).sort((a, b) => t(a) - t(b) || (a.id === inbound.id ? 1 : b.id === inbound.id ? -1 : 0))
  const sellerMsgs = ordered.filter((m) => m.direction === 'inbound')
  const facts = buildFactLedger({ inbound: sellerMsgs.map((m) => ({ id: m.id, body: m.body, at: m.at, intent: m.id === inbound.id ? deterministic?.intent ?? m.intent : m.intent })), recordFacts, now })
  const ledger = questionLedger(ordered, facts)
  const blocked = blockedQuestionKinds(ledger)
  const stage = deriveStageEvidence({ facts, ledger, offers })

  // A placeholder name on an internal / test record ("Internal", "Test") is not
  // a seller's name (eval #128 drafted "Hi Internal…").
  const rawFirst = firstNameOnly(names.first_name || null)
  const firstName = rawFirst && PLACEHOLDER_FIRST_NAME_RE.test(rawFirst) ? null : rawFirst
  // OUR last question before this inbound -- every reply is read against it.
  const lastOutbound = [...ordered].reverse().find((m) => m.direction === 'outbound' && m.id !== inbound.id) || null
  const lastQuestionKind = lastOutbound ? questionKindOf(lastOutbound) : 'none'
  const requiredNextObjective = requiredObjectiveFor({ inboundText: inbound.body, ledger, facts, deterministic })
  const maskOpts = { maskNames: names.full_names || [], keepFirstName: firstName }
  const recent = ordered.slice(-MAX_THREAD_MESSAGES)
  const messageIds = recent.map((m) => m.id)
  const inboundIds = recent.filter((m) => m.direction === 'inbound').map((m) => m.id)
  const pref = new Map(properties.map((p, i) => [String(p.property_id), `P${i + 1}`]))

  const model = {
    context_version: CONTEXT_VERSION,
    now,
    language: language || null,
    seller_first_name: firstName,
    last_question_kind: lastQuestionKind,
    ...(requiredNextObjective ? { required_next_objective: requiredNextObjective } : {}),
    current_inbound: { id: inbound.id, at: inbound.at, text: maskText(inbound.body, maskOpts).slice(0, MAX_MESSAGE_CHARS) },
    messages: recent.map((m) => ({
      id: m.id,
      from: m.direction === 'inbound' ? 'seller' : 'us',
      at: m.at,
      text: maskText(m.body, maskOpts).slice(0, MAX_MESSAGE_CHARS),
      ...(m.direction === 'outbound' ? { question_kind: questionKindOf(m) } : {}),
    })),
    prior_questions: Object.values(ledger).filter((q) => q.asked_count > 0 || q.deflected).map((q) => ({ kind: q.kind, asked_count: q.asked_count, answered: q.answered, deflected: q.deflected })),
    do_not_ask: [...blocked],
    facts: factSummary(facts),
    ownership_status: facts.ownership?.current?.value ?? 'unknown',
    properties: properties.map((p) => ({ ref: pref.get(String(p.property_id)), property_type: p.property_type || null, units: p.units ?? null, city: p.city || null, state: p.state || null })),
    stage_evidence: stage,
    asking_price_history: (facts.asking_price?.history || []).filter((h) => h.origin === 'seller_stated').map((h) => ({ amount: h.value?.amount ?? null, source_message_id: h.source_message_id, at: h.at })),
    condition: facts.condition?.current?.value ?? null,
    offers: offers.map((o, i) => ({ offer_ref: `O${i + 1}`, amount: o.amount ?? null, status: o.status || null, at: o.created_at || null, property_ref: o.property_id ? pref.get(String(o.property_id)) || null : null })),
    scheduled_followups: followups.map((f) => ({ use_case: f.use_case, due_at: f.due_at, status: f.status || 'scheduled' })),
    eligibility: eligibility ? { blocked: Boolean(eligibility.blocked), reasons: (eligibility.reasons || []).slice(0, 8), window_open: eligibility.window_open ?? null } : { blocked: null, reasons: ['eligibility_unknown'], window_open: null },
    deterministic_classification: deterministic ? { intent: deterministic.intent ?? null, confidence: deterministic.confidence ?? null } : null,
  }
  return {
    model,
    thread_ref: threadRef(inbound.thread_key),
    message_ids: messageIds,
    inbound_ids: inboundIds,
    facts,
    ledger,
    blocked,
    stage,
    offers,
    property_ids: [...propIds],
    at_by_id: Object.fromEntries(recent.map((m) => [m.id, m.at])),
    mask: maskOpts,
    last_question_kind: lastQuestionKind,
    required_next_objective: requiredNextObjective,
  }
}

const PLACEHOLDER_FIRST_NAME_RE = /^(?:internal|test|tester|testing|unknown|owner|homeowner|resident|seller|n\/?a|none|null|undefined|qa|demo)$/i

/**
 * Deterministic objective override (eval #14, #92): once we asked the asking
 * price and the seller asks for OUR offer instead, the price is never asked
 * again -- condition next, or a human when condition is already known.
 */
export function requiredObjectiveFor({ inboundText = '', ledger = null, facts = {}, deterministic = null } = {}) {
  const askedPrice = (ledger?.asking_price?.asked_count || 0) > 0
  if (!askedPrice || facts?.asking_price?.current) return null
  const offerRequest = deterministic?.intent === 'asks_offer' || isDeflectionToOffer(inboundText)
  if (!offerRequest) return null
  return facts?.condition?.current ? 'offer_needs_human' : 'get_condition'
}
