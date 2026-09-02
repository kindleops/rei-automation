// ─── queue-mobile-semantics.ts ───────────────────────────────────────────────
// Presentation-only mapping of the five independent Queue state dimensions.
//
//   1. queue status        send_queue.status — the row's lifecycle slot
//   2. dispatch capability resolveQueueDispatchTruth — can the processor act now
//   3. carrier delivery    resolveQueueDeliveryTruth — what the provider reports
//   4. runnable state      dispatch category === 'runnable'
//   5. retry eligibility   retryEligible minus the non-retryable categories
//
// Nothing here changes business semantics. It exists because the render layer
// previously collapsed (2) and (3) into a single "blocking" string, so a
// finished row surfaced `Needs attention · Queue status is delivered` — the
// dispatch truth's non-runnable fallthrough shown as an operator alert. A
// terminal row is not an exception; it simply has nothing left to run.

import type { QueueItem } from '../../domain/queue/queue.types'
import { FAILURE_LABEL } from '../../domain/queue/classifyFailure'
import { resolveQueueDispatchTruth, type QueueDispatchTruth } from '../../domain/queue/queue-dispatch-truth'
import { resolveQueueDeliveryTruth, type QueueDeliveryTruth } from '../../domain/queue/queue-status-truth'
import { BLOCKED_STATUSES, isFailed, isManualMessage, NON_RETRYABLE_CATEGORIES } from './queue-ui-helpers'

/** Where the row sits in its own life, independent of carrier or processor. */
export type QueueLifecycle =
  | 'pre_send'   // waiting for its window / the processor
  | 'in_flight'  // dispatching or awaiting the carrier receipt
  | 'complete'   // provider-confirmed delivered
  | 'failed'     // provider or queue terminal failure
  | 'blocked'    // stopped before the provider by a guard
  | 'closed'     // cancelled / expired / duplicate / replied first — nothing to do

const PRE_SEND_STATUSES = new Set(['scheduled', 'queued', 'ready', 'pending', 'approval', 'approved', 'held'])
const IN_FLIGHT_STATUSES = new Set(['sending', 'processing', 'sent'])
const CLOSED_STATUSES = new Set(['cancelled', 'expired', 'duplicate_blocked', 'replied_before_send'])

export interface QueueRetryState {
  eligible: boolean
  /** Retry is refused for a durable compliance/validity reason, not a transient one. */
  permanentlyBlocked: boolean
  reason: string | null
}

export interface QueueStateMap {
  queueStatus: string
  dispatch: QueueDispatchTruth
  delivery: QueueDeliveryTruth
  runnable: boolean
  retry: QueueRetryState
  lifecycle: QueueLifecycle
}

const NON_RETRYABLE_REASON: Record<string, string> = {
  blacklist_pair_21610: 'Carrier blacklisted this sender↔recipient pair (21610)',
  recipient_opted_out: 'Recipient opted out',
  suppression_blocked: 'Recipient is suppressed',
  invalid_number: 'Number is not a valid SMS destination',
}

export function resolveQueueRetryState(item: QueueItem): QueueRetryState {
  const category = item.failureCategory ?? ''
  const permanent =
    NON_RETRYABLE_CATEGORIES.has(category) || (item.failedReason ?? '').includes('21610')
  if (permanent) {
    return {
      eligible: false,
      permanentlyBlocked: true,
      reason: NON_RETRYABLE_REASON[category] ?? 'Compliance block — retrying would re-send a suppressed message',
    }
  }
  if (!item.retryEligible) {
    return {
      eligible: false,
      permanentlyBlocked: false,
      reason: item.retryCount >= item.maxRetries
        ? `Retry budget spent (${item.retryCount}/${item.maxRetries})`
        : 'Row is not marked retry eligible',
    }
  }
  return { eligible: true, permanentlyBlocked: false, reason: null }
}

