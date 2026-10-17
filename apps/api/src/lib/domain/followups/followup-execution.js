// FOLLOW-UP EXECUTION PIPELINE (rc-8.5.21, owner P0 2026-10-16).
//
// "A follow_up_at field alone is not a scheduled action." In rc-8.5.20 nothing that sends read
// inbox_thread_state.follow_up_at: a 30-day nurture whose send_queue row was never written (or was
// cancelled by an inbound and never re-written) silently never happened. This module is the ONE
// pipeline that turns every eligible follow-up intent into an executable job with a verified
// outcome. It is NOT a second queue — it reuses:
//
//   intent      inbox_thread_state.follow_up_at (+ disposition / stage → kind)
//   job         the agent runtime (agent.runtime_enqueue_event_at: lease, bounded attempts,
//               dead letter) — kinds followup.execution_sweep / followup.dispatch / followup.reconcile
//   claim       public.idempotency_ledger, scope `followup_execution`, one key per follow-up
//               (and per retry attempt): at most one send_queue write, ever
//   send row    the canonical follow-up writer seller-followup-scheduler.scheduleFollowUp →
//               enqueueSendQueueItem → public.send_queue (unique queue_key = the DB-level dedupe);
//               the body is resolved at send time from an APPROVED sms_templates row
//               (resolve-deferred-queue-message.js) — no approved row ⇒ held for a human
//   dispatch    process-send-queue, with every existing gate (send-time contact guard incl. the
//               automation-hold port and the recontact guard, contact window, sender routing,
//               provider transport with its own bounded no-SID-safe retries)
//   outcome     the send_queue row (provider id / delivered_at / failed_reason) ← provider callbacks
//
//   kinds       not_interested_nurture (30 d) · seller_requested_callback · stage_silence
//               s2_silence / offer_silence are written by the no-response chain
//               (no-response-followup.js) as send_queue rows; the reconciliation covers them too
//
// Every dispatch RE-CHECKS, fresh, right before the write: the intent still stands (same
// follow_up_at, no newer inbound), thread suppression, the automation-hold registry (also at
// enqueue), the full send-time contact guard (suppression list, automation suppressions, opt-out,
// wrong number, property-scoped ownership denial from contact_property_resolution and the thread's
// own text), the recipient-local contact window (shared reply-timing, purpose outreach), sender
// health, the outbound mode, and that an approved template exists in the seller's language.
//
// Retry: transport failures only (the row failed with no provider id and no ambiguous-accept
// marker), at most FOLLOWUP_MAX_ATTEMPTS, never after an ambiguous accept / a provider id.
//
// BORN OFF: system_control `followup_execution_mode` absent / invalid ⇒ off; the handlers are
// registered only with LC_FOLLOWUP_EXECUTION=1; the runtime kinds must be armed by the owner; the
// schedules are created DISABLED (PROPOSED_20261016161000_followup_execution_schedules.sql).
import crypto from 'node:crypto'

import { checkAutomationHoldPort } from '../holds-port/automation-hold-port.js'
import { evaluateReplyTiming, resolveRecipientZones } from '../queue/reply-timing.js'
import { NURTURE_TEMPLATE_CANDIDATES } from '../queue/resolve-deferred-queue-message.js'
import { resolveFollowUpPolicyForStage } from '../seller-flow/followup-policy-registry.js'
import { latestIdentifiableSellerLanguage } from '../classification/seller-reply-language.js'
import { encodeRef, decodeRef } from '../../ai/conversation-ai-shadow-hook.js'

export const FOLLOWUP_EXECUTION_VERSION = 'followup-execution.v1'
export const FOLLOWUP_EXECUTION_MODE_KEY = 'followup_execution_mode'
export const FOLLOWUP_EXECUTION_MODES = Object.freeze(['off', 'dry_run', 'live'])
export const FOLLOWUP_EXECUTION_ENV = 'LC_FOLLOWUP_EXECUTION'
export const FOLLOWUP_SWEEP_KIND = 'followup.execution_sweep'
export const FOLLOWUP_DISPATCH_KIND = 'followup.dispatch'
export const FOLLOWUP_RECONCILE_KIND = 'followup.reconcile'
export const FOLLOWUP_LEDGER_SCOPE = 'followup_execution'
export const FOLLOWUP_SOURCE = 'followup_execution_pipeline'
export const FOLLOWUP_MAX_ATTEMPTS = 2
export const FOLLOWUP_HORIZON_MS = 36 * 3_600_000 // ≤ the runtime's 2-day not_before ceiling
export const FOLLOWUP_OUTCOME_GRACE_MS = 6 * 3_600_000
export const FOLLOWUP_LEDGER_LEASE_MS = 5 * 60_000

