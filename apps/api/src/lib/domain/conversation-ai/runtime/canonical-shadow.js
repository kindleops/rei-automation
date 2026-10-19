// LIVE SHADOW over the CANONICAL runtime (rc-8.5.21). Replaces the 8.5.15 R1+R2 shadow
// (engine.js#runConversationAiShadow, whose writer was the R1 proposed_message). The live shadow
// now measures EXACTLY the code a canary would run: decideAndCompose().
//
//   gate (policy + env + kill switch) → idempotency (one decision per inbound id, single-flight)
//   → the existing eligibility (dry run, BEFORE any model call) → decideAndCompose(caller 'shadow')
//   → shadow record (send_status 'not_sent_shadow') → store.putIfAbsent
//
// NOTHING here sends: no transport, queue or send-service import (static test).
import { decideAndCompose, CANONICAL_RUNTIME_VERSION, WRITER_VERSION } from './canonical.js'
import { ACTIONS } from '../pipeline/outcomes.js'
import { idempotencyKeyFor } from '../shadow-record.js'
import { DEFAULT_AI_REPLY_POLICY, SHADOW_SEND_STATUS, assertSendAllowed, normalizePolicy, shadowAllowed } from '../policy.js'
import { threadRef } from '../pii.js'
import { NO_COMPANY_IDENTITY } from '../company-identity.js'

export const CANONICAL_SHADOW_RECORD_VERSION = 'conv-ai.shadow.v2-canonical'

/** Map a canonical decision onto the shadow table's outcome vocabulary (CHECK-constrained). */
export function shadowOutcomeOf(record) {
  const t = record?.terminal?.type
  if (t === ACTIONS.SUPPRESS) return 'SUPPRESS'
  if (t === ACTIONS.AI_GENERATED_REPLY || t === ACTIONS.DETERMINISTIC_REPLY) return 'REPLY_CANDIDATE'
  if (t === ACTIONS.NO_RESPONSE) {
    const own = (record.plan?.actions || []).find((a) => a.type === ACTIONS.UPDATE_SELLER_FACTS && a.facts?.ownership)
    return own && ['denied', 'wrong_number', 'tenant', 'former_owner', 'property_non_owner'].includes(String(own.facts.ownership)) ? 'UPDATE_ONLY' : 'NO_RESPONSE'
  }
  return 'NEEDS_REVIEW'
}

export function buildCanonicalShadowRecord(record, { inboundVersion = null, threadKey = null, propertyIds = [], deterministic = null, latencyMs = null, policyCode = null }) {
  const reply = record.reply
  const validationStatus = reply ? (record.validation?.status === 'validated' ? 'validated_draft' : 'rejected_with_reasons') : 'not_applicable'
  const cost = { haiku_usd: 0, sonnet_usd: 0, other_usd: 0, total_usd: 0 }
  for (const c of record.model_calls || []) {
    const usd = Number(c.usd) || 0
    if (/haiku/i.test(c.model)) cost.haiku_usd += usd
    else if (/sonnet/i.test(c.model)) cost.sonnet_usd += usd
    else cost.other_usd += usd
    cost.total_usd += usd
  }
  for (const k of Object.keys(cost)) cost[k] = Math.round(cost[k] * 1e6) / 1e6
  return {
    record_version: CANONICAL_SHADOW_RECORD_VERSION,
    idempotency_key: idempotencyKeyFor(record.inbound_message_id),
    inbound_message_id: String(record.inbound_message_id),
    inbound_version: inboundVersion && /^[a-p]{16}$/.test(inboundVersion) ? inboundVersion : null,
    thread_ref: threadKey ? threadRef(threadKey) : null,
    property_ids: (propertyIds || []).map(String),
    created_at: record.decided_at,
    seller_message_masked: record.seller_message_masked,
    versions: record.versions,
    writer_version: WRITER_VERSION,
    understood: { intent: record.judgment?.intent || 'unclear', seller_interest: record.judgment?.seller_interest || 'unknown', confidence: record.judgment?.confidence ?? null },
    decision: {
      contract_version: CANONICAL_RUNTIME_VERSION,
      outcome: shadowOutcomeOf(record),
      terminal: record.terminal,
      plan: record.plan,
      send_permission_granted: false,
    },
    model: { path: `canonical:${record.understand_path || 'none'}`, models: [...new Set((record.model_calls || []).map((c) => c.model).filter(Boolean))], calls: record.model_calls || [] },
    draft: reply ? { text: reply.text, chars: reply.text.length, category: reply.category, objective: reply.objective, send_ready: reply.send_ready } : null,
    validation: { status: validationStatus, reasons: record.validation?.reasons || [], question_kind: reply?.question_kind ?? null, version: record.validation?.version || null },
    composition: record.composition,
    ledger_summary: record.ledger_summary,
    eligibility: record.eligibility,
    deterministic_engine: deterministic,
    policy_code: policyCode,
    send_status: SHADOW_SEND_STATUS,
    cost,
    latency_ms: latencyMs,
  }
}

const inflight = new Map()

/**
 * @param {object} a
 * @param {object} a.input             context rows (context-loader.js)
 * @param {Function|null} [a.eligibilityFor]  ({ now }) => dryRunEligibility(...)
 */
export async function runCanonicalShadow({ input, deterministic = null, eligibilityFor = null, modelClient = null, spend = null, policy = DEFAULT_AI_REPLY_POLICY, env = process.env, store = null, clock = () => Date.now(), inboundVersion = null, establishedPersona = null, companyIdentity = NO_COMPANY_IDENTITY, negotiationAuthority = undefined, enabledLanguages = ['en'] }) {
  const p = normalizePolicy(policy)
  const gate = shadowAllowed(p, env)
  if (!gate.allowed) return { ran: false, code: gate.code }
  const key = idempotencyKeyFor(input?.inbound?.id)
  if (store) {
    const existing = await store.get(key)
    if (existing) return { ran: false, code: 'DUPLICATE_INBOUND', record: existing }
  }
  if (inflight.has(key)) return { ran: false, code: 'DUPLICATE_INBOUND_INFLIGHT', record: (await inflight.get(key)).record }
  const job = (async () => {
    const t0 = clock()
    const now = input.now || new Date(t0).toISOString()
    let eligibility = input.eligibility || null
    if (!eligibility && eligibilityFor) {
      try { eligibility = await eligibilityFor({ now }) } catch { eligibility = { blocked: true, reasons: ['send_time_guard_read_failed'], guard: { blocked: true, reason: 'send_time_guard_read_failed' } } }
    }
    const decision = await decideAndCompose({ input, deterministic, eligibility, modelClient, spend, establishedPersona, companyIdentity, ...(negotiationAuthority ? { negotiationAuthority } : {}), caller: 'shadow', now, enabledLanguages })
    return { decision, record: buildCanonicalShadowRecord(decision, { inboundVersion, threadKey: input.inbound.thread_key, propertyIds: (input.properties || []).map((x) => x.property_id), deterministic, latencyMs: clock() - t0, policyCode: assertSendAllowed(p).code }) }
  })()
  inflight.set(key, job)
  try {
    const { decision, record } = await job
    if (store) {
      const put = await store.putIfAbsent(record)
      return { ran: put.inserted, code: put.inserted ? 'SHADOW_RECORDED' : 'DUPLICATE_INBOUND', record: put.record, decision }
    }
    return { ran: true, code: 'SHADOW_RECORDED', record, decision }
  } finally {
    inflight.delete(key)
  }
}
