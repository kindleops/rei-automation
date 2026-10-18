// R3 — the ONE controlled server-side dispatcher for AI conversation replies (8.5.16 contract;
// rc-8.5.21 Phase 6: WIRED as the canonical dispatcher for origin ai_generated, OFF behind the
// existing switches). It is the ONLY module allowed to reach the send_queue insertion function
// for AI text (static test). It never calls a provider: the row it inserts is dispatched (or
// held / cancelled) by the existing queue runner, so every existing pre-send guard runs at send
// time — send-time contact guard (STOP, suppression, wrong number, not-owner), canonical
// contactability, contact window, sender routing, cadence, duplicate, the
// trg_block_repeat_asking_price trigger — plus the AI row gate (kill switch, record binding,
// stale-inbound, the shared send-time eligibility function).
//
// INPUT: a CANONICAL decision record (runtime/canonical.js#decideAndCompose) for the turn's latest
// inbound — never an R1 decision, never model text from another writer. The record's writer /
// runtime versions must equal this build's (a record from another writer is refused).
//
// Order (fail closed at every step; nothing is written before the reservations):
//   0. a SUPPRESS plan for a STOP in this inbound cancels queued / scheduled sends FIRST, whatever
//      the AI switch says (an existing-suppression SUPPRESS has nothing to cancel)
//   1. emergency stop (system_control queue_emergency_stop_at) and the kill switch
//      system_control[ai_conversation_send_enabled] === 'true'
//   2. AI send policy (system_control[ai_conversation_send_policy]) enabled + thread in scope
//   3. the record: canonical kind + versions, terminal AI_GENERATED_REPLY, validated text
//   4. FRESH state: the record's inbound is still the LATEST inbound (else re-decide), nothing went
//      out / is queued after it, the thread's persona + sender are resolvable (sender unavailable ⇒ held)
//   5. fresh eligibility (the existing guard, dry run) and the SHARED outbound validator on the fresh
//      ledger (no model call); the SHARED send-time function at this instant (not lawful ⇒ deferred
//      with the next permitted time)
//   6. canonical routine scope (decided category; money / offers / legal / negotiation / multi-property
//      / non-English held)
//   7. reservations in public.idempotency_ledger: one reply per inbound (scope 'inbound_reply',
//      shared with the template engine — a turn's finalize already holds them all-or-none and R3
//      verifies the turn's token), one per seller per day, ≤ policy.max_per_day_global slots
//   8. emergency stop + kill switch re-read immediately before the insert
//   9. the IMMUTABLE public.ai_generated_messages record (inbound, thread, model, writer version,
//      exact text, context ref, validation, authorization, approval, schedule, cost), then the queue
//      row through insertSupabaseSendQueueRow: message_origin 'ai_generated', source 'ai_conversation',
//      NO template id, metadata.ai_message_id + body hash + recipient zones + in-session linkage,
//      max_retries 1 (dispatchable exactly once; no retry after any failure or ambiguous accept);
//      then a 'queued' lifecycle event. Provider outcomes are appended by the runner. A crash between
//      the record and the queue insert is finished by the retry (the record's exact text).
import crypto from 'node:crypto'

import { insertSupabaseSendQueueRow } from '@/lib/supabase/sms-engine.js'
import { getSystemValueFresh } from '@/lib/system-control.js'
import { beginIdempotentProcessing, completeIdempotentProcessing, failIdempotentProcessing } from '@/lib/domain/events/idempotency-ledger.js'
import { isEmergencyStopActive } from '@/lib/domain/queue/queue-control-safety.js'
import { evaluateReplyTiming, resolveRecipientZones } from '@/lib/domain/queue/reply-timing.js'
import { ledgerFromContextInput, ledgerSummary } from '@/lib/domain/conversation-ai/fact-ledger.js'
import { attachPropertyFactsFromInput } from '@/lib/domain/conversation-ai/property-ownership.js'
import { hypotheticalReplyRow, dryRunEligibility } from '@/lib/domain/conversation-ai/eligibility-bridge.js'
import { questionKindOf } from '@/lib/domain/conversation-ai/questions.js'
import {
  AI_CONVERSATION_SOURCE, AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY, AI_SEND_POLICY_VERSION, INBOUND_REPLY_RESERVATION_SCOPE,
  R3_EXECUTOR_WIRED, isOwnerHandledThread, languageVerdict, normalizeSendPolicy, parseKillSwitch, threadInPolicyScope,
} from '@/lib/domain/conversation-ai/send-policy.js'
import { buildAiGeneratedMessage, insertAiGeneratedMessage, lookupAiGeneratedMessageByQueueKey, recordAiGeneratedMessageEvent, sealedThreadRef } from '@/lib/domain/messages/ai-generated-message.js'
import { cancelSupabasePendingOutbound, CANCELLATION_POLICIES } from '@/lib/domain/queue/cancel-supabase-pending-outbound.js'
import { CONTEXT_VERSION } from '@/lib/domain/conversation-ai/context-builder.js'
import { ACTIONS } from '@/lib/domain/conversation-ai/pipeline/outcomes.js'
import { OUTBOUND_VALIDATOR_VERSION, validateOutbound } from '@/lib/domain/conversation-ai/outbound-validator.js'
import { STYLE_VALIDATOR_VERSION } from '@/lib/domain/conversation-ai/playbook/v3/style-validator.js'
import { CANONICAL_RUNTIME_VERSION, WRITER_VERSION, canonicalRoutineScope } from '@/lib/domain/conversation-ai/runtime/canonical.js'
import { resolveThreadContinuity } from '@/lib/domain/conversation-ai/persona-continuity.js'
import { NO_COMPANY_IDENTITY } from '@/lib/domain/conversation-ai/company-identity.js'
import { checkAutomationHoldPort } from '@/lib/domain/holds-port/automation-hold-port.js'

