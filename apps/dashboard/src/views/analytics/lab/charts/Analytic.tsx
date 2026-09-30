/**
 * CONTRIBUTION BRIDGE, HEATMAP, HISTOGRAM, OUTCOME STACK.
 *
 * Contribution says what CONTRIBUTED TO the observed change (midpoint
 * decomposition: the rows sum exactly to the change); it never says cause.
 * The heatmap is seller-local hour × weekday. The histogram shows the
 * distribution with its percentiles and n. The outcome stack is additive and
 * uses the validated role order (primary → failure → workflow → attention).
 */
import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ContributionRow, Heatmap, Histogram } from '../../../../domain/analytics/analytics-lab-api'
import { clamp, niceTicks, seqColor } from './chart-kit'

/* ── contribution bridge ─────────────────────────────────────────────────── */

type Bridge = {
  kind: 'rate' | 'count'
  start: number
  end: number
  rows: ContributionRow[]
  others: number
  polarity: 'up' | 'down' | 'neutral'
  format: (v: number | null) => string
  startLabel: string
  endLabel: string
  onRow?: (row: ContributionRow) => void
}
export function ContributionBridge({ kind, start, end, rows, others, polarity, format, startLabel, endLabel, onRow }: Bridge) {
  const unitScale = kind === 'rate' ? 0.01 : 1 // pts → rate
  const steps: Array<{ key: string; label: string; from: number; to: number; row?: ContributionRow; total?: boolean }> = []
  let run = start
  steps.push({ key: '__start', label: startLabel, from: start, to: start, total: true })
  for (const r of rows) {
    const c = (kind === 'rate' ? r.contributionPts ?? 0 : r.contribution ?? 0) * unitScale
    steps.push({ key: r.key, label: r.label, from: run, to: run + c, row: r })
    run += c
  }
  if (Math.abs(others) > 1e-9) { steps.push({ key: '__others', label: 'All other groups', from: run, to: run + others * unitScale }); run += others * unitScale }
  steps.push({ key: '__end', label: endLabel, from: end, to: end, total: true })
  const lo = Math.min(...steps.flatMap((s) => [s.from, s.to]))
  const hiV = Math.max(...steps.flatMap((s) => [s.from, s.to]))
  const pad = (hiV - lo) * 0.08 || (kind === 'rate' ? 0.005 : 1)
  const dLo = Math.max(0, lo - pad)
  const dHi = hiV + pad
  const pos = (v: number) => `${(clamp((v - dLo) / (dHi - dLo || 1), 0, 1) * 100).toFixed(2)}%`
  const tone = (d: number) => (!d || polarity === 'neutral' ? 'neutral' : (d > 0) === (polarity === 'up') ? 'good' : 'bad')
  const fmtDelta = (d: number) => (kind === 'rate' ? `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d * 100).toFixed(2)} pts` : `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(Math.round(d)).toLocaleString('en-US')}`)
  return (
    <div className="lab-bridge" role="table" aria-label="Contribution to the observed change">
      {steps.map((s) => {
        const d = s.to - s.from
        return (
          <div key={s.key} role="row" className={['lab-bridge__row', s.total && 'is-total'].filter(Boolean).join(' ')}>
            <button type="button" role="rowheader" className="lab-bridge__label" disabled={!s.row || !onRow} onClick={() => s.row && onRow?.(s.row)} title={s.label}>{s.label}</button>
            <span className="lab-bridge__track" role="cell">
              {s.total
                ? <i className="lab-bridge__mark" style={{ left: pos(s.to) } as CSSProperties} />
                : <i className={`lab-bridge__bar t-${tone(d)}`} style={{ left: pos(Math.min(s.from, s.to)), width: `max(2px, calc(${pos(Math.max(s.from, s.to))} - ${pos(Math.min(s.from, s.to))}))` } as CSSProperties} />}
            </span>
            <span role="cell" className={`lab-bridge__val ${s.total ? '' : `t-${tone(d)}`}`}>
              {s.total ? <b>{format(s.to)}</b> : <><b>{d > 0 ? '▲' : d < 0 ? '▼' : '•'} {fmtDelta(d)}</b>{s.row && kind === 'rate' && typeof s.row.rateEffectPts === 'number' ? <span>rate {s.row.rateEffectPts >= 0 ? '+' : '−'}{Math.abs(s.row.rateEffectPts).toFixed(2)} · mix {(s.row.mixEffectPts ?? 0) >= 0 ? '+' : '−'}{Math.abs(s.row.mixEffectPts ?? 0).toFixed(2)}</span> : null}</>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/* ── heatmap: seller-local hour × weekday ─────────────────────────────── */

const ORDER = [1, 2, 3, 4, 5, 6, 0] // Mon first
export function HourHeatmap({ data, format, isRate, minSample = 20, onCell }: { data: Heatmap; format: (v: number | null) => string; isRate: boolean; minSample?: number; onCell?: (weekday: number, hour: number) => void }) {
  const [hover, setHover] = useState<{ w: number; h: number } | null>(null)
  const max = useMemo(() => {
    let m = 0
    for (const row of data.cells) for (const c of row) if (c.value !== null && (!isRate || c.den >= Math.max(3, minSample / 4))) m = Math.max(m, c.value)
    return m || 1
  }, [data, isRate, minSample])
  const cell = hover ? data.cells[hover.w][hover.h] : null
  return (
    <div className="lab-heat">
      <div className="lab-heat__grid" role="grid" aria-label="Hour of day by weekday, seller-local time">
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="lab-heat__hour" aria-hidden="true">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>)}
        {ORDER.map((w) => (
          <div key={w} role="row" className="lab-heat__row">
            <span className="lab-heat__day">{data.weekdays[w]}</span>
            {data.cells[w].map((c, h) => {
              const thin = isRate ? c.den < minSample : false
              const empty = isRate ? c.den === 0 : c.n === 0
              const t = c.value === null ? 0 : c.value / max
              return (
                <button
                  key={h} type="button" role="gridcell"
                  className={['lab-heat__cell', thin && 'is-thin', empty && 'is-empty'].filter(Boolean).join(' ')}
                  style={{ background: empty ? undefined : seqColor(t) } as CSSProperties}
                  aria-label={`${data.weekdays[w]} ${String(h).padStart(2, '0')}:00 — ${empty ? 'no records' : `${format(c.value)}${isRate ? ` (${c.num}/${c.den})` : ''}`}`}
                  onPointerEnter={() => setHover({ w, h })} onFocus={() => setHover({ w, h })} onPointerLeave={() => setHover(null)}
                  onClick={() => !empty && onCell?.(w, h)} disabled={empty}
                />
              )
            })}
          </div>
        ))}
      </div>
      <div className="lab-heat__foot">
        <span className="lab-heat__legend"><i style={{ background: seqColor(0.08) }} />low<i style={{ background: seqColor(0.55) }} /><i style={{ background: seqColor(1) }} />high ({format(max)})</span>
        {isRate ? <span className="lab-heat__legend"><i className="is-thin" />n &lt; {minSample}</span> : null}
        <span className="lab-heat__read">{cell && hover ? `${data.weekdays[hover.w]} ${String(hover.h).padStart(2, '0')}:00 · ${format(cell.value)}${isRate ? ` · ${cell.num}/${cell.den}` : ` · ${cell.n}`}` : `${data.unresolved ? `${data.unresolved} without a resolvable local time · ` : ''}${data.basis}`}</span>
      </div>
    </div>
  )
}

/* ── histogram with percentiles ──────────────────────────────────────────── */

export function DistributionHistogram({ data, format }: { data: Histogram; format: (v: number | null) => string }) {
  const bins = data.bins
  const maxC = Math.max(1, ...bins.map((b) => b.count))
  const { ticks } = niceTicks(0, maxC, 3)
  const last = bins.length ? bins[bins.length - 1].to : 1
  const logPos = (v: number) => {
    if (!bins.length) return 0
    const i = bins.findIndex((b) => v <= b.to)
    const k = i < 0 ? bins.length - 1 : i
    const b = bins[k]
    const frac = b.to > b.from ? (v - b.from) / (b.to - b.from) : 0
    return ((k + clamp(frac, 0, 1)) / bins.length) * 100
  }
  const marks = [['P50', data.dist.p50], ['P75', data.dist.p75], ['P90', data.dist.p90]] as const
  return (
    <div className="lab-hist" role="img" aria-label={`Distribution, n=${data.dist.n}, median ${format(data.dist.p50)}`}>
      <div className="lab-hist__plot">
        {ticks.map((t) => <i key={t} className="lab-hist__grid" style={{ bottom: `${(t / (ticks[ticks.length - 1] || 1)) * 100}%` } as CSSProperties}><em>{t}</em></i>)}
        <div className="lab-hist__bars">
          {bins.map((b, i) => <i key={i} title={`${format(b.from)} – ${format(b.to)}: ${b.count}`} style={{ height: `${(b.count / (ticks[ticks.length - 1] || 1)) * 100}%` } as CSSProperties} />)}
        </div>
        {marks.map(([k, v]) => (v === null || v === undefined ? null : <span key={k} className="lab-hist__mark" style={{ left: `${logPos(v)}%` } as CSSProperties}><b>{k}</b>{format(v)}</span>))}
      </div>
      <div className="lab-hist__axis"><span>0</span><span>{format(bins.length ? bins[Math.floor(bins.length / 2)].to : null)}</span><span>{format(last)}</span></div>
      <p className="lab-note">n = {data.dist.n} · log-spaced bins · median {format(data.dist.p50)} · P75 {format(data.dist.p75)} · P90 {format(data.dist.p90)}</p>
    </div>
  )
}

/* ── additive outcome stack (validated role order) ───────────────────────── */

export type StackPart = { key: string; label: string; value: number; role: 'primary' | 'bad' | 'violet' | 'gold' | 'muted'; onPick?: () => void }
export function OutcomeStack({ parts, total, format }: { parts: StackPart[]; total: number; format: (n: number) => string }) {
  const sum = total || parts.reduce((a, p) => a + p.value, 0) || 1
  return (
    <div className="lab-stack">
      <div className="lab-stack__bar" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(', ')}>
        {parts.filter((p) => p.value > 0).map((p) => <i key={p.key} className={`r-${p.role}`} style={{ flexGrow: p.value } as CSSProperties} title={`${p.label}: ${format(p.value)} (${((p.value / sum) * 100).toFixed(1)}%)`} />)}
      </div>
      <ul className="lab-stack__legend">
        {parts.map((p) => (
          <li key={p.key}>
            <button type="button" onClick={p.onPick} disabled={!p.onPick || !p.value}>
              <i className={`r-${p.role}`} /><span>{p.label}</span><b>{format(p.value)}</b><em>{((p.value / sum) * 100).toFixed(1)}%</em>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
