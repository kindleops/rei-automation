import { useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCButton, LCEmpty, LCFacts, LCInspector, LCInspectorSection, LCSkeleton, LCStatus } from '../../../../shared/lc'
import { pushRoutePath } from '../../../../app/router'
import { fetchAnalytics, type CatalogCapability, type StudioCatalog } from '../lib/api'
import { FAMILY, terminalTone } from '../lib/families'
import { ago, count, dur, pct, words } from '../lib/format'
import { useResource } from '../lib/resource'
import type { AnalyticsResponse, NodeTelemetry, Period, RegistryEntry, RunDetailResponse, Topology, TopologyNode, WorkflowTelemetry } from '../lib/types'
import { DistributionBars } from '../analytics/charts'
import { useStudio } from '../studio-context'

type Tab = 'overview' | 'config' | 'activity' | 'analytics' | 'evidence'

const sum = (members: string[], t: WorkflowTelemetry | null): NodeTelemetry | null => {
  if (!t) return null
  const out: NodeTelemetry = { entered: 0, passed: 0, held: 0, failed: 0, human: 0, skipped: 0, waiting_now: 0, p50_ms: null, p95_ms: null, last_at: null }
  const timed: NodeTelemetry[] = []
  for (const k of members) {
    const x = t.nodes[k]
    if (!x) continue
    out.entered = Math.max(out.entered, x.entered)
    out.passed += x.passed; out.held += x.held; out.failed += x.failed; out.human += x.human; out.skipped += x.skipped; out.waiting_now += x.waiting_now
    if (x.p50_ms !== null) timed.push(x)
    if (x.last_at && (!out.last_at || x.last_at > out.last_at)) out.last_at = x.last_at
  }
  // percentiles never add up across steps — only a single timed step reports one
  if (timed.length === 1) { out.p50_ms = timed[0].p50_ms; out.p95_ms = timed[0].p95_ms }
  return out
}

const configLabel = (n: TopologyNode | null) => {
  if (!n) return 'Steps'
  const k = FAMILY[n.family].kind
  return k === 'Decision' ? 'Decision' : k === 'Wait' ? 'Timing' : k === 'Approval' ? 'Approval' : k === 'External' ? 'Handoff' : 'Capability'
}

/**
 * NODE INSPECTOR — what the step is, the canonical capability it runs, the
 * contract it honours, who owns it, how it behaved over the period and the
 * evidence that proves it. A system workflow's node is observed, never edited.
 */
