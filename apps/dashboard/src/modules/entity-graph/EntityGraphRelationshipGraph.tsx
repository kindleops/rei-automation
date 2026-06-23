import { useEffect, useMemo, useRef, useState } from 'react'
import type { EntityGraphDossier, EntityGraphNode } from '../../domain/entity-graph/entity-graph.types'

type PositionedNode = EntityGraphNode & { x: number; y: number }

const NODE_COLORS: Record<string, string> = {
  property: '56 189 248',
  master_owner: '245 158 11',
  prospect: '167 139 250',
  phone: '74 222 128',
  email: '129 140 248',
  organization: '251 191 36',
  market: '45 212 191',
  zip: '34 211 238',
  thread: '248 113 113',
}

const LEGEND = [
  { type: 'property', label: 'Property' },
  { type: 'master_owner', label: 'Owner' },
  { type: 'prospect', label: 'Person' },
  { type: 'organization', label: 'Entity' },
  { type: 'phone', label: 'Phone' },
  { type: 'email', label: 'Email' },
  { type: 'market', label: 'Market' },
  { type: 'zip', label: 'ZIP' },
]

export function EntityGraphRelationshipGraph({
  dossier,
  focusOnly = false,
  onNodeSelect,
}: {
  dossier: EntityGraphDossier | null
  focusOnly?: boolean
  onNodeSelect: (nodeId: string, nodeType: string, entityId: string) => void
}) {
  const graph = dossier?.graph
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({})
  const dragRef = useRef<{ mode: 'pan' | 'node'; nodeId?: string; x: number; y: number } | null>(null)

  const width = 860
  const height = 520
  const centerX = width / 2
  const centerY = height / 2

  const visibleGraph = useMemo(() => {
    if (!graph) return null
    if (!focusOnly) return graph
    const active = graph.nodes.find((n) => n.meta?.active)?.id
    if (!active) return graph
    const connected = new Set<string>([active])
    for (const edge of graph.edges) {
      if (edge.from === active) connected.add(edge.to)
      if (edge.to === active) connected.add(edge.from)
    }
    return {
      nodes: graph.nodes.filter((n) => connected.has(n.id)),
      edges: graph.edges.filter((e) => connected.has(e.from) && connected.has(e.to)),
    }
  }, [focusOnly, graph])

  const positioned = useMemo(() => {
    if (!visibleGraph?.nodes?.length) return [] as PositionedNode[]
    const radius = Math.min(width, height) * 0.36
    const neighbors = visibleGraph.nodes.filter((node) => !node.meta?.active)
    return visibleGraph.nodes.map((node) => {
      const saved = nodePositions[node.id]
      if (saved) return { ...node, x: saved.x, y: saved.y }
      if (node.meta?.active) return { ...node, x: centerX, y: centerY }
      const index = neighbors.findIndex((entry) => entry.id === node.id)
      const angle = (index / Math.max(neighbors.length, 1)) * Math.PI * 2 - Math.PI / 2
      return {
        ...node,
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      }
    })
  }, [visibleGraph?.nodes, nodePositions])

  useEffect(() => {
    setSelectedId(visibleGraph?.nodes.find((node) => node.meta?.active)?.id ?? null)
  }, [dossier?.entityId, dossier?.entityType, visibleGraph?.nodes])

  if (!visibleGraph || visibleGraph.nodes.length === 0) {
    return (
      <div className="eg-empty is-graph">
        <strong>No graph edges</strong>
        <span>This record has no linked relationships to visualize yet.</span>
      </div>
    )
  }

  const byId = new Map(positioned.map((node) => [node.id, node]))
  const activeId = visibleGraph.nodes.find((n) => n.meta?.active)?.id ?? selectedId
  const relatedIds = new Set<string>()
  if (activeId) {
    relatedIds.add(activeId)
    for (const edge of visibleGraph.edges) {
      if (edge.from === activeId) relatedIds.add(edge.to)
      if (edge.to === activeId) relatedIds.add(edge.from)
    }
  }

  const recenter = () => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setNodePositions({})
  }

  return (
    <div className="eg-graph">
      <div className="eg-graph__toolbar">
        <button type="button" className="eg-glass-btn" onClick={() => setZoom((v) => Math.min(2.4, v + 0.12))}>Zoom in</button>
        <button type="button" className="eg-glass-btn" onClick={() => setZoom((v) => Math.max(0.5, v - 0.12))}>Zoom out</button>
        <button type="button" className="eg-glass-btn" onClick={recenter}>Re-center</button>
      </div>

      <div className="eg-graph__legend">
        {LEGEND.map((item) => (
          <span key={item.type} className="eg-graph__legend-item" data-type={item.type}>
            {item.label}
          </span>
        ))}
      </div>

      <div
        className="eg-graph__viewport"
        onWheel={(event) => {
          event.preventDefault()
          setZoom((current) => Math.min(2.4, Math.max(0.5, current + (event.deltaY < 0 ? 0.08 : -0.08))))
        }}
        onMouseDown={(event) => {
          const target = (event.target as HTMLElement).closest('[data-graph-node]') as HTMLElement | null
          if (target?.dataset.graphNode) {
            dragRef.current = { mode: 'node', nodeId: target.dataset.graphNode, x: event.clientX, y: event.clientY }
            return
          }
          dragRef.current = { mode: 'pan', x: event.clientX - offset.x, y: event.clientY - offset.y }
        }}
        onMouseMove={(event) => {
          if (!dragRef.current) return
          if (dragRef.current.mode === 'pan') {
            setOffset({ x: event.clientX - dragRef.current.x, y: event.clientY - dragRef.current.y })
            return
          }
          const nodeId = dragRef.current.nodeId
          if (!nodeId) return
          const node = byId.get(nodeId)
          if (!node) return
          const dx = (event.clientX - dragRef.current.x) / zoom
          const dy = (event.clientY - dragRef.current.y) / zoom
          dragRef.current = { mode: 'node', nodeId, x: event.clientX, y: event.clientY }
          setNodePositions((current) => ({
            ...current,
            [nodeId]: { x: (current[nodeId]?.x ?? node.x) + dx, y: (current[nodeId]?.y ?? node.y) + dy },
          }))
        }}
        onMouseUp={() => { dragRef.current = null }}
        onMouseLeave={() => { dragRef.current = null }}
      >
        <div className="eg-graph__stage" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}>
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="eg-graph__svg">
            <defs>
              <marker id="eg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {visibleGraph.edges.map((edge) => {
              const from = byId.get(edge.from)
              const to = byId.get(edge.to)
              if (!from || !to) return null
              const midX = (from.x + to.x) / 2
              const midY = (from.y + to.y) / 2
              const isHighlighted = activeId && (edge.from === activeId || edge.to === activeId)
              const isFaded = activeId && !isHighlighted
              const showLabel = isHighlighted || hoveredId === edge.from || hoveredId === edge.to
              return (
                <g key={`${edge.from}-${edge.to}`} style={{ color: 'rgba(148, 163, 184, 0.85)' }}>
                  <line
                    className={`eg-graph__edge${isHighlighted ? ' is-highlighted' : ''}${isFaded ? ' is-faded' : ''}`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    markerEnd="url(#eg-arrow)"
                  />
                  {edge.label && showLabel && (
                    <text className="eg-graph__edge-label" x={midX} y={midY - 4}>{edge.label}</text>
                  )}
                </g>
              )
            })}
          </svg>
          {positioned.map((node) => {
            const [, entityId] = node.id.includes(':') ? node.id.split(':') : [node.type, node.id]
            const isActive = node.meta?.active || selectedId === node.id
            const isRelated = activeId && relatedIds.has(node.id) && !isActive
            const isFaded = activeId && !relatedIds.has(node.id)
            return (
              <button
                key={node.id}
                type="button"
                data-graph-node={node.id}
                className={`eg-graph__node${isActive ? ' is-active' : ''}${isRelated ? ' is-related' : ''}${isFaded ? ' is-faded' : ''}${hoveredId === node.id ? ' is-hovered' : ''}`}
                data-type={node.type}
                style={{
                  left: node.x,
                  top: node.y,
                  ['--eg-node-accent' as string]: NODE_COLORS[node.type] ?? '148 163 184',
                }}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId((c) => (c === node.id ? null : c))}
                onClick={(e) => {
                  e.stopPropagation()
                  setSelectedId(node.id)
                  onNodeSelect(node.id, node.type, entityId)
                }}
                title={node.label}
              >
                <span className="eg-graph__node-label">{node.label}</span>
                <span className="eg-graph__node-type">{node.type.replace(/_/g, ' ')}</span>
              </button>
            )
          })}
        </div>
      </div>

      {hoveredId && byId.get(hoveredId) && (
        <div className="eg-graph__hover">
          <strong>{byId.get(hoveredId)?.label}</strong>
          <span>{byId.get(hoveredId)?.type?.replace(/_/g, ' ')}</span>
        </div>
      )}
    </div>
  )
}