export const R3_EXECUTOR_VERSION = 'conv-ai.r3-executor.v2'
export { R3_EXECUTOR_WIRED }
export const SELLER_DAY_SCOPE = 'ai_conv_seller_day'
export const GLOBAL_DAY_SCOPE = 'ai_conv_global_day'
export const EMERGENCY_STOP_KEY = 'queue_emergency_stop_at'
const RESERVATION_LEASE_MS = 24 * 60 * 60 * 1000

// a row in any of these states answers (or will answer) the inbound
const ACTIVE_REPLY_STATUSES = new Set(['queued', 'scheduled', 'pending', 'approval', 'processing', 'sending', 'sent', 'delivered', 'paused_operator_review', 'held'])
const NOT_YET_SENT_STATUSES = new Set(['queued', 'scheduled', 'pending', 'approval', 'processing', 'sending', 'paused_operator_review', 'held'])

const KIND_USE_CASE = Object.freeze({
  ownership: 'ai_ownership_check', interest: 'ai_consider_selling', asking_price: 'ai_seller_asking_price', condition: 'ai_condition_probe',
  identity: 'ai_who_is_this', none: 'ai_conversation_reply', other: 'ai_conversation_reply',
})

const clean = (v) => String(v ?? '').trim()
const t = (x) => Date.parse(x?.at || x?.created_at || 0) || 0

