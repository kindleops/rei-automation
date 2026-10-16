// Composition root for the 24/7 conversation turn engine (rc-8.5.20). Loaded lazily, only when
// AI_CONVERSATION_TURNS_ENABLED=true (and AI_CONVERSATION_SHADOW_ENABLED=true). The ONLY place the
// turn engine meets a DB client and the runtime store. Writes: public.conversation_turns (turn
// functions) and runtime jobs (agent.runtime_enqueue_event_at). It never sends: the decision at
// the due time is the existing shadow decision (public.conversation_ai_shadow_decisions).
import { isInternalTestPhone } from '@/lib/config/internal-phones.js'
import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js'
import { loadInboundRow, loadShadowContext } from '@/lib/domain/conversation-ai/context-loader.js'
import { ledgerFromContextInput } from '@/lib/domain/conversation-ai/fact-ledger.js'
import { questionKindOf } from '@/lib/domain/conversation-ai/questions.js'
import { shadowAllowed } from '@/lib/domain/conversation-ai/policy.js'
import { resolveThreadContinuity } from '@/lib/domain/conversation-ai/persona-continuity.js'
import { normalizeDelayPolicy } from '@/lib/domain/conversation-ai/turns/delay-planner.js'
import { createSupabaseTurnStore } from '@/lib/domain/conversation-ai/turns/turn-store.js'
import { handleConversationEvent, planInputsFromThread } from '@/lib/domain/conversation-ai/turns/turn-engine.js'
import { inboundVersionOf } from './conversation-ai-shadow-hook.js'
import { loadPolicy, runConversationAiShadowForInbound } from './conversation-ai-shadow-wiring.js'

/** system_control key holding the delay policy JSON (absent ⇒ the code defaults; caps clamp). */
export const DELAY_POLICY_KEY = 'ai_conversation_delay_policy'

async function readDelayPolicy(supabase) {
  try {
    const r = await supabase.from('system_control').select('value').eq('key', DELAY_POLICY_KEY).limit(1)
    const raw = r?.data?.[0]?.value
    return normalizeDelayPolicy(raw ? JSON.parse(raw) : {})
  } catch {
    return normalizeDelayPolicy({})
  }
}

async function rowsOrThrow(q, code = 'TURN_CONTEXT_READ_FAILED') {
  const r = await q
  if (r?.error) throw Object.assign(new Error(code), { code })
  return Array.isArray(r?.data) ? r.data : []
}

/**
 * Route ONE inbound VERSION into the turn engine (the conversation.decide job when turns are on).
 * Deterministic only: no model call here.
 */
