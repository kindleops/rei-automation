// R3 — the ONE controlled server-side execution module for AI conversation replies (8.5.16).
//
// BUILT, OFF, NOT WIRED. Nothing in the codebase calls executeAiConversationReply()
// in this release (R3_EXECUTOR_WIRED = false in send-policy.js); it is exercised only
// by tests. It is the ONLY module allowed to reach the send_queue insertion function
// (static test: conversation-ai-r3-executor). It never calls a provider: a row it
// inserts is dispatched (or held / cancelled) by the existing queue runner, so every
// existing pre-send guard runs at send time — send-time contact guard (STOP,
// suppression, wrong number, not-owner), canonical contactability, template
// authority, contact window, sender routing, cadence, duplicate, the
// trg_block_repeat_asking_price trigger — plus the AI row gate (kill switch).
//
// Order (fail closed at every step; nothing is written before step 7):
//   1. kill switch system_control[ai_conversation_send_enabled] === 'true'
//   2. AI send policy (system_control[ai_conversation_send_policy]) enabled + thread in scope
//   3. the candidate is a STRICTLY valid conv-ai.decision.v1 with a validated draft
//   4. FRESH state: the candidate's inbound is still the LATEST inbound (else re-decide),
//      nothing went out / is queued after it
//   5. re-validation on the fresh state: decision ids ∈ latest context, the R2 validator
//      (existing eligibility bridge, dry run) + the canonical fact/question ledger
//   6. routine scope (S1–S4 next missing fact, identity answer, not-interested close);
//      money / offers / financial / legal / negotiation / multi-property / Spanish held
//   7. atomic reservations in public.idempotency_ledger (existing; idempotency_begin is
//      INSERT … ON CONFLICT): one reply per inbound (scope 'inbound_reply', shared with
//      the template engine), one per seller per day, ≤ 25 global slots per day
//   8. kill switch re-read immediately before the insert
//   9. the IMMUTABLE public.ai_generated_messages record (provenance + authorisation;
//      origin ai_generated, NOT a template), then the queue row through
//      insertSupabaseSendQueueRow (the function the template auto-reply path uses):
//      message_origin 'ai_generated', source 'ai_conversation', NO template id,
//      metadata.ai_message_id + body hash, max_retries 0; then a 'queued' lifecycle event.
//      A record whose queue insert fails stays unbound (bound to this queue key / inbound).
//   0. a SUPPRESS plan (any stop request) cancels queued / scheduled sends FIRST, whatever
//      the AI switch says.
import crypto from 'node:crypto'

import { insertSupabaseSendQueueRow } from '@/lib/supabase/sms-engine.js'
import { HOLD_CAPABILITIES, resolveAutomationHold } from '@/lib/domain/holds/automation-hold.js'
import { getSystemValueFresh } from '@/lib/system-control.js'
import { beginIdempotentProcessing, completeIdempotentProcessing, failIdempotentProcessing } from '@/lib/domain/events/idempotency-ledger.js'
import { resolveRecipientTimezone } from '@/lib/domain/queue/recipient-timezone.js'
import { DECISION_CONTRACT_VERSION, validateDecision } from '@/lib/domain/conversation-ai/contract.js'
import { buildConversationContext } from '@/lib/domain/conversation-ai/context-builder.js'
import { loadShadowContext } from '@/lib/domain/conversation-ai/context-loader.js'
import { dryRunEligibility, hypotheticalReplyRow } from '@/lib/domain/conversation-ai/eligibility-bridge.js'
import { ledgerFromContextInput, ledgerSummary } from '@/lib/domain/conversation-ai/fact-ledger.js'
import { DEFAULT_AI_REPLY_POLICY } from '@/lib/domain/conversation-ai/policy.js'
import { questionKindOf } from '@/lib/domain/conversation-ai/questions.js'
import {
  AI_CONVERSATION_SOURCE, AI_SEND_KILL_SWITCH_KEY, AI_SEND_POLICY_KEY, AI_SEND_POLICY_VERSION, INBOUND_REPLY_RESERVATION_SCOPE,
  R3_EXECUTOR_WIRED, classifyRoutineScope, isOwnerHandledThread, normalizeSendPolicy, parseKillSwitch, threadInPolicyScope,
} from '@/lib/domain/conversation-ai/send-policy.js'
import { VALIDATOR_VERSION, validateDraft } from '@/lib/domain/conversation-ai/validator.js'
import { buildAiGeneratedMessage, insertAiGeneratedMessage, recordAiGeneratedMessageEvent, sealedThreadRef } from '@/lib/domain/messages/ai-generated-message.js'
import { cancelSupabasePendingOutbound, CANCELLATION_POLICIES } from '@/lib/domain/queue/cancel-supabase-pending-outbound.js'
import { CONTEXT_VERSION } from '@/lib/domain/conversation-ai/context-builder.js'
import { COMPOSE_PROMPT_VERSION, PLAYBOOK_VERSION } from '@/lib/domain/conversation-ai/playbook/v2/index.js'
import { validatePlaybookStyle } from '@/lib/domain/conversation-ai/playbook/v2/style-validator.js'
import { ACTIONS, validatePlan } from '@/lib/domain/conversation-ai/pipeline/outcomes.js'
import { closeAndAttributionReasons } from '@/lib/domain/conversation-ai/pipeline/compose.js'
import { resolveThreadContinuity } from '@/lib/domain/conversation-ai/persona-continuity.js'

