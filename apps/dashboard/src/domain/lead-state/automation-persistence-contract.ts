/**
 * Automation persistence contract — the one boundary between the canonical operator
 * automation vocabulary and the values `inbox_thread_state` actually stores.
 *
 * ── Schema facts this module encodes (read-only production inspection, N.2) ──────────
 *
 *   `public.inbox_thread_state` holds BOTH of these, and they are different dimensions:
 *     • `automation_state`  — operator automation mode.  Projected by
 *       `public.canonical_inbox_threads` as `autopilot_mode`.
 *     • `automation_status` — queue / execution status.  Projected as `queue_status`.
 *
 *   `autopilot_mode` is therefore a VIEW ALIAS, not a column. Writing `autopilot_mode`
 *   is what `ThreadStateBar` used to do; `patch-universal-lead-state.js`'s `buildRowPatch`
 *   never had a branch for it, so those writes were accepted and silently dropped.
 *
 *   A legacy hydrated view additionally computes
 *     `COALESCE(ts.automation_status, ts.automation_state, 'active') AS automation_status`
 *   which collapses the two dimensions into one. That is a backward-compatibility
 *   projection for old readers. It is NOT a mutation contract, and nothing in this module
 *   or in any write path may fall back from `automation_state` to `automation_status`.
 *
 * ── Persisted values, and where each one was located ─────────────────────────────────
 *
 *   Every value below is taken from existing repository code or observed production data.
 *   No value here was invented.
 *
 *     'running'  — written by `syncClassifiedInboxThreadState`
 *                  (`apps/api/src/lib/supabase/sms-engine.js:3686`) on every classified
 *                  inbound sync, and assumed as the default by
 *                  `shouldSuppressSellerAutoReply`
 *                  (`resolve-seller-auto-reply-plan.js:318`). It is the only non-null,
 *                  non-empty `automation_state` value observed in production.
 *     'paused'   — suppression branch of `shouldSuppressSellerAutoReply`
 *                  (`resolve-seller-auto-reply-plan.js:322`) → `{ suppress, "manual_pause" }`.
 *     'manual'   — same branch, same line. Distinct from 'paused' so "an operator is
 *                  driving this thread by hand" stays distinguishable from
 *                  "automation is temporarily halted".
 *
 *   `review_required`, `disabled` and `completed` are canonical *modes* but have NO
 *   located `automation_state` value. They are therefore not serializable, which is the
 *   mechanical reason an operator control cannot write them — on top of the
 *   `operatorSelectable` guard in `canonical-control-vocabularies.ts`.
 *
 * ── Empty / null `automation_state` ─────────────────────────────────────────────────
 *
 *   Observed in production alongside 'running'. It is read as `active` because that is
 *   what the backend itself does — `automation_state || "running"` at
 *   `resolve-seller-auto-reply-plan.js:318` — so a null row's *effective* behaviour is
 *   "automation may send". Displaying it as anything else would tell the operator the
 *   thread is halted when it is not.
 *
 * Pure and dependency-free apart from the canonical vocabularies — testable under
 * `node --test`.
 */

import {
  AUTOMATION_MODE_META,
  resolveAutomationModeForWrite,
  resolveOperatorAutomationMode,
  type AutomationModeCode,
  type VocabularyResolution,
} from './canonical-control-vocabularies'

export type { AutomationModeCode }

// ── persisted vocabulary ─────────────────────────────────────────────────────

/** The `automation_state` values this repository is known to read or write. */
export const PERSISTED_AUTOMATION_STATES = ['running', 'paused', 'manual'] as const
export type PersistedAutomationState = (typeof PERSISTED_AUTOMATION_STATES)[number]

const PERSISTED_SET = new Set<string>(PERSISTED_AUTOMATION_STATES)

/**
 * Canonical operator mode → persisted `automation_state`.
 *
 * Only the three operator-selectable modes appear. A mode absent from this table has no
 * located database value and must not be written — see the module header.
 */
export const OPERATOR_MODE_TO_PERSISTED: Readonly<Partial<Record<AutomationModeCode, PersistedAutomationState>>> =
  Object.freeze({
    active: 'running',
    paused: 'paused',
    human_controlled: 'manual',
  })

/** Persisted `automation_state` → canonical mode. The exact inverse of the table above. */
export const PERSISTED_TO_MODE: Readonly<Record<PersistedAutomationState, AutomationModeCode>> = Object.freeze({
  running: 'active',
  paused: 'paused',
  manual: 'human_controlled',
})

/** The canonical write target for operator automation mode. Never `automation_status`. */
export const AUTOMATION_MODE_FIELD = 'automation_state' as const

/** The read-only queue/execution field. Never an operator automation-mode write target. */
export const AUTOMATION_QUEUE_STATUS_FIELD = 'automation_status' as const

/** The manual-control lock field. A separate concept from automation mode. */
export const MANUAL_STAGE_LOCK_FIELD = 'manual_stage_lock' as const

