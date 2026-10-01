import { useCallback, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { LCButton, LCError, LCFacts, LCIconButton, LCInspector, LCInspectorSection, LCPopover, LCSegmented, LCSkeleton, LCStatus } from '../../../../shared/lc'
import { pushRoutePath } from '../../../../app/router'
import type { GraphCanvasApi } from '../canvas/GraphCanvas'
import { useTrafficPulses } from '../canvas/pulses'
import { fetchRuns, fetchSystemMap } from '../lib/api'
import { SYSTEM_EDGE, WORKFLOW_FAMILY } from '../lib/families'
import { ago, count, words } from '../lib/format'
import { useResource } from '../lib/resource'
import type { ExceptionItem, RegistryEntry, SystemEdge, SystemMapResponse, SystemNode } from '../lib/types'
import { findWorkflow, useStudio } from '../studio-context'
import { ExceptionQueue } from './ExceptionQueue'
import { RuntimeHealth } from './RuntimeHealth'
import { SystemMap } from './SystemMap'
import { neighbourhood } from './system-layout'
import { systemFacts, systemStatus } from './system-model'
import { sound } from '../../../../shared/sound'

/**
 * OVERVIEW — the automation architecture of the company. The signature object
 * is the system topology (real relationships only); beside it, what needs a
 * person and whether every runtime's heartbeat is current.
 */
export function OverviewMode() {
  const s = useStudio()
  const [window, setWindow] = useState<'24h' | '7d'>('24h')
  const [sel, setSel] = useState<string | null>(null)
  const [edge, setEdge] = useState<string | null>(null)
  const [excSel, setExcSel] = useState<string | null>(null)
  const [sideOpen, setSideOpen] = useState(false)
  const overlay = s.width > 0 && s.width < 1600
  const mapKey = `system:${window}`
  const map = useResource<SystemMapResponse>(mapKey, (sig) => fetchSystemMap(window, sig), { interval: 30_000, placeholderKey: window === '24h' ? 'system:7d' : 'system:24h' })
  const canvas = useRef<GraphCanvasApi | null>(null)
  const pulses = useTrafficPulses(mapKey, s.still)

  const excByWf = useMemo(() => {
    const m: Record<string, number> = {}
    for (const it of s.exceptions.data?.items || []) m[it.workflow_key] = (m[it.workflow_key] || 0) + 1
    return m
  }, [s.exceptions.data])

  const node = sel ? map.data?.nodes.find((n) => n.key === sel) || null : null
  const edgeData = edge ? map.data?.edges.find((e) => e.id === edge) || null : null
  const openSystem = useCallback((key: string) => {
    const n = map.data?.nodes.find((x) => x.key === key)
    const wf = n?.workflow_key || (n?.members?.[0]?.workflow_key ?? null)
    if (wf) { s.setWorkflow(wf); s.setMode('canvas') } else if (n?.owner_href) pushRoutePath(n.owner_href)
  }, [map.data, s])
  /** after the inspector has taken its room: frame these systems in what is left of the map */
  const frame = useCallback((keys: string[]) => { globalThis.setTimeout(() => canvas.current?.frameNodes(keys, 1), 0) }, [])
  const selectSystem = useCallback((k: string | null) => {
    setEdge(null)
    setSel(k)
    if (k) sound.ui.select()
    const n = k ? map.data?.nodes.find((x) => x.key === k) : null
    if (n?.workflow_key) s.setWorkflow(n.workflow_key)
    // dependency focus: the system, what it depends on and what it sets off, all in view
    if (k && map.data) { const nb = neighbourhood(k, map.data.edges); frame([k, ...nb.up, ...nb.down]) }
  }, [frame, map.data, s])
  const selectEdge = useCallback((id: string | null) => {
    setSel(null)
    setEdge(id)
    const e = id ? map.data?.edges.find((x) => x.id === id) : null
    if (e) frame([e.from, e.to])
  }, [frame, map.data])

  const openException = (it: ExceptionItem) => {
    setExcSel(it.id)
    if (it.open) s.openRun(it.open.workflow_key, it.open.run_id, it.node_key)
    else if (it.drill) s.openRuns(it.workflow_key, it.drill)
    else { setSel(map.data?.nodes.find((n) => n.workflow_key === it.workflow_key)?.key || null); s.setWorkflow(it.workflow_key) }
  }

  const inspecting = Boolean(node || edgeData)
  return (
    <div className={`ws4-overview${overlay ? ' is-overlay' : ''}${overlay && sideOpen ? ' is-side-open' : ''}`}>
      <div className="ws4-stage ws4-stage--map">
        {map.data ? (
          <SystemMap
            ref={canvas}
            map={map.data}
            workflows={s.workflows}
            exceptionsByWorkflow={excByWf}
            selected={sel}
            selectedEdge={edge}
            onSelect={selectSystem}
            onEdge={(id) => selectEdge(id === edge ? null : id)}
            onOpen={openSystem}
            reducedMotion={s.still}
            pulses={pulses.pulses}
            onPulseDone={pulses.done}
            flashEdges={pulses.flash}
            arrived={pulses.arrived}
            insetRight={inspecting ? 400 : overlay && sideOpen ? 372 : 0}
          >
            <div className="ws4-tool is-top" data-no-pan>
              <span className="ws4-tool__title">
                <strong>Automation topology</strong>
                <small>{map.data.nodes.filter((n) => n.kind === 'system').length} runtimes · {map.data.edges.length} real connections{map.placeholder ? ' · showing the other window while this one reads' : ''}</small>
              </span>
              <span className="ws4-tool__grow" />
              <LCSegmented size="sm" label="Traffic window" value={window} onChange={setWindow} options={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }]} />
              <Legend />
              {overlay ? <button type="button" className={`ws4-chipbtn is-exc${sideOpen ? ' is-on' : ''}`} aria-expanded={sideOpen} onClick={() => setSideOpen((v) => !v)}><Icon name="alert-circle" size={12} />Exceptions<b className="lc-num">{s.exceptions.data?.total ?? '—'}</b></button> : null}
            </div>
            <div className="ws4-tool is-left" data-no-pan>
              <LCIconButton icon="chevron-up" label="Zoom in" shortcut={['+']} size="sm" variant="glass" tooltipSide="right" onClick={() => canvas.current?.zoomIn()} />
              <LCIconButton icon="chevron-down" label="Zoom out" shortcut={['−']} size="sm" variant="glass" tooltipSide="right" onClick={() => canvas.current?.zoomOut()} />
              <LCIconButton icon="maximize" label="Fit the topology" shortcut={['F']} size="sm" variant="glass" tooltipSide="right" onClick={() => canvas.current?.fit()} />
              <LCIconButton icon="target" label="Recenter" size="sm" variant="glass" tooltipSide="right" onClick={() => canvas.current?.recenter()} />
            </div>
            {map.data.degraded.length ? <p className="ws4-tool is-bottom ws4-degraded" data-no-pan><Icon name="alert" size={12} />Could not read: {map.data.degraded.join(', ')} — those connectors show “not read”, not zero</p> : null}
          </SystemMap>
        ) : map.error ? (
          <div className="ws4-board is-empty"><LCError what="The automation topology could not be read" detail={map.error} onRetry={map.reload} /></div>
        ) : (
          <div className="ws4-board is-empty" aria-busy="true"><LCSkeleton shape="chart" height={360} label="Reading the automation topology" /></div>
        )}
        <LCInspector
          open={Boolean(node)}
          onClose={() => setSel(null)}
          id="ws4-system"
          eyebrow={node ? eyebrowOf(node, findWorkflow(s.workflows, node.workflow_key)) : ''}
          title={node?.label || ''}
          subtitle={node?.sub}
          status={node ? <SystemStatusLine n={node} w={findWorkflow(s.workflows, node.workflow_key)} /> : null}
          contentKey={node?.key}
          width={380}
          footer={node ? <SystemActions n={node} w={findWorkflow(s.workflows, node.workflow_key)} onOpen={openSystem} /> : null}
        >
          {node && map.data ? <SystemDetail n={node} map={map.data} window={window} onSystem={selectSystem} onEdge={selectEdge} /> : null}
        </LCInspector>
        <LCInspector open={Boolean(edgeData)} onClose={() => setEdge(null)} id="ws4-system-edge" eyebrow={edgeData ? `${SYSTEM_EDGE[edgeData.kind].label} connection` : ''} title={edgeData?.label || ''} contentKey={edgeData?.id} width={380}>
          {edgeData && map.data ? <EdgeDetail e={edgeData} map={map.data} onSystem={selectSystem} /> : null}
        </LCInspector>
      </div>
      <aside className="ws4-side" aria-label="Exceptions and runtime health">
        <ExceptionQueue read={s.exceptions} selectedId={excSel} onOpen={openException} onOpenRuns={(wf, drill) => s.openRuns(wf, drill)} />
        <RuntimeHealth beats={s.registry.data?.runtimes ?? null} loading={s.registry.loading} />
      </aside>
    </div>
  )
}

function eyebrowOf(n: SystemNode, w: RegistryEntry | null) {
  if (n.kind === 'external') return 'External runtime'
  if (n.kind === 'domain') return 'Canonical state'
  if (n.kind === 'studio') return 'Studio workflows · editable'
  return `System workflow · read-only topology${w ? ` · ${WORKFLOW_FAMILY[w.family].label}` : ''}`
}

function SystemStatusLine({ n, w }: { n: SystemNode; w: RegistryEntry | null }) {
  const st = systemStatus(n, w)
  const tone = st.tone === 'teal' ? 'exec' : st.tone
  return (
    <span className="ws4-statusline">
      <LCStatus label={st.word} tone={tone as 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'neutral'} />
      {w?.status_note ? <span className="lc-t-meta">{w.status_note}</span> : null}
      {w?.heartbeat?.key ? <span className="lc-t-meta">beat {ago(w.heartbeat.at)} · {w.heartbeat.cadence}</span> : w?.heartbeat?.cadence ? <span className="lc-t-meta">{w.heartbeat.cadence}</span> : null}
    </span>
  )
}

function SystemDetail({ n, map, window, onSystem, onEdge }: { n: SystemNode; map: SystemMapResponse; window: '24h' | '7d'; onSystem: (k: string) => void; onEdge: (id: string) => void }) {
  const s = useStudio()
  const w = findWorkflow(s.workflows, n.workflow_key)
  const up = map.edges.filter((e) => e.to === n.key)
  const down = map.edges.filter((e) => e.from === n.key)
  const facts = systemFacts(n, w, window)
  const wf = n.workflow_key || n.members?.[0]?.workflow_key || null
  const canRuns = Boolean(w?.supports.runs || n.kind === 'studio')
  const runs = useResource(canRuns && wf ? `runs:${wf}:24h:recent` : null, (sig) => fetchRuns(wf!, { period: '24h', limit: 6 }, sig))
  const nameOf = (k: string) => map.nodes.find((x) => x.key === k)?.label || k
  return (
    <>
      {n.description || w?.description ? <p className="ws4-desc">{n.description || w?.description}</p> : null}
      {n.note ? <p className="ws4-note">{n.note}</p> : null}
      {facts.length ? (
        <div className="ws4-figs" role="group" aria-label="Live state">
          {facts.map((f, i) => <span key={i} data-tone={f.tone}><b className="lc-num">{f.v}</b><small>{f.l}</small></span>)}
        </div>
      ) : null}
      {w ? (
        <LCInspectorSection title="Runtime">
          <LCFacts rows={[
            { label: 'Runs', value: w.runtime },
            { label: 'Trigger', value: w.trigger?.label },
            { label: 'Ledger', value: w.ledger.join(' · ') },
            { label: 'Owner', value: w.owner_app },
            ...(w.stats.waiting ? [{ label: 'Waiting now', value: count(w.stats.waiting) }] : []),
            ...(w.stats.follow_ups_scheduled ? [{ label: 'Follow-ups scheduled', value: count(w.stats.follow_ups_scheduled) }] : []),
          ]} />
        </LCInspectorSection>
      ) : null}
      {n.members?.length ? (
        <LCInspectorSection title="Armed here">
          <ul className="ws4-linklist">{n.members.map((m) => <li key={m.workflow_key}><button type="button" onClick={() => { s.setWorkflow(m.workflow_key); s.setMode('canvas') }}><Icon name="spark" size={12} />{m.name}<em>{words(m.status)} · v{m.version ?? '—'}</em></button></li>)}</ul>
        </LCInspectorSection>
      ) : null}
      <LCInspectorSection title={`Depends on · ${up.length}`}>
        {up.length ? <ul className="ws4-linklist">{up.map((e) => <EdgeRow key={e.id} e={e} other={nameOf(e.from)} dir="in" onOther={() => onSystem(e.from)} onEdge={() => onEdge(e.id)} />)}</ul> : <p className="ws4-quiet">Nothing automated leads into it.{n.key === 'buyer_matching' ? ' An operator starts it.' : ''}</p>}
      </LCInspectorSection>
      <LCInspectorSection title={`Downstream effects · ${down.length}`}>
        {down.length ? <ul className="ws4-linklist">{down.map((e) => <EdgeRow key={e.id} e={e} other={nameOf(e.to)} dir="out" onOther={() => onSystem(e.to)} onEdge={() => onEdge(e.id)} />)}</ul> : <p className="ws4-quiet">It sets nothing else in motion.</p>}
      </LCInspectorSection>
      {canRuns && wf ? (
        <LCInspectorSection title="Recent runs · 24h" aside={<button type="button" className="lc-link" onClick={() => s.openRuns(wf, { period: '24h' })}>All runs</button>}>
          {runs.loading ? <LCSkeleton shape="rows" count={3} /> : runs.data?.runs.length ? (
            <ul className="ws4-runlist">
              {runs.data.runs.map((r) => (
                <li key={r.run_id}>
                  <button type="button" onClick={() => s.openRun(wf, r.run_id, r.current_node || r.final_node)} data-status={r.status}>
                    <i aria-hidden />
                    <span><b>{r.subject.name || r.subject.address || r.subject.id || r.trigger || 'Run'}</b><small>{r.result || r.status_label}{r.reason && r.status !== 'completed' ? ` · ${r.reason}` : ''}</small></span>
                    <time className="lc-t-stamp">{ago(r.started_at)}</time>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="ws4-quiet">{runs.error ? `Runs could not be read — ${runs.error}` : 'No run in the last 24 hours.'}</p>}
        </LCInspectorSection>
      ) : null}
    </>
  )
}

function EdgeRow({ e, other, dir, onOther, onEdge }: { e: SystemEdge; other: string; dir: 'in' | 'out'; onOther: () => void; onEdge: () => void }) {
  return (
    <li className="ws4-edgerow" data-kind={e.kind} data-state={e.state}>
      <button type="button" className="ws4-edgerow__other" onClick={onOther}><Icon name={dir === 'in' ? 'arrow-down-left' : 'arrow-up-right'} size={12} />{other}</button>
      <button type="button" className="ws4-edgerow__edge" onClick={onEdge} title={e.evidence}>
        <span className="ws4-kind">{SYSTEM_EDGE[e.kind].label}</span>{e.label}
        <em className="lc-num">{e.state === 'off' ? 'off' : e.traffic.count === null ? 'not counted' : count(e.traffic.count)}</em>
      </button>
    </li>
  )
}

function EdgeDetail({ e, map, onSystem }: { e: SystemEdge; map: SystemMapResponse; onSystem: (k: string) => void }) {
  const from = map.nodes.find((n) => n.key === e.from)
  const to = map.nodes.find((n) => n.key === e.to)
  return (
    <>
      <div className="ws4-edgeflow">
        <button type="button" onClick={() => onSystem(e.from)}>{from?.label}</button>
        <span className="ws4-kind" data-kind={e.kind}>{SYSTEM_EDGE[e.kind].label}</span>
        <button type="button" onClick={() => onSystem(e.to)}>{to?.label}</button>
      </div>
      <p className="ws4-desc">{SYSTEM_EDGE[e.kind].label}: {to?.label} {e.kind === 'external' ? 'is a provider outside LeadCommand' : e.kind === 'state' ? 'shares canonical state with' : e.kind === 'subworkflow' ? 'is invoked by' : e.kind === 'action' ? 'is asked to act by' : 'reacts to what is recorded by'} {e.kind === 'external' ? `that ${from?.label} talks to` : from?.label}.</p>
      <LCFacts rows={[
        { label: `Traffic · ${e.traffic.window}`, value: e.state === 'off' ? 'Switched off' : e.traffic.count === null ? (e.note ? 'Not counted' : 'Could not be read') : count(e.traffic.count) },
        { label: 'State', value: { carrying: 'Carrying traffic', quiet: 'Wired · nothing carried in the window', off: 'Switched off', unmeasured: 'Wired · not attributable', unread: 'Could not be read' }[e.state] },
        { label: 'Evidence', value: e.evidence },
      ]} />
      {e.note ? <p className="ws4-note">{e.note}</p> : null}
    </>
  )
}

function SystemActions({ n, w, onOpen }: { n: SystemNode; w: RegistryEntry | null; onOpen: (k: string) => void }) {
  const s = useStudio()
  const wf = n.workflow_key || n.members?.[0]?.workflow_key
  return (
    <div className="ws4-actions">
      {wf ? <LCButton variant="primary" icon="grid" onClick={() => onOpen(n.key)}>Open workflow</LCButton> : null}
      {wf && (w?.supports.runs || n.kind === 'studio') ? <LCButton icon="list" onClick={() => s.openRuns(wf, null)}>Runs</LCButton> : null}
      {(w?.owner_href || n.owner_href) && w?.owner_app !== 'Workflow Studio' ? <LCButton variant="quiet" icon="arrow-up-right" onClick={() => pushRoutePath((w?.owner_href || n.owner_href)!)}>{w?.owner_app || n.owner_app}</LCButton> : null}
    </div>
  )
}

function Legend() {
  return (
    <LCPopover label="Connector kinds" side="bottom" align="end" width={300} trigger={<button type="button" className="ws4-chipbtn"><Icon name="layers" size={12} />Legend</button>}>
      <div className="ws4-legend">
        {(Object.keys(SYSTEM_EDGE) as Array<keyof typeof SYSTEM_EDGE>).map((k) => (
          <div key={k} className="ws4-legend__row" data-kind={k}>
            <svg width="44" height="10" aria-hidden><path d="M 2 5 L 42 5" className={`ws4-edge is-k-${k} is-carrying`} /></svg>
            <span><b>{SYSTEM_EDGE[k].label}</b>{SYSTEM_EDGE[k].hint}</span>
          </div>
        ))}
        <p className="ws4-note">Weight is the traffic the connector’s own evidence counted. Dashed = wired, nothing carried in the window. Dotted = switched off. A number is a count, never an estimate; “not counted” means no ledger can attribute it.</p>
      </div>
    </LCPopover>
  )
}
