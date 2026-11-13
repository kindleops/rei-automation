// FOLLOW-UP EXECUTION — the agent-runtime face of the ONE follow-up lifecycle (owner P0 2026-10-17).
//
// rc-8.5.21-A built this pipeline on inbox_thread_state.follow_up_at and wrote the follow-up through
// scheduleFollowUp as a BODY-LESS send_queue row: the queue loader pauses an empty body before any claim
// (paused_invalid_queue_row / missing_message_body) and the render only ran after a claim, so that design
// could never send (the same defect that left 0 deferred follow-ups delivered in 120 days). The pipeline
// now drives the lifecycle in domain/followups/followup-lifecycle.js (storage + transitions:
// PROPOSED_20261017120000_followup_intent_lifecycle.sql). No parallel queue: the agent runtime only
// schedules the passes; the intent's own lease + the send_queue unique keys make every write exactly-once.
//
//   followup.execution_sweep   one MATERIALIZATION pass: due − lead intents → rendered, validated,
//                              re-checked, ONE nonempty send-ready send_queue row each (or a reason)
//   followup.dispatch          materialize ONE named intent now (operator / reconcile targeted run)
//   followup.reconcile         two-way reconciliation: every intent has a live record or a reason, every
//                              pending follow-up row has an intent, every follow_up_at is backed. REPORT
//                              ONLY unless the job input says { apply: true } (adopt legacy body-less rows
//                              and bare dates into intents; one bounded retry of a pre-accept failure)
//
// BORN OFF: system_control `followup_execution_mode` absent / invalid ⇒ off; the handlers are registered
// only with LC_FOLLOWUP_EXECUTION=1; the runtime kinds must be armed by the owner; the schedules are
// created DISABLED (PROPOSED_20261016163000_followup_execution_schedules.sql).
import { encodeRef, decodeRef } from '../../ai/conversation-ai-shadow-hook.js'
import { checkAutomationHoldPort } from '../holds-port/automation-hold-port.js'
import { resolveFollowUpPolicyForStage } from '../seller-flow/followup-policy-registry.js'
import {
  createFollowUpLifecycleDeps, withLifecycleHelpers, runFollowUpMaterialization, reconcileFollowUpLifecycle,
  resolveLifecycleMode, LIFECYCLE_MODE_KEY, EXECUTABLE_STATES,
} from './followup-lifecycle.js'

export const FOLLOWUP_EXECUTION_VERSION = 'followup-execution.v2'
export const FOLLOWUP_EXECUTION_MODE_KEY = LIFECYCLE_MODE_KEY
export const FOLLOWUP_EXECUTION_MODES = Object.freeze(['off', 'dry_run', 'live'])
export const FOLLOWUP_EXECUTION_ENV = 'LC_FOLLOWUP_EXECUTION'
export const FOLLOWUP_SWEEP_KIND = 'followup.execution_sweep'
export const FOLLOWUP_DISPATCH_KIND = 'followup.dispatch'
export const FOLLOWUP_RECONCILE_KIND = 'followup.reconcile'
export const FOLLOWUP_SOURCE = 'followup_execution_pipeline'
export const FOLLOWUP_RECONCILE_MAX_RETRIES = 1

export const FOLLOWUP_KINDS = Object.freeze({
  NOT_INTERESTED_NURTURE: 'not_interested_nurture',
  SELLER_CALLBACK: 'seller_requested_callback',
  STAGE_SILENCE: 'stage_silence',
})
const K = FOLLOWUP_KINDS

export const FOLLOWUP_CODES = Object.freeze({
  OFF: 'FOLLOWUP_EXECUTION_OFF',
  DRY_RUN: 'DRY_RUN_REPORT',
  INPUT_INVALID: 'FOLLOWUP_INPUT_INVALID',
  SWEPT: 'SWEPT',
  RECONCILED: 'RECONCILED',
})
const C = FOLLOWUP_CODES

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const toMs = (v) => { const t = Date.parse(clean(v)); return Number.isFinite(t) ? t : null }

/** Absent / blank / invalid / unreadable ⇒ off. */
export function resolveFollowUpExecutionMode(raw) {
  return resolveLifecycleMode(raw)
}