const asKey = (value: unknown): string => String(value ?? '').trim().toLowerCase()

// ── serialization (frontend → database) ──────────────────────────────────────

export type AutomationSerializationRejection =
  /** Not a recognised automation mode at all. */
  | 'unknown_mode'
  /** A real canonical mode, but system-owned — an operator may not select it. */
  | 'system_only_mode'
  /** A real canonical mode with no located `automation_state` value. */
  | 'no_persisted_value'

export type AutomationSerialization =
  | { ok: true; mode: AutomationModeCode; persistedValue: PersistedAutomationState }
  | { ok: false; reason: AutomationSerializationRejection; input: string; message: string }

/**
 * Serialize an operator's automation choice for persistence.
 *
 * This is the only function permitted to produce an `automation_state` value from an
 * operator action. It refuses display labels ("Autopilot On"), system-only modes, and
 * anything without a located database value.
 */
export const serializeOperatorAutomationMode = (value: unknown): AutomationSerialization => {
  const input = asKey(value)
  const resolved = resolveOperatorAutomationMode(value)
  if (!resolved.ok) {
    // Distinguish "system-only" from "not a mode" so the caller can explain the refusal.
    const asSystemMode = resolveAutomationModeForWrite(value)
    if (asSystemMode.ok && !AUTOMATION_MODE_META[asSystemMode.value].operatorSelectable) {
      return {
        ok: false,
        reason: 'system_only_mode',
        input,
        message: `"${AUTOMATION_MODE_META[asSystemMode.value].label}" is set by the system and cannot be chosen here.`,
      }
    }
    return {
      ok: false,
      reason: 'unknown_mode',
      input,
      message: `"${input}" is not a recognised automation mode.`,
    }
  }

  const persistedValue = OPERATOR_MODE_TO_PERSISTED[resolved.value]
  if (!persistedValue) {
    return {
      ok: false,
      reason: 'no_persisted_value',
      input,
      message: `"${AUTOMATION_MODE_META[resolved.value].label}" has no stored automation value and cannot be saved.`,
    }
  }
  return { ok: true, mode: resolved.value, persistedValue }
}

/**
 * Vocabulary-resolver shape for `useCanonicalControlMutations`.
 *
 * The hook resolves the *canonical* value; `persist` performs the serialization. Keeping
 * the two apart means the control's rendered value is always canonical and only the
 * request body ever carries a legacy string.
 */
export const resolveOperatorAutomationModeForControl = (
  value: unknown,
): VocabularyResolution<AutomationModeCode> => {
  const serialization = serializeOperatorAutomationMode(value)
  if (serialization.ok) return { ok: true, value: serialization.mode, viaAlias: false }
  return {
    ok: false,
    reason: serialization.reason === 'unknown_mode' ? 'unknown' : 'wrong_dimension',
    input: serialization.input,
    dimension: 'automation_mode',
  }
}

// ── deserialization (database → frontend) ────────────────────────────────────

/**
 * Read the operator automation mode out of a persisted row.
 *
 * Reads `automation_state` and **only** `automation_state`. It never consults
 * `automation_status`: that is the queue dimension, and the hydrated view's COALESCE of
 * the two is the legacy projection this contract exists to stop honouring.
 *
 * Returns `null` for a value that is neither empty nor recognisable, so a caller can
 * display "unsupported legacy value" rather than a mode the row does not hold.
 */
export const deserializeAutomationState = (value: unknown): AutomationModeCode | null => {
  const key = asKey(value)
  // Backend default: `automation_state || "running"` — an unset row behaves as active.
  if (!key) return 'active'
  if (PERSISTED_SET.has(key)) return PERSISTED_TO_MODE[key as PersistedAutomationState]
  const resolved = resolveAutomationModeForWrite(key)
  return resolved.ok ? resolved.value : null
}

/** Did this row hold an `automation_state` value we could not interpret? */
export const isUnsupportedAutomationState = (value: unknown): boolean =>
  deserializeAutomationState(value) === null

/**
 * Read the automation mode off a thread-shaped record.
 *
 * The field is read under both snake_case and camelCase because Deal Desk threads arrive
 * in both shapes. `automation_status` / `queueStatus` are deliberately NOT consulted.
 */
export const readAutomationModeFromThread = (thread: unknown): AutomationModeCode | null => {
  if (!thread || typeof thread !== 'object') return 'active'
  const record = thread as Record<string, unknown>
  for (const key of ['automation_state', 'automationState', 'autopilot_mode', 'autopilotMode']) {
    if (record[key] !== undefined && record[key] !== null && asKey(record[key]) !== '') {
      return deserializeAutomationState(record[key])
    }
  }
  return 'active'
}

/**
 * Read the queue/execution status off a thread-shaped record — display only.
 * Returned verbatim (trimmed) because it is a backend-owned string with no canonical
 * frontend vocabulary; rendering it as-is is honest, mapping it would not be.
 */