export function resolveQueueStateMap(item: QueueItem): QueueStateMap {
  const dispatch = resolveQueueDispatchTruth({
    status: item.status,
    scheduledForUtc: item.scheduledForUtc,
    smsEligible: item.smsEligible,
    metadata: item.metadata,
    campaignId: item.campaignId,
    campaignStatus: (item.metadata?.campaign_status as string | undefined) ?? null,
    globalBrakes: item.metadata?.global_send_brakes as QueueItem['metadata'],
  })
  const delivery = resolveQueueDeliveryTruth(item)
  const status = String(item.status ?? '').toLowerCase()

  let lifecycle: QueueLifecycle
  if (delivery.isDelivered) lifecycle = 'complete'
  else if (delivery.isBlocked || BLOCKED_STATUSES.has(status)) lifecycle = 'blocked'
  else if (delivery.isFailed || isFailed(status)) lifecycle = 'failed'
  else if (CLOSED_STATUSES.has(status)) lifecycle = 'closed'
  else if (IN_FLIGHT_STATUSES.has(status)) lifecycle = 'in_flight'
  else if (PRE_SEND_STATUSES.has(status)) lifecycle = 'pre_send'
  else lifecycle = 'closed'

  return {
    queueStatus: item.status,
    dispatch,
    delivery,
    runnable: dispatch.category === 'runnable',
    retry: resolveQueueRetryState(item),
    lifecycle,
  }
}

// ── Attention ────────────────────────────────────────────────────────────────
// A row needs attention only when an operator can change its outcome. Finished
// work (delivered, cancelled, replied first) is never an alert.

export type AttentionTone = 'red' | 'amber' | 'cyan'

export interface QueueAttention {
  needsAttention: boolean
  /** Short actionable condition, e.g. "Carrier receipt unresolved". */
  headline: string | null
  /** The underlying evidence, verbatim from the row where one exists. */
  detail: string | null
  tone: AttentionTone
}

const DIAGNOSTIC_ATTENTION: Record<string, { headline: string; detail: string; tone: AttentionTone }> = {
  provider_receipt_missing: {
    headline: 'Carrier receipt unresolved',
    detail: 'Dispatched with a provider ID but no delivery or failure receipt has arrived.',
    tone: 'amber',
  },
  provider_id_missing: {
    headline: 'Provider ID missing',
    detail: 'Marked sent but no provider message ID was recorded — the send is unconfirmed.',
    tone: 'amber',
  },
  message_event_missing: {
    headline: 'Delivery event not reconciled',
    detail: 'No message event is linked to this row, so delivery cannot be confirmed from the webhook stream.',
    tone: 'amber',
  },
  queue_status_conflict: {
    headline: 'Queue status conflicts with the receipt',
    detail: 'The stored queue status disagrees with the provider receipt for this row.',
    tone: 'amber',
  },
  sent_with_failed_reason: {
    headline: 'Sent row carries a failure reason',
    detail: 'The row is marked sent but a provider failure reason is attached.',
    tone: 'red',
  },
}

const DISPATCH_ATTENTION: Partial<Record<QueueDispatchTruth['category'], AttentionTone>> = {
  globally_blocked: 'red',
  paused_campaign: 'amber',
  proof: 'cyan',
}

export function resolveQueueAttention(item: QueueItem, state?: QueueStateMap): QueueAttention {
  const s = state ?? resolveQueueStateMap(item)
  const none: QueueAttention = { needsAttention: false, headline: null, detail: null, tone: 'amber' }

  // Finished work is never an alert, whatever the pre-send dispatch label says.
  if (s.lifecycle === 'complete' || s.lifecycle === 'closed') return none

  if (s.lifecycle === 'blocked') {
    const detail = item.blockedReason || item.pausedReason || item.guardReason || null
    return {
      needsAttention: true,
      headline: s.delivery.isBlocked ? s.delivery.status : 'Blocked before send',
      detail,
      tone: 'amber',
    }
  }

  if (s.lifecycle === 'failed') {
    const manualMissingTemplate = isManualMessage(item) && item.failureCategory === 'missing_template'
    const headline = !manualMissingTemplate && item.failureCategory
      ? (FAILURE_LABEL[item.failureCategory] ?? item.failureCategory.replace(/_/g, ' '))
      : 'Send failed'
    return {
      needsAttention: true,
      headline,
      detail: item.failedReason || s.retry.reason,
      tone: 'red',
    }
  }

  if (item.status === 'approval') {
    return {
      needsAttention: true,
      headline: 'Operator approval required',
      detail: item.approvalReason || 'This row will not dispatch until an operator approves it.',
      tone: 'amber',
    }
  }

  // Real gates on an otherwise live row — a future contact window is not one.
  const dispatchTone = DISPATCH_ATTENTION[s.dispatch.category]
  if (dispatchTone && s.dispatch.blocker) {
    const headline = s.dispatch.category === 'globally_blocked'
      ? 'Global send brakes engaged'
      : s.dispatch.category === 'paused_campaign'
        ? 'Campaign is not live'
        : 'Proof / test row — no SMS will transmit'
    return { needsAttention: true, headline, detail: s.dispatch.blocker, tone: dispatchTone }
  }

  // Diagnostics only matter while a row is still in flight.
  if (s.lifecycle === 'in_flight') {
    for (const code of s.delivery.diagnostics) {
      const mapped = DIAGNOSTIC_ATTENTION[code]
      if (mapped) {
        return { needsAttention: true, headline: mapped.headline, detail: mapped.detail, tone: mapped.tone }
      }
    }
  }

  if (!isManualMessage(item) && item.failureCategory === 'missing_template' && s.lifecycle === 'pre_send') {
    return {
      needsAttention: true,
      headline: FAILURE_LABEL.missing_template ?? 'Missing template',
      detail: 'No template is attached for this stage, so the row cannot render a message.',
      tone: 'amber',
    }
  }

  return none
}

