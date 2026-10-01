/**
 * Queue statuses in operator words, with the semantic tone each deserves.
 * A hold is not a failure; a cancellation is the system working.
 */
const QUEUE_WORDS: Record<string, { label: string; tone: 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'neutral' }> = {
  queued: { label: 'Queued', tone: 'exec' },
  scheduled: { label: 'Scheduled', tone: 'exec' },
  pending: { label: 'Queued', tone: 'exec' },
  ready: { label: 'Queued', tone: 'exec' },
  approved: { label: 'Queued', tone: 'exec' },
  processing: { label: 'Sending', tone: 'exec' },
  sending: { label: 'Sending', tone: 'exec' },
  sent: { label: 'Sent · no receipt', tone: 'exec' },
  delivered: { label: 'Delivered', tone: 'ok' },
  failed_transport: { label: 'Not delivered', tone: 'crit' },
  failed: { label: 'Refused', tone: 'crit' },
  blocked_by_health_guard: { label: 'Held at send', tone: 'attn' },
  cancelled: { label: 'Withdrawn', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
  duplicate_blocked: { label: 'Duplicate stopped', tone: 'neutral' },
}

export function queueWordsOf(status: string | null | undefined): { label: string; tone: 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'neutral' } {
  const key = String(status ?? '').trim()
  if (!key) return { label: '—', tone: 'neutral' }
  if (QUEUE_WORDS[key]) return QUEUE_WORDS[key]
  if (key.startsWith('paused_') || key.startsWith('blocked')) return { label: 'Held', tone: 'attn' }
  return { label: key.replace(/_/g, ' '), tone: 'neutral' }
}