/** The handlers exist only with the env flag (the runtime then never claims these kinds otherwise). */
export function followUpExecutionRequested(env = process.env) {
  return clean(env?.[FOLLOWUP_EXECUTION_ENV]) === '1'
}

async function modeOf(readSwitch) {
  try { return resolveFollowUpExecutionMode(typeof readSwitch === 'function' ? await readSwitch(FOLLOWUP_EXECUTION_MODE_KEY) : null) } catch { return 'off' }
}

// ── legacy thread intent (a bare follow_up_at written before the lifecycle) → scheduler intent ──────
const TERMINAL_DISPOSITIONS = new Set([
  'suppressed', 'opt_out', 'opted_out', 'stop', 'dnc', 'do_not_contact', 'wrong_number', 'wrong_person',
  'not_owner', 'property_specific_non_owner', 'former_owner_respondent', 'sold', 'sold_property', 'hostile_or_legal', 'dead', 'closed',
  // owner 2026-10-17: "No thanks" to the ownership question — a property × contact hold, never a follow-up
  'declined_unverified', 'ownership_declined_unverified',
])
// a stage-silence follow-up only for a thread with NO disposition or a neutral / engaged one; any other
// (unknown) disposition fails CLOSED — it must never fall through to a stage question (it could re-ask ownership)
const STAGE_SILENCE_DISPOSITIONS = new Set(['', 'none', 'open', 'active', 'engaged', 'interested', 'positive', 'neutral'])
const NOT_INTERESTED_DISPOSITIONS = new Set(['not_interested', 'disinterest', 'not_interested_nurture'])
const CALLBACK_DISPOSITIONS = new Set(['callback', 'call_back', 'check_back', 'need_time', 'not_ready', 'future_nurture', 'requested_followup', 'follow_up_requested', 'seller_callback'])
export const STAGE_SILENCE_USE_CASE = Object.freeze({
  ownership_confirmation: 'ownership_check',
  offer_interest: 'consider_selling_follow_up',
  asking_price: 'asking_price_follow_up',
  property_condition: 'ask_condition_clarifier',
})
/**
 * Pure. The follow-up a legacy inbox_thread_state.follow_up_at asks for (used ONLY by the reconciliation's
 * adoption of dates written before the lifecycle), or why none.
 */
export function followUpIntentOf(state = {}) {
  if (toMs(state.follow_up_at) == null) return { kind: null, intent: null, use_case: null, stage: null, skip: 'no_follow_up_at' }
  if (state.is_suppressed === true) return { kind: null, intent: null, use_case: null, stage: null, skip: 'thread_suppressed' }
  const d = lower(state.disposition)
  const stage = lower(state.lifecycle_stage) || lower(state.stage) || null
  if (d === 'declined_unverified' || d === 'ownership_declined_unverified') return { kind: null, intent: null, use_case: null, stage, skip: 'ownership_declined_unverified_hold' }
  if (TERMINAL_DISPOSITIONS.has(d)) return { kind: null, intent: null, use_case: null, stage, skip: 'terminal_disposition' }
  if (NOT_INTERESTED_DISPOSITIONS.has(d)) return { kind: K.NOT_INTERESTED_NURTURE, intent: 'not_interested', use_case: 'nurture_not_interested', stage, skip: null }
  if (CALLBACK_DISPOSITIONS.has(d)) return { kind: K.SELLER_CALLBACK, intent: 'seller_callback', use_case: 'nurture_seller_callback', stage, skip: null }
  if (d === 'declined_unverified' || d === 'ownership_declined_unverified') return { kind: null, intent: null, use_case: null, stage, skip: 'ownership_declined_unverified_hold' }
  if (!STAGE_SILENCE_DISPOSITIONS.has(d)) return { kind: null, intent: null, use_case: null, stage, skip: `disposition_not_followup_eligible:${d.replace(/[^a-z_]/g, '').slice(0, 40)}` }
  const use_case = STAGE_SILENCE_USE_CASE[stage] || null
  return { kind: K.STAGE_SILENCE, intent: 'stage_no_reply', use_case, stage, skip: use_case ? null : 'stage_use_case_unknown' }
}

// ── runtime input (identifiers only, letter-encoded: agent.payload_is_clean) ─────────────────────────
export function encodeDispatchInput({ intent_id }) {
  return { intent_ref: encodeRef(clean(intent_id)) }
}
export function decodeDispatchInput(input = {}) {
  const id = typeof input?.intent_ref === 'string' && input.intent_ref.length <= 160 ? decodeRef(input.intent_ref) : null
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null
  return { intent_id: id }
}
const refs = (ids, n = 25) => ids.slice(0, n).map((id) => encodeRef(String(id)))

// ── the passes ───────────────────────────────────────────────────────────────
/** followup.execution_sweep: one materialization pass (dry_run: a read-only count of what is due). */
export async function runFollowUpSweep(deps = {}) {
  const mode = await modeOf(deps.readSwitch)
  if (mode === 'off') return { code: C.OFF, mode }
  if (mode === 'dry_run') {
    const due = typeof deps.countDue === 'function' ? await deps.countDue() : null
    return { code: C.DRY_RUN, mode, counts: { due_for_materialization: due } }
  }
  const r = await runFollowUpMaterialization(deps)
  return { code: C.SWEPT, mode, counts: r.counts || {}, result_refs: refs((r.results || []).map((x) => x.intent_id)), result_codes: (r.results || []).slice(0, 25).map((x) => x.code) }
}

/** followup.dispatch: materialize ONE named intent now (bounded by its own lease / attempts). */
export async function runFollowUpDispatch(job, deps = {}) {
  const mode = await modeOf(deps.readSwitch)
  if (mode === 'off') return { code: C.OFF, mode }
  if (!job?.intent_id) return { code: C.INPUT_INVALID }
  if (mode === 'dry_run') return { code: C.DRY_RUN, mode }
  const r = await runFollowUpMaterialization({ ...deps, intentId: job.intent_id, limit: 1, leadMs: 365 * 86_400_000 })
  const one = (r.results || [])[0] || null
  // codes only on the runtime record (agent.payload_is_clean): letters, '_' and ':'; never ids / digits
  return { code: one?.code || 'NOTHING_CLAIMABLE', reason: one?.reason ? clean(one.reason).replace(/[^a-z_:|]/gi, '').slice(0, 80) || null : null }
}

/**
 * followup.reconcile. Report-only unless `apply` (job input) AND mode live. Apply = adopt each legacy
 * body-less pending follow-up row (never sendable) and each bare follow_up_at into an intent through the
 * ONE writer (scheduleFollowUp, which in live mode plans an intent), cancel the adopted legacy row, and
 * re-plan a failure that happened BEFORE the provider accepted (at most FOLLOWUP_RECONCILE_MAX_RETRIES).
 */
export async function runFollowUpReconcile(deps = {}, { apply = false } = {}) {
  const mode = await modeOf(deps.readSwitch)
  if (mode === 'off') return { code: C.OFF, mode }
  const now = deps.now ? toMs(deps.now()) : Date.now()
  const snapshot = await deps.loadReconcileSnapshot()
  const r = reconcileFollowUpLifecycle({ ...snapshot, now })
  const applied = { adopted_rows: 0, adopted_dates: 0, recorded_not_executable: 0, retried: 0, refused: 0 }
  if (apply === true && mode === 'live') {
    for (const id of r.legacy_deferred_rows.slice(0, 100)) {
      const row = snapshot.rows.find((x) => clean(x.id) === clean(id))
      const ok = row ? await deps.adoptLegacyRow(row) : false
      if (ok) applied.adopted_rows += 1; else applied.refused += 1
    }
    for (const thread_key of r.unbacked_follow_up_at.slice(0, 100)) {
      const t = snapshot.threads.find((x) => clean(x.thread_key) === clean(thread_key))
      const i = t ? followUpIntentOf(t) : { kind: null, skip: 'thread_missing' }
      if (!i.kind) {
        // fail closed AND visible: the bare date becomes a documented non-executable / held record
        const rec = t && typeof deps.recordUnadoptableDate === 'function' ? await deps.recordUnadoptableDate(t, i.skip) : false
        if (rec) applied.recorded_not_executable += 1; else applied.refused += 1
        continue
      }
      const ok = await deps.adoptBareDate(t, i)
      if (ok) applied.adopted_dates += 1; else applied.refused += 1
    }
    for (const intent of snapshot.intents.filter((x) => x.state === 'failed' && x.outcome === 'failed_before_accept' && (Number(x.row_spec?.reconcile_retries) || 0) < FOLLOWUP_RECONCILE_MAX_RETRIES).slice(0, 50)) {
      const ok = await deps.requeueFailed(intent)
      if (ok) applied.retried += 1
    }
  }
  return {
    code: C.RECONCILED, mode, applied: apply === true && mode === 'live', counts: { ...r.counts, ...applied },
    ready_without_row_refs: refs(r.ready_without_row), orphan_row_refs: refs(r.orphan_rows), legacy_deferred_row_refs: refs(r.legacy_deferred_rows),
    unbacked_thread_refs: refs(r.unbacked_follow_up_at), planned_overdue_refs: refs(r.planned_overdue), no_reason_refs: refs(r.no_reason),
  }
}