export const FOLLOWUP_KINDS = Object.freeze({
  NOT_INTERESTED_NURTURE: 'not_interested_nurture',
  SELLER_CALLBACK: 'seller_requested_callback',
  STAGE_SILENCE: 'stage_silence',
  S2_SILENCE: 's2_silence',
  OFFER_SILENCE: 'offer_silence',
})
const K = FOLLOWUP_KINDS

/** Dispatch / sweep result codes (codes only: agent.payload_is_clean). */
export const FOLLOWUP_CODES = Object.freeze({
  OFF: 'FOLLOWUP_EXECUTION_OFF',
  DRY_RUN: 'DRY_RUN_WOULD_ENQUEUE',
  INTENT_GONE: 'INTENT_GONE',
  SUPERSEDED: 'SUPERSEDED',
  SUPPRESSED: 'SUPPRESSED',
  TERMINAL: 'TERMINAL_DISPOSITION',
  HELD: 'AUTOMATION_HOLD',
  BLOCKED: 'BLOCKED_AT_DISPATCH',
  HOLD_FOR_HUMAN: 'HOLD_FOR_HUMAN',
  OUTBOUND_PAUSED: 'OUTBOUND_PAUSED',
  ADOPTED: 'ADOPTED_EXISTING_ROW',
  DUPLICATE: 'DUPLICATE',
  ENQUEUED: 'ENQUEUED',
  ATTEMPTS_EXHAUSTED: 'ATTEMPTS_EXHAUSTED',
})
const C = FOLLOWUP_CODES

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const iso = (ms) => new Date(ms).toISOString()
const ms = (v) => { const t = Date.parse(clean(v)); return Number.isFinite(t) ? t : null }

/** Absent / blank / invalid / unreadable ⇒ off. */
export function resolveFollowUpExecutionMode(raw) {
  const v = lower(raw)
  return FOLLOWUP_EXECUTION_MODES.includes(v) ? v : 'off'
}

/** The handlers exist only with the env flag (the runtime then never claims these kinds otherwise). */
export function followUpExecutionRequested(env = process.env) {
  return clean(env?.[FOLLOWUP_EXECUTION_ENV]) === '1'
}

// ── intent → kind ────────────────────────────────────────────────────────────
const TERMINAL_DISPOSITIONS = new Set([
  'suppressed', 'opt_out', 'opted_out', 'stop', 'dnc', 'do_not_contact', 'wrong_number', 'wrong_person',
  'not_owner', 'property_specific_non_owner', 'former_owner_respondent', 'sold', 'sold_property', 'hostile_or_legal', 'dead', 'closed',
])
const NOT_INTERESTED_DISPOSITIONS = new Set(['not_interested', 'disinterest', 'not_interested_nurture'])
const CALLBACK_DISPOSITIONS = new Set(['callback', 'call_back', 'check_back', 'need_time', 'not_ready', 'future_nurture', 'requested_followup', 'follow_up_requested', 'seller_callback'])
/** Stage silence → the declared stage use case (resolved from sms_templates exactly; fail closed). */
export const STAGE_SILENCE_USE_CASE = Object.freeze({
  ownership_confirmation: 'ownership_check',
  offer_interest: 'consider_selling_follow_up',
  asking_price: 'asking_price_follow_up',
  property_condition: 'ask_condition_clarifier',
})

/**
 * Pure. The follow-up an inbox_thread_state row asks for, or why none.
 * @returns {{ kind: string|null, intent: string|null, use_case: string|null, stage: string|null, skip: string|null }}
 */
export function followUpIntentOf(state = {}) {
  if (!ms(state.follow_up_at)) return { kind: null, intent: null, use_case: null, stage: null, skip: 'no_follow_up_at' }
  if (state.is_suppressed === true) return { kind: null, intent: null, use_case: null, stage: null, skip: 'thread_suppressed' }
  const d = lower(state.disposition)
  const stage = lower(state.lifecycle_stage) || lower(state.stage) || null
  if (TERMINAL_DISPOSITIONS.has(d)) return { kind: null, intent: null, use_case: null, stage, skip: 'terminal_disposition' }
  if (NOT_INTERESTED_DISPOSITIONS.has(d)) return { kind: K.NOT_INTERESTED_NURTURE, intent: 'not_interested', use_case: 'nurture_not_interested', stage, skip: null }
  if (CALLBACK_DISPOSITIONS.has(d)) return { kind: K.SELLER_CALLBACK, intent: 'seller_callback', use_case: 'nurture_seller_callback', stage, skip: null }
  const use_case = STAGE_SILENCE_USE_CASE[stage] || null
  return { kind: K.STAGE_SILENCE, intent: 'stage_no_reply', use_case, stage, skip: null }
}

