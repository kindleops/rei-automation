import * as backendClient from '../../lib/api/backendClient'
import type { AnyRecord } from '../../lib/data/shared'
import {
  ARCHIVE_SCOPE_CODES,
  normalizePatchToCanonical,
  STATE_SOURCE_CODES,
  type OperationalStatusCode,
} from './universal-lead-state-registry'

const DEFAULT_SNOOZE_MS = 24 * 60 * 60 * 1000

export type UniversalLeadStatePatch = Record<string, unknown>

export type LeadStateSourceView =
  | 'inbox'
  | 'pipeline'
  | 'queue'
  | 'calendar'
  | 'map'
  | 'thread'
  | string

export interface UniversalLeadStateMeta {
  source_view?: LeadStateSourceView
  reason?: string
  change_source?: string
  execute_next_action?: boolean
  operator_id?: string
  updated_by?: string
  manual_stage_lock?: boolean
  manual_temperature_lock?: boolean
  resume_automatic_scoring?: boolean
  metadata?: Record<string, unknown>
}

export interface UniversalLeadStateMutationResult {
  ok: boolean
  threadKey: string
  errorMessage: string | null
  mutationPayload: AnyRecord | null
  writeTarget: 'inbox_thread_state' | 'none'
  data?: unknown
}

function buildMutationPayload(threadKey: string, patch: UniversalLeadStatePatch): AnyRecord {
  return { thread_key: threadKey, ...patch }
}

function toMutationResult(
  threadKey: string,
  patch: UniversalLeadStatePatch,
  result: Awaited<ReturnType<typeof backendClient.patchUniversalLeadState>>,
): UniversalLeadStateMutationResult {
  const mutationPayload = buildMutationPayload(threadKey, patch)
  if (result.ok) {
    return {
      ok: true,
      threadKey,
      errorMessage: null,
      mutationPayload,
      writeTarget: 'inbox_thread_state',
      data: result.data,
    }
  }
  return {
    ok: false,
    threadKey,
    errorMessage: result.message,
    mutationPayload,
    writeTarget: 'none',
  }
}


/**
 * Reduce any thread identifier to the canonical +1XXXXXXXXXX the lead-state API
 * requires. Accepts the canonical form unchanged, extracts the `phone:` segment
 * from a composite selection key, and normalises a bare 10/11-digit number.
 * Anything else is returned trimmed so the caller still gets the API's explicit
 * invalid_canonical_thread_key rather than a silent no-op.
 */
export function canonicalizeLeadStateThreadKey(raw: unknown): string {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  if (/^\+1\d{10}$/.test(value)) return value

  const embedded = value.match(/phone:(\+?1?\d{10})/i)
  if (embedded?.[1]) {
    const digits = embedded[1].replace(/\D/g, '')
    if (digits.length === 10) return `+1${digits}`
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  }

  const digitsOnly = value.replace(/\D/g, '')
  if (digitsOnly.length === 10) return `+1${digitsOnly}`
  if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) return `+${digitsOnly}`

  return value
}

export async function persistUniversalLeadState(
  threadKey: string,
  patch: UniversalLeadStatePatch,
  meta: UniversalLeadStateMeta = {},
): Promise<UniversalLeadStateMutationResult> {
  // GLOBAL WRITE CONTRACT.
  // Every surface -- inbox, composer, pipeline, map -- funnels lead-state
  // writes through here, but they do not all hold the same identifier. Some
  // carry the canonical phone, others a composite selection key such as
  // `ct:property:123|owner:mo_ab|phone:+15551234567`. The API accepts ONLY the
  // canonical phone and answers invalid_canonical_thread_key for anything else,
  // so a surface holding the composite silently failed every write.
  //
  // Canonicalising here means one rule for the whole system instead of each app
  // remembering to resolve its own key.
  const key = canonicalizeLeadStateThreadKey(threadKey)
  const canonicalPatch = normalizePatchToCanonical(patch)
  if (!key) {
    return {
      ok: false,
      threadKey: '',
      errorMessage: 'Missing thread key for universal lead state patch',
      mutationPayload: null,
      writeTarget: 'none',
    }
  }
  if (!Object.keys(canonicalPatch).length) {
    return {
      ok: false,
      threadKey: key,
      errorMessage: 'No allowed universal lead state fields in patch',
      mutationPayload: null,
      writeTarget: 'none',
    }
  }

  const result = await backendClient.patchUniversalLeadState(key, canonicalPatch, {
    ...meta,
    change_source: meta.change_source ?? STATE_SOURCE_CODES.MANUAL,
    execute_next_action: meta.execute_next_action === true,
  })

  return toMutationResult(key, canonicalPatch, result)
}

