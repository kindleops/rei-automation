import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../../../shared/icons'
import {
  ACTOR_LABEL, APP_LABEL, KIND_LABEL, addDays, zoneAbbr, clock, dayNum, eventDay, humanReason, shortDate, timeLabel, weekdayShort,
  type CalEvent, type CalMember,
} from '../../../domain/calendar/calendar-timeline-api'

export const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/** Semantic accent: communication aqua, automation cobalt, deals violet, closings gold. */
export function tone(e: CalEvent): string {
  if (e.attention && (e.overdue || e.actor === 'blocked' || e.status === 'held' || e.status === 'missed')) return 'bad'
  if (e.actor === 'completed') return 'done'
  if (e.type === 'closing' || e.type === 'closing_milestone') return 'gold'
  if (e.type === 'pipeline_action' || e.type === 'offer') return 'violet'
  if (e.type.startsWith('campaign')) return 'cobalt'
  return 'aqua'
}

const ICON: Record<string, IconName> = {
  campaign_sends: 'send', campaign_start: 'zap', campaign_window: 'clock', scheduled_message: 'message',
  scheduled_message_group: 'layers', seller_follow_up: 'user', pipeline_action: 'activity', offer: 'file-text',
  closing: 'key', closing_milestone: 'flag',
}

export function ActorPill({ e }: { e: CalEvent }) {
  const label = e.status === 'not_acted' ? 'Automation' : e.status === 'held' ? 'Held' : e.status === 'missed' ? 'Missed' : ACTOR_LABEL[e.actor]
  return <span className={cls('cal2-pill', `is-${e.actor}`, e.overdue && 'is-overdue')}>{label}</span>
}

export function EventCard({ e, tz, past, onOpen, compact = false }: { e: CalEvent; tz: string; past?: boolean; onOpen: () => void; compact?: boolean }) {
  const t = timeLabel(e, tz)
  return (
    <button type="button" className={cls('cal2-card', `t-${tone(e)}`, past && 'is-past', e.attention && 'is-attn', compact && 'is-compact')} onClick={onOpen}>
      <span className="cal2-card__accent" aria-hidden="true" />
      <span className="cal2-card__icon" aria-hidden="true"><Icon name={ICON[e.type] || 'calendar'} /></span>
      <span className="cal2-card__body">
        <span className="cal2-card__top">
          <b className="cal2-card__title">{e.title}</b>
          <ActorPill e={e} />
        </span>
        {e.subtitle ? <span className="cal2-card__sub">{e.subtitle}</span> : null}
        {e.place ? <span className="cal2-card__place">{e.place}</span> : null}
        {!compact && (e.reason || t.alt) ? (
          <span className={cls('cal2-card__why', e.attention && 'is-bad')}>
            {e.attention && e.reason ? humanReason(e.reason) : t.alt || (e.type === 'campaign_window' ? e.reason : null)}
          </span>
        ) : null}
      </span>
    </button>
  )
}

