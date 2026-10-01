import { LCButton, LCFacts, LCInspector, LCInspectorSection, LCSkeleton } from '../../../../shared/lc'
import { fetchRuns } from '../lib/api'
import { ago, count, pct, words } from '../lib/format'
import { useResource } from '../lib/resource'
import type { Period, RegistryEntry, Topology, WorkflowTelemetry } from '../lib/types'
import { useStudio } from '../studio-context'

const KIND: Record<string, string> = { primary: 'Primary path', branch: 'Branch', exception: 'Exception path', failure: 'Failure path', human: 'Human path', retry: 'Retry', handoff: 'Handoff' }

/** EDGE INSPECTOR — the condition, how often it was taken in the period, and the exact runs that took it. */
export function EdgeInspector({ topology, workflow, telemetry, edgeId, period, onClose, onNode }: {
  topology: Topology
  workflow: RegistryEntry
  telemetry: WorkflowTelemetry | null
  edgeId: string
  period: Period
  onClose: () => void
  onNode: (key: string) => void
}) {
  const s = useStudio()
  const e = topology.edges.find((x) => x.id === edgeId)
  const runs = useResource(e && workflow.supports.runs ? `runs:${workflow.workflow_key}:${period}:edge:${edgeId}` : null, (sig) => fetchRuns(workflow.workflow_key, { period, edge: edgeId, limit: 6 }, sig))
  if (!e) return null
  const from = topology.nodes.find((n) => n.key === e.from)
  const to = topology.nodes.find((n) => n.key === e.to)
  const n = telemetry?.edges[e.id] ?? null
  const entered = telemetry?.nodes[e.from]?.entered ?? null
  const siblings = topology.edges.filter((x) => x.from === e.from)
  return (
    <LCInspector
      open
      onClose={onClose}
      id="ws4-edge"
      eyebrow={KIND[e.kind] || words(e.kind)}
      title={e.label ? `${e.label}` : `${from?.label} → ${to?.label}`}
      subtitle={`${from?.label} → ${to?.label}`}
      contentKey={e.id}
      width={400}
      footer={workflow.supports.runs ? <div className="ws4-actions"><LCButton icon="list" onClick={() => s.openRuns(workflow.workflow_key, { edge: e.id, period, label: `${from?.label} → ${to?.label}${e.label ? ` · ${e.label}` : ''}` })}>Every run on this path</LCButton></div> : null}
    >
      <div className="ws4-edgeflow">
        <button type="button" onClick={() => onNode(e.from)}>{from?.label}</button>
        <span className="ws4-kind" data-kind={e.kind}>{e.label || KIND[e.kind]}</span>
        <button type="button" onClick={() => onNode(e.to)}>{to?.label}</button>
      </div>
      <LCFacts rows={[
        { label: `Taken · ${period}`, value: n === null ? null : `${count(n)} run${n === 1 ? '' : 's'}` },
        { label: 'Share of the step', value: n !== null && entered ? `${pct(n / entered, 0)} of ${count(entered)} through ${from?.label}` : null },
        { label: 'Condition', value: e.label || (siblings.length > 1 ? 'the default branch' : 'always next') },
      ]} />
      {siblings.length > 1 ? (
        <LCInspectorSection title="Every branch from this step">
          <ul className="ws4-exits">{siblings.map((x) => <li key={x.id} data-kind={x.kind} className={x.id === e.id ? 'is-on' : undefined}><span className="ws4-exit__label">{x.label || 'Next'}</span><span className="ws4-exit__to">{topology.nodes.find((t) => t.key === x.to)?.label}</span><em className="lc-num">{count(telemetry?.edges[x.id] ?? 0)}</em></li>)}</ul>
        </LCInspectorSection>
      ) : null}
      {workflow.supports.runs ? (
        <LCInspectorSection title="Recent runs on this path">
          {runs.loading ? <LCSkeleton shape="rows" count={3} /> : runs.data?.runs.length ? (
            <ul className="ws4-runlist">
              {runs.data.runs.map((r) => (
                <li key={r.run_id}><button type="button" onClick={() => s.openRun(workflow.workflow_key, r.run_id, e.to)} data-status={r.status}><i aria-hidden /><span><b>{r.subject.name || r.subject.address || r.subject.id || 'Run'}</b><small>{r.result || r.status_label}</small></span><time className="lc-t-stamp">{ago(r.started_at)}</time></button></li>
              ))}
            </ul>
          ) : <p className="ws4-quiet">{runs.error ? `Runs could not be read — ${runs.error}` : `No run took this path in ${period}.`}</p>}
        </LCInspectorSection>
      ) : null}
    </LCInspector>
  )
}
