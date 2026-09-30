import type { AttentionGroup, Closing, ClosingRow, GroupKey, Owner, Severity } from '../mobile/closing-execution-api'
import { clock, money, shortDate, zoneAbbr } from '../mobile/closing-format'

/**
 * CLOSING DESK · DESKTOP — pure arrangement over the server's derivation.
 * Nothing here decides a business state: groups, states, items, owners and
 * readiness all arrive from closing-execution-model.js. This file only orders,
 * filters, words and links them.
 */

export const GROUP_ORDER: Array<{ key: GroupKey; label: string }> = [
  { key: 'needs_you', label: 'Needs you' },
  { key: 'closing_today', label: 'Closing today' },
  { key: 'closing_soon', label: 'Closing soon' },
  { key: 'waiting_seller', label: 'Waiting on seller' },
  { key: 'waiting_buyer', label: 'Waiting on buyer' },
  { key: 'waiting_title', label: 'Waiting on title' },
  { key: 'waiting_lender', label: 'Waiting on lender' },
  { key: 'system_handling', label: 'System handling' },
  { key: 'ready', label: 'Ready' },
  { key: 'closed', label: 'Closed' },
  { key: 'cancelled', label: 'Cancelled' },
]

export const ATTENTION_ORDER: Array<{ key: AttentionGroup; label: string }> = [
  { key: 'blocking', label: 'Blocking' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'due_soon', label: 'Due soon' },
  { key: 'missing', label: 'Missing' },
  { key: 'human_decision', label: 'Human decision' },
]

export const OWNER_WORD: Record<Owner, string> = { you: 'You', seller: 'Seller', buyer: 'Buyer', title: 'Title', lender: 'Lender', system: 'System' }
export const BALL_OWNERS: Owner[] = ['you', 'seller', 'buyer', 'title', 'system']
export const SEVERITY_WORD: Record<Severity, string> = { blocking: 'Blocking', overdue: 'Overdue', due_soon: 'Due soon', pending: 'Pending', waiting: 'Waiting', resolved: 'Resolved' }

export type Filter = 'all' | 'needs_you' | 'this_week' | 'waiting' | 'system' | 'ready' | 'closed' | 'cancelled'
export const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'needs_you', label: 'Needs you' },
  { key: 'this_week', label: 'This week' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'system', label: 'System' },
  { key: 'ready', label: 'Ready' },
  { key: 'closed', label: 'Closed' },
  { key: 'cancelled', label: 'Cancelled' },
]
export const SORTS: Array<{ key: string; label: string }> = [
  { key: 'most_urgent', label: 'Most urgent' },
  { key: 'next_closing', label: 'Next closing' },
  { key: 'recently_updated', label: 'Recently updated' },
  { key: 'recently_closed', label: 'Recently closed' },
]

/** The desktop reads the row projection; demo/full payloads are projected the same way. */
export function toRow(x: Closing): ClosingRow {
  return {
    id: x.id, rowId: x.rowId ?? null, opportunityId: x.opportunityId, propertyId: x.propertyId, masterOwnerId: x.masterOwnerId, threadKey: x.threadKey,
    property: x.property, market: x.market ?? null, seller: { name: x.seller.name },
    buyer: x.buyer ? { name: x.buyer.name, selected: x.buyer.selected, committed: x.buyer.committed } : null,
    title: { company: x.title.company, escrowFile: x.title.escrowFile },
    stage: x.stage, terminal: x.terminal, closed: x.closed, ready: x.ready, state: x.state, group: x.group, closing: x.closing, proximity: x.proximity ?? null,
    readiness: x.readiness, requirements: x.requirements.map((r) => ({ key: r.key, label: r.label, met: r.met })),
    items: (x.items ?? []).filter((i) => i.severity !== 'resolved').slice(0, 6).map(({ key, what, owner, severity, group, requirement, requirements, at, dateOnly }) => ({ key, what, owner, severity, group, requirement, requirements, at, dateOnly })),
    ball: x.ball ? { owner: x.ball.owner, ownerLabel: x.ball.ownerLabel, what: x.ball.what, why: x.ball.why, at: x.ball.at, waitingOn: x.ball.waitingOn ?? null, automation: x.ball.automation ? { label: x.ball.automation.label, sequence: x.ball.automation.sequence, at: x.ball.automation.at, why: x.ball.automation.why, held: x.ball.automation.held } : null } : null,
    money: { expectedFee: x.money.estimated.assignmentFee?.value ?? null, actualNet: x.money.actual?.netProceeds ?? null, actualFee: x.money.actual?.assignmentFee ?? null, closedAt: x.money.actual?.legs?.[0]?.closedAt ?? null },
    cancellation: x.cancellation ?? null,
    automation: { paused: Boolean(x.automation?.paused), held: x.automation?.held ?? null },
    updatedAt: x.updatedAt, lastActivityAt: x.lastActivityAt,
  }
}

