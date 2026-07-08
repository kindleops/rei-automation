// ─── queue-status-truth.ts ───────────────────────────────────────────────────
// Canonical operational-truth helpers for the Queue.
//
// This module holds the *pure* logic that turns a queue row into the status an
// operator should actually see. It is deliberately dependency-free so it can be
// unit-tested in isolation and reused by both the server-side mapper and the
// render layer.
//
// Slice scope (launch-automation-control-plane §1/§2): make Queue operational
// truth accurate — proof/test rows classified only from explicit metadata,
// provider/receipt truth taking precedence over a bare `sent`, diagnostics
// separated from delivery success, and touch/stage display preferring canonical
// state over a hardcoded touch_number.

import type { QueueItem } from './queue.types'
import { STAGE_LABELS, type StageCode } from './queue.types'

function clean(value: unknown): string {
  return String(value ?? '').trim()
}
function lower(value: unknown): string {
  return clean(value).toLowerCase()
}
function truthy(value: unknown): boolean {
  return value === true || lower(value) === 'true'
}

// ── Proof / test classification (metadata-only) ──────────────────────────────
// A row is proof/test ONLY when its metadata explicitly says so. `sms_eligible`,
// suppression, blocked, failed, cancelled, missing phone, etc. are REAL
// operational statuses and must never be treated as proof.

const PROOF_TRUE_KEYS = [
  'dry_run',
  'proof_mode',
  'test_mode',
  'no_sms_transmit',
  'no_send',
  'proof_hydration',
] as const

export function metadataMarksProof(metadata: Record<string, unknown> | null | undefined): boolean {
  const md = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {}
  if (PROOF_TRUE_KEYS.some((key) => truthy(md[key]))) return true
  if (lower(md.proof_mode) === 'no_send') return true
  if (lower(md.launch_mode) === 'proof_hydration_no_send') return true
  return false
}

export function isProofTestQueueItem(
  item: Pick<QueueItem, 'metadata'> & { dispatchCategory?: string | null },
): boolean {
  if (item.dispatchCategory === 'proof') return true
  return metadataMarksProof(item.metadata)
}

// ── Canonical delivery / status truth ────────────────────────────────────────

export type QueueTruthTone = 'green' | 'red' | 'amber' | 'cyan' | 'blue' | 'muted'
export type QueueTruthSeverity =
  | 'success'
  | 'failure'
  | 'blocked'
  | 'pending'
  | 'diagnostic'
  | 'neutral'

export interface QueueDeliveryTruth {
  status: string
  tone: QueueTruthTone
  severity: QueueTruthSeverity
  isDelivered: boolean
  isFailed: boolean
  isBlocked: boolean
  isTerminal: boolean
  /** Raw queue_status shown as secondary context when it disagrees with truth. */
  secondaryQueueStatus: string | null
  /** Non-fatal operational diagnostics (never the primary status on their own). */
  diagnostics: QueueDiagnosticCode[]
}

export type QueueDiagnosticCode =
  | 'message_event_missing'
  | 'provider_id_missing'
  | 'provider_receipt_missing'
  | 'queue_status_conflict'
  | 'sent_with_failed_reason'
  | 'proof_test_row'

type DeliveryTruthInput = Partial<
  Pick<
    QueueItem,
    | 'status'
    | 'deliveryStatus'
    | 'failedReason'
    | 'failureCategory'
    | 'blockedReason'
    | 'guardReason'
    | 'providerMessageId'
    | 'textgridMessageId'
    | 'messageEventId'
    | 'missingProviderMessageId'
    | 'missingMessageEvent'
    | 'deliveredAt'
    | 'sentAt'
    | 'lastEventStatus'
    | 'metadata'
    | 'dispatchCategory'
  >
> & { deliveryConfirmed?: string | null }

const CONTENT_FILTER_CATEGORIES = new Set(['textgrid_content_filter'])
const OPTOUT_CATEGORIES = new Set(['recipient_opted_out', 'suppression_blocked', 'blacklist_pair_21610'])
const QUEUE_TERMINAL_FAILED = new Set(['failed', 'failed_transport', 'blocked', 'blocked_by_health_guard'])
const QUEUE_TERMINAL_CLOSED = new Set(['expired', 'cancelled', 'duplicate_blocked'])
const QUEUE_PROCESSING = new Set(['processing', 'sending'])
const QUEUE_PRESEND = new Set(['queued', 'scheduled', 'ready', 'pending', 'approval'])

