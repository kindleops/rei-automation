// REVIEW DRAFTS over the CANONICAL runtime (rc-8.5.21, Phase 2). Intelligence Command's review
// panel (POST /api/cockpit/agent/conversation-ai/draft) and the inbox.draft_ai_reply capability
// (Agntei / MCP workflows) ask THIS service for "what would the engine do / say on this inbound?".
// It calls decideAndCompose — the same function reference the live shadow, the turn job, R3 and
// the evaluations use — and returns the plan, the text (if any) and its validation. It never
// queues, reserves or sends anything, and writes nothing.
//
// Gates: the shadow gate (AI_CONVERSATION_SHADOW_ENABLED + the reply policy's shadow switch +
// the kill switch released). Model spend only when AI_CONVERSATION_DRAFT_MODEL_ENABLED=true, then
// capped per request (DRAFT_CAP_USD) by an in-process tracker; otherwise deterministic only
// (the plan is computed, no model text).
import { isInternalTestPhone } from '@/lib/config/internal-phones.js'
import { agentStandDownForThread, AGENT_HELD_STAND_DOWN } from './agent-lead-stand-down.js'
import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js'
import { decideAndCompose } from '@/lib/domain/conversation-ai/runtime/canonical.js'
import { createConversationModelClient, createSpendTracker } from '@/lib/domain/conversation-ai/model-client.js'
import { shadowAllowed } from '@/lib/domain/conversation-ai/policy.js'
import { loadPolicy } from './conversation-ai-shadow-wiring.js'
import { composeSpendFor, loadCanonicalInputs } from './conversation-canonical-inputs.js'

export const DRAFT_SERVICE_VERSION = 'conv-ai.draft-service.v1'
export const DRAFT_MODEL_ENV = 'AI_CONVERSATION_DRAFT_MODEL_ENABLED'
export const DRAFT_CAP_USD = 0.02
const UUID_RE = /^[0-9a-f-]{36}$/i

/** The model-facing / operator-facing projection: no phones, no names, codes + our own text only. */
export function projectDraft(record) {
  return {
    versions: record.versions,
    caller: record.caller,
    terminal: { type: record.terminal?.type || null, reason: record.terminal?.reason || null, category: record.terminal?.category || null, evidence: record.terminal?.evidence || null },
    plan_reasons: record.plan?.reasons || [],
    reply: record.reply ? { text: record.reply.text, category: record.reply.category, objective: record.reply.objective, send_ready: record.reply.send_ready, blocked_by: record.reply.blocked_by } : null,
    validation: record.validation,
    stage: record.ledger_summary?.stage?.stage || null,
    next_missing: record.ledger_summary?.next_missing || null,
    cost_usd: record.cost_usd,
    send_status: 'never_sent_draft',
  }
}

/**
 * @param {{ inboundMessageId: string, caller: 'review_api'|'capability', env?: object, supabase?: object, provider?: object|null, tracker?: object|null }} a
 */
export async function draftReplyForInbound({ inboundMessageId, caller, env = process.env, supabase = getDefaultSupabaseClient(), provider = null, tracker = null }) {
  if (!['review_api', 'capability'].includes(caller)) return { ok: false, code: 'CALLER_INVALID' }
  const id = String(inboundMessageId ?? '').trim()
  if (!UUID_RE.test(id)) return { ok: false, code: 'INBOUND_ID_INVALID' }
  const policy = await loadPolicy(supabase)
  const gate = shadowAllowed(policy, env)
  if (!gate.allowed) return { ok: false, code: gate.code }
  const r = await supabase.from('message_events').select('id,provider_message_sid,direction').eq('id', id).limit(1)
  if (r?.error) return { ok: false, code: 'INBOUND_READ_FAILED' }
  const row = r?.data?.[0]
  if (!row?.provider_message_sid || String(row.direction || '').toLowerCase() !== 'inbound') return { ok: false, code: 'INBOUND_NOT_FOUND' }
  const now = new Date().toISOString()
  const ci = await loadCanonicalInputs({ supabase, providerMessageSid: row.provider_message_sid, now })
  if (!ci) return { ok: false, code: 'INBOUND_NOT_FOUND' }
  if (isInternalTestPhone(ci.loaded.row.from_phone_number) || isInternalTestPhone(ci.loaded.row.to_phone_number)) return { ok: false, code: 'INTERNAL_TEST_THREAD' }
  // link #32: an agent holds this lead — LeadCommand drafts nothing there (the agent composes every text)
  const sd = await agentStandDownForThread(supabase, ci.input?.inbound?.thread_key || ci.loaded?.row?.thread_key)
  if (sd.stand_down) return { ok: false, code: AGENT_HELD_STAND_DOWN }
  const modelOn = String(env?.[DRAFT_MODEL_ENV] ?? '').trim() === 'true'
  const tr = tracker || (modelOn ? createSpendTracker({ capUsd: DRAFT_CAP_USD }) : null)
  const modelClient = tr && (provider || modelOn) ? createConversationModelClient({ provider: provider || (await import('./anthropic-provider.js')).createAnthropicProvider({ env }), tracker: tr, env }) : null
  let eligibility
  try { eligibility = await ci.eligibilityFor({ now }) } catch { eligibility = { blocked: true, reasons: ['send_time_guard_read_failed'], guard: { blocked: true, reason: 'send_time_guard_read_failed' } } }
  const record = await decideAndCompose({ input: ci.input, eligibility, modelClient, spend: composeSpendFor(tr), establishedPersona: ci.continuity.ok ? ci.continuity.persona_name : null, companyIdentity: ci.companyIdentity, caller, now })
  return { ok: true, code: 'DRAFT_DECIDED', model_used: Boolean(modelClient), draft: projectDraft(record), version: DRAFT_SERVICE_VERSION }
}

/** The latest inbound message_events id of a thread (the capability's thread ref → inbound). */
export async function latestInboundIdForThread(thread_key, { supabase = getDefaultSupabaseClient() } = {}) {
  const r = await supabase.from('message_events').select('id').eq('thread_key', thread_key).eq('direction', 'inbound').order('created_at', { ascending: false }).limit(1)
  if (r?.error) throw Object.assign(new Error('message_events read failed'), { code: 'INBOUND_READ_FAILED' })
  return r?.data?.[0]?.id ? String(r.data[0].id) : null
}