/** One key per follow-up (thread state row × kind × due instant) and per retry attempt. */
export function followUpJobKey({ state_id, kind, follow_up_at, attempt = 1 }) {
  const due = ms(follow_up_at)
  const h = crypto.createHash('sha256').update(`${FOLLOWUP_EXECUTION_VERSION}|${clean(state_id)}|${clean(kind)}|${due == null ? '' : iso(due)}`).digest('hex').slice(0, 40)
  return `fu1.${h}${attempt > 1 ? `.a${attempt}` : ''}`
}

/** Runtime job input: identifiers only, letter-encoded (agent.payload_is_clean). */
export function encodeDispatchInput({ state_id, kind, follow_up_at, attempt = 1 }) {
  return { state_ref: encodeRef(clean(state_id)), followup_kind: clean(kind), due_at: iso(ms(follow_up_at)), attempt_ref: encodeRef(String(attempt)) }
}
export function decodeDispatchInput(input = {}) {
  const state_id = typeof input?.state_ref === 'string' && input.state_ref.length <= 160 ? decodeRef(input.state_ref) : null
  const attempt = typeof input?.attempt_ref === 'string' ? Number(decodeRef(input.attempt_ref)) : 1
  if (!state_id || !/^[0-9a-f-]{36}$/i.test(state_id) || !Object.values(K).includes(input?.followup_kind) || !ms(input?.due_at)) return null
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > FOLLOWUP_MAX_ATTEMPTS) return null
  return { state_id, kind: input.followup_kind, follow_up_at: input.due_at, attempt }
}

// ── send_queue row facts ─────────────────────────────────────────────────────
const LIVE_STATUSES = new Set(['queued', 'ready', 'runnable', 'scheduled', 'pending', 'paused', 'paused_after_hours', 'processing', 'approved', 'approval', 'held', 'sending'])
const meta = (row) => (row?.metadata && typeof row.metadata === 'object' ? row.metadata : {})
/** A follow-up row on the thread that is still going to send (not sent, live status). */
export function isLiveFollowUpRow(row = {}) {
  if (row.sent_at) return false
  return LIVE_STATUSES.has(lower(row.queue_status))
}
/** Any automated follow-up row (pipeline, nurture scheduler, no-response chain, stage layer). */
export function isFollowUpRow(row = {}) {
  const m = meta(row)
  return lower(row.type) === 'followup' || lower(row.message_type) === 'followup' || clean(m.followup_job_key) !== '' || lower(m.source) === FOLLOWUP_SOURCE
}
export function followUpKindOfRow(row = {}) {
  const m = meta(row)
  if (clean(m.followup_kind)) return clean(m.followup_kind)
  const uc = lower(row.use_case_template)
  if (lower(m.no_response_kind) === 'offer' || uc.includes('offer')) return K.OFFER_SILENCE
  if (clean(m.no_response_kind) || lower(m.source).includes('no_response')) return K.S2_SILENCE
  if (uc === 'nurture_not_interested') return K.NOT_INTERESTED_NURTURE
  return K.STAGE_SILENCE
}

const TRANSPORT_FAILURE_RE = /\b(?:timeout|timed out|network|econn\w*|socket|transport|5\d\d|unavailable|rate.?limit|429)\b/i
const AMBIGUOUS_RE = /\b(?:no.?sid|ambiguous)\b/i
/**
 * Pure. The verified outcome of a follow-up send_queue row.
 * @returns {{ outcome: 'delivered'|'provider_accepted'|'accepted_unconfirmed'|'transport_failure'|'ambiguous'|'terminal_failure'|'cancelled'|'held_for_human'|'pending'|'overdue_no_outcome', retryable: boolean }}
 */
export function classifyFollowUpOutcome(row = {}, { now = Date.now() } = {}) {
  const m = meta(row)
  const status = lower(row.queue_status)
  const provider_id = clean(row.provider_message_id) || clean(row.textgrid_message_id)
  if (row.delivered_at || row.delivery_confirmed === true || status === 'delivered') return { outcome: 'delivered', retryable: false }
  if (status === 'sent' || row.sent_at || provider_id) {
    const sentAt = ms(row.sent_at) ?? ms(row.updated_at)
    if (sentAt != null && now - sentAt > FOLLOWUP_OUTCOME_GRACE_MS) return { outcome: 'accepted_unconfirmed', retryable: false }
    return { outcome: 'provider_accepted', retryable: false }
  }
  if (status.startsWith('failed') || status === 'invalid_number' || status === 'carrier_blocked') {
    const reason = clean(row.failed_reason) || clean(m.failed_reason) || clean(m.last_error)
    if (m.no_sid_ambiguous_send === true || m.ambiguous_send === true || AMBIGUOUS_RE.test(reason)) return { outcome: 'ambiguous', retryable: false }
    if (status === 'failed_transport' || TRANSPORT_FAILURE_RE.test(reason)) return { outcome: 'transport_failure', retryable: true }
    return { outcome: 'terminal_failure', retryable: false }
  }
  if (status === 'cancelled' || status === 'canceled' || status === 'blocked' || status === 'skipped') return { outcome: 'cancelled', retryable: false }
  if (status.startsWith('paused_')) return { outcome: 'held_for_human', retryable: false }
  const due = ms(row.scheduled_for_utc) ?? ms(row.scheduled_for)
  if (due != null && now - due > FOLLOWUP_OUTCOME_GRACE_MS) return { outcome: 'overdue_no_outcome', retryable: false }
  return { outcome: 'pending', retryable: false }
}

