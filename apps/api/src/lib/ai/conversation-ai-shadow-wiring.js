// Wiring for the live shadow run (loaded lazily, only when the env flag is on).
// Composition root: the ONLY place a provider client, a DB client and the
// conversation-ai engine meet. Writes go to public.conversation_ai_shadow_decisions
// (PROPOSED table) and nowhere else.
// rc-8.5.21: the shadow decides with the CANONICAL runtime (runtime/canonical.js#decideAndCompose
// via runtime/canonical-shadow.js) — the exact code a canary would run. The R1 proposed_message
// writer (engine.js) is retired.
import { isInternalTestPhone } from '@/lib/config/internal-phones.js'
import { agentStandDownForThread, AGENT_HELD_STAND_DOWN } from './agent-lead-stand-down.js'
import { createAnthropicProvider } from './anthropic-provider.js'
import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js'
import { loadInboundRow } from '@/lib/domain/conversation-ai/context-loader.js'
import { idempotencyKeyFor } from '@/lib/domain/conversation-ai/shadow-record.js'
import { inboundVersionOf } from './conversation-ai-shadow-hook.js'
import { createConversationModelClient } from '@/lib/domain/conversation-ai/model-client.js'
import { normalizePolicy, shadowAllowed } from '@/lib/domain/conversation-ai/policy.js'
import { runCanonicalShadow } from '@/lib/domain/conversation-ai/runtime/canonical-shadow.js'
import { composeSpendFor, loadCanonicalInputs } from './conversation-canonical-inputs.js'
import { HOLD_CAPABILITIES, resolveAutomationHold } from '@/lib/domain/holds/automation-hold.js'

export const SHADOW_TABLE = 'conversation_ai_shadow_decisions'
export const POLICY_TABLE = 'conversation_ai_reply_policy'

export async function loadPolicy(supabase) {
  try {
    const r = await supabase.from(POLICY_TABLE).select('*').eq('id', 1).limit(1)
    if (r?.error || !r?.data?.[0]) return normalizePolicy(null)
    return normalizePolicy(r.data[0])
  } catch {
    return normalizePolicy(null)
  }
}

export function createShadowTableStore(supabase) {
  return {
    async get(key) {
      const r = await supabase.from(SHADOW_TABLE).select('record').eq('idempotency_key', key).limit(1)
      // fail closed BEFORE any model call: an unreadable store is never "no record yet"
      if (r?.error) throw Object.assign(new Error('SHADOW_READ_FAILED'), { code: 'SHADOW_READ_FAILED' })
      return r?.data?.[0]?.record || null
    },
    async putIfAbsent(record) {
      const row = {
        idempotency_key: record.idempotency_key, inbound_message_id: record.inbound_message_id, thread_ref: record.thread_ref,
        property_ids: record.property_ids, record_version: record.record_version, contract_version: record.decision.contract_version,
        outcome: record.decision.outcome, intent: record.understood.intent, path: record.model.path, models: record.model.models,
        validation_status: record.validation.status, validation_reasons: record.validation.reasons, seller_message_masked: record.seller_message_masked,
        draft_text: record.draft?.text || null, record, cost_usd: record.cost.total_usd, latency_ms: record.latency_ms, send_status: record.send_status,
      }
      const r = await supabase.from(SHADOW_TABLE).upsert(row, { onConflict: 'idempotency_key', ignoreDuplicates: true }).select('idempotency_key')
      if (r?.error) throw Object.assign(new Error('SHADOW_WRITE_FAILED'), { code: 'SHADOW_WRITE_FAILED' })
      return { inserted: Array.isArray(r?.data) && r.data.length > 0, record }
    },
  }
}

/** A store whose write is refused once the job was stopped (an abandoned attempt never records). */
function jobBoundStore(store, signal) {
  if (!signal) return store
  return {
    get: (k) => store.get(k),
    async putIfAbsent(record) {
      if (signal.aborted) throw Object.assign(new Error('JOB_DEADLINE'), { code: 'JOB_DEADLINE', abortJob: true })
      return store.putIfAbsent(record)
    },
  }
}

/**
 * One shadow decision for one inbound VERSION. Spend goes ONLY through the injected
 * tracker (the R2 job's agent.spend_ledger reserve/settle); without a tracker no model
 * is called (deterministic pre-check only, everything else NEEDS_REVIEW).
 *
 * Order (8.5.15): policy gate → ONE inbound row read → version check → existing
 * record check → bounded thread read → engine. A duplicate, retried or stale-version
 * job therefore never reloads the thread and never calls a model.
 */
