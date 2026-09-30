import { useMemo, useState, type ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import type { DeskEvent, DeskTimeline } from '../../../domain/calendar/calendar-timeline-api'
import { humanReason } from '../../../domain/calendar/calendar-timeline-api'
import {
  addDays, aggLine, attentionSections, clock, dayKey, dayNum, eventDay, groupSlots, hourHeat, hourLabel, isGroup, localMinutes, longDay,
  monthCells, monthDay, monthTitle, nowWindow, todayModel, timelineDays, weekday, weekGrid, weeksAhead, workloadSplit, zoneAbbr,
  type DeskItem, type TzMode,
} from './desk-model'
import { EventObject, ItemObject, OwnerTag, StateTag, cx, iconFor, toneOf } from './DeskParts'

export interface ViewProps {
  data: DeskTimeline
  events: DeskEvent[]
  day: string
  mode: TzMode
  tz: string
  now: number
  selectedId: string | null
  arrivedIds: Set<string>
  showHistory: boolean
  onOpen: (e: DeskEvent) => void
  onPickDay: (d: string, view?: 'today' | 'week') => void
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function Plane({ title, meta, children, quiet, className }: { title: string; meta?: ReactNode; children: ReactNode; quiet?: boolean; className?: string }) {
  return (
    <section className={cx('c3-plane', quiet && 'is-quiet', className)}>
      <header className="c3-plane__head"><h3>{title}</h3>{meta ? <span>{meta}</span> : null}</header>
      <div className="c3-plane__body">{children}</div>
    </section>
  )
}
function Calm({ children }: { children: ReactNode }) {
  return <p className="c3-calm">{children}</p>
}

function list(items: DeskItem[], p: ViewProps, opts: { past?: boolean; compact?: boolean } = {}) {
  return items.map((it) => (
    <ItemObject key={it.id} item={it} mode={p.mode} tz={p.tz} now={p.now} today={p.data.range.today} selectedId={p.selectedId} arrivedIds={p.arrivedIds}
      past={opts.past} compact={opts.compact} onOpen={p.onOpen} />
  ))
}

/* ══ TODAY ═════════════════════════════════════════════════════════════ */
export function TodayView(p: ViewProps) {
  const { day, now, tz, data } = p
  const isToday = day === data.range.today
  const dayIsPast = day < data.range.today
  // A future day is all ahead; a past day is all behind; today splits at NOW.
  const m = useMemo(() => todayModel(p.events, { day, now: day > data.range.today ? Date.parse(`${addDays(day, -1)}T00:00:00Z`) : now, tz }), [p.events, day, now, tz, data.range.today])
  const tomorrow = addDays(day, 1)
  const tm = useMemo(() => todayModel(p.events, { day: tomorrow, now, tz }), [p.events, tomorrow, now, tz])
  const tel = data.telemetry
  const nextSys = isToday && tel.next_system ? p.events.find((e) => e.id === tel.next_system!.id) || null : null
  const windowsLive = m.windows.filter((w) => w.state === 'live').length
  const sends = m.windows.length ? p.events.filter((e) => e.type === 'campaign_sends' && eventDay(e, tz) === day).reduce((a, e) => a + (e.count || 0), 0) : 0
  const spec = [
    plural(m.windows.length, 'campaign window') + (windowsLive ? ` · ${windowsLive} live` : ''),
    sends ? `${sends.toLocaleString()} campaign texts` : null,
    plural(m.needsYou.length, 'item') + ' yours',
    m.deadlines.filter((e) => eventDay(e, tz) === day).length ? plural(m.deadlines.filter((e) => eventDay(e, tz) === day).length, 'deadline') : null,
  ].filter(Boolean)
  const tomorrowSpec = [
    tm.windows.length ? plural(tm.windows.length, 'window') : null,
    tm.needsYou.length ? `${tm.needsYou.length} yours` : null,
    tm.automated.length ? `${tm.automated.length} automated` : null,
    tm.deadlines.filter((e) => eventDay(e, tz) === tomorrow).length ? plural(tm.deadlines.filter((e) => eventDay(e, tz) === tomorrow).length, 'deadline') : null,
  ].filter(Boolean)
  const past = p.showHistory ? [...m.earlier, ...m.history].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)) : m.earlier
  return (
    <div className="c3-today">
      <div className="c3-today__main">
        <div className="c3-dayhead">
          <div>
            <span className="c3-eyebrow">{isToday ? 'Today' : day === tomorrow ? 'Tomorrow' : weekday(day, 'long')}</span>
            <h2>{longDay(day)}</h2>
            <p className="c3-specline">{spec.join(' · ')}</p>
          </div>
          {isToday ? <span className="c3-nowchip" aria-live="polite"><i aria-hidden />Now · {clock(now, tz)} {zoneAbbr(tz)}</span> : null}
        </div>

        {m.windows.length ? (
          <div className="c3-stack">
            {m.windows.map((w) => <EventObject key={w.id} e={w} mode={p.mode} tz={tz} now={now} today={data.range.today} selected={p.selectedId === w.id} arrived={p.arrivedIds.has(w.id)} onOpen={p.onOpen} />)}
          </div>
        ) : null}

        {isToday ? (
          <Plane title="Next system action" meta={nextSys ? `${clock(tel.next_system!.at, tz)} ${zoneAbbr(tz)}` : null} className="is-nsa">
            {nextSys ? <EventObject e={nextSys} mode={p.mode} tz={tz} now={now} today={data.range.today} selected={p.selectedId === nextSys.id} onOpen={p.onOpen} />
              : <Calm>No further system action is scheduled today{tel.live.length ? ' — the live windows keep sending as the queue runs' : ''}.</Calm>}
          </Plane>
        ) : null}

        {!dayIsPast ? (
          <Plane title={isToday ? 'Next' : 'Scheduled'} meta={m.next.length ? `${m.next.length + m.later.length} ahead` : null}>
            {m.next.length ? list(groupSlots([...m.next, ...m.later], tz), p) : <Calm>{isToday ? 'Nothing else is scheduled for the rest of today.' : 'Nothing is scheduled on this day.'}</Calm>}
          </Plane>
        ) : null}

        {past.length || dayIsPast ? (
          <Plane title={isToday ? 'Earlier today' : dayIsPast ? 'On this day' : 'Earlier'} meta={p.showHistory && m.history.length ? `${m.history.length} completed or closed` : null} quiet={!dayIsPast}>
            {past.length ? null : <Calm>Nothing was on record for this day.</Calm>}
            {list(groupSlots(past, tz), p, { past: true, compact: true })}
          </Plane>
        ) : null}

        <button type="button" className="c3-tomorrow" onClick={() => p.onPickDay(tomorrow)}>
          <span className="c3-eyebrow">{day === data.range.today ? 'Tomorrow' : weekday(tomorrow, 'long')}</span>
          <b>{longDay(tomorrow)}</b>
          <span>{tomorrowSpec.length ? tomorrowSpec.join(' · ') : 'Nothing scheduled yet'}</span>
          <Icon name="chevron-right" />
        </button>
      </div>

      <aside className="c3-today__side">
        <Plane title="Needs you" meta={m.needsYou.length || null}>
          {m.needsYou.length ? list(m.needsYou, p, { compact: true }) : <Calm>Nothing on this day needs you.</Calm>}
        </Plane>
        <Plane title="Waiting external" meta={m.waiting.length || null} quiet>
          {m.waiting.length ? list(m.waiting, p, { compact: true }) : <Calm>No seller, buyer or title waits on this day.</Calm>}
        </Plane>
        <Plane title="Automated" meta={m.automated.length ? `${m.automated.length} · system handling` : null} quiet>
          {m.automated.length ? list(groupSlots(m.automated, tz), p, { compact: true }) : <Calm>No automated sends or timers on this day.</Calm>}
        </Plane>
        <Plane title="Closing & deal deadlines" meta="next 14 days">
          {m.deadlines.length ? list(m.deadlines, p, { compact: true }) : <Calm>No closing or deal deadline on record in the next 14 days.</Calm>}
        </Plane>
        <IntelPanel {...p} />
      </aside>
    </div>
  )
}

