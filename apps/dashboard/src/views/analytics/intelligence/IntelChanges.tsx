/**
 * WHAT CHANGED — concise deltas first, then the drivers.
 *
 * The server lists only changes its test calls meaningful (p < 0.05 with the
 * metric's minimum samples on both sides), ranked by p. Picking one runs the
 * contribution analysis for it: which market / campaign / sender / template /
 * failure class moved the number — for a rate, split into the change in each
 * group's rate and the change in its share of the base. Contributions sum
 * exactly to the change and say "contributed to", never "caused".
 * Every driver is a filter: one click narrows the whole Lab to it.
 */
import { useState } from 'react'
import type { ContributionRow, LabQuery, WhatChanged } from '../../../domain/analytics/analytics-lab-api'
import { fmtMetric, fmtP } from '../../../domain/analytics/analytics-lab-api'
import { LCSegmented, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { useLab } from './intel-context'
import { paths, useIntel } from './intel-data'
import { changeMagnitude, changeText, changeTone } from './intel-model'
import { fmtRange } from './intel-format'
import { serverContext } from './intel-state'
import { Bridge } from './IntelCharts'

export function IntelChanges({ variant = 'overview' }: { variant?: 'overview' | 'lens' }) {
  const { ctx, act, defs, dims, overview, records, inspect, refreshing } = useLab()
  const changes = (overview?.changes || []).slice(0, variant === 'lens' ? 8 : 6)
  const [picked, setPicked] = useState<string | null>(null)
  const change: WhatChanged | null = changes.find((c) => c.id === picked) || changes[0] || null
  const [dimPick, setDimPick] = useState<Record<string, string>>({})
  const dimsFor = change?.drill?.length ? change.drill : ['market']
  const dim = change ? (dimPick[change.id] && dimsFor.includes(dimPick[change.id]) ? dimPick[change.id] : change.top?.dim && dimsFor.includes(change.top.dim) ? change.top.dim : dimsFor[0]) : 'market'
  const q = useIntel<LabQuery>(change ? paths.query(serverContext(ctx, { metric: change.id, groupBy: dim, limit: 8 }), 'contribution') : null)
  const result = q.data?.result
  const def = change ? defs[change.id] : undefined
  const maxMag = Math.max(1e-9, ...changes.map((c) => changeMagnitude(c) / (c.kind === 'rate' ? 1 : Math.max(1, Math.abs(c.prev ?? 0) + Math.abs(c.cur ?? 0)))))
  const cmpLabel = overview?.compare.available ? fmtRange(overview.compare.start, overview.compare.end, ctx.tz) : ''
  const curLabel = overview ? fmtRange(overview.period.start, overview.period.end, ctx.tz) : ''

  return (
    <section className={cx('ix-changes lc-plane is-crystal is-d2', variant === 'lens' && 'is-lens', refreshing && 'is-refreshing')} data-under="attn" aria-label="What changed">
      <header className="ix-plane__head">
        <div>
          <span className="ix-eyebrow">What changed</span>
          <h2>{overview?.compare.available ? <>Against {cmpLabel}</> : 'No comparison window'}</h2>
        </div>
        <p className="ix-muted">tested at p &lt; 0.05 with minimum samples · association, not cause</p>
      </header>
      {!overview ? <div className="ix-skel-rows"><i /><i /><i /></div>
        : !overview.compare.available ? <p className="ix-note ix-pad">{overview.compare.reason || 'Choose a comparison window to see what changed.'}</p>
          : !changes.length ? <p className="ix-note ix-pad">No meaningful change against {cmpLabel}: every metric moved within normal variation or lacks the minimum sample on one side.</p>
            : (
              <div className="ix-changes__body">
                <ol className="ix-changes__list">
                  {changes.map((c) => {
                    const tone = changeTone(c)
                    const mag = changeMagnitude(c) / (c.kind === 'rate' ? 1 : Math.max(1, Math.abs(c.prev ?? 0) + Math.abs(c.cur ?? 0)))
                    return (
                      <li key={c.id}>
                        <button type="button" className={cx('ix-change', `is-${tone}`, change?.id === c.id && 'is-on')} onClick={() => setPicked(c.id)} aria-pressed={change?.id === c.id}>
                          <span className="ix-change__label">{c.label}</span>
                          <b className="ix-change__delta"><i aria-hidden="true">{tone === 'good' ? '▲' : tone === 'bad' ? '▼' : '•'}</i>{changeText(c)}</b>
                          <span className="ix-change__bar" aria-hidden="true"><i style={{ width: `${Math.max(4, (mag / maxMag) * 100)}%` }} /></span>
                          <small className="ix-change__from">{fmtMetric(defs[c.id], c.prev)} → {fmtMetric(defs[c.id], c.cur)}{fmtP(c.p) ? ` · ${fmtP(c.p)}` : ''}</small>
                        </button>
                      </li>
                    )
                  })}
                </ol>
                {change ? (
                  <div className="ix-changes__drivers">
                    <div className="ix-changes__dims">
                      <span className="ix-eyebrow">{change.label} · drivers by</span>
                      <LCSegmented label="Explain by" size="sm" value={dim} onChange={(d) => setDimPick((p) => ({ ...p, [change.id]: d }))} options={dimsFor.map((d) => ({ value: d, label: dims[d]?.label || d.replace(/_/g, ' ') }))} />
                    </div>
                    <div className={cx('ix-changes__bridge', q.stale && 'is-stale')}>
                      {q.loading && !q.data ? <div className="ix-skel-rows"><i /><i /><i /></div> : null}
                      {q.error && !q.data ? <p className="ix-note is-bad">Driver analysis didn’t load · {q.error}</p> : null}
                      {result && result.available === false ? <p className="ix-note">{result.reason || 'No driver analysis for this change.'}</p> : null}
                      {result && result.available !== false && Array.isArray(result.rows) ? (
                        <Bridge
                          kind={result.kind === 'rate' ? 'rate' : 'count'}
                          start={change.prev ?? 0}
                          end={change.cur ?? 0}
                          rows={(result.rows as ContributionRow[]).slice(0, variant === 'lens' ? 8 : 6)}
                          others={Number(result.others || 0)}
                          polarity={change.polarity}
                          format={(v) => fmtMetric(def, v)}
                          startLabel={cmpLabel}
                          endLabel={curLabel}
                          onRow={(row) => act.pushSegment({ dim, value: row.key, label: row.label })}
                        />
                      ) : null}
                    </div>
                    <p className="ix-note">{change.kind === 'rate' ? `Each group’s contribution = the change in its rate weighted by its share of ${def?.denominator?.label || 'the base'} (rate) + the change in its share (mix). Click a group to narrow the Lab to it.` : 'Each group’s contribution is its own change in count. Click a group to narrow the Lab to it.'}</p>
                    <div className="ix-changes__actions">
                      <button type="button" className="ix-link" onClick={() => records({ cohort: { metric: change.id, part: def?.unit === 'rate' ? 'numerator' : undefined, window: 'current' }, title: `${change.label} · ${curLabel}` })}><Icon name="list" size={12} />This period’s records</button>
                      <button type="button" className="ix-link" onClick={() => records({ cohort: { metric: change.id, part: def?.unit === 'rate' ? 'numerator' : undefined, window: 'comparison' }, title: `${change.label} · ${cmpLabel}` })}><Icon name="clock" size={12} />Comparison records</button>
                      <button type="button" className="ix-link" onClick={() => inspect({ kind: 'metric', id: change.id })}><Icon name="hash" size={12} />Definition</button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
    </section>
  )
}
