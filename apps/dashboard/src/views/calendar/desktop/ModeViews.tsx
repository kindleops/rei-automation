import { memo, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { LCEmpty, LCHoverCard, LCSegmented, LCSkeleton, cx } from '../../../shared/lc'
import type { DeskDay, DeskEvent, DeskTimeline } from '../../../domain/calendar/calendar-timeline-api'
import { humanReason } from '../../../domain/calendar/calendar-timeline-api'
import {
  LANE_ICON, MONTH_METRICS, STATUS_LABEL, attentionGroups, laneOf, loadWord, monthModel, statusOf, timeText, toneOf, weekModel, type LaneKey, type MonthMetric,
} from './temporal-model'
import { addDays, clock, dayBounds, dayKey, dayNum, longDay, monthDay, weekday, zoneAbbr } from './temporal-time'

/* ══ WEEK (§31–32, §126, §184) ═══════════════════════════════════════════ */

const LANE_TONE: Record<LaneKey, string> = { campaigns: 'exec', sellers: 'cobalt', workflows: 'flow', deals: 'neutral', closings: 'neutral', email: 'neutral' }
const LANE_SHORT: Record<LaneKey, string> = { campaigns: 'Campaign', sellers: 'Seller', workflows: 'Workflow', deals: 'Deal', closings: 'Closing', email: 'Email' }

export const WeekView = memo(function WeekView({ events, from, today, tz, now, onPickDay }: { events: DeskEvent[]; from: string; today: string; tz: string; now: number; onPickDay: (d: string) => void }) {
  const w = useMemo(() => weekModel(events, { from, tz }), [events, from, tz])
  const [h0, h1] = w.hourRange
  const hours = Array.from({ length: h1 - h0 }, (_, i) => h0 + i)
  const busiest = w.days.reduce((a, b) => (b.open + b.done > a.open + a.done ? b : a), w.days[0])
  const nowHour = dayKey(now, tz) >= from && dayKey(now, tz) <= addDays(from, 6) ? (now - dayBounds(dayKey(now, tz), tz).start) / 3_600_000 : null
  return (
    <section className="tcc-week" aria-label="Week workload">
      <header className="tcc-week__head">
        <div>
          <span className="lc-eyebrow">Week load</span>
          <p>{busiest && busiest.open + busiest.done ? <>Busiest <b>{weekday(busiest.day, 'long')}</b> · {busiest.open + busiest.done} events{busiest.texts ? ` · ${busiest.texts.toLocaleString('en-US')} campaign texts` : ''}</> : 'Nothing scheduled this week'}</p>
        </div>
        <div className="tcc-legend" aria-hidden="true">
          {(Object.keys(LANE_TONE) as LaneKey[]).filter((k) => w.days.some((d) => d.byLane[k])).map((k) => <span key={k} data-tone={LANE_TONE[k]}><i />{LANE_SHORT[k]}</span>)}
          <span className="is-window"><i />Send window</span>
          <span className="is-closing"><i />Closing time</span>
          <span className="is-attn"><i />Attention</span>
        </div>
      </header>
      {/* the load chart: one column per day, composition stacked, the summary in words */}
      <div className="tcc-week__load" role="list">
        {w.days.map((d) => {
          const total = d.open + d.done
          const word = loadWord(total, w.max)
          return (
            <LCHoverCard key={d.day} side="bottom" align="center" width={240} openDelay={260}
              trigger={
                <button type="button" role="listitem" className={cx('tcc-wday', d.day === today && 'is-today', d.day < today && 'is-past')} onClick={() => onPickDay(d.day)} aria-label={`${longDay(d.day)}: ${total} events, ${word}. Open the day.`}>
                  <span className="tcc-wday__name"><b>{weekday(d.day)}</b><span>{dayNum(d.day)}</span></span>
                  <span className="tcc-wday__bar" aria-hidden="true">
                    {(Object.keys(LANE_TONE) as LaneKey[]).map((k) => d.byLane[k] ? <i key={k} data-tone={LANE_TONE[k]} style={{ height: `${(d.byLane[k] / w.max) * 100}%` }} /> : null)}
                  </span>
                  <span className="tcc-wday__word" data-word={word.toLowerCase()}>{word}</span>
                  <span className="tcc-wday__sum">{d.summary}</span>
                  <span className="tcc-wday__marks">
                    {d.windows.length ? <i className="is-window" title={`${d.windows.length} send window${d.windows.length === 1 ? '' : 's'}`} /> : null}
                    {d.closings.length ? <i className="is-closing" title={`${d.closings.length} closing item${d.closings.length === 1 ? '' : 's'}`} /> : null}
                    {d.attention ? <i className="is-attn" title={`${d.attention} needing attention`} /> : null}
                  </span>
                </button>
              }>
              <div className="tcc-hover">
                <b>{longDay(d.day)}</b>
                <ul>
                  {(Object.keys(LANE_TONE) as LaneKey[]).filter((k) => d.byLane[k]).map((k) => <li key={k}><span className="tcc-dot" data-tone={LANE_TONE[k] === 'cobalt' ? 'exec' : LANE_TONE[k]} />{d.byLane[k]} {LANE_SHORT[k].toLowerCase()}{d.byLane[k] === 1 ? '' : 's'}</li>)}
                  {d.texts ? <li><span className="tcc-dot" data-tone="exec" />{d.texts.toLocaleString('en-US')} campaign texts (queue schedule)</li> : null}
                  {d.windows.length ? <li><span className="tcc-dot" data-tone="exec" />{d.windows.length} send window{d.windows.length === 1 ? '' : 's'}</li> : null}
                  {d.attention ? <li><span className="tcc-dot" data-tone="attn" />{d.attention} need attention</li> : null}
                  {!total ? <li>Nothing scheduled</li> : null}
                </ul>
              </div>
            </LCHoverCard>
          )
        })}
      </div>
      {/* the density field: hours down, days across — windows as coverage, closings as markers */}
      <div className="tcc-week__field" style={{ ['--hours' as string]: hours.length }}>
        <div className="tcc-week__hours" aria-hidden="true">{hours.map((h) => <span key={h}>{h % 3 === 0 ? (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`) : ''}</span>)}</div>
        {w.days.map((d) => (
          <button key={d.day} type="button" className={cx('tcc-week__col', d.day === today && 'is-today')} onClick={() => onPickDay(d.day)} aria-label={`${longDay(d.day)} by hour`}>
            {d.windows.map((x, i) => {
              const b = dayBounds(d.day, tz)
              const top = Math.max(0, ((x.from - b.start) / 3_600_000 - h0) / (h1 - h0)) * 100
              const bottom = Math.min(1, ((x.to - b.start) / 3_600_000 - h0) / (h1 - h0)) * 100
              return <span key={i} className={cx('tcc-week__win', x.live && 'is-live')} style={{ top: `${top}%`, height: `${Math.max(1, bottom - top)}%`, left: `${8 + i * 4}%` }} aria-hidden="true" />
            })}
            {hours.map((h) => {
              const v = d.hours[h]
              return <span key={h} className={cx('tcc-week__cell', v > 0 && 'has')} style={v ? { ['--heat' as string]: Math.sqrt(v / w.hourMax) } : undefined} title={v ? `${weekday(d.day)} ${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'} · ${v} timed` : undefined} aria-hidden="true" />
            })}
            {d.closings.map((c) => c.hour === null
              ? <span key={c.e.id} className="tcc-week__allday" title={`${c.e.title} · date only`} aria-hidden="true"><Icon name="flag" size={9} /></span>
              : <span key={c.e.id} className="tcc-week__closing" style={{ top: `${Math.min(100, Math.max(0, ((c.hour - h0) / (h1 - h0)) * 100))}%` }} title={`${c.e.title} · ${clock(c.e.start, tz)}`} aria-hidden="true" />)}
            {d.day === dayKey(now, tz) && nowHour !== null && nowHour >= h0 && nowHour <= h1 ? <span className="tcc-week__now" style={{ top: `${((nowHour - h0) / (h1 - h0)) * 100}%` }} aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
      <p className="tcc-basis">Density: timed events per hour in your zone ({zoneAbbr(tz)}); campaign texts are the queue's own per-row schedule. Windows are coverage, not load. Click a day to open it.</p>
    </section>
  )
})

/* ══ MONTH (§33–34, §127, §185) ══════════════════════════════════════════ */

export const MonthView = memo(function MonthView({ anchor, days, today, filtered, onPickDay }: { anchor: string; days: Record<string, DeskDay>; today: string; filtered: boolean; onPickDay: (d: string) => void }) {
  const [metric, setMetric] = useState<MonthMetric>('total')
  const m = useMemo(() => monthModel(anchor, days, metric), [anchor, days, metric])
  const def = MONTH_METRICS.find((x) => x.key === metric)!
  return (
    <section className="tcc-month" aria-label="Month">
      <header className="tcc-month__head">
        <LCSegmented size="sm" label="Heatmap metric" value={metric} onChange={(v) => setMetric(v as MonthMetric)} options={MONTH_METRICS.map((x) => ({ value: x.key, label: x.label }))} />
        <p className="tcc-basis">{def.basis}{filtered ? ' Filters applied.' : ''} Peak {m.max.toLocaleString('en-US')}.</p>
      </header>
      <div className="tcc-month__grid" role="grid" data-metric={metric} aria-label={`Month heatmap: ${def.label}`}>
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <span key={d} className="tcc-month__dow" role="columnheader">{d}</span>)}
        {m.cells.map((c) => (
          <button key={c.day} type="button" role="gridcell" className={cx('tcc-mcell', !c.inMonth && 'is-out', c.day === today && 'is-today', c.day < today && 'is-past', !c.agg && 'is-unknown')}
            style={{ ['--heat' as string]: c.intensity }} onClick={() => onPickDay(c.day)}
            aria-label={`${longDay(c.day)}: ${c.agg ? `${c.value} ${def.label.toLowerCase()}` : 'not loaded'}`}>
            <span className="tcc-mcell__fill" aria-hidden="true" />
            <span className="tcc-mcell__num">{dayNum(c.day) === 1 ? `${monthDay(c.day)}` : dayNum(c.day)}</span>
            {c.value ? <b className="tcc-mcell__value">{c.value.toLocaleString('en-US')}</b> : null}
            <span className="tcc-mcell__marks" aria-hidden="true">
              {c.marks.campaign ? <i className="is-campaign" /> : null}
              {c.marks.closing ? <i className="is-closing" /> : null}
              {c.marks.attention ? <i className="is-attn" /> : null}
            </span>
          </button>
        ))}
      </div>
      <div className="tcc-legend is-month" aria-hidden="true">
        <span className="is-scale"><i /><i /><i /><i /><i />{def.label}</span>
        <span className="is-window"><i />Campaign day</span>
        <span className="is-closing"><i />Closing</span>
        <span className="is-attn"><i />Attention</span>
      </div>
    </section>
  )
})

/* ══ ATTENTION (§35, §128, §186) ═════════════════════════════════════════ */

export const AttentionView = memo(function AttentionView({ data, tz, now, filter, onOpen }: { data: DeskTimeline; tz: string; now: number; filter: (e: DeskEvent) => boolean; onOpen: (e: DeskEvent) => void }) {
  const groups = useMemo(() => attentionGroups(data, { now, tz }).map((g) => ({ ...g, items: g.items.filter((i) => filter(i.e)) })).filter((g) => g.items.length), [data, now, tz, filter])
  const total = groups.reduce((a, g) => a + g.items.length, 0)
  if (!total) {
    return <LCEmpty tone="calm" icon="check" title="Nothing will go wrong on its own" body="No overdue items, no missed starts, nothing due that is waiting on you." className="tcc-empty" />
  }
  return (
    <section className="tcc-attn" aria-label="Attention">
      <header className="tcc-attn__head">
        <span className="lc-eyebrow">Temporal risk</span>
        <p>What stays blocked or goes wrong if nothing changes — {total} item{total === 1 ? '' : 's'}. Each says why and where to act.</p>
      </header>
      {groups.map((g) => (
        <section key={g.key} className={cx('tcc-attn__group', `is-${g.key}`)}>
          <h3><span className="lc-eyebrow">{g.label}</span><span className="tcc-attn__n">{g.items.length}</span></h3>
          <ul>
            {g.items.map((i) => {
              const t = timeText(i.e, tz)
              return (
                <li key={i.e.id}>
                  <button type="button" className="tcc-attn__row" onClick={() => onOpen(i.e)} data-tone={toneOf(i.e)}>
                    <span className="tcc-attn__when"><b>{i.when}</b><em>{i.e.undated ? '' : `${weekday(i.e.all_day && i.e.date ? i.e.date : dayKey(i.e.start, tz))} ${t.main}`}</em></span>
                    <span className="tcc-attn__what">
                      <span className="tcc-attn__kind"><Icon name={LANE_ICON[laneOf(i.e)]} size={11} />{i.kind}</span>
                      <b>{i.e.subtitle && i.e.type !== 'campaign_start' ? `${i.e.title} · ${i.e.subtitle}` : i.e.type === 'campaign_start' ? `${i.e.subtitle}` : i.e.title}</b>
                      <em>{humanReason(i.why)}</em>
                    </span>
                    <span className="tcc-attn__go">{i.e.deep_link ? <>{i.e.deep_link.label}<Icon name="arrow-up-right" size={11} /></> : STATUS_LABEL[statusOf(i.e)]}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </section>
  )
})

/* ══ SEARCH RESULTS (§51) ════════════════════════════════════════════════ */

export const SearchResults = memo(function SearchResults({ results, query, range, tz, onOpen }: { results: DeskEvent[]; query: string; range: { from: string; to: string }; tz: string; onOpen: (e: DeskEvent) => void }) {
  const byDay = useMemo(() => {
    const m = new Map<string, DeskEvent[]>()
    for (const e of results) { const d = e.undated ? 'undated' : e.all_day && e.date ? e.date : dayKey(e.start, tz); if (!m.has(d)) m.set(d, []); m.get(d)!.push(e) }
    return [...m.entries()]
  }, [results, tz])
  return (
    <section className="tcc-results" aria-label={`Search results for ${query}`}>
      <header className="tcc-results__head"><span className="lc-eyebrow">Search · {results.length} result{results.length === 1 ? '' : 's'}</span><p>Across the loaded range {monthDay(range.from)} – {monthDay(range.to)} and every open attention item.</p></header>
      {!results.length ? <LCEmpty title={`Nothing matches “${query}”`} body="Search reads sellers, addresses, campaigns, workflows, markets and event types. A date (“tomorrow”, “Oct 15”) jumps there." compact /> : null}
      {byDay.map(([d, list]) => (
        <section key={d} className="tcc-results__day">
          <h3 className="lc-eyebrow">{d === 'undated' ? 'No date' : longDay(d)}</h3>
          <ul>
            {list.map((e) => {
              const t = timeText(e, tz)
              return (
                <li key={e.id}>
                  <button type="button" className={cx('tcc-attn__row', e.history && 'is-history')} data-tone={toneOf(e)} onClick={() => onOpen(e)}>
                    <span className="tcc-attn__when"><b>{e.all_day ? 'All day' : clock(e.start, tz)}</b><em>{t.alt || zoneAbbr(tz)}</em></span>
                    <span className="tcc-attn__what"><span className="tcc-attn__kind"><Icon name={LANE_ICON[laneOf(e)]} size={11} />{STATUS_LABEL[statusOf(e)]}</span><b>{e.title}{e.subtitle ? ` · ${e.subtitle}` : ''}</b><em>{e.place || humanReason(e.reason) || ''}</em></span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </section>
  )
})

/* ══ LOADING: the temporal skeleton keeps axis, lanes and brief in place (§147) ══ */

export function CanvasSkeleton() {
  return (
    <div className="tcc-canvas is-skeleton" aria-busy="true" aria-label="Loading the day">
      <div className="tcc-axis"><div className="tcc-gutter" /><div className="tcc-axis__track">{Array.from({ length: 9 }, (_, i) => <span key={i} className="tcc-tick has-label" style={{ left: `${(i / 8) * 100}%` }}><b><i className="tcc-skel-num" /></b></span>)}</div></div>
      <div className="tcc-lanes">
        {[3, 1, 1].map((rows, i) => (
          <div key={i} className="tcc-lane" style={{ height: rows * 44 }}>
            <div className="tcc-gutter tcc-lane__label"><LCSkeleton shape="lines" count={1} /></div>
            <div className="tcc-lane__track">{Array.from({ length: rows }, (_, r) => <i key={r} className="lc-skel tcc-skel-band" style={{ top: r * 44 + 6, left: `${12 + r * 3}%`, width: `${70 - r * 8}%` }} />)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** A clear day (§148): calm words, one real next step. */
export function ClearDay({ day, today, onTomorrow }: { day: string; today: string; onTomorrow: () => void }) {
  return (
    <LCEmpty tone="calm" icon="calendar" className="tcc-empty is-clear" title="Clear day"
      body={day < today ? 'Nothing was on record for this day.' : 'No system actions scheduled. Nothing is waiting on you.'}
      action={{ label: day === today ? 'View tomorrow' : 'Next day', onClick: onTomorrow }} />
  )
}
