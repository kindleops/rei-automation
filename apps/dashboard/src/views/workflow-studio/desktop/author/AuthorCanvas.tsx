import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Icon, type IconName } from '../../../../shared/icons'
import { LCButton, LCConfirm, LCError, LCFacts, LCIconButton, LCInspector, LCInspectorSection, LCPopover, LCSelect, LCSkeleton, LCStatus, LCTooltip, type LCEffect } from '../../../../shared/lc'
import type { GraphCanvasApi } from '../canvas/GraphCanvas'
import { layoutTopology } from '../canvas/layout'
import { WorkflowBoard } from '../canvas/WorkflowBoard'
import { fetchCatalog, fetchStudioWorkflow, orchestratorAction, simulate, type CatalogCapability, type GraphDoc, type Scenario, type SimulationResult, type StudioCatalog, type StudioWorkflowResponse } from '../lib/api'
import { stamp, words } from '../lib/format'
import { useResource } from '../lib/resource'
import type { RegistryEntry } from '../lib/types'
import { useStudio } from '../studio-context'
import { defaultNode, draftTopology, exitsOf, insertAfter, removeNode, setExit, type Catalog, type GNode, type Graph, type Kind } from './graph-model'
import { sound } from '../../../../shared/sound'

type ScenarioId = 'preview' | 'replied' | 'silent' | 'rejected'
const SCENARIOS: Array<{ value: ScenarioId; label: string; hint: string }> = [
  { value: 'preview', label: 'Where it acts', hint: 'every decision takes its first branch' },
  { value: 'replied', label: 'Seller replies', hint: 'awaited events arrive after an hour; loops stop at once' },
  { value: 'silent', label: 'Nobody answers', hint: 'no event arrives — every wait times out, loops run out' },
  { value: 'rejected', label: 'Approvals rejected', hint: 'every approval is rejected' },
]

/** synthetic scenario facts — sent to the PURE simulator, never to a runtime */
function scenarioFor(id: ScenarioId, g: Graph): Scenario {
  if (id === 'preview') return { pick: 'first' }
  const events = id === 'replied' ? g.nodes.filter((n) => n.kind === 'wait' && n.config.mode === 'event').map((n) => ({ type: String(n.config.event), at_hours: 1 })) : []
  const facts: Record<string, Record<string, unknown>> = id === 'replied'
    ? { 'seller.replied_since': { last_inbound_at: '2099-01-01T00:00:00Z', since: '2000-01-01T00:00:00Z' }, 'seller.conversation_open': {}, 'seller.contactable': { contactable: true } }
    : { 'seller.replied_since': {}, 'seller.conversation_open': { in_needs_review: true }, 'seller.contactable': { contactable: true } }
  const loops = Object.fromEntries(g.nodes.filter((n) => n.kind === 'follow_up_loop').map((n) => [n.id, id === 'replied' ? 1 : 99]))
  const approvals = id === 'rejected' ? Object.fromEntries(g.nodes.filter((n) => n.kind === 'approval').map((n) => [n.id, 'Rejected' as const])) : {}
  return { events, facts, loop_stop_after: loops, approvals }
}

interface PaletteItem { kind: Kind; pick?: string; label: string; hint: string; icon: IconName; disabled?: string | null; policy?: string }

/**
 * AUTHORING — Studio workflows only, on the same board. Every action comes
 * from the typed capability catalog (an unavailable one says why and cannot
 * be placed); conditions are typed reads of canonical state; waits are
 * bounded; the only repetition is a bounded follow-up loop. Validation marks
 * the exact nodes; simulation runs on the server with ZERO writes; publishing
 * makes an immutable version through the orchestrator's own action, and runs
 * already in flight stay pinned to theirs.
 */