export function draftHash(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

export function aiUseCaseFor({ category, kind }) {
  if (category === 'not_interested_close') return 'ai_not_interested_close'
  if (category === 'identity_answer' && (kind === 'none' || kind === 'other' || kind === 'identity')) return 'ai_who_is_this'
  return KIND_USE_CASE[kind] || 'ai_conversation_reply'
}

/** Default fresh-state loader: the ONE canonical input loader (read-only). */
export async function loadR3State({ supabase, candidate, now }) {
  const sid = clean(candidate?.inbound?.provider_message_sid)
  if (!sid) return null
  const { loadCanonicalInputs } = await import('./conversation-canonical-inputs.js')
  const ci = await loadCanonicalInputs({ supabase, providerMessageSid: sid, now })
  if (!ci) return null
  return {
    input: ci.input, queueRows: ci.queueRows, thread_state: ci.threadState, continuity: ci.continuity, company_identity: ci.companyIdentity,
    recipient_zones: ci.recipientZones, timezone: ci.loaded.timezone, geography: ci.loaded.geography, language: ci.input.language,
    seller_phone: ci.loaded.row.from_phone_number, our_phone: ci.loaded.row.to_phone_number, property_id: ci.loaded.row.property_id || null,
    property_address: ci.property_address, prospect_id: ci.loaded.row.prospect_id || null, master_owner_id: null, market_id: null, campaign_id: null,
    eligibilityFor: ci.eligibilityFor,
  }
}

const reservationId = (scope, key) => `idempotency:${scope}:${key}`

/** The send_queue row of an AI reply by its queue key (read-only). */
export async function lookupQueueRowByKey(supabase, queueKey) {
  const k = clean(queueKey)
  if (!k || !supabase?.from) return { found: false, read_failed: true, row: null }
  try {
    const r = await supabase.from('send_queue').select('id,queue_status').eq('queue_key', k).limit(1)
    if (r?.error) return { found: false, read_failed: true, row: null }
    const row = Array.isArray(r?.data) ? r.data[0] || null : r?.data || null
    return { found: Boolean(row), read_failed: false, row }
  } catch { return { found: false, read_failed: true, row: null } }
}

/** The turn's finalize holds inbound_reply for every member under its token (read-only check). */
async function defaultVerifyTurnHold({ supabase, keys, token }) {
  if (!supabase?.from) return false
  const r = await supabase.from('idempotency_ledger').select('key,status,claim_token').eq('scope', INBOUND_REPLY_RESERVATION_SCOPE).in('key', keys).limit(60)
  if (r?.error) return false
  const rows = r?.data || []
  return keys.every((k) => rows.some((x) => x.key === k && x.status === 'processing' && clean(x.claim_token) === clean(token)))
}

const defaultReservations = (supabase) => ({
  begin: (a) => beginIdempotentProcessing(a),
  complete: (a) => completeIdempotentProcessing(a),
  release: (a) => failIdempotentProcessing(a),
  verifyTurnHold: (a) => defaultVerifyTurnHold({ supabase, ...a }),
})

/**
 * @param {object} candidate
 * @param {object} candidate.record          decideAndCompose() result (caller 'turn')
 * @param {{ id: string, provider_message_sid?: string, thread_key: string, received_at?: string }} candidate.inbound
 * @param {{ turn_id: string, version: number, token: string, inbound_ids: string[] }|null} [candidate.turn]
 * @param {string|null} [candidate.job_id]
 * @param {object} [deps]
 */
export async function executeAiConversationReply(candidate = {}, deps = {}) {
  const now = deps.now ? (typeof deps.now === 'function' ? deps.now() : deps.now) : new Date().toISOString()
  const readSwitch = deps.readSwitch || ((key) => getSystemValueFresh(key, deps.supabase ? { supabase: deps.supabase } : {}))
  const reservations = { ...defaultReservations(deps.supabase), ...(deps.reservations || {}) }
  const insertQueueRow = deps.insertQueueRow || ((payload) => insertSupabaseSendQueueRow(payload, deps.supabase ? { supabase: deps.supabase } : {}))
  const insertRecord = deps.insertRecord || ((record) => insertAiGeneratedMessage(deps.supabase, record))
  const lookupRecord = deps.lookupRecord || ((key) => lookupAiGeneratedMessageByQueueKey(deps.supabase, key))
  const lookupQueueRow = deps.lookupQueueRow || ((key) => lookupQueueRowByKey(deps.supabase, key))
  const recordEvent = deps.recordEvent || ((e) => recordAiGeneratedMessageEvent(deps.supabase, e))
  const cancelPending = deps.cancelPending || ((a) => cancelSupabasePendingOutbound(a, { supabase: deps.supabase }))
  const loadState = deps.loadState || ((a) => loadR3State({ supabase: deps.supabase, ...a }))
  const out = (status, reasons = [], extra = {}) => ({ status, reasons: [...new Set(reasons)], executor_version: R3_EXECUTOR_VERSION, inbound_message_id: clean(candidate?.inbound?.id) || null, ...extra })
  const record = candidate.record || null
  const turn = candidate.turn && clean(candidate.turn.token) ? candidate.turn : null
  const inboundId = clean(candidate.inbound?.id)
  const threadKey = clean(candidate.inbound?.thread_key)
  // a turn-held reservation is CONSUMED when R3 decides "a person handles this" (never released to
  // another automated reply); a transient failure leaves it to the job retry / the turn reopen
  const consumeTurnHold = async (reasons) => {
    if (!turn) return
    for (const k of turn.inbound_ids || []) {
      try { await reservations.complete({ record_item_id: reservationId(INBOUND_REPLY_RESERVATION_SCOPE, k), scope: INBOUND_REPLY_RESERVATION_SCOPE, key: k, metadata: { outcome: 'held', reasons: reasons.slice(0, 6), executor_version: R3_EXECUTOR_VERSION } }) } catch { /* the lease keeps it claimed */ }
    }
  }
  const held = async (reasons, extra = {}) => { await consumeTurnHold(reasons); return out('held', reasons, extra) }

  // 0. a SUPPRESS plan for a STOP is applied whatever the AI switch says (cancel only)
  const planActions = Array.isArray(record?.plan?.actions) ? record.plan.actions : []
  const suppress = planActions.find((a) => a?.type === ACTIONS.SUPPRESS)
  if (suppress) {
    if (!threadKey) return out('refused', ['inbound_identity_missing'])
    if (suppress.cancel_pending !== true) return out('suppressed', ['existing_suppression_nothing_to_cancel'])
    let cancelled = null
    try {
      cancelled = await cancelPending({ thread_key: threadKey, policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL, reason: 'stop_request', suppression_reason: 'stop_request', inbound_event_id: inboundId || null, inbound_received_at: candidate.inbound?.received_at || null, cancelled_by: 'conversation_ai_pipeline', now })
    } catch { cancelled = { ok: false } }
    return out('suppressed', cancelled?.ok === false ? ['cancel_pending_failed'] : [], { cancel_result: cancelled ? { ok: cancelled.ok !== false, cancelled_count: cancelled.cancelled_count ?? cancelled.count ?? null } : null })
  }

  // 1. emergency stop + kill switch
  const brakes = async () => {
    let stop = null; let sw = null
    try { stop = await readSwitch(EMERGENCY_STOP_KEY) } catch { stop = 'unreadable' }
    if (isEmergencyStopActive(stop)) return 'emergency_stop_active'
    try { sw = await readSwitch(AI_SEND_KILL_SWITCH_KEY) } catch { sw = null }
    if (!parseKillSwitch(sw)) return 'kill_switch_off'
    return null
  }
  const brake = await brakes()
  if (brake) return held([brake])
  // 2. policy
  let policyRaw = null
  try { policyRaw = await readSwitch(AI_SEND_POLICY_KEY) } catch { policyRaw = null }
  const policy = normalizeSendPolicy(policyRaw)
  if (!policy.enabled) return held(['ai_send_policy_disabled'])

  // 3. the record — the canonical writer only
  if (!record || record.record_kind !== 'conv-ai.canonical-decision') return out('refused', ['not_a_canonical_decision'])
  if (record.versions?.runtime !== CANONICAL_RUNTIME_VERSION || record.versions?.writer !== WRITER_VERSION) return out('refused', ['writer_version_mismatch'])
  if (!inboundId || !threadKey || clean(record.inbound_message_id) !== inboundId) return out('refused', ['inbound_identity_missing'])
  if (isOwnerHandledThread({ thread_key: threadKey })) return held(['owner_handled_thread'])
  if (record.terminal?.type === ACTIONS.NO_RESPONSE) return out('no_response', [], { category: 'no_response' })
  if (record.terminal?.type !== ACTIONS.AI_GENERATED_REPLY) return held([`terminal_${String(record.terminal?.type || 'none').toLowerCase()}`])
  let draft = clean(record.reply?.text)
  if (!draft) return out('refused', ['empty_draft'])
  if (record.validation?.content_reasons?.length) return held(['draft_not_validated'])

  // 4. FRESH state, read immediately before enqueue
  let state = null
  try { state = await loadState({ candidate, now }) } catch { state = null }
  if (!state?.input?.inbound) return out('retry', ['state_unavailable'])
  if (clean(state.input.inbound.thread_key) !== threadKey) return held(['thread_mismatch'])
  if (isOwnerHandledThread({ thread_key: threadKey, property_address: state.property_address })) return held(['owner_handled_thread'])
  const thread = [...(state.input.thread || [])]
  if (!thread.some((m) => m.id === state.input.inbound.id)) thread.push({ ...state.input.inbound, direction: 'inbound' })
  const inboundRow = thread.find((m) => m.id === inboundId)
  if (!inboundRow) return held(['inbound_not_in_thread'])
  const inbounds = thread.filter((m) => m.direction === 'inbound').sort((a, b) => t(a) - t(b))
  const latest = inbounds[inbounds.length - 1]
  if (latest && latest.id !== inboundId) return out('stale_inbound', ['newer_inbound_arrived'], { action: 're_decide', latest_inbound_id: latest.id })
  // idempotent resume (a retried job after a crash): the record exists.
  // blind-eval D2: a record WITHOUT its queue row (the crash hit between the two inserts) is NOT
  // "already enqueued" — the retry FINISHES the enqueue with the record's exact, hashed text; only a
  // record whose queue row exists is already_enqueued. An unreadable record / row is a retry.
  const key = `ai_conversation:${inboundId}`
  let resumeRecord = null
  let existing = null
  try { existing = await lookupRecord(key) } catch { existing = { found: false, read_failed: true } }
  if (existing?.read_failed) return out('retry', ['ai_generated_record_unreadable'])
  if (existing?.found) {
    let q = null
    try { q = await lookupQueueRow(key) } catch { q = { found: false, read_failed: true } }
    if (!q || q.read_failed) return out('retry', ['queue_row_unreadable'])
    if (q.found) return out('already_enqueued', ['ai_generated_record_exists', 'queue_row_exists'], { ai_message_id: existing.record?.id || null, queue_row_id: q.row?.id || null })
    resumeRecord = existing.record || null
    const body = clean(resumeRecord?.message_body)
    if (!resumeRecord?.id || !body || draftHash(body) !== clean(resumeRecord.body_sha256)) return held(['ai_generated_record_unusable'])
    draft = body
  }
  if (thread.some((m) => m.direction === 'outbound' && t(m) > t(inboundRow))) return held(['already_answered_by_outbound'])
  const pending = (state.queueRows || []).find((r) => ACTIVE_REPLY_STATUSES.has(clean(r.queue_status).toLowerCase()) && (clean(r.inbound_message_id) === inboundId || t(r) >= t(inboundRow)))
  if (pending) return held(['reply_already_queued'], { existing_queue_row_id: pending.id })
  const continuity = state.continuity || resolveThreadContinuity({ sentRows: state.queueRows || [], threadState: state.thread_state || null, inboundTo: state.our_phone })
  if (!continuity.ok || !continuity.sender_number) return held([...(continuity.reasons || []).map((r) => `continuity:${r}`), ...(continuity.sender_number || (continuity.reasons || []).length ? [] : ['sender_unavailable'])])
  const unsent = (state.queueRows || []).find((r) => NOT_YET_SENT_STATUSES.has(clean(r.queue_status).toLowerCase()))
  if (unsent) return held(['outbound_pending_on_thread'], { existing_queue_row_id: unsent.id })
  if (!threadInPolicyScope(policy, { thread_key: threadKey, market_id: state.market_id, campaign_id: state.campaign_id })) return held(['thread_not_in_ai_scope'])
  // the ONE automation-hold registry (fail closed: a lookup error is a hold)
  const hold = await checkAutomationHoldPort({ threadKey, propertyId: state.property_id, masterOwnerId: state.master_owner_id, capability: 'ai_reply_dispatch', propertyAddress: state.property_address }, { checker: deps.automationHoldChecker || null })
  if (hold.held) return held([`automation_hold:${hold.hold_type}`], { hold_reason: hold.reason, hold_id: hold.hold_id })

  // 5. fresh eligibility + the SHARED outbound validator on the fresh ledger + the SHARED send time
  const row = hypotheticalReplyRow({ sellerPhone: state.seller_phone, ourPhone: state.our_phone, threadKey, propertyId: state.property_id, prospectId: state.prospect_id, inboundId, inboundAt: inboundRow.at, now })
  const zones = state.recipient_zones || resolveRecipientZones({ recipientPhone: state.seller_phone, propertyGeography: state.geography, storedTimezone: state.timezone })
  let eligibility
  try {
    eligibility = deps.eligibility ? await deps.eligibility({ row, state, now }) : state.eligibilityFor ? await state.eligibilityFor({ now }) : await dryRunEligibility({ row, supabase: deps.supabase, timezone: state.timezone, geography: state.geography, recipientZones: zones, now })
  } catch { eligibility = { blocked: true, reasons: ['send_time_guard_read_failed'], guard: { blocked: true, reason: 'send_time_guard_read_failed' } } }
  if (eligibility?.blocked) return held((eligibility.reasons?.length ? eligibility.reasons : ['blocked']).map((r) => `ineligible:${r}`))
  const freshInput = { ...state.input, inbound: { ...state.input.inbound, ...(inboundRow.body != null ? { body: inboundRow.body } : {}) } }
  // blind-eval S1: the per-property facts on FRESH state (incl. persisted contact × property resolutions)
  const ledger = attachPropertyFactsFromInput(ledgerFromContextInput(freshInput, { modelFacts: record.judgment?.facts_extracted || [], queueRows: state.queueRows || [], now }), freshInput)
  const followup = planActions.find((a) => a?.type === ACTIONS.SCHEDULE_FOLLOWUP) || null
  const companyIdentity = state.company_identity || NO_COMPANY_IDENTITY
  const timing = evaluateReplyTiming({ at: now, queuedAt: now, inboundId, inboundAt: inboundRow.at, zones: zones.zones })
  const val = validateOutbound(draft, {
    ledger, objective: record.reply.objective, category: record.reply.category, inboundIntent: record.judgment?.intent || null,
    establishedPersona: continuity.persona_name, companyIdentity, followupScheduled: followup, eligibility, timing,
    knownNumbers: [...new Set(thread.flatMap((m) => String(m.body || '').match(/[0-9]{3,}/g) || []))], firstName: state.input?.names?.first_name || null,
    previousOutbound: [...thread].filter((m) => m.direction === 'outbound' && t(m) <= t(inboundRow)).sort((a, b) => t(a) - t(b)).pop()?.body || null,
  })
  if (val.content_reasons.length || val.eligibility_reasons.length) return held([...val.content_reasons, ...val.eligibility_reasons], { ledger: ledgerSummary(ledger) })
  if (!timing.lawful) return out('deferred', ['outside_sending_window'], { next_permitted_at: timing.next_permitted_at, timing })
  // 6. canonical routine scope (the decided category; deterministic exclusions first)
  const lang = languageVerdict({ language: state.language, inboundText: inboundRow.body || '', draftText: draft })
  const scope = canonicalRoutineScope(record, { languageEnglish: lang.english, languageReason: lang.reason, policy, inboundText: inboundRow.body || '', ledger, thread, inbound: inboundRow })
  if (!scope.in_scope) return held(scope.reasons, { category: scope.category, ledger: ledgerSummary(ledger) })

  // 7. reservations (atomic; idempotency_begin = INSERT … ON CONFLICT DO NOTHING)
  const day = String(now).slice(0, 10)
  const meta = { engine: AI_CONVERSATION_SOURCE, decision_id: clean(candidate.decision_id) || null, executor_version: R3_EXECUTOR_VERSION, writer_version: WRITER_VERSION }
  const taken = []
  const releaseTaken = async (why) => { for (const r of taken.reverse()) { try { await reservations.release({ record_item_id: r.record_item_id, scope: r.scope, key: r.key, error: why }) } catch { /* lease expiry frees it */ } } }
  let inboundClaims = []
  if (turn) {
    const keys = (turn.inbound_ids || []).map(clean).filter(Boolean)
    if (!keys.includes(inboundId)) return out('refused', ['turn_does_not_hold_inbound'])
    let ok = false
    try { ok = await reservations.verifyTurnHold({ keys, token: turn.token }) } catch { ok = false }
    if (!ok) return out('duplicate', ['inbound_reservation_not_held_by_turn'])
    inboundClaims = keys.map((k) => ({ record_item_id: reservationId(INBOUND_REPLY_RESERVATION_SCOPE, k), scope: INBOUND_REPLY_RESERVATION_SCOPE, key: k, turn_held: true }))
  } else {
    const r1 = await reservations.begin({ scope: INBOUND_REPLY_RESERVATION_SCOPE, key: inboundId, summary: 'ai_conversation_reply', metadata: meta, lease_ms: RESERVATION_LEASE_MS })
    if (!r1?.ok || r1.duplicate) return out('duplicate', ['inbound_already_reserved'])
    inboundClaims = [{ ...r1, scope: INBOUND_REPLY_RESERVATION_SCOPE, key: inboundId }]
  }
  // after the inbound is claimed, a cap / switch hold CONSUMES the inbound's automated turn
  const holdConsumed = async (reasons, extra = {}) => {
    await releaseTaken(reasons[0])
    for (const c of inboundClaims) { try { await reservations.complete({ record_item_id: c.record_item_id, scope: c.scope, key: c.key, metadata: { outcome: 'held', reasons } }) } catch { /* lease */ } }
    return out('held', reasons, extra)
  }
  const releaseInbound = async (why) => {
    await releaseTaken(why)
    // a transient failure frees the inbound for a retry (a turn-held reservation stays with the turn: the job retries)
    for (const c of inboundClaims) if (!c.turn_held) { try { await reservations.release({ record_item_id: c.record_item_id, scope: c.scope, key: c.key, error: why }) } catch { /* lease */ } }
  }
  let sellerKey = `${sealedThreadRef(threadKey)}:${day}`
  let slot = null
  if (resumeRecord) {
    // D2 resume: the crashed attempt already holds this reply's seller-day + global slot (recorded on
    // the immutable record); they are completed with the enqueue below, never taken twice
    const rr = resumeRecord.audit_refs?.reservations || {}
    const rday = String(resumeRecord.audit_refs?.schedule?.queued_at || resumeRecord.generated_at || now).slice(0, 10)
    if (!clean(rr.seller_day) || !Number.isInteger(Number(rr.global_slot))) return held(['ai_generated_record_reservations_missing'])
    sellerKey = clean(rr.seller_day)
    slot = { scope: GLOBAL_DAY_SCOPE, key: `${rday}:${Number(rr.global_slot)}`, n: Number(rr.global_slot), record_item_id: reservationId(GLOBAL_DAY_SCOPE, `${rday}:${Number(rr.global_slot)}`) }
    taken.push({ scope: SELLER_DAY_SCOPE, key: sellerKey, record_item_id: reservationId(SELLER_DAY_SCOPE, sellerKey) }, slot)
  } else {
    if (policy.limits.max_per_seller_per_day < 1) return holdConsumed(['seller_daily_cap'])
    const r2 = await reservations.begin({ scope: SELLER_DAY_SCOPE, key: sellerKey, summary: 'ai_conversation_seller_day', metadata: meta, lease_ms: RESERVATION_LEASE_MS })
    if (!r2?.ok || r2.duplicate) return holdConsumed(['seller_daily_cap'])
    taken.push({ ...r2, scope: SELLER_DAY_SCOPE, key: sellerKey })
    for (let n = 1; n <= policy.limits.max_per_day_global; n += 1) {
      const r = await reservations.begin({ scope: GLOBAL_DAY_SCOPE, key: `${day}:${n}`, summary: 'ai_conversation_global_slot', metadata: meta, lease_ms: RESERVATION_LEASE_MS })
      if (r?.ok && !r.duplicate) { slot = { ...r, scope: GLOBAL_DAY_SCOPE, key: `${day}:${n}`, n }; break }
    }
    if (!slot) return holdConsumed(['global_daily_cap'])
    taken.push(slot)
  }

  // 8. brakes again, immediately before the insert
  const brake2 = await brakes()
  if (brake2) return holdConsumed([`${brake2}_at_enqueue`])

  // 9a. the IMMUTABLE per-message record — append-only
  const kind = questionKindOf({ body: draft })
  const hash = draftHash(draft)
  const useCase = aiUseCaseFor({ category: scope.category, kind })
  const scopeMatch = policy.scope.thread_keys.includes(threadKey) ? 'thread_keys' : policy.scope.market_ids.includes(String(state.market_id)) ? 'market_ids' : 'campaign_ids'
  const comp = record.composition || {}
  const decisionId = clean(candidate.decision_id) || `canonical:${inboundId}`
  const aiRecord = buildAiGeneratedMessage({
    body: draft, inboundMessageId: inboundId, queueKey: key, threadKey, propertyId: state.property_id, contactId: state.prospect_id,
    recipientPhone: state.seller_phone, senderPhone: continuity.sender_number, decisionId, jobId: candidate.job_id || null,
    model: comp.model || 'unknown', playbookVersion: comp.playbook_version || record.versions.playbook, promptVersion: comp.prompt_version || record.versions.compose_prompt,
    contextVersion: CONTEXT_VERSION, validation: { status: 'validated', validators: [OUTBOUND_VALIDATOR_VERSION, STYLE_VALIDATOR_VERSION, 'fact-ledger', 'canonical-routine-scope', 'reply-timing'], reasons: [] },
    ledgerSnapshot: ledgerSummary(ledger), policy,
    authorizationScope: { policy_key: AI_SEND_POLICY_KEY, policy_version: policy.policy_version, scope_match: scopeMatch, category: scope.category, kill_switch_key: AI_SEND_KILL_SWITCH_KEY },
    approvalState: 'policy_authorized', generatedAt: record.decided_at || now, costUsd: record.cost_usd || comp.usd || 0, inputTokens: comp.usage?.input_tokens ?? null, outputTokens: comp.usage?.output_tokens ?? null,
    auditRefs: {
      writer_version: WRITER_VERSION, runtime_version: CANONICAL_RUNTIME_VERSION, decision_caller: record.caller, decision_id: decisionId, executor_version: R3_EXECUTOR_VERSION,
      context_ref: { inbound_message_id: inboundId, thread_ref: sealedThreadRef(threadKey), ledger_version: record.versions.fact_ledger },
      schedule: { lawful_basis: timing.basis, zones: timing.zones, certainty: zones.certainty || null, queued_at: now },
      turn: turn ? { turn_id: turn.turn_id, version: turn.version } : null,
      reservations: { inbound: inboundClaims.map((c) => c.key), seller_day: sellerKey, global_slot: slot.n },
    },
  })
  let rec = null
  if (resumeRecord) rec = { ok: true, id: resumeRecord.id, resumed: true }
  else {
    try { rec = await insertRecord(aiRecord) } catch { rec = { ok: false, reason: 'ai_generated_record_insert_threw' } }
  }
  if (!rec?.ok || !rec.id) {
    // a record that appeared since the lookup is re-examined by the retry (row present ⇒ already
    // enqueued; row absent ⇒ the enqueue is finished) — never assumed enqueued here
    await releaseInbound(rec?.reason || 'ai_generated_record_insert_failed')
    return out('retry', [rec?.reason || 'ai_generated_record_insert_failed'])
  }

  // 9b. the queue insert — the existing auto-reply insertion function; guards run at send time
  const payload = {
    queue_key: key, queue_id: key, dedupe_key: key, queue_status: 'queued',
    scheduled_for: now, scheduled_for_utc: now, scheduled_for_local: now,
    timezone: zones.zones?.length === 1 ? zones.zones[0] : null,
    send_priority: 5, retry_count: 0,
    // blind-eval D1: max_retries 0 made the runner's pre-claim gate (retry_count >= max_retries)
    // pause EVERY AI row as paused_max_retries. 1 = dispatchable EXACTLY ONCE: any failure (and an
    // ambiguous accept, which the runner never retries) is final and goes to a human
    max_retries: 1,
    message_body: draft, message_text: draft,
    seller_first_name: clean(state.input?.names?.first_name) || null,
    to_phone_number: state.seller_phone, from_phone_number: continuity.sender_number, agent_name: continuity.persona_name,
    master_owner_id: state.master_owner_id || null, prospect_id: state.prospect_id || null, property_id: state.property_id || null,
    // ORIGIN ai_generated (owner 2026-10-15): NOT a template. No template id of any kind
    message_origin: 'ai_generated', template_id: null, selected_template_id: null, template_source: 'ai_generated',
    message_type: 'ai_conversation_reply', type: AI_CONVERSATION_SOURCE, use_case_template: useCase,
    character_count: draft.length, thread_key: threadKey, source: AI_CONVERSATION_SOURCE, source_event_id: inboundId, inbound_message_id: inboundId,
    language: 'English', sms_eligible: true, routing_allowed: true,
    metadata: {
      source: AI_CONVERSATION_SOURCE,
      // a reply to one inbound (the in-session linkage the runner and the row gate read)
      type: 'reply',
      action_type: 'ai_conversation_reply',
      decision_id: decisionId,
      model: clean(comp.model) || null,
      draft_hash: hash,
      message_origin: 'ai_generated',
      ai_message_id: rec.id,
      ai_message_body_sha256: aiRecord.body_sha256,
      ai_message_record_version: aiRecord.record_version,
      ledger_snapshot_hash: aiRecord.ledger_snapshot_hash,
      playbook_version: aiRecord.playbook_version,
      writer_version: WRITER_VERSION,
      inbound_received_at: inboundRow.at || null,
      inbound_message_event_id: inboundId,
      conversational_reply: { stage: 'queued', at: now, queued_at: now, inbound_message_event_id: inboundId, inbound_received_at: inboundRow.at || null, in_session: timing.in_session },
      recipient_zones: timing.zones,
      recipient_zone_certainty: zones.certainty || null,
      validator_version: OUTBOUND_VALIDATOR_VERSION,
      executor_version: R3_EXECUTOR_VERSION,
      send_policy_version: AI_SEND_POLICY_VERSION,
      ai_scope_category: scope.category,
      question_kind: kind,
      stage: ledger.stage?.stage || null,
      reservations: { inbound: inboundClaims.map((c) => c.key), seller_day: sellerKey, global_slot: slot.n },
      turn: turn ? { turn_id: turn.turn_id, version: turn.version } : null,
      agent_persona: continuity.persona_name,
      persona_continuity: { version: continuity.version, persona_source: continuity.persona_source, sender_source: continuity.sender_source },
      no_direct_provider_send: true,
    },
  }
  let res = null
  try { res = await insertQueueRow(payload) } catch (e) { res = { ok: false, reason: e?.message || 'insert_threw' } }
  const queueRowId = res?.queue_row_id || res?.item_id || res?.id || null
  if (!res?.ok || !queueRowId) {
    try { await recordEvent({ aiMessageId: rec.id, eventType: 'held', detail: { reason: 'queue_insert_failed' } }) } catch { /* best effort */ }
    await releaseInbound('queue_insert_failed')
    return out('held', ['queue_insert_failed'], { insert_reason: res?.reason || null, ai_message_id: rec.id })
  }
  for (const r of [...inboundClaims, ...taken]) {
    try { await reservations.complete({ record_item_id: r.record_item_id, scope: r.scope, key: r.key, metadata: { outcome: 'enqueued', queue_row_id: queueRowId } }) } catch { /* the lease keeps it claimed */ }
  }
  const rawStatus = clean(res?.raw?.queue_status).toLowerCase()
  if (rawStatus === 'cancelled') {
    try { await recordEvent({ aiMessageId: rec.id, eventType: 'cancelled', queueRowId, detail: { reason: clean(res?.raw?.paused_reason) || 'cancelled_by_trigger' } }) } catch { /* best effort */ }
    return out('blocked_at_insert', [clean(res?.raw?.paused_reason) || 'cancelled_by_trigger'], { queue_row_id: queueRowId, ai_message_id: rec.id })
  }
  try { await recordEvent({ aiMessageId: rec.id, eventType: 'queued', queueRowId, detail: { queue_key: key } }) } catch { /* the queue row + record already bind */ }
  return out('enqueued', [], { queue_row_id: queueRowId, category: scope.category, draft_hash: hash, use_case_template: payload.use_case_template, ai_message_id: rec.id, lawful_basis: timing.basis })
}

export default executeAiConversationReply