// ── Capability ───────────────────────────────────────────────────────────────
// "What can this row do next" — deliberately separate from the delivery
// timeline so the two are never read as one dimension.

export type CapabilityTone = 'green' | 'blue' | 'cyan' | 'amber' | 'red' | 'muted'

export interface QueueCapability {
  label: string
  tone: CapabilityTone
  /** Human copy: why the row can or cannot act right now. */
  explanation: string
  canRetry: boolean
  canReschedule: boolean
  canPause: boolean
  canApprove: boolean
}

const fmtWhen = (iso: string | null | undefined): string => {
  if (!iso) return 'its scheduled window'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'its scheduled window'
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function resolveQueueCapability(item: QueueItem, state?: QueueStateMap): QueueCapability {
  const s = state ?? resolveQueueStateMap(item)
  const base = { canRetry: false, canReschedule: false, canPause: false, canApprove: false }

  if (s.lifecycle === 'complete') {
    return {
      ...base,
      label: 'Complete',
      tone: 'green',
      explanation: 'The carrier confirmed delivery. Nothing further will send from this row.',
    }
  }

  if (s.lifecycle === 'closed') {
    // `status` is widened deliberately: the queue emits terminal states
    // (expired, duplicate_blocked) that the QueueItemStatus union predates.
    const raw = String(item.status ?? '').toLowerCase()
    const why = raw === 'expired'
      ? 'The contact window passed before the processor reached this row, so it will not send.'
      : raw === 'replied_before_send'
        ? 'The seller replied before this row dispatched, so the send was withdrawn.'
        : raw === 'duplicate_blocked'
          ? 'A duplicate of this message already exists, so this row was closed.'
          : 'This row was cancelled and will not send.'
    return { ...base, label: s.delivery.status, tone: 'muted', explanation: why }
  }

  if (s.lifecycle === 'failed') {
    if (s.retry.permanentlyBlocked) {
      return {
        ...base,
        label: 'Will not retry',
        tone: 'red',
        explanation: `${s.retry.reason}. Retrying is blocked to keep the send compliant.`,
      }
    }
    if (s.retry.eligible) {
      return {
        ...base,
        canRetry: true,
        canReschedule: true,
        label: 'Retry eligible',
        tone: 'amber',
        explanation: `Attempt ${item.retryCount} of ${item.maxRetries} failed. This row can be retried or rescheduled.`,
      }
    }
    return {
      ...base,
      canReschedule: true,
      label: 'Retry exhausted',
      tone: 'red',
      explanation: `${s.retry.reason ?? 'No retries remain'}. Reschedule it to try again in a new window.`,
    }
  }

  if (s.lifecycle === 'blocked') {
    // A compliance block (opt-out, 21610, suppression) must never read as
    // "clear the block and reschedule" — rescheduling it would re-send to a
    // contact the carrier or the recipient has refused.
    if (s.retry.permanentlyBlocked) {
      return {
        ...base,
        label: 'Will not retry',
        tone: 'red',
        explanation: `${s.retry.reason}. Rescheduling or retrying this row is blocked.`,
      }
    }
    return {
      ...base,
      canReschedule: true,
      label: 'Blocked',
      tone: 'amber',
      explanation: 'A guard stopped this row before the provider. Clear the block, then reschedule.',
    }
  }

  if (s.lifecycle === 'in_flight') {
    const awaiting = s.delivery.diagnostics.includes('provider_receipt_missing')
    return {
      ...base,
      canPause: false,
      label: s.delivery.status,
      tone: s.delivery.tone === 'amber' ? 'amber' : 'cyan',
      explanation: awaiting
        ? 'The message is with the carrier. No action is available until a receipt arrives.'
        : 'The message is dispatching now. Actions are unavailable while it is in flight.',
    }
  }

  // Pre-send.
  if (item.status === 'approval') {
    return {
      ...base,
      canApprove: true,
      canReschedule: true,
      canPause: true,
      label: 'Awaiting approval',
      tone: 'amber',
      explanation: 'An operator must approve this row before the processor will dispatch it.',
    }
  }

  switch (s.dispatch.category) {
    case 'runnable':
      return {
        ...base,
        canReschedule: true,
        canPause: true,
        label: 'Runnable',
        tone: 'green',
        explanation: 'This row is inside its window and eligible to dispatch on the next processor pass.',
      }
    case 'future_window':
      return {
        ...base,
        canReschedule: true,
        canPause: true,
        label: 'Scheduled',
        tone: 'blue',
        explanation: `Held until ${fmtWhen(s.dispatch.nextEligibleSendAt)} to respect the contact window.`,
      }
    case 'paused_campaign':
      return {
        ...base,
        canReschedule: true,
        label: 'Campaign paused',
        tone: 'amber',
        explanation: s.dispatch.blocker ?? 'The parent campaign is not live, so sends are gated.',
      }
    case 'globally_blocked':
      return {
        ...base,
        label: 'Globally blocked',
        tone: 'red',
        explanation: s.dispatch.blocker ?? 'Global send brakes are engaged for every queue row.',
      }
    case 'proof':
      return {
        ...base,
        label: 'Proof / test',
        tone: 'cyan',
        explanation: 'Proof hydration row — it will never transmit an SMS.',
      }
    case 'expired':
      return {
        ...base,
        label: 'Expired',
        tone: 'muted',
        explanation: s.dispatch.blocker ?? 'The runnable window expired before send.',
      }
    default:
      return {
        ...base,
        canPause: true,
        label: 'Not runnable',
        tone: 'muted',
        explanation: 'The processor will not pick this row up in its current queue state.',
      }
  }
}

// ── Dense-row signal ─────────────────────────────────────────────────────────
// One concise operational reason for the list. Attention wins; otherwise the
// row reports its own capability.

export function resolveQueueRowSignal(item: QueueItem, state?: QueueStateMap): { text: string; tone: CapabilityTone } {
  const s = state ?? resolveQueueStateMap(item)
  const attention = resolveQueueAttention(item, s)
  if (attention.needsAttention && attention.headline) {
    return { text: attention.headline, tone: attention.tone === 'cyan' ? 'cyan' : attention.tone }
  }
  const capability = resolveQueueCapability(item, s)
  return { text: capability.label, tone: capability.tone }
}

// ── Attention-first queue summary ────────────────────────────────────────────
// Every field maps 1:1 to a status bucket the server can filter on, so a tile's
// number always equals what tapping it shows. (An earlier draft summed
// failed+blocked+approval into one "attention" tile whose tap could only apply
// the `failed` bucket — the count and the resulting list disagreed.)

export interface QueueAttentionSummary {
  queued: number
  sending: number
  failed: number
  scheduled: number
  blocked: number
  approval: number
  delivered: number
  sent: number
}

export function summarizeQueueAttention(
  kpi: {
    scheduled: number; queued: number; sending: number; failed: number
    blocked: number; approval: number; delivered: number; sent: number
  },
): QueueAttentionSummary {
  return {
    queued: kpi.queued,
    sending: kpi.sending,
    failed: kpi.failed,
    scheduled: kpi.scheduled,
    blocked: kpi.blocked,
    approval: kpi.approval,
    delivered: kpi.delivered,
    sent: kpi.sent,
  }
}
