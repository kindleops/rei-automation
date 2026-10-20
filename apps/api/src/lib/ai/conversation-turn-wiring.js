// Composition root for the 24/7 conversation turn engine (rc-8.5.20). Loaded lazily, only when
// AI_CONVERSATION_TURNS_ENABLED=true (and AI_CONVERSATION_SHADOW_ENABLED=true). The ONLY place the
// turn engine meets a DB client and the runtime store. Writes: public.conversation_reply_turns (turn
// functions) and runtime jobs (agent.runtime_enqueue_event_at). It never sends: the decision at
// the due time is the existing shadow decision (public.conversation_ai_shadow_decisions).
import { isInternalTestPhone } from '@/lib/config/internal-phones.js'
import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js'
import { loadInboundRow, loadShadowContext } from '@/lib/domain/conversation-ai/context-loader.js'
import { ledgerFromContextInput } from '@/lib/domain/conversation-ai/fact-ledger.js'
import { questionKindOf } from '@/lib/domain/conversation-ai/questions.js'
import { attributeInbounds } from '@/lib/domain/conversation-ai/property-facts.js'
import { messagesOfInput } from '@/lib/domain/conversation-ai/property-ownership.js'
import { shadowAllowed } from '@/lib/domain/conversation-ai/policy.js'
import { resolveThreadContinuity } from '@/lib/domain/conversation-ai/persona-continuity.js'
import { normalizeDelayPolicy } from '@/lib/domain/conversation-ai/turns/delay-planner.js'
import { createSupabaseTurnStore } from '@/lib/domain/conversation-ai/turns/turn-store.js'
import { handleConversationEvent, planInputsFromThread } from '@/lib/domain/conversation-ai/turns/turn-engine.js'
import { inboundVersionOf } from './conversation-ai-shadow-hook.js'
import { createShadowTableStore, loadPolicy } from './conversation-ai-shadow-wiring.js'
import { resolveRecipientZones } from '@/lib/domain/queue/reply-timing.js'
import { decideAndCompose, WRITER_VERSION } from '@/lib/domain/conversation-ai/runtime/canonical.js'
import { buildCanonicalShadowRecord } from '@/lib/domain/conversation-ai/runtime/canonical-shadow.js'
import { ACTIONS } from '@/lib/domain/conversation-ai/pipeline/outcomes.js'
import { createConversationModelClient } from '@/lib/domain/conversation-ai/model-client.js'
import { AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY, isOwnerHandledThread, normalizeSendPolicy, parseKillSwitch, threadInPolicyScope } from '@/lib/domain/conversation-ai/send-policy.js'
import { isEmergencyStopActive } from '@/lib/domain/queue/queue-control-safety.js'
import { getSystemValueFresh } from '@/lib/system-control.js'
import { checkAutomationHoldPort } from '@/lib/domain/holds-port/automation-hold-port.js'
import { composeSpendFor, loadCanonicalInputs } from './conversation-canonical-inputs.js'

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
  // rc-8.5.21 P0: the question this inbound answers is read from ALL our questions since the seller's
  // previous reply (follow-up fragments included), never the last outbound alone
  const openAtt = attributeInbounds({ messages: messagesOfInput(loaded.input), properties: loaded.input.properties || [], questionKindOf }).get(String(inb.id)) || null
  const continuity = resolveThreadContinuity({ sentRows: queueRows, threadState: threadState[0] || null, inboundTo: loaded.row.to_phone_number })
  const delayPolicy = await readDelayPolicy(supabase)
  // recipient-local zone evidence (area code + mailing state) ∩ the property zone (reply-timing.js)
  const recipientZones = resolveRecipientZones({ recipientPhone: loaded.row.from_phone_number, propertyGeography: loaded.geography, storedTimezone: loaded.timezone })
  const planArgs = { ...planInputsFromThread({ thread: loaded.input.thread, inbound: inb, ledger, queueRows, timezone: loaded.timezone, recipientZones, now, extra }), policy: delayPolicy }
  return handleConversationEvent({
    event: { kind: 'inbound', thread_key: tk, inbound: { id: String(inb.id), at: inb.at, body: inb.body }, deterministic, lastQuestionKind: openAtt ? openAtt.last_question_kind : lastOut ? questionKindOf(lastOut) : null, ownershipAmbiguous: openAtt?.ambiguous === true && !openAtt?.clauses?.length, ledger },
    store: turnStore || createSupabaseTurnStore(supabase),
    enqueueAt: (o) => runtimeStore.enqueueEventAt(o),
    planArgs,
    continuity: continuity.ok ? continuity : { persona_name: null, sender_number: null },
    now,
  })
}

