/**
 * AUTOMATION — how WELL the machine runs (Workflow Studio shows HOW it runs).
 *
 *   outcomes      every autopilot run ends in exactly one class: executed by
 *                 the system · routed to a person · auto-reply off · held by
 *                 the send gate (the system's own brake, not a failure) ·
 *                 stopped by policy · failed
 *   intervention  runs the autopilot itself routed to a person ÷ all runs —
 *                 an actual rate with its counts, never an "autonomy score"
 *   holds         canonical block_reason codes, as recorded
 *   ownership     who has the ball NOW on every live deal (Pipeline Command's
 *                 lanes) — and, over time, what the autopilot did with each
 *                 inbound (run outcomes per day)
 *   rhythm        daily volume (calendar) and the weekday × hour pattern,
 *                 seller-local, flat (a 3-D terrain would add nothing to read)
 *
 * Not captured anywhere canonical — so not shown: step-level execution time,
 * retries and approvals of the seller autopilot.
 */
import { useMemo, useState } from 'react'
import type { BreakdownRow, Heatmap, LabQuery, SeriesPoint } from '../../../domain/analytics/analytics-lab-api'
import { LCSegmented, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { ActivityHeatmap } from '../../../shared/arc/activity-heatmap/activity-heatmap'
import { useLab } from './intel-context'
import { paths, useIntel } from './intel-data'
import { metricFormat, metricTick, usePipelineData } from './intel-hooks'
import type { OrchestratorResult, SeriesByResult } from './intel-model'
import { LANES, RUN_CLASSES, alignTrend } from './intel-model'
import { fmtInt, fmtPct } from './intel-format'
import { serverContext } from './intel-state'
import { IntelTrend } from './IntelTrend'
import { OutcomeBar, RankedBars, RhythmHeat, StackColumns } from './IntelCharts'

const DAILY: ReadonlyArray<{ key: string; label: string; short: string; metric: string; part?: 'num' }> = [
  { key: 'runs', label: 'Autopilot runs', short: 'Runs', metric: 'autopilot_runs' },
  { key: 'replies', label: 'Seller replies', short: 'Replies', metric: 'sellers_replied' },
  { key: 'moves', label: 'Stage moves', short: 'Moves', metric: 'stage_advancements' },
  { key: 'failures', label: 'Delivery failures', short: 'Failures', metric: 'transport_failures' },
  { key: 'human', label: 'Runs routed to a person', short: 'Human', metric: 'human_intervention_rate', part: 'num' },
]
const RHYTHM: ReadonlyArray<{ key: string; label: string; metric: string }> = [
  { key: 'replies', label: 'Replies', metric: 'sellers_replied' },
  { key: 'sends', label: 'Sends', metric: 'messages_sent' },
  { key: 'runs', label: 'Autopilot', metric: 'autopilot_runs' },
  { key: 'failures', label: 'Failures', metric: 'transport_failures' },
]
const iso = (ms: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)

export function IntelAutomation({ variant = 'overview' }: { variant?: 'overview' | 'lens' }) {
  const { ctx, defs, overview, records, inspect, refreshing } = useLab()
  const base = serverContext(ctx, { metric: 'autopilot_runs', groupBy: null })
  const outQ = useIntel<LabQuery>(paths.query({ ...base, groupBy: 'hold_class', limit: 12 }, 'breakdown'))
  const reasonsQ = useIntel<LabQuery>(paths.query({ ...base, groupBy: 'block_reason', limit: 20 }, 'breakdown'))
  const hirQ = useIntel<LabQuery>(overview && variant === 'lens' ? paths.query(serverContext(ctx, { metric: 'human_intervention_rate', groupBy: null }), 'series') : null)
  const { money } = usePipelineData()
  const rows = (outQ.data?.result?.rows || []) as BreakdownRow[]
  const total = outQ.data?.metric?.cur?.value ?? null
  const hir = overview?.metrics.human_intervention_rate
  const hirPoints = useMemo(() => (hirQ.data?.result ? alignTrend((hirQ.data.result.current as SeriesPoint[]) || [], (hirQ.data.result.comparison as SeriesPoint[] | null) ?? null) : []), [hirQ.data])
  const [active, setActive] = useState<number | null>(null)
  const parts = RUN_CLASSES.map((c) => ({ key: c.key, label: c.label, value: rows.find((r) => r.key === c.key)?.value ?? 0, tone: c.tone })).filter((p) => p.value > 0 || ['executed', 'human_review', 'send_gate', 'failed'].includes(p.key))
  const lanes = money ? LANES.filter((l) => l.key !== 'complete' || money.totals.lanes.complete).map((l) => ({ key: l.key, label: l.label, value: money.totals.lanes[l.key] || 0, tone: l.tone, hint: l.hint })) : null

  return (
    <section className={cx('ix-auto lc-plane is-crystal is-d2', variant === 'lens' && 'is-lens', refreshing && 'is-refreshing')} data-under="flow" aria-label="Automation performance">
      <header className="ix-plane__head">
        <div>
          <span className="ix-eyebrow">Automation</span>
          <h2>How the autopilot handled every inbound</h2>
        </div>
        <button type="button" className="ix-link" onClick={() => pushRoutePath('/workflow-studio?seller_automation=1&workflow=seller-inbound-v1')}>Open Workflow Studio <Icon name="arrow-up-right" size={12} /></button>
      </header>

      <div className="ix-auto__lead">
        <div className="ix-auto__rate">
          <button type="button" className="ix-auto__ratebtn" onClick={() => inspect({ kind: 'metric', id: 'human_intervention_rate' })} title="Definition, counts and records">
            <span className="ix-eyebrow">Routed to a person</span>
            <b>{fmtPct(hir?.cur.value)}</b>
            <small>{hir ? `${fmtInt(hir.cur.num)} of ${fmtInt(hir.cur.den)} runs` : '—'}{hir?.change.comparable && typeof hir.change.pts === 'number' ? ` · ${hir.change.pts > 0 ? '+' : '−'}${Math.abs(hir.change.pts).toFixed(1)} pts${hir.change.significant ? '' : ' (within variation)'}` : ''}</small>
          </button>
          <p className="ix-note">The share of autopilot runs the autopilot itself sent to an operator (unclear, low confidence, missing context, relationship review). Not a failure rate: send-gate holds and policy stops are their own classes.</p>
        </div>
        <div className="ix-auto__outcomes">
          <div className="ix-subhead"><span className="ix-eyebrow">Run outcomes · {total !== null ? `${fmtInt(total)} runs` : '…'}</span></div>
          {rows.length ? <OutcomeBar label="Autopilot run outcomes" parts={parts} total={total ?? undefined} onPick={(key) => records({ cohort: { metric: 'autopilot_runs', group: { dim: 'hold_class', key, label: RUN_CLASSES.find((c) => c.key === key)?.label || key } }, title: `Autopilot runs · ${RUN_CLASSES.find((c) => c.key === key)?.label || key}` })} /> : outQ.loading ? <div className="ix-skel-rows"><i /><i /></div> : <p className="ix-note">No autopilot runs in this slice.</p>}
        </div>
      </div>

      <div className={cx('ix-duo', variant !== 'lens' && 'is-one')}>
        {variant === 'lens' ? <div className={cx(hirQ.stale && 'is-stale')}>
          <div className="ix-subhead"><span className="ix-eyebrow">Intervention over time</span><small className="ix-muted">runs routed to a person ÷ runs, per day</small></div>
          {hirPoints.length ? (
            <IntelTrend points={hirPoints} unit="rate" grain={String(hirQ.data?.result?.grain || 'day')} tz={ctx.tz} label="Human-intervention rate" format={metricFormat(defs.human_intervention_rate)} formatTick={metricTick(defs.human_intervention_rate)} height={180} minSample={defs.human_intervention_rate?.min_sample} showCompare={Boolean(overview?.compare.available)} active={active} onActive={setActive} tooltip compareLabel="Previous period" sampleLabel={defs.human_intervention_rate?.denominator?.label}
              onPick={(i) => { const p = hirPoints[i]; if (p) records({ cohort: { metric: 'human_intervention_rate', part: 'numerator', bucket: { start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString() } }, title: `Runs routed to a person · ${new Date(p.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` }) }} />
          ) : <div className="ix-skel-block is-short" />}
        </div> : null}
        <div>
          <div className="ix-subhead"><span className="ix-eyebrow">Why runs were held · canonical reason codes</span></div>
          {reasonsQ.data ? <RankedBars rows={((reasonsQ.data.result?.rows || []) as BreakdownRow[])} unit="count" format={(v) => fmtInt(v)} maxRows={variant === 'lens' ? 10 : 6} compact
            onRecords={(r) => records({ cohort: { metric: 'autopilot_runs', group: { dim: 'block_reason', key: r.key, label: r.label } }, title: `Autopilot runs · ${r.label}` })} /> : <div className="ix-skel-rows"><i /><i /><i /></div>}
        </div>
      </div>

      <div className="ix-auto__own">
        <div className="ix-subhead"><span className="ix-eyebrow">Who has the ball now · every live deal</span><small className="ix-muted">Pipeline Command’s waiting-on lanes</small></div>
        {lanes ? <OutcomeBar label="Ownership of live deals" parts={lanes} /> : <div className="ix-skel-rows"><i /><i /></div>}
      </div>

      {variant === 'lens' ? <AutomationDeep /> : null}
      <p className="ix-note">Not captured in a canonical store, so not shown: step-level execution time, retries and approvals for the seller autopilot.</p>
    </section>
  )
}

function AutomationDeep() {
  const { ctx, records } = useLab()
  const [daily, setDaily] = useState('runs')
  const [rhythm, setRhythm] = useState('replies')
  const d = DAILY.find((x) => x.key === daily) || DAILY[0]
  const r = RHYTHM.find((x) => x.key === rhythm) || RHYTHM[0]
  const stackQ = useIntel<LabQuery>(paths.query(serverContext(ctx, { metric: 'autopilot_runs', groupBy: 'hold_class', limit: 8 }), 'seriesBy'))
  const dayQ = useIntel<LabQuery>(paths.query(serverContext(ctx, { metric: d.metric, groupBy: null, grain: 'day' }), 'series'))
  const heatQ = useIntel<LabQuery>(paths.query(serverContext(ctx, { metric: r.metric, groupBy: null }), 'heatmap'))
  const wfQ = useIntel<LabQuery>(paths.query(serverContext(ctx, { metric: 'autopilot_runs', groupBy: null }), 'orchestrator'))
  const stack = stackQ.data?.result as unknown as SeriesByResult | null
  const days = ((dayQ.data?.result?.current as SeriesPoint[] | undefined) || []).map((p) => ({ date: iso(p.start, ctx.tz), count: d.part === 'num' ? p.num ?? 0 : p.value ?? 0 }))
  const hm = (heatQ.data?.result as unknown as { current: Heatmap } | null)?.current
  const wf = wfQ.data?.result as unknown as OrchestratorResult | null
  const period = dayQ.data?.period ? `${new Date(dayQ.data.period.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(Date.parse(dayQ.data.period.end) - 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'the period'
  return (
    <div className="ix-auto__deep">
      <div className="ix-subhead"><span className="ix-eyebrow">Run outcomes per day</span><small className="ix-muted">what the autopilot did with each inbound — parts always sum to the day’s runs</small></div>
      {stack?.available ? <StackColumns result={stack} roles={RUN_CLASSES.map((c) => ({ key: c.key, label: c.label, tone: c.tone }))} grain={stack.grain || 'day'} tz={ctx.tz} label="Autopilot run outcomes per day" height={170} onPick={(b) => records({ cohort: { metric: 'autopilot_runs', bucket: { start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() } }, title: `Autopilot runs · ${new Date(b.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` })} /> : <div className="ix-skel-block is-short" />}
      <div className="ix-duo">
        <div className="lc-arc ix-calendar">
          <div className="ix-subhead">
            <span className="ix-eyebrow">Daily rhythm</span>
            <LCSegmented label="Daily metric" size="sm" value={daily} onChange={setDaily} options={DAILY.map((x) => ({ value: x.key, label: x.short }))} />
          </div>
          {days.length ? <ActivityHeatmap days={days} label={`${d.label} per day`} period={period} unit={{ one: d.label.toLowerCase().replace(/s$/, ''), other: d.label.toLowerCase() }} weekStartsOn={1} /> : <div className="ix-skel-block is-short" />}
        </div>
        <div>
          <div className="ix-subhead">
            <span className="ix-eyebrow">Machine rhythm · weekday × hour</span>
            <LCSegmented label="Rhythm metric" size="sm" value={rhythm} onChange={setRhythm} options={RHYTHM.map((x) => ({ value: x.key, label: x.label }))} />
          </div>
          {hm ? <RhythmHeat data={hm} isRate={false} format={(v) => fmtInt(v)} onCell={(w, h) => records({ cohort: { metric: r.metric, cell: { weekday: w, hour: h } }, title: `${r.label} · ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][w]} ${String(h).padStart(2, '0')}:00` })} /> : <div className="ix-skel-block" />}
        </div>
      </div>
      <div className="ix-subhead"><span className="ix-eyebrow">Workflow orchestrator (wf_*)</span><small className="ix-muted">live since Sep 29 · rates withheld below 30 runs per version</small></div>
      {wf ? (wf.total ? (
        <ul className="ix-wf">{wf.workflows.map((x) => (
          <li key={x.key}>
            <button type="button" onClick={() => pushRoutePath(`/workflow-studio?workflow=${encodeURIComponent(x.workflow)}`)} title="Open this workflow in Workflow Studio">
              <b>{x.key}</b><span>{fmtInt(x.runs)} run{x.runs === 1 ? '' : 's'}</span><em>{Object.entries(x.states).map(([k, n]) => `${n} ${k}`).join(' · ')}</em><Icon name="arrow-up-right" size={12} />
            </button>
          </li>
        ))}</ul>
      ) : <p className="ix-note">No orchestrator runs started in this period.</p>) : <div className="ix-skel-rows"><i /></div>}
    </div>
  )
}