export const R3_EXECUTOR_VERSION = 'conv-ai.r3-executor.v1'
export { R3_EXECUTOR_WIRED }
export const SELLER_DAY_SCOPE = 'ai_conv_seller_day'
export const GLOBAL_DAY_SCOPE = 'ai_conv_global_day'
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

/** Default fresh-state loader: the EXISTING read-only shadow loader + one bounded send_queue read. */
export async function loadR3State({ supabase, candidate, now }) {
  const sid = clean(candidate?.inbound?.provider_message_sid)
  if (!sid) return null
  const loaded = await loadShadowContext({ supabase, providerMessageSid: sid, now })
  if (!loaded) return null
  const since = new Date(Date.parse(now) - 75 * 864e5).toISOString()
  // rc-8.5.20: agent_name / metadata / body / from number feed the persona + sender continuity
  const q = await supabase.from('send_queue').select('id,queue_status,use_case_template,created_at,source,inbound_message_id,agent_name,metadata,message_body,from_phone_number').eq('thread_key', loaded.input.inbound.thread_key).gte('created_at', since).order('created_at', { ascending: false }).limit(60)
  if (q?.error) throw Object.assign(new Error('R3_STATE_READ_FAILED'), { code: 'R3_STATE_READ_FAILED' })
  const ts = await supabase.from('inbox_thread_state').select('our_number').eq('thread_key', loaded.input.inbound.thread_key).limit(1)
  if (ts?.error) throw Object.assign(new Error('R3_STATE_READ_FAILED'), { code: 'R3_STATE_READ_FAILED' })
  let property_address = null
  if (loaded.row.property_id) {
    const pr = await supabase.from('properties').select('property_address,property_address_full').eq('property_id', loaded.row.property_id).limit(1)
    if (pr?.error) throw Object.assign(new Error('R3_STATE_READ_FAILED'), { code: 'R3_STATE_READ_FAILED' })
    property_address = pr?.data?.[0]?.property_address || pr?.data?.[0]?.property_address_full || null
  }
  return {
    input: loaded.input,
    queueRows: q?.data || [],
    thread_state: ts?.data?.[0] || null,
    timezone: loaded.timezone,
    geography: loaded.geography,
    language: loaded.input.language,
    seller_phone: loaded.row.from_phone_number,
    our_phone: loaded.row.to_phone_number,
    property_id: loaded.row.property_id || null,
    property_address,
    prospect_id: loaded.row.prospect_id || null,
    master_owner_id: null,
    market_id: null,
    campaign_id: null,
  }
}

const defaultReservations = {
  begin: (a) => beginIdempotentProcessing(a),
  complete: (a) => completeIdempotentProcessing(a),
  release: (a) => failIdempotentProcessing(a),
}

/**
 * @param {object} candidate
 * @param {object} candidate.decision        conv-ai.decision.v1 (strictly re-validated here)
 * @param {string} candidate.draft_text      the R2-composed draft
 * @param {{ status: string }} candidate.validation  the R2 validator result ('validated_draft' only)
 * @param {string} candidate.decision_id     shadow record idempotency key
 * @param {string|null} candidate.model
 * @param {{ id: string, provider_message_sid?: string, thread_key: string }} candidate.inbound
 * @param {object} [deps]
 */