// ── the sweep: intent → durable job ──────────────────────────────────────────
/**
 * Pure. For each due-soon intent: adopt the live row that already executes it, enqueue a dispatch
 * job at its due time, or skip with a reason.
 */
export function planFollowUpSweep({ intents = [], rowsByThread = new Map(), now = Date.now(), horizonMs = FOLLOWUP_HORIZON_MS } = {}) {
  const out = []
  for (const s of intents) {
    const i = followUpIntentOf(s)
    const due = ms(s.follow_up_at)
    if (!i.kind) { out.push({ state_id: s.id, decision: 'skip', reason: i.skip }); continue }
    if (due > now + horizonMs) { out.push({ state_id: s.id, decision: 'not_yet', reason: 'beyond_horizon' }); continue }
    const rows = rowsByThread.get(clean(s.thread_key)) || []
    const live = rows.find((r) => isLiveFollowUpRow(r) && isFollowUpRow(r))
    if (live) { out.push({ state_id: s.id, decision: 'adopted', reason: 'live_followup_row_exists', queue_row_id: live.id || null, kind: i.kind }); continue }
    out.push({ state_id: s.id, decision: 'enqueue', kind: i.kind, not_before: iso(Math.max(due, now)), job_key: followUpJobKey({ state_id: s.id, kind: i.kind, follow_up_at: s.follow_up_at }) })
  }
  return out
}

/**
 * The enqueue sweep. Consults the automation-hold registry at ENQUEUE (a held thread gets no job).
 * The runtime event key carries the UTC day: a follow-up not executed today (paused outbound,
 * hold) is re-offered tomorrow; the ledger still allows at most one send row per follow-up.
 */
export async function runFollowUpSweep(deps = {}) {
  const now = deps.now ? Date.parse(deps.now()) : Date.now()
  const mode = resolveFollowUpExecutionMode(await safeRead(deps.readSwitch, FOLLOWUP_EXECUTION_MODE_KEY))
  if (mode === 'off') return { code: C.OFF, mode }
  const intents = await deps.loadDueIntents({ until: iso(now + FOLLOWUP_HORIZON_MS), limit: deps.limit || 200 })
  const rowsByThread = await deps.loadThreadFollowUpRows(intents.map((s) => clean(s.thread_key)).filter(Boolean))
  const plan = planFollowUpSweep({ intents, rowsByThread, now })
  const counts = { intents: intents.length, enqueued: 0, deduped: 0, adopted: 0, held: 0, skipped: 0, not_yet: 0, dry_run: 0, enqueue_failed: 0 }
  const byId = new Map(intents.map((s) => [s.id, s]))
  for (const p of plan) {
    if (p.decision === 'adopted') { counts.adopted += 1; continue }
    if (p.decision === 'not_yet') { counts.not_yet += 1; continue }
    if (p.decision === 'skip') { counts.skipped += 1; continue }
    const s = byId.get(p.state_id)
    const hold = await checkAutomationHoldPort({ threadKey: s.thread_key, threadId: s.id, propertyId: s.property_id || null, opportunityId: s.opportunity_id || null, masterOwnerId: s.master_owner_id || null, capability: 'followup_enqueue' }, { checker: deps.automationHoldChecker || null })
    if (hold.held) { counts.held += 1; continue }
    if (mode === 'dry_run') { counts.dry_run += 1; continue }
    const r = await deps.enqueueAt({ kind: FOLLOWUP_DISPATCH_KIND, event_key: `${p.job_key}:${iso(now).slice(0, 10)}`, input: encodeDispatchInput({ state_id: s.id, kind: p.kind, follow_up_at: s.follow_up_at }), priority: 60, not_before: p.not_before })
    if (r?.ok === false) counts.enqueue_failed += 1
    else if (r?.deduped) counts.deduped += 1
    else counts.enqueued += 1
  }
  return { code: 'SWEPT', mode, counts }
}

async function safeRead(readSwitch, key) {
  try { return typeof readSwitch === 'function' ? await readSwitch(key) : null } catch { return null }
}

