import { Fragment, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import type { DeskEvent, DeskTimeline } from '../../../domain/calendar/calendar-timeline-api'
import { humanReason } from '../../../domain/calendar/calendar-timeline-api'
import { clock, countdown, dayKey, isGroup, longDay, monthDay, timeText, zoneAbbr, zoneFor, type DeskItem, type TzMode } from './desk-model'

/**
 * CALENDAR 3.0 · the event grammar. Each kind of real thing has its own
 * object — a campaign window is a long span, a closing a milestone, a
 * follow-up a capsule, a deadline a thin emphasis row, a workflow wait a timer
 * — never equal rectangles. Colour is semantic and never the only signal:
 * every state is also a word.
 */

/** Class names; a falsy count (`n && 'is-x'` with n = 0) contributes nothing. */
export const cx = (...t: Array<string | number | false | null | undefined>) => t.filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ')

export const OWNER_LABEL: Record<DeskEvent['owner'], string> = { you: 'You', system: 'System', seller: 'Seller', buyer: 'Buyer', title: 'Title', external: 'External' }
export const STATE_LABEL: Record<DeskEvent['state'], string> = {
  upcoming: 'Upcoming', live: 'Live', waiting: 'Waiting', needs_you: 'Needs you', overdue: 'Overdue', completed: 'Completed', cancelled: 'Cancelled', superseded: 'Superseded',
}
const EDIT_LABEL = { read_only: 'Read-only system event', reschedulable: 'Reschedulable', manual: 'Manual · scheduled by you' } as const

const TYPE_ICON: Partial<Record<DeskEvent['type'], IconName>> = {
  campaign_window: 'clock', campaign_start: 'bolt', campaign_sends: 'send', scheduled_message: 'message', scheduled_message_group: 'layers',
  seller_follow_up: 'message', pipeline_action: 'activity', offer: 'file-text' as IconName, closing: 'key' as IconName, closing_milestone: 'flag' as IconName,
  closing_missing_date: 'flag' as IconName, workflow_timer: 'clock', workflow_approval: 'shield', workflow_held: 'alert', workflow_run: 'activity', email_scheduled: 'inbox',
}
export const iconFor = (e: Pick<DeskEvent, 'type'>): IconName => TYPE_ICON[e.type] || 'calendar'

/** Semantic tone: state first (overdue/attention/done), then lane. */
export function toneOf(e: DeskEvent): string {
  if (e.attention_state === 'blocking' || (e.state === 'overdue' && e.owner === 'you')) return 'bad'
  if (e.attention) return 'attn'
  if (e.state === 'completed') return 'done'
  if (e.state === 'cancelled' || e.state === 'superseded') return 'void'
  if (e.type === 'closing' && (e.detail as { ready?: boolean })?.ready) return 'ready'
  if (e.lane === 'workflow') return 'wf'
  if (e.lane === 'closing') return 'closing'
  if (e.lane === 'manual' || e.owner === 'you') return 'man'
  return 'sys'
}

export function OwnerTag({ owner, manual }: { owner: DeskEvent['owner']; manual?: boolean }) {
  return <span className={cx('c3-owner', `is-${owner}`)} title={manual ? 'Scheduled by you; the system sends it' : undefined}>{manual && owner === 'system' ? 'You → System' : OWNER_LABEL[owner]}</span>
}
export function StateTag({ e }: { e: Pick<DeskEvent, 'state' | 'attention_state' | 'status'> }) {
  const label = e.status === 'stalled' ? 'Overdue' : STATE_LABEL[e.state]
  return <span className={cx('c3-state', `is-${e.state}`, e.attention_state !== 'none' && `is-${e.attention_state}`)}>{label}</span>
}

function campaignParts(name: string | null) {
  const parts = String(name || 'Campaign').split(' · ')
  return { head: parts.slice(0, 2).join(' · '), tail: parts.slice(2).join(' · ') }
}

type Detail = Record<string, unknown> & {
  window?: string; tz?: string; eligible?: number; remaining?: number; scheduled?: number; sent?: number; held?: number; day_index?: number; projected_days?: number; daily_pace?: number; halted?: string | null
  feeder?: { at?: string | null; bound?: string | null; reason?: string | null; sent_today?: number | null; ready_remaining?: number | null; live_rows?: number | null; last_refill_at?: string | null; stalled?: boolean } | null
  counts?: Record<string, number>; delivered?: number; failed?: number; past_due?: number; next_send_at?: string | null
  workflow_name?: string; node_label?: string | null; duration_hours?: number | null; anchor_at?: string | null; next_nodes?: Array<{ label: string; exit: string | null }>; steps?: Array<{ node: string; kind: string; status: string; exit: string | null; reason: string | null; at: string }>; run_state?: string; outcome?: string | null; version?: number
  closing_state?: { label?: string; tone?: string } | null; ready?: boolean; requirements?: Array<{ key: string; label: string; met: boolean }>; blockers?: Array<{ what: string; why?: string; ownerLabel?: string }>; buyer?: string | null; title_company?: string | null
  members?: Array<{ id: string; start: string; subtitle: string | null; reason: string | null; status: string; title?: string }>
  reasons?: Record<string, number>; followup_reason?: string | null; scheduled_by?: string | null; cancel_reason?: string | null; outcome_at?: string | null; reply_marker?: boolean
}
const det = (e: DeskEvent) => (e.detail || {}) as Detail
/** The feeder's own reason code, in plain words (unknown codes are shown as written). */
const FEEDER_WORDS: Record<string, string> = {
  buffer_full: 'buffer full', no_row_placed: 'nothing new to place', refilled: 'refilled', cohort_exhausted: 'cohort exhausted',
  buffer: 'topping up', daily_cap: 'daily cap reached', total_cap: 'total cap reached', outside_window: 'outside the window',
}
export const feederWords = (f: { reason?: string | null; bound?: string | null } | null | undefined) => {
  const k = String(f?.reason || f?.bound || '').trim()
  return FEEDER_WORDS[k] || k.replace(/_/g, ' ') || 'checked'
}
const fmtHours = (ms: number) => { const m = Math.max(0, Math.round(ms / 60_000)); const h = Math.floor(m / 60); return h ? `${h} h${m % 60 ? ` ${m % 60} m` : ''}` : `${m} m` }

/* ── the grammar ─────────────────────────────────────────────────────── */

interface ObjProps { e: DeskEvent; mode: TzMode; tz: string; now: number; today: string; selected?: boolean; arrived?: boolean; past?: boolean; compact?: boolean; onOpen: (e: DeskEvent) => void }

export function EventObject(p: ObjProps) {
  const { e } = p
  if (e.kind === 'window') return <WindowSpan {...p} />
  if (e.type === 'closing') return <ClosingMilestone {...p} />
  if (e.kind === 'deadline') return <DeadlineRow {...p} />
  if (e.kind === 'timer') return <TimerObject {...p} />
  if (e.kind === 'group') return <SendsBlock {...p} />
  return <Capsule {...p} />
}

function frame(p: ObjProps, cls: string, body: ReactNode, label: string) {
  const { e } = p
  return (
    <button type="button" className={cx('c3-obj', cls, `t-${toneOf(e)}`, p.selected && 'is-selected', p.arrived && 'is-arrived', (p.past || e.history) && 'is-past', p.compact && 'is-compact')}
      onClick={() => p.onOpen(e)} aria-label={label} aria-pressed={p.selected} data-event={e.id}>
      {body}
    </button>
  )
}

/** Campaign window = a long glass span with its real facts. */
function WindowSpan(p: ObjProps) {
  const { e, now } = p
  const d = det(e)
  const { head, tail } = campaignParts(e.subtitle)
  const s = Date.parse(e.start)
  const end = Date.parse(e.end || e.start)
  const pct = now <= s ? 0 : now >= end ? 100 : ((now - s) / (end - s)) * 100
  const t = timeText(e, p.mode, p.tz)
  const live = e.state === 'live'
  const status = d.halted ? 'Halted' : live ? 'Running' : e.state === 'completed' ? 'Closed' : `Opens ${clock(e.start, zoneFor(e, p.mode, p.tz))}`
  const f = d.feeder
  const facts = [t.main, d.projected_days ? `Day ${d.day_index} of ${d.projected_days}` : null, d.eligible != null ? `${d.eligible.toLocaleString()} eligible` : null].filter(Boolean)
  return frame(p, 'c3-window', (
    <>
      <span className="c3-window__top">
        <span className="c3-window__name"><b>{head}</b>{tail ? <em>{tail}</em> : null}</span>
        <span className={cx('c3-window__status', live && 'is-live', d.halted && 'is-halted')}>{live && !d.halted ? <i aria-hidden /> : null}{status}</span>
      </span>
      <span className="c3-window__facts">{facts.join(' · ')}{t.alt ? <em> · {t.alt}</em> : null}</span>
      <span className="c3-window__track" aria-hidden><i style={{ width: `${pct}%` }} />{live ? <b style={{ left: `${pct}%` }} /> : null}</span>
      {live && f ? (
        <span className="c3-window__live">
          {f.sent_today != null ? <span><b>{f.sent_today}</b> sent today</span> : null}
          {f.ready_remaining != null ? <span><b>{f.ready_remaining}</b> ready</span> : null}
          {f.live_rows != null ? <span><b>{f.live_rows}</b> queued</span> : null}
          {f.at ? <span className="is-quiet">feeder · {feederWords(f)} · {clock(f.at, p.tz)}</span> : null}
        </span>
      ) : null}
    </>
  ), `${head} send window, ${status}`)
}

/** Closing = a strong milestone object; a restrained countdown when near. */
function ClosingMilestone(p: ObjProps) {
  const { e } = p
  const d = det(e)
  const req = (d.requirements || []).filter((r) => ['buyer', 'emd', 'title', 'schedule'].includes(r.key))
  const cd = countdown(e, p.today)
  const t = timeText(e, p.mode, p.tz)
  return frame(p, 'c3-closing', (
    <>
      <span className="c3-closing__mark" aria-hidden><i /></span>
      <span className="c3-closing__body">
        <span className="c3-closing__eyebrow">{e.title}{d.closing_state?.label ? ` · ${d.closing_state.label}` : ''}</span>
        <b className="c3-closing__place">{e.place || e.subtitle || 'Closing'}</b>
        <span className="c3-closing__time">{t.main}{t.alt ? <em> · {t.alt}</em> : null}{e.subtitle && e.place ? <em> · {e.subtitle}</em> : null}</span>
        {req.length ? (
          <span className="c3-closing__req">
            {req.map((r) => <span key={r.key} className={cx(r.met && 'is-met')}><i aria-hidden />{r.label.replace(/^Buyer /, '').replace(/^Closing /, 'Date ')}{r.met ? '' : ' — open'}</span>)}
          </span>
        ) : null}
      </span>
      {cd ? <span className="c3-closing__count">{cd}</span> : <StateTag e={e} />}
    </>
  ), `${e.title} ${e.place || ''}`)
}

/** Deadline = a thin emphasis row. */
function DeadlineRow(p: ObjProps) {
  const { e } = p
  const t = timeText(e, p.mode, p.tz)
  return frame(p, 'c3-deadline', (
    <>
      <span className="c3-deadline__rule" aria-hidden />
      <span className="c3-deadline__what"><b>{e.title}</b>{e.place ? <em>{e.place}</em> : e.subtitle ? <em>{e.subtitle}</em> : null}</span>
      <span className="c3-deadline__when">{e.all_day ? (e.date ? monthDay(e.date) : 'No date') : t.main}</span>
      <OwnerTag owner={e.owner} />
      <StateTag e={e} />
    </>
  ), `${e.title} deadline`)
}

/** Workflow wait / approval = a timer object. */
function TimerObject(p: ObjProps) {
  const { e, now } = p
  const d = det(e)
  const wake = Date.parse(e.start)
  const anchor = Date.parse(d.anchor_at || '')
  const total = Number.isFinite(anchor) ? wake - anchor : null
  const done = total && total > 0 ? Math.min(100, Math.max(0, ((now - anchor) / total) * 100)) : null
  const z = zoneFor(e, p.mode, p.tz)
  const running = e.type === 'workflow_timer' && e.state !== 'overdue'
  const head = String(d.workflow_name || e.title).toUpperCase()
  const spec = e.type === 'workflow_timer'
    ? [d.duration_hours ? `${d.duration_hours} h timer` : 'Timer', `${running ? 'expires' : 'expired'} ${clock(e.start, z)} ${zoneAbbr(z)}`]
    : e.type === 'workflow_approval' ? ['Approval', `due ${clock(e.start, z)} ${zoneAbbr(z)}`]
      : e.type === 'workflow_held' ? ['Held', humanReason(d.reason as string)] : [String(d.outcome || 'Finished').replace(/_/g, ' '), clock(e.start, z)]
  return frame(p, 'c3-timer', (
    <>
      <span className="c3-timer__dial" aria-hidden style={{ ['--p' as string]: `${done ?? (e.history ? 100 : 0)}` }}><i /></span>
      <span className="c3-timer__body">
        <span className="c3-timer__head"><b>{head}</b><span>{spec.join(' · ')}</span></span>
        {d.node_label ? <span className="c3-timer__node">{d.node_label}{running && Number.isFinite(anchor) ? ` · waited ${fmtHours(now - anchor)}` : ''}</span> : null}
        {!e.history && d.next_nodes?.length ? <span className="c3-timer__next">next: {d.next_nodes.map((n) => n.label).join(' → ')}</span> : null}
        {e.history && e.reason ? <span className="c3-timer__next">{e.reason}</span> : null}
      </span>
      <StateTag e={e} />
    </>
  ), `${head} ${spec.join(' ')}`)
}

/** A day's campaign sends / a group of messages = one block, never rows per text. */
function SendsBlock(p: ObjProps) {
  const { e } = p
  const d = det(e)
  const z = zoneFor(e, p.mode, p.tz)
  const c = d.counts || {}
  const bits = e.type === 'campaign_sends'
    ? [c.sent ? `${c.sent} sent` : null, d.delivered ? `${d.delivered} delivered` : null, (c.scheduled || 0) + (c.sending || 0) ? `${(c.scheduled || 0) + (c.sending || 0)} queued` : null, d.failed ? `${d.failed} did not go out` : null].filter(Boolean)
    : Object.entries(d.reasons || {}).slice(0, 2).map(([r, n]) => `${n} ${humanReason(r).toLowerCase()}`)
  return frame(p, 'c3-block', (
    <>
      <span className="c3-block__icon" aria-hidden><Icon name={iconFor(e)} /></span>
      <span className="c3-block__body">
        <span className="c3-block__head"><b>{e.title}</b>{e.subtitle ? <em>{e.subtitle}</em> : null}</span>
        <span className="c3-block__facts">{clock(e.start, z)}{e.end ? `–${clock(e.end, z)}` : ''} {zoneAbbr(z)}{bits.length ? ` · ${bits.join(' · ')}` : ''}{d.next_send_at && !e.history ? ` · next ${clock(d.next_send_at, z)}` : ''}</span>
        {e.attention && e.reason ? <span className="c3-why is-attn">{humanReason(e.reason)}</span> : null}
      </span>
      <StateTag e={e} />
    </>
  ), e.title)
}

/** Follow-up / message = a smaller capsule. Manual vs automation is always said. */
function Capsule(p: ObjProps) {
  const { e } = p
  const z = zoneFor(e, p.mode, p.tz)
  const w = e.contact_window
  const kindLabel = e.manual ? 'Scheduled by you' : e.type === 'seller_follow_up' && e.owner !== 'you' ? 'Follow-up automation' : e.type === 'pipeline_action' ? 'Deal action' : null
  const whenLine = e.all_day ? 'All day' : `${clock(e.start, z)} ${zoneAbbr(z)}`
  const windowLine = w && w.deferred && !e.history ? `due ${clock(e.start, w.tz)} · earliest send ${clock(w.earliest_at, w.tz)} ${w.abbr}` : null
  return frame(p, 'c3-capsule', (
    <>
      <span className="c3-capsule__time">{whenLine}</span>
      <span className="c3-capsule__dot" aria-hidden />
      <span className="c3-capsule__body">
        <span className="c3-capsule__head"><b>{e.title}</b>{e.subtitle ? <em>{e.subtitle}</em> : e.place ? <em>{e.place}</em> : null}</span>
        {(windowLine || kindLabel || (e.reason && (e.attention || e.history))) ? (
          <span className={cx('c3-capsule__sub', e.attention && 'is-attn')}>
            {e.attention || e.history ? humanReason(e.reason) : windowLine || kindLabel}
          </span>
        ) : null}
      </span>
      <OwnerTag owner={e.owner} manual={e.manual} />
      <StateTag e={e} />
    </>
  ), `${e.title} ${e.subtitle || ''}`)
}

/** A client-side slot group ("37 seller follow-ups · 8:00 AM") that opens to its members. */
export function GroupObject({ g, mode, tz, now, today, selectedId, onOpen }: { g: Extract<DeskItem, { group: true }>; mode: TzMode; tz: string; now: number; today: string; selectedId: string | null; onOpen: (e: DeskEvent) => void }) {
  const [open, setOpen] = useState(false)
  const z = mode === 'operator' ? tz : zoneFor(g.members[0], mode, tz)
  return (
    <div className={cx('c3-group', open && 'is-open')}>
      <button type="button" className={cx('c3-group__head', `t-${toneOf(g.members[0])}`)} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="c3-group__count">{g.count}</span>
        <span className="c3-group__title"><b>{g.title.replace(/^\d+ /, '').toUpperCase()}</b><em>{clock(g.start, z)} {zoneAbbr(z)}</em></span>
        <OwnerTag owner={g.owner} />
        <span className={cx('c3-state', `is-${g.state}`)}>{STATE_LABEL[g.state]}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} />
      </button>
      {open ? (
        <div className="c3-group__members">
          {g.members.map((m) => <EventObject key={m.id} e={m} mode={mode} tz={tz} now={now} today={today} compact selected={selectedId === m.id} onOpen={onOpen} />)}
        </div>
      ) : null}
    </div>
  )
}