export async function executeAiConversationReply(candidate = {}, deps = {}) {
  const now = deps.now ? (typeof deps.now === 'function' ? deps.now() : deps.now) : new Date().toISOString()
  const readSwitch = deps.readSwitch || ((key) => getSystemValueFresh(key, deps.supabase ? { supabase: deps.supabase } : {}))
  const reservations = deps.reservations || defaultReservations
  const insertQueueRow = deps.insertQueueRow || ((payload) => insertSupabaseSendQueueRow(payload, deps.supabase ? { supabase: deps.supabase } : {}))
  const insertRecord = deps.insertRecord || ((record) => insertAiGeneratedMessage(deps.supabase, record))
  const recordEvent = deps.recordEvent || ((e) => recordAiGeneratedMessageEvent(deps.supabase, e))
  const cancelPending = deps.cancelPending || ((a) => cancelSupabasePendingOutbound(a, { supabase: deps.supabase }))
  const loadState = deps.loadState || ((a) => loadR3State({ supabase: deps.supabase, ...a }))
  const eligibilityFor = deps.eligibility || (({ row, state }) => dryRunEligibility({ row, supabase: deps.supabase, timezone: state.timezone, geography: state.geography, now }))
  const out = (status, reasons = [], extra = {}) => ({ status, reasons: [...new Set(reasons)], executor_version: R3_EXECUTOR_VERSION, inbound_message_id: clean(candidate?.inbound?.id) || null, ...extra })

  // 0. a SUPPRESS plan (STOP / any stop request) is applied whatever the AI switch says:
  //    it only ever cancels queued / scheduled sends (owner 2026-10-15: no AI override)
  const planActions = Array.isArray(candidate?.plan?.actions) ? candidate.plan.actions : null
  if (planActions?.some((a) => a?.type === ACTIONS.SUPPRESS)) {
    const tk = clean(candidate.inbound?.thread_key)
    if (!tk) return out('refused', ['inbound_identity_missing'])
    let cancelled = null
    try {
      cancelled = await cancelPending({ thread_key: tk, policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL, reason: 'stop_request', suppression_reason: 'stop_request', inbound_event_id: clean(candidate.inbound?.id) || null, inbound_received_at: candidate.inbound?.received_at || null, cancelled_by: 'conversation_ai_pipeline', now })
    } catch { cancelled = { ok: false } }
    return out('suppressed', cancelled?.ok === false ? ['cancel_pending_failed'] : [], { cancel_result: cancelled ? { ok: cancelled.ok !== false, cancelled_count: cancelled.cancelled_count ?? cancelled.count ?? null } : null })
  }

  // 1. kill switch
  let switchRaw = null
  try { switchRaw = await readSwitch(AI_SEND_KILL_SWITCH_KEY) } catch { switchRaw = null }
  if (!parseKillSwitch(switchRaw)) return out('refused', ['kill_switch_off'])
  // 2. policy
  let policyRaw = null
  try { policyRaw = await readSwitch(AI_SEND_POLICY_KEY) } catch { policyRaw = null }
  const policy = normalizeSendPolicy(policyRaw)
  if (!policy.enabled) return out('refused', ['ai_send_policy_disabled'])

  // 3. the candidate
  const decision = candidate.decision
  const shape = validateDecision(decision)
  if (!shape.ok) return out('refused', ['decision_invalid', ...shape.errors.slice(0, 5)])
  if (decision.contract_version !== DECISION_CONTRACT_VERSION) return out('refused', ['decision_contract_mismatch'])
  const inboundId = clean(candidate.inbound?.id)
  const threadKey = clean(candidate.inbound?.thread_key)
  if (!inboundId || !threadKey) return out('refused', ['inbound_identity_missing'])
  // OWNER 2026-10-14 (permanent): owner-handled threads are never touched
  if (isOwnerHandledThread({ thread_key: threadKey })) return out('refused', ['owner_handled_thread'])
  if (decision.outcome === 'NO_RESPONSE') return out('no_response', [], { category: 'no_response' })
  if (decision.outcome !== 'REPLY_CANDIDATE') return out('held', [`outcome_${String(decision.outcome).toLowerCase()}`])
  if (candidate.validation?.status !== 'validated_draft') return out('held', ['draft_not_validated'])
  const draft = clean(candidate.draft_text)
  if (!draft) return out('refused', ['empty_draft'])
  if (planActions) {
    const pv = validatePlan(planActions)
    if (!pv.ok) return out('held', ['plan_conflict', ...pv.reasons])
    if (!planActions.some((a) => a?.type === ACTIONS.AI_GENERATED_REPLY)) return out('held', ['plan_has_no_ai_generated_reply'])
  }
  // playbook v1 style, enforced in code (no em / en dash, one question, no invented claims, …)
  // (the persona half of the style rules is judged after the thread's persona is known, step 4)
  const style = validatePlaybookStyle(draft)
  const styleEarly = style.reasons.filter((r) => r !== 'persona:name_not_established')
  if (styleEarly.length) return out('held', styleEarly)

  // 4. FRESH state, read immediately before enqueue
  let state = null
  try { state = await loadState({ candidate, now }) } catch { state = null }
  if (!state?.input?.inbound) return out('held', ['state_unavailable'])
  if (clean(state.input.inbound.thread_key) !== threadKey) return out('held', ['thread_mismatch'])
  if (isOwnerHandledThread({ thread_key: threadKey, property_address: state.property_address })) return out('refused', ['owner_handled_thread'])
  // AUTOMATION HOLD registry (P0 2026-10-16), read fresh immediately before enqueue. Fail closed.
  const aiHold = await (deps.resolveHold || resolveAutomationHold)(
    { thread_key: threadKey, property_id: clean(candidate.inbound?.property_id) || null },
    { capability: HOLD_CAPABILITIES.AI_ACTION, supabase: deps.supabase || null }
  )
  if (aiHold?.held) return out('refused', [aiHold.fail_closed ? 'automation_hold_lookup_failed' : 'automation_hold'])
  const thread = [...(state.input.thread || [])]
  if (!thread.some((m) => m.id === state.input.inbound.id)) thread.push({ ...state.input.inbound, direction: 'inbound' })
  const inboundRow = thread.find((m) => m.id === inboundId)
  if (!inboundRow) return out('held', ['inbound_not_in_thread'])
  const inbounds = thread.filter((m) => m.direction === 'inbound').sort((a, b) => t(a) - t(b))
  const latest = inbounds[inbounds.length - 1]
  if (latest && latest.id !== inboundId) return out('stale_inbound', ['newer_inbound_arrived'], { action: 're_decide', latest_inbound_id: latest.id })
  if (thread.some((m) => m.direction === 'outbound' && t(m) > t(inboundRow))) return out('held', ['already_answered_by_outbound'])
  const pending = (state.queueRows || []).find((r) => ACTIVE_REPLY_STATUSES.has(clean(r.queue_status).toLowerCase()) && (clean(r.inbound_message_id) === inboundId || t(r) >= t(inboundRow)))
  if (pending) return out('held', ['reply_already_queued'], { existing_queue_row_id: pending.id })
  // rc-8.5.20 Phase 2: the thread's established persona and sender number (one resolver for
  // every origin); a conflict or a number mismatch holds for a human, never auto-switches
  const continuity = state.continuity || resolveThreadContinuity({ sentRows: state.queueRows || [], threadState: state.thread_state || null, inboundTo: state.our_phone })
  if (!continuity.ok) return out('held', continuity.reasons.map((r) => `continuity:${r}`))
  const personaStyle = validatePlaybookStyle(draft, { establishedPersona: continuity.persona_name })
  if (!personaStyle.ok) return out('held', personaStyle.reasons)
  // any other not-yet-sent row on the thread (a scheduled follow-up, a held reply) ⇒ a human decides
  const unsent = (state.queueRows || []).find((r) => NOT_YET_SENT_STATUSES.has(clean(r.queue_status).toLowerCase()))
  if (unsent) return out('held', ['outbound_pending_on_thread'], { existing_queue_row_id: unsent.id })

  // scope (explicit allowlist; empty = nothing)
  if (!threadInPolicyScope(policy, { thread_key: threadKey, market_id: state.market_id, campaign_id: state.campaign_id })) return out('held', ['thread_not_in_ai_scope'])

  // 5. re-validate on the latest state
  const input = { ...state.input, inbound: { ...state.input.inbound, ...(inboundRow.body != null ? { body: inboundRow.body } : {}) } }
  const row = hypotheticalReplyRow({ sellerPhone: state.seller_phone, ourPhone: state.our_phone, threadKey, propertyId: state.property_id, prospectId: state.prospect_id, inboundId, inboundAt: inboundRow.at, now })
  let eligibility
  try { eligibility = await eligibilityFor({ row, state, now }) } catch { eligibility = { blocked: true, reasons: ['eligibility_check_failed'], outside_window: null } }
  let context
  try { context = buildConversationContext({ ...input, eligibility, now }) } catch (e) { return out('held', [`context_${e?.code || 'failed'}`]) }
  const ids = validateDecision(decision, { messageIds: context.message_ids, inboundMessageIds: context.inbound_ids })
  if (!ids.ok) return out('held', ['decision_ids_not_in_latest_context'])
  const ledger = ledgerFromContextInput(input, { modelFacts: decision.facts_extracted, queueRows: state.queueRows || [], now })
  const val = await validateDraft({ decision: { ...decision, proposed_message: draft }, context, inboundText: input.inbound.body, policy: DEFAULT_AI_REPLY_POLICY, eligibility, factLedger: ledger })
  // 6. routine scope (reported together with the re-validation reasons)
  const scope = classifyRoutineScope({ decision, draftText: draft, inboundText: input.inbound.body, ledger, language: state.language, propertyCount: (input.properties || []).length || 1, policy })
  // a close never promises no further contact (the 30-day follow-up exists); attributions must be stated facts
  const closeReasons = closeAndAttributionReasons(draft, { ledger, category: scope.category, followupScheduled: scope.category === 'not_interested_close' ? { days: 30 } : null })
  if (closeReasons.length) return out('held', closeReasons, { category: scope.category, ledger: ledgerSummary(ledger) })
  if (val.status !== 'validated_draft' || !scope.in_scope) {
    const reasons = [...(val.status !== 'validated_draft' ? (val.reasons.length ? val.reasons : ['revalidation_failed']) : []), ...scope.reasons]
    return out('held', reasons, { category: scope.category, ledger: ledgerSummary(ledger) })
  }
  if (scope.category === 'no_response') return out('no_response', [], { category: 'no_response' })

  // 7. reservations (atomic; idempotency_begin = INSERT … ON CONFLICT DO NOTHING)
  const day = String(now).slice(0, 10)
  const meta = { engine: AI_CONVERSATION_SOURCE, decision_id: clean(candidate.decision_id) || null, executor_version: R3_EXECUTOR_VERSION }
  const taken = []
  const releaseAll = async (why) => { for (const r of taken.reverse()) { try { await reservations.release({ record_item_id: r.record_item_id, scope: r.scope, key: r.key, error: why }) } catch { /* lease expiry frees it */ } } }
  const r1 = await reservations.begin({ scope: INBOUND_REPLY_RESERVATION_SCOPE, key: inboundId, summary: 'ai_conversation_reply', metadata: meta, lease_ms: RESERVATION_LEASE_MS })
  if (!r1?.ok || r1.duplicate) return out('duplicate', ['inbound_already_reserved'])
  const inboundClaim = { ...r1, scope: INBOUND_REPLY_RESERVATION_SCOPE, key: inboundId }
  // after the inbound is claimed, a cap / switch hold CONSUMES the inbound's automated turn
  // (held for a human); only a transient failure releases it for a retry
  const holdConsumed = async (reasons, extra = {}) => {
    await releaseAll(reasons[0])
    try { await reservations.complete({ record_item_id: inboundClaim.record_item_id, scope: inboundClaim.scope, key: inboundClaim.key, metadata: { outcome: 'held', reasons } }) } catch { /* the lease keeps it claimed */ }
    return out('held', reasons, extra)
  }
  if (policy.limits.max_per_seller_per_day < 1) return holdConsumed(['seller_daily_cap'])
  const r2 = await reservations.begin({ scope: SELLER_DAY_SCOPE, key: `${sealedThreadRef(threadKey)}:${day}`, summary: 'ai_conversation_seller_day', metadata: meta, lease_ms: RESERVATION_LEASE_MS })
  if (!r2?.ok || r2.duplicate) return holdConsumed(['seller_daily_cap'])
  taken.push({ ...r2, scope: SELLER_DAY_SCOPE, key: `${sealedThreadRef(threadKey)}:${day}` })
  let slot = null
  for (let n = 1; n <= policy.limits.max_per_day_global; n += 1) {
    const r = await reservations.begin({ scope: GLOBAL_DAY_SCOPE, key: `${day}:${n}`, summary: 'ai_conversation_global_slot', metadata: meta, lease_ms: RESERVATION_LEASE_MS })
    if (r?.ok && !r.duplicate) { slot = { ...r, scope: GLOBAL_DAY_SCOPE, key: `${day}:${n}`, n }; break }
  }
  if (!slot) return holdConsumed(['global_daily_cap'])
  taken.push(slot)

  // 8. kill switch again, immediately before the insert
  let switchAgain = null
  try { switchAgain = await readSwitch(AI_SEND_KILL_SWITCH_KEY) } catch { switchAgain = null }
  if (!parseKillSwitch(switchAgain)) return holdConsumed(['kill_switch_off_at_enqueue'])

  // 9a. the IMMUTABLE per-message template record (owner 2026-10-15) — append-only
  const kind = questionKindOf({ body: draft })
  const tz = resolveRecipientTimezone({ to_phone_number: state.seller_phone, timezone: state.timezone }, { propertyGeography: state.geography })
  const hash = draftHash(draft)
  const key = `ai_conversation:${inboundId}`
  const useCase = aiUseCaseFor({ category: scope.category, kind })
  const scopeMatch = policy.scope.thread_keys.includes(threadKey) ? 'thread_keys' : policy.scope.market_ids.includes(String(state.market_id)) ? 'market_ids' : 'campaign_ids'
  const comp = candidate.composition || {}
  const record = buildAiGeneratedMessage({
    body: draft, inboundMessageId: inboundId, queueKey: key, threadKey, propertyId: state.property_id, contactId: state.prospect_id,
    recipientPhone: state.seller_phone, senderPhone: continuity.sender_number, decisionId: candidate.decision_id, jobId: candidate.job_id || null,
    model: comp.model || candidate.model, playbookVersion: comp.playbook_version || PLAYBOOK_VERSION, promptVersion: comp.prompt_version || COMPOSE_PROMPT_VERSION,
    contextVersion: CONTEXT_VERSION, validation: { status: 'validated', validators: [VALIDATOR_VERSION, style.version, 'fact-ledger', 'routine-scope'], reasons: [] },
    ledgerSnapshot: ledgerSummary(ledger), policy,
    authorizationScope: { policy_key: AI_SEND_POLICY_KEY, policy_version: policy.policy_version, scope_match: scopeMatch, category: scope.category, kill_switch_key: AI_SEND_KILL_SWITCH_KEY },
    approvalState: 'policy_authorized', generatedAt: now, costUsd: comp.usd || 0, inputTokens: comp.usage?.input_tokens ?? null, outputTokens: comp.usage?.output_tokens ?? null,
    auditRefs: { shadow_record: clean(candidate.decision_id) || null, executor_version: R3_EXECUTOR_VERSION, reservations: { inbound: inboundId, seller_day: `${sealedThreadRef(threadKey)}:${day}`, global_slot: slot.n } },
  })
  let rec = null
  try { rec = await insertRecord(record) } catch { rec = { ok: false, reason: 'ai_generated_record_insert_threw' } }
  if (!rec?.ok || !rec.id) {
    await releaseAll('ai_generated_record_insert_failed')
    try { await reservations.release({ record_item_id: inboundClaim.record_item_id, scope: inboundClaim.scope, key: inboundClaim.key, error: 'ai_generated_record_insert_failed' }) } catch { /* lease */ }
    return out('held', [rec?.reason || 'ai_generated_record_insert_failed'])
  }

  // 9b. the queue insert — the existing auto-reply insertion function; guards run at send time
  const payload = {
    queue_key: key,
    queue_id: key,
    dedupe_key: key,
    queue_status: 'queued',
    scheduled_for: now,
    scheduled_for_utc: now,
    scheduled_for_local: now,
    timezone: tz?.ok ? tz.iana : null,
    send_priority: 5,
    retry_count: 0,
    // no automatic retry for AI text: a failure goes to a human, never a second attempt
    max_retries: 0,
    message_body: draft,
    message_text: draft,
    seller_first_name: clean(state.input?.names?.first_name) || null,
    to_phone_number: state.seller_phone,
    from_phone_number: continuity.sender_number,
    agent_name: continuity.persona_name,
    master_owner_id: state.master_owner_id || null,
    prospect_id: state.prospect_id || null,
    property_id: state.property_id || null,
    // ORIGIN ai_generated (owner 2026-10-15): NOT a template. No template id of any kind;
    // the authority is the immutable ai_generated_messages record (same queue key, body hash)
    message_origin: 'ai_generated',
    template_id: null,
    selected_template_id: null,
    template_source: 'ai_generated',
    message_type: 'ai_conversation_reply',
    type: AI_CONVERSATION_SOURCE,
    use_case_template: useCase,
    character_count: draft.length,
    thread_key: threadKey,
    source: AI_CONVERSATION_SOURCE,
    source_event_id: inboundId,
    inbound_message_id: inboundId,
    language: 'English',
    sms_eligible: true,
    routing_allowed: true,
    metadata: {
      source: AI_CONVERSATION_SOURCE,
      action_type: 'ai_conversation_reply',
      decision_id: clean(candidate.decision_id) || null,
      model: clean(candidate.model) || null,
      draft_hash: hash,
      message_origin: 'ai_generated',
      ai_message_id: rec.id,
      ai_message_body_sha256: record.body_sha256,
      ai_message_record_version: record.record_version,
      ledger_snapshot_hash: record.ledger_snapshot_hash,
      playbook_version: record.playbook_version,
      inbound_received_at: inboundRow.at || null,
      decision_contract_version: DECISION_CONTRACT_VERSION,
      validator_version: VALIDATOR_VERSION,
      executor_version: R3_EXECUTOR_VERSION,
      send_policy_version: AI_SEND_POLICY_VERSION,
      ai_scope_category: scope.category,
      question_kind: kind,
      inbound_message_event_id: inboundId,
      stage: ledger.stage?.stage || null,
      reservations: { inbound: inboundId, seller_day: `${sealedThreadRef(threadKey)}:${day}`, global_slot: slot.n },
      agent_persona: continuity.persona_name,
      persona_continuity: { version: continuity.version, persona_source: continuity.persona_source, sender_source: continuity.sender_source },
      no_direct_provider_send: true,
    },
  }
  let res = null
  try { res = await insertQueueRow(payload) } catch (e) { res = { ok: false, reason: e?.message || 'insert_threw' } }
  const queueRowId = res?.queue_row_id || res?.item_id || res?.id || null
  if (!res?.ok || !queueRowId) {
    await releaseAll('queue_insert_failed')
    try { await reservations.release({ record_item_id: inboundClaim.record_item_id, scope: inboundClaim.scope, key: inboundClaim.key, error: 'queue_insert_failed' }) } catch { /* lease */ }
    return out('held', ['queue_insert_failed'], { insert_reason: res?.reason || null })
  }
  for (const r of [inboundClaim, ...taken]) {
    try { await reservations.complete({ record_item_id: r.record_item_id, scope: r.scope, key: r.key, metadata: { outcome: 'enqueued', queue_row_id: queueRowId } }) } catch { /* the lease keeps it claimed */ }
  }
  const rawStatus = clean(res?.raw?.queue_status).toLowerCase()
  if (rawStatus === 'cancelled') {
    try { await recordEvent({ aiMessageId: rec.id, eventType: 'cancelled', queueRowId, detail: { reason: clean(res?.raw?.paused_reason) || 'cancelled_by_trigger' } }) } catch { /* best effort */ }
    return out('blocked_at_insert', [clean(res?.raw?.paused_reason) || 'cancelled_by_trigger'], { queue_row_id: queueRowId, ai_message_id: rec.id })
  }
  try { await recordEvent({ aiMessageId: rec.id, eventType: 'queued', queueRowId, detail: { queue_key: key } }) } catch { /* the queue row + record already bind */ }
  return out('enqueued', [], { queue_row_id: queueRowId, category: scope.category, draft_hash: hash, use_case_template: payload.use_case_template, ai_message_id: rec.id })
}

export default executeAiConversationReply