export async function patchLeadStateFromView(
  sourceView: LeadStateSourceView,
  threadKey: string,
  patch: UniversalLeadStatePatch,
  meta: UniversalLeadStateMeta = {},
): Promise<UniversalLeadStateMutationResult> {
  return persistUniversalLeadState(threadKey, patch, {
    ...meta,
    source_view: sourceView,
  })
}

export function archiveConversation(
  threadKey: string,
  meta: UniversalLeadStateMeta = {},
): Promise<UniversalLeadStateMutationResult> {
  return persistUniversalLeadState(threadKey, {
    is_archived: true,
    archive_scope: ARCHIVE_SCOPE_CODES.CONVERSATION,
  }, meta)
}

export function archiveLead(
  threadKey: string,
  meta: UniversalLeadStateMeta = {},
): Promise<UniversalLeadStateMutationResult> {
  return persistUniversalLeadState(threadKey, {
    is_archived: true,
    archive_scope: ARCHIVE_SCOPE_CODES.LEAD,
  }, meta)
}

export function restoreLead(
  threadKey: string,
  meta: UniversalLeadStateMeta = {},
): Promise<UniversalLeadStateMutationResult> {
  return persistUniversalLeadState(threadKey, {
    is_archived: false,
    archive_scope: null,
    archived_at: null,
  }, meta)
}

export function starThread(
  threadKey: string,
  meta: UniversalLeadStateMeta = {},
): Promise<UniversalLeadStateMutationResult> {
  return persistUniversalLeadState(threadKey, { is_starred: true }, meta)
}

export function unstarThread(
  threadKey: string,
  meta: UniversalLeadStateMeta = {},
): Promise<UniversalLeadStateMutationResult> {
  return persistUniversalLeadState(threadKey, { is_starred: false }, meta)
}

export function pinThread(
  threadKey: string,
  meta: UniversalLeadStateMeta = {},
): Promise<UniversalLeadStateMutationResult> {
  return persistUniversalLeadState(threadKey, { is_pinned: true }, meta)
}

export function unpinThread(
  threadKey: string,
  meta: UniversalLeadStateMeta = {},
): Promise<UniversalLeadStateMutationResult> {
  return persistUniversalLeadState(threadKey, { is_pinned: false }, meta)
}

export function snoozeThread(
  threadKey: string,
  until?: string | Date,
  meta: UniversalLeadStateMeta = {},
): Promise<UniversalLeadStateMutationResult> {
  const snoozedUntil = until instanceof Date
    ? until.toISOString()
    : until ?? new Date(Date.now() + DEFAULT_SNOOZE_MS).toISOString()

  return persistUniversalLeadState(threadKey, {
    operational_status: 'snoozed' satisfies OperationalStatusCode,
    snoozed_until: snoozedUntil,
  }, meta)
}

export function unsnoozeThread(
  threadKey: string,
  meta: UniversalLeadStateMeta = {},
): Promise<UniversalLeadStateMutationResult> {
  return persistUniversalLeadState(threadKey, {
    snoozed_until: null,
    snooze_reason: null,
    operational_status: 'needs_review' satisfies OperationalStatusCode,
  }, meta)
}