/* ══ INTELLIGENCE (secondary): scheduled workload, not a prediction ═══ */
export function IntelPanel(p: ViewProps) {
  const { data, tz } = p
  const split = useMemo(() => workloadSplit(p.events), [p.events])
  const weeks = useMemo(() => weeksAhead(p.events, { today: data.range.today, tz }), [p.events, data.range.today, tz])
  const heat = useMemo(() => hourHeat(p.events, tz), [p.events, tz])
  const total = Math.max(1, split.system + split.you + split.external)
  return (
    <Plane title="Scheduled workload" meta={`${monthDay(data.range.from)} – ${monthDay(data.range.to)}`} className="c3-intel">
      <div className="c3-split" role="img" aria-label={`System ${split.system}, you ${split.you}, external ${split.external}`}>
        <i className="is-sys" style={{ flexGrow: split.system / total }} />
        <i className="is-you" style={{ flexGrow: split.you / total }} />
        <i className="is-ext" style={{ flexGrow: split.external / total }} />
      </div>
      <div className="c3-split__legend"><span><i className="is-sys" />System {split.system}</span><span><i className="is-you" />You {split.you}</span><span><i className="is-ext" />External {split.external}</span></div>
      <div className="c3-weeks">
        {weeks.map((w) => (
          <button key={w.from} type="button" onClick={() => p.onPickDay(w.from, 'week')}>
            <small>{monthDay(w.from)}</small>
            <span>{w.closings ? `${w.closings} closing${w.closings === 1 ? '' : 's'}` : '—'}</span>
            <span className={cx(w.attention && 'is-attn')}>{w.attention ? `${w.attention} attention` : '0 attention'}</span>
          </button>
        ))}
      </div>
      <div className="c3-heat" role="img" aria-label="Open timed items by weekday and hour">
        {heat.grid.map((row, wd) => (
          <div key={wd} className="c3-heat__row"><small>{['S', 'M', 'T', 'W', 'T', 'F', 'S'][wd]}</small>
            {row.slice(6, 23).map((n, h) => <i key={h} style={{ opacity: n ? 0.18 + 0.82 * (n / heat.max) : 0.06 }} title={`${hourLabel(h + 6)} · ${n}`} />)}
          </div>
        ))}
        <div className="c3-heat__axis"><small /> <span>6a</span><span>12p</span><span>6p</span><span>10p</span></div>
      </div>
      <p className="c3-foot">Counts of what is on record in the loaded range — scheduled workload, not a forecast.</p>
    </Plane>
  )
}