export const readQueueStatusFromThread = (thread: unknown): string | null => {
  if (!thread || typeof thread !== 'object') return null
  const record = thread as Record<string, unknown>
  for (const key of ['automation_status', 'automationStatus', 'queue_status', 'queueStatus']) {
    const raw = String(record[key] ?? '').trim()
    if (raw) return raw
  }
  return null
}

// ── resume eligibility ───────────────────────────────────────────────────────

export type ResumeBlockReason = 'suppressed' | 'terminal_stage' | 'terminal_disposition'

export interface ResumeEligibility {
  allowed: boolean
  reason?: ResumeBlockReason
  message?: string
}

/**
 * Contactability values that block sending.
 * Mirrors `CONTACTABILITY_META[*].blocksSend` in `universal-lead-state-registry.ts` and
 * `BLOCKING_CONTACTABILITY` in the API registry.
 */
const BLOCKING_CONTACTABILITY = new Set([
  'opted_out', 'dnc', 'provider_blacklisted', 'invalid_number', 'do_not_text',
])

/** Dispositions after which there is no conversation left for automation to continue. */
const TERMINAL_DISPOSITIONS = new Set([
  'not_interested', 'wrong_person', 'wrong_number', 'sold', 'duplicate', 'unqualified',
])

const truthy = (value: unknown): boolean =>
  value === true || asKey(value) === 'true' || asKey(value) === 'yes' || asKey(value) === '1'

/**
 * May automation be turned back on for this record?
 *
 * A suppressed or terminal thread must reject a resume rather than accept it and report
 * success — the write would be persisted but the automation engine would refuse to send,
 * leaving the operator with a green control over a dead thread.
 *
 * Checked locally so the refusal is immediate and no doomed request is emitted; the
 * server enforces the same rule independently (`patch-universal-lead-state.js`).
 */
export const evaluateAutomationResume = (thread: unknown): ResumeEligibility => {
  if (!thread || typeof thread !== 'object') return { allowed: true }
  const record = thread as Record<string, unknown>

  const contactability = asKey(record.contactability_status ?? record.contactabilityStatus)
  const suppressed =
    truthy(record.is_suppressed) || truthy(record.isSuppressed) ||
    truthy(record.opt_out) || truthy(record.isOptOut) || truthy(record.optOut) ||
    (contactability !== '' && BLOCKING_CONTACTABILITY.has(contactability))
  if (suppressed) {
    return {
      allowed: false,
      reason: 'suppressed',
      message: 'This conversation is suppressed. Automation cannot be resumed until suppression is lifted.',
    }
  }

  const stage = asKey(record.lifecycle_stage ?? record.lifecycleStage)
  if (stage === 'closed') {
    return {
      allowed: false,
      reason: 'terminal_stage',
      message: 'This lead is closed. Move it out of the closed stage before resuming automation.',
    }
  }

  const disposition = asKey(record.disposition)
  if (disposition && TERMINAL_DISPOSITIONS.has(disposition)) {
    return {
      allowed: false,
      reason: 'terminal_disposition',
      message: 'This lead has a terminal disposition. Automation cannot be resumed for it.',
    }
  }

  return { allowed: true }
}

/**
 * Does a mode change count as a resume?
 *
 * Only a transition INTO `active` is a resume. Pausing a suppressed thread, or putting it
 * under manual control, stays allowed — those reduce automation, never restart it.
 */
export const isResumeTransition = (next: AutomationModeCode): boolean => next === 'active'

// ── manual control ───────────────────────────────────────────────────────────

/**
 * The row patch for an automation-mode write.
 *
 * `human_controlled` additionally sets `manual_stage_lock`, because "a human is driving
 * this thread" and "automated writers may not move this thread's stage" are the same
 * operator intent expressed against two columns. The lock is the pre-existing contract:
 * `patch-universal-lead-state.js` refuses an automated `lifecycle_stage` write when
 * `previous.manual_stage_lock === true`.
 *
 * The lock is only *set*, never cleared, by a mode change. Clearing it is the explicit
 * "resume automatic scoring" action, so switching from manual to paused does not quietly
 * hand stage control back to the automation engine.
 */
export const buildAutomationModePatch = (
  mode: AutomationModeCode,
): { patch: Record<string, unknown>; meta: Record<string, unknown> } | null => {
  const persistedValue = OPERATOR_MODE_TO_PERSISTED[mode]
  if (!persistedValue) return null
  const patch: Record<string, unknown> = { [AUTOMATION_MODE_FIELD]: persistedValue }
  const meta: Record<string, unknown> = {}
  if (mode === 'human_controlled') {
    patch[MANUAL_STAGE_LOCK_FIELD] = true
    meta.manual_stage_lock = true
  }
  return { patch, meta }
}

/** Read `manual_stage_lock` off a thread-shaped record. */
export const readManualStageLock = (thread: unknown): boolean => {
  if (!thread || typeof thread !== 'object') return false
  const record = thread as Record<string, unknown>
  return truthy(record.manual_stage_lock) || truthy(record.manualStageLock)
}