export async function runConversationAiShadowForInbound({ providerMessageSid, inboundVersion = null, inboundRevision = 0, deterministic = null, env = process.env, supabase = getDefaultSupabaseClient(), provider = null, tracker = null, remainingMs = null, signal = null, shadowStore = null }) {
  const policy = await loadPolicy(supabase)
  const gate = shadowAllowed(policy, env)
  if (!gate.allowed) return { ran: false, code: gate.code }
  const inbound = await loadInboundRow({ supabase, providerMessageSid })
  if (!inbound) return { ran: false, code: 'INBOUND_NOT_FOUND' }
  const version = inboundVersionOf(providerMessageSid, inbound.message_body ?? '', inboundRevision)
  // the job was enqueued for another version of this message (the stored body differs): never decided here
  if (inboundVersion && inboundVersion !== version) return { ran: false, code: 'INBOUND_VERSION_MISMATCH' }
  const store = jobBoundStore(shadowStore || createShadowTableStore(supabase), signal)
  const existing = await store.get(idempotencyKeyFor(inbound.id))
  if (existing) {
    const same = !inboundVersion || !existing.inbound_version || existing.inbound_version === inboundVersion
    return { ran: false, code: same ? 'DUPLICATE_INBOUND' : 'PRIOR_VERSION_RECORDED', record: existing }
  }
  // link #32: an agent holds this lead — no model decision here (the agent hears the inbound on its event feed)
  const sd = await agentStandDownForThread(supabase, inbound.thread_key)
  if (sd.stand_down) return { ran: false, code: AGENT_HELD_STAND_DOWN }
  const ci = await loadCanonicalInputs({ supabase, providerMessageSid, inbound })
  if (!ci) return { ran: false, code: 'INBOUND_NOT_FOUND' }
  const loaded = ci.loaded
  // RC 8.5.15 (eval #128 drafted "Hi Internal..."): internal / test numbers are
  // never decided -- no model call, no record.
  if (isInternalTestPhone(loaded.row.from_phone_number) || isInternalTestPhone(loaded.row.to_phone_number)) return { ran: false, code: 'INTERNAL_TEST_THREAD' }
  const modelClient = tracker ? createConversationModelClient({ provider: provider || createAnthropicProvider({ env }), tracker, env, remainingMs, signal }) : null
  // AUTOMATION HOLD (P0 2026-10-16): a held thread's shadow decision is still
  // RECORDED (evidence), never acted on. R1/R2 has no act path at all; the
  // verdict is returned so any future executor must read it, and every send
  // would still meet the enqueue / dispatch chokepoints and the DB trigger.
  const automation_hold = await resolveAutomationHold(
    { thread_key: loaded.row.thread_key, property_id: loaded.row.property_id },
    { capability: HOLD_CAPABILITIES.AI_ACTION, supabase }
  )
  // rc-8.5.21 integration: the canonical shadow runtime (8.5.21-a) is the writer; the hold verdict
  // (rc-8.5.20-holds) still annotates its result exactly as before.
  // OWNER DECISION 2026-10-18: the enabled reply languages come from THE send-policy setting
  let enabledLanguages = ['en']
  try {
    const { getSystemValueFresh } = await import('@/lib/system-control.js')
    const { AI_SEND_POLICY_KEY, normalizeSendPolicy } = await import('@/lib/domain/conversation-ai/send-policy.js')
    enabledLanguages = normalizeSendPolicy(await getSystemValueFresh(AI_SEND_POLICY_KEY, { supabase })).languages
  } catch { enabledLanguages = ['en'] }
  const shadow = await runCanonicalShadow({
    enabledLanguages,
    input: loaded.input,
    deterministic,
    eligibilityFor: ({ now }) => ci.eligibilityFor({ now }),
    modelClient,
    spend: composeSpendFor(tracker),
    policy,
    env,
    store,
    inboundVersion: version,
    establishedPersona: ci.continuity.ok ? ci.continuity.persona_name : null,
    companyIdentity: ci.companyIdentity,
  })
  return automation_hold.held
    ? { ...shadow, act_allowed: false, automation_hold: { hold_ids: automation_hold.hold_ids, fail_closed: automation_hold.fail_closed === true } }
    : shadow
}