function looksContentFilter(item: DeliveryTruthInput): boolean {
  if (CONTENT_FILTER_CATEGORIES.has(clean(item.failureCategory))) return true
  const reason = lower(item.failedReason)
  return reason.includes('content filter') || reason.includes('carrier block') || reason.includes('spam')
}

function looksOptOutBlocked(item: DeliveryTruthInput): boolean {
  if (OPTOUT_CATEGORIES.has(clean(item.failureCategory))) return true
  const reason = lower(item.failedReason)
  return reason.includes('21610') || reason.includes('opted out') || reason.includes('opt out')
}

function collectDiagnostics(item: DeliveryTruthInput, q: string, hasProviderId: boolean): QueueDiagnosticCode[] {
  const diagnostics: QueueDiagnosticCode[] = []
  if (item.missingMessageEvent) diagnostics.push('message_event_missing')
  if (q === 'sent' && !hasProviderId) diagnostics.push('provider_id_missing')
  if (q === 'sent' && hasProviderId && !item.deliveredAt && !item.failedReason && lower(item.lastEventStatus) !== 'delivered') {
    diagnostics.push('provider_receipt_missing')
  }
  if (q === 'sent' && item.failedReason) diagnostics.push('sent_with_failed_reason')
  if (metadataMarksProof(item.metadata) || item.dispatchCategory === 'proof') diagnostics.push('proof_test_row')
  return diagnostics
}

/**
 * Resolve the status an operator should see, by canonical precedence:
 *   1. provider terminal delivered
 *   2. provider terminal blocked / content-filter
 *   3. provider terminal failed / undelivered
 *   4. send_queue terminal failed / blocked
 *   5. delivery_confirmed = confirmed / queue_status delivered / delivered_at
 *   6. send_queue terminal expired / cancelled
 *   7. failed_reason present (overrides a plain "sent")
 *   8. queue_status sent → awaiting receipt (or Missing Provider ID diagnostic)
 *   9. processing / sending
 *  10. queued / scheduled
 *  11. unknown / needs reconciliation
 *
 * "sent" is never "delivered". A missing provider id or message event is a
 * diagnostic, not a delivery success.
 */
