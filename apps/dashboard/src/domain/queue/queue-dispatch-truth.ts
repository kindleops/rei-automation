export type QueueDispatchCategory =
  | 'runnable'
  | 'proof'
  | 'future_window'
  | 'paused_campaign'
  | 'globally_blocked'
  | 'expired'
  | 'non_runnable'

export interface QueueDispatchTruth {
  category: QueueDispatchCategory
  label: string
  blocker: string | null
  nextEligibleSendAt: string | null
}

export interface QueueDispatchTruthInput {
  status: string
  scheduledForUtc: string
  smsEligible?: boolean | null
  metadata?: Record<string, unknown>
  campaignId?: string | null
  campaignStatus?: string | null
  globalBrakes?: {
    send_blocked?: boolean
    emergency_stop_active?: boolean
    processor_paused?: boolean
    reasons?: string[]
  }
  now?: string | number | Date
}

const LIVE_CAMPAIGN_STATUSES = new Set(['active', 'activating', 'live_limited'])

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function toTimestamp(value: string | number | Date | undefined): number | null {
  if (value == null || value === '') return null
  const ts = new Date(value).getTime()
  return Number.isFinite(ts) ? ts : null
}

function isProofRow(metadata: Record<string, unknown>): boolean {
  return Boolean(
    metadata.no_send === true ||
    metadata.proof_hydration === true ||
    metadata.proof_mode === 'no_send' ||
    metadata.launch_mode === 'proof_hydration_no_send',
  )
}

function formatBrakeBlocker(brakes: QueueDispatchTruthInput['globalBrakes']): string {
  const parts: string[] = []
  if (brakes?.emergency_stop_active) parts.push('Emergency stop active')
  if (brakes?.processor_paused) parts.push('Queue processor paused')
  if (!parts.length && brakes?.reasons?.length) {
    return brakes.reasons.join(' · ')
  }
  return parts.join(' · ') || 'Global send brakes active'
}

export function resolveQueueDispatchTruth(input: QueueDispatchTruthInput): QueueDispatchTruth {
  const status = clean(input.status).toLowerCase()
  const metadata = input.metadata ?? {}
  const nowTs = toTimestamp(input.now) ?? Date.now()
  const scheduledTs = toTimestamp(input.scheduledForUtc)
  const nextEligibleSendAt = scheduledTs && scheduledTs > nowTs ? new Date(scheduledTs).toISOString() : null

  if (status === 'expired') {
    return {
      category: 'expired',
      label: 'Expired',
      blocker: clean(metadata.send_brake_reasons as string) || 'Runnable window expired before send',
      nextEligibleSendAt: null,
    }
  }

  if (isProofRow(metadata) || input.smsEligible === false) {
    return {
      category: 'proof',
      label: 'Proof / Test',
      blocker: 'Proof hydration — no SMS will transmit',
      nextEligibleSendAt: null,
    }
  }

  if (input.campaignId && input.campaignStatus && !LIVE_CAMPAIGN_STATUSES.has(clean(input.campaignStatus).toLowerCase())) {
    return {
      category: 'paused_campaign',
      label: 'Campaign Not Live',
      blocker: `Campaign is ${input.campaignStatus} — sends gate until active`,
      nextEligibleSendAt: nextEligibleSendAt,
    }
  }

  if (input.globalBrakes?.send_blocked) {
    return {
      category: 'globally_blocked',
      label: 'Globally Blocked',
      blocker: formatBrakeBlocker(input.globalBrakes),
      nextEligibleSendAt: nextEligibleSendAt ?? (scheduledTs ? new Date(scheduledTs).toISOString() : null),
    }
  }

  if (scheduledTs !== null && scheduledTs > nowTs) {
    return {
      category: 'future_window',
      label: 'Future Window',
      blocker: 'Scheduled for contact window',
      nextEligibleSendAt: new Date(scheduledTs).toISOString(),
    }
  }

  if (['scheduled', 'queued', 'ready', 'pending', 'approved'].includes(status)) {
    return {
      category: 'runnable',
      label: 'Runnable',
      blocker: null,
      nextEligibleSendAt: scheduledTs ? new Date(scheduledTs).toISOString() : new Date(nowTs).toISOString(),
    }
  }

  return {
    category: 'non_runnable',
    label: 'Not Runnable',
    blocker: `Queue status is ${status || 'unknown'}`,
    nextEligibleSendAt: null,
  }
}