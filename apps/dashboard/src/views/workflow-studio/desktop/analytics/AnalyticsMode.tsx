import { useMemo, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCError, LCSegmented, LCSelect, LCSkeleton, LCTooltip } from '../../../../shared/lc'
import { fetchActivity, fetchAnalytics, fetchWorkflow } from '../lib/api'
import { count, dur, pct, words } from '../lib/format'
import { useResource } from '../lib/resource'
import type { ActivityResponse, AnalyticsBucket, AnalyticsResponse, Period, WorkflowDetailResponse } from '../lib/types'
import { findWorkflow, useStudio } from '../studio-context'
import { DayHeatmap, DistributionBars, RateMeter, RhythmGrid, StatusColumns, type DayMetric } from './charts'

const TIMING_NOTE: Record<string, string> = {
  measured: 'Step times are stamped by the runtime — dwell and latency are measured.',
  recorder: 'Steps are recorded in one burst after each run — order is causal; only run duration, inbound latency and dispatch are measured.',
  inferred: 'One row per message — gates before the deciding one are inferred; due, sent and delivered times are measured.',
  single: 'One row per run — durations are row lifetimes.',
}

/**
 * ANALYTICS — how well automation runs (not business performance): a defined
 * automation rate, where people had to step in and why, how long runs and
 * steps take, where waits accumulate, which branches dominate and what
 * changed between versions. Every figure names its population and drills into
 * the exact runs behind it.
 */
