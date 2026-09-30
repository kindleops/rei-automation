/**
 * OVERVIEW — THE MACHINE. The calm first screen:
 *
 *   the period in plain language (every figure opens its inspector)   | The Period
 *   the KPI strip (value · delta in pts / % / absolute · explicit base)
 *   one large trend with a metric toggle, real grain, comparison and interval
 *   What Changed (tested) + contribution drill                       | the acquisition funnel
 *   one geographic signal (reply rate by market, with intervals and n)
 *
 * Nothing here counts; every value is the server's. A rate always shows its
 * numerator and denominator.
 */
import { useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { LabContext, LabOverview as Overview, MetricDef, RecordCohort, WhatChanged } from '../../../domain/analytics/analytics-lab-api'
import { fetchLabQuery, fmtCount, fmtMetric, fmtP, fmtRate } from '../../../domain/analytics/analytics-lab-api'
import type { LabActions } from './lab-state'
import { useLabData } from './lab-state'
import { Delta, Empty, StatusMark, cls } from './LabUi'
import { TrendChart, TrendTable } from './charts/TrendChart'
import { BreakdownTable, RankedBars } from './charts/Bars'
import { ContributionBridge } from './charts/Analytic'
import { fmtRangeShort } from './charts/chart-kit'

export type OpenRecords = (cohort: RecordCohort, title: string) => void

type Props = {
  ctx: LabContext
  act: LabActions
  data: Overview
  defs: Record<string, MetricDef>
  dims: Record<string, { label: string }>
  onInspect: (id: string) => void
  onRecords: OpenRecords
}

export function LabOverview({ ctx, act, data, defs, dims, onInspect, onRecords }: Props) {
  const tz = ctx.tz
  const cmpLabel = data.compare.available ? fmtRangeShort(data.compare.start, data.compare.end, tz) : null
  const curLabel = fmtRangeShort(data.period.start, data.period.end, tz)
  const [drill, setDrill] = useState<WhatChanged | null>(null)
  return (
    <div className="lab-ov">
      <section className="lab-sec lab-machine" aria-label="The machine">
        <span className="lab-eyebrow">The machine · {curLabel}</span>
        <div className="lab-story">
          {data.narrative.map((s, i) => (
            <p key={i}>
              {s.parts
                ? s.parts.map((p, k) => (p.metric
                  ? <button key={k} type="button" className="lab-fig" onClick={() => onInspect(p.metric as string)} title={`${defs[p.metric]?.label || p.metric} — definition, numerator, denominator`}>{p.text}</button>
                  : <span key={k}>{p.text}</span>))
                : s.text}
            </p>
          ))}
        </div>
      </section>

      <ThePeriod data={data} tz={tz} curLabel={curLabel} cmpLabel={cmpLabel} />

      <section className="lab-sec lab-strip" aria-label="Key metrics">
        {data.strip.map((m) => {
          const def = defs[m.id]
          const rate = def?.unit === 'rate'
          return (
            <button key={m.id} type="button" className={cls('lab-kpi', m.cur.status !== 'ok' && `s-${m.cur.status}`, ctx.metric === m.id && 'is-trend')} onClick={() => onInspect(m.id)}>
              <span className="lab-kpi__label">{def?.short || m.id}</span>
              <b className="lab-kpi__value">{m.cur.status === 'not_applicable' || m.cur.status === 'unavailable' ? '—' : fmtMetric(def, m.cur.value)}</b>
              <span className="lab-kpi__base">
                {rate && m.cur.den !== undefined ? <>{fmtCount(m.cur.num)} / {fmtCount(m.cur.den)}</> : def?.unit === 'duration_min' && m.cur.n !== undefined ? <>n = {fmtCount(m.cur.n)}</> : def?.unit === 'count' ? <>{def.entity === 'seller' ? 'sellers' : def.entity === 'transition' ? 'events' : def.entity === 'run' ? 'runs' : 'records'}</> : null}
              </span>
              <span className="lab-kpi__delta">{m.cur.status === 'ok' || m.cur.status === 'insufficient_sample' ? <Delta def={def} change={m.change} compact /> : null}<StatusMark status={m.cur.status} reason={m.cur.reason} n={m.cur.n} /></span>
            </button>
          )
        })}
      </section>

      <TrendPanel ctx={ctx} act={act} data={data} defs={defs} curLabel={curLabel} cmpLabel={cmpLabel} onRecords={onRecords} />

      <section className="lab-sec lab-changes" aria-label="What changed">
        <header className="lab-sec__head"><h2>What changed</h2><span>{data.compare.available ? `vs ${cmpLabel} · tested at p < 0.05 with minimum samples` : 'no comparison window'}</span></header>
        {!data.compare.available ? <p className="lab-note">{data.compare.reason || 'Choose a comparison window to see what changed.'}</p>
          : data.changes.length ? (
            <ul className="lab-chg">
              {data.changes.map((c) => {
                const def = defs[c.id]
                const tone = c.polarity === 'neutral' ? 'neutral' : ((c.kind === 'rate' ? c.pts ?? 0 : c.delta ?? 0) > 0) === (c.polarity === 'up') ? 'good' : 'bad'
                const d = c.kind === 'rate' ? c.pts ?? 0 : c.delta ?? 0
                return (
                  <li key={c.id}>
                    <button type="button" className={cls(drill?.id === c.id && 'is-on')} onClick={() => setDrill((x) => (x?.id === c.id ? null : c))}>
                      <i className={`lab-dot t-${tone}`} aria-hidden="true" />
                      <span className="lab-chg__what"><b>{c.label}</b><em>{fmtMetric(def, c.prev)} → {fmtMetric(def, c.cur)}</em></span>
                      <strong className={`t-${tone}`}>{d > 0 ? '▲' : '▼'} {c.kind === 'rate' ? `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} pts` : `${d > 0 ? '+' : '−'}${fmtCount(Math.abs(d))}${c.pct !== null ? ` (${c.pct > 0 ? '+' : '−'}${Math.abs(c.pct * 100).toFixed(0)}%)` : ''}`}</strong>
                      <small>{fmtP(c.p)}{c.ciPts ? ` · 95% CI ${c.ciPts[0] > 0 ? '+' : ''}${c.ciPts[0].toFixed(1)} to ${c.ciPts[1] > 0 ? '+' : ''}${c.ciPts[1].toFixed(1)} pts` : ''}</small>
                      {c.top ? <span className="lab-chg__top">Largest contribution · {c.top.dimLabel.toLowerCase()} <b>{c.top.label}</b> ({c.top.kind === 'rate' ? `${c.top.value > 0 ? '+' : '−'}${Math.abs(c.top.value).toFixed(1)} pts` : `${c.top.value > 0 ? '+' : '−'}${fmtCount(Math.abs(c.top.value))}`})</span> : null}
                      <Icon name="chevron-right" />
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : <p className="lab-note">No statistically meaningful change against {cmpLabel}. Every KPI moved within normal variation or lacks the minimum sample on one side.</p>}
      </section>

      <Funnel data={data} defs={defs} onInspect={onInspect} />

      {drill ? <ContributionPanel ctx={ctx} change={drill} def={defs[drill.id]} dims={dims} curLabel={curLabel} cmpLabel={cmpLabel || ''} onClose={() => setDrill(null)} onSegment={(dim, key, label) => act.pushSegment({ dim, value: key, label })} onRecords={onRecords} /> : null}

      <section className="lab-sec lab-geo" aria-label="Reply rate by market">
        <header className="lab-sec__head">
          <h2>Where sellers answer</h2>
          <span>reply rate by canonical market · 95% interval · faded below n = {defs.reply_rate?.min_sample ?? 30}</span>
          <button type="button" className="lab-ctl is-quiet" onClick={() => act.setMode('geography')}><Icon name="map" />Geography</button>
        </header>
        {data.geo.rows.length ? (
          <RankedBars
            rows={data.geo.rows} unit="rate" format={(v) => fmtRate(v)} maxRows={8}
            onPick={(r) => act.pushSegment({ dim: 'market', value: r.key, label: r.label })}
            onRecords={(r) => onRecords({ metric: 'reply_rate', part: 'denominator', group: { dim: 'market', key: r.key, label: r.label } }, `Sellers reached · ${r.label}`)}
          />
        ) : <p className="lab-note">No market has reached sellers in this slice.</p>}
        {data.geo.unresolved ? <p className="lab-note">{data.geo.unresolved} seller{data.geo.unresolved === 1 ? '' : 's'} could not be placed in a canonical market (counted, never assigned).</p> : null}
      </section>

      {ctx.groupBy ? <BreakdownPanel ctx={ctx} act={act} def={defs[ctx.metric]} dimLabel={dims[ctx.groupBy]?.label || ctx.groupBy} onRecords={onRecords} /> : null}
    </div>
  )
}

/* ── The Period ─────────────────────────────────────────────────────────── */

const EXCLUSION_LABEL: Record<string, string> = {
  canarySends: 'canary messages', canaryInbound: 'canary replies', unattributableInbound: 'replies with no seller thread', syntheticHistory: 'certification history rows',
  replayRuns: 'replay-only runs', testCampaignMessages: 'test-campaign messages', voidedClosings: 'voided closing cases',
}
function ThePeriod({ data, tz, curLabel, cmpLabel }: { data: Overview; tz: string; curLabel: string; cmpLabel: string | null }) {
  const p = data.thePeriod
  const asOf = p.freshness.dataAsOf ? new Date(p.freshness.dataAsOf).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }) : '—'
  const exclusions = Object.entries(p.exclusions).filter(([, n]) => n > 0)
  return (
    <aside className="lab-sec lab-period" aria-label="The period">
      <span className="lab-eyebrow">The period</span>
      <dl className="lab-spec">
        <div><dt>Period</dt><dd>{curLabel} · {Math.round(data.period.days)} days{data.period.coverage === 'partial' ? ' · starts before history' : ''}</dd></div>
        <div><dt>Compared with</dt><dd>{cmpLabel ? `${cmpLabel}${data.compare.partial ? ' · partial history' : ''}` : data.compare.reason || 'No comparison'}</dd></div>
        <div><dt>Cohort</dt><dd>{fmtCount(p.cohort.sellers)} sellers · {fmtCount(p.cohort.messages)} messages · {fmtCount(p.cohort.replies)} repliers · {fmtCount(p.cohort.transitions)} pipeline events · {fmtCount(p.cohort.runs)} autopilot runs</dd></div>
        <div><dt>Data as of</dt><dd>{asOf} · live sources, cached 90 s</dd></div>
        {exclusions.length ? <div><dt>Excluded</dt><dd>{exclusions.map(([k, n]) => `${fmtCount(n)} ${EXCLUSION_LABEL[k] || k}`).join(' · ')}</dd></div> : null}
        <div><dt>Definitions</dt><dd>{data.version} · every figure opens its numerator, denominator and source</dd></div>
      </dl>
      {p.caveats.length ? <ul className="lab-caveats">{p.caveats.map((c) => <li key={c}>{c}</li>)}</ul> : null}
    </aside>
  )
}

/* ── the primary trend ──────────────────────────────────────────────────── */

function TrendPanel({ ctx, act, data, defs, curLabel, cmpLabel, onRecords }: { ctx: LabContext; act: LabActions; data: Overview; defs: Record<string, MetricDef>; curLabel: string; cmpLabel: string | null; onRecords: OpenRecords }) {
  const [asTable, setAsTable] = useState(false)
  const t = data.trend
  const def = defs[t.metric]
  const isSellerRate = def?.entity === 'seller' && def.unit === 'rate'
  const maturingFrom = isSellerRate && data.period.preset !== 'custom' ? Date.parse(data.period.end) - 72 * 3_600_000 : null
  const format = (v: number | null) => fmtMetric(def, v)
  const total = data.metrics[t.metric]?.cur
  return (
    <section className="lab-sec lab-trendpanel" aria-label="Trend">
      <header className="lab-sec__head">
        <h2>{def?.label || t.metric}</h2>
        <span>{t.grain === 'week' ? 'weekly' : t.grain === 'hour' ? 'hourly' : t.grain === 'month' ? 'monthly' : 'daily'}{def?.entity === 'seller' ? ' · sellers bucketed by the day they were reached' : ''}{total && total.status !== 'not_applicable' ? ` · period ${format(total.value)}${def?.unit === 'rate' && total.den !== undefined ? ` (${fmtCount(total.num)}/${fmtCount(total.den)})` : ''}` : ''}</span>
        <div className="lab-sec__tools">
          <button type="button" className={cls('lab-ctl is-quiet', asTable && 'is-on')} onClick={() => setAsTable((x) => !x)} aria-pressed={asTable}><Icon name={asTable ? 'stats' : 'list'} />{asTable ? 'Chart' : 'Table'}</button>
        </div>
      </header>
      <div className="lab-metricpick" role="tablist" aria-label="Trend metric">
        {t.options.map((id) => <button key={id} type="button" role="tab" aria-selected={t.metric === id} className={cls(t.metric === id && 'is-on')} onClick={() => act.set({ metric: id, groupBy: ctx.groupBy && defs[id]?.dimensions.includes(ctx.groupBy) ? ctx.groupBy : null })}>{defs[id]?.short || id}</button>)}
      </div>
      {asTable
        ? <TrendTable current={t.current} comparison={t.comparison} grain={t.grain} tz={ctx.tz} format={format} unit={def?.unit || 'count'} />
        : (
          <TrendChart
            current={t.current} comparison={t.comparison} unit={def?.unit || 'count'} grain={t.grain} tz={ctx.tz} format={format}
            label={def?.label || t.metric} currentLabel={curLabel} compareLabel={cmpLabel} minSample={def?.min_sample} maturingFrom={maturingFrom} height={280}
            onPick={(_, p) => onRecords({ metric: t.metric, part: def?.unit === 'rate' ? 'numerator' : undefined, bucket: { start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString() } }, `${def?.label || t.metric} · ${new Date(p.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)}
          />
        )}
      {maturingFrom ? <p className="lab-note">The shaded tail holds sellers reached in the last 72 hours — they have had less time to reply, so their rate is still maturing (the comparison window is measured by the identical rule).</p> : null}
    </section>
  )
}

/* ── funnel ─────────────────────────────────────────────────────────────── */

function Funnel({ data, defs, onInspect }: { data: Overview; defs: Record<string, MetricDef>; onInspect: (id: string) => void }) {
  const f = data.funnel
  const top = f.steps[0]?.value || 0
  return (
    <section className="lab-sec lab-funnel" aria-label="Acquisition funnel">
      <header className="lab-sec__head"><h2>Acquisition funnel</h2><span>the period’s reached cohort</span></header>
      <ol className="lab-fun">
        {f.steps.map((s, i) => (
          <li key={s.id}>
            <button type="button" onClick={() => onInspect(s.id)} title={defs[s.id]?.description}>
              <span className="lab-fun__label">{s.label}{s.note ? <small>{s.note}</small> : null}</span>
              <span className="lab-fun__bar"><i style={{ width: `${top ? Math.max(1.5, ((s.value ?? 0) / top) * 100) : 0}%` }} /></span>
              <b>{fmtCount(s.value)}</b>
              <em>{i === 0 ? '' : s.conversion !== null ? fmtRate(s.conversion) : '—'}</em>
            </button>
          </li>
        ))}
      </ol>
      <div className="lab-fun__events">
        {f.events.map((e) => (
          <button key={e.id} type="button" onClick={() => onInspect(e.id)} title={e.caveat || undefined}>
            <span>{e.label}</span><b>{e.status === 'ok' ? fmtCount(e.value) : '—'}</b>
          </button>
        ))}
      </div>
      <p className="lab-note">{f.note}{f.events.every((e) => e.value === 0) ? ' The offer ledger holds one record ever (a withdrawn seller counter) and the closing desk none — zero here is an empty ledger, not a failing funnel.' : ''}</p>
    </section>
  )
}

/* ── contribution drill ─────────────────────────────────────────────────── */

function ContributionPanel({ ctx, change, def, dims, curLabel, cmpLabel, onClose, onSegment, onRecords }: {
  ctx: LabContext; change: WhatChanged; def?: MetricDef; dims: Record<string, { label: string }>; curLabel: string; cmpLabel: string
  onClose: () => void; onSegment: (dim: string, key: string, label: string) => void; onRecords: OpenRecords
}) {
  const [dim, setDim] = useState(change.top?.dim || change.drill[0] || 'market')
  const q = useLabData(`contrib|${change.id}|${dim}|${JSON.stringify([ctx.range, ctx.compare, ctx.filters, ctx.segment, ctx.tz])}`, (signal) => fetchLabQuery({ ...ctx, metric: change.id, groupBy: dim, limit: 10 }, 'contribution', signal))
  const r = q.data?.result
  const isRate = change.kind === 'rate'
  const format = (v: number | null) => fmtMetric(def, v)
  return (
    <section className="lab-sec lab-drill" aria-label={`What contributed to the change in ${change.label}`}>
      <header className="lab-sec__head">
        <h2>{change.label}: what contributed to the observed change</h2>
        <span>{cmpLabel} → {curLabel} · contributions sum exactly to the change · association, not cause</span>
        <div className="lab-sec__tools"><button type="button" className="lab-ctl is-quiet" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div>
      </header>
      <div className="lab-dimpick" role="tablist" aria-label="Contribution by">
        {change.drill.map((d) => <button key={d} type="button" role="tab" aria-selected={dim === d} className={cls(dim === d && 'is-on')} onClick={() => setDim(d)}>{dims[d]?.label || d}</button>)}
      </div>
      <div className={cls('lab-drill__body', q.loading && 'is-refreshing')}>
        {q.error ? <p className="lab-note is-bad">{q.error}</p> : null}
        {r && r.available === false ? <p className="lab-note">{r.reason}</p> : null}
        {r && r.available !== false && Array.isArray(r.rows) ? (
          <ContributionBridge
            kind={isRate ? 'rate' : 'count'}
            start={change.prev ?? 0} end={change.cur ?? 0}
            rows={r.rows as never} others={r.others || 0} polarity={change.polarity} format={format}
            startLabel={`${cmpLabel}`} endLabel={`${curLabel}`}
            onRow={(row) => (row.key === '__unresolved' || row.key === '__none' ? null : onSegment(dim, row.key, row.label))}
          />
        ) : !q.error && !r ? <p className="lab-note">Decomposing…</p> : null}
        {isRate ? <p className="lab-note">Each group’s contribution = its share of {def?.denominator?.label || 'the denominator'} × its change in rate (rate effect) + its change in share × its rate (mix effect). Click a group to drill into it.</p> : <p className="lab-note">Each group’s contribution is its own change in count. Click a group to drill into it.</p>}
        <div className="lab-drill__actions">
          <button type="button" className="lab-ctl" onClick={() => onRecords({ metric: change.id, part: isRate ? 'numerator' : undefined }, `${change.label} · current period`)}><Icon name="list" />Current records</button>
          <button type="button" className="lab-ctl" onClick={() => onRecords({ metric: change.id, part: isRate ? 'numerator' : undefined, window: 'comparison' }, `${change.label} · comparison period`)}><Icon name="clock" />Comparison records</button>
        </div>
      </div>
    </section>
  )
}

/* ── breakdown by the chosen group ──────────────────────────────────────── */

function BreakdownPanel({ ctx, act, def, dimLabel, onRecords }: { ctx: LabContext; act: LabActions; def?: MetricDef; dimLabel: string; onRecords: OpenRecords }) {
  const [asTable, setAsTable] = useState(false)
  const q = useLabData(`bd|${JSON.stringify([ctx.metric, ctx.groupBy, ctx.range, ctx.compare, ctx.filters, ctx.segment, ctx.tz])}`, (signal) => fetchLabQuery({ ...ctx, limit: 60 }, 'breakdown', signal))
  const rows = useMemo(() => (q.data?.result?.rows || []) as import('../../../domain/analytics/analytics-lab-api').BreakdownRow[], [q.data])
  const unit = def?.unit || 'count'
  const format = (v: number | null) => fmtMetric(def, v)
  const status = q.data?.metric?.cur?.status
  return (
    <section className="lab-sec lab-breakdown" aria-label={`${def?.label} by ${dimLabel}`}>
      <header className="lab-sec__head">
        <h2>{def?.label} by {dimLabel.toLowerCase()}</h2>
        <span>{unit === 'rate' ? '95% interval · prior-period tick' : 'prior-period tick'} · test campaigns never rank</span>
        <div className="lab-sec__tools"><button type="button" className={cls('lab-ctl is-quiet', asTable && 'is-on')} onClick={() => setAsTable((x) => !x)}><Icon name={asTable ? 'stats' : 'list'} />{asTable ? 'Chart' : 'Table'}</button></div>
      </header>
      <div className={cls(q.loading && 'is-refreshing')}>
        {q.error ? <p className="lab-note is-bad">{q.error}</p> : null}
        {status === 'not_applicable' || status === 'unavailable' ? <Empty title={def?.label || ''}>{q.data?.metric?.cur?.reason}</Empty> : null}
        {rows.length ? (asTable
          ? <BreakdownTable rows={rows} unit={unit} format={format} dimLabel={dimLabel} />
          : <RankedBars rows={rows} unit={unit} format={format} maxRows={14}
            onPick={(r) => act.pushSegment({ dim: ctx.groupBy as string, value: r.key, label: r.label })}
            onRecords={(r) => onRecords({ metric: ctx.metric, part: unit === 'rate' ? 'numerator' : undefined, group: { dim: ctx.groupBy as string, key: r.key, label: r.label } }, `${def?.label} · ${r.label}`)} />)
          : !q.loading && !q.error && status !== 'not_applicable' ? <p className="lab-note">No rows in this slice.</p> : null}
        {q.data?.result?.truncated ? <p className="lab-note">Showing the top {rows.length} of {q.data.result.total}.</p> : null}
      </div>
    </section>
  )
}