export async function routeInboundToTurn({ providerMessageSid, inboundVersion = null, inboundRevision = 0, deterministic = null, env = process.env, supabase = getDefaultSupabaseClient(), runtimeStore, turnStore = null, now = new Date().toISOString(), extra = {} }) {
  const policy = await loadPolicy(supabase)
  const gate = shadowAllowed(policy, env)
  if (!gate.allowed) return { code: gate.code }
  const inbound = await loadInboundRow({ supabase, providerMessageSid })
  if (!inbound) return { code: 'INBOUND_NOT_FOUND' }
  const version = inboundVersionOf(providerMessageSid, inbound.message_body ?? '', inboundRevision)
  if (inboundVersion && inboundVersion !== version) return { code: 'INBOUND_VERSION_MISMATCH' }
  if (isInternalTestPhone(inbound.from_phone_number) || isInternalTestPhone(inbound.to_phone_number)) return { code: 'INTERNAL_TEST_THREAD' }
  const loaded = await loadShadowContext({ supabase, providerMessageSid, inbound, now })
  if (!loaded) return { code: 'INBOUND_NOT_FOUND' }
  const tk = loaded.input.inbound.thread_key
  const since = new Date(Date.parse(now) - 75 * 864e5).toISOString()
  const [queueRows, threadState] = await Promise.all([
    rowsOrThrow(supabase.from('send_queue').select('id,queue_status,use_case_template,created_at,source,agent_name,metadata,message_body,from_phone_number').eq('thread_key', tk).gte('created_at', since).order('created_at', { ascending: false }).limit(60)),
    rowsOrThrow(supabase.from('inbox_thread_state').select('our_number').eq('thread_key', tk).limit(1)),
  ])
  const ledger = ledgerFromContextInput(loaded.input, { queueRows, now })
  const inb = loaded.input.inbound
  const lastOut = [...(loaded.input.thread || [])].filter((m) => m.direction === 'outbound' && (Date.parse(m.at) || 0) <= (Date.parse(inb.at) || 0)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).pop() || null
  const continuity = resolveThreadContinuity({ sentRows: queueRows, threadState: threadState[0] || null, inboundTo: loaded.row.to_phone_number })
  const delayPolicy = await readDelayPolicy(supabase)
  const planArgs = { ...planInputsFromThread({ thread: loaded.input.thread, inbound: inb, ledger, queueRows, timezone: loaded.timezone, now, extra }), policy: delayPolicy }
  return handleConversationEvent({
    event: { kind: 'inbound', thread_key: tk, inbound: { id: String(inb.id), at: inb.at, body: inb.body }, deterministic, lastQuestionKind: lastOut ? questionKindOf(lastOut) : null, ledger },
    store: turnStore || createSupabaseTurnStore(supabase),
    enqueueAt: (o) => runtimeStore.enqueueEventAt(o),
    planArgs,
    continuity: continuity.ok ? continuity : { persona_name: null, sender_number: null },
    now,
  })
}

/**
 * The decision for a due, claimed turn: the existing shadow decision for the turn's LATEST inbound
 * (its context loader reads the whole thread, so every member and the updated fact ledger are in
 * it). Records to public.conversation_ai_shadow_decisions; never sends.
 */
export function createShadowTurnDecider({ supabase = getDefaultSupabaseClient(), env = process.env, tracker = null, remainingMs = null, signal = null } = {}) {
  return async (claim) => {
    const rows = await rowsOrThrow(supabase.from('message_events').select('id,provider_message_sid,direction').eq('id', claim.latest_inbound_id).limit(1))
    const sid = rows[0]?.provider_message_sid
    if (!sid || String(rows[0]?.direction || '').toLowerCase() !== 'inbound') return { code: 'TURN_INBOUND_NOT_FOUND', outcome: 'needs_review' }
    const r = await runConversationAiShadowForInbound({ providerMessageSid: sid, env, supabase, tracker, remainingMs, signal })
    return { code: r?.code || null, outcome: r?.record?.decision?.outcome || r?.code || null, reply: null, record: r?.record ? { idempotency_key: r.record.idempotency_key, validation_status: r.record.validation?.status || null } : null }
  }
}

/**
 * A change on a turn's thread (a reply that failed, an operator take-over, an offer recorded …):
 * routed by the same deterministic router. Thread identity comes from the turn row, never from
 * the job payload.
 */
export async function routeTurnChange({ turnId, kind, change = null, failureClass = null, supabase = getDefaultSupabaseClient(), runtimeStore, turnStore = null, now = new Date().toISOString() }) {
  const rows = await rowsOrThrow(supabase.from('conversation_turns').select('thread_key').eq('turn_id', turnId).limit(1))
  const tk = rows[0]?.thread_key
  if (!tk) return { code: 'TURN_NOT_FOUND' }
  const delayPolicy = await readDelayPolicy(supabase)
  return handleConversationEvent({
    event: { kind, thread_key: tk, turn_id: turnId, change, failureClass },
    store: turnStore || createSupabaseTurnStore(supabase),
    enqueueAt: (o) => runtimeStore.enqueueEventAt(o),
    // a re-decision after a reply that never left: in session from now (the seller is waiting)
    planArgs: { lastInboundAt: now, policy: delayPolicy },
    now,
  })
}