export function resolveQueueDeliveryTruth(item: DeliveryTruthInput): QueueDeliveryTruth {
  const q = lower(item.status)
  const provider = lower(item.lastEventStatus)
  const confirmed = lower(item.deliveryConfirmed) || lower((item.metadata as Record<string, unknown> | undefined)?.delivery_confirmed)
  const hasProviderId = Boolean(clean(item.providerMessageId) || clean(item.textgridMessageId))
  const diagnostics = collectDiagnostics(item, q, hasProviderId)
  const secondaryQueueStatus = clean(item.status) || null

  const base = (
    status: string,
    tone: QueueTruthTone,
    severity: QueueTruthSeverity,
    extra: Partial<QueueDeliveryTruth> = {},
  ): QueueDeliveryTruth => ({
    status,
    tone,
    severity,
    isDelivered: false,
    isFailed: false,
    isBlocked: false,
    isTerminal: false,
    secondaryQueueStatus:
      extra.secondaryQueueStatus !== undefined ? extra.secondaryQueueStatus : secondaryQueueStatus,
    diagnostics,
    ...extra,
  })

  // 1. Provider-confirmed delivered — strongest possible truth.
  if (provider === 'delivered' || confirmed === 'confirmed' || (q === 'delivered' && !item.failedReason)) {
    return base('Delivered', 'green', 'success', { isDelivered: true, isTerminal: true, secondaryQueueStatus: q === 'delivered' ? null : secondaryQueueStatus })
  }
  if (item.deliveredAt && !item.failedReason && provider !== 'failed' && provider !== 'undelivered') {
    return base('Delivered', 'green', 'success', { isDelivered: true, isTerminal: true })
  }

  // 2. Blocked / content filter — visible as its own state, not a plain failure.
  if (looksContentFilter(item)) {
    return base('Blocked / Content Filter', 'amber', 'blocked', { isBlocked: true, isFailed: true, isTerminal: true })
  }
  if (looksOptOutBlocked(item)) {
    return base('Blocked / Opt-Out', 'amber', 'blocked', { isBlocked: true, isFailed: true, isTerminal: true })
  }

  // 3. Provider terminal failure.
  if (provider === 'failed' || provider === 'undelivered' || provider === 'delivery_failed') {
    return base(provider === 'undelivered' ? 'Undelivered' : 'Failed', 'red', 'failure', { isFailed: true, isTerminal: true })
  }

  // 4. Queue terminal failure.
  if (QUEUE_TERMINAL_FAILED.has(q)) {
    return base(q === 'blocked' || q === 'blocked_by_health_guard' ? 'Blocked' : 'Failed', q === 'blocked' || q === 'blocked_by_health_guard' ? 'amber' : 'red', q.startsWith('blocked') ? 'blocked' : 'failure', {
      isFailed: true,
      isBlocked: q.startsWith('blocked'),
      isTerminal: true,
    })
  }

  // 5. Queue says delivered (no stronger provider signal above).
  if (q === 'delivered') {
    return base('Delivered', 'green', 'success', { isDelivered: true, isTerminal: true, secondaryQueueStatus: null })
  }

  // 6. Queue terminal closed states.
  if (QUEUE_TERMINAL_CLOSED.has(q)) {
    const label = q === 'expired' ? 'Expired' : q === 'cancelled' ? 'Cancelled' : 'Duplicate Blocked'
    return base(label, 'muted', 'neutral', { isTerminal: true, secondaryQueueStatus: null })
  }

  // 7. A failed_reason overrides a bare "sent" (the 353-row contradiction bucket).
  if (item.failedReason && (q === 'sent' || q === '' || QUEUE_PRESEND.has(q))) {
    return base('Failed', 'red', 'failure', { isFailed: true, isTerminal: q === 'sent' })
  }

  // 8. Sent — awaiting receipt. Missing provider id is a diagnostic, not success.
  if (q === 'sent' || provider === 'sent') {
    if (!hasProviderId) {
      return base('Missing Provider ID', 'amber', 'diagnostic', { secondaryQueueStatus })
    }
    return base('Awaiting Final Receipt', 'cyan', 'pending')
  }

  // 9. Actively dispatching.
  if (QUEUE_PROCESSING.has(q)) {
    return base('Sending', 'cyan', 'pending')
  }

  // 10. Pre-send.
  if (QUEUE_PRESEND.has(q)) {
    const label = q === 'scheduled' ? 'Scheduled' : q === 'approval' ? 'Approval Required' : 'Queued'
    return base(label, 'blue', 'pending')
  }

  // 11. Unknown / needs reconciliation.
  return base('Unknown / Needs reconciliation', 'muted', 'diagnostic')
}

// ── Touch / stage display truth ──────────────────────────────────────────────
// Prefer canonical seller/thread stage over a hardcoded touch_number. Never
// label an offer/negotiation row as ownership confirmation when canonical state
// disagrees; show "Unknown / Needs reconciliation" when the signals conflict.

const STAGE_RANK: Record<StageCode, number> = {
  S1: 1,
  S1F: 1,
  S2: 2,
  S3: 3,
  S4: 4,
  S5: 5,
  S6: 6,
  manual_reply: 0,
  auto_reply: 0,
  other: 0,
}

// Map free-text canonical stage/status strings to a normalized stage rank.
function canonicalStageRank(text: string): number {
  const t = lower(text)
  if (!t) return -1
  if (/(contract|closing|under[_\s-]?contract|title)/.test(t)) return 6
  if (/(offer|negotiat|counter|asking[_\s-]?price[_\s-]?received)/.test(t)) return 5
  if (/(condition|underwrit|inspection|justif)/.test(t)) return 4
  if (/(asking|price)/.test(t)) return 3
  if (/(interest|selling|warm|engaged)/.test(t)) return 2
  if (/(ownership|owner[_\s-]?confirm|s1)/.test(t)) return 1
  return -1
}

const RANK_TO_STAGECODE: Record<number, StageCode> = { 1: 'S1', 2: 'S2', 3: 'S3', 4: 'S4', 5: 'S5', 6: 'S6' }