export function NodeInspector({ topology, workflow, telemetry, nodeKey, groupKey, period, run, live, catalog, onClose, onNode, onOpenWorkflow, onToggleGroup, expanded, back }: {
  topology: Topology
  workflow: RegistryEntry
  telemetry: WorkflowTelemetry | null
  nodeKey: string | null
  groupKey: string | null
  period: Period
  run: RunDetailResponse | null
  live: { executing: number; parked: number } | null
  catalog: StudioCatalog | null
  onClose: () => void
  onNode: (key: string) => void
  onOpenWorkflow: (key: string) => void
  onToggleGroup: (key: string) => void
  expanded: ReadonlySet<string>
  back?: { label: string; onBack: () => void }
}) {
  const s = useStudio()
  const [tab, setTab] = useState<Tab>('overview')
  const group = groupKey ? topology.groups.find((g) => g.key === groupKey) || null : null
  const node: TopologyNode | null = nodeKey ? topology.nodes.find((n) => n.key === nodeKey) || null : null
  const members = group ? topology.nodes.filter((n) => n.group === group.key) : node ? [node] : []
  const family = group ? group.family : node?.family || 'ACTION'
  const meta = FAMILY[family]
  const tone = family === 'TERMINAL' ? terminalTone(node?.terminal) : meta.tone
  const t = sum(members.map((m) => m.key), telemetry)
  const label = group ? group.label : node?.label || ''
  const outgoing = node ? topology.edges.filter((e) => e.from === node.key) : []
  const runAt = node && run ? run.path.nodes[node.key] : null
  const cap: CatalogCapability | null = node?.action && catalog ? catalog.capabilities.find((c) => c.key === node.action) || null : null
  const isStudio = workflow.kind === 'studio'
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'overview', label: 'Overview' },
    ...(node && node.family !== 'TRIGGER' && node.family !== 'TERMINAL' ? [{ id: 'config' as Tab, label: configLabel(node) }] : group ? [{ id: 'config' as Tab, label: 'Steps' }] : []),
    { id: 'activity', label: 'Activity' },
    ...(workflow.supports.runs ? [{ id: 'analytics' as Tab, label: 'Analytics' }] : []),
    { id: 'evidence', label: 'Evidence' },
  ]
  const active = tabs.some((x) => x.id === tab) ? tab : 'overview'
  if (!group && !node) return null

  return (
    <LCInspector
      open
      onClose={onClose}
      id="ws4-node"
      eyebrow={`${group ? `Group · ${members.length} steps` : meta.label}${node?.optional ? ' · optional' : ''}`}
      title={label}
      subtitle={`${workflow.short_name || workflow.name}${workflow.kind === 'system' ? ` · ${workflow.runtime_version} · read-only` : ` · ${workflow.runtime_version}`}`}
      status={runAt ? <LCStatus label={`In this run · ${words(runAt.status)}${runAt.label ? ` · ${runAt.label}` : ''}`} tone={runAt.status === 'failed' ? 'crit' : ['blocked', 'held'].includes(runAt.status) ? 'attn' : ['human', 'needs_review'].includes(runAt.status) ? 'attn' : runAt.status === 'skipped' ? 'neutral' : 'ok'} /> : <LCStatus label={meta.kind} tone={tone === 'violet' ? 'flow' : tone === 'cyan' || tone === 'cobalt' ? 'exec' : tone === 'green' ? 'ok' : tone === 'red' ? 'crit' : tone === 'amber' || tone === 'gold' ? 'attn' : 'neutral'} quiet />}
      tabs={{ items: tabs, value: active, onChange: (v) => setTab(v as Tab) }}
      contentKey={`${nodeKey || groupKey}:${active}`}
      back={back}
      width={420}
      className={`ws4-insp is-${tone}`}
      footer={
        <div className="ws4-actions">
          {node && workflow.supports.runs ? <LCButton icon="list" onClick={() => s.openRuns(workflow.workflow_key, { node: node.key, period, label: `Through ${node.label}` })}>Runs through this step</LCButton> : null}
          {node?.handoff ? <LCButton icon="layers" onClick={() => onOpenWorkflow(node.handoff!)}>Open {node.label.replace(/^Hand off to /i, '')}</LCButton> : null}
          {node?.link ? <LCButton variant="quiet" icon="arrow-up-right" onClick={() => pushRoutePath(node.link!.href)}>{node.link.app}</LCButton> : null}
          {group ? <LCButton icon="layers" onClick={() => onToggleGroup(group.key)}>{expanded.has(group.key) ? 'Collapse on canvas' : 'Expand on canvas'}</LCButton> : null}
        </div>
      }
    >
      {active === 'overview' ? (
        <>
          {node?.description || node?.summary || group?.summary ? <p className="ws4-desc">{node?.description || node?.summary || group?.summary}</p> : null}
          {t ? (
            <div className="ws4-figs" role="group" aria-label={`Behaviour over ${period}`}>
              <span><b className="lc-num">{count(t.entered)}</b><small>{t.entered === 1 ? 'execution' : 'executions'} · {period}</small></span>
              <span data-tone={t.held ? 'attn' : undefined}><b className="lc-num">{t.entered ? pct(t.held / t.entered, 0) : '—'}</b><small>held</small></span>
              <span data-tone={t.failed ? 'crit' : t.human ? 'gold' : undefined}><b className="lc-num">{t.entered ? pct((t.failed || t.human) / t.entered, 0) : '—'}</b><small>{t.failed ? 'failed' : 'to a person'}</small></span>
              <span><b className="lc-num">{t.p50_ms !== null ? dur(t.p50_ms) : '—'}</b><small>{t.p50_ms !== null ? `p50 · p95 ${dur(t.p95_ms)}` : 'not timed by the runtime'}</small></span>
            </div>
          ) : <p className="ws4-quiet">No telemetry for this period.</p>}
          {(t?.waiting_now || live?.executing || live?.parked) ? (
            <LCInspectorSection title="Right now">
              <LCFacts rows={[
                ...(live?.executing ? [{ label: 'Executing here', value: count(live.executing) }] : []),
                ...(t?.waiting_now ? [{ label: family === 'HUMAN_REVIEW' || family === 'APPROVAL' ? 'Waiting on a person' : 'Parked here', value: count(t.waiting_now) }] : []),
                ...(live?.parked && !t?.waiting_now ? [{ label: 'Parked here', value: count(live.parked) }] : []),
              ]} />
            </LCInspectorSection>
          ) : null}
          {outgoing.length ? (
            <LCInspectorSection title="Next edges">
              <ul className="ws4-exits">
                {outgoing.map((e) => {
                  const n = telemetry?.edges[e.id] ?? null
                  const to = topology.nodes.find((x) => x.key === e.to)
                  return (
                    <li key={e.id} data-kind={e.kind}>
                      <button type="button" onClick={() => onNode(e.to)}>
                        <span className="ws4-exit__label">{e.label || (e.kind === 'primary' ? 'Next' : words(e.kind))}</span>
                        <span className="ws4-exit__to">{to?.label || e.to}</span>
                        {n !== null ? <em className="lc-num">{count(n)}{t?.entered ? ` · ${pct(n / t.entered, 0)}` : ''}</em> : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </LCInspectorSection>
          ) : null}
          {node?.outputs?.length ? <LCInspectorSection title="Outputs"><p className="ws4-mono">{node.outputs.join(' · ')}</p></LCInspectorSection> : null}
        </>
      ) : null}

      {active === 'config' && node ? <NodeConfig node={node} topology={topology} workflow={workflow} cap={cap} isStudio={isStudio} run={run} /> : null}
      {active === 'config' && group ? (
        <ol className="ws4-members">
          {members.map((m) => {
            const x = telemetry?.nodes[m.key]
            return <li key={m.key}><button type="button" onClick={() => onNode(m.key)}><span className="ws4-members__glyph" data-tone={FAMILY[m.family].tone}><Icon name={FAMILY[m.family].icon} size={11} /></span><span>{m.label}</span><b className="lc-num">{x ? count(x.entered) : '—'}</b></button></li>
          })}
        </ol>
      ) : null}

      {active === 'activity' ? <NodeActivity members={members.map((m) => m.key)} telemetry={telemetry} workflowKey={workflow.workflow_key} /> : null}
      {active === 'analytics' ? <NodeAnalytics workflowKey={workflow.workflow_key} period={period} nodeKey={node?.key || null} members={members.map((m) => m.key)} topology={topology} /> : null}
      {active === 'evidence' ? (
        <>
          <LCFacts rows={[
            { label: 'Runtime', value: node?.owner || workflow.runtime },
            { label: 'Topology', value: topology.topology_version },
            { label: 'Ledger', value: workflow.ledger.join(' · ') },
            { label: 'Proved by', value: members.flatMap((m) => m.evidence || []).join(' · ') || null },
          ]} />
          {node?.measured?.note ? <p className="ws4-note">{node.measured.note}</p> : null}
          <p className="ws4-note">A step is drawn as executed only when its ledger key was recorded for the run. Send results come from the queue row itself, never from a ledger label.</p>
        </>
      ) : null}
    </LCInspector>
  )
}

function NodeConfig({ node, topology, workflow, cap, isStudio, run }: { node: TopologyNode; topology: Topology; workflow: RegistryEntry; cap: CatalogCapability | null; isStudio: boolean; run: RunDetailResponse | null }) {
  const k = FAMILY[node.family].kind
  const exits = topology.edges.filter((e) => e.from === node.key)
  const target = (key: string) => topology.nodes.find((n) => n.key === key)?.label || key
  if (k === 'Decision') {
    return (
      <>
        <LCInspectorSection title="Decision">
          <LCFacts rows={[
            { label: 'Rule owner', value: node.owner },
            { label: 'Evaluates', value: node.action },
            { label: 'Reads', value: node.inputs?.join(' · ') },
            { label: 'Produces', value: node.outputs?.join(' · ') },
          ]} />
        </LCInspectorSection>
        <LCInspectorSection title="Branches">
          <ul className="ws4-exits">{exits.map((e) => <li key={e.id} data-kind={e.kind}><span className="ws4-exit__label">{e.label || 'Next'}</span><span className="ws4-exit__to">{target(e.to)}</span></li>)}</ul>
        </LCInspectorSection>
        {node.family === 'AI' ? <p className="ws4-note">Only the structured output (intent, signal, confidence) is shown — never a model’s reasoning.</p> : null}
        {run?.path.nodes[node.key] ? <p className="ws4-note">This run: {words(run.path.nodes[node.key].status)}{run.path.nodes[node.key].label ? ` · ${run.path.nodes[node.key].label}` : ''}{run.path.nodes[node.key].reason ? ` · ${words(run.path.nodes[node.key].reason)}` : ''}</p> : null}
      </>
    )
  }
  if (k === 'Wait') {
    const timeout = exits.find((e) => /TIMEOUT|EXHAUSTED/.test(e.label || ''))
    return (
      <LCInspectorSection title="Timing">
        <LCFacts rows={[
          { label: 'Waits', value: node.summary },
          { label: 'Timeout edge', value: timeout ? `${timeout.label} → ${target(timeout.to)}` : exits.length ? 'Continues when the wait resolves' : null },
          { label: 'Scheduled wake', value: run?.technical?.wake_at ? String(run.technical.wake_at).replace('T', ' ').slice(0, 16) : null },
          { label: 'Owner', value: node.owner },
        ]} />
        <p className="ws4-note">A workflow waiting normally is healthy — a wait becomes an exception only when it passes its wake time unresumed.</p>
      </LCInspectorSection>
    )
  }
  if (k === 'Approval') {
    const yes = exits.find((e) => /APPROVED|FOR APPROVAL/.test(e.label || '')) || exits[0]
    return (
      <LCInspectorSection title="Approval">
        <LCFacts rows={[
          { label: 'Decided by', value: node.link?.app ? `An operator in ${node.link.app}` : 'An operator' },
          { label: 'What follows', value: yes ? target(yes.to) : null },
          { label: 'Other branches', value: exits.filter((e) => e !== yes).map((e) => `${e.label || 'Next'} → ${target(e.to)}`).join(' · ') || null },
          { label: 'Owner', value: node.owner },
        ]} />
        <p className="ws4-note">No path can bypass it: the gated action runs only on the approved branch.</p>
      </LCInspectorSection>
    )
  }
  if (k === 'External') {
    return (
      <LCInspectorSection title="Handoff">
        <LCFacts rows={[{ label: 'Hands off to', value: node.handoff ? words(node.handoff) : node.label }, { label: 'Owner', value: node.owner }, { label: 'Truth', value: 'The receiving runtime owns the outcome shown here' }]} />
      </LCInspectorSection>
    )
  }
  return (
    <LCInspectorSection title="Capability">
      <LCFacts rows={[
        { label: 'Canonical capability', value: cap?.key || node.action },
        { label: 'Authority', value: cap ? `${words(cap.domain)} domain` : node.owner || workflow.owner_app },
        { label: 'Input contract', value: cap ? Object.entries(cap.inputs).map(([key, v]) => `${key}${v.required ? '*' : ''}: ${v.type}`).join(' · ') : node.inputs?.join(' · ') },
        { label: 'Output contract', value: cap?.outputs ? Object.keys(cap.outputs).join(' · ') || null : node.outputs?.join(' · ') },
        { label: 'Side effects', value: node.outputs?.length ? `writes ${node.outputs.join(', ')}` : null },
        { label: 'Approval', value: cap ? (cap.policy === 'APPROVAL' ? 'Required — must sit behind an Approval node' : cap.policy === 'AUTO' ? 'Not required — runs inside its domain’s own guards' : words(cap.policy)) : null },
        { label: 'Availability', value: cap ? `${words(cap.availability.state)}${cap.availability.reason ? ` — ${cap.availability.reason}` : ''}` : isStudio ? null : `${words(workflow.status)} in production · ${workflow.runtime}` },
      ]} />
    </LCInspectorSection>
  )
}

function NodeActivity({ members, telemetry, workflowKey }: { members: string[]; telemetry: WorkflowTelemetry | null; workflowKey: string }) {
  const s = useStudio()
  const recent = telemetry?.recent ? members.flatMap((m) => (telemetry.recent?.[m] || []).map((r) => ({ ...r, node: m }))).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12) : []
  if (!recent.length) return <LCEmpty title="No recent execution" body="Nothing passed this step in the period." compact />
  return (
    <ul className="ws4-runlist">
      {recent.map((r) => (
        <li key={`${r.run_id}:${r.node}`}>
          <button type="button" onClick={() => s.openRun(workflowKey, r.run_id, r.node)} data-status={r.status}>
            <i aria-hidden />
            <span><b>{r.subject || 'Run'}</b><small>{r.reason || words(r.status)}</small></span>
            <time className="lc-t-stamp">{ago(r.at)}</time>
          </button>
        </li>
      ))}
    </ul>
  )
}

function NodeAnalytics({ workflowKey, period, nodeKey, members, topology }: { workflowKey: string; period: Period; nodeKey: string | null; members: string[]; topology: Topology }) {
  const s = useStudio()
  const a = useResource<AnalyticsResponse>(`analytics:${workflowKey}:${period}`, (sig) => fetchAnalytics(workflowKey, period, sig))
  if (a.loading) return <LCSkeleton shape="rows" count={4} label="Reading node analytics" />
  if (!a.data) return <p className="ws4-quiet">{a.error ? `Analytics could not be read — ${a.error}` : 'No analytics.'}</p>
  const rows = a.data.bottlenecks.filter((b) => members.includes(b.key))
  const branches = a.data.branches.filter((b) => members.includes(b.node))
  const lat = nodeKey ? a.data.latency?.nodes[nodeKey] : null
  const dwell = a.data.dwell?.find((d) => members.includes(d.node))
  return (
    <>
      {rows.length ? (
        <LCFacts rows={rows.flatMap((r) => [
          { label: `${r.label} · executions`, value: count(r.entered) },
          { label: 'Held', value: r.held ? `${count(r.held)} · ${pct(r.hold_rate, 0)}` : '0' },
          { label: 'Failed', value: r.failed ? `${count(r.failed)} · ${pct(r.fail_rate, 0)}` : '0' },
          { label: 'To a person', value: r.human ? `${count(r.human)} · ${pct(r.human_rate, 0)}` : '0' },
        ])} />
      ) : <p className="ws4-quiet">No execution in {period}.</p>}
      {branches.map((b) => {
        const total = b.exits.reduce((x, e) => x + e.count, 0) || 1
        return (
          <LCInspectorSection key={b.node} title="Branch distribution">
            <ul className="ws4-branchbars">
              {b.exits.map((e) => (
                <li key={e.edge} data-kind={e.kind}>
                  <button type="button" onClick={() => s.openRuns(workflowKey, { edge: e.edge, period, label: `${b.label} → ${e.label}` })} disabled={!e.count}>
                    <span>{e.label}</span><i style={{ ['--w' as string]: `${(e.count / total) * 100}%` }} /><b className="lc-num">{pct(e.count / total, 0)}</b><em className="lc-num">{count(e.count)}</em>
                  </button>
                </li>
              ))}
            </ul>
          </LCInspectorSection>
        )
      })}
      {lat?.samples ? <LCInspectorSection title={`Measured latency · ${lat.samples} samples`}><DistributionBars d={lat} /></LCInspectorSection> : <p className="ws4-note">{topology.nodes.find((n) => n.key === nodeKey)?.measured?.note || 'This step is not timed by its runtime — no latency is shown rather than a guess.'}</p>}
      {dwell?.samples ? <LCInspectorSection title={`Dwell · ${dwell.samples} waits`}><DistributionBars d={dwell} /></LCInspectorSection> : null}
    </>
  )
}
