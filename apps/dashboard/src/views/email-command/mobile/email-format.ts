import type { OpState, ThreadSummary } from './email-command-api'

export const STATE_LABEL: Record<OpState, string> = {
  needs_you: 'Needs you',
  system_handling: 'System handling',
  waiting: 'Waiting on reply',
  failed: 'Failed',
  unresolved: 'Unresolved',
  done: 'Done',
}

/** Ambient tone per state: cobalt = automation, red = real exception, neutral = waiting. */
export const STATE_TONE: Record<OpState, string> = {
  needs_you: 'attention',
  system_handling: 'active',
  waiting: 'external',
  failed: 'blocked',
  unresolved: 'muted',
  done: 'ready',
}

export const AUTOMATION_LABEL: Record<string, string> = {
  on: 'Automation on',
  sending: 'Sending',
  follow_up_scheduled: 'Follow-up scheduled',
  waiting: 'Waiting',
  paused: 'Paused',
  paused_you_own_it: 'You own this',
  needs_you: 'Needs you',
  completed: 'Completed',
  failed: 'Failed',
}

export const ROLE_LABEL: Record<string, string> = {
  seller: 'Seller', title: 'Title', buyer: 'Buyer', lender: 'Lender', attorney: 'Attorney', agent: 'Agent', vendor: 'Vendor', unresolved: 'Unknown sender', other: 'Contact', internal: 'Internal',
}

export function ago(at: string | null | undefined, now = Date.now()): string {
  const t = at ? Date.parse(at) : NaN
  if (!Number.isFinite(t)) return ''
  const s = Math.round((now - t) / 1000)
  if (s < 0) return until(at, now)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function until(at: string | null | undefined, now = Date.now()): string {
  const t = at ? Date.parse(at) : NaN
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  const tomorrow = new Date(now + 864e5).toDateString() === d.toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (t <= now) return sameDay ? `today ${time}` : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
  if (sameDay) return `today · ${time}`
  if (tomorrow) return `tomorrow · ${time}`
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${time}`
}

export function stamp(at: string | null | undefined): string {
  const t = at ? Date.parse(at) : NaN
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export const money = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? `$${n >= 1000 ? `${Math.round(n / 1000)}K` : n}` : String(n ?? ''))

export function who(t: ThreadSummary): string {
  if (t.context?.kind === 'seller' && t.context.seller_name) return t.context.seller_name
  return t.counterparty.name || t.counterparty.email || 'Unknown'
}

export function where(t: ThreadSummary): string | null {
  return t.property_address || (t.context && 'property_address' in t.context ? t.context.property_address : null) || null
}

/** The one line that says what this conversation is about right now. */
export function businessLine(t: ThreadSummary): string | null {
  if (t.needs) return t.needs.reason
  if (t.context?.kind === 'closing') return t.context.waiting_for
  if (t.context?.kind === 'seller') {
    const fact = t.context.known_facts.find((f) => f.key === 'asking_price')
    return [t.context.stage_label, fact ? `Asking ${money(fact.value)}` : null].filter(Boolean).join(' · ') || null
  }
  return t.subject
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
export const human = (code: string | null | undefined) => cap(String(code || '').replace(/[._]/g, ' ').trim())
