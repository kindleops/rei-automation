/**
 * Deal Desk control contract — the per-field definition of what an operator control
 * writes, how it reads the answer back, and what a failure says out loud.
 *
 * There is exactly one entry per canonical field. Everything a control needs is derived
 * from that entry, so a second control cannot invent a different vocabulary, a different
 * request body or a different success condition for the same field. That is the mechanism
 * behind "one logical mutation owner per field" — the owner is this table.
 *
 * Dimension separation is structural: `lifecycle_stage`, `operational_status`,
 * `lead_temperature` and `automation_state` each carry their own strict resolver from
 * `canonical-control-vocabularies.ts`, and none of them can accept another's values.
 *
 * Pure and dependency-free apart from the vocabularies — testable under `node --test`.
 */

import {
  buildAutomationModePatch,
  deserializeAutomationState,
  readAutomationModeFromThread,
  readManualStageLock,
  resolveOperatorAutomationModeForControl,
  type AutomationModeCode,
} from '../lead-state/automation-persistence-contract'
import {
  resolveLeadTemperatureForWrite,
  resolveLifecycleStageForWrite,
  resolveOperationalStatusForWrite,
  type VocabularyResolution,
} from '../lead-state/canonical-control-vocabularies'
import type {
  LeadTemperatureCode,
  LifecycleStageCode,
  OperationalStatusCode,
} from '../lead-state/universal-lead-state-registry'

// ── field identity ───────────────────────────────────────────────────────────

export const DEAL_DESK_CONTROL_FIELDS = [
  'lifecycle_stage',
  'operational_status',
  'lead_temperature',
  'automation_state',
  'is_read',
] as const

export type DealDeskControlField = (typeof DEAL_DESK_CONTROL_FIELDS)[number]

/** The read/unread control's canonical vocabulary — a string pair, not a raw boolean. */
export const READ_STATE_VALUES = ['read', 'unread'] as const
export type ReadStateCode = (typeof READ_STATE_VALUES)[number]

const asKey = (value: unknown): string => String(value ?? '').trim().toLowerCase()

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

// ── read-state resolver ──────────────────────────────────────────────────────

export const resolveReadStateForWrite = (value: unknown): VocabularyResolution<ReadStateCode> => {
  const key = asKey(value)
  if (!key) return { ok: false, reason: 'empty', input: key, dimension: 'read_state' }
  if (key === 'read' || key === 'unread') return { ok: true, value: key, viaAlias: false }
  // Booleans are accepted from internal callers only after an explicit conversion; a raw
  // `true` reaching here means a caller skipped the vocabulary, so it is refused.
  return { ok: false, reason: 'unknown', input: key, dimension: 'read_state' }
}

// ── current-value resolution ─────────────────────────────────────────────────

/**
 * What a control currently holds.
 *
 * `unsupported` is the DD-002 escape hatch: a row whose stored value has no canonical
 * equivalent keeps its raw value and is flagged, instead of being silently rendered as
 * `ownership_confirmation`. A flagged control shows the raw value and refuses to pretend
 * the lead is somewhere it never reached.
 */
export interface ResolvedControlValue<T extends string> {
  /** Canonical value, or null when the stored value has no canonical equivalent. */
  canonical: T | null
  /** The stored value, trimmed. Rendered verbatim when `unsupported`. */
  raw: string
  unsupported: boolean
}

const resolveCurrent = <T extends string>(
  raw: unknown,
  resolve: (value: unknown) => VocabularyResolution<T>,
  fallback: T | null,
): ResolvedControlValue<T> => {
  const value = String(raw ?? '').trim()
  if (!value) return { canonical: fallback, raw: '', unsupported: false }
  const resolution = resolve(value)
  if (resolution.ok) return { canonical: resolution.value, raw: value, unsupported: false }
  return { canonical: null, raw: value, unsupported: true }
}

/**
 * First non-empty value among a set of keys. Order is authority order, not preference:
 * the canonical column always comes first, and a legacy source is consulted only when the
 * canonical one is absent from the row.
 */
const firstPresent = (record: Record<string, unknown>, keys: readonly string[]): unknown => {
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return value
  }
  return undefined
}

/**
 * Read the four state dimensions off a thread-shaped record.
 *
 * ── Why there are fallback keys, and why they are still safe ─────────────────────────
 *
 * `INBOX_LIST_COLUMNS` (`lib/data/inboxData.ts`) selects `automation_state` and `is_read`
 * but NOT `lifecycle_stage`, `operational_status` or `lead_temperature`; those reach a
 * thread only through a realtime `inbox_thread_state` patch or a dossier fetch. Reading
 * the canonical column alone would therefore blank both controls on a freshly loaded list.
 *
 * The fallbacks are safe because every one of them goes through the STRICT resolver:
 *   - a legacy value with a declared mapping (`ownership_check`) resolves deliberately;
 *   - a value from another dimension (`mf_suppressed`, `suppressed`, `closed`) is REJECTED
 *     and surfaces as `unsupported`, displayed verbatim, and refused by the write path.
 * That is the DD-002 guarantee: `mf_suppressed` can be *shown*, never silently converted
 * into `ownership_confirmation` and never written as a stage.
 *
 * Deliberately NOT consulted:
 *   - `status` — on `InboxThread` that is `'read' | 'unread' | 'archived'`, a read-state
 *     value, not an operational status.
 *   - `inbox_category` / `inbox_bucket` — routing/triage, a third dimension.
 *   - `isHotLead` — a derived signal, not stored temperature.
 */
const STAGE_SOURCE_KEYS = [
  'lifecycle_stage', 'lifecycleStage',
  'universal_stage', 'universalStage',
  'seller_stage', 'sellerStage',
  'conversationStage', 'stage',
] as const

const STATUS_SOURCE_KEYS = [
  'operational_status', 'operationalStatus',
  'conversation_status', 'conversationStatus',
  'inboxStatus',
] as const

const TEMPERATURE_SOURCE_KEYS = [
  'lead_temperature', 'leadTemperature', 'temperature',
] as const

/**
 * `automation_state` and its view alias only.
 *
 * `automationState` (camelCase) is deliberately absent: `toWorkflowThread` used to
 * synthesise it from `isArchived`/`isSuppressed`, so it is a display artefact rather than
 * a stored value. `automation_status` is absent for the same reason it is absent
 * everywhere in this lane — it is the queue dimension.
 */
const AUTOMATION_SOURCE_KEYS = ['automation_state', 'autopilot_mode'] as const

export const readStageValue = (thread: unknown): ResolvedControlValue<LifecycleStageCode> => {
  const record = asRecord(thread)
  return resolveCurrent(firstPresent(record, STAGE_SOURCE_KEYS), resolveLifecycleStageForWrite, null)
}

export const readStatusValue = (thread: unknown): ResolvedControlValue<OperationalStatusCode> => {
  const record = asRecord(thread)
  return resolveCurrent(firstPresent(record, STATUS_SOURCE_KEYS), resolveOperationalStatusForWrite, null)
}

export const readTemperatureValue = (thread: unknown): ResolvedControlValue<LeadTemperatureCode> => {
  const record = asRecord(thread)
  return resolveCurrent(firstPresent(record, TEMPERATURE_SOURCE_KEYS), resolveLeadTemperatureForWrite, 'unscored')
}

export const readAutomationValue = (thread: unknown): ResolvedControlValue<AutomationModeCode> => {
  const record = asRecord(thread)
  const source = firstPresent(record, AUTOMATION_SOURCE_KEYS)
  const raw = String(source ?? '').trim()
  const mode = readAutomationModeFromThread(source === undefined ? {} : { automation_state: source })
  if (mode === null) return { canonical: null, raw, unsupported: true }
  return { canonical: mode, raw, unsupported: false }
}

export const readReadStateValue = (thread: unknown): ResolvedControlValue<ReadStateCode> => {
  const record = asRecord(thread)
  const raw = record.is_read ?? record.isRead
  if (raw === undefined || raw === null || raw === '') {
    // `isUnread`/`unread` is the inverse shape some list rows carry.
    const inverse = record.unread ?? record.isUnread
    if (inverse !== undefined && inverse !== null && inverse !== '') {
      const unread = inverse === true || asKey(inverse) === 'true'
      return { canonical: unread ? 'unread' : 'read', raw: unread ? 'unread' : 'read', unsupported: false }
    }
    return { canonical: 'unread', raw: '', unsupported: false }
  }
  const isRead = raw === true || asKey(raw) === 'true'
  return { canonical: isRead ? 'read' : 'unread', raw: isRead ? 'read' : 'unread', unsupported: false }
}

export { readManualStageLock }

// ── request payloads ─────────────────────────────────────────────────────────

export interface ControlWritePayload {
  patch: Record<string, unknown>
  meta: Record<string, unknown>
}

/**
 * The exact request body for one field's write. One field per call — a status change
 * carries `operational_status` and nothing else, so it can never move the stage, the
 * bucket or the suppression state as a side effect.
 *
 * The one documented exception is `automation_state: 'manual'`, which also sets
 * `manual_stage_lock`. That coupling is stated in `buildAutomationModePatch` and is the
 * pre-existing backend contract for manual control, not a new invention.
 */
export const buildControlWritePayload = (
  field: DealDeskControlField,
  value: string,
): ControlWritePayload | null => {
  switch (field) {
    case 'lifecycle_stage': {
      const resolved = resolveLifecycleStageForWrite(value)
      if (!resolved.ok) return null
      // `manual_stage_lock` is set by the server for a manual stage write; sending it
      // explicitly here would duplicate the server contract rather than restate it.
      return { patch: { lifecycle_stage: resolved.value }, meta: {} }
    }
    case 'operational_status': {
      const resolved = resolveOperationalStatusForWrite(value)
      if (!resolved.ok) return null
      return { patch: { operational_status: resolved.value }, meta: {} }
    }
    case 'lead_temperature': {
      const resolved = resolveLeadTemperatureForWrite(value)
      if (!resolved.ok) return null
      return { patch: { lead_temperature: resolved.value }, meta: {} }
    }
    case 'automation_state': {
      const resolved = resolveOperatorAutomationModeForControl(value)
      if (!resolved.ok) return null
      return buildAutomationModePatch(resolved.value)
    }
    case 'is_read': {
      const resolved = resolveReadStateForWrite(value)
      if (!resolved.ok) return null
      return { patch: { is_read: resolved.value === 'read' }, meta: {} }
    }
    default:
      return null
  }
}

// ── authoritative read-back ──────────────────────────────────────────────────

/**
 * Read one field back out of the server's authoritative row.
 *
 * Returns null when the row does not confirm the field — the caller surfaces that as
 * "saved, but not confirmed" rather than adopting the optimistic value. A row that omits
 * the field, or returns something the strict resolver refuses, is not a confirmation.
 */
export const readBackControlValue = (
  field: DealDeskControlField,
  row: Record<string, unknown> | null | undefined,
): string | null => {
  if (!row || typeof row !== 'object') return null
  switch (field) {
    case 'lifecycle_stage': {
      const resolved = resolveLifecycleStageForWrite(row.lifecycle_stage)
      return resolved.ok ? resolved.value : null
    }
    case 'operational_status': {
      const resolved = resolveOperationalStatusForWrite(row.operational_status)
      return resolved.ok ? resolved.value : null
    }
    case 'lead_temperature': {
      const resolved = resolveLeadTemperatureForWrite(row.lead_temperature)
      return resolved.ok ? resolved.value : null
    }
    case 'automation_state': {
      // A row that omits the column entirely is not a confirmation: the deserializer maps
      // "absent" to `active`, which would report a successful resume the write never made.
      if (!('automation_state' in row)) return null
      return deserializeAutomationState(row.automation_state)
    }
    case 'is_read': {
      if (!('is_read' in row)) return null
      const value = row.is_read
      if (value === null || value === undefined) return null
      return value === true || asKey(value) === 'true' ? 'read' : 'unread'
    }
    default:
      return null
  }
}

// ── operator-facing failure text ─────────────────────────────────────────────

/**
 * Server reason code → operator-facing message.
 *
 * The raw `BackendClientError.message` must never be rendered: it embeds the request URL
 * and a body preview, and the thread key in that URL is the seller's phone number. Only
 * the canonical reason code crosses this boundary, and only as a lookup key.
 */
const SERVER_REASON_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  automation_resume_blocked_suppressed:
    'This conversation is suppressed. Automation cannot be resumed until suppression is lifted.',
  automation_resume_blocked_terminal_stage:
    'This lead is closed. Move it out of the closed stage before resuming automation.',
  automation_resume_blocked_terminal_disposition:
    'This lead has a terminal disposition. Automation cannot be resumed for it.',
  manual_stage_lock_blocked_stage_write:
    'A manual stage lock is active on this lead, so the stage was not changed.',
  invalid_canonical_thread_key:
    'This conversation has no writable canonical phone route, so its state cannot be saved.',
  no_allowed_patch_fields:
    'The server did not accept this value, so nothing was saved.',
})

const DEFAULT_FAILURE_MESSAGE = 'The change could not be saved.'

/**
 * Localised, identifier-free explanation for a server refusal.
 *
 * The lookup is an own-property check, not `MAP[key]`. A bare index reaches the prototype
 * chain — `Object.freeze` does not detach `Object.prototype` — so `describeServerRefusal
 * ('constructor')` returned the `Object` **function** typed as a string, and that value
 * would have been rendered into the operator-facing error surface. Verified before fixing.
 * Same defect class as the alias lookup in `canonical-control-vocabularies.ts`.
 */
export const describeServerRefusal = (reasonCode: string | null | undefined): string => {
  const key = asKey(reasonCode)
  if (!key) return DEFAULT_FAILURE_MESSAGE
  if (!Object.prototype.hasOwnProperty.call(SERVER_REASON_MESSAGES, key)) return DEFAULT_FAILURE_MESSAGE
  const message = SERVER_REASON_MESSAGES[key]
  return typeof message === 'string' ? message : DEFAULT_FAILURE_MESSAGE
}

/** Is this reason code one we can explain precisely? Used to decide telemetry severity. */
export const isKnownServerRefusal = (reasonCode: string | null | undefined): boolean =>
  Object.prototype.hasOwnProperty.call(SERVER_REASON_MESSAGES, asKey(reasonCode))
