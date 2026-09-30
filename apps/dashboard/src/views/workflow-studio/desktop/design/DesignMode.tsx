import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Icon } from '../../../../shared/icons'
import { callBackend } from '../../../../lib/api/backendClient'
import type { RegistryEntry } from '../observatory-types'
import { StudioCanvas, type CanvasApi } from '../canvas/StudioCanvas'
import { useReducedMotion } from '../use-studio-data'
import { defaultNode, draftTopology, exitsOf, insertAfter, removeNode, setExit, type Catalog, type GNode, type Graph, type Kind } from './design-graph'

const BASE = '/api/cockpit/workflow-studio'
interface Issue { code: string; node: string | null; message: string }
interface SimResult { validation: { ok: boolean; errors: Issue[]; warnings: Issue[] }; description: string; diff: Array<{ kind: string; node?: string; text: string }>; simulation: { outcome: string; path: Array<{ node: string; label: string; exit?: string; why?: string; at_hours: number }>; actions: Array<{ label: string; preview: string | null }>; waits: unknown[]; duration_hours: number; writes: number } }

async function get<T>(path: string): Promise<T> {
  const r = await callBackend<T & { ok: boolean }>(path, { timeoutMs: 30_000 })
  if (!r.ok || !r.data) throw new Error((r as { error?: string }).error || 'unavailable')
  return r.data as T
}
async function post<T>(path: string, body: unknown): Promise<T & { ok: boolean; error?: string; code?: string; errors?: Issue[] }> {
  const r = await callBackend<T & { ok: boolean }>(path, { method: 'POST', body: JSON.stringify(body), timeoutMs: 30_000 })
  if (!r.ok) { const up = r.upstream as (T & { ok: boolean; error?: string }) | undefined; return up && typeof up === 'object' && 'ok' in up ? up : ({ ok: false, error: (r as { error?: string }).error || 'request_failed' } as T & { ok: boolean; error?: string }) }
  return (r.data as T & { ok: boolean }) || ({ ok: false, error: 'empty_response' } as T & { ok: boolean; error?: string })
}

const PALETTE: Array<{ kind: Kind; label: string; pick?: string; hint: string }> = [
  { kind: 'wait', label: 'Wait · duration', hint: 'Pause for a fixed time' },
  { kind: 'wait', label: 'Wait · until event', pick: 'event', hint: 'Needs a timeout — nothing waits forever' },
  { kind: 'wait', label: 'Wait · until time', pick: 'until', hint: 'Resume at a time' },
  { kind: 'approval', label: 'Approval', hint: 'An operator approves or rejects' },
  { kind: 'follow_up_loop', label: 'Follow-up loop', hint: 'Bounded: cadence · max · stop' },
  { kind: 'terminate', label: 'End', hint: 'Finish with an outcome' },
]

/**
 * DESIGN — Studio workflows only. Palette of REAL capabilities and registered
 * triggers; typed conditions (no eval); bounded waits and loops; SIMULATE with
 * test facts (no writes, the path lit); immutable versions with a diff; publish
 * through the existing orchestrator action — runs in flight stay pinned.
 */
