import { Icon } from '../../../../shared/icons'
import { pushRoutePath } from '../../../../app/router'
import { FAMILY, terminalTone } from '../families'
import type { NodeTelemetry, RegistryEntry, Topology, TopologyNode, WorkflowTelemetry } from '../observatory-types'
import { ago } from '../../mobile/workflow-format'
import { fmtCount, fmtMs } from './CanvasNode'

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—')

function sum(members: string[], t: WorkflowTelemetry | null): NodeTelemetry | null {
  if (!t) return null
  const out: NodeTelemetry = { entered: 0, passed: 0, held: 0, failed: 0, human: 0, skipped: 0, waiting_now: 0, p50_ms: null, p95_ms: null, last_at: null }
  for (const k of members) {
    const x = t.nodes[k]
    if (!x) continue
    out.entered = Math.max(out.entered, x.entered)
    out.passed += x.passed; out.held += x.held; out.failed += x.failed; out.human += x.human; out.skipped += x.skipped; out.waiting_now += x.waiting_now
    if (x.p50_ms !== null) out.p50_ms = (out.p50_ms ?? 0) + x.p50_ms
    if (x.p95_ms !== null) out.p95_ms = (out.p95_ms ?? 0) + x.p95_ms
    if (x.last_at && (!out.last_at || x.last_at > out.last_at)) out.last_at = x.last_at
  }
  return out
}

/**
 * NODE INSPECTOR (Level 3). What the step is, who owns it, the contract it
 * honours, how it behaved over the period, and the way into the owning app.
 * Everything is read-only for a system workflow — it is observed, not edited.
 */