/**
 * Is an AI SEND authorised for this thread right now? (kill switch, emergency stop, policy, scope,
 * owner-handled). Everything absent ⇒ no: the decision is recorded (shadow) and NOTHING is reserved,
 * so the template engine keeps the inbound exactly as today.
 */
export async function aiSendAuthorizedFor({ threadKey, readSwitch, propertyId = null, propertyAddress = null, automationHoldChecker = null }) {
  try {
    if (isOwnerHandledThread({ thread_key: threadKey, property_address: propertyAddress })) return { ok: false, reason: 'owner_handled_thread' }
    const hold = await checkAutomationHoldPort({ threadKey, propertyId, capability: 'ai_reply_decision', propertyAddress }, { checker: automationHoldChecker })
    if (hold.held) return { ok: false, reason: `automation_hold:${hold.hold_type}` }
    if (isEmergencyStopActive(await readSwitch('queue_emergency_stop_at'))) return { ok: false, reason: 'emergency_stop_active' }
    if (!parseKillSwitch(await readSwitch(AI_SEND_KILL_SWITCH_KEY))) return { ok: false, reason: 'kill_switch_off' }
    const policy = normalizeSendPolicy(await readSwitch(AI_SEND_POLICY_KEY))
    if (!policy.enabled) return { ok: false, reason: 'ai_send_policy_disabled' }
    if (!threadInPolicyScope(policy, { thread_key: threadKey })) return { ok: false, reason: 'thread_not_in_ai_scope' }
    return { ok: true, reason: 'ai_send_authorized' }
  } catch {
    return { ok: false, reason: 'ai_send_switch_unreadable' }
  }
}

/**
 * The decision for a due, claimed turn: THE canonical runtime (decideAndCompose, caller 'turn') for
 * the turn's LATEST inbound (the loader reads the whole thread, so every member and the updated
 * fact ledger are in it). The decision is recorded in public.conversation_ai_shadow_decisions; a
 * reply is handed to the R3 dispatcher ONLY when an AI send is authorised for the thread.
 */