/* ── search / filter / sort ─────────────────────────────────────────────── */

export const searchText = (r: ClosingRow) => [
  r.property.address, r.property.line, r.property.city, r.market, r.seller.name, r.buyer?.name, r.title.company, r.title.escrowFile, r.id, r.opportunityId, r.propertyId,
].filter(Boolean).join(' ').toLowerCase()

export const matchesQuery = (r: ClosingRow, q: string) => {
  const t = q.trim().toLowerCase()
  if (!t) return true
  const hay = searchText(r)
  return t.split(/\s+/).every((w) => hay.includes(w))
}

export function matchesFilter(r: ClosingRow, f: Filter): boolean {
  switch (f) {
    case 'all': return true
    case 'needs_you': return r.group === 'needs_you'
    case 'this_week': return !r.terminal && !r.closed && Boolean(r.closing?.confirmed) && r.closing?.daysOut !== null && r.closing?.daysOut !== undefined && r.closing.daysOut >= 0 && r.closing.daysOut <= 7
    case 'waiting': return Boolean(r.group?.startsWith('waiting_'))
    case 'system': return r.group === 'system_handling'
    case 'ready': return r.ready
    case 'closed': return r.closed
    case 'cancelled': return r.terminal
  }
}

const TONE_RANK: Record<string, number> = { blocked: 4, attention: 3, external: 2, ready: 2, active: 1 }
const urgency = (r: ClosingRow) => (TONE_RANK[r.state.tone] || 0) * 100 - Math.min(99, Math.max(0, r.closing?.daysOut ?? 99))
const t = (v: string | null | undefined, fallback: number) => { const n = Date.parse(v || ''); return Number.isFinite(n) ? n : fallback }

export function sortRows(rows: ClosingRow[], sort: string): ClosingRow[] {
  const next = (a: ClosingRow, b: ClosingRow) => t(a.closing?.at, 9e15) - t(b.closing?.at, 9e15)
  const cmp: Record<string, (a: ClosingRow, b: ClosingRow) => number> = {
    most_urgent: (a, b) => urgency(b) - urgency(a) || next(a, b),
    next_closing: next,
    recently_updated: (a, b) => t(b.updatedAt, 0) - t(a.updatedAt, 0),
    recently_closed: (a, b) => t(b.money?.closedAt || b.updatedAt, 0) - t(a.money?.closedAt || a.updatedAt, 0),
  }
  return [...rows].sort(cmp[sort] || cmp.most_urgent)
}

export function groupRows(rows: ClosingRow[]): Array<{ key: GroupKey; label: string; rows: ClosingRow[] }> {
  return GROUP_ORDER.map((g) => ({ ...g, rows: rows.filter((r) => (r.group ?? 'needs_you') === g.key) })).filter((g) => g.rows.length > 0)
}

/* ── words ──────────────────────────────────────────────────────────────── */

