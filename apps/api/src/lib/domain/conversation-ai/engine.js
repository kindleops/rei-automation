// Conversation Engine 2.0 — R1 + R2 shadow pipeline for ONE inbound message.
//
//   gate (policy + env + kill switch) → idempotency (one decision per inbound id)
//   → context → R1 understand → R2 compose (decision.proposed_message, normalised)
//   → independent validator (eligibility via the EXISTING engine, dry run)
//   → shadow record (send_status 'not_sent_shadow') → store.put (insert-if-absent)
//
// NOTHING here sends. This module imports no transport, queue or send service
// (static test: conversation-ai-no-send-path). There is no code path from a
// shadow record to a send in R1/R2.
import { ContextError, buildConversationContext, deriveStageEvidence } from './context-builder.js'
import { failClosedDecision } from './contract.js'
import { mergeModelFacts } from './facts.js'
import { maskText } from './pii.js'
import { DEFAULT_AI_REPLY_POLICY, assertSendAllowed, normalizePolicy, shadowAllowed } from './policy.js'
import { buildShadowRecord, idempotencyKeyFor } from './shadow-record.js'
import { understandInbound } from './understand.js'
import { validateDraft } from './validator.js'
import { blockedQuestionKinds, questionLedger } from './questions.js'
import { ledgerFromContextInput } from './fact-ledger.js'

export const ENGINE_VERSION = 'conv-ai.engine.v1'

/** In-process single-flight + memo keyed by the idempotency key (a store adds cross-process uniqueness). */
export function createMemoryShadowStore() {
  const rows = new Map()
  return {
    async get(key) { return rows.get(key) || null },
    async putIfAbsent(record) {
      if (rows.has(record.idempotency_key)) return { inserted: false, record: rows.get(record.idempotency_key) }
      rows.set(record.idempotency_key, record)
      return { inserted: true, record }
    },
    all: () => [...rows.values()],
  }
}

const inflight = new Map()

