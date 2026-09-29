import type { ClosingDoc, EmdLine, Owner, When } from './closing-execution-api'

export const OWNER_LABEL: Record<Owner, string> = { you: 'You', seller: 'Seller', buyer: 'Buyer', title: 'Title', lender: 'Lender', system: 'System' }

export const money = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `$${Math.round(n).toLocaleString('en-US')}`

export const operatorZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago' } catch { return 'America/Chicago' }
}

const ABBR: Record<string, string> = {
  'America/New_York': 'ET', 'America/Detroit': 'ET', 'America/Indiana/Indianapolis': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT',
  'America/Phoenix': 'MST', 'America/Los_Angeles': 'PT', 'America/Anchorage': 'AKT', 'Pacific/Honolulu': 'HT',
}
export const zoneAbbr = (tz: string | null | undefined) => (tz ? ABBR[tz] || tz.split('/').pop()?.replace(/_/g, ' ') || tz : '')

const dateOf = (d: string) => new Date(`${d}T12:00:00Z`)
export const shortDate = (d: string | null | undefined) => (d ? dateOf(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—')
export const weekdayDate = (d: string) => dateOf(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
export const clock = (hm: string) => {
  const [h, m] = hm.split(':').map(Number)
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}
export const stamp = (at: string | null | undefined, tz?: string | null) => {
  if (!at) return '—'
  const d = new Date(at)
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz || undefined })} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined })}`
}

/** "Sep 30 · 2:00 PM CT" plus the operator's own time only when it differs. */
export function whenLabel(w: When | null | undefined, opTz = operatorZone()): { main: string; alt: string | null } {
  if (!w) return { main: 'No date', alt: null }
  if (!w.time) return { main: shortDate(w.date), alt: null }
  const main = `${shortDate(w.date)} · ${clock(w.time)}${w.tz ? ` ${zoneAbbr(w.tz)}` : ''}`
  if (!w.tz || w.tz === opTz) return { main, alt: null }
  const local = new Date(w.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: opTz })
  return { main, alt: `${local} your time` }
}

/** Countdown words — only for a CONFIRMED date; a target never gets drama. */
export function countdown(daysOut: number | null | undefined): string | null {
  if (daysOut === null || daysOut === undefined) return null
  if (daysOut < 0) return `${-daysOut} day${daysOut === -1 ? '' : 's'} past`
  if (daysOut === 0) return 'Closing today'
  if (daysOut === 1) return 'Closing tomorrow'
  return `Closing in ${daysOut} days`
}

export const DOC_STATUS: Record<string, string> = {
  signed: 'Signed', awaiting_signature: 'Awaiting signature', awaiting_countersignature: 'Awaiting countersignature',
  draft: 'Draft', declined: 'Declined', voided: 'Voided', expired: 'Expired', superseded: 'Superseded',
  received: 'Received', final: 'Final', missing: 'Missing', verified: 'Verified', unknown: 'Unknown',
}
export const docTone = (d: ClosingDoc) =>
  d.status === 'missing' || d.status === 'declined' ? 'bad'
    : d.status === 'signed' || d.status === 'final' || d.status === 'verified' ? 'good'
      : d.status === 'voided' || d.status === 'superseded' || d.status === 'expired' ? 'muted' : 'wait'

export const EMD_WORD: Record<EmdLine['state'], string> = {
  not_required: 'Not required', verified: 'Verified', received: 'Received — not verified', failed: 'Failed', disputed: 'Disputed',
  refunded: 'Refunded', overdue: 'Overdue', due: 'Due', required: 'Required',
}
export const emdTone = (s: EmdLine['state']) =>
  s === 'verified' || s === 'not_required' ? 'good' : s === 'overdue' || s === 'failed' || s === 'disputed' ? 'bad' : 'wait'

export const titleCase = (s: string | null | undefined) => String(s ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
