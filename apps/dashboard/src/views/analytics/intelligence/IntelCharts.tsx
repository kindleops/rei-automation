/**
 * ANALYTICS 4.0 — the Lab's compact chart vocabulary. Each form answers one
 * kind of question and nothing else:
 *
 *   RankedBars       which group is larger (counts) / which rate is credible (forest: dot + 95% interval)
 *   Bridge           what contributed to an observed change (sums exactly to it; association, not cause)
 *   RhythmHeat       when (seller-local weekday × hour)
 *   StackColumns     how a count splits over time (parts always sum to the whole)
 *   AgeRanges        how long live deals have sat in each stage (min · P25–P75 · median · P90)
 *   OutcomeBar       one whole, additively split (≤ 7 parts, each labelled)
 *   LatencyHistogram how long sellers take to answer (log bins, percentiles, n)
 *
 * Every mark is a button where it leads somewhere; colour is a role, never an
 * index; text never wears the data colour.
 */
import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { BreakdownRow, ContributionRow, Heatmap, Histogram } from '../../../domain/analytics/analytics-lab-api'
import { cx } from '../../../shared/lc'
import type { SeriesByResult } from './intel-model'
import { clamp, fmtBucket, fmtInt, niceTicks, seqColor } from './intel-format'

type Unit = 'count' | 'rate' | 'ratio' | 'duration_min'
const pctOf = (v: number | null | undefined, hi: number) => `${(clamp((v ?? 0) / (hi || 1), 0, 1) * 100).toFixed(2)}%`

/* ── ranked bars / forest ───────────────────────────────────────────────── */

export function RankedBars({ rows, unit, format, onPick, onRecords, maxRows = 12, showPrev = true, selected, compact }: {
  rows: BreakdownRow[]; unit: Unit; format: (v: number | null) => string; onPick?: (r: BreakdownRow) => void; onRecords?: (r: BreakdownRow) => void
  maxRows?: number; showPrev?: boolean; selected?: string | null; compact?: boolean
}) {
  const shown = rows.slice(0, maxRows)
  const isRate = unit === 'rate'
  // the scale belongs to THIS period; a previous period far larger than anything now
  // (e.g. a volume the system no longer runs) is clipped at the edge and printed, so
  // it never shrinks every current bar to a sliver
  const curMax = Math.max(isRate ? 0.05 : 1, ...shown.flatMap((r) => [r.value ?? 0, isRate && r.ci ? r.ci.high : 0]))
  const prevMax = showPrev ? Math.max(0, ...shown.map((r) => r.prev?.value ?? 0)) : 0
  const { hi, ticks } = niceTicks(0, prevMax <= curMax * 2.5 ? Math.max(curMax, prevMax) : curMax, 3)
  return (
    <div className={cx('ixb', isRate && 'is-forest', compact && 'is-compact')} role="table" aria-label="Breakdown">
      <div className="ixb__axis" role="row" aria-hidden="true">
        <span />
        <span className="ixb__scale">{ticks.map((t) => <i key={t} style={{ left: pctOf(t, hi) }}>{format(t)}</i>)}</span>
        <span />
      </div>
      {shown.map((r) => {
        const small = Boolean(r.insufficient)
        const named = r.key !== '__unresolved' && r.key !== '__none'
        return (
          <div key={r.key} role="row" className={cx('ixb__row', small && 'is-small', r.test && 'is-test', !named && 'is-unresolved', selected === r.key && 'is-on')}>
            <button type="button" role="rowheader" className="ixb__label" onClick={() => onPick?.(r)} disabled={!onPick || r.test || !named} title={onPick && named && !r.test ? `Narrow the Lab to ${r.label}` : r.label}>
              <b>{r.label}</b>{r.test ? <em className="ix-tag">test · not ranked</em> : null}
            </button>
            <span className="ixb__track" role="cell">
              {ticks.map((t) => <i key={t} className="ixb__grid" style={{ left: pctOf(t, hi) }} />)}
              {isRate ? (
                <>
                  {r.ci && r.n > 0 ? <i className="ixb__ci" style={{ left: pctOf(r.ci.low, hi), width: `calc(${pctOf(r.ci.high, hi)} - ${pctOf(r.ci.low, hi)})` }} /> : null}
                  {r.value !== null ? <i className="ixb__dot" style={{ left: pctOf(r.value, hi) }} /> : null}
                </>
              ) : <i className="ixb__bar" style={{ width: pctOf(r.value, hi) }} />}
              {showPrev && r.prev && r.prev.value !== null ? <i className={cx('ixb__prev', r.prev.value > hi && 'is-off')} style={{ left: pctOf(Math.min(r.prev.value, hi), hi) }} title={`Previous period: ${format(r.prev.value)}`} /> : null}
            </span>
            <button type="button" role="cell" className="ixb__val" onClick={() => onRecords?.(r)} disabled={!onRecords} title={onRecords ? 'Open the records' : undefined}>
              <b>{format(r.value)}</b>
              <span>{isRate ? `${fmtInt(r.num)}/${fmtInt(r.den)}` : unit === 'count' ? '' : `n=${fmtInt(r.n)}`}{small ? ' · small n' : ''}{showPrev && r.prev && r.prev.value !== null && r.prev.value > hi ? `${isRate || unit !== 'count' ? ' · ' : ''}was ${format(r.prev.value)}` : ''}</span>
            </button>
          </div>
        )
      })}
      {rows.length > shown.length ? <p className="ix-note">{rows.length - shown.length} more — open the table view for all.</p> : null}
    </div>
  )
}

/* ── contribution bridge ────────────────────────────────────────────────── */

export function Bridge({ kind, start, end, rows, others, polarity, format, startLabel, endLabel, onRow }: {
  kind: 'rate' | 'count'; start: number; end: number; rows: ContributionRow[]; others: number; polarity: 'up' | 'down' | 'neutral'
  format: (v: number | null) => string; startLabel: string; endLabel: string; onRow?: (row: ContributionRow) => void
}) {
  const unit = kind === 'rate' ? 0.01 : 1 // pts → rate
  const steps: Array<{ key: string; label: string; from: number; to: number; row?: ContributionRow; total?: boolean }> = []
  let run = start
  steps.push({ key: '__start', label: startLabel, from: start, to: start, total: true })
  for (const r of rows) {
    const c = (kind === 'rate' ? r.contributionPts ?? 0 : r.contribution ?? 0) * unit
    steps.push({ key: r.key, label: r.label, from: run, to: run + c, row: r })
    run += c
  }
  if (Math.abs(others) > 1e-9) { steps.push({ key: '__others', label: 'All other groups', from: run, to: run + others * unit }); run += others * unit }
  steps.push({ key: '__end', label: endLabel, from: end, to: end, total: true })
  const lo = Math.min(...steps.flatMap((s) => [s.from, s.to]))
  const hiV = Math.max(...steps.flatMap((s) => [s.from, s.to]))
  const pad = (hiV - lo) * 0.08 || (kind === 'rate' ? 0.005 : 1)
  const dLo = Math.max(0, lo - pad)
  const dHi = hiV + pad
  const pos = (v: number) => `${(clamp((v - dLo) / (dHi - dLo || 1), 0, 1) * 100).toFixed(2)}%`
  const tone = (d: number) => (!d || polarity === 'neutral' ? 'neutral' : (d > 0) === (polarity === 'up') ? 'good' : 'bad')
  const fmtD = (d: number) => (kind === 'rate' ? `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d * 100).toFixed(2)} pts` : `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(Math.round(d)).toLocaleString('en-US')}`)
  return (
    <div className="ixbr" role="table" aria-label="Contribution to the observed change">
      {steps.map((s) => {
        const d = s.to - s.from
        const named = s.row && s.row.key !== '__unresolved' && s.row.key !== '__none'
        return (
          <div key={s.key} role="row" className={cx('ixbr__row', s.total && 'is-total')}>
            <button type="button" role="rowheader" className="ixbr__label" disabled={!named || !onRow || s.row?.test} onClick={() => s.row && onRow?.(s.row)} title={named ? `Narrow the Lab to ${s.label}` : s.label}>{s.label}</button>
            <span className="ixbr__track" role="cell">
              {s.total
                ? <i className="ixbr__mark" style={{ left: pos(s.to) }} />
                : <i className={`ixbr__bar is-${tone(d)}`} style={{ left: pos(Math.min(s.from, s.to)), width: `max(2px, calc(${pos(Math.max(s.from, s.to))} - ${pos(Math.min(s.from, s.to))}))` }} />}
            </span>
            <span role="cell" className={cx('ixbr__val', !s.total && `is-${tone(d)}`)}>
              {s.total ? <b>{format(s.to)}</b> : <><b>{fmtD(d)}</b>{s.row && kind === 'rate' && typeof s.row.rateEffectPts === 'number' ? <span>rate {s.row.rateEffectPts >= 0 ? '+' : '−'}{Math.abs(s.row.rateEffectPts).toFixed(2)} · mix {(s.row.mixEffectPts ?? 0) >= 0 ? '+' : '−'}{Math.abs(s.row.mixEffectPts ?? 0).toFixed(2)}</span> : null}</>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/* ── weekday × hour rhythm (seller-local) ───────────────────────────────── */

const ORDER = [1, 2, 3, 4, 5, 6, 0] // Monday first
export function RhythmHeat({ data, isRate, format, minSample = 20, onCell }: { data: Heatmap; isRate: boolean; format: (v: number | null) => string; minSample?: number; onCell?: (weekday: number, hour: number) => void }) {
  const [hover, setHover] = useState<{ w: number; h: number } | null>(null)
  const max = useMemo(() => {
    let m = 0
    for (const row of data.cells) for (const c of row) if (c.value !== null && (!isRate || c.den >= Math.max(3, minSample / 4))) m = Math.max(m, c.value)
    return m || 1
  }, [data, isRate, minSample])
  const cell = hover ? data.cells[hover.w][hover.h] : null
  let total = 0
  for (const row of data.cells) for (const c of row) total += isRate ? c.den : c.n
  return (
    <div className="ixh">
      <div className="ixh__grid" role="grid" aria-label={`Weekday by hour, seller-local time. ${fmtInt(total)} ${isRate ? 'in the base' : 'records'}.`}>
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="ixh__hour" aria-hidden="true">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>)}
        {ORDER.map((w) => (
          <div key={w} role="row" className="ixh__row">
            <span className="ixh__day">{data.weekdays[w]}</span>
            {data.cells[w].map((c, h) => {
              const thin = isRate ? c.den < minSample : false
              const empty = isRate ? c.den === 0 : c.n === 0
              const t = c.value === null ? 0 : c.value / max
              return (
                <button
                  key={h} type="button" role="gridcell"
                  className={cx('ixh__cell', thin && 'is-thin', empty && 'is-empty', hover?.w === w && hover?.h === h && 'is-on')}
                  style={{ background: empty ? undefined : seqColor(0.12 + 0.88 * t) } as CSSProperties}
                  aria-label={`${data.weekdays[w]} ${String(h).padStart(2, '0')}:00 — ${empty ? 'no records' : `${format(c.value)}${isRate ? ` (${c.num} of ${c.den})` : ''}`}`}
                  onPointerEnter={() => setHover({ w, h })} onFocus={() => setHover({ w, h })} onPointerLeave={() => setHover(null)}
                  onClick={() => { if (!empty) onCell?.(w, h) }} disabled={empty}
                />
              )
            })}
          </div>
        ))}
      </div>
      <div className="ixh__foot">
        <span className="ixh__legend" aria-hidden="true"><i style={{ background: seqColor(0.14) }} />low<i style={{ background: seqColor(0.56) }} /><i style={{ background: seqColor(1) }} />high · {format(max)}</span>
        {isRate ? <span className="ixh__legend"><i className="is-thin" />n &lt; {minSample}</span> : null}
        <span className="ixh__read" aria-live="polite">{cell && hover ? `${data.weekdays[hover.w]} ${String(hover.h).padStart(2, '0')}:00 · ${format(cell.value)}${isRate ? ` · ${cell.num} of ${cell.den}` : ` · ${cell.n}`}` : `${data.unresolved ? `${fmtInt(data.unresolved)} without a resolvable local time · ` : ''}${data.basis}`}</span>
      </div>
    </div>
  )
}

/* ── stacked columns over time (counts split by one dimension) ──────────── */

export type StackRole = { key: string; label: string; tone: string }
export function StackColumns({ result, roles, grain, tz, height = 180, onPick, label }: {
  result: SeriesByResult; roles: StackRole[]; grain: string; tz: string; height?: number; onPick?: (bucket: { start: number; end: number }, key?: string) => void; label: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const buckets = result.buckets || []
  const known = new Set(roles.map((r) => r.key))
  const order = [...roles.filter((r) => (result.keys || []).some((k) => k.key === r.key)), ...(result.keys || []).filter((k) => !known.has(k.key)).map((k) => ({ key: k.key, label: k.label, tone: 'neutral' })), ...((result.other || 0) > 0 ? [{ key: '__other', label: 'Everything else', tone: 'neutral' }] : [])]
  const max = Math.max(1, ...buckets.map((b) => b.total))
  const { hi, ticks } = niceTicks(0, max, 3)
  const hb = hover !== null ? buckets[hover] : null
  return (
    <div className="ixs">
      <div className="ixs__plot" style={{ height }} role="group" aria-label={label} onPointerLeave={() => setHover(null)}>
        <div className="ixs__grid" aria-hidden="true">{ticks.slice(1).map((t) => <i key={t} style={{ bottom: `${(t / hi) * 100}%` }}><em>{fmtInt(t)}</em></i>)}</div>
        <div className="ixs__cols">
          {buckets.map((b, i) => (
            <button key={b.start} type="button" className={cx('ixs__col', hover === i && 'is-on')} onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onClick={() => onPick?.({ start: b.start, end: b.end })}
              aria-label={`${fmtBucket(b.start, grain, tz, true)}: ${b.total} total${order.map((o) => (b.values[o.key] ? `, ${o.label} ${b.values[o.key]}` : '')).join('')}`}>
              <span className="ixs__stack" style={{ height: `${(b.total / hi) * 100}%` }}>
                {order.map((o) => (b.values[o.key] ? <i key={o.key} data-tone={o.tone} style={{ flexGrow: b.values[o.key] }} /> : null))}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="ixs__axis" aria-hidden="true"><span>{buckets[0] ? fmtBucket(buckets[0].start, grain, tz) : ''}</span><span>{buckets.length ? fmtBucket(buckets[buckets.length - 1].start, grain, tz) : ''}</span></div>
      <ul className="ixs__legend">
        {order.map((o) => {
          const total = o.key === '__other' ? result.other || 0 : (result.keys || []).find((k) => k.key === o.key)?.total || 0
          return <li key={o.key}><i data-tone={o.tone} /><span>{o.label}</span><b>{hb ? fmtInt(hb.values[o.key] || 0) : fmtInt(total)}</b></li>
        })}
      </ul>
      <p className="ix-note ixs__read" aria-live="polite">{hb ? `${fmtBucket(hb.start, grain, tz, true)} · ${fmtInt(hb.total)} in all` : `${fmtInt(result.total)} in the period${result.otherGroups ? ` · ${result.otherGroups} smaller groups under “Everything else”` : ''}`}</p>
    </div>
  )
}

/* ── live stage age: min · P25–P75 · median · P90 per stage ─────────────── */

export function AgeRanges({ rows, onPick, maxDays }: {
  rows: Array<{ code: string; label: string; short: string; n: number; min: number | null; p25: number | null; p50: number | null; p75: number | null; p90: number | null; threshold: number | null; over: number }>
  onPick?: (code: string) => void; maxDays?: number
}) {
  const days = (m: number | null) => (m === null ? null : m / 1440)
  const top = maxDays || Math.max(10, ...rows.flatMap((r) => [days(r.p90) ?? 0, r.threshold ?? 0])) * 1.08
  const { ticks, hi } = niceTicks(0, top, 4)
  const at = (d: number | null) => `${(clamp((d ?? 0) / hi, 0, 1) * 100).toFixed(2)}%`
  return (
    <div className="ixa" role="table" aria-label="Age of live deals in each stage, in days">
      <div className="ixa__axis" role="row" aria-hidden="true"><span /><span className="ixa__scale">{ticks.map((t) => <i key={t} style={{ left: at(t) }}>{t}d</i>)}</span><span /></div>
      {rows.map((r) => (
        <div key={r.code} role="row" className={cx('ixa__row', !r.n && 'is-empty')}>
          <button type="button" role="rowheader" className="ixa__label" onClick={() => onPick?.(r.code)} disabled={!onPick}><span className="ix-stage">{r.short}</span>{r.label}</button>
          <span className="ixa__track" role="cell">
            {ticks.map((t) => <i key={t} className="ixa__grid" style={{ left: at(t) }} />)}
            {r.threshold ? <i className="ixa__clock" style={{ left: at(r.threshold) }} title={`Stage clock: ${r.threshold} days`} /> : null}
            {r.n ? (
              <>
                <i className="ixa__whisker" style={{ left: at(days(r.min)), width: `calc(${at(days(r.p90))} - ${at(days(r.min))})` }} />
                <i className="ixa__box" style={{ left: at(days(r.p25)), width: `max(3px, calc(${at(days(r.p75))} - ${at(days(r.p25))}))` }} />
                <i className="ixa__median" style={{ left: at(days(r.p50)) }} />
              </>
            ) : null}
          </span>
          <span role="cell" className="ixa__val">
            {r.n ? <><b>{(days(r.p50) as number).toFixed(1)}d</b><span>median · n={r.n}{r.threshold ? ` · ${r.over} > ${r.threshold}d` : ''}</span></> : <span>no live deals</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

/* ── one whole, additively split ────────────────────────────────────────── */

export function OutcomeBar({ parts, total, format = fmtInt, onPick, label }: {
  parts: Array<{ key: string; label: string; value: number; tone: string; hint?: string }>; total?: number; format?: (n: number) => string; onPick?: (key: string) => void; label: string
}) {
  const sum = total || parts.reduce((a, p) => a + p.value, 0) || 1
  return (
    <div className="ixo">
      <div className="ixo__bar" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${format(p.value)}`).join(', ')}`}>
        {parts.filter((p) => p.value > 0).map((p) => <i key={p.key} data-tone={p.tone} style={{ flexGrow: p.value }} title={`${p.label}: ${format(p.value)} (${((p.value / sum) * 100).toFixed(1)}%)`} />)}
      </div>
      <ul className="ixo__legend">
        {parts.map((p) => (
          <li key={p.key}>
            <button type="button" onClick={() => onPick?.(p.key)} disabled={!onPick || !p.value} title={p.hint}>
              <i data-tone={p.tone} /><span>{p.label}</span><b>{format(p.value)}</b><em>{((p.value / sum) * 100).toFixed(1)}%</em>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ── latency distribution ───────────────────────────────────────────────── */

export function LatencyHistogram({ data, format }: { data: Histogram; format: (v: number | null) => string }) {
  const bins = data.bins
  const maxC = Math.max(1, ...bins.map((b) => b.count))
  const pos = (v: number) => {
    if (!bins.length) return 0
    const i = bins.findIndex((b) => v <= b.to)
    const k = i < 0 ? bins.length - 1 : i
    const b = bins[k]
    const frac = b.to > b.from ? (v - b.from) / (b.to - b.from) : 0
    return ((k + clamp(frac, 0, 1)) / bins.length) * 100
  }
  const marks = [['median', data.dist.p50], ['P75', data.dist.p75], ['P90', data.dist.p90]] as const
  return (
    <div className="ixl" role="img" aria-label={`Reply latency: median ${format(data.dist.p50)}, P75 ${format(data.dist.p75)}, P90 ${format(data.dist.p90)}, n = ${data.dist.n}`}>
      <div className="ixl__plot">
        <div className="ixl__bars">{bins.map((b, i) => <i key={i} title={`${format(b.from)} – ${format(b.to)}: ${b.count}`} style={{ height: `${(b.count / maxC) * 100}%` }} />)}</div>
        {marks.map(([k, v]) => (v === null || v === undefined ? null : <span key={k} className="ixl__mark" style={{ left: `${pos(v)}%` }}><b>{k}</b>{format(v)}</span>))}
      </div>
      <div className="ixl__axis" aria-hidden="true"><span>0</span><span>{format(bins.length ? bins[Math.floor(bins.length / 2)].to : null)}</span><span>{format(bins.length ? bins[bins.length - 1].to : null)}</span></div>
      <p className="ix-note">n = {fmtInt(data.dist.n)} · log-spaced bins · median {format(data.dist.p50)} · P75 {format(data.dist.p75)} · P90 {format(data.dist.p90)}</p>
    </div>
  )
}