/* ══ TIMELINE: automation and human time on one spine ═══════════════ */
export function TimelineView(p: ViewProps) {
  const { data, tz, now } = p
  // Two days of context before the selected day, never before the loaded range.
  const from = addDays(p.day, -2) > data.range.from ? addDays(p.day, -2) : data.range.from
  const days = useMemo(() => timelineDays(p.events.filter((e) => p.showHistory || !e.history), { from, to: data.range.to, tz }), [p.events, p.showHistory, from, data.range.to, tz])
  return (
    <div className="c3-tl">
      <div className="c3-tl__legend" aria-hidden><span>System · automation · workflows</span><span /><span>You · seller · buyer · title</span></div>
      {days.map((d) => {
        const empty = !d.items.length && !d.windows.length && !d.allDay.length
        const isToday = d.day === data.range.today
        const nowIndex = isToday ? d.items.findIndex(({ e }) => Date.parse(isGroup(e) ? e.start : e.start) > now) : -1
        return (
          <section key={d.day} className={cx('c3-tl__day', isToday && 'is-today', d.day < data.range.today && 'is-past', empty && 'is-empty')} id={`c3-day-${d.day}`}>
            <header className="c3-tl__dayhead">
              <b>{isToday ? 'Today' : weekday(d.day, 'long')}</b><span>{monthDay(d.day)}</span>
              <em>{empty ? 'Nothing on record' : [d.windows.length ? plural(d.windows.length, 'window') : null, d.items.length ? plural(d.items.length, 'item') : null, d.allDay.length ? plural(d.allDay.length, 'deadline') : null].filter(Boolean).join(' · ')}</em>
            </header>
            {d.windows.length || d.allDay.length ? (
              <div className="c3-tl__band">
                {d.windows.map((w) => <EventObject key={w.id} e={w} mode={p.mode} tz={tz} now={now} today={data.range.today} compact selected={p.selectedId === w.id} onOpen={p.onOpen} />)}
                {d.allDay.map((e) => <EventObject key={e.id} e={e} mode={p.mode} tz={tz} now={now} today={data.range.today} compact selected={p.selectedId === e.id} onOpen={p.onOpen} />)}
              </div>
            ) : null}
            {d.items.length ? (
              <ol className="c3-tl__spine">
                {d.items.map(({ e, side }, i) => {
                  const start = isGroup(e) ? e.start : e.start
                  const pastRow = Date.parse(start) < now
                  return (
                    <li key={e.id} className={cx('c3-tl__row', `is-${side}`, pastRow && 'is-past')}>
                      {i === nowIndex ? <div className="c3-tl__now" aria-label={`Now ${clock(now, tz)}`}><span>Now · {clock(now, tz)} {zoneAbbr(tz)}</span></div> : null}
                      <div className="c3-tl__cell is-sys">{side === 'system' ? <ItemObject item={e} mode={p.mode} tz={tz} now={now} today={data.range.today} selectedId={p.selectedId} arrivedIds={p.arrivedIds} past={pastRow} compact onOpen={p.onOpen} /> : null}</div>
                      <time className="c3-tl__time">{clock(start, tz).replace(/ (AM|PM)$/, '')}<small>{clock(start, tz).slice(-2)}</small></time>
                      <div className="c3-tl__cell is-hum">{side === 'human' ? <ItemObject item={e} mode={p.mode} tz={tz} now={now} today={data.range.today} selectedId={p.selectedId} arrivedIds={p.arrivedIds} past={pastRow} compact onOpen={p.onOpen} /> : null}</div>
                    </li>
                  )
                })}
                {isToday && nowIndex === -1 ? <li className="c3-tl__row is-nowend"><div className="c3-tl__now"><span>Now · {clock(now, tz)} {zoneAbbr(tz)}</span></div></li> : null}
              </ol>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}

/* ══ WEEK: a real time grid ═══════════════════════════════════════════ */
const START_H = 6
const END_H = 23
export function WeekView(p: ViewProps & { weekFrom: string }) {
  const { tz, now, data } = p
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(p.weekFrom, i)), [p.weekFrom])
  const cells = useMemo(() => weekGrid(p.events.filter((e) => p.showHistory || !e.history), days, tz, { startHour: START_H, endHour: END_H }), [p.events, p.showHistory, days, tz])
  const [openStack, setOpenStack] = useState<string | null>(null)
  const todayIdx = days.indexOf(data.range.today)
  const nowPct = ((localMinutes(now, tz) - START_H * 60) / ((END_H - START_H) * 60)) * 100
  const hours = Array.from({ length: END_H - START_H + 1 }, (_, i) => START_H + i)
  return (
    <div className="c3-week">
      <div className="c3-week__head">
        <span className="c3-week__corner">{zoneAbbr(tz)}</span>
        {cells.map((c) => {
          const agg = data.days[c.day]
          return (
            <button key={c.day} type="button" className={cx('c3-week__dh', c.day === data.range.today && 'is-today', c.day === p.day && 'is-selected')} onClick={() => p.onPickDay(c.day)}>
              <small>{weekday(c.day)}</small><b>{dayNum(c.day)}</b>
              {agg?.attention ? <i className="is-attn" title={`${agg.attention} attention`} /> : null}
            </button>
          )
        })}
      </div>
      <div className="c3-week__allday">
        <span className="c3-week__corner">all-day</span>
        {cells.map((c) => (
          <div key={c.day} className="c3-week__adcell">
            {c.allDay.slice(0, 3).map((e) => (
              <button key={e.id} type="button" className={cx('c3-week__ad', `t-${toneOf(e)}`, p.selectedId === e.id && 'is-selected')} onClick={() => p.onOpen(e)} title={`${e.title} · ${e.place || e.subtitle || ''}`}>{e.title}</button>
            ))}
            {c.allDay.length > 3 ? <button type="button" className="c3-week__more" onClick={() => p.onPickDay(c.day)}>+{c.allDay.length - 3} more</button> : null}
          </div>
        ))}
      </div>
      <div className="c3-week__grid">
        <div className="c3-week__hours" aria-hidden>{hours.map((h) => <span key={h} style={{ top: `${((h - START_H) / (END_H - START_H)) * 100}%` }}>{hourLabel(h)}</span>)}</div>
        {cells.map((c, ci) => (
          <div key={c.day} className={cx('c3-week__col', c.day === data.range.today && 'is-today', c.day < data.range.today && 'is-past')}>
            {c.spans.map(({ e, top, height }) => (
              <button key={e.id} type="button" className={cx('c3-week__span', e.state === 'live' && 'is-live', p.selectedId === e.id && 'is-selected')} style={{ top: `${top}%`, height: `${height}%` }} onClick={() => p.onOpen(e)} title={`${e.subtitle} · send window`}>
                <span>{String(e.subtitle || '').split(' · ').slice(0, 2).join(' · ')}</span>
              </button>
            ))}
            {c.stacks.map((s) => {
              const first = s.items[0]
              const multi = s.items.length > 1
              return (
                <div key={s.key} className="c3-week__stackwrap" style={{ top: `${s.top}%` }}>
                  <button type="button" className={cx('c3-week__stack', `t-${toneOf(first)}`, multi && 'is-multi', s.items.some((i) => i.id === p.selectedId) && 'is-selected', first.history && 'is-past')}
                    onClick={() => (multi ? setOpenStack((o) => (o === s.key ? null : s.key)) : p.onOpen(first))} aria-expanded={multi ? openStack === s.key : undefined}>
                    <time>{clock(first.start, tz).replace(/:00/, '')}</time>
                    <b>{multi ? `${s.items.length} · ${[...new Set(s.items.map((i) => i.title))].slice(0, 2).join(', ')}` : first.title}</b>
                  </button>
                  {multi && openStack === s.key ? (
                    <div className="c3-pop c3-week__pop" role="dialog" aria-label="Items at this time">
                      {s.items.map((e) => (
                        <button key={e.id} type="button" className="c3-pop__row" onClick={() => { setOpenStack(null); p.onOpen(e) }}>
                          <time>{clock(e.start, tz)}</time><span><b>{e.title}</b><em>{e.subtitle || e.place || ''}</em></span><StateTag e={e} />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
            {ci === todayIdx && nowPct >= 0 && nowPct <= 100 ? <div className="c3-week__now" style={{ top: `${nowPct}%` }}><span>{clock(now, tz)}</span></div> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ══ MONTH: macro aggregates per day; click to drill ══════════════════ */
export function MonthView(p: ViewProps & { month: string }) {
  const { data } = p
  const cells = useMemo(() => monthCells(p.month, data.days), [p.month, data.days])
  const peak = Math.max(1, ...cells.map((c) => (c.agg ? c.agg.total - c.agg.completed : 0)))
  return (
    <div className="c3-month">
      <div className="c3-month__title"><h2>{monthTitle(p.month)}</h2><span>Macro view — open items per day, from the server's day aggregates</span></div>
      <div className="c3-month__wd">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => <span key={w}>{w}</span>)}</div>
      <div className="c3-month__grid">
        {cells.map((c) => {
          const lines = aggLine(c.agg)
          const load = c.agg ? (c.agg.total - c.agg.completed) / peak : 0
          return (
            <button key={c.day} type="button" className={cx('c3-month__cell', !c.inMonth && 'is-out', c.day === data.range.today && 'is-today', c.day === p.day && 'is-selected', c.day < data.range.today && 'is-past', !c.agg && 'is-unloaded')}
              onClick={() => p.onPickDay(c.day)} aria-label={`${longDay(c.day)}: ${lines.join(', ') || 'nothing on record'}`}>
              <span className="c3-month__n">{dayNum(c.day)}</span>
              <span className="c3-month__lines">{lines.slice(0, 4).map((l) => <span key={l} className={cx(/attention/.test(l) && 'is-attn', /closing/.test(l) && 'is-closing')}>{l}</span>)}</span>
              <span className="c3-month__load" aria-hidden><i style={{ width: `${Math.round(load * 100)}%` }} /></span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ══ ATTENTION: canonical categories ═════════════════════════════════ */
export function AttentionView(p: ViewProps) {
  const { data, tz } = p
  const sections = useMemo(() => attentionSections(data), [data])
  const total = data.telemetry.attention.total
  return (
    <div className="c3-attn">
      <div className="c3-attn__head">
        <h2>{total ? `${total} need${total === 1 ? 's' : ''} attention` : 'Nothing needs attention'}</h2>
        <p>Every category is a canonical definition from the read model; each row says what was due, whose it is, what it holds up and where to act.</p>
      </div>
      <div className="c3-attn__grid">
        {sections.map((s) => (
          <section key={s.key} className={cx('c3-attn__sec', !s.items.length && 'is-empty', `is-${s.key}`)}>
            <header><h3>{s.label}</h3><b>{s.items.length}</b></header>
            <p className="c3-attn__def">{s.definition}</p>
            {s.items.map((e) => (
              <button key={e.id} type="button" className={cx('c3-attn__row', p.selectedId === e.id && 'is-selected', `t-${toneOf(e)}`)} onClick={() => p.onOpen(e)}>
                <span className="c3-attn__when">{e.undated ? 'No date' : e.all_day && e.date ? monthDay(e.date) : `${monthDay(dayKey(e.start, tz))} · ${clock(e.start, tz)}`}</span>
                <span className="c3-attn__what"><b>{e.title}{e.subtitle ? ` · ${e.subtitle}` : ''}</b><em>{humanReason(e.reason) || e.why}</em></span>
                <OwnerTag owner={e.owner} manual={e.manual} />
                <span className="c3-attn__next">{e.deep_link?.label || e.editable.how}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}

/* ══ NOW: past 2 h → now → next 6 h ══════════════════════════════════ */
export function NowView(p: ViewProps & { motion: boolean }) {
  const { now, tz, data } = p
  const w = useMemo(() => nowWindow(p.events, now), [p.events, now])
  return (
    <div className={cx('c3-now', p.motion && 'is-moving')}>
      <div className="c3-now__head"><h2>Now · {clock(now, tz)} {zoneAbbr(tz)}</h2><span>Two hours back, six ahead. The playhead moves with the clock.</span></div>
      <div className="c3-now__stage">
        <div className="c3-now__ticks" aria-hidden>{w.ticks.map((t) => <span key={t.t} style={{ left: `${t.pct}%` }}>{clock(t.t, tz).replace(':00', '')}</span>)}</div>
        {w.lanes.map((l) => (
          <div key={l.key} className="c3-now__lane">
            <span className="c3-now__label">{l.label}<em>{l.items.length || ''}</em></span>
            <div className="c3-now__track">
              {l.items.map(({ e, left, width }) => (
                <button key={e.id} type="button" className={cx('c3-now__item', width ? 'is-span' : 'is-point', `t-${toneOf(e)}`, p.selectedId === e.id && 'is-selected', Date.parse(e.start) < now && !width && 'is-past')}
                  style={{ left: `${left}%`, width: width ? `${width}%` : undefined }} onClick={() => p.onOpen(e)} title={`${e.title} · ${clock(e.start, tz)}`}>
                  <Icon name={iconFor(e)} /><span>{e.type === 'campaign_window' ? String(e.subtitle || '').split(' · ').slice(0, 2).join(' · ') : e.title}</span>
                </button>
              ))}
              {!l.items.length ? <span className="c3-now__empty">—</span> : null}
            </div>
          </div>
        ))}
        <div className="c3-now__playhead" style={{ left: `calc(14px + var(--c3-now-label) + (100% - 28px - var(--c3-now-label)) * ${w.nowPct / 100})` }} aria-hidden><span>Now</span></div>
      </div>
      {!w.lanes.some((l) => l.items.length) ? <Calm>Nothing timed falls between {clock(w.from, tz)} and {clock(w.to, tz)}.</Calm> : null}
      {void data}
    </div>
  )
}

/* ══ search ═════════════════════════════════════════════════════════ */
export function SearchResults(p: ViewProps & { query: string }) {
  const q = p.query.trim().toLowerCase()
  const hits = useMemo(() => p.events.filter((e) => [e.title, e.subtitle, e.place, (e.detail as { market?: string })?.market, (e.detail as { workflow_name?: string })?.workflow_name]
    .some((v) => String(v ?? '').toLowerCase().includes(q))).slice(0, 80), [p.events, q])
  return (
    <div className="c3-results">
      <div className="c3-attn__head"><h2>{hits.length ? `${hits.length} match${hits.length === 1 ? '' : 'es'} for “${p.query}”` : `No events match “${p.query}”`}</h2><p>Searched the loaded range ({monthDay(p.data.range.from)} – {monthDay(p.data.range.to)}).</p></div>
      {hits.map((e) => (
        <div key={e.id} className="c3-results__row">
          <time>{e.undated ? 'No date' : e.all_day && e.date ? monthDay(e.date) : `${monthDay(dayKey(e.start, p.tz))} · ${clock(e.start, p.tz)}`}</time>
          <EventObject e={e} mode={p.mode} tz={p.tz} now={p.now} today={p.data.range.today} compact selected={p.selectedId === e.id} onOpen={p.onOpen} />
        </div>
      ))}
    </div>
  )
}