export function ItemObject({ item, ...rest }: { item: DeskItem } & Omit<ObjProps, 'e'> & { selectedId: string | null; arrivedIds?: Set<string> }) {
  if (isGroup(item)) return <GroupObject g={item} mode={rest.mode} tz={rest.tz} now={rest.now} today={rest.today} selectedId={rest.selectedId} onOpen={rest.onOpen} />
  return <EventObject {...rest} e={item} selected={rest.selectedId === item.id} arrived={rest.arrivedIds?.has(item.id)} />
}

/* ── the inspector: a contextual brain per type ───────────────────────── */

export interface InspectorActions {
  go: (path: string, e?: DeskEvent) => void
  openMap: (e: DeskEvent) => void
  reschedule: (e: DeskEvent) => void
}

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return <section className="c3-insp__sec"><h4>{title}</h4>{children}</section>
}
function Spec({ rows }: { rows: Array<[string, ReactNode]> }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false)
  if (!shown.length) return null
  return <dl className="c3-spec">{shown.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
}

export function Inspector({ e, mode, tz, now, today, actions, onClose }: { e: DeskEvent; mode: TzMode; tz: string; now: number; today: string; actions: InspectorActions; onClose: () => void }) {
  const d = det(e)
  const z = zoneFor(e, 'event', tz)
  const t = timeText(e, mode, tz)
  const w = e.contact_window
  const links = e.links || {}
  const summary: Array<[string, ReactNode]> = []
  const activity: ReactNode[] = []
  if (e.type === 'campaign_window' || e.type === 'campaign_start' || e.type === 'campaign_sends') {
    summary.push(['Campaign', e.subtitle], ['Eligible', d.eligible?.toLocaleString()], ['Held', d.held?.toLocaleString()], ['Queued', d.scheduled?.toLocaleString()], ['Sent', d.sent?.toLocaleString()], ['Ready', d.remaining?.toLocaleString()])
    if (d.projected_days) summary.push(['Pace', `about ${d.daily_pace}/day · day ${d.day_index} of ${d.projected_days}`])
    if (d.counts) summary.push(['This day', Object.entries(d.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ')], ['Delivered', d.delivered || null], ['Next queued send', d.next_send_at ? `${clock(d.next_send_at, z)} ${zoneAbbr(z)}` : null])
    if (d.feeder) activity.push(<p key="f" className="c3-insp__line">Feeder: {feederWords(d.feeder)} at {clock(d.feeder.at || e.start, tz)} · {d.feeder.sent_today ?? '—'} sent today · {d.feeder.live_rows ?? '—'} rows queued{d.feeder.last_refill_at ? ` · last refill ${monthDay(dayKey(d.feeder.last_refill_at, tz))} ${clock(d.feeder.last_refill_at, tz)}` : ''}</p>)
    if (d.halted) activity.push(<p key="h" className="c3-insp__line is-attn">Sending is halted: {String(d.halted).replace(/_/g, ' ')}.</p>)
  } else if (e.type === 'closing' || e.lane === 'closing') {
    summary.push(['Property', e.place], ['Seller', e.subtitle], ['State', d.closing_state?.label], ['Buyer', d.buyer], ['Title', d.title_company])
    if (d.requirements?.length) activity.push(<ul key="r" className="c3-req">{d.requirements.map((r) => <li key={r.key} className={cx(r.met && 'is-met')}><i aria-hidden />{r.label}<span>{r.met ? 'Met' : 'Open'}</span></li>)}</ul>)
    if (d.blockers?.length) activity.push(<div key="b" className="c3-insp__blockers">{d.blockers.map((b, i) => <p key={i}><b>{b.what}</b>{b.why ? ` — ${b.why}` : ''}{b.ownerLabel ? <em> · {b.ownerLabel}</em> : null}</p>)}</div>)
  } else if (e.lane === 'workflow') {
    summary.push(['Workflow', `${d.workflow_name} · v${d.version ?? '?'}`], ['Waiting on', d.node_label], ['Run state', String(d.run_state || '').replace(/_/g, ' ')], ['Outcome', d.outcome ? String(d.outcome).replace(/_/g, ' ') : null])
    if (d.anchor_at) summary.push(['Timer started', `${monthDay(dayKey(d.anchor_at, tz))} ${clock(d.anchor_at, tz)} (triggering event)`])
    if (d.steps?.length) activity.push(<ol key="s" className="c3-steps">{d.steps.map((s, i) => <li key={i}><time>{clock(s.at, tz)}</time><span><b>{s.node.replace(/_/g, ' ')}</b> {s.kind} · {s.status}{s.exit ? ` → ${s.exit}` : ''}</span></li>)}</ol>)
  } else if (d.members?.length) {
    activity.push(<div key="m" className="c3-members">{d.members.slice(0, 30).map((m) => <div key={m.id}><time>{clock(m.start, tz)}</time><b>{m.subtitle || m.title || 'Seller'}</b><em>{humanReason(m.reason)}</em></div>)}</div>)
  } else {
    summary.push(['Seller', e.subtitle], ['Property', e.place], ['Stage', d.stage ? String(d.stage).replace(/_/g, ' ') : null], ['Bucket', d.bucket ? String(d.bucket).replace(/_/g, ' ') : null], ['Planned by', d.scheduled_by], ['Reason', d.followup_reason], ['Cancelled by', d.cancelled_by ? String(d.cancelled_by).replace(/_/g, ' ') : null])
    if (d.outcome_at) activity.push(<p key="o" className="c3-insp__line">{e.reason}</p>)
  }
  const edit = e.editable
  const primary = e.deep_link
  const secondary: Array<{ label: string; icon: IconName; run: () => void }> = []
  if (links.thread_key && primary?.app !== 'inbox') secondary.push({ label: 'Conversation', icon: 'message', run: () => actions.go(`/inbox?thread=${encodeURIComponent(links.thread_key as string)}`, e) })
  if (links.opportunity_id && primary?.app !== 'pipeline') secondary.push({ label: 'Pipeline', icon: 'activity', run: () => actions.go(`/pipeline?opp=${encodeURIComponent(links.opportunity_id as string)}`, e) })
  if (links.closing_case_id && primary?.app !== 'closing') secondary.push({ label: 'Closing Desk', icon: 'key' as IconName, run: () => actions.go(`/closing-desk?case=${encodeURIComponent(links.closing_case_id as string)}`, e) })
  if (links.property_id) {
    secondary.push({ label: 'Map', icon: 'map', run: () => actions.openMap(e) })
    secondary.push({ label: 'Entity Graph', icon: 'users', run: () => actions.go(`/entity-graph/property/${encodeURIComponent(links.property_id as string)}`, e) })
  }
  if (e.lane === 'automation' && links.queue_id) secondary.push({ label: 'Queue', icon: 'layers', run: () => actions.go('/queue', e) })
  const chips: Array<[string, string]> = [
    ['Thread', links.thread_key as string], ['Deal', links.opportunity_id as string], ['Property', links.property_id as string], ['Campaign', links.campaign_id as string],
    ['Closing case', links.closing_case_id as string], ['Workflow run', links.run_id as string], ['Queue row', links.queue_id as string],
  ].filter(([, v]) => Boolean(v)) as Array<[string, string]>
  return (
    <div className={cx('c3-insp__card', `t-${toneOf(e)}`)} role="region" aria-label={`${e.title} details`}>
      <header className="c3-insp__head">
        <span className="c3-insp__glyph" aria-hidden><Icon name={iconFor(e)} /></span>
        <div>
          <span className="c3-insp__eyebrow">{e.app === 'workflow' ? 'Workflow Studio' : e.app === 'campaigns' ? 'Campaign Command' : e.app === 'closing' ? 'Closing Desk' : e.app === 'pipeline' ? 'Pipeline' : e.app === 'email' ? 'Email' : 'Inbox'} · {e.kind}</span>
          <h3>{e.type === 'campaign_window' ? campaignParts(e.subtitle).head : e.title}</h3>
          {e.subtitle && e.type !== 'campaign_window' ? <p>{e.subtitle}</p> : e.type === 'campaign_window' ? <p>Send window{campaignParts(e.subtitle).tail ? ` · ${campaignParts(e.subtitle).tail}` : ''}</p> : null}
        </div>
        <button type="button" className="c3-icon" onClick={onClose} aria-label="Close inspector (Esc)"><Icon name="close" /></button>
      </header>
      <div className="c3-insp__tags">
        <StateTag e={e} />
        <OwnerTag owner={e.owner} manual={e.manual} />
        <span className={cx('c3-edit', `is-${edit.mode}`)}>{EDIT_LABEL[edit.mode]}</span>
        {countdown(e, today) ? <span className="c3-count">{countdown(e, today)}</span> : null}
      </div>

      <Sec title="Time">
        <div className="c3-insp__when">
          <b>{e.undated ? 'No date on record' : e.all_day ? (e.date ? longDay(e.date) : '—') : t.main}</b>
          <span>{e.undated ? 'Nothing in the source record carries a date.' : e.all_day ? 'Date-only — no clock time is recorded, none is invented' : `${longDay(dayKey(e.start, z))}${t.alt ? ` · ${t.alt}` : ''}`}</span>
        </div>
        {w ? (
          <p className={cx('c3-insp__line', w.deferred && 'is-note')}>
            Seller's window {w.window} {w.abbr} · planned {clock(e.start, w.tz)} {w.planned_within ? 'is inside it' : 'is outside it'}{w.deferred ? ` · earliest send ${clock(w.earliest_at, w.tz)} ${w.abbr}${dayKey(w.earliest_at, w.tz) !== dayKey(e.start, w.tz) ? ` (${monthDay(dayKey(w.earliest_at, w.tz))})` : ''}` : ''}
          </p>
        ) : null}
        <p className="c3-insp__prov">Scheduled by {e.provenance.scheduled_by}. {e.provenance.timezone_basis}{e.provenance.timezone ? ` (${e.provenance.timezone})` : ''}.{e.provenance.policy ? ` Policy ${e.provenance.policy}.` : ''}</p>
      </Sec>

      {e.why ? <Sec title="Why is this on my calendar?"><p className="c3-insp__why">{e.why}</p></Sec> : null}

      <Sec title="Owner">
        <p className="c3-insp__line"><b>{e.manual && e.owner === 'system' ? 'You scheduled it · the system sends it' : OWNER_LABEL[e.owner]}</b>{e.next ? ` — ${e.next}` : ''}</p>
        {e.reason && (e.attention || e.history) ? <p className={cx('c3-insp__line', e.attention && 'is-attn')}>{humanReason(e.reason)}</p> : null}
      </Sec>

      {summary.some(([, v]) => v !== null && v !== undefined && v !== '') ? <Sec title="Summary"><Spec rows={summary} /></Sec> : null}
      {e.lane !== 'workflow' && (e.owner === 'system' || e.manual) ? (
        <Sec title="Automation">
          <Spec rows={[
            ['Planned by', e.provenance.scheduled_by],
            ['Basis', e.provenance.basis ? String(e.provenance.basis).replace(/_/g, ' ') : null],
            ['Policy', e.provenance.policy || null],
            ['Dispatch', e.lane === 'campaign' ? 'The queue sends inside the campaign window, paced and refilled by the feeder'
              : e.type === 'seller_follow_up' ? 'The queue sends inside the seller\'s contact window; a seller reply first cancels it'
                : e.type === 'scheduled_message' ? 'The queue sends at this time, inside the seller\'s contact window'
                  : e.type === 'email_scheduled' ? 'The email dispatcher — only while sending is on' : null],
          ]} />
        </Sec>
      ) : null}
      {activity.length ? <Sec title={e.lane === 'workflow' ? 'Automation · run steps' : e.lane === 'closing' ? 'Ready to close' : e.kind === 'group' ? 'Members' : 'Activity'}>{activity}</Sec> : null}

      {chips.length ? (
        <Sec title="Linked records">
          <div className="c3-chips">{chips.map(([k, v]) => <span key={k} className="c3-chip"><small>{k}</small>{v.length > 22 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v}</span>)}</div>
        </Sec>
      ) : null}

      <Sec title="Actions">
        <div className="c3-insp__acts">
          {primary ? <button type="button" className="c3-btn is-primary" onClick={() => actions.go(primary.path, e)}><Icon name="arrow-up-right" />{primary.label}</button> : null}
          {edit.mode !== 'read_only' && !e.history ? <button type="button" className="c3-btn" onClick={() => actions.reschedule(e)}><Icon name="clock" />Reschedule…</button> : null}
          {secondary.map((s) => <button key={s.label} type="button" className="c3-btn is-quiet" onClick={s.run}><Icon name={s.icon} />{s.label}</button>)}
        </div>
        <p className="c3-insp__prov">{edit.how}</p>
      </Sec>
      <p className="c3-insp__src">Source · {e.source}{e.source_id ? ` · ${e.source_id.length > 28 ? `${e.source_id.slice(0, 12)}…` : e.source_id}` : ''}{e.updated_at ? ` · updated ${monthDay(dayKey(e.updated_at, tz))} ${clock(e.updated_at, tz)}` : ''}</p>
      {void now}
    </div>
  )
}

/** The day brief — what the inspector says when nothing is selected. */
export function DayBrief({ data, day, tz, now, onOpen }: { data: DeskTimeline; day: string; tz: string; now: number; onOpen: (id: string) => void }) {
  const t = data.telemetry
  const failed = Object.entries(data.source_status || {}).filter(([, s]) => s === 'failed').map(([k]) => k.replace(/_/g, ' '))
  const sys = data.system
  const isToday = day === data.range.today
  const top = data.attention.slice().sort((a, b) => (Date.parse(b.start || '') || 0) - (Date.parse(a.start || '') || 0)).slice(0, 4)
  return (
    <div className="c3-insp__card is-brief">
      <header className="c3-insp__head">
        <span className="c3-insp__glyph" aria-hidden><Icon name="calendar" /></span>
        <div><span className="c3-insp__eyebrow">{isToday ? 'Today' : 'Selected day'} · brief</span><h3>{longDay(day)}</h3><p>Select anything on the calendar to see its provenance.</p></div>
      </header>
      {isToday ? (
        <Sec title="Right now">
          {t.live.length ? t.live.map((l) => <button key={l.id} type="button" className="c3-brief__row" onClick={() => onOpen(l.id)}><i className="is-live" aria-hidden /><span><b>{l.subtitle || l.title}</b><em>{l.title} · until {clock(l.end || l.start, tz)}</em></span></button>) : <p className="c3-insp__line">Nothing is running right now.</p>}
          {t.next_system ? <button type="button" className="c3-brief__row" onClick={() => onOpen(t.next_system!.id)}><i aria-hidden /><span><b>Next system action · {clock(t.next_system.at, tz)}</b><em>{t.next_system.title}{t.next_system.subtitle ? ` · ${t.next_system.subtitle}` : ''}</em></span></button> : <p className="c3-insp__line">No further system action is scheduled today.</p>}
        </Sec>
      ) : null}
      <Sec title="Who is doing what">
        <Spec rows={[['Today, open', `${t.today.total}`], ['System', `${t.today.system}`], ['You', `${t.today.you}`], ['External', `${t.today.external}`], ['Attention', `${t.attention.total}`]]} />
      </Sec>
      {top.length ? (
        <Sec title="Needs attention">
          {top.map((e) => <button key={e.id} type="button" className="c3-brief__row" onClick={() => onOpen(e.id)}><i className="is-attn" aria-hidden /><span><b>{e.title}{e.subtitle ? ` · ${e.subtitle}` : ''}</b><em>{humanReason(e.reason)}</em></span></button>)}
        </Sec>
      ) : null}
      <Sec title="Switches on record">
        <Spec rows={[
          ['Queue processor', sys.emergency_stop ? 'Emergency stop' : sys.processor],
          ['Execution mode', sys.execution_mode],
          ['Workflow orchestrator', sys.workflow_orchestrator ? `On${sys.workflow_heartbeat_at ? ` · beat ${clock(sys.workflow_heartbeat_at, tz)}` : ''}` : 'Off'],
          ['Email sending', sys.email_sending ? 'On' : 'Off — emails wait in the outbox'],
          ['Contact window', `${sys.contact_window.start}–${sys.contact_window.end} seller-local`],
        ]} />
      </Sec>
      <p className={cx('c3-insp__src', failed.length && 'is-attn')}>{failed.length ? `Some calendar data unavailable: ${failed.join(', ')}` : `All ${Object.keys(data.source_status || {}).length} sources read · as of ${clock(data.range.now, tz)}`}</p>
      {void now}
    </div>
  )
}
