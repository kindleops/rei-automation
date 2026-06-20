import { useEffect, useMemo, useRef, useState } from 'react'
import type { EntityGraphDossier, EntityGraphNode } from '../../domain/entity-graph/entity-graph.types'

type PositionedNode = EntityGraphNode & { x: number; y: number; fx?: number; fy?: number }

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

export function EntityGraphRelationshipGraph({
  dossier,
  onNodeSelect,
}: {
  dossier: EntityGraphDossier | null
  onNodeSelect: (nodeId: string, nodeType: string, entityId: string) => void
}) {
  const graph = dossier?.graph
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({})
  const dragRef = useRef<{ mode: 'pan' | 'node'; nodeId?: string; x: number; y: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const width = 720
  const height = 460
  const centerX = width / 2
  const centerY = height / 2

  const positioned = useMemo(() => {
    if (!graph?.nodes?.length) return [] as PositionedNode[]
    const radius = Math.min(width, height) * 0.34
    const neighbors = graph.nodes.filter((node) => !node.meta?.active)
    return graph.nodes.map((node) => {
      const saved = nodePositions[node.id]
      if (saved) return { ...node, x: saved.x, y: saved.y }
      if (node.meta?.active) return { ...node, x: centerX, y: centerY }
      const index = neighbors.findIndex((entry) => entry.id === node.id)
      const angle = (index / Math.max(neighbors.length, 1)) * Math.PI * 2
      return {
        ...node,
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      }
    })
  }, [graph?.nodes, nodePositions])

  useEffect(() => {
    setSelectedId(graph?.nodes.find((node) => node.meta?.active)?.id ?? null)
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [dossier?.entityId, dossier?.entityType])

  if (!graph || graph.nodes.length === 0) {
    return <div className="nx-entity-graph__empty">Select an entity to render its local relationship network.</div>
  }

  const byId = new Map(positioned.map((node) => [node.id, node]))

  const fitGraph = () => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }

  return (
    <div className="nx-entity-graph__graph-shell">
      <div className="nx-entity-graph__graph-toolbar">
        <button type="button" onClick={() => setZoom((value) => Math.min(2.2, value + 0.12))}>Zoom In</button>
        <button type="button" onClick={() => setZoom((value) => Math.max(0.55, value - 0.12))}>Zoom Out</button>
        <button type="button" onClick={fitGraph}>Fit Graph</button>
        <button type="button" onClick={() => { setNodePositions({}); fitGraph() }}>Reset View</button>
      </div>
      <div
        ref={viewportRef}
        className="nx-entity-graph__graph-canvas is-interactive"
        onWheel={(event) => {
          event.preventDefault()
          setZoom((current) => Math.min(2.2, Math.max(0.55, current + (event.deltaY < 0 ? 0.08 : -0.08))))
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
        <div
          className="nx-entity-graph__graph-stage"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
        >
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="nx-entity-graph__graph-svg">
            {graph.edges.map((edge) => {
              const from = byId.get(edge.from)
              const to = byId.get(edge.to)
              if (!from || !to) return null
              const midX = (from.x + to.x) / 2
              const midY = (from.y + to.y) / 2
              return (
                <g key={`${edge.from}-${edge.to}`}>
                  <line className="nx-entity-graph__graph-edge" x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
                  <text className="nx-entity-graph__graph-edge-label" x={midX} y={midY}>{edge.label}</text>
                </g>
              )
            })}
          </svg>
          {positioned.map((node) => {
            const [, entityId] = node.id.includes(':') ? node.id.split(':') : [node.type, node.id]
            const isActive = node.meta?.active || selectedId === node.id
            return (
              <button
                key={node.id}
                type="button"
                data-graph-node={node.id}
                className={`nx-entity-graph__graph-node${isActive ? ' is-active' : ''}${hoveredId === node.id ? ' is-hovered' : ''}`}
                data-type={node.type}
                style={{
                  left: node.x,
                  top: node.y,
                  ['--eg-node-accent' as string]: NODE_COLORS[node.type] ?? '148 163 184',
                }}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId((current) => (current === node.id ? null : current))}
                onClick={() => {
                  setSelectedId(node.id)
                  onNodeSelect(node.id, node.type, entityId)
                }}
                title={node.label}
              >
                <span>{node.label}</span>
              </button>
            )
          })}
        </div>
      </div>
      {hoveredId && byId.get(hoveredId) && (
        <div className="nx-entity-graph__graph-hover">
          <strong>{byId.get(hoveredId)?.label}</strong>
          <span>{byId.get(hoveredId)?.type}</span>
        </div>
      )}
    </div>
  )
}