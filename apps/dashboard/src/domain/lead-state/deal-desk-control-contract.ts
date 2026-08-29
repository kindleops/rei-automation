import {
  resolveAutomationModeForWrite,
  resolveLeadTemperatureForWrite,
  resolveLifecycleStageForWrite,
  resolveOperationalStatusForWrite,
  type AutomationModeCode,
  type VocabularyResolution,
} from './canonical-control-vocabularies'
import type {
  LeadTemperatureCode,
  LifecycleStageCode,
  OperationalStatusCode,
} from './universal-lead-state-registry'

export type OperatorAutomationMode = Extract<AutomationModeCode, 'active' | 'paused' | 'human_controlled'>
export type PersistedAutomationState = 'running' | 'paused' | 'manual'

export const PERSISTED_AUTOMATION_STATE_BY_MODE: Readonly<Record<OperatorAutomationMode, PersistedAutomationState>> = Object.freeze({
  active: 'running',
  paused: 'paused',
  human_controlled: 'manual',
})

export interface ThreadControlRow extends Record<string, unknown> {
  lifecycle_stage?: unknown
  operational_status?: unknown
  lead_temperature?: unknown
  automation_state?: unknown
  autopilot_mode?: unknown
  automation_status?: unknown
  queue_status?: unknown
  manual_stage_lock?: unknown
  is_read?: unknown
  is_archived?: unknown
  is_suppressed?: unknown
  contactability_status?: unknown
}

const text = (value: unknown): string => String(value ?? '').trim()
const lower = (value: unknown): string => text(value).toLowerCase()
const bool = (value: unknown): boolean => value === true || ['1', 'true', 'yes', 'on'].includes(lower(value))

export function serializeOperatorAutomationMode(mode: OperatorAutomationMode): PersistedAutomationState {
  return PERSISTED_AUTOMATION_STATE_BY_MODE[mode]
}

/**
 * Read automation mode from the canonical persisted field or the canonical view alias.
 * `automation_status` / `queue_status` are intentionally never consulted: those are the
 * execution/queue dimension and cannot be used to reconstruct operator mode.
 */
export function resolveAutomationModeFromRow(
  row: ThreadControlRow,
): VocabularyResolution<AutomationModeCode> {
  const persisted = text(row.automation_state)
  if (persisted) return resolveAutomationModeForWrite(persisted)
  return resolveAutomationModeForWrite(row.autopilot_mode)
}

export function resolveStageFromRow(row: ThreadControlRow): VocabularyResolution<LifecycleStageCode> {
  return resolveLifecycleStageForWrite(row.lifecycle_stage)
}

export function resolveStatusFromRow(row: ThreadControlRow): VocabularyResolution<OperationalStatusCode> {
  return resolveOperationalStatusForWrite(row.operational_status)
}

export function resolveTemperatureFromRow(row: ThreadControlRow): VocabularyResolution<LeadTemperatureCode> {
  return resolveLeadTemperatureForWrite(row.lead_temperature)
}

export function readBooleanFromRow(row: ThreadControlRow, field: 'is_read' | 'manual_stage_lock'): boolean {
  return bool(row[field])
}

export interface AutomationResumeBlock {
  blocked: boolean
  reason: string | null
}

const TERMINAL_EXECUTION_STATUSES = new Set(['suppressed', 'off', 'disabled', 'completed', 'terminal'])
const BLOCKING_CONTACTABILITY = new Set([
  'opted_out', 'dnc', 'provider_blacklisted', 'invalid_number', 'do_not_text', 'suppressed',
])

/** Shared client preflight; the server repeats this guard authoritatively. */
export function getAutomationResumeBlock(row: ThreadControlRow): AutomationResumeBlock {
  if (bool(row.is_suppressed)) return { blocked: true, reason: 'Automation cannot resume while this conversation is suppressed.' }
  if (bool(row.is_archived)) return { blocked: true, reason: 'Automation cannot resume on an archived conversation.' }
  if (lower(row.lifecycle_stage) === 'closed') return { blocked: true, reason: 'Automation cannot resume after the lifecycle is closed.' }
  if (BLOCKING_CONTACTABILITY.has(lower(row.contactability_status))) {
    return { blocked: true, reason: 'Automation cannot resume while contactability is blocked.' }
  }
  const execution = lower(row.automation_status || row.queue_status)
  if (TERMINAL_EXECUTION_STATUSES.has(execution)) {
    return { blocked: true, reason: `Automation cannot resume while execution status is ${execution}.` }
  }
  return { blocked: false, reason: null }
}

export function buildOperatorAutomationPatch(
  mode: OperatorAutomationMode,
  row: ThreadControlRow,
): { ok: true; patch: { automation_state: PersistedAutomationState } } | { ok: false; reason: string } {
  if (mode === 'active') {
    const block = getAutomationResumeBlock(row)
    if (block.blocked) return { ok: false, reason: block.reason || 'Automation cannot resume for this conversation.' }
  }
  return { ok: true, patch: { automation_state: serializeOperatorAutomationMode(mode) } }
}