export function AuthorCanvas({ workflow, onExit }: { workflow: RegistryEntry; onExit: () => void }) {
  const s = useStudio()
  const key = workflow.workflow_key
  const cat = useResource<StudioCatalog>('catalog', (sig) => fetchCatalog(sig))
  const studio = useResource<StudioWorkflowResponse>(`studio:${key}`, (sig) => fetchStudioWorkflow(key, sig))
  const live: Graph | null = (studio.data?.workflow.graph as unknown as Graph) || null
  const liveVersion = studio.data?.workflow.version ?? null
  const [draft, setDraft] = useState<{ base: string; graph: Graph } | null>(null)
  const graph = draft && studio.data && draft.base === String(liveVersion) ? draft.graph : live
  const [past, setPast] = useState<Graph[]>([])
  const [future, setFuture] = useState<Graph[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [scenario, setScenario] = useState<ScenarioId>('preview')
  const [showSim, setShowSim] = useState(true)
  const [sim, setSim] = useState<{ sig: string; r: SimulationResult } | null>(null)
  const [simErr, setSimErr] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'publish' | 'arm' | 'pause' | 'exit' | null>(null)
  const [note, setNote] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const board = useRef<GraphCanvasApi | null>(null)
  // an EXPLICIT simulation (scenario chosen, path shown) sounds; the background re-check after each edit never does
  const explicitSim = useRef(false)
  const simulateExplicitly = () => { explicitSim.current = true; sound.outcome.loading() }
  const catalog: Catalog | null = useMemo(() => (cat.data ? { capabilities: cat.data.capabilities, conditions: cat.data.conditions, triggers: cat.data.triggers } : null), [cat.data])

  const commit = useCallback((g: Graph) => {
    if (!graph) return
    setPast((p) => [...p.slice(-40), graph]); setFuture([])
    setDraft({ base: String(liveVersion), graph: g })
  }, [graph, liveVersion])
  const undo = () => { const prev = past[past.length - 1]; if (!prev || !graph) return; setFuture((f) => [graph, ...f]); setPast((p) => p.slice(0, -1)); setDraft({ base: String(liveVersion), graph: prev }) }
  const redo = () => { const nx = future[0]; if (!nx || !graph) return; setPast((p) => [...p, graph]); setFuture((f) => f.slice(1)); setDraft({ base: String(liveVersion), graph: nx }) }

  // validate · describe · diff · simulate on every change — a PURE server call, debounced
  const sig = graph ? JSON.stringify([graph, scenario]) : ''
  useEffect(() => {
    if (!graph) return
    const ac = new AbortController()
    const t = window.setTimeout(() => {
      simulate(graph as unknown as GraphDoc, (live as unknown as GraphDoc) || null, scenarioFor(scenario, graph), ac.signal)
        .then((r) => { setSim({ sig, r }); setSimErr(null); if (explicitSim.current) { explicitSim.current = false; sound.outcome.ready() } })
        .catch((e) => { if ((e as Error)?.name !== 'AbortError') { setSimErr((e as Error)?.message || 'unavailable'); if (explicitSim.current) { explicitSim.current = false; sound.outcome.error() } } })
    }, 420)
    return () => { ac.abort(); window.clearTimeout(t) }
  }, [graph, live, scenario, sig])

  const result = sim?.r || null
  const fresh = sim?.sig === sig
  const dirty = Boolean(graph && live && JSON.stringify(graph) !== JSON.stringify(live))
  const topology = useMemo(() => (graph ? draftTopology(key, graph, catalog) : null), [catalog, graph, key])
  const layout = useMemo(() => (topology ? layoutTopology(topology, new Set(), { direction: 'LR' }) : null), [topology])
  const issues = useMemo(() => {
    const m = new Map<string, { errors: number; warnings: number }>()
    for (const e of result?.validation.errors || []) { const k = e.node || 'trigger'; const v = m.get(k) || { errors: 0, warnings: 0 }; v.errors++; m.set(k, v) }
    for (const w of result?.validation.warnings || []) { const k = w.node || 'trigger'; const v = m.get(k) || { errors: 0, warnings: 0 }; v.warnings++; m.set(k, v) }
    return m
  }, [result])
  const simOverlay = useMemo(() => (showSim && result ? {
    path: result.simulation.path.map((p) => p.node),
    actions: Object.fromEntries(result.simulation.actions.map((a) => [a.node, `Would ${(a.label || words(a.capability)).replace(/^./, (c) => c.toLowerCase())}`])),
  } : null), [result, showSim])

  const node = graph?.nodes.find((n) => n.id === sel) || null
  const add = (kind: Kind, pick?: string, after?: string) => {
    if (!graph) return
    const n = defaultNode(kind, catalog, pick)
    commit(insertAfter(graph, after || sel || lastNode(graph) || 'trigger', n, catalog))
    setSel(n.id)
  }
  const patch = (p: Partial<GNode>) => { if (!graph || !node) return; commit({ ...graph, nodes: graph.nodes.map((n) => (n.id === node.id ? { ...n, ...p, config: { ...n.config, ...(p.config || {}) } } : n)) }) }

  const palette = useMemo<Array<{ title: string; hint: string; items: PaletteItem[] }>>(() => [
    { title: 'Actions', hint: 'canonical capabilities', items: (cat.data?.capabilities || []).map((c) => ({ kind: 'action' as Kind, pick: c.key, label: c.label, hint: c.description, icon: c.key === 'notify.operator' ? 'bell' as IconName : 'zap' as IconName, disabled: c.availability.state !== 'AVAILABLE' ? `${words(c.availability.state)} — ${c.availability.reason || 'no canonical domain action'}` : null, policy: c.policy })) },
    { title: 'Logic', hint: 'typed reads of canonical state', items: (cat.data?.conditions || []).map((c) => ({ kind: 'condition' as Kind, pick: c.key, label: c.label, hint: `Reads ${c.reads} · ${c.exits.join(' / ')}`, icon: 'filter' as IconName })) },
    { title: 'Wait', hint: 'bounded — nothing waits forever', items: [
      { kind: 'wait', label: 'Wait a duration', hint: 'Pause for a fixed time', icon: 'clock' },
      { kind: 'wait', pick: 'event', label: 'Wait for an event', hint: 'Needs a timeout and a timeout branch', icon: 'clock' },
      { kind: 'wait', pick: 'until', label: 'Wait until a time', hint: 'Resume at a time', icon: 'clock' },
      { kind: 'follow_up_loop', label: 'Bounded follow-up loop', hint: 'Cadence · maximum · stop condition', icon: 'refresh-cw' },
    ] },
    { title: 'Approval', hint: 'a person decides', items: [{ kind: 'approval', label: 'Operator approval', hint: 'Approved / Rejected (and Timeout)', icon: 'check' }] },
    { title: 'System', hint: 'end the run', items: [{ kind: 'terminate', label: 'End with an outcome', hint: 'Makes the outcome explicit', icon: 'flag' }] },
  ], [cat.data])

  const onDragStart = (e: DragEvent<HTMLButtonElement>, it: PaletteItem) => { e.dataTransfer.setData('application/x-ws4-node', JSON.stringify({ kind: it.kind, pick: it.pick })); e.dataTransfer.effectAllowed = 'copy' }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const raw = e.dataTransfer.getData('application/x-ws4-node')
    if (!raw) return
    e.preventDefault()
    const target = (e.target as HTMLElement).closest('[data-node]')?.getAttribute('data-node') || null
    const { kind, pick } = JSON.parse(raw) as { kind: Kind; pick?: string }
    add(kind, pick, target && !target.startsWith('group:') ? target : undefined)
  }

  const run = async () => {
    if (!confirm || !graph) return
    if (confirm === 'exit') { setConfirm(null); onExit(); return }
    setBusy(true)
    const r = confirm === 'publish'
      ? await orchestratorAction('publish', { workflow_key: key, name: workflow.name, graph, note: note || null })
      : await orchestratorAction(confirm, { workflow_key: key })
    setBusy(false)
    setConfirm(null)
    if (!r.ok) { sound.outcome.error(); setNotice(`${words(confirm)} refused — ${r.errors?.map((x) => x.message).join(' · ') || r.error || r.code || 'unavailable'}`); return }
    if (confirm === 'publish') { if (!r.unchanged) sound.outcome.success('strong'); setNotice(r.unchanged ? 'Nothing changed — no new version was made.' : `Published v${r.version}. New runs start on v${r.version}; runs in flight stay on v${liveVersion}.`); setDraft(null); setPast([]); setFuture([]) }
    else setNotice(confirm === 'arm' ? 'Armed — new matching events start runs on the published version.' : 'Paused — no new runs start; runs in flight stop advancing until it is armed again.')
    studio.reload(); s.registry.reload()
  }

  if (cat.error || studio.error) return <div className="ws4-board is-empty"><LCError what="The editor could not open" detail={cat.error || studio.error || ''} onRetry={() => { cat.reload(); studio.reload() }} /></div>
  if (!graph || !topology || !layout) return <div className="ws4-loading"><LCSkeleton shape="chart" height={320} label="Opening the draft" /></div>
  const errors = result?.validation.errors || []
  const warnings = result?.validation.warnings || []
  const runsOn = (v: number) => (studio.data?.runs || []).filter((r) => r.version === v).length
  const draftV = (liveVersion || 0) + 1

  return (
    <div className="ws4-author" onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-ws4-node')) e.preventDefault() }} onDrop={onDrop}>
      <aside className="ws4-palette" aria-label="Palette">
        <header><span className="lc-eyebrow">Trigger</span></header>
        <LCSelect size="sm" variant="field" label="Trigger" value={graph.trigger.type || null} placeholder="Choose a canonical event…" onChange={(v) => commit({ ...graph, trigger: { type: v } })} options={(cat.data?.triggers || []).filter((t) => t.key !== 'manual').map((t) => ({ value: t.key, label: t.label, hint: `${t.source}${t.volume30d !== null ? ` · ${t.volume30d} in 30 days` : ''}` }))} />
        <div className="ws4-palette__scroll lc-scroll">
          {palette.map((sec) => (
            <section key={sec.title}>
              <h4>{sec.title}<small>{sec.hint}</small></h4>
              <ul>
                {sec.items.map((it) => (
                  <li key={`${it.kind}:${it.pick || it.label}`}>
                    <LCTooltip content={it.disabled ? `Unavailable — ${it.disabled}` : it.hint} side="right">
                      <button type="button" className={`ws4-pal${it.disabled ? ' is-off' : ''}`} draggable={!it.disabled} onDragStart={(e) => onDragStart(e, it)} disabled={Boolean(it.disabled)} aria-disabled={Boolean(it.disabled)} onClick={() => add(it.kind, it.pick)}>
                        <Icon name={it.icon} size={12} />
                        <span>{it.label}</span>
                        {it.disabled ? <em>unavailable</em> : it.policy === 'APPROVAL' ? <em className="is-gold">needs approval</em> : null}
                      </button>
                    </LCTooltip>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="ws4-note">Drag onto a node to place after it, or click to add after the selection. There is no free-form action: a step is a canonical capability or it does not exist.</p>
        </div>
      </aside>
      <div className="ws4-stage">
        <WorkflowBoard
          key={`author:${key}`}
          ref={board}
          topology={topology}
          layout={layout}
          telemetry={null}
          selected={sel}
          onSelect={(k) => setSel(k === 'trigger' ? null : k)}
          issues={issues}
          sim={simOverlay}
          reducedMotion={s.still}
          viewKey={`author:${key}`}
          insetRight={420}
          fitMode="contain"
          label={`${workflow.name} — draft editor`}
        >
          <div className="ws4-tool is-top" data-no-pan>
            <span className="ws4-tool__title">
              <strong>{workflow.name}</strong>
              <small className="is-studio">Editing · draft v{draftV} · {dirty ? 'unpublished changes' : 'same as live'} · live v{liveVersion ?? '—'} ({workflow.status})</small>
            </span>
            <span className="ws4-tool__grow" />
            <LCIconButton icon="arrow-down-left" label="Undo" shortcut={['⌘', 'Z']} size="sm" disabled={!past.length} onClick={undo} />
            <LCIconButton icon="arrow-up-right" label="Redo" shortcut={['⇧', '⌘', 'Z']} size="sm" disabled={!future.length} onClick={redo} />
            <LCSelect size="sm" variant="chip" label="Simulation scenario" prefix="Simulate" value={scenario} onChange={(v) => { setScenario(v); setShowSim(true); simulateExplicitly() }} options={SCENARIOS.map((x) => ({ value: x.value, label: x.label, hint: x.hint }))} />
            <button type="button" className={`ws4-livetoggle is-sim${showSim ? ' is-on' : ''}`} aria-pressed={showSim} onClick={() => { if (!showSim) simulateExplicitly(); setShowSim((v) => !v) }}><i aria-hidden />Path</button>
            <span className={`ws4-valid${errors.length ? ' is-bad' : ' is-ok'}`} role="status">{!fresh ? 'Checking…' : errors.length ? `${errors.length} issue${errors.length === 1 ? '' : 's'} · can’t publish` : `Valid${warnings.length ? ` · ${warnings.length} note${warnings.length === 1 ? '' : 's'}` : ''}`}</span>
            <Versions data={studio.data} runsOn={runsOn} />
            {workflow.status === 'armed' ? <LCButton size="sm" icon="pause" onClick={() => setConfirm('pause')}>Pause</LCButton> : liveVersion ? <LCButton size="sm" icon="play" onClick={() => setConfirm('arm')}>Arm v{liveVersion}</LCButton> : null}
            <LCButton size="sm" variant="primary" disabled={!dirty || !result?.validation.ok || !fresh || busy} onClick={() => setConfirm('publish')}>Publish v{draftV}</LCButton>
            <LCButton size="sm" variant="quiet" onClick={() => (dirty ? setConfirm('exit') : onExit())}>Done</LCButton>
          </div>
          {errors.length || warnings.length || simErr ? (
            <div className="ws4-tool is-bottom ws4-issues" data-no-pan>
              {simErr ? <p className="ws4-quiet is-error">Validation needs the studio API — {simErr}</p> : null}
              {errors.map((e, i) => <button key={`e${i}`} type="button" className="is-error" onClick={() => { if (e.node && e.node !== 'trigger') { setSel(e.node); board.current?.flyToNode(e.node) } }}><Icon name="alert" size={12} /><b>{e.node && e.node !== 'trigger' ? graph.nodes.find((n) => n.id === e.node)?.label || e.node : 'Workflow'}</b><span>{e.message}</span></button>)}
              {warnings.map((w, i) => <button key={`w${i}`} type="button" onClick={() => { if (w.node) { setSel(w.node); board.current?.flyToNode(w.node) } }}><Icon name="alert-circle" size={12} /><b>{w.node ? graph.nodes.find((n) => n.id === w.node)?.label || w.node : 'Workflow'}</b><span>{w.message}</span></button>)}
            </div>
          ) : null}
          {notice ? <div className="ws4-toast" role="status">{notice}<button type="button" className="lc-link" onClick={() => setNotice(null)}>Dismiss</button></div> : null}
        </WorkflowBoard>
        <LCInspector open onClose={() => setSel(null)} id="ws4-author" eyebrow={node ? words(node.kind) : 'Studio workflow · draft'} title={node ? node.label : workflow.name} contentKey={node?.id || 'draft'} width={400}>
          {node ? (
            <NodeEditor node={node} graph={graph} cat={catalog} onPatch={patch} onWire={(exit, to) => commit(setExit(graph, node.id, exit, to))} onDelete={() => { commit(removeNode(graph, node.id)); setSel(null) }} />
          ) : (
            <DraftSummary result={result} fresh={fresh} liveVersion={liveVersion} onFocus={(id) => { setSel(id); board.current?.flyToNode(id) }} />
          )}
          {showSim && result && node ? <SimulationPanel result={result} onFocus={(id) => { setSel(id === 'trigger' ? null : id); if (id !== 'trigger') board.current?.flyToNode(id) }} compact /> : null}
        </LCInspector>
      </div>
      <LCConfirm
        open={Boolean(confirm)}
        onOpenChange={(o) => { if (!o) setConfirm(null) }}
        title={confirm === 'publish' ? `Publish v${draftV}` : confirm === 'arm' ? `Arm v${liveVersion}` : confirm === 'pause' ? 'Pause this workflow' : 'Leave the editor'}
        tone={confirm === 'pause' || confirm === 'exit' ? 'danger' : 'primary'}
        confirmLabel={confirm === 'publish' ? (busy ? 'Publishing…' : `Publish v${draftV}`) : confirm === 'arm' ? 'Arm' : confirm === 'pause' ? 'Pause' : 'Discard the draft'}
        effects={effectsFor(confirm, { draftV, liveVersion, armed: workflow.status === 'armed', result, note, setNote })}
        onConfirm={run}
      />
    </div>
  )
}

function effectsFor(kind: 'publish' | 'arm' | 'pause' | 'exit' | null, x: { draftV: number; liveVersion: number | null; armed: boolean; result: SimulationResult | null; note: string; setNote: (v: string) => void }): LCEffect[] {
  if (kind === 'publish') return [
    { text: `Creates v${x.draftV} — immutable once published.`, kind: 'note' },
    { text: x.result?.validation.ok ? 'Validation passed: every branch is wired, waits are bounded, approvals cannot be bypassed.' : 'Validation has not passed.', kind: x.result?.validation.ok ? 'keeps' : 'danger' },
    { text: `New runs start on v${x.draftV}${x.armed ? ' (the workflow stays armed)' : ' once it is armed'}.`, kind: 'stops' },
    { text: `Runs already in flight stay pinned to v${x.liveVersion ?? '—'} until they finish.`, kind: 'keeps' },
  ]
  if (kind === 'arm') return [
    { text: 'Matching canonical events start runs on the published version, read by the orchestrator every 5 minutes.', kind: 'stops' },
    { text: 'Every action still goes through its capability’s own domain guards.', kind: 'keeps' },
  ]
  if (kind === 'pause') return [
    { text: 'No new run starts while it is paused.', kind: 'stops' },
    { text: 'Runs in flight stop advancing; the orchestrator re-checks them every 10 minutes and resumes them where they are once armed again.', kind: 'keeps' },
    { text: 'Nothing a run already did is undone.', kind: 'note' },
  ]
  if (kind === 'exit') return [{ text: 'The unpublished draft is discarded. The live version is untouched.', kind: 'danger' }]
  return []
}

function lastNode(g: Graph): string | null {
  const from = new Set(g.edges.map((e) => e.from))
  const leaf = [...g.nodes].reverse().find((n) => !from.has(n.id) && n.kind !== 'terminate')
  return leaf?.id || (g.nodes.length ? null : 'trigger')
}

function Versions({ data, runsOn }: { data: StudioWorkflowResponse | null; runsOn: (v: number) => number }) {
  if (!data) return null
  return (
    <LCPopover label="Versions" side="bottom" align="end" width={320} trigger={<button type="button" className="ws4-chipbtn"><Icon name="layers" size={12} />v{data.workflow.version ?? '—'} · {data.versions.length} version{data.versions.length === 1 ? '' : 's'}</button>}>
      <div className="ws4-versions">
        <p className="lc-eyebrow">Published versions · immutable</p>
        <ol>
          {data.versions.map((v) => (
            <li key={v.version} className={v.version === data.workflow.version ? 'is-live' : undefined}>
              <b>v{v.version}{v.version === data.workflow.version ? <em>live</em> : null}</b>
              <span>{stamp(v.published_at)}{v.published_by ? ` · ${v.published_by}` : ''}</span>
              <small>{runsOn(v.version)} run{runsOn(v.version) === 1 ? '' : 's'} pinned{v.note ? ` · ${v.note}` : ''}</small>
            </li>
          ))}
        </ol>
        <p className="ws4-note">A run stays on the version it started with; a new publish affects future runs only.</p>
      </div>
    </LCPopover>
  )
}

function DraftSummary({ result, fresh, liveVersion, onFocus }: { result: SimulationResult | null; fresh: boolean; liveVersion: number | null; onFocus: (id: string) => void }) {
  if (!result) return <LCSkeleton shape="lines" count={4} label="Validating the draft" />
  return (
    <>
      <p className="ws4-desc">{result.description}</p>
      <LCInspectorSection title={`Changes vs v${liveVersion ?? '—'}`}>
        {result.diff.length ? (
          <ul className="ws4-diff">{result.diff.map((d, i) => <li key={i} data-kind={d.kind}><button type="button" disabled={!d.node} onClick={() => d.node && onFocus(d.node)}><b>{d.kind === 'added' ? '+' : d.kind === 'removed' ? '−' : '~'}</b><span>{d.text}</span></button></li>)}</ul>
        ) : <p className="ws4-quiet">No change from the live version.</p>}
      </LCInspectorSection>
      <SimulationPanel result={result} onFocus={onFocus} />
      {!fresh ? <p className="ws4-note">Re-checking the latest edit…</p> : null}
    </>
  )
}

function SimulationPanel({ result, onFocus, compact = false }: { result: SimulationResult; onFocus: (id: string) => void; compact?: boolean }) {
  const sim = result.simulation
  return (
    <LCInspectorSection title="Simulation · no writes" aside={<LCStatus label={`${sim.writes} writes · ${words(sim.outcome)}`} tone={sim.writes ? 'crit' : 'flow'} quiet />} className="ws4-simbox">
      <ol className="ws4-path is-sim">
        {sim.path.map((p, i) => (
          <li key={`${p.node}:${i}`} data-status="sim">
            <button type="button" onClick={() => onFocus(p.node)}>
              <span className="ws4-path__mark"><Icon name={p.kind === 'action' ? 'zap' : p.kind === 'wait' ? 'clock' : p.kind === 'approval' ? 'check' : p.kind === 'condition' ? 'filter' : p.kind === 'trigger' ? 'bolt' : 'flag'} size={10} /></span>
              <span className="ws4-path__name">{p.label}</span>
              <span className="ws4-path__what">{p.exit ? `→ ${p.exit}` : ''}{p.why ? ` · ${p.why}` : ''} · +{p.at_hours}h</span>
            </button>
          </li>
        ))}
      </ol>
      {!compact && sim.actions.length ? (
        <>
          <h4 className="ws4-asub">Would execute</h4>
          <ul className="ws4-would">{sim.actions.map((a, i) => <li key={i}><b>WOULD</b><span>{a.preview || a.label || words(a.capability)}{a.attempt ? ` · attempt ${a.attempt}` : ''}</span><small>+{a.at_hours}h</small></li>)}</ul>
        </>
      ) : null}
      {!compact && sim.waits.length ? <LCFacts rows={sim.waits.map((w, i) => ({ label: `${words(w.kind)} ${i + 1}`, value: w.kind === 'approval' ? `“${w.title}” from +${w.from_hours}h` : w.timeout_hours ? `up to ${w.timeout_hours}h from +${w.from_hours}h → ${w.resolved}` : `${w.duration_hours ?? 0}h from +${w.from_hours}h` }))} /> : null}
      <p className="ws4-note">The server ran each capability’s <code>simulate</code>, never <code>invoke</code>: nothing was sent, queued or written.</p>
    </LCInspectorSection>
  )
}

function NodeEditor({ node, graph, cat, onPatch, onWire, onDelete }: { node: GNode; graph: Graph; cat: Catalog | null; onPatch: (p: Partial<GNode>) => void; onWire: (exit: string, to: string | null) => void; onDelete: () => void }) {
  const c = node.config as Record<string, unknown>
  const cap: CatalogCapability | undefined = cat?.capabilities.find((x) => x.key === c.capability)
  const others = graph.nodes.filter((n) => n.id !== node.id)
  const num = (k: string, v: string) => onPatch({ config: { [k]: Number(v) } })
  const inputs = (c.inputs as Record<string, unknown>) || {}
  return (
    <>
      <label className="ws4-field-row"><span>Label</span><input className="ws4-input" value={node.label} onChange={(e) => onPatch({ label: e.target.value })} /></label>
      {node.kind === 'action' ? (
        <LCInspectorSection title="Capability">
          <LCSelect size="sm" variant="field" label="Capability" value={String(c.capability || '') || null} onChange={(v) => onPatch({ config: { capability: v, inputs: {} } })} options={(cat?.capabilities || []).map((x) => ({ value: x.key, label: x.label, disabled: x.availability.state !== 'AVAILABLE', hint: x.availability.state !== 'AVAILABLE' ? `Unavailable — ${x.availability.reason || ''}` : x.policy === 'APPROVAL' ? 'needs an Approval on every path' : words(x.domain) }))} />
          {cap ? <LCFacts rows={[{ label: 'Authority', value: `${words(cap.domain)} domain` }, { label: 'Approval', value: cap.policy === 'APPROVAL' ? 'Required on every path' : 'Not required' }, { label: 'Availability', value: words(cap.availability.state) }, { label: 'Outputs', value: Object.keys(cap.outputs || {}).join(' · ') || null }]} /> : null}
          {cap ? Object.entries(cap.inputs).filter(([k]) => !['seller', 'closing', 'campaign', 'opportunity', 'property', 'recipient', 'entity', 'thread'].includes(k)).map(([k, spec]) => (
            <label key={k} className="ws4-field-row"><span>{words(k)}{spec.required ? ' *' : ''}</span>
              {spec.type === 'enum'
                ? <LCSelect size="sm" variant="field" label={words(k)} value={String(inputs[k] ?? '') || null} onChange={(v) => onPatch({ config: { inputs: { ...inputs, [k]: v } } })} options={(spec.values || []).map((v) => ({ value: v, label: words(v) }))} />
                : <input className="ws4-input" value={String(inputs[k] ?? '')} onChange={(e) => onPatch({ config: { inputs: { ...inputs, [k]: e.target.value } } })} />}
            </label>
          )) : null}
          <label className="ws4-check"><input type="checkbox" checked={c.on_failure === 'branch'} onChange={(e) => onPatch({ config: { on_failure: e.target.checked ? 'branch' : undefined } })} />Branch on failure (Success / Failed)</label>
        </LCInspectorSection>
      ) : null}
      {node.kind === 'condition' ? (
        <LCInspectorSection title="Typed condition">
          <LCSelect size="sm" variant="field" label="Condition" value={String(c.condition || '') || null} onChange={(v) => onPatch({ config: { condition: v } })} options={(cat?.conditions || []).map((x) => ({ value: x.key, label: x.label, hint: `Reads ${x.reads}` }))} />
          <p className="ws4-note">Conditions read canonical state through the owning authority — no SQL, no free text.</p>
        </LCInspectorSection>
      ) : null}
      {node.kind === 'wait' ? (
        <LCInspectorSection title="Wait">
          <LCSelect size="sm" variant="field" label="Wait for" value={String(c.mode)} onChange={(v) => onPatch({ config: { mode: v } })} options={[{ value: 'duration', label: 'A duration' }, { value: 'until', label: 'A time' }, { value: 'event', label: 'An event (with timeout)' }, { value: 'contact_window', label: 'The contact window' }]} />
          {c.mode === 'duration' ? <label className="ws4-field-row"><span>Hours</span><input className="ws4-input" type="number" min={1} value={Number(c.duration_hours || 1)} onChange={(e) => num('duration_hours', e.target.value)} /></label> : null}
          {c.mode === 'until' ? <label className="ws4-field-row"><span>Until (ISO time)</span><input className="ws4-input" value={String(c.until || '')} onChange={(e) => onPatch({ config: { until: e.target.value } })} placeholder="2026-10-02T15:00:00Z" /></label> : null}
          {c.mode === 'event' ? <>
            <LCSelect size="sm" variant="field" label="Event" value={String(c.event || '') || null} onChange={(v) => onPatch({ config: { event: v } })} options={(cat?.triggers || []).filter((t) => t.key !== 'manual').map((t) => ({ value: t.key, label: t.label }))} />
            <label className="ws4-field-row"><span>Timeout (hours) *</span><input className="ws4-input" type="number" min={1} value={Number(c.timeout_hours || 0)} onChange={(e) => num('timeout_hours', e.target.value)} /></label>
            <p className="ws4-note">Waiting for an event needs a timeout and a wired Timeout branch — nothing may wait forever.</p>
          </> : null}
        </LCInspectorSection>
      ) : null}
      {node.kind === 'approval' ? (
        <LCInspectorSection title="Approval">
          <label className="ws4-field-row"><span>What the operator sees *</span><input className="ws4-input" value={String(c.title || '')} onChange={(e) => onPatch({ config: { title: e.target.value } })} /></label>
          <label className="ws4-field-row"><span>Expires after (hours)</span><input className="ws4-input" type="number" min={0} value={Number(c.timeout_hours || 0)} onChange={(e) => num('timeout_hours', e.target.value)} /></label>
          <p className="ws4-note">The gated action runs only on the Approved branch; Rejected (and Timeout) must be wired.</p>
        </LCInspectorSection>
      ) : null}
      {node.kind === 'follow_up_loop' ? (
        <LCInspectorSection title="Bounded loop">
          <label className="ws4-field-row"><span>Every (hours)</span><input className="ws4-input" type="number" min={1} value={Number(c.cadence_hours || 24)} onChange={(e) => num('cadence_hours', e.target.value)} /></label>
          <label className="ws4-field-row"><span>At most (≤ 10)</span><input className="ws4-input" type="number" min={1} max={10} value={Number(c.max_attempts || 3)} onChange={(e) => num('max_attempts', e.target.value)} /></label>
          <p className="ws4-note">Stops when {words(String((c.stop as { condition?: string })?.condition || 'its stop condition'))} → {String((c.stop as { when?: string })?.when || '—')}. This loop is the only way a workflow repeats.</p>
        </LCInspectorSection>
      ) : null}
      {node.kind === 'terminate' ? <label className="ws4-field-row"><span>Outcome</span><input className="ws4-input" value={String(c.outcome || '')} onChange={(e) => onPatch({ config: { outcome: e.target.value } })} /></label> : null}
      {exitsOf(node, cat).length ? (
        <LCInspectorSection title="Exits · connect">
          {exitsOf(node, cat).map((x) => {
            const cur = graph.edges.find((e) => e.from === node.id && (e.exit || 'Next') === x)?.to || ''
            return (
              <label key={x} className="ws4-field-row"><span>{x === 'Next' ? 'Then' : x}</span>
                <LCSelect size="sm" variant="field" label={`${x} goes to`} value={cur || '__none'} onChange={(v) => onWire(x, v === '__none' ? null : v)} options={[{ value: '__none', label: '— not connected —' }, ...others.map((o) => ({ value: o.id, label: o.label }))]} />
              </label>
            )
          })}
        </LCInspectorSection>
      ) : null}
      <div className="ws4-actions"><LCButton size="sm" variant="danger" icon="x" onClick={onDelete}>Remove step</LCButton></div>
    </>
  )
}