export function DesignMode({ workflow, onDone }: { workflow: RegistryEntry; onDone: () => void }) {
  const still = useReducedMotion()
  const [cat, setCat] = useState<Catalog | null>(null)
  const [live, setLive] = useState<Graph | null>(null)
  const [liveVersion, setLiveVersion] = useState<number | null>(null)
  const [graph, setGraph] = useState<Graph | null>(null)
  const [past, setPast] = useState<Graph[]>([])
  const [future, setFuture] = useState<Graph[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [sim, setSim] = useState<SimResult | null>(null)
  const [simErr, setSimErr] = useState<string | null>(null)
  const [showSim, setShowSim] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const canvas = useRef<CanvasApi | null>(null)

  useEffect(() => {
    let off = false
    Promise.all([get<Catalog & { ok: boolean }>(`${BASE}/catalog`), get<{ workflow: { graph: Graph | null; version: number | null; name: string } }>(`${BASE}/studio/${encodeURIComponent(workflow.workflow_key)}`)])
      .then(([c, w]) => { if (off) return; setCat(c); setLive(w.workflow.graph); setLiveVersion(w.workflow.version); setGraph(w.workflow.graph ? JSON.parse(JSON.stringify(w.workflow.graph)) : { schema: 'lc.workflow/v1', trigger: { type: '' }, nodes: [], edges: [] }) })
      .catch((e) => { if (!off) setNotice(`The studio catalog could not be read — ${(e as Error).message}`) })
    return () => { off = true }
  }, [workflow.workflow_key])

  const commit = useCallback((g: Graph) => { setPast((p) => (graph ? [...p.slice(-40), graph] : p)); setFuture([]); setGraph(g) }, [graph])
  const undo = () => { const prev = past[past.length - 1]; if (!prev || !graph) return; setFuture((f) => [graph, ...f]); setPast((p) => p.slice(0, -1)); setGraph(prev) }
  const redo = () => { const nx = future[0]; if (!nx || !graph) return; setPast((p) => [...p, graph]); setFuture((f) => f.slice(1)); setGraph(nx) }
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return; e.preventDefault(); if (e.shiftKey) redo(); else undo() }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  })

  // validate + describe + diff + simulate on every change (pure server call, debounced)
  useEffect(() => {
    if (!graph) return
    const t = window.setTimeout(async () => {
      const r = await post<SimResult>(`${BASE}/simulate`, { graph, previous: live, scenario: {} })
      if (r.ok) { setSim(r); setSimErr(null) } else setSimErr(r.error || 'unavailable')
    }, 500)
    return () => window.clearTimeout(t)
  }, [graph, live])

  const dirty = useMemo(() => JSON.stringify(graph) !== JSON.stringify(live), [graph, live])
  const topology = useMemo(() => (graph ? draftTopology(workflow.workflow_key, graph, cat) : null), [cat, graph, workflow.workflow_key])
  const node = graph?.nodes.find((n) => n.id === sel) || null
  const errors = sim?.validation.errors || []
  const simOverlay = useMemo(() => (showSim && sim ? { nodes: Object.fromEntries(sim.simulation.path.map((p) => [p.node, { status: 'succeeded' }])), edges: [], focus: null } : null), [showSim, sim])

  const add = (kind: Kind, pick?: string) => {
    if (!graph) return
    const n = defaultNode(kind, cat, pick)
    commit(insertAfter(graph, sel || lastNode(graph) || 'trigger', n, cat)); setSel(n.id)
  }
  const patch = (p: Partial<GNode>) => { if (!graph || !node) return; commit({ ...graph, nodes: graph.nodes.map((n) => (n.id === node.id ? { ...n, ...p, config: { ...n.config, ...(p.config || {}) } } : n)) }) }

  const setStatus = async (action: 'arm' | 'pause') => {
    setBusy(action)
    const r = await post<{ status: string }>(`${BASE}/orchestrator/actions`, { action, workflow_key: workflow.workflow_key })
    setBusy(null)
    setNotice(r.ok ? (action === 'arm' ? 'Armed — new matching events start runs on the published version.' : 'Paused — no new runs start; runs in flight wait until you arm it again.') : `Refused — ${r.error || r.code}`)
    if (r.ok) onDone()
  }

  const publish = async () => {
    if (!graph) return
    setBusy('publish')
    const r = await post<{ version: number; unchanged?: boolean }>(`${BASE}/orchestrator/actions`, { action: 'publish', workflow_key: workflow.workflow_key, name: workflow.name, graph, note: note || null })
    setBusy(null)
    if (!r.ok) { setNotice(`Publish refused — ${r.errors?.map((e) => e.message).join(' · ') || r.error || r.code}`); return }
    setConfirm(false); setNotice(r.unchanged ? 'Nothing changed — no new version.' : `Published v${r.version}. Runs already in flight stay on v${liveVersion}.`)
    setLive(graph); setLiveVersion(r.version); onDone()
  }

  if (!graph || !topology) return <div className="ws3-loading">{notice || <><i className="ws3-spin" />Opening the draft…</>}</div>

  return (
    <div className="ws3-design">
      <aside className="ws3-palette" aria-label="Palette">
        <h4>Trigger</h4>
        <label className="ws3-select is-block"><select value={graph.trigger.type} onChange={(e) => commit({ ...graph, trigger: { type: e.target.value } })} aria-label="Trigger">
          <option value="">Choose a registered trigger…</option>
          {cat?.triggers.map((t) => <option key={t.key} value={t.key}>{t.label}{t.volume30d !== null ? ` · ${t.volume30d}/30d` : ''}</option>)}
        </select></label>
        <h4>Actions<small>canonical capabilities</small></h4>
        <ul>{cat?.capabilities.map((c) => <li key={c.key}><button type="button" disabled={c.availability.state !== 'AVAILABLE'} title={c.availability.reason || c.description} onClick={() => add('action', c.key)}><Icon name={c.key === 'notify.operator' ? 'bell' : 'zap'} /><span>{c.label}<small>{c.availability.state !== 'AVAILABLE' ? 'unavailable' : c.policy === 'APPROVAL' ? 'needs approval' : c.domain}</small></span></button></li>)}</ul>
        <h4>Conditions<small>typed · read canonical state</small></h4>
        <ul>{cat?.conditions.map((c) => <li key={c.key}><button type="button" onClick={() => add('condition', c.key)} title={`Reads ${c.reads}`}><Icon name="filter" /><span>{c.label}<small>{c.exits.join(' / ')}</small></span></button></li>)}</ul>
        <h4>Flow</h4>
        <ul>{PALETTE.map((p) => <li key={p.label}><button type="button" onClick={() => add(p.kind, p.pick)} title={p.hint}><Icon name={p.kind === 'wait' ? 'clock' : p.kind === 'approval' ? 'check' : p.kind === 'follow_up_loop' ? 'refresh-cw' : 'flag'} /><span>{p.label}<small>{p.hint}</small></span></button></li>)}</ul>
      </aside>

      <div className="ws3-stage">
        <StudioCanvas ref={canvas} topology={topology} telemetry={null} expanded={EMPTY} selected={sel} onSelect={setSel} run={simOverlay} reducedMotion={still} />
        <header className="ws3-tool is-top" data-no-pan>
          <span className="ws3-tool__title"><strong>{workflow.name}</strong><small>CURRENT v{liveVersion ?? '—'} · {dirty ? `DRAFT v${(liveVersion || 0) + 1} · unsaved` : 'no changes'}</small></span>
          <span className="ws3-tool__grow" />
          <button type="button" className="ws3-iconbtn" onClick={undo} disabled={!past.length} aria-label="Undo" title="Undo (⌘Z)"><Icon name="arrow-down-left" /></button>
          <button type="button" className="ws3-iconbtn" onClick={redo} disabled={!future.length} aria-label="Redo" title="Redo (⇧⌘Z)"><Icon name="arrow-up-right" /></button>
          <button type="button" className={`ws3-btn${showSim ? ' is-on' : ''}`} onClick={() => setShowSim((v) => !v)} disabled={!sim}><Icon name="play" />Simulate</button>
          {errors.length ? (
            <span className="ws3-cantpublish" role="status">CAN'T PUBLISH · {errors.length} issue{errors.length === 1 ? '' : 's'}</span>
          ) : null}
          {workflow.status === 'armed'
            ? <button type="button" className="ws3-btn" disabled={Boolean(busy)} onClick={() => void setStatus('pause')}><Icon name="pause" />Pause</button>
            : liveVersion ? <button type="button" className="ws3-btn" disabled={Boolean(busy)} onClick={() => void setStatus('arm')}><Icon name="play" />Arm v{liveVersion}</button> : null}
          <button type="button" className="ws3-btn is-primary" disabled={!dirty || !sim?.validation.ok || Boolean(busy)} onClick={() => setConfirm(true)}>Publish v{(liveVersion || 0) + 1}</button>
        </header>
        {errors.length || simErr ? (
          <div className="ws3-issues" data-no-pan>
            {simErr ? <p className="ws3-quiet is-error">Validation needs the studio API — {simErr}.</p> : null}
            {errors.map((e, i) => <button key={i} type="button" onClick={() => { if (e.node) { setSel(e.node); canvas.current?.flyToNode(e.node) } }}><Icon name="alert" /><span>{e.message}</span></button>)}
          </div>
        ) : null}
        {notice ? <div className="ws3-toast" role="status">{notice}<button type="button" className="ws3-iconbtn" onClick={() => setNotice(null)} aria-label="Dismiss"><Icon name="close" /></button></div> : null}
      </div>

      <aside className="ws3-insp is-design" aria-label="Node editor">
        {node ? (
          <NodeEditor node={node} graph={graph} cat={cat} onPatch={patch} onWire={(exit, to) => commit(setExit(graph, node.id, exit, to))} onDelete={() => { commit(removeNode(graph, node.id)); setSel(null) }} />
        ) : (
          <>
            <header className="ws3-insp__head"><span className="ws3-insp__glyph"><Icon name="spark" /></span><span className="ws3-insp__title"><small>Studio workflow · draft</small><strong>{workflow.name}</strong></span></header>
            <p className="ws3-insp__desc">{sim?.description || 'Choose a trigger, then add steps from the palette. Select a node to edit it.'}</p>
            {sim?.diff.length ? (
              <section className="ws3-insp__sec">
                <h4>Changes vs v{liveVersion}</h4>
                <ul className="ws3-diff">{sim.diff.map((d, i) => <li key={i} className={`is-${d.kind}`}><b>{d.kind === 'changed' && /: label /.test(d.text) ? 'layout-only' : d.kind}</b>{d.text}</li>)}</ul>
              </section>
            ) : null}
          </>
        )}
        {showSim && sim ? (
          <section className="ws3-insp__sec ws3-simbox">
            <h4>SIMULATION · no writes<em>{sim.simulation.outcome.replace(/_/g, ' ')}</em></h4>
            <ol className="ws3-tl">{sim.simulation.path.map((p, i) => <li key={i}><button type="button" onClick={() => setSel(p.node === 'trigger' ? null : p.node)}><i className="ws3-dot is-completed" aria-hidden /><span><b>{p.label}</b><small>{p.exit ? `→ ${p.exit} · ` : ''}{p.why || ''}</small></span><time>+{p.at_hours}h</time></button></li>)}</ol>
            {sim.simulation.actions.length ? <p className="ws3-note">Would request: {sim.simulation.actions.map((a) => a.preview || a.label).join(' · ')}</p> : null}
          </section>
        ) : null}
      </aside>

      {confirm ? (
        <div className="ws3-modal" role="dialog" aria-modal="true" aria-label="Publish">
          <div className="ws3-modal__card">
            <h3>Publish v{(liveVersion || 0) + 1}</h3>
            <p>{sim?.description}</p>
            {sim?.diff.length ? <ul className="ws3-diff">{sim.diff.map((d, i) => <li key={i} className={`is-${d.kind}`}><b>{d.kind}</b>{d.text}</li>)}</ul> : null}
            <p className="ws3-note">Versions are immutable. New runs start on v{(liveVersion || 0) + 1}; runs already in flight stay pinned to v{liveVersion}. {workflow.status === 'armed' ? 'The workflow stays armed.' : 'It stays in draft until you arm it.'}</p>
            <input className="ws3-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed (optional)" aria-label="Change note" />
            <div className="ws3-modal__actions"><button type="button" className="ws3-btn" onClick={() => setConfirm(false)}>Cancel</button><button type="button" className="ws3-btn is-primary" onClick={() => void publish()} disabled={Boolean(busy)}>{busy ? 'Publishing…' : 'Publish'}</button></div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function lastNode(g: Graph): string | null {
  const from = new Set(g.edges.map((e) => e.from))
  const leaf = [...g.nodes].reverse().find((n) => !from.has(n.id) && n.kind !== 'terminate')
  return leaf?.id || (g.nodes.length ? null : 'trigger')
}

function NodeEditor({ node, graph, cat, onPatch, onWire, onDelete }: { node: GNode; graph: Graph; cat: Catalog | null; onPatch: (p: Partial<GNode>) => void; onWire: (exit: string, to: string | null) => void; onDelete: () => void }) {
  const c = node.config as Record<string, unknown>
  const cap = cat?.capabilities.find((x) => x.key === c.capability)
  const num = (k: string) => (e: ChangeEvent<HTMLInputElement>) => onPatch({ config: { [k]: Number(e.target.value) } })
  const txt = (k: string) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onPatch({ config: { [k]: e.target.value } })
  const others = graph.nodes.filter((n) => n.id !== node.id)
  return (
    <>
      <header className="ws3-insp__head">
        <span className="ws3-insp__glyph"><Icon name={node.kind === 'wait' ? 'clock' : node.kind === 'condition' ? 'filter' : node.kind === 'approval' ? 'check' : node.kind === 'terminate' ? 'flag' : node.kind === 'follow_up_loop' ? 'refresh-cw' : 'zap'} /></span>
        <span className="ws3-insp__title"><small>{node.kind.replace(/_/g, ' ')}</small><input className="ws3-input is-title" value={node.label} onChange={(e) => onPatch({ label: e.target.value })} aria-label="Label" /></span>
        <button type="button" className="ws3-iconbtn" onClick={onDelete} aria-label="Delete node" title="Delete"><Icon name="x" /></button>
      </header>
      <section className="ws3-insp__sec">
        <h4>Configuration</h4>
        <div className="ws3-form">
          {node.kind === 'action' ? (
            <>
              <label>Capability<select value={String(c.capability || '')} onChange={(e) => onPatch({ config: { capability: e.target.value, inputs: {} } })}>{cat?.capabilities.map((x) => <option key={x.key} value={x.key} disabled={x.availability.state !== 'AVAILABLE'}>{x.label}</option>)}</select></label>
              {cap ? <p className="ws3-note">{cap.description}{cap.policy === 'APPROVAL' ? ' Requires an Approval on every path.' : ''}</p> : null}
              {cap ? Object.entries(cap.inputs).filter(([k]) => !['seller', 'closing', 'campaign', 'opportunity', 'property', 'recipient', 'entity', 'thread'].includes(k)).map(([k, spec]) => (
                <label key={k}>{k.replace(/_/g, ' ')}{spec.required ? ' *' : ''}
                  {spec.type === 'enum' ? <select value={String((c.inputs as Record<string, unknown>)?.[k] ?? '')} onChange={(e) => onPatch({ config: { inputs: { ...(c.inputs as object), [k]: e.target.value } } })}><option value="">—</option>{spec.values?.map((v) => <option key={v} value={v}>{v.replace(/_/g, ' ')}</option>)}</select>
                    : <input value={String((c.inputs as Record<string, unknown>)?.[k] ?? '')} onChange={(e) => onPatch({ config: { inputs: { ...(c.inputs as object), [k]: e.target.value } } })} />}
                </label>
              )) : null}
              <label className="is-check"><input type="checkbox" checked={c.on_failure === 'branch'} onChange={(e) => onPatch({ config: { on_failure: e.target.checked ? 'branch' : undefined } })} />Branch on failure (Success / Failed)</label>
            </>
          ) : null}
          {node.kind === 'condition' ? <label>Condition<select value={String(c.condition || '')} onChange={txt('condition')}>{cat?.conditions.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></label> : null}
          {node.kind === 'wait' ? (
            <>
              <label>Wait for<select value={String(c.mode)} onChange={txt('mode')}><option value="duration">A duration</option><option value="until">A time</option><option value="event">An event (with timeout)</option><option value="contact_window">The contact window</option></select></label>
              {c.mode === 'duration' ? <><label>Hours<input type="number" min={1} value={Number(c.duration_hours || 1)} onChange={num('duration_hours')} /></label><label>Count from<select value={String(c.anchor || 'run')} onChange={txt('anchor')}><option value="run">The run</option><option value="trigger">The triggering event</option></select></label></> : null}
              {c.mode === 'until' ? <label>Until (ISO time)<input value={String(c.until || '')} onChange={txt('until')} placeholder="2026-10-01T15:00:00Z" /></label> : null}
              {c.mode === 'event' ? <><label>Event<select value={String(c.event || '')} onChange={txt('event')}>{cat?.triggers.filter((t) => t.key !== 'manual').map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label><label>Timeout (hours) *<input type="number" min={1} value={Number(c.timeout_hours || 0)} onChange={num('timeout_hours')} /></label></> : null}
            </>
          ) : null}
          {node.kind === 'approval' ? <><label>Title *<input value={String(c.title || '')} onChange={txt('title')} /></label><label>Timeout (hours)<input type="number" min={0} value={Number(c.timeout_hours || 0)} onChange={num('timeout_hours')} /></label></> : null}
          {node.kind === 'follow_up_loop' ? <><label>Every (hours)<input type="number" min={1} value={Number(c.cadence_hours || 24)} onChange={num('cadence_hours')} /></label><label>At most (attempts ≤ 10)<input type="number" min={1} max={10} value={Number(c.max_attempts || 3)} onChange={num('max_attempts')} /></label><p className="ws3-note">Stops when {String((c.stop as { condition?: string })?.condition || 'its stop condition')} → {String((c.stop as { when?: string })?.when || '—')}. No arbitrary cycles: this bounded loop is the only way to repeat.</p></> : null}
          {node.kind === 'terminate' ? <label>Outcome<input value={String(c.outcome || '')} onChange={txt('outcome')} /></label> : null}
        </div>
      </section>
      {exitsOf(node, cat).length ? (
        <section className="ws3-insp__sec">
          <h4>Exits · connect</h4>
          <div className="ws3-form">
            {exitsOf(node, cat).map((x) => {
              const cur = graph.edges.find((e) => e.from === node.id && (e.exit || 'Next') === x)?.to || ''
              return <label key={x}>{x === 'Next' ? 'Then' : x}<select value={cur} onChange={(e) => onWire(x, e.target.value || null)}><option value="">— not connected —</option>{others.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
            })}
          </div>
        </section>
      ) : null}
    </>
  )
}

const EMPTY: ReadonlySet<string> = new Set()
