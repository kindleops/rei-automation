export const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

export const fmt = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export const fmtPct = (n: number): string => `${n.toFixed(1)}%`

export const fmtInterval = (secs: number): string => {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  return `${(secs / 3600).toFixed(1)}h`
}

export const fmtRelative = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const diff = new Date(iso).getTime() - Date.now()
  if (diff < 0) {
    const ago = Math.abs(diff)
    const mins = Math.floor(ago / 60_000)
    if (mins < 60) return `${mins}m ago`
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
    return `${Math.floor(mins / 1440)}d ago`
  }
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `in ${mins}m`
  if (mins < 1440) return `in ${Math.floor(mins / 60)}h`
  return `in ${Math.floor(mins / 1440)}d`
}

/** Lifecycle states in which a future send is actually going to happen. */
const RUNNING_STATUSES = new Set(['scheduled', 'activating', 'active', 'live_limited', 'queued'])

export interface NextSendDisplay {
  label: string
  tone: 'neutral' | 'pending' | 'overdue'
}

/**
 * "Next send" only means something for a campaign that is going to run. Rendering
 * `fmtRelative(next_send_at)` unconditionally produced "Next 53d ago" on paused
 * campaigns whose scheduled_for had long passed — a countdown to an event that
 * cannot occur. Resolve against lifecycle state instead:
 *   - not running        -> no countdown, state is the answer
 *   - running, future    -> "in 3h"
 *   - running, past due  -> "overdue by 2d" (the scheduler has not picked it up)
 */
export const resolveNextSend = (
  campaign: { status?: string | null; next_send_at?: string | null },
): NextSendDisplay => {
  const status = String(campaign.status ?? '').toLowerCase()
  const iso = campaign.next_send_at

  if (!RUNNING_STATUSES.has(status)) {
    if (status === 'paused') return { label: 'Paused', tone: 'neutral' }
    if (status === 'completed') return { label: 'Complete', tone: 'neutral' }
    if (status === 'archived') return { label: 'Archived', tone: 'neutral' }
    if (status === 'failed') return { label: 'Failed', tone: 'overdue' }
    return { label: 'Not scheduled', tone: 'neutral' }
  }

  if (!iso) return { label: 'Not scheduled', tone: 'neutral' }
  const diff = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(diff)) return { label: '—', tone: 'neutral' }
  if (diff >= 0) return { label: fmtRelative(iso), tone: 'pending' }
  return { label: `Overdue by ${fmtRelative(iso).replace(/ ago$/, '')}`, tone: 'overdue' }
}