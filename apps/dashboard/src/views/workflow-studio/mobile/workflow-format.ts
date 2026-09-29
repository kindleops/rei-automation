import type { IconName } from '../../../shared/icons'
import type { Beat } from './workflow-observatory-api'

export const RUN_LABEL: Record<string, string> = {
  completed: 'Completed', waiting: 'Waiting', held: 'Held by policy', needs_operator: 'Needs you', failed: 'Failed',
  superseded: 'Superseded', running: 'Running', paused: 'Paused', cancelled: 'Cancelled',
}
export const RUN_TONE: Record<string, string> = {
  completed: 'good', waiting: 'neutral', held: 'muted', needs_operator: 'attention', failed: 'bad', superseded: 'muted', running: 'active', paused: 'attention', cancelled: 'muted',
}
export const FAMILY_LABEL: Record<string, string> = {
  trigger: 'Trigger', resolve: 'Resolve', understand: 'Understand', decision: 'Decision', action: 'Action', wait: 'Wait', approval: 'Approval', state: 'State', notify: 'Notify', end: 'End',
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
export const human = (code: string | null | undefined) => cap(String(code || '').replace(/[._]/g, ' ').trim())

export function ago(at: string | null | undefined, now = Date.now()): string {
  const t = at ? Date.parse(at) : NaN
  if (!Number.isFinite(t)) return ''
  const s = Math.round((now - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function clock(at: string | null | undefined): string {
  const t = at ? Date.parse(at) : NaN
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

export function beatLabel(b: Beat): string {
  if (b.state === 'event_driven') return b.last_run_at ? `Event-driven · last run ${ago(b.last_run_at)}` : 'Event-driven · no runs yet'
  if (b.state === 'never') return `No heartbeat — never run${b.cadence ? ` (${b.cadence})` : ''}`
  if (b.state === 'stale') return `Heartbeat stale · ${ago(b.at)}`
  return `Heartbeat ${ago(b.at)}${b.cadence ? ` · ${b.cadence}` : ''}`
}

export function domainIcon(domain: string): IconName {
  return ({ seller: 'message', closing: 'key', campaign: 'bolt', email: 'mail' } as Record<string, IconName>)[domain] || 'layers'
}
