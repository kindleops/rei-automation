/**
 * WORKFORCE × AGNTEI — pure view model (docs/WORKFORCE-AGNTEI.md §1, §4). The server derives the truthful activity;
 * this only renders it: a live "last seen" from last_seen_at, a tone, and the origin / employment badges. An unknown
 * field renders as unknown, never as "working".
 */
import type { LCTone } from '../../../shared/lc'
import type { WfActivity, WfAssignment, WfEmployee, WfGatewayAuditEvent } from '../api/wf-types'
import { relTime } from './wf-model'

export const WORKING_HEARTBEAT_MS = 2 * 60_000

export const ACTIVITY_TONE: Record<string, LCTone> = {
  working: 'ok', waiting: 'attn', idle: 'neutral', pending_link: 'flow', binding_expired: 'crit', binding_revoked: 'crit', paused: 'attn', retired: 'neutral', done: 'neutral',
}
const STATE_LABEL: Record<string, string> = {
  working: 'Working', waiting: 'Waiting', idle: 'Idle', pending_link: 'Not linked yet', binding_expired: 'Binding expired', binding_revoked: 'Binding revoked', paused: 'Paused', retired: 'Retired', done: 'Done',
}

/** "last seen 3 min ago" from the server's last_seen_at at THIS render (null = never seen). */
export function lastSeenText(iso: string | null | undefined, now: number): string {
  const t = relTime(iso, now)
  return t ? `last seen ${t.replace(/\b(min|hr|sec)\./g, '$1')}` : 'never seen'
}

/**
 * The status line of an employee / assignment: the server's label, with the "last seen" re-rendered live so it never
 * goes stale on screen. An external waiting row reads "Waiting for Ridge (Agntei), last seen 3 min ago".
 */
export function activityText(a: WfActivity | null | undefined, now: number): { label: string; detail: string | null; tone: LCTone; state: string } | null {
  if (!a) return null
  const tone = ACTIVITY_TONE[a.state] ?? 'neutral'
  const base = (a.label ?? STATE_LABEL[a.state] ?? a.state).replace(/,\s*(last seen [^,]+|never seen)$/i, '')
  if (a.reason === 'external_agent' || a.reason === 'agent_silent') return { label: base, detail: lastSeenText(a.last_seen_at, now), tone, state: a.state }
  return { label: base, detail: null, tone, state: a.state }
}
export const activityLine = (a: WfActivity | null | undefined, now: number): string | null => {
  const t = activityText(a, now)
  return t ? (t.detail ? `${t.label}, ${t.detail}` : t.label) : null
}

export const isAgntei = (e: Pick<WfEmployee, 'origin'> | null | undefined): boolean => e?.origin === 'agntei'
export function originBadge(e: Pick<WfEmployee, 'origin' | 'employment_type' | 'kind'>): { label: string; title: string; kind: 'agntei' | 'workforce' | 'human' } {
  if (e.origin === 'agntei' || e.employment_type === 'operator_ai') return { label: 'Agntei', title: 'An operator-directed agent in Agntei: it acts only through the Action Gateway, as this employee', kind: 'agntei' }
  if (e.kind === 'human' || e.employment_type === 'human') return { label: 'Human', title: 'A person', kind: 'human' }
  return { label: 'Workforce', title: 'An autonomous Workforce employee (the in-process engine)', kind: 'workforce' }
}
export const EMPLOYMENT_LABEL: Record<string, string> = { autonomous_ai: 'Autonomous AI', operator_ai: 'Operator-directed AI', human: 'Human' }

export const executionLabel = (a: Pick<WfAssignment, 'execution_mode'>): string | null => (a.execution_mode === 'external' ? 'External · Agntei' : a.execution_mode === 'internal' ? 'Internal' : null)

/** The register form: a valid employee id from a display name (emp_<slug>), or null. */
export function employeeIdFrom(name: string): string | null {
  const slug = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36)
  return slug.length >= 3 ? `emp_${slug}` : null
}
export const AGNTEI_ROLES = ['research_analyst', 'acquisition_agent', 'campaign_manager', 'dispositions_agent', 'ops_supervisor'] as const
export function registerProblems(f: { employee_id: string | null; display_name: string; role_key: string; markets: string[] }): string[] {
  const p: string[] = []
  if (!f.display_name.trim()) p.push('A name is required')
  else if (/[0-9]{4,}|@/.test(f.display_name)) p.push('A name carries no phone number or email')
  if (!f.employee_id || !/^emp_[a-z0-9_]{3,40}$/.test(f.employee_id)) p.push('The employee id must be emp_ and 3 to 40 lower-case letters, digits or _')
  if (!(AGNTEI_ROLES as readonly string[]).includes(f.role_key)) p.push('Choose a role an Agntei agent can hold')
  if ((f.role_key === 'acquisition_agent' || f.role_key === 'campaign_manager' || f.role_key === 'dispositions_agent') && !f.markets.length) p.push('This role is market-scoped: name at least one market')
  return p
}

/** One row of the merged action history (Workforce events + the Action Gateway audit of the principal), newest first. */
export interface HistoryRow { key: string; at: string | null; source: 'workforce' | 'gateway'; what: string; code: string | null }
const humanize = (s: string) => s.replace(/^wf\./, '').replace(/^workforce_/, '').replace(/[._]+/g, ' ').trim()
export function mergeHistory(events: { event_id: number; at: string; type: string; payload?: Record<string, unknown> }[], gateway: WfGatewayAuditEvent[]): HistoryRow[] {
  const rows: HistoryRow[] = [
    ...events.map((e) => ({ key: `w${e.event_id}`, at: e.at, source: 'workforce' as const, what: humanize(e.type), code: typeof e.payload?.reason === 'string' ? (e.payload.reason as string) : null })),
    ...gateway.map((g) => ({ key: `g${g.event_id}`, at: g.at, source: 'gateway' as const, what: `${g.action ? humanize(g.action) : 'call'} · ${humanize(g.event_type)}`, code: g.code })),
  ]
  return rows.sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0))
}