const SCHEDULING_FOLLOWUP_MODES = new Set(['full_live', 'live', 'live_limited', 'scheduled', 'schedule_only'])
/** Outbound mode: the queue processor is live, follow-ups are in a scheduling mode, no emergency stop. */
export async function outboundModeOpen(readSwitch) {
  const qp = lower(await safeRead(readSwitch, 'queue_processor_mode'))
  const fu = lower(await safeRead(readSwitch, 'followup_automation_mode'))
  const stop = clean(await safeRead(readSwitch, 'queue_emergency_stop_at'))
  if (stop && Number.isFinite(Date.parse(stop))) return { open: false, reason: 'emergency_stop_active' }
  if (qp !== 'live') return { open: false, reason: `queue_processor_mode:${qp || 'unset'}` }
  if (!SCHEDULING_FOLLOWUP_MODES.has(fu)) return { open: false, reason: `followup_automation_mode:${fu || 'unset'}` }
  return { open: true, reason: null }
}

const UNHEALTHY_SENDER = new Set(['disabled', 'inactive', 'failed', 'blocked', 'retired', 'paused', 'suspended', 'cooling'])

// ── the dispatch: re-check everything, then ONE claimed write ────────────────
/**
 * @param {{ state_id: string, kind: string, follow_up_at: string, attempt?: number }} job
 * @param {object} deps see createFollowUpDeps
 * @returns {Promise<{ code: string, reason?: string|null, queue_row_id?: string|null, mode?: string, send_at?: string }>}
 */