/** The compact uppercase state a row / hero carries. */
export function stateWord(r: Pick<ClosingRow, 'state' | 'ball' | 'terminal' | 'closed' | 'money'>): string {
  const k = r.state.key
  if (r.terminal) return r.state.label.toUpperCase()
  if (r.closed) return r.money && r.money.actualNet === null ? 'CLOSED · NO SETTLEMENT RECORD' : 'CLOSED'
  if (k === 'date_passed') return 'DATE PASSED'
  if (k === 'ready_to_close') return 'READY TO CLOSE'
  if (k === 'closing_at_risk') return 'AT RISK'
  if (r.state.tone === 'blocked') return 'BLOCKED'
  if (k === 'needs_you') return 'NEEDS YOU'
  if (k === 'system_handling') return 'SYSTEM HANDLING'
  if (k.startsWith('waiting_on_')) return `WAITING ON ${k.slice('waiting_on_'.length).toUpperCase()}`
  return r.state.label.toUpperCase()
}

export const toneClass = (tone: string) => `is-${tone}`

/** "2h 14m" for anything inside the next 24 hours; null otherwise. */
export function countdown(at: string | null | undefined, now: number): string | null {
  const ms = Date.parse(at || '') - now
  if (!Number.isFinite(ms) || ms <= 0 || ms > 24 * 3_600_000) return null
  const m = Math.round(ms / 60_000)
  const h = Math.floor(m / 60)
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

const dayKey = (at: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))

/**
 * "tonight 10:47 PM CT", "tomorrow 6:46 AM CT", "Oct 4 · 2:00 PM CT" — in the
 * property's zone. `dateOnly` values (due dates stored at 00:00Z) read as
 * days: "today", "tomorrow", "Sep 29" — never as a clock time.
 */
export function relativeMoment(at: string | null | undefined, tz: string | null | undefined, now: number, dateOnly = false): string {
  const ms = Date.parse(at || '')
  if (!Number.isFinite(ms)) return '—'
  const zone = tz || 'America/Chicago'
  const today = dayKey(now, zone)
  const tomorrow = dayKey(now + 86_400_000, zone)
  const yesterday = dayKey(now - 86_400_000, zone)
  if (dateOnly) {
    const date = String(at).slice(0, 10)
    return date === today ? 'today' : date === tomorrow ? 'tomorrow' : date === yesterday ? 'yesterday' : shortDate(date)
  }
  const time = new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone })
  const abbr = zoneAbbr(zone)
  const d = dayKey(ms, zone)
  const hour = Number(new Date(ms).toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: zone }))
  if (d === today) return `${hour >= 18 ? 'tonight' : 'today'} ${time} ${abbr}`.trim()
  if (d === tomorrow) return `tomorrow ${time} ${abbr}`.trim()
  if (d === yesterday) return `yesterday ${time} ${abbr}`.trim()
  return `${shortDate(d)} · ${time} ${abbr}`.trim()
}

/** When-fact for a row: the confirmed appointment, a target, or the historic close. */
export function whenFact(r: Pick<ClosingRow, 'closing' | 'closed' | 'terminal' | 'money' | 'cancellation' | 'proximity'>, now: number): string {
  if (r.terminal) return r.cancellation?.at ? `${r.cancellation.label} ${shortDate(r.cancellation.at.slice(0, 10))}` : 'Cancelled'
  if (r.closed) return `Closed ${shortDate((r.money?.closedAt || r.closing?.at || '').slice(0, 10) || null)}`
  const c = r.closing
  if (!c) return 'No closing date'
  if (!c.confirmed) return `Target ${shortDate(c.date)}`
  if (r.proximity?.key === 'passed') return `Was ${shortDate(c.date)}${c.time ? ` · ${clock(c.time)}` : ''}`
  if (r.proximity?.key === 'tomorrow') return 'Closing tomorrow'
  const at = `${shortDate(c.date)}${c.time ? ` · ${clock(c.time)}${c.tz ? ` ${zoneAbbr(c.tz)}` : ''}` : ''}`
  if (r.proximity?.key === 'today') { const cd = countdown(c.at, now); return cd ? `Today · ${c.time ? clock(c.time) : ''}${c.tz ? ` ${zoneAbbr(c.tz)}` : ''} · ${cd}` : `Today${c.time ? ` · ${clock(c.time)}` : ''}` }
  return at
}