export function NodeInspector({ topology, workflow, telemetry, nodeKey, groupKey, expanded, onToggleGroup, onClose, onOpenRun, onOpenWorkflow, onRunsThrough }: {
  topology: Topology
  workflow: RegistryEntry
  telemetry: WorkflowTelemetry | null
  nodeKey: string | null
  groupKey: string | null
  expanded: ReadonlySet<string>
  onToggleGroup: (k: string) => void
  onClose: () => void
  onOpenRun: (runId: string, nodeKey: string | null) => void
  onOpenWorkflow: (key: string) => void
  onRunsThrough?: (node: string, label: string) => void
}) {
  const group = groupKey ? topology.groups.find((g) => g.key === groupKey) || null : null
  const node: TopologyNode | null = nodeKey ? topology.nodes.find((n) => n.key === nodeKey) || null : null
  const members = group ? topology.nodes.filter((n) => n.group === group.key) : node ? [node] : []
  if (!group && !node) return null
  const family = group ? group.family : node!.family
  const meta = FAMILY[family]
  const tone = family === 'TERMINAL' ? terminalTone(node?.terminal) : meta.tone
  const t = sum(members.map((m) => m.key), telemetry)
  const measured = members.some((m) => m.measured?.latency)
  const recent = telemetry?.recent ? members.flatMap((m) => (telemetry.recent?.[m.key] || []).map((r) => ({ ...r, node: m.key }))).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6) : []
  const label = group ? group.label : node!.label
  const description = group ? group.summary : node!.description || node!.summary
  const outgoing = node ? topology.edges.filter((e) => e.from === node.key && e.label) : []
  const link = node?.link || null

  return (
    <aside className={`ws3-insp is-${tone}`} aria-label={`${label} — node inspector`}>
      <header className="ws3-insp__head">
        <span className="ws3-insp__glyph"><Icon name={group ? 'layers' : meta.icon} /></span>
        <span className="ws3-insp__title">
          <small>{group ? `Group · ${members.length} steps` : meta.label}{node?.optional ? ' · optional' : ''}</small>
          <strong>{label}</strong>
        </span>
        <button type="button" className="ws3-iconbtn" onClick={onClose} aria-label="Close inspector"><Icon name="close" /></button>
      </header>

      <p className="ws3-insp__spec">{workflow.owner_app} · {node?.owner || workflow.runtime}{workflow.kind === 'system' ? ' · read-only' : ''}</p>
      {description ? <p className="ws3-insp__desc">{description}</p> : null}

      {t ? (
        <div className="ws3-insp__figs" role="group" aria-label={`Behaviour over ${telemetry?.period}`}>
          <span><b>{fmtCount(t.entered)}</b><small>runs · {telemetry?.period}</small></span>
          <span className={t.held ? 'is-held' : ''}><b>{pct(t.held, t.entered)}</b><small>held</small></span>
          <span className={t.failed ? 'is-bad' : t.human ? 'is-human' : ''}><b>{t.failed ? pct(t.failed, t.entered) : pct(t.human, t.entered)}</b><small>{t.failed ? 'failed' : 'to a human'}</small></span>
          <span><b>{measured ? fmtMs(t.p50_ms) : '—'}</b><small>{measured ? `p50 · p95 ${fmtMs(t.p95_ms)}` : 'not timed by runtime'}</small></span>
        </div>
      ) : <p className="ws3-insp__quiet">No telemetry for this period.</p>}
      {t && t.waiting_now ? <p className="ws3-insp__pressure"><Icon name="user" />{t.waiting_now} waiting on a person right now</p> : null}

      {group ? (
        <section className="ws3-insp__sec">
          <h4>Steps<button type="button" className="ws3-textbtn" onClick={() => onToggleGroup(group.key)}>{expanded.has(group.key) ? 'Collapse' : 'Expand on canvas'}</button></h4>
          <ol className="ws3-insp__members">
            {members.map((m) => {
              const x = telemetry?.nodes[m.key]
              return <li key={m.key}><Icon name={FAMILY[m.family].icon} /><span>{m.label}</span><b>{x ? fmtCount(x.entered) : '—'}</b></li>
            })}
          </ol>
        </section>
      ) : null}

      {node ? (
        <section className="ws3-insp__sec">
          <h4>Canonical action</h4>
          <dl className="ws3-insp__dl">
            {node.action ? <><dt>Runs</dt><dd><code>{node.action}</code></dd></> : null}
            <dt>Owner</dt><dd>{node.owner || workflow.owner_app}</dd>
            {node.evidence?.length ? <><dt>Proved by</dt><dd>{node.evidence.map((e) => <code key={e}>{e}</code>)}</dd></> : null}
            {node.inputs?.length ? <><dt>Reads</dt><dd>{node.inputs.join(' · ')}</dd></> : null}
            {node.outputs?.length ? <><dt>Writes</dt><dd>{node.outputs.join(' · ')}</dd></> : null}
            {outgoing.length ? <><dt>Exits</dt><dd>{outgoing.map((e) => <span key={e.id} className={`ws3-exit is-${e.kind}`}>{e.label}</span>)}</dd></> : null}
          </dl>
          {node.measured?.note ? <p className="ws3-insp__note">{node.measured.note}</p> : null}
        </section>
      ) : null}

      {recent.length ? (
        <section className="ws3-insp__sec">
          <h4>Recent</h4>
          <ul className="ws3-insp__recent">
            {recent.map((r) => (
              <li key={`${r.run_id}:${r.node}`}>
                <button type="button" onClick={() => onOpenRun(r.run_id, r.node)}>
                  <i className={`ws3-dot is-${r.status}`} aria-hidden />
                  <span className="ws3-insp__who">{r.subject || 'Run'}<small>{r.reason || r.status.replace(/_/g, ' ')}</small></span>
                  <time>{ago(r.at)}</time>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="ws3-insp__foot">
        {onRunsThrough && node ? <button type="button" className="ws3-btn" onClick={() => onRunsThrough(node.key, node.label)}><Icon name="list" />Runs through this step</button> : null}
        {node?.handoff ? <button type="button" className="ws3-btn" onClick={() => onOpenWorkflow(node.handoff!)}><Icon name="layers" />Open {node.label.replace(/^Hand off to /i, '')}</button> : null}
        {link ? <button type="button" className="ws3-btn" onClick={() => pushRoutePath(link.href)}><Icon name="arrow-up-right" />Open in {link.app}</button> : workflow.owner_href ? <button type="button" className="ws3-btn" onClick={() => pushRoutePath(workflow.owner_href!)}><Icon name="arrow-up-right" />Open {workflow.owner_app}</button> : null}
      </footer>
    </aside>
  )
}
