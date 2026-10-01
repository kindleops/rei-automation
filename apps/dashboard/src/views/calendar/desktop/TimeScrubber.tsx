import { memo, useMemo, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { LCIconButton, cx } from '../../../shared/lc'
import type { ScrubDay } from './temporal-model'
import { dayNum, longDay, monthShort, weekday, weekdayIndex } from './temporal-time'

/**
 * THE TIME SCRUBBER (§37–39) — the loaded range as one continuous ribbon,
 * not a row of date boxes. A density silhouette says where the work is; at
 * most three quiet marks per day (campaign · closing · attention). Drag the
 * lens: the preview follows the pointer and the canvas does not move until
 * release resolves the day. Arrow keys, Home/End and Page keys move it too.
 */

export interface ScrubberProps {
  days: ScrubDay[]
  selected: string
  today: string
  /** the period the arrows step: a day, a week or a month */
  stepLabel: 'day' | 'week' | 'month'
  onPick: (day: string) => void
  onPreview: (day: string | null) => void
  onStep: (dir: 1 | -1) => void
  onToday: () => void
  loading: boolean
  /** the zoom for the day canvas sits with the scrubber: navigation and scale together */
  aside?: ReactNode
}

function silhouette(days: ScrubDay[], h: number) {
  if (!days.length) return ''
  const n = days.length
  const pts = days.map((d, i) => [((i + 0.5) / n) * 1000, h - 2 - d.load * (h - 8)] as const)
  // Catmull-Rom → cubic Bézier: a calm curve through each day's load
  let path = `M0,${h} L0,${pts[0][1]} L${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    path += ` C${c1[0].toFixed(1)},${Math.min(h - 2, c1[1]).toFixed(1)} ${c2[0].toFixed(1)},${Math.min(h - 2, c2[1]).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`
  }
  const last = pts[pts.length - 1]
  return `${path} L1000,${last[1]} L1000,${h} Z`
}

export const TimeScrubber = memo(function TimeScrubber({ days, selected, today, stepLabel, onPick, onPreview, onStep, onToday, loading, aside }: ScrubberProps) {
  const [drag, setDrag] = useState<{ day: string; moved: boolean } | null>(null)
  const n = days.length
  const index = (d: string) => days.findIndex((x) => x.day === d)
  const shown = drag?.day ?? selected
  const si = index(shown)
  const ti = index(today)
  const path = useMemo(() => silhouette(days, 40), [days])
  const at = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const r = ev.currentTarget.getBoundingClientRect()
    const i = Math.min(n - 1, Math.max(0, Math.floor(((ev.clientX - r.left) / Math.max(1, r.width)) * n)))
    return days[i]?.day ?? null
  }
  const onDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!n || ev.button !== 0) return
    ev.currentTarget.setPointerCapture(ev.pointerId)
    const d = at(ev)
    if (!d) return
    setDrag({ day: d, moved: false })
    onPreview(d)
  }
  const onMove = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return
    const d = at(ev)
    if (d && d !== drag.day) { setDrag({ day: d, moved: true }); onPreview(d) }
  }
  const onUp = () => {
    if (!drag) return
    const d = drag.day
    setDrag(null)
    onPreview(null)
    if (d !== selected) onPick(d)
  }
  const onKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    const i = index(selected)
    const go = (j: number) => { const d = days[Math.min(n - 1, Math.max(0, j))]?.day; if (d && d !== selected) onPick(d) }
    const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : ev.key === 'PageDown' ? 7 : ev.key === 'PageUp' ? -7 : null
    if (step !== null) { ev.preventDefault(); ev.stopPropagation(); go(i < 0 ? 0 : i + step); return }
    if (ev.key === 'Home') { ev.preventDefault(); ev.stopPropagation(); go(0) }
    if (ev.key === 'End') { ev.preventDefault(); ev.stopPropagation(); go(n - 1) }
  }
  const cur = si >= 0 ? days[si] : null
  const preview = drag && cur ? `${longDay(cur.day)} · ${cur.known ? `${cur.total} event${cur.total === 1 ? '' : 's'}${cur.marks.attention ? ' · attention' : ''}` : 'not loaded'}` : null
  return (
    <div className={cx('tcc-scrub', drag && 'is-scrubbing', loading && 'is-loading', aside && 'has-aside')}>
      <div className="tcc-scrub__nav">
        <LCIconButton icon="chevron-left" label={`Previous ${stepLabel}`} size="sm" shortcut={['←']} onClick={() => onStep(-1)} />
        <button type="button" className={cx('tcc-scrub__today', selected === today && 'is-on')} onClick={onToday} title="Today (T)">Today</button>
        <LCIconButton icon="chevron-right" label={`Next ${stepLabel}`} size="sm" shortcut={['→']} onClick={() => onStep(1)} />
      </div>
      <div className="tcc-scrub__track" role="slider" tabIndex={0} aria-label="Scrub through days"
        aria-valuemin={0} aria-valuemax={Math.max(0, n - 1)} aria-valuenow={Math.max(0, si)} aria-valuetext={cur ? longDay(cur.day) : undefined}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { setDrag(null); onPreview(null) }} onKeyDown={onKey}>
        <svg className="tcc-scrub__density" viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>
        {days.map((d, i) => {
          const first = dayNum(d.day) === 1
          const sunday = weekdayIndex(d.day) === 0
          return (
            <span key={d.day} className={cx('tcc-scrub__day', d.day < today && 'is-past', first && 'is-month', sunday && 'is-week', !d.known && 'is-unknown')} style={{ left: `${(i / n) * 100}%`, width: `${100 / n}%` }} aria-hidden="true">
              {first || (sunday && i > 0) || i === 0 ? <b className="tcc-scrub__label">{first || i === 0 ? `${monthShort(d.day)} ${dayNum(d.day)}` : dayNum(d.day)}</b> : null}
              <span className="tcc-scrub__marks">
                {d.marks.campaign ? <i className="is-campaign" /> : null}
                {d.marks.closing ? <i className="is-closing" /> : null}
                {d.marks.attention ? <i className="is-attention" /> : null}
              </span>
            </span>
          )
        })}
        {ti >= 0 ? <span className="tcc-scrub__now" style={{ left: `${((ti + 0.5) / n) * 100}%` }} aria-hidden="true" /> : null}
        {si >= 0 ? (
          <span className="tcc-scrub__lens" style={{ left: `${((si + 0.5) / n) * 100}%` }} aria-hidden="true">
            <small>{weekday(days[si].day)}</small><b>{dayNum(days[si].day)}</b>
          </span>
        ) : null}
        {preview ? <span className="tcc-scrub__preview" style={{ left: `${((si + 0.5) / n) * 100}%` }} role="status">{preview}</span> : null}
      </div>
      {aside ? <div className="tcc-scrub__aside">{aside}</div> : null}
    </div>
  )
})