export interface TouchStageDisplay {
  stageLabel: string
  stageCode: StageCode | null
  touchLabel: string
  ambiguous: boolean
}

export function resolveTouchStageDisplay(
  item: Pick<
    QueueItem,
    'stageCode' | 'stageLabel' | 'stage' | 'currentStage' | 'touchNumber' | 'useCase' | 'metadata' | 'extractedIntent'
  >,
): TouchStageDisplay {
  const md = (item.metadata && typeof item.metadata === 'object' ? item.metadata : {}) as Record<string, unknown>
  const action = lower(md.action || md.send_action)
  const source = lower(md.source || md.send_source)
  const isOwnershipContext = action === 'send_ownership_check' || source === 'map_command' || action === 'ownership_check'

  // Canonical stage signal from seller/thread state (preferred over stageCode).
  const canonicalText =
    clean(md.seller_stage) ||
    clean(md.canonical_stage) ||
    clean(item.currentStage) ||
    clean(item.stage)
  const canonicalRank = canonicalStageRank(canonicalText)
  const codeRank = item.stageCode ? STAGE_RANK[item.stageCode] : -1

  // Conflict: hardcoded/derived stageCode says ownership (S1) but canonical state
  // says a later stage (offer/negotiation/contract). Trust canonical.
  const conflict = canonicalRank > 0 && codeRank > 0 && canonicalRank !== codeRank && (canonicalRank >= 3 || codeRank >= 3)

  let stageCode: StageCode | null
  let stageLabel: string
  let ambiguous = false

  if (conflict) {
    stageCode = RANK_TO_STAGECODE[canonicalRank] ?? null
    stageLabel = stageCode ? STAGE_LABELS[stageCode] : canonicalText || 'Unknown / Needs reconciliation'
    ambiguous = true
  } else if (item.stageLabel) {
    stageCode = item.stageCode ?? null
    stageLabel = item.stageLabel
  } else if (item.stageCode) {
    stageCode = item.stageCode
    stageLabel = STAGE_LABELS[item.stageCode]
  } else if (canonicalRank > 0) {
    stageCode = RANK_TO_STAGECODE[canonicalRank] ?? null
    stageLabel = stageCode ? STAGE_LABELS[stageCode] : canonicalText
  } else if (canonicalText) {
    stageCode = null
    stageLabel = canonicalText
  } else if (clean(item.useCase)) {
    stageCode = null
    stageLabel = clean(item.useCase)
  } else {
    stageCode = null
    stageLabel = 'Unknown / Needs reconciliation'
    ambiguous = true
  }

  // Touch resolution. A hardcoded touch_number=1 on a non-ownership / later-stage
  // row is not trustworthy — do not assert "T1" when canonical stage disagrees.
  const metaTouch = Number(md.touch_number)
  let touchLabel: string
  if (isOwnershipContext && Number.isFinite(metaTouch) && metaTouch >= 1) {
    touchLabel = `T${metaTouch}`
  } else if (conflict) {
    touchLabel = '—'
  } else if (Number.isFinite(item.touchNumber) && item.touchNumber > 1) {
    touchLabel = `T${item.touchNumber}`
  } else if (isOwnershipContext && item.touchNumber >= 1) {
    touchLabel = `T${item.touchNumber}`
  } else {
    // Hardcoded default of 1 on a non-ownership row — don't assert a touch.
    touchLabel = '—'
  }

  return { stageLabel, stageCode, touchLabel, ambiguous }
}

// ── Drawer close state (pure) ────────────────────────────────────────────────
// Extracted so the close behavior can be asserted without a DOM.

export interface QueueDrawerState {
  selectedId: string | null
  expandedId: string | null
  dossierOpen: boolean
}

export function resolveDrawerCloseState(): QueueDrawerState {
  return { selectedId: null, expandedId: null, dossierOpen: false }
}

/**
 * Guard against the "drawer reopens due to stale selected row effect" bug: once
 * an operator explicitly closes a dossier, an external-context effect must not
 * immediately re-select the same row.
 */
export function shouldReopenDossierFromContext(
  dismissedContextId: string | null,
  matchedId: string | null,
): boolean {
  if (!matchedId) return false
  if (dismissedContextId && dismissedContextId === matchedId) return false
  return true
}