// ── composition ──────────────────────────────────────────────────────────────
async function rowsOf(q) {
  const r = await q
  if (r?.error) throw r.error
  return Array.isArray(r?.data) ? r.data : []
}

/**
 * Production composition: the lifecycle deps (the automation-hold PORT is the hold authority on this
 * branch: it folds the owner-handled exclusion in) + the reconciliation reads / adoption writers.
 */
export async function createFollowUpDeps({ supabase, readSwitch, now = null, automationHoldChecker = null, scheduleFollowUp = null } = {}) {
  const holdCheck = async ({ thread_key, property_id, master_owner_id }) => {
    const h = await checkAutomationHoldPort({ threadKey: thread_key, propertyId: property_id || null, masterOwnerId: master_owner_id || null, capability: 'followup_dispatch' }, { checker: automationHoldChecker })
    return h.held ? { held: true, hold_type: h.hold_type, reason: h.reason, fail_closed: h.hold_type === 'lookup_error', hold_ids: h.hold_id ? [h.hold_id] : [] } : { held: false }
  }
  const base = await withLifecycleHelpers(createFollowUpLifecycleDeps({ supabase, readSwitch, holdCheck, now }))
  const schedule = scheduleFollowUp || (async (...a) => (await import('../seller-flow/seller-followup-scheduler.js')).scheduleFollowUp(...a))
  return {
    ...base,
    readSwitch,
    async stagePolicy(intent) {
      if (intent.kind !== K.STAGE_SILENCE) return { ok: true }
      const stage = lower(intent.row_spec?.metadata?.stage)
      const { policy } = resolveFollowUpPolicyForStage(stage)
      if (!policy?.enabled) return { ok: false, reason: 'stage_followups_disabled' }
      return { ok: true }
    },
    async countDue() {
      const r = await rowsOf(supabase.from('followup_intents').select('id,state,due_at').in('state', ['planned', 'materializing']).limit(1000))
      return r.length
    },
    async loadReconcileSnapshot() {
      const intents = await rowsOf(supabase.from('followup_intents').select('*').in('state', [...EXECUTABLE_STATES, 'held', 'failed', 'provider_accepted']).limit(5000))
      const rows = await rowsOf(supabase.from('send_queue').select('id,queue_status,type,message_type,thread_key,to_phone_number,sent_at,message_body,scheduled_for,metadata,use_case_template,master_owner_id,property_id,created_at')
        .eq('type', 'followup').in('queue_status', ['queued', 'pending', 'approved', 'ready', 'scheduled', 'processing', 'sending', 'paused', 'paused_after_hours', 'held', 'approval']).limit(5000))
      const threads = await rowsOf(supabase.from('inbox_thread_state').select('thread_key,follow_up_at,disposition,stage,lifecycle_stage,is_suppressed,property_id,master_owner_id').gte('follow_up_at', '1970-01-01T00:00:00Z').limit(5000))
      return { intents, rows, threads }
    },
    async adoptLegacyRow(listed) {
      // the FULL legacy row (render context: name, address, sender, language, agent) becomes the row spec
      const row = (await rowsOf(supabase.from('send_queue').select('*').eq('id', listed.id).limit(1)))[0]
      if (!row) return false
      const intent = lower(row.metadata?.intent) || (lower(row.use_case_template).startsWith('nurture_') ? lower(row.use_case_template).slice(8) : '')
      if (!intent) return false
      const due = clean(row.scheduled_for) || new Date().toISOString()
      const { id: _id, queue_status: _qs, sent_at: _sent, created_at: _c, updated_at: _u, is_locked: _l, locked_at: _la, lock_token: _lt, retry_count: _rc, next_retry_at: _nr, paused_reason: _pr, guard_status: _gs, guard_reason: _gr, ...rest } = row
      const spec = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null && v !== ''))
      const { planFollowUpIntent, followUpKindFor } = await import('./followup-lifecycle.js')
      const r = await planFollowUpIntent({
        thread_key: row.thread_key || row.to_phone_number, property_id: row.property_id, master_owner_id: row.master_owner_id,
        kind: followUpKindFor(intent, row.metadata || {}), intent, use_case: row.use_case_template, due_at: due, writer: 'reconcile:legacy_deferred_row',
        cause: `legacy_row:${row.id}`, row_spec: { ...spec, queue_status: 'scheduled', type: 'followup', message_type: 'followup', metadata: { ...(row.metadata || {}), adopted_from_legacy_row: row.id } },
      }, { supabase })
      if (!r.ok) return false
      const u = await supabase.from('send_queue').update({ queue_status: 'cancelled', guard_status: 'blocked', guard_reason: 'superseded_by_followup_intent', updated_at: new Date().toISOString(),
        metadata: { ...(row.metadata || {}), skip_reason: 'superseded_by_followup_intent', superseded_by_followup_intent: r.intent?.id || null, final_queue_status: 'cancelled' } }).eq('id', row.id).in('queue_status', ['queued', 'pending', 'approved', 'ready', 'scheduled', 'paused', 'paused_invalid_queue_row', 'paused_after_hours'])
      return !u?.error
    },
    async adoptBareDate(thread, i) {
      const due = toMs(thread.follow_up_at)
      const r = await schedule(i.intent, thread.thread_key, {
        source: 'reconcile:bare_follow_up_at', writer: 'reconcile:bare_follow_up_at', property_id: thread.property_id || null, master_owner_id: thread.master_owner_id || null,
        scheduled_for_at: new Date(Math.max(due, Date.now())).toISOString(), followup_dedupe_scope: `bare_date:${new Date(due).toISOString()}`,
        ...(i.kind === K.STAGE_SILENCE ? { stage: i.stage, stage_no_reply_hours: 24, followup_use_case: i.use_case } : {}),
        skip_email_lane: true,
      }, supabase)
      return r?.ok === true && r.lifecycle === true
    },
    async recordUnadoptableDate(thread, skip) {
      const { recordNonExecutableFollowUp, planFollowUpIntent } = await import('./followup-lifecycle.js')
      const held = /declined_unverified/.test(clean(skip))
      const input = { thread_key: thread.thread_key, property_id: thread.property_id || null, master_owner_id: thread.master_owner_id || null, kind: 'bare_date', intent: 'unknown',
        due_at: thread.follow_up_at, writer: 'reconcile:bare_follow_up_at', cause: `bare_date:${thread.follow_up_at}`, reason: `not_followup_eligible:${clean(skip) || 'unknown'}` }
      const r = held ? await planFollowUpIntent({ ...input, state: 'held' }, { supabase }) : await recordNonExecutableFollowUp(input, { supabase })
      return r?.ok === true
    },
    async requeueFailed(intent) {
      const { data, error } = await supabase.rpc('followup_intent_requeue_failed', { p_id: intent.id, p_reason: 'reconcile_retry_failed_before_accept', p_actor: 'reconcile' })
      return !error && data?.ok === true
    },
  }
}
