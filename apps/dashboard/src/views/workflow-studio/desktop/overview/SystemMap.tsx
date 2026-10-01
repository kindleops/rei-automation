import { forwardRef, useCallback, useMemo, type ReactNode } from 'react'
import { GraphCanvas, type GraphCanvasApi, type GraphEdgeView, type GraphNodeView, type Pulse } from '../canvas/GraphCanvas'
import { count } from '../lib/format'
import type { RegistryEntry, SystemMapResponse } from '../lib/types'
import { layoutSystemMap, neighbourhood } from './system-layout'
import { SystemNodeCard } from './SystemNode'
import { systemStatus } from './system-model'

/**
 * THE SYSTEM TOPOLOGY — LeadCommand's automation architecture as one graph.
 * Nodes are runtimes, providers and the canonical stores that couple them;
 * every connector is a relationship the code wires, styled by its kind
 * (event · action · subworkflow · external · state) and weighted by the
 * traffic its own evidence counted. Selecting a system keeps its dependencies
 * and downstream effects sharp and lets everything else recede.
 */
export const SystemMap = forwardRef<GraphCanvasApi, {
  map: SystemMapResponse
  workflows: RegistryEntry[]
  exceptionsByWorkflow: Record<string, number>
  selected: string | null
  selectedEdge: string | null
  onSelect: (key: string | null) => void
  onEdge: (id: string) => void
  onOpen: (key: string) => void
  reducedMotion: boolean
  pulses?: Pulse[]
  onPulseDone?: (id: string) => void
  flashEdges?: ReadonlySet<string>
  arrived?: ReadonlySet<string>
  insetRight?: number
  label?: string
  children?: ReactNode
}>(function SystemMap({ map, workflows, exceptionsByWorkflow, selected, selectedEdge, onSelect, onEdge, onOpen, reducedMotion, pulses, onPulseDone, flashEdges, arrived, insetRight, label, children }, ref) {
  const layout = useMemo(() => layoutSystemMap(map.nodes, map.edges), [map])
  const edgeMarker = useCallback((e: GraphEdgeView) => layout.edgesById.get(e.id)?.kind ?? null, [layout])
  const byWf = useMemo(() => new Map(workflows.map((w) => [w.workflow_key, w])), [workflows])
  const entryOf = useCallback((key: string) => { const n = layout.nodesByKey.get(key); return n?.workflow_key ? byWf.get(n.workflow_key) || null : null }, [byWf, layout])

  const focusEdge = selectedEdge ? layout.edgesById.get(selectedEdge) : null
  const near = useMemo(() => {
    if (focusEdge) return new Set([focusEdge.from, focusEdge.to])
    if (!selected) return null
    const nb = neighbourhood(selected, map.edges)
    return new Set([selected, ...nb.up, ...nb.down])
  }, [focusEdge, map.edges, selected])
  const maxCount = useMemo(() => Math.max(1, ...map.edges.map((e) => e.traffic.count || 0)), [map])

  const edgeClass = useCallback((g: GraphEdgeView) => {
    const e = layout.edgesById.get(g.id)
    if (!e) return ''
    const c = [`is-k-${e.kind}`, `is-${e.state}`]
    if (selectedEdge === e.id) c.push('is-selected')
    else if (selected && (e.from === selected || e.to === selected)) c.push('is-touching')
    else if (near) c.push('is-dim')
    return c.join(' ')
  }, [layout, near, selected, selectedEdge])
  const edgeWidth = useCallback((g: GraphEdgeView) => {
    const e = layout.edgesById.get(g.id)
    const n = e?.traffic.count || 0
    return n ? 1.1 + 2.3 * (Math.log10(1 + n) / Math.log10(1 + maxCount)) : 1
  }, [layout, maxCount])
  const edgeLabel = useCallback((g: GraphEdgeView) => {
    const e = layout.edgesById.get(g.id)
    if (!e) return null
    const figure = e.state === 'off' ? <em>off</em> : e.traffic.count !== null ? <em className="lc-num">{count(e.traffic.count)}</em> : null
    // a connector between neighbouring modules carries its figure only; the words live in its tooltip and inspector
    if (g.tight) return figure
    return <><span>{e.label}</span>{figure}</>
  }, [layout])
  const edgeTitle = useCallback((g: GraphEdgeView) => {
    const e = layout.edgesById.get(g.id)
    if (!e) return null
    return `${e.label} · ${e.kind} · ${e.traffic.count === null ? 'not counted' : `${e.traffic.count} in ${e.traffic.window}`}\n${e.evidence}`
  }, [layout])

  const renderNode = useCallback((v: GraphNodeView) => {
    const n = layout.nodesByKey.get(v.key)!
    const w = entryOf(v.key)
    return (
      <SystemNodeCard
        n={n}
        w={w}
        window={map.window}
        state={{ selected: selected === v.key, dim: Boolean(near && !near.has(v.key)), neighbour: Boolean(near && near.has(v.key) && selected !== v.key), arrived: Boolean(arrived?.has(v.key)), exceptions: n.workflow_key ? exceptionsByWorkflow[n.workflow_key] || 0 : n.key === 'studio_orchestrator' ? (n.members || []).reduce((a, m) => a + (exceptionsByWorkflow[m.workflow_key] || 0), 0) : 0 }}
        onSelect={(k) => onSelect(k === selected ? null : k)}
        onOpen={onOpen}
      />
    )
  }, [arrived, entryOf, exceptionsByWorkflow, layout, map.window, near, onOpen, onSelect, selected])

  const marked = useMemo(() => new Set(map.nodes.filter((n) => (entryOf(n.key)?.stats.executing || 0) > 0).map((n) => n.key)), [entryOf, map.nodes])
  const toneOf = useCallback((key: string) => {
    const n = layout.nodesByKey.get(key)
    return n ? `is-${systemStatus(n, entryOf(key)).tone}` : ''
  }, [entryOf, layout])

  return (
    <GraphCanvas
      ref={ref}
      model={layout}
      variant="system"
      reducedMotion={reducedMotion}
      renderNode={renderNode}
      edgeClass={edgeClass}
      edgeWidth={edgeWidth}
      edgeLabel={edgeLabel}
      edgeTitle={edgeTitle}
      onEdge={onEdge}
      onBackground={() => onSelect(null)}
      pulses={pulses}
      onPulseDone={onPulseDone}
      flashEdges={flashEdges}
      marked={marked}
      minimapTone={toneOf}
      minimap={false}
      edgeMarker={edgeMarker}
      viewKey="system-map"
      fitMode="contain"
      insetRight={insetRight}
      className={near ? 'is-focusing' : undefined}
      label={label || 'LeadCommand automation topology'}
    >
      {children}
    </GraphCanvas>
  )
})
