import { useMemo, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { fetchAnalytics, type RunsFilter } from '../observatory-api'
import type { AnalyticsResponse, Period, RegistryEntry, RunStatus } from '../observatory-types'
import { fmtCount, fmtMs } from '../canvas/CanvasNode'
import { usePoll } from '../use-studio-data'

type Drill = Partial<Pick<RunsFilter, 'node' | 'reason' | 'version' | 'from' | 'to' | 'human'>> & { status?: RunStatus | 'all'; label?: string }
const PERIODS: Period[] = ['24h', '7d', '30d']
const STACK: Array<{ k: 'completed' | 'waiting' | 'running' | 'held' | 'needs_you' | 'failed' | 'cancelled'; l: string }> = [
  { k: 'completed', l: 'Completed' }, { k: 'waiting', l: 'Waiting' }, { k: 'running', l: 'Running' }, { k: 'needs_you', l: 'Needs you' }, { k: 'held', l: 'Held' }, { k: 'failed', l: 'Failed' }, { k: 'cancelled', l: 'Stopped' },
]
const RES: Array<{ k: keyof AnalyticsResponse['resolution']; l: string; drill: Drill }> = [
  { k: 'system', l: 'System handled', drill: { status: 'completed', label: 'System handled' } },
  { k: 'human', l: 'Human intervention', drill: { human: true, label: 'A person intervened' } },
  { k: 'held', l: 'Held by policy', drill: { status: 'held', label: 'Held by policy' } },
  { k: 'failed', l: 'Failed', drill: { status: 'failed', label: 'Failed' } },
  { k: 'withdrawn', l: 'Withdrawn', drill: { status: 'cancelled', label: 'Withdrawn' } },
  { k: 'in_flight', l: 'In flight', drill: { status: 'waiting', label: 'In flight' } },
]
const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`)
const tick = (at: string, p: Period) => (p === '24h' ? new Date(at).toLocaleTimeString(undefined, { hour: 'numeric' }) : new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))

/**
 * ANALYTICS — how a workflow behaves over a period. Resolution keeps human
 * escalation and policy holds apart from failure; latency appears only where
 * the runtime measures it; versions are compared with their populations
 * stated. Every bar, row and segment drills into the exact runs.
 */
export function AnalyticsMode({ workflows, wfKey, onWorkflow, period, onPeriod, onDrill }: {
  workflows: RegistryEntry[]
  wfKey: string
  onWorkflow: (k: string) => void
  period: Period
  onPeriod: (p: Period) => void
  onOpenRun: (wf: string, run: string, node: string | null) => void
  onDrill: (f: Drill) => void
}) {
  const a = usePoll((s) => fetchAnalytics(wfKey, period, s), [wfKey, period], 120_000)
  const d = a.data
  const runnable = workflows.filter((w) => w.supports.runs && !w.test && w.group !== 'not_running')
  const [hover, setHover] = useState<number | null>(null)
  const maxBucket = useMemo(() => Math.max(1, ...(d?.series || []).map((b) => b.total)), [d])
  const maxHuman = useMemo(() => Math.max(1, ...(d?.interventions || []).map((b) => b.human)), [d])
  const resTotal = d ? Object.values(d.resolution).reduce((x, y) => x + y, 0) : 0
  return (
    <div className="ws3-analytics">
      <div className="ws3-bar">
        <label className="ws3-select" title="Workflow"><Icon name="layers" /><select value={wfKey} onChange={(e) => onWorkflow(e.target.value)} aria-label="Workflow">{runnable.map((w) => <option key={w.workflow_key} value={w.workflow_key}>{w.name}</option>)}</select></label>
        <div className="ws3-seg" role="tablist" aria-label="Period">{PERIODS.map((p) => <button key={p} type="button" role="tab" aria-selected={period === p} className={period === p ? 'is-on' : ''} onClick={() => onPeriod(p)}>{p}</button>)}</div>
        <span className="ws3-bar__note">{d ? d.population.note : a.error ? `Could not read — ${a.error}` : 'Reading…'}</span>
      </div>
      {!d ? (
        <div className="ws3-skel-rows" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <span key={i} />)}</div>
      ) : (
        <div className="ws3-agrid">
          <section className="ws3-card is-kpis" aria-label="Performance">
            <Kpi label="Runs" value={fmtCount(d.performance.runs)} onClick={() => onDrill({ status: 'all', label: `All runs · ${period}` })} />
            <Kpi label="Completion" value={pct(d.performance.completion_rate)} hint="of finished runs" />
            <Kpi label="Held by policy" value={pct(d.performance.hold_rate)} tone="held" onClick={() => onDrill({ status: 'held', label: 'Held by policy' })} />
            <Kpi label="Human intervention" value={pct(d.performance.intervention_rate)} tone="human" onClick={() => onDrill({ human: true, label: 'A person intervened' })} />
            <Kpi label="Failed" value={pct(d.performance.failure_rate)} tone="bad" onClick={() => onDrill({ status: 'failed', label: 'Failed' })} />
            <Kpi label="Runtime p50 · p95" value={d.performance.duration_samples ? `${fmtMs(d.performance.median_ms)} · ${fmtMs(d.performance.p95_ms)}` : '—'} hint={d.performance.duration_samples ? `${d.performance.duration_samples} timed runs` : 'not timed by this runtime'} />
            <Kpi label="Retry rate" value={pct(d.performance.retry_rate)} />
          </section>

          <section className="ws3-card is-series" aria-label="Runs over time by status">
            <h4>Runs over time<small>by status · click a bar for its runs</small></h4>
            <div className="ws3-bars" onMouseLeave={() => setHover(null)}>
              {d.series.map((b, i) => (
                <button key={b.at} type="button" className="ws3-bars__col" style={{ ['--h' as string]: `${(b.total / maxBucket) * 100}%` }} onMouseEnter={() => setHover(i)} onClick={() => onDrill({ from: b.at, to: b.to, label: `${tick(b.at, period)} · ${b.total} runs` })} aria-label={`${tick(b.at, period)}: ${b.total} runs`}>
                  <span className="ws3-bars__stack">{STACK.map((s) => (b[s.k] ? <i key={s.k} className={`is-${s.k}`} style={{ flexGrow: b[s.k] }} /> : null))}</span>
                </button>
              ))}
            </div>
            <div className="ws3-bars__axis"><span>{d.series[0] ? tick(d.series[0].at, period) : ''}</span><span>{hover !== null && d.series[hover] ? `${tick(d.series[hover].at, period)} · ${d.series[hover].total} runs${d.series[hover].human ? ` · ${d.series[hover].human} with a person` : ''}` : ''}</span><span>{d.series.length ? tick(d.series[d.series.length - 1].at, period) : ''}</span></div>
            <div className="ws3-legend">{STACK.map((s) => <span key={s.k}><i className={`is-${s.k}`} />{s.l}</span>)}</div>
          </section>

          <section className="ws3-card is-resolution" aria-label="Resolution">
            <h4>Resolution<small>human escalation is not failure</small></h4>
            <div className="ws3-resbar">{RES.map((r) => (d.resolution[r.k] ? <button key={r.k} type="button" className={`is-${r.k}`} style={{ flexGrow: d.resolution[r.k] }} onClick={() => onDrill(r.drill)} title={`${r.l}: ${d.resolution[r.k]}`} /> : null))}</div>
            <ul className="ws3-reslist">{RES.map((r) => <li key={r.k}><button type="button" onClick={() => onDrill(r.drill)}><i className={`is-${r.k}`} /><span>{r.l}</span><b>{d.resolution[r.k]}</b><em>{resTotal ? `${Math.round((d.resolution[r.k] / resTotal) * 100)}%` : '—'}</em></button></li>)}</ul>
          </section>

          <section className="ws3-card is-bottlenecks" aria-label="Node bottlenecks">
            <h4>Node bottlenecks<small>where runs are held, fail or reach a person</small></h4>
            <div className="ws3-mtable">
              <div className="is-head"><span>Node</span><span>Runs</span><span>Held</span><span>Failed</span><span>Person</span><span>Latency</span></div>
              {d.bottlenecks.slice(0, 12).map((n) => (
                <button key={n.key} type="button" onClick={() => onDrill({ node: n.key, label: `Through ${n.label}` })}>
                  <span className="is-name">{n.label}</span><span>{fmtCount(n.entered)}</span>
                  <span className={n.held ? 'is-held' : ''}>{n.held ? `${n.held} · ${pct(n.hold_rate)}` : '—'}</span>
                  <span className={n.failed ? 'is-bad' : ''}>{n.failed || '—'}</span>
                  <span className={n.human ? 'is-human' : ''}>{n.human || '—'}</span>
                  <span>{n.measured && n.p50_ms !== undefined && n.p50_ms !== null ? `${fmtMs(n.p50_ms)} · ${fmtMs(n.p95_ms ?? null)}` : '—'}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="ws3-card is-reasons" aria-label="Hold reasons">
            <h4>Hold reasons<small>canonical codes</small></h4>
            {d.hold_reasons.length ? (
              <ul className="ws3-hbars">{d.hold_reasons.map((r) => <li key={r.reason}><button type="button" onClick={() => onDrill({ reason: r.reason, label: r.label })}><span>{r.label}</span><i style={{ ['--w' as string]: `${(r.count / d.hold_reasons[0].count) * 100}%` }} /><b>{r.count}</b></button></li>)}</ul>
            ) : <p className="ws3-quiet">No holds in the period.</p>}
          </section>

          <section className="ws3-card is-trend" aria-label="Intervention trend">
            <h4>Intervention trend<small>runs a person resolved</small></h4>
            <svg className="ws3-trend" viewBox={`0 0 ${Math.max(1, d.interventions.length - 1) * 20} 60`} preserveAspectRatio="none" role="img" aria-label="Human interventions over time">
              <polyline points={d.interventions.map((b, i) => `${i * 20},${58 - (b.human / maxHuman) * 52}`).join(' ')} />
              <polygon points={`0,60 ${d.interventions.map((b, i) => `${i * 20},${58 - (b.human / maxHuman) * 52}`).join(' ')} ${(d.interventions.length - 1) * 20},60`} />
            </svg>
            <div className="ws3-bars__axis"><span>{d.interventions[0] ? tick(d.interventions[0].at, period) : ''}</span><span>{d.interventions.reduce((x, b) => x + b.human, 0)} with a person</span><span>{d.interventions.length ? tick(d.interventions[d.interventions.length - 1].at, period) : ''}</span></div>
          </section>

          <section className="ws3-card is-branches" aria-label="Branch distribution">
            <h4>Branch distribution<small>which way each decision went</small></h4>
            {d.branches.length ? d.branches.slice(0, 6).map((b) => {
              const total = b.exits.reduce((x, e) => x + e.count, 0) || 1
              return (
                <div key={b.node} className="ws3-branch">
                  <span className="ws3-branch__name">{b.label}</span>
                  <div className="ws3-branch__bar">{b.exits.filter((e) => e.count).map((e) => <button key={e.edge} type="button" className={`is-${e.kind}`} style={{ flexGrow: e.count }} onClick={() => onDrill({ node: e.to, label: `${b.label} → ${e.label}` })} title={`${e.label}: ${e.count}`}><span>{e.label} {Math.round((e.count / total) * 100)}%</span></button>)}</div>
                </div>
              )
            }) : <p className="ws3-quiet">No decision branched in the period.</p>}
          </section>

          <section className="ws3-card is-versions" aria-label="Version comparison">
            <h4>Versions<small>populations differ — compare rates, not totals</small></h4>
            <div className="ws3-mtable is-versions">
              <div className="is-head"><span>Version</span><span>Runs</span><span>Completed</span><span>Held</span><span>Person</span><span>Failed</span></div>
              {d.versions.map((v) => (
                <button key={v.version} type="button" onClick={() => onDrill({ version: v.version, label: `Version ${v.version}` })}>
                  <span className="is-name">{v.version}<small>{new Date(v.first_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – {new Date(v.last_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small></span>
                  <span>{v.runs}</span><span>{pct(v.runs ? v.completed / v.runs : null)}</span><span>{pct(v.runs ? v.held / v.runs : null)}</span><span>{pct(v.runs ? v.human / v.runs : null)}</span><span>{pct(v.runs ? v.failed / v.runs : null)}</span>
                </button>
              ))}
            </div>
            {d.versions.length > 1 ? <p className="ws3-note">{d.versions.map((v) => `${v.version}: ${v.runs} runs`).join(' · ')} — different populations and windows.</p> : null}
          </section>
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, hint, tone, onClick }: { label: string; value: string; hint?: string; tone?: 'held' | 'human' | 'bad'; onClick?: () => void }) {
  return (
    <button type="button" className={`ws3-kpi${tone ? ` is-${tone}` : ''}`} onClick={onClick} disabled={!onClick}>
      <small>{label}</small><b>{value}</b>{hint ? <em>{hint}</em> : null}
    </button>
  )
}