export async function runFollowUpDispatch(job, deps = {}) {
  const now = deps.now ? Date.parse(deps.now()) : Date.now()
  const attempt = job.attempt || 1
  const mode = resolveFollowUpExecutionMode(await safeRead(deps.readSwitch, FOLLOWUP_EXECUTION_MODE_KEY))
  if (mode === 'off') return { code: C.OFF, mode }
  if (attempt > FOLLOWUP_MAX_ATTEMPTS) return { code: C.ATTEMPTS_EXHAUSTED }

  // 1. the intent still stands, fresh
  const s = await deps.loadIntent(job.state_id)
  if (!s || !ms(s.follow_up_at)) return { code: C.INTENT_GONE }
  if (attempt === 1 && ms(s.follow_up_at) !== ms(job.follow_up_at)) return { code: C.SUPERSEDED, reason: 'follow_up_at_changed' }
  const i = followUpIntentOf(s)
  if (!i.kind) return { code: i.skip === 'thread_suppressed' ? C.SUPPRESSED : C.TERMINAL, reason: i.skip }
  if (i.kind !== job.kind) return { code: C.SUPERSEDED, reason: 'kind_changed' }
  // the seller wrote at or after the due instant: the conversation moved on (the inbound path owns it)
  if (ms(s.last_inbound_at) != null && ms(s.last_inbound_at) >= ms(job.follow_up_at)) return { code: C.SUPERSEDED, reason: 'newer_inbound' }

  // 2. the automation-hold registry (fail closed)
  const hold = await checkAutomationHoldPort({ threadKey: s.thread_key, threadId: s.id, propertyId: s.property_id || null, opportunityId: s.opportunity_id || null, masterOwnerId: s.master_owner_id || null, capability: 'followup_dispatch' }, { checker: deps.automationHoldChecker || null })
  if (hold.held) return { code: C.HELD, reason: hold.hold_type }

  // 3. an existing live follow-up row already executes it (written elsewhere) — adopt, never double
  const rows = (await deps.loadThreadFollowUpRows([clean(s.thread_key)])).get(clean(s.thread_key)) || []
  const live = rows.find((r) => isLiveFollowUpRow(r) && isFollowUpRow(r) && clean(meta(r).followup_job_key) !== followUpJobKey({ state_id: s.id, kind: i.kind, follow_up_at: job.follow_up_at, attempt }))
  if (live) return { code: C.ADOPTED, queue_row_id: live.id || null }

  // 4. stage policy (stage silences only): enabled stage + the automated-follow-up ceiling
  if (i.kind === K.STAGE_SILENCE) {
    if (!i.use_case) return { code: C.HOLD_FOR_HUMAN, reason: 'stage_use_case_unknown' }
    const { policy } = resolveFollowUpPolicyForStage(i.stage)
    const used = rows.filter((r) => isFollowUpRow(r) && !['cancelled', 'canceled'].includes(lower(r.queue_status))).length
    if (!policy?.enabled) return { code: C.TERMINAL, reason: 'stage_followups_disabled' }
    if (used >= (policy.max_automated_followups ?? 0)) return { code: C.TERMINAL, reason: 'stage_followup_ceiling' }
  }

  // 5. the hypothetical row through the SAME send-time contact guard the processor runs
  const hypothetical = {
    to_phone_number: s.canonical_e164 || s.thread_key, thread_key: s.thread_key, property_id: s.property_id || null,
    master_owner_id: s.master_owner_id || null, prospect_id: s.prospect_id || null, type: 'followup', message_type: 'followup',
    use_case_template: i.use_case, metadata: { source: FOLLOWUP_SOURCE, followup_kind: i.kind },
  }
  const guard = await deps.guard(hypothetical)
  if (guard?.blocked) return { code: C.BLOCKED, reason: guard.reason || 'blocked' }

  // 6. language + an APPROVED template (sms_templates) for this kind, else a human
  const language = clean(await deps.languageFor(s))
  if (!language) return { code: C.HOLD_FOR_HUMAN, reason: 'language_unknown' }
  const candidates = i.kind === K.STAGE_SILENCE ? [i.use_case] : (NURTURE_TEMPLATE_CANDIDATES[i.intent] || [])
  if (!candidates.length || !(await deps.templatesAvailable(candidates, language))) return { code: C.HOLD_FOR_HUMAN, reason: 'no_approved_template' }

  // 7. outbound mode + sender health
  const outbound = await outboundModeOpen(deps.readSwitch)
  if (!outbound.open) return { code: C.OUTBOUND_PAUSED, reason: outbound.reason }
  let from = clean(s.our_number) || null
  if (from) {
    const status = lower(await deps.senderStatus(from))
    // an unhealthy sticky sender is dropped: the processor's approved routing picks a healthy one
    if (!status || UNHEALTHY_SENDER.has(status)) from = null
  }

  // 8. contact window: the first lawful recipient-local instant ≥ due (shared reply-timing, outreach)
  const zones = resolveRecipientZones({ recipientPhone: s.canonical_e164 || s.thread_key, propertyGeography: s.property_geography || null }).zones
  const at = iso(Math.max(now, ms(job.follow_up_at)))
  const timing = evaluateReplyTiming({ purpose: 'outreach', at, zones })
  const send_at = timing.lawful ? at : timing.next_permitted_at
  if (!send_at) return { code: C.HOLD_FOR_HUMAN, reason: 'no_lawful_window' }

  if (mode === 'dry_run') return { code: C.DRY_RUN, mode, send_at }

  // 9. ONE claimed write (crash-safe: the queue_key is deterministic from the job key)
  const key = followUpJobKey({ state_id: s.id, kind: i.kind, follow_up_at: job.follow_up_at, attempt })
  const claim = await deps.reservations.begin({ scope: FOLLOWUP_LEDGER_SCOPE, key, summary: `followup:${i.kind}`, metadata: { kind: i.kind, attempt }, lease_ms: FOLLOWUP_LEDGER_LEASE_MS })
  if (claim?.duplicate && claim.reason !== 'stale_or_failed_event_reclaimed') {
    if (claim.reason === 'event_already_processing') {
      const e = new Error('followup_dispatch_in_progress'); e.code = 'FOLLOWUP_IN_PROGRESS'; e.retryable = true; throw e
    }
    return { code: C.DUPLICATE, reason: claim.reason || 'duplicate' }
  }
  let w
  try {
    w = await deps.writeFollowUp(i.intent, s.canonical_e164 || s.thread_key, {
      property_id: s.property_id || null, master_owner_id: s.master_owner_id || null, prospect_id: s.prospect_id || null,
      followup_dedupe_scope: key, scheduled_for_at: send_at, language, stage: i.stage, stage_no_reply_hours: i.kind === K.STAGE_SILENCE ? 24 : undefined,
      followup_use_case: i.kind === K.STAGE_SILENCE ? i.use_case : undefined, from_phone_number: from, source: FOLLOWUP_SOURCE,
      followup_job_key: key, followup_kind: i.kind, followup_attempt: attempt, followup_due_at: iso(ms(job.follow_up_at)), skip_email_lane: false,
    })
  } catch (err) {
    await deps.reservations.release({ scope: FOLLOWUP_LEDGER_SCOPE, key, error: clean(err?.message).slice(0, 120) || 'write_failed' })
    throw err
  }
  const replay = w?.reason === 'duplicate_followup_exists' && w.queue_row_id
  if (!w?.ok && !replay) {
    await deps.reservations.release({ scope: FOLLOWUP_LEDGER_SCOPE, key, error: clean(w?.reason) || 'write_refused' })
    if (w?.reason === 'phone_suppressed_21610') return { code: C.BLOCKED, reason: 'phone_suppressed_21610' }
    return { code: C.HOLD_FOR_HUMAN, reason: clean(w?.reason) || 'write_refused' }
  }
  await deps.reservations.complete({ scope: FOLLOWUP_LEDGER_SCOPE, key, metadata: { queue_row_id: w.queue_row_id || null, channel: w.channel || 'sms' } })
  return { code: replay ? C.ADOPTED : C.ENQUEUED, queue_row_id: w.queue_row_id || w.email_queue_row_id || null, send_at, channel: w.channel || 'sms' }
}