/** R2 composition: the model's proposed_message, normalised (whitespace, quotes, trailing filler). */
export function composeDraft(decision) {
  if (!decision?.proposed_message) return null
  let t = String(decision.proposed_message).replace(/\s+/g, ' ').replace(/^["'“”]+|["'“”]+$/g, '').trim()
  t = t.replace(/\s*(?:thanks!?|thank you!?)\s*$/i, (m) => (t.length > 120 ? '' : m)).trim()
  return t || null
}

/**
 * @param {object} a
 * @param {object} a.input           buildConversationContext() arguments (rows already loaded)
 * @param {object|null} a.deterministic  { intent, compliance_flag, confidence, plan? } from the existing engine
 * @param {(draft: object) => Promise<{ blocked: boolean, reasons: string[] }>|{ blocked: boolean, reasons: string[] }} a.eligibilityFor
 *        dry-run call into the EXISTING eligibility functions (eligibility-bridge.js)
 * @param {object|null} a.modelClient
 * @param {object} [a.policy]
 * @param {object} [a.env]
 * @param {object} [a.store]
 * @param {Function|null} [a.semanticCheck]
 * @param {() => number} [a.clock]
 */
export async function runConversationAiShadow({ input, deterministic = null, eligibilityFor = null, modelClient = null, policy = DEFAULT_AI_REPLY_POLICY, env = process.env, store = null, semanticCheck = null, clock = () => Date.now() }) {
  const p = normalizePolicy(policy)
  const gate = shadowAllowed(p, env)
  if (!gate.allowed) return { ran: false, code: gate.code }
  const key = idempotencyKeyFor(input?.inbound?.id)
  if (store) {
    const existing = await store.get(key)
    if (existing) return { ran: false, code: 'DUPLICATE_INBOUND', record: existing }
  }
  if (inflight.has(key)) return { ran: false, code: 'DUPLICATE_INBOUND_INFLIGHT', record: await inflight.get(key) }
  const job = (async () => {
    const t0 = clock()
    const now = input.now || new Date(t0).toISOString()
    // the EXISTING deterministic eligibility verdict, dry run, BEFORE any model call
    let eligibility = input.eligibility || null
    if (!eligibility && eligibilityFor) {
      try { eligibility = await eligibilityFor({ now }) } catch { eligibility = { blocked: true, reasons: ['eligibility_check_failed'], outside_window: null } }
    }
    let context
    try {
      context = buildConversationContext({ ...input, eligibility, deterministic, now })
    } catch (err) {
      const code = err instanceof ContextError ? err.code : 'CONTEXT_FAILED'
      const decision = failClosedDecision({ errors: [code], sourceMessageIds: [String(input.inbound.id)], producedBy: 'context' })
      return buildShadowRecord({ inboundMessageId: input.inbound.id, threadRef: null, createdAt: now, sellerMessageMasked: maskText(input.inbound.body), decision, path: 'context_error', latencyMs: clock() - t0, policyCode: assertSendAllowed(p).code, deterministic })
    }
    const r1 = await understandInbound({ context, inboundText: input.inbound.body, inboundId: input.inbound.id, deterministic, eligibility, modelClient })
    const decision = r1.decision
    // post-decision ledgers: merge validated model facts, so "already answered" includes THIS message
    const facts = mergeModelFacts(context.facts, decision.facts_extracted, { inboundIds: new Set(context.inbound_ids), atById: context.at_by_id })
    const ledger = questionLedger((input.thread || []).concat([]), facts)
    const ctxAfter = { ...context, facts, ledger: { ...context.ledger, ...Object.fromEntries(Object.entries(ledger).map(([k, v]) => [k, { ...context.ledger[k], answered: context.ledger[k].answered || v.answered }])) } }
    ctxAfter.blocked = new Set([...context.blocked, ...blockedQuestionKinds(ctxAfter.ledger)])
    // the stage AFTER this inbound (deterministic + validated model facts), never behind the stage before it
    const after = deriveStageEvidence({ facts, ledger: ctxAfter.ledger, offers: context.offers })
    const ORDER = ['S1_ownership', 'S2_interest', 'S3_asking_price', 'S4_condition', 'S5_offer']
    ctxAfter.stage = ORDER.indexOf(after.stage) >= ORDER.indexOf(context.stage.stage) || !ORDER.includes(context.stage.stage) ? after : context.stage
    const draftText = composeDraft(decision)
    let validation = { status: 'not_applicable', reasons: [] }
    if (decision.outcome === 'REPLY_CANDIDATE' && draftText) {
      // 8.5.16: the canonical fact + question ledger (validated model facts merged) also judges the draft
      const factLedger = ledgerFromContextInput(input, { modelFacts: decision.facts_extracted, now })
      validation = await validateDraft({ decision: { ...decision, proposed_message: draftText }, context: ctxAfter, inboundText: input.inbound.body, policy: p, eligibility, semanticCheck, factLedger })
      if (validation.semantic?.call) r1.calls.push({ ...validation.semantic.call, route: 'semantic_check' })
    }
    return buildShadowRecord({
      inboundMessageId: input.inbound.id,
      threadRef: context.thread_ref,
      propertyIds: context.property_ids,
      createdAt: now,
      sellerMessageMasked: context.model.current_inbound.text,
      decision,
      path: r1.trace.path,
      models: r1.calls.map((c) => c.model).filter(Boolean),
      calls: r1.calls,
      draft: draftText ? { text: draftText, monetary_amounts: validation.draft?.monetary_amounts || [], needs_approval: validation.draft?.needs_approval } : null,
      validation: { status: validation.status, reasons: validation.reasons, question_kind: validation.draft?.question_kind ?? null },
      deterministic,
      latencyMs: clock() - t0,
      policyCode: assertSendAllowed(p).code,
      contextSummary: { eligibility: eligibility ? { blocked: eligibility.blocked, reasons: eligibility.reasons, outside_window: eligibility.outside_window ?? null, in_session: eligibility.in_session ?? null } : null, stage: context.stage, do_not_ask: [...context.blocked], facts: Object.keys(context.model.facts), message_count: context.message_ids.length, trace: r1.trace },
    })
  })()
  inflight.set(key, job)
  try {
    const record = await job
    if (store) {
      const put = await store.putIfAbsent(record)
      return { ran: put.inserted, code: put.inserted ? 'SHADOW_RECORDED' : 'DUPLICATE_INBOUND', record: put.record }
    }
    return { ran: true, code: 'SHADOW_RECORDED', record }
  } finally {
    inflight.delete(key)
  }
}
