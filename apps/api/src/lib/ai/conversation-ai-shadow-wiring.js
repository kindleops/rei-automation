// Wiring for the live shadow run (loaded lazily, only when the env flag is on).
// Composition root: the ONLY place a provider client, a DB client and the
// conversation-ai engine meet. Writes go to public.conversation_ai_shadow_decisions
// (PROPOSED table) and nowhere else.
import { createAnthropicProvider } from './anthropic-provider.js'
import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js'
import { loadInboundRow, loadShadowContext } from '@/lib/domain/conversation-ai/context-loader.js'
import { idempotencyKeyFor } from '@/lib/domain/conversation-ai/shadow-record.js'
import { inboundVersionOf } from './conversation-ai-shadow-hook.js'
import { dryRunEligibility, hypotheticalReplyRow } from '@/lib/domain/conversation-ai/eligibility-bridge.js'
import { createConversationModelClient } from '@/lib/domain/conversation-ai/model-client.js'
import { normalizePolicy, shadowAllowed } from '@/lib/domain/conversation-ai/policy.js'
import { runConversationAiShadow } from '@/lib/domain/conversation-ai/engine.js'
import { createSemanticCheck } from '@/lib/domain/conversation-ai/semantic-check.js'

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
  const loaded = await loadShadowContext({ supabase, providerMessageSid, inbound })
  if (!loaded) return { ran: false, code: 'INBOUND_NOT_FOUND' }
  const modelClient = tracker ? createConversationModelClient({ provider: provider || createAnthropicProvider({ env }), tracker, env, remainingMs, signal }) : null
  const row = hypotheticalReplyRow({ sellerPhone: loaded.row.from_phone_number, ourPhone: loaded.row.to_phone_number, threadKey: loaded.row.thread_key, propertyId: loaded.row.property_id, prospectId: loaded.row.prospect_id, inboundId: loaded.row.id, inboundAt: loaded.input.inbound.at, now: loaded.input.now })
  return runConversationAiShadow({
    input: loaded.input,
    deterministic,
    eligibilityFor: ({ now }) => dryRunEligibility({ row, supabase, timezone: loaded.timezone, geography: loaded.geography, now }),
    modelClient,
    policy,
    env,
    store,
    semanticCheck: modelClient ? createSemanticCheck(modelClient) : null,
    inboundVersion: version,
  })
}