// ── reconciliation: dates with no job, jobs with no outcome, duplicates, retries ─
/**
 * Pure. intents = due inbox_thread_state rows; rowsByThread = send_queue follow-up rows.
 * @returns {{ counts: object, missing_job: string[], no_outcome: string[], duplicates: string[], ambiguous: string[], retry: Array<{state_id, kind, follow_up_at, attempt}> }}
 */
export function reconcileFollowUps({ intents = [], rowsByThread = new Map(), now = Date.now(), graceMs = FOLLOWUP_OUTCOME_GRACE_MS } = {}) {
  const counts = { intents_due: 0, executing: 0, missing_job: 0, no_outcome: 0, duplicates: 0, delivered: 0, accepted: 0, ambiguous: 0, transport_failed: 0, retry_scheduled: 0, retries_exhausted: 0, terminal_failed: 0, held_for_human: 0, cancelled: 0 }
  const out = { counts, missing_job: [], no_outcome: [], duplicates: [], ambiguous: [], retry: [] }
  const seenRows = new Set()
  for (const s of intents) {
    const i = followUpIntentOf(s)
    const due = ms(s.follow_up_at)
    if (!i.kind || due == null || due > now) continue
    counts.intents_due += 1
    const rows = (rowsByThread.get(clean(s.thread_key)) || []).filter(isFollowUpRow)
    rows.forEach((r) => seenRows.add(r))
    const live = rows.filter(isLiveFollowUpRow)
    const mine = rows.filter((r) => clean(meta(r).followup_job_key).startsWith(followUpJobKey({ state_id: s.id, kind: i.kind, follow_up_at: s.follow_up_at })))
    if (live.length > 1) { counts.duplicates += 1; out.duplicates.push(s.id) }
    if (!live.length && !mine.length) {
      if (now - due > graceMs) { counts.missing_job += 1; out.missing_job.push(s.id) }
      continue
    }
    counts.executing += 1
    const latest = [...mine].sort((a, b) => ((Number(meta(b).followup_attempt) || 1) - (Number(meta(a).followup_attempt) || 1)) || ((ms(b.created_at) || 0) - (ms(a.created_at) || 0)))[0]
    if (latest && !isLiveFollowUpRow(latest)) {
      const o = classifyFollowUpOutcome(latest, { now })
      const attempt = Number(meta(latest).followup_attempt) || 1
      if (o.outcome === 'transport_failure') {
        counts.transport_failed += 1
        if (attempt < FOLLOWUP_MAX_ATTEMPTS && !live.length) { counts.retry_scheduled += 1; out.retry.push({ state_id: s.id, kind: i.kind, follow_up_at: s.follow_up_at, attempt: attempt + 1 }) }
        else counts.retries_exhausted += 1
      }
    }
  }
  // every follow-up row (any writer): outcomes, overdue rows without an outcome, ambiguous accepts
  for (const rows of rowsByThread.values()) {
    for (const r of rows.filter(isFollowUpRow)) {
      const o = classifyFollowUpOutcome(r, { now })
      if (o.outcome === 'delivered') counts.delivered += 1
      else if (o.outcome === 'provider_accepted' || o.outcome === 'accepted_unconfirmed') counts.accepted += 1
      else if (o.outcome === 'ambiguous') { counts.ambiguous += 1; out.ambiguous.push(r.id) }
      else if (o.outcome === 'terminal_failure') counts.terminal_failed += 1
      else if (o.outcome === 'held_for_human') counts.held_for_human += 1
      else if (o.outcome === 'cancelled') counts.cancelled += 1
      if (o.outcome === 'overdue_no_outcome' || o.outcome === 'accepted_unconfirmed') { counts.no_outcome += 1; out.no_outcome.push(r.id) }
    }
  }
  return out
}

/** The reconciliation job: report (encoded refs only) + enqueue bounded transport retries. */
export async function runFollowUpReconcile(deps = {}) {
  const now = deps.now ? Date.parse(deps.now()) : Date.now()
  const mode = resolveFollowUpExecutionMode(await safeRead(deps.readSwitch, FOLLOWUP_EXECUTION_MODE_KEY))
  if (mode === 'off') return { code: C.OFF, mode }
  const intents = await deps.loadDueIntents({ until: iso(now), limit: deps.limit || 500 })
  const rowsByThread = await deps.loadThreadFollowUpRows(intents.map((s) => clean(s.thread_key)).filter(Boolean))
  const r = reconcileFollowUps({ intents, rowsByThread, now })
  let retries_enqueued = 0
  if (mode === 'live') {
    for (const x of r.retry) {
      const q = await deps.enqueueAt({ kind: FOLLOWUP_DISPATCH_KIND, event_key: `${followUpJobKey(x)}:retry`, input: encodeDispatchInput(x), priority: 50, not_before: iso(now + 15 * 60_000) })
      if (q?.ok !== false && !q?.deduped) retries_enqueued += 1
    }
  }
  const refs = (ids) => ids.slice(0, 25).map((id) => encodeRef(String(id)))
  return { code: 'RECONCILED', mode, counts: { ...r.counts, retries_enqueued }, missing_job_refs: refs(r.missing_job), no_outcome_refs: refs(r.no_outcome), duplicate_refs: refs(r.duplicates), ambiguous_refs: refs(r.ambiguous) }
}