export function AnalyticsMode() {
  const s = useStudio()
  const wf = s.wfKey
  const workflow = findWorkflow(s.workflows, wf)
  const a = useResource<AnalyticsResponse>(`analytics:${wf}:${s.period}`, (sig) => fetchAnalytics(wf, s.period, sig), { interval: 120_000, placeholderKey: `analytics:${wf}:${s.period === '30d' ? '7d' : '30d'}` })
  const detail = useResource<WorkflowDetailResponse>(`wf:${wf}:${s.period}`, (sig) => fetchWorkflow(wf, s.period, sig))
  const humanAll = useResource<ActivityResponse>('activity:168:human', (sig) => fetchActivity({ hours: 168, human: true, limit: 300 }, sig), { interval: 300_000 })
  const [dayMetric, setDayMetric] = useState<DayMetric>('runs')
  const [rhythmMetric, setRhythmMetric] = useState<'runs' | 'human' | 'failed'>('runs')
  const [nodeSel, setNodeSel] = useState<string | null>(null)
  const runnable = s.workflows.filter((w) => w.supports.runs && !w.test && w.group !== 'not_running')
  const d = a.data
  const label = (b: AnalyticsBucket) => (s.period === '24h' ? new Date(b.at).toLocaleTimeString('en-US', { hour: 'numeric' }) : new Date(b.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
  const drill = (x: Parameters<typeof s.openRuns>[1]) => s.openRuns(wf, { period: s.period, ...x })

  const byWorkflow = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>()
    for (const g of humanAll.data?.groups || []) { const cur = m.get(g.workflow_key) || { name: g.workflow_name, n: 0 }; cur.n++; m.set(g.workflow_key, cur) }
    return [...m.entries()].sort((x, y) => y[1].n - x[1].n)
  }, [humanAll.data])
  const waiting = useMemo(() => Object.entries(detail.data?.telemetry?.nodes || {}).filter(([, t]) => t.waiting_now > 0).map(([k, t]) => ({ k, n: t.waiting_now, label: detail.data?.topology.nodes.find((x) => x.key === k)?.label || words(k) })).sort((x, y) => y.n - x.n), [detail.data])
  const node = nodeSel && d ? d.bottlenecks.find((b) => b.key === nodeSel) || null : null

  return (
    <div className="ws4-analytics">
      <div className="ws4-analytics__bar">
        <LCSelect size="sm" variant="chip" label="Workflow" prefix="Workflow" value={wf} onChange={(k) => { setNodeSel(null); s.setWorkflow(k) }} options={runnable.map((w) => ({ value: w.workflow_key, label: w.name }))} />
        <LCSegmented size="sm" label="Period" value={s.period} onChange={(p: Period) => s.setPeriod(p)} options={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]} />
        <span className="ws4-analytics__note lc-t-meta">{d ? `${d.population.note}${a.placeholder ? ' — showing the other window while this one reads' : ''}` : a.error ? `Could not read — ${a.error}` : 'Reading…'}</span>
        {d?.timing ? <LCTooltip content={TIMING_NOTE[d.timing]}><span className="ws4-chipbtn is-static"><Icon name="clock" size={11} />{workflow?.kind === 'studio' ? 'Studio orchestrator' : d.source_runtime}</span></LCTooltip> : null}
      </div>
      <div className="ws4-analytics__doc lc-scroll">
        {!d ? (a.error ? <LCError what="Analytics could not be read" detail={a.error} onRetry={a.reload} /> : <LCSkeleton shape="chart" height={420} label="Reading analytics" />) : (
          <>
            {/* the telemetry strip */}
            <section className="ws4-strip" aria-label="Performance">
              <Cell label="Runs" value={count(d.performance.runs)} sub={`${d.period}`} onClick={() => drill({ label: `All runs · ${d.period}` })} />
              <Cell
                label="Automation rate"
                value={d.automation ? pct(d.automation.rate) : '—'}
                sub={d.automation ? `${count(d.automation.automated)} / ${count(d.automation.eligible)} finished runs` : 'not reported'}
                hint={d.automation?.definition}
                tone="ok"
                onClick={() => drill({ status: 'completed', label: 'Completed' })}
              />
              <Cell label="Human intervention" value={d.intervention ? count(d.intervention.runs) : count(d.resolution.human)} sub={d.intervention ? pct(d.intervention.rate) : pct(d.performance.intervention_rate)} tone="gold" onClick={() => drill({ human: true, label: 'A person intervened' })} />
              <Cell label="Held by policy" value={count(d.resolution.held)} sub={pct(d.performance.hold_rate)} tone="attn" onClick={() => drill({ status: 'held', label: 'Held by policy' })} />
              <Cell label="Failed" value={count(d.resolution.failed)} sub={pct(d.performance.failure_rate)} tone="crit" onClick={() => drill({ status: 'failed', label: 'Failed' })} />
              <Cell label="Retries" value={d.retries ? count(d.retries.runs) : '—'} sub={d.retries ? pct(d.retries.rate) : 'not reported'} />
              <Cell label="In flight" value={count(d.resolution.in_flight)} sub="waiting · running" onClick={() => drill({ status: 'waiting', label: 'In flight' })} />
              <Cell label="Run duration" value={d.latency?.runs.samples ? dur(d.latency.runs.p50) : '—'} sub={d.latency?.runs.samples ? `p50 · p95 ${dur(d.latency.runs.p95)}` : 'not timed'} />
            </section>

            <div className="ws4-arow is-2-1">
              <section className="ws4-asec" aria-label="Runs over time">
                <header><h3>Runs over time</h3><small>by outcome · a column opens its runs</small></header>
                <StatusColumns series={d.series} label={label} onBucket={(b) => drill({ from: b.at, to: b.to, label: `${label(b)} · ${b.total} runs` })} />
              </section>
              <section className="ws4-asec" aria-label="Resolution">
                <header><h3>Resolution</h3><small>a person stepping in is not a failure</small></header>
                {d.automation ? <RateMeter value={d.automation.rate} of={`${count(d.automation.automated)} of ${count(d.automation.eligible)} finished runs completed with no person`} label="Automation rate" /> : null}
                <ul className="ws4-reslist">
                  {([['system', 'Handled by automation', { status: 'completed' as const }], ['human', 'A person intervened', { human: true }], ['held', 'Held by policy', { status: 'held' as const }], ['failed', 'Failed', { status: 'failed' as const }], ['withdrawn', 'Withdrawn', { status: 'cancelled' as const }], ['in_flight', 'Still in flight', { status: 'waiting' as const }]] as const).map(([k, l, dr]) => {
                    const total = Object.values(d.resolution).reduce((x, y) => x + y, 0)
                    return <li key={k} data-k={k}><button type="button" onClick={() => drill({ ...dr, label: l })} disabled={!d.resolution[k]}><i /><span>{l}</span><b className="lc-num">{count(d.resolution[k])}</b><em className="lc-num">{total ? pct(d.resolution[k] / total, 0) : '—'}</em></button></li>
                  })}
                </ul>
                {d.automation ? <p className="ws4-note">{d.automation.definition}</p> : null}
              </section>
            </div>

            <div className="ws4-arow">
              <section className="ws4-asec" aria-label="Daily rhythm">
                <header><h3>Daily rhythm</h3><LCSegmented size="sm" label="Heatmap metric" value={dayMetric} onChange={setDayMetric} options={[{ value: 'runs', label: 'Runs' }, { value: 'human', label: 'Interventions' }, { value: 'failed', label: 'Failures' }, { value: 'held', label: 'Holds' }]} /></header>
                {d.days?.length ? <DayHeatmap days={d.days} metric={dayMetric} onDay={(date) => { const from = new Date(`${date}T00:00:00`); drill({ from: from.toISOString(), to: new Date(from.getTime() + 864e5).toISOString(), label: `${date} · ${dayMetric}` }) }} /> : <p className="ws4-quiet">No days in the window.</p>}
              </section>
              <section className="ws4-asec" aria-label="Machine rhythm">
                <header><h3>Machine rhythm</h3><LCSegmented size="sm" label="Rhythm metric" value={rhythmMetric} onChange={setRhythmMetric} options={[{ value: 'runs', label: 'Runs' }, { value: 'human', label: 'Interventions' }, { value: 'failed', label: 'Failures' }]} /></header>
                {d.rhythm ? <RhythmGrid cells={d.rhythm.cells} metric={rhythmMetric} tz={d.rhythm.tz} /> : null}
              </section>
            </div>

            <div className="ws4-arow">
              <section className="ws4-asec" aria-label="Latency">
                <header><h3>How long runs take</h3><small>{d.latency?.note || 'run row: started → finished'}</small></header>
                {d.latency?.runs.samples ? <DistributionBars d={d.latency.runs} /> : <p className="ws4-quiet">This runtime records no run duration.</p>}
                {d.latency?.ingress?.samples ? <>
                  <h4 className="ws4-asub">Seller reply → processed <small>inbound ledger · {count(d.latency.ingress.samples)} matched runs</small></h4>
                  <DistributionBars d={d.latency.ingress} tone="flow" />
                </> : null}
              </section>
              <section className="ws4-asec" aria-label="Measured steps and waits">
                <header><h3>Measured steps · waits</h3><small>only where the runtime measures them</small></header>
                {Object.entries(d.latency?.nodes || {}).map(([k, dist]) => (
                  <div key={k} className="ws4-asub-block"><h4 className="ws4-asub">{d.bottlenecks.find((b) => b.key === k)?.label || words(k)} <small>{count(dist.samples)} samples</small></h4><DistributionBars d={dist} tone="exec" /></div>
                ))}
                {(d.dwell || []).map((x) => <div key={x.node} className="ws4-asub-block"><h4 className="ws4-asub">{x.label} · dwell <small>{count(x.samples)} waits</small></h4><DistributionBars d={x} tone="attn" unit="waits" /></div>)}
                {!Object.keys(d.latency?.nodes || {}).length && !(d.dwell || []).length ? <p className="ws4-quiet">No step of this workflow is timed by its runtime — nothing is shown rather than the recorder’s spacing.</p> : null}
                {waiting.length ? <><h4 className="ws4-asub">Waiting right now</h4><ul className="ws4-hbars">{waiting.map((w) => <li key={w.k}><span>{w.label}</span><i style={{ ['--w' as string]: `${(w.n / waiting[0].n) * 100}%` }} /><b className="lc-num">{count(w.n)}</b></li>)}</ul></> : null}
              </section>
            </div>

            <div className="ws4-arow is-3">
              <section className="ws4-asec" aria-label="Intervention by node">
                <header><h3>Where people step in</h3><small>the node the run stopped at</small></header>
                {d.intervention?.by_node.length ? <ul className="ws4-hbars">{d.intervention.by_node.map((n) => <li key={n.node}><button type="button" onClick={() => drill({ node: n.node, human: true, label: `A person at ${n.label}` })}><span>{n.label}</span><i style={{ ['--w' as string]: `${(n.count / d.intervention!.by_node[0].count) * 100}%` }} data-tone="gold" /><b className="lc-num">{count(n.count)}</b></button></li>)}</ul> : <p className="ws4-quiet">No intervention in the window.</p>}
              </section>
              <section className="ws4-asec" aria-label="Intervention by reason">
                <header><h3>Why</h3><small>canonical reason codes</small></header>
                {d.intervention?.by_reason.length ? <ul className="ws4-hbars">{d.intervention.by_reason.map((r) => <li key={r.reason}><button type="button" onClick={() => drill({ reason: r.reason, label: r.label })}><span>{r.label}</span><i style={{ ['--w' as string]: `${(r.count / d.intervention!.by_reason[0].count) * 100}%` }} data-tone="gold" /><b className="lc-num">{count(r.count)}</b></button></li>)}</ul> : <p className="ws4-quiet">No intervention in the window.</p>}
                {d.hold_reasons.length ? <><h4 className="ws4-asub">Hold reasons</h4><ul className="ws4-hbars">{d.hold_reasons.slice(0, 6).map((r) => <li key={r.reason}><button type="button" onClick={() => drill({ reason: r.reason, label: r.label })}><span>{words(r.label)}</span><i style={{ ['--w' as string]: `${(r.count / d.hold_reasons[0].count) * 100}%` }} data-tone="attn" /><b className="lc-num">{count(r.count)}</b></button></li>)}</ul></> : null}
              </section>
              <section className="ws4-asec" aria-label="Intervention by workflow">
                <header><h3>Across workflows</h3><small>runs a person touched · 7d</small></header>
                {byWorkflow.length ? <ul className="ws4-hbars">{byWorkflow.map(([k, v]) => <li key={k}><button type="button" onClick={() => s.openRuns(k, { human: true, period: '7d', label: 'A person intervened · 7d' })}><span>{v.name}</span><i style={{ ['--w' as string]: `${(v.n / byWorkflow[0][1].n) * 100}%` }} data-tone="gold" /><b className="lc-num">{count(v.n)}</b></button></li>)}</ul> : humanAll.loading ? <LCSkeleton shape="rows" count={3} /> : <p className="ws4-quiet">No run needed a person in 7 days.</p>}
                {humanAll.data && humanAll.data.groups.length >= 300 ? <p className="ws4-note">Read capped at the latest 300 runs.</p> : null}
              </section>
            </div>

            <section className="ws4-asec" aria-label="Node analytics">
              <header><h3>Node analytics</h3><small>select a node for its branches and timing</small></header>
              <div className="ws4-ntable" role="table">
                <div className="ws4-ntable__row is-head" role="row"><span role="columnheader">Node</span><span role="columnheader">Executions</span><span role="columnheader">Held</span><span role="columnheader">Failed</span><span role="columnheader">To a person</span><span role="columnheader">p50 · p95</span></div>
                {d.bottlenecks.map((n) => (
                  <button key={n.key} type="button" role="row" className={`ws4-ntable__row${nodeSel === n.key ? ' is-on' : ''}`} onClick={() => setNodeSel(nodeSel === n.key ? null : n.key)}>
                    <span role="cell" className="is-name">{n.label}</span>
                    <span role="cell" className="lc-num">{count(n.entered)}</span>
                    <span role="cell" className="lc-num" data-tone={n.held ? 'attn' : undefined}>{n.held ? `${count(n.held)} · ${pct(n.hold_rate, 0)}` : '—'}</span>
                    <span role="cell" className="lc-num" data-tone={n.failed ? 'crit' : undefined}>{n.failed ? `${count(n.failed)} · ${pct(n.fail_rate, 0)}` : '—'}</span>
                    <span role="cell" className="lc-num" data-tone={n.human ? 'gold' : undefined}>{n.human ? `${count(n.human)} · ${pct(n.human_rate, 0)}` : '—'}</span>
                    <span role="cell" className="lc-num">{n.measured && n.p50_ms !== null && n.p50_ms !== undefined ? `${dur(n.p50_ms)} · ${dur(n.p95_ms ?? null)}` : '—'}</span>
                  </button>
                ))}
              </div>
              {node ? (
                <div className="ws4-ndetail">
                  <p className="lc-t-meta">{node.label}: {count(node.entered)} executions · {count(node.held)} held · {count(node.failed)} failed · {count(node.human)} to a person{node.measured && node.p50_ms !== null && node.p50_ms !== undefined ? ` · p50 ${dur(node.p50_ms)} · p95 ${dur(node.p95_ms ?? null)}` : ' · not timed by the runtime'}</p>
                  <button type="button" className="lc-link" onClick={() => drill({ node: node.key, label: `Through ${node.label}` })}>Every run through this node</button>
                </div>
              ) : null}
            </section>

            <section className="ws4-asec" aria-label="Branch analytics">
              <header><h3>Which way decisions went</h3><small>a branch opens its run cohort</small></header>
              {d.branches.length ? d.branches.map((b) => {
                const total = b.exits.reduce((x, e) => x + e.count, 0) || 1
                return (
                  <div key={b.node} className="ws4-branch">
                    <span className="ws4-branch__name">{b.label}</span>
                    <div className="ws4-branch__bar">
                      {b.exits.filter((e) => e.count).map((e) => (
                        <button key={e.edge} type="button" data-kind={e.kind} style={{ flexGrow: e.count }} onClick={() => drill({ edge: e.edge, label: `${b.label} → ${e.label}` })} title={`${e.label}: ${e.count} runs (${pct(e.count / total, 0)})`}>
                          <span>{e.label.replace(/^IF /, '')} {pct(e.count / total, 0)}</span>
                        </button>
                      ))}
                    </div>
                    <em className="lc-num">{count(total)}</em>
                  </div>
                )
              }) : <p className="ws4-quiet">No decision branched in the window.</p>}
            </section>

            <section className="ws4-asec" aria-label="Versions">
              <header><h3>Versions</h3><small>populations differ — compare rates, not totals</small></header>
              <div className="ws4-ntable is-versions" role="table">
                <div className="ws4-ntable__row is-head" role="row"><span role="columnheader">Version</span><span role="columnheader">Runs</span><span role="columnheader">Completed</span><span role="columnheader">Held</span><span role="columnheader">Person</span><span role="columnheader">Failed</span></div>
                {d.versions.map((v) => (
                  <button key={v.version} type="button" role="row" className="ws4-ntable__row" onClick={() => drill({ version: v.version, label: `Version ${v.version}` })}>
                    <span role="cell" className="is-name">{v.version}<small>{new Date(v.first_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {new Date(v.last_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</small></span>
                    <span role="cell" className="lc-num">{count(v.runs)}</span>
                    <span role="cell" className="lc-num">{pct(v.runs ? v.completed / v.runs : null, 0)}</span>
                    <span role="cell" className="lc-num">{pct(v.runs ? v.held / v.runs : null, 0)}</span>
                    <span role="cell" className="lc-num">{pct(v.runs ? v.human / v.runs : null, 0)}</span>
                    <span role="cell" className="lc-num">{pct(v.runs ? v.failed / v.runs : null, 0)}</span>
                  </button>
                ))}
              </div>
              {d.versions.length < 2 ? <p className="ws4-note">One version ran in the window — there is nothing to compare yet.</p> : null}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function Cell({ label, value, sub, hint, tone, onClick }: { label: string; value: string; sub?: string; hint?: string; tone?: string; onClick?: () => void }) {
  const body = (
    <>
      <small className="ws4-strip__label">{label}{hint ? <Icon name="alert-circle" size={10} /> : null}</small>
      <b className="ws4-strip__value">{value}</b>
      {sub ? <em className="ws4-strip__sub">{sub}</em> : null}
    </>
  )
  const el = onClick ? <button type="button" className="ws4-strip__cell" data-tone={tone} onClick={onClick}>{body}</button> : <div className="ws4-strip__cell" data-tone={tone}>{body}</div>
  return hint ? <LCTooltip content={hint}>{el}</LCTooltip> : el
}