/* ── day strip ── */
export function DayStrip({ days, selected, today, marks, onPick }: {
  days: string[]; selected: string; today: string
  marks: Map<string, { operator: boolean; system: boolean; closing: boolean; attention: boolean }>
  onPick: (d: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('.is-selected')
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [selected])
  return (
    <div className="cal2-strip" ref={ref} role="tablist" aria-label="Days">
      {days.map((d) => {
        const m = marks.get(d)
        return (
          <button key={d} type="button" role="tab" aria-selected={d === selected} className={cls('cal2-strip__day', d === selected && 'is-selected', d === today && 'is-today')} onClick={() => onPick(d)}>
            <span className="cal2-strip__wd">{d === today ? 'Today' : weekdayShort(d)}</span>
            <b className="cal2-strip__n">{dayNum(d)}</b>
            <span className="cal2-strip__dots" aria-hidden="true">
              {m?.attention ? <i className="d-bad" /> : null}
              {m?.closing ? <i className="d-gold" /> : null}
              {m?.operator ? <i className="d-violet" /> : null}
              {m?.system ? <i className="d-cobalt" /> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ── the day's timeline: all-day band, time rail, NOW ── */
export function DayTimeline({ events, tz, isToday, now, onOpen }: { events: CalEvent[]; tz: string; isToday: boolean; now: number; onOpen: (e: CalEvent) => void }) {
  const allDay = events.filter((e) => e.all_day)
  const windows = events.filter((e) => e.type === 'campaign_window')
  const timed = events.filter((e) => !e.all_day && e.type !== 'campaign_window')
  const nowIndex = isToday ? timed.findIndex((e) => Date.parse(e.start) >= now) : -1
  const nowAt = isToday ? (nowIndex === -1 ? timed.length : nowIndex) : -1
  return (
    <div className="cal2-day">
      {allDay.length || windows.length ? (
        <div className="cal2-band">
          {allDay.map((e) => <EventCard key={e.id} e={e} tz={tz} onOpen={() => onOpen(e)} compact />)}
          {windows.map((e) => <WindowBar key={e.id} e={e} tz={tz} now={now} onOpen={() => onOpen(e)} />)}
        </div>
      ) : null}
      <ol className="cal2-rail">
        {timed.map((e, i) => (
          <Fragment key={e.id}>
            {i === nowAt ? <NowMarker now={now} tz={tz} /> : null}
            <li className={cls('cal2-slot', isToday && i < nowAt && 'is-past')} style={{ ['--i' as string]: Math.min(i, 12) }}>
              <time className="cal2-slot__time">
                <b>{clock(e.start, tz).replace(/\s?(AM|PM)$/, '')}</b>
                <small>{clock(e.start, tz).match(/(AM|PM)$/)?.[0]}</small>
              </time>
              <span className="cal2-slot__node" aria-hidden="true" />
              <EventCard e={e} tz={tz} past={isToday && i < nowAt} onOpen={() => onOpen(e)} />
            </li>
          </Fragment>
        ))}
        {nowAt === timed.length && timed.length > 0 ? <NowMarker now={now} tz={tz} /> : null}
      </ol>
    </div>
  )
}

function NowMarker({ now, tz }: { now: number; tz: string }) {
  return (
    <li className="cal2-now" aria-label={`Now, ${clock(now, tz)}`}>
      <span className="cal2-now__label">Now · {clock(now, tz)}</span>
      <span className="cal2-now__line" aria-hidden="true" />
    </li>
  )
}

/** A send window is a span, drawn as one — never as the messages inside it. */
function WindowBar({ e, tz, now, onOpen }: { e: CalEvent; tz: string; now: number; onOpen: () => void }) {
  const t = timeLabel(e, tz)
  const s = Date.parse(e.start)
  const end = Date.parse(e.end || e.start)
  const pct = now <= s ? 0 : now >= end ? 100 : ((now - s) / (end - s)) * 100
  const d = e.detail as { remaining?: number; day_index?: number; projected_days?: number; daily_pace?: number }
  return (
    <button type="button" className={cls('cal2-window', e.status === 'open' && 'is-open', e.time_kind === 'expected' && 'is-expected')} onClick={onOpen}>
      <span className="cal2-window__top">
        <b>{e.subtitle}</b>
        <span>{e.status === 'open' ? 'Sending now' : e.time_kind === 'expected' ? 'Expected' : 'Send window'}</span>
      </span>
      <span className="cal2-window__time">{t.main}{t.alt ? <em> · {t.alt}</em> : null}</span>
      <span className="cal2-window__track" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
      {d.projected_days ? <span className="cal2-window__meta">Day {d.day_index} of ~{d.projected_days} · about {d.daily_pace}/day</span> : null}
    </button>
  )
}

/* ── week: vertical, one row per day ── */
export function WeekList({ days, byDay, today, onPick }: { days: string[]; byDay: Map<string, CalEvent[]>; today: string; onPick: (d: string) => void }) {
  return (
    <div className="cal2-week">
      {days.map((d) => {
        const list = byDay.get(d) || []
        const you = list.filter((e) => e.actor === 'operator').length
        const sys = list.filter((e) => e.actor === 'system').length
        const attn = list.filter((e) => e.attention).length
        const top = list.filter((e) => e.type !== 'campaign_window').slice(0, 2)
        return (
          <button key={d} type="button" className={cls('cal2-week__row', d === today && 'is-today', !list.length && 'is-empty')} onClick={() => onPick(d)}>
            <span className="cal2-week__date"><small>{weekdayShort(d)}</small><b>{dayNum(d)}</b></span>
            <span className="cal2-week__body">
              <span className="cal2-week__counts">
                {list.length ? <>{list.length} item{list.length === 1 ? '' : 's'}{you ? <em className="is-you"> · {you} you</em> : null}{sys ? <em> · {sys} system</em> : null}{attn ? <em className="is-bad"> · {attn} attention</em> : null}</> : 'Clear'}
              </span>
              {top.map((e) => <span key={e.id} className="cal2-week__item"><i className={`t-${tone(e)}`} />{e.title}{e.subtitle ? ` · ${e.subtitle}` : ''}</span>)}
            </span>
            <Icon name="chevron-right" />
          </button>
        )
      })}
    </div>
  )
}

/* ── month: navigation, dots only ── */
export function MonthGrid({ month, selected, today, marks, onPick, onShift }: {
  month: string; selected: string; today: string
  marks: Map<string, { operator: boolean; system: boolean; closing: boolean; attention: boolean }>
  onPick: (d: string) => void; onShift: (n: number) => void
}) {
  const first = `${month.slice(0, 7)}-01`
  const lead = new Date(`${first}T12:00:00Z`).getUTCDay()
  const cells: Array<string | null> = Array.from({ length: lead }, () => null)
  for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = addDays(d, 1)) cells.push(d)
  return (
    <div className="cal2-month">
      <div className="cal2-month__head">
        <button type="button" className="cal2-icon-btn" onClick={() => onShift(-1)} aria-label="Previous month"><Icon name="chevron-left" /></button>
        <b>{new Date(`${first}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</b>
        <button type="button" className="cal2-icon-btn" onClick={() => onShift(1)} aria-label="Next month"><Icon name="chevron-right" /></button>
      </div>
      <div className="cal2-month__wd">{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => <span key={i}>{w}</span>)}</div>
      <div className="cal2-month__grid">
        {cells.map((d, i) => {
          if (!d) return <span key={`x${i}`} />
          const m = marks.get(d)
          return (
            <button key={d} type="button" className={cls('cal2-month__cell', d === selected && 'is-selected', d === today && 'is-today', d < today && 'is-past')} onClick={() => onPick(d)} aria-label={shortDate(d)}>
              <b>{dayNum(d)}</b>
              <span className="cal2-strip__dots" aria-hidden="true">
                {m?.attention ? <i className="d-bad" /> : null}
                {m?.closing ? <i className="d-gold" /> : null}
                {m?.operator ? <i className="d-violet" /> : null}
                {m?.system ? <i className="d-cobalt" /> : null}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ── attention: the time-based work queue ── */
const ATTN_GROUPS: Array<{ key: string; label: string; test: (e: CalEvent) => boolean }> = [
  { key: 'you', label: 'Waiting on you', test: (e) => e.actor === 'operator' && e.overdue },
  { key: 'missed', label: 'Missed starts & held sends', test: (e) => e.status === 'missed' || e.status === 'held' },
  { key: 'deadline', label: 'Deadlines passed', test: (e) => (e.type === 'closing' || e.type === 'closing_milestone') && e.overdue },
  { key: 'automation', label: 'Automation hasn’t acted', test: (e) => e.status === 'not_acted' || (e.actor === 'system' && e.overdue) },
  { key: 'blocked', label: 'Sends that did not go out', test: (e) => e.actor === 'blocked' || e.status === 'blocked' || e.status === 'past_due' },
]

export function AttentionList({ events, tz, onOpen }: { events: CalEvent[]; tz: string; onOpen: (e: CalEvent) => void }) {
  const seen = new Set<string>()
  const groups = ATTN_GROUPS.map((g) => {
    const list = events.filter((e) => !seen.has(e.id) && g.test(e))
    list.forEach((e) => seen.add(e.id))
    return { ...g, list }
  }).filter((g) => g.list.length)
  const rest = events.filter((e) => !seen.has(e.id))
  if (rest.length) groups.push({ key: 'other', label: 'Other', test: () => true, list: rest })
  if (!groups.length) {
    return (
      <div className="cal2-clear">
        <span className="cal2-clear__orb" aria-hidden="true"><Icon name="check" /></span>
        <b>Nothing needs attention</b>
        <p>No overdue work, missed starts or failed sends.</p>
      </div>
    )
  }
  return (
    <div className="cal2-attn">
      {groups.map((g) => (
        <section key={g.key} className="cal2-attn__group">
          <h4>{g.label}<span>{g.list.reduce((a, e) => a + (e.count || 1), 0)}</span></h4>
          {g.list.map((e) => (
            <div key={e.id} className="cal2-attn__row">
              <time>{e.all_day ? shortDate(eventDay(e, tz)) : `${shortDate(eventDay(e, tz))} · ${clock(e.start, e.tz || tz)}`}</time>
              <EventCard e={e} tz={tz} onOpen={() => onOpen(e)} />
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

/* ── detail sheet ── */
export interface SheetActions {
  conversation?: (threadKey: string, propertyId?: string | null) => void
  pipeline?: (opportunityId: string) => void
  campaign?: (campaignId: string) => void
  closing?: () => void
  graph?: (propertyId: string) => void
}

export function EventSheet({ e, tz, theme, actions, onClose }: { e: CalEvent; tz: string; theme: string; actions: SheetActions; onClose: () => void }) {
  const t = timeLabel(e, tz)
  const d = e.detail || {}
  const stats: Array<[string, unknown]> = e.type.startsWith('campaign')
    ? [['Eligible', d.eligible], ['Held', d.held], ['Scheduled', d.scheduled], ['Sent', d.sent], ['Remaining', d.remaining], ['Window', d.window ? `${d.window}${typeof d.tz === 'string' ? ` · ${zoneAbbr(d.tz)}` : ''}` : null], ['Pace', d.daily_pace ? `about ${d.daily_pace}/day` : null]]
    : e.type === 'closing' || e.type === 'closing_milestone'
      ? [['Closing status', d.closing_status], ['Stage', d.substage], ['Title', d.title_status], ['Escrow', d.escrow_status], ['Title company', d.title_company]]
      : [['Stage', d.stage], ['Market', d.market], ['Next action', d.next_action ? humanReason(String(d.next_action)) : null]]
  const counts = d.counts as Record<string, number> | undefined
  const members = (d.members || []) as CalMember[]
  const act: ReactNode[] = []
  if (e.links.thread_key && actions.conversation) act.push(<button key="c" type="button" className="cal2-act is-primary" onClick={() => actions.conversation!(e.links.thread_key as string, e.links.property_id)}><Icon name="message" />Open conversation</button>)
  if (e.links.campaign_id && actions.campaign) act.push(<button key="k" type="button" className="cal2-act is-primary" onClick={() => actions.campaign!(e.links.campaign_id as string)}><Icon name="send" />Open campaign</button>)
  if (e.links.closing_case_id && actions.closing) act.push(<button key="d" type="button" className="cal2-act is-primary" onClick={actions.closing}><Icon name="key" />Open Closing Desk</button>)
  if (e.links.opportunity_id && actions.pipeline) act.push(<button key="p" type="button" className="cal2-act" onClick={() => actions.pipeline!(e.links.opportunity_id as string)}><Icon name="activity" />Open in Pipeline</button>)
  if (e.links.property_id && actions.graph) act.push(<button key="g" type="button" className="cal2-act" onClick={() => actions.graph!(e.links.property_id as string)}><Icon name="users" />View relationships</button>)
  return createPortal(
    <div className="cal2-sheet" data-theme={theme} role="dialog" aria-label={e.title}>
      <button type="button" className="cal2-sheet__scrim" aria-label="Close" onClick={onClose} />
      <div className={cls('cal2-sheet__panel', `t-${tone(e)}`)}>
        <div className="cal2-sheet__grab" />
        <div className="cal2-sheet__head">
          <div>
            <span className="cal2-eyebrow"><i />{APP_LABEL[e.app]} · {e.actor === 'blocked' ? 'Did not go out' : e.status === 'missed' ? 'Missed' : KIND_LABEL[e.time_kind]}</span>
            <h3>{e.title}</h3>
            {e.subtitle ? <p className="cal2-sheet__sub">{e.subtitle}</p> : null}
          </div>
          <button type="button" className="cal2-icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        <div className="cal2-sheet__when">
          <b>{e.all_day ? shortDate(eventDay(e, tz)) : t.main}</b>
          <span>{e.all_day ? (e.time_kind === 'due' ? 'Due that day — no time was recorded' : 'All day') : `${shortDate(eventDay(e, tz))}${t.alt ? ` · ${t.alt}` : ''}`}</span>
          <ActorPill e={e} />
        </div>
        {e.place ? <div className="cal2-sheet__place"><Icon name="pin" />{e.place}</div> : null}
        {e.reason ? (
          <div className={cls('cal2-sheet__why', e.attention && 'is-bad')}>
            <small>{e.attention ? 'Why this needs attention' : 'What happens'}</small>
            <p>{humanReason(e.reason)}</p>
          </div>
        ) : null}
        {counts ? (
          <div className="cal2-sheet__stats">
            {Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => <div key={k}><b>{n}</b><span>{k}</span></div>)}
          </div>
        ) : null}
        {stats.some(([, v]) => v !== null && v !== undefined && v !== '') ? (
          <dl className="cal2-sheet__rows">
            {stats.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{typeof v === 'number' ? v.toLocaleString() : humanReason(String(v))}</dd></Fragment>)}
          </dl>
        ) : null}
        {members.length ? (
          <div className="cal2-sheet__members">
            <small>{e.count} messages{members.length < e.count ? ` · first ${members.length}` : ''}</small>
            {members.map((m) => (
              <button key={m.id} type="button" className="cal2-member" disabled={!m.thread_key || !actions.conversation} onClick={() => m.thread_key && actions.conversation?.(m.thread_key)}>
                <time>{clock(m.start, tz)}</time>
                <span><b>{m.subtitle || 'Seller'}</b>{m.reason ? <em>{humanReason(m.reason)}</em> : null}</span>
                {m.thread_key ? <Icon name="chevron-right" /> : null}
              </button>
            ))}
          </div>
        ) : null}
        {act.length ? <div className="cal2-sheet__acts">{act}</div> : null}
        <p className="cal2-sheet__prov">Source · {e.source}</p>
      </div>
    </div>,
    document.body,
  )
}