/** The one or two reasons a row carries after its state. */
export function reasonFacts(r: ClosingRow, now: number): string[] {
  if (r.terminal) return [r.cancellation?.reason || 'Closing ended'].filter(Boolean) as string[]
  if (r.closed) return [r.money?.actualNet !== null && r.money?.actualNet !== undefined ? `Net ${money(r.money.actualNet)}` : 'Settlement record unavailable']
  const hard = (r.items ?? []).filter((i) => i.severity === 'blocking' || i.severity === 'overdue')
  if (hard.length) return hard.slice(0, 2).map((i) => i.what)
  if (r.ready) return ['Title clear to close']
  const auto = r.ball?.automation
  if (r.ball?.owner === 'system' && auto) return [`${auto.label}${auto.sequence ? ` #${auto.sequence}` : ''} · ${relativeMoment(auto.at, r.property.tz, now)}`]
  const soon = (r.items ?? []).find((i) => i.severity === 'due_soon' || i.group === 'human_decision')
  if (soon) return [soon.what]
  return r.ball ? [r.ball.what.replace(/^[^:]+:\s*/, '')] : []
}

export const readinessFact = (r: Pick<ClosingRow, 'readiness' | 'terminal' | 'closed'>) => (r.terminal || r.closed || !r.readiness ? null : `${r.readiness.met}/${r.readiness.total}`)

/* ── deep links: canonical ids only ─────────────────────────────────────── */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Which closing a URL names. `?case=` is canonical (closing_case_id; an
 * opportunity uuid is accepted and resolved); other apps hand off with
 * ?closing= / ?closing_id= / ?opp= / ?opportunity_id= / ?property_id=.
 * Returns the canonical closing_case_id, or a raw closing id to load by id.
 */
export function resolveCaseParam(params: URLSearchParams, rows: Array<Pick<ClosingRow, 'id' | 'opportunityId' | 'propertyId'>>): string | null {
  const byId = (v: string | null) => (v ? rows.find((r) => r.id === v) ?? null : null)
  const byOpp = (v: string | null) => (v ? rows.find((r) => r.opportunityId === v) ?? null : null)
  const direct = params.get('case') || params.get('closing') || params.get('closing_id')
  if (direct) {
    const hit = byId(direct) || (UUID_RE.test(direct) ? byOpp(direct) : null)
    if (hit) return hit.id
    if (/^closing:/.test(direct)) return direct
    if (UUID_RE.test(direct)) return `closing:${direct}`
  }
  const opp = params.get('opp') || params.get('opportunity_id')
  if (opp) { const hit = byOpp(opp); if (hit) return hit.id }
  const pid = params.get('property_id')
  if (pid) {
    const live = rows.filter((r) => r.propertyId === pid)
    if (live.length) return live[0].id
  }
  return null
}

export const SECTIONS = ['overview', 'buyer', 'emd', 'title', 'contract', 'money', 'documents', 'deadlines', 'timeline', 'activity', 'automation', 'property'] as const
export type Section = (typeof SECTIONS)[number]
export const isSection = (v: string | null): v is Section => Boolean(v && (SECTIONS as readonly string[]).includes(v))

export const links = {
  room: (id: string, section?: Section | null) => `/closing-desk?case=${encodeURIComponent(id)}${section && section !== 'overview' ? `&section=${section}` : ''}`,
  calendarEvent: (eventId: string, date: string) => `/calendar?date=${encodeURIComponent(date)}&event=${encodeURIComponent(eventId)}`,
  workflow: () => '/workflow-studio?wf=closing_execution',
  workflowRun: (closingId: string) => `/workflow-studio?wf=closing_execution&run=${encodeURIComponent(closingId)}`,
  emailThread: (threadId: string) => `/email-command?thread=${encodeURIComponent(threadId)}`,
  pipeline: (opportunityId: string) => `/pipeline?opp=${encodeURIComponent(opportunityId)}`,
}