export function createCanonicalTurnDecider({ supabase = getDefaultSupabaseClient(), env = process.env, tracker = null, remainingMs = null, signal = null, provider = null, readSwitch = null, shadowStore = null, automationHoldChecker = null, now = () => new Date().toISOString() } = {}) {
  const read = readSwitch || ((key) => getSystemValueFresh(key, { supabase }))
  return async (claim) => {
    const rows = await rowsOrThrow(supabase.from('message_events').select('id,provider_message_sid,direction').eq('id', claim.latest_inbound_id).limit(1))
    const sid = rows[0]?.provider_message_sid
    if (!sid || String(rows[0]?.direction || '').toLowerCase() !== 'inbound') return { code: 'TURN_INBOUND_NOT_FOUND', outcome: 'needs_review', reply: null }
    const policy = await loadPolicy(supabase)
    const gate = shadowAllowed(policy, env)
    if (!gate.allowed) return { code: gate.code, outcome: 'needs_review', reply: null }
    const at = typeof now === 'function' ? now() : now
    const ci = await loadCanonicalInputs({ supabase, providerMessageSid: sid, now: at, readSwitch: read })
    if (!ci) return { code: 'TURN_INBOUND_NOT_FOUND', outcome: 'needs_review', reply: null }
    if (isInternalTestPhone(ci.loaded.row.from_phone_number) || isInternalTestPhone(ci.loaded.row.to_phone_number)) return { code: 'INTERNAL_TEST_THREAD', outcome: 'needs_review', reply: null }
    const modelClient = tracker ? createConversationModelClient({ provider: provider || (await import('./anthropic-provider.js')).createAnthropicProvider({ env }), tracker, env, remainingMs, signal }) : null
    let eligibility
    try { eligibility = await ci.eligibilityFor({ now: at }) } catch { eligibility = { blocked: true, reasons: ['send_time_guard_read_failed'], guard: { blocked: true, reason: 'send_time_guard_read_failed' } } }
    // OWNER DECISION 2026-10-18: the enabled reply languages come from THE send policy setting
    let enabledLanguages = ['en']
    try { enabledLanguages = normalizeSendPolicy(await read(AI_SEND_POLICY_KEY)).languages } catch { enabledLanguages = ['en'] }
    const record = await decideAndCompose({
      // rc-8.5.21 v3 (RT-11 / RT-05): every member inbound of the consolidated turn is part of the decision
      input: { ...ci.input, turn_member_ids: (claim.inbound_ids || []).map(String) }, eligibility, modelClient, spend: composeSpendFor(tracker), enabledLanguages,
      establishedPersona: claim.persona_name || (ci.continuity.ok ? ci.continuity.persona_name : null), companyIdentity: ci.companyIdentity, caller: 'turn', now: at,
    })
    const store = shadowStore || createShadowTableStore(supabase)
    try {
      const sr = buildCanonicalShadowRecord(record, { inboundVersion: inboundVersionOf(sid, ci.loaded.row.message_body ?? '', 0), threadKey: ci.input.inbound.thread_key, propertyIds: (ci.input.properties || []).map((x) => x.property_id), latencyMs: null, policyCode: 'TURN_DECISION' })
      await store.putIfAbsent(sr)
    } catch (err) { if (err?.abortJob) throw err /* the decision stands; the record is best-effort measurement */ }
    const reply = record.terminal?.type === ACTIONS.AI_GENERATED_REPLY && record.reply?.text && !(record.validation?.content_reasons || []).length ? record.reply : null
    const auth = reply ? await aiSendAuthorizedFor({ threadKey: ci.input.inbound.thread_key, readSwitch: read, propertyId: ci.loaded.row.property_id || null, propertyAddress: ci.property_address, automationHoldChecker }) : { ok: false, reason: 'no_reply' }
    return {
      code: record.terminal?.type || null,
      reason: record.terminal?.reason || null,
      outcome: String(record.terminal?.type || 'no_decision').toLowerCase(),
      writer_version: WRITER_VERSION,
      reply: reply && auth.ok ? { text: reply.text, category: reply.category } : null,
      send_authorization: auth.reason,
      canonical: record,
      inbound: { id: String(ci.input.inbound.id), provider_message_sid: sid, thread_key: ci.input.inbound.thread_key, received_at: ci.input.inbound.at },
      record: { idempotency_key: `conv-ai:v1:${ci.input.inbound.id}`, validation_status: record.validation?.status || null },
    }
  }
}

/**
 * A change on a turn's thread (a reply that failed, an operator take-over, an offer recorded …):
 * routed by the same deterministic router. Thread identity comes from the turn row, never from
 * the job payload.
 */
export async function routeTurnChange({ turnId, kind, change = null, failureClass = null, supabase = getDefaultSupabaseClient(), runtimeStore, turnStore = null, now = new Date().toISOString() }) {
  const rows = await rowsOrThrow(supabase.from('conversation_reply_turns').select('thread_key').eq('turn_id', turnId).limit(1))
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