// ── default IO (supabase) ────────────────────────────────────────────────────
const INTENT_COLS = 'id,thread_key,canonical_e164,property_id,master_owner_id,prospect_id,follow_up_at,disposition,stage,lifecycle_stage,is_suppressed,last_inbound_at,updated_at,our_number'
const ROW_COLS = 'id,queue_key,queue_status,thread_key,to_phone_number,type,message_type,use_case_template,scheduled_for,scheduled_for_utc,sent_at,delivered_at,delivery_confirmed,failed_reason,provider_message_id,textgrid_message_id,retry_count,max_retries,metadata,created_at,updated_at'

async function rows(q) {
  const r = await q
  if (r?.error) throw r.error
  return Array.isArray(r?.data) ? r.data : []
}

/**
 * Production composition: every read throws on error (the runtime retries the job, bounded,
 * then dead-letters it) — a follow-up is never written on a partial read.
 */
export function createFollowUpDeps({ supabase, readSwitch, enqueueAt = null, automationHoldChecker = null, reservations = null, writeFollowUp = null, guard = null, now = null } = {}) {
  return {
    now,
    readSwitch,
    enqueueAt,
    automationHoldChecker,
    async loadDueIntents({ until, limit = 200 }) {
      return rows(supabase.from('inbox_thread_state').select(INTENT_COLS).lte('follow_up_at', until).order('follow_up_at', { ascending: true }).limit(limit))
    },
    async loadIntent(id) {
      return (await rows(supabase.from('inbox_thread_state').select(INTENT_COLS).eq('id', id).limit(1)))[0] || null
    },
    async loadThreadFollowUpRows(threadKeys = []) {
      const out = new Map()
      const keys = [...new Set(threadKeys.filter(Boolean))]
      for (let i = 0; i < keys.length; i += 100) {
        const chunk = keys.slice(i, i + 100)
        for (const r of await rows(supabase.from('send_queue').select(ROW_COLS).in('thread_key', chunk).limit(2000))) {
          const k = clean(r.thread_key)
          if (!out.has(k)) out.set(k, [])
          out.get(k).push(r)
        }
      }
      return out
    },
    async languageFor(s) {
      const inbound = await rows(supabase.from('message_events').select('message_body,language,direction,created_at').eq('thread_key', s.thread_key).eq('direction', 'inbound').order('created_at', { ascending: false }).limit(20))
      return latestIdentifiableSellerLanguage(inbound) || null
    },
    async templatesAvailable(useCases, language) {
      const t = await rows(supabase.from('sms_templates').select('id,use_case,language').eq('is_active', true).eq('safe_for_auto_reply', true).in('language', [language]).in('use_case', useCases).limit(5))
      return t.length > 0
    },
    async senderStatus(phone) {
      const t = await rows(supabase.from('textgrid_numbers').select('status,phone_number').in('phone_number', [phone]).limit(1))
      return t[0] ? (clean(t[0].status) || 'active') : null
    },
    guard: guard || (async (row) => {
      const { loadSendTimeContactFacts, evaluateSendTimeContactGuard } = await import('../queue/send-time-contact-guard.js')
      try {
        const facts = await loadSendTimeContactFacts(supabase, row, { automationHoldChecker })
        return evaluateSendTimeContactGuard(row, facts)
      } catch (err) {
        return { blocked: true, reason: 'send_time_guard_read_failed', detail: { error: clean(err?.message).slice(0, 120) } }
      }
    }),
    reservations: reservations || {
      async begin(o) { return (await import('../events/idempotency-ledger.js')).beginIdempotentProcessing(o) },
      async complete({ scope, key, metadata }) { const m = await import('../events/idempotency-ledger.js'); return m.completeIdempotentProcessing({ record_item_id: `idempotency:${scope}:${key}`, scope, key, metadata }) },
      async release({ scope, key, error }) { const m = await import('../events/idempotency-ledger.js'); return m.failIdempotentProcessing({ record_item_id: `idempotency:${scope}:${key}`, scope, key, error }) },
    },
    writeFollowUp: writeFollowUp || (async (intent, threadKey, context) => {
      const { scheduleFollowUp } = await import('../seller-flow/seller-followup-scheduler.js')
      return scheduleFollowUp(intent, threadKey, context, supabase)
    }),
  }
}
