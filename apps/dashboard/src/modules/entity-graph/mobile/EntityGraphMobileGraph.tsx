import { useCallback, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import { fetchEntityGraphDossier } from '../../../domain/entity-graph/entity-graph-api'
import type {
  EntityGraphEdge,
  EntityGraphNode,
  EntitySearchResult,
} from '../../../domain/entity-graph/entity-graph.types'
import { resolveIdentity, type EntityScope } from './entity-graph-mobile-format'
import {
  NODE_STYLE,
  EXPANDABLE,
  RELATIONSHIP_GROUPS,
  dossierTypeFor,
  groupForType,
  layout,
  neighborhoodOf,
  type Placed,
  type RelationshipGroup,
} from './entity-graph-graph-layout'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/**
 * Interactive relationship graph.
 *
 * It never attempts the whole universe. It starts from one anchor record's
 * neighborhood and grows only where the operator taps — and then only along the
 * relationship they asked for, so pulling a property's phone numbers doesn't
 * also dump its 40-property portfolio into the view. That is the whole defence
 * against node/edge spaghetti: growth is opt-in per relationship type, and
 * every expansion is undoable.
 *
 * The viewport is held in a ref and written straight to the transform rather
 * than kept in React state. Panning is a continuous gesture; routing it through
 * state re-renders every node on every pointer move.
 */

type View = { x: number; y: number; scale: number }

type ExpansionStep = {
  nodeId: string
  group: RelationshipGroup
  /** Ids this step introduced, so collapsing removes exactly what it added. */
  addedNodeIds: string[]
  addedEdgeKeys: string[]
}

type GraphState = {
  anchorId: string
  nodes: EntityGraphNode[]
  edges: EntityGraphEdge[]
  history: ExpansionStep[]
  placed: Placed[]
}

const edgeKey = (e: EntityGraphEdge) => `${e.from}|${e.to}|${e.label}`

function buildGraphState(
  anchorId: string,
  nodes: EntityGraphNode[],
  edges: EntityGraphEdge[],
  history: ExpansionStep[],
  previous: Map<string, Placed>,
): GraphState {
  return { anchorId, nodes, edges, history, placed: layout(nodes, edges, anchorId, previous) }
}

type Props = {
  scope: EntityScope
  anchor: EntitySearchResult | null
  initialNodes: EntityGraphNode[]
  initialEdges: EntityGraphEdge[]
  loading: boolean
  fullscreen: boolean
  onToggleFullscreen: () => void
  onInspect: (entityType: string, entityId: string) => void
}

export function EntityGraphMobileGraph({
  scope,
  anchor,
  initialNodes,
  initialEdges,
  loading,
  fullscreen,
  onToggleFullscreen,
  onInspect,
}: Props) {
  const anchorId = anchor ? `${anchor.entityType}:${anchor.entityId}` : (initialNodes[0]?.id ?? '')

  const [graph, setGraph] = useState<GraphState>(
    () => buildGraphState(anchorId, initialNodes, initialEdges, [], new Map()),
  )
  const [expanding, setExpanding] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)

  // A new anchor resets the working graph — expansion history belongs to the
  // record being explored. Adjusted during render so the reset lands before
  // paint instead of one frame late.
  if (graph.anchorId !== anchorId) {
    setGraph(buildGraphState(anchorId, initialNodes, initialEdges, [], new Map()))
    setSelectedId(null)
    setFocusId(null)
  }

  const worldRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<View>({ x: 0, y: 0, scale: 1 })
  const fittedForRef = useRef('')
  const gestureRef = useRef<{
    pointers: Map<number, { x: number; y: number }>
    startView: View
    startCenter: { x: number; y: number }
    startDistance: number
  } | null>(null)

  const applyView = useCallback(() => {
    const world = worldRef.current
    if (!world) return
    const { x, y, scale } = viewRef.current
    world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  }, [])

  const setView = useCallback((next: View) => {
    viewRef.current = next
    applyView()
  }, [applyView])

  const positionById = useMemo(
    () => new Map(graph.placed.map((n) => [n.id, n])),
    [graph.placed],
  )

  /** Ids kept at full strength while a node is focused. */
  const focusSet = useMemo(
    () => (focusId ? neighborhoodOf(focusId, graph.edges, 1) : null),
    [focusId, graph.edges],
  )

  const fitTo = useCallback((nodes: Placed[], signature: string, force = false) => {
    const box = canvasRef.current?.getBoundingClientRect()
    if (!box || box.width === 0 || nodes.length === 0) return
    if (!force && fittedForRef.current === signature) return
    if (gestureRef.current) return

    const xs = nodes.map((n) => n.x)
    const ys = nodes.map((n) => n.y)
    const pad = 84
    const width = Math.max(1, Math.max(...xs) - Math.min(...xs) + pad * 2)
    const height = Math.max(1, Math.max(...ys) - Math.min(...ys) + pad * 2)
    const scale = Math.max(0.4, Math.min(1.6, Math.min(box.width / width, box.height / height)))
    const centerX = (Math.max(...xs) + Math.min(...xs)) / 2
    const centerY = (Math.max(...ys) + Math.min(...ys)) / 2

    fittedForRef.current = signature
    setView({ scale, x: -centerX * scale, y: -centerY * scale })
  }, [setView])

  const signature = `${graph.anchorId}|${graph.placed.length}|${fullscreen}`

  const attachWorld = useCallback((node: HTMLDivElement | null) => {
    worldRef.current = node
    if (node) {
      applyView()
      fitTo(graph.placed, signature)
    }
  }, [applyView, fitTo, graph.placed, signature])

  /** Which relationship groups the selected node could still pull in. */
  const availableGroups = useCallback((nodeId: string): RelationshipGroup[] => {
    const done = new Set(graph.history.filter((h) => h.nodeId === nodeId).map((h) => h.group))
    return RELATIONSHIP_GROUPS.map((g) => g.key).filter((key) => !done.has(key))
  }, [graph.history])

  const expand = useCallback(async (node: EntityGraphNode, group: RelationshipGroup) => {
    const apiType = dossierTypeFor(node.type)
    const entityId = node.id.slice(node.id.indexOf(':') + 1)
    if (!apiType || !entityId) return

    setExpanding(`${node.id}|${group}`)
    try {
      const dossier = await fetchEntityGraphDossier(apiType, entityId)
      const incoming = dossier?.graph
      setGraph((current) => {
        if (current.history.some((h) => h.nodeId === node.id && h.group === group)) return current

        const seenNodes = new Set(current.nodes.map((n) => n.id))
        const seenEdges = new Set(current.edges.map(edgeKey))

        // Only the requested relationship group comes in. Everything else stays
        // behind its own tap, which is what keeps the picture readable.
        const freshNodes = (incoming?.nodes ?? []).filter(
          (n) => !seenNodes.has(n.id) && groupForType(n.type) === group,
        )
        const freshIds = new Set(freshNodes.map((n) => n.id))
        const reachable = new Set([...seenNodes, ...freshIds])
        const freshEdges = (incoming?.edges ?? []).filter(
          (e) => !seenEdges.has(edgeKey(e)) && reachable.has(e.from) && reachable.has(e.to),
        )

        const step: ExpansionStep = {
          nodeId: node.id,
          group,
          addedNodeIds: freshNodes.map((n) => n.id),
          addedEdgeKeys: freshEdges.map(edgeKey),
        }

        const previous = new Map(current.placed.map((p) => [p.id, p]))
        return buildGraphState(
          current.anchorId,
          [...current.nodes, ...freshNodes],
          [...current.edges, ...freshEdges],
          [...current.history, step],
          previous,
        )
      })
    } finally {
      setExpanding(null)
    }
  }, [])

  /** Undo the most recent expansion, removing exactly what it added. */
  const collapseLast = useCallback(() => {
    setGraph((current) => {
      const step = current.history[current.history.length - 1]
      if (!step) return current
      const dropNodes = new Set(step.addedNodeIds)
      const dropEdges = new Set(step.addedEdgeKeys)
      const nodes = current.nodes.filter((n) => !dropNodes.has(n.id))
      const edges = current.edges.filter((e) => !dropEdges.has(edgeKey(e)))
      const previous = new Map(current.placed.filter((p) => !dropNodes.has(p.id)).map((p) => [p.id, p]))
      return buildGraphState(current.anchorId, nodes, edges, current.history.slice(0, -1), previous)
    })
    setSelectedId((id) => (id && graph.history.at(-1)?.addedNodeIds.includes(id) ? null : id))
  }, [graph.history])

  /* ── Pan + pinch zoom ─────────────────────────────────────────────────── */
  const centerOf = (pointers: Map<number, { x: number; y: number }>) => {
    const list = [...pointers.values()]
    return list.reduce(
      (acc, p) => ({ x: acc.x + p.x / list.length, y: acc.y + p.y / list.length }),
      { x: 0, y: 0 },
    )
  }

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    const pointers = gestureRef.current?.pointers ?? new Map()
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const list = [...pointers.values()]
    gestureRef.current = {
      pointers,
      startView: { ...viewRef.current },
      startCenter: centerOf(pointers),
      startDistance: list.length === 2 ? Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y) : 0,
    }
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const gesture = gestureRef.current
    if (!gesture || !gesture.pointers.has(event.pointerId)) return
    gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const list = [...gesture.pointers.values()]
    const center = centerOf(gesture.pointers)

    const scale = list.length === 2 && gesture.startDistance > 0
      ? Math.max(0.4, Math.min(2.8, gesture.startView.scale
          * (Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y) / gesture.startDistance)))
      : gesture.startView.scale

    setView({
      scale,
      x: gesture.startView.x + (center.x - gesture.startCenter.x),
      y: gesture.startView.y + (center.y - gesture.startCenter.y),
    })
  }, [setView])

  const endPointer = useCallback((event: React.PointerEvent) => {
    const gesture = gestureRef.current
    if (!gesture) return
    gesture.pointers.delete(event.pointerId)
    if (gesture.pointers.size === 0) {
      gestureRef.current = null
      return
    }
    gestureRef.current = {
      pointers: gesture.pointers,
      startView: { ...viewRef.current },
      startCenter: centerOf(gesture.pointers),
      startDistance: 0,
    }
  }, [])

  const zoom = useCallback((factor: number) => {
    const current = viewRef.current
    setView({ ...current, scale: Math.max(0.4, Math.min(2.8, current.scale * factor)) })
  }, [setView])

  const fitAll = useCallback(() => fitTo(graph.placed, signature, true), [fitTo, graph.placed, signature])

  const fitSelection = useCallback(() => {
    if (!focusSet) { fitAll(); return }
    const subset = graph.placed.filter((n) => focusSet.has(n.id))
    fitTo(subset.length > 0 ? subset : graph.placed, `${signature}|focus`, true)
  }, [fitAll, fitTo, focusSet, graph.placed, signature])

  const selected = selectedId ? positionById.get(selectedId) : null
  const selectedGroups = selected ? availableGroups(selected.id) : []

  if (loading) {
    return <div className={cls('egg', fullscreen && 'is-fullscreen', 'is-loading')}><span>Loading relationships…</span></div>
  }

  if (!anchor || graph.placed.length === 0) {
    return (
      <div className={cls('egg', fullscreen && 'is-fullscreen', 'is-empty')}>
        <Icon name="layers" />
        <strong>Pick a record to explore</strong>
        <span>
          The graph starts from one record and expands where you tap. It never renders
          the whole universe at once.
        </span>
      </div>
    )
  }

  return (
    <div className={cls('egg', fullscreen && 'is-fullscreen', focusId && 'is-focused')}>
      <div
        className="egg-canvas"
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        <div className="egg-world" ref={attachWorld}>
          <svg className="egg-edges" viewBox="-400 -400 800 800" aria-hidden>
            {graph.edges.map((edge) => {
              const from = positionById.get(edge.from)
              const to = positionById.get(edge.to)
              if (!from || !to) return null
              const inFocus = !focusSet || (focusSet.has(edge.from) && focusSet.has(edge.to))
              return (
                <line
                  key={edgeKey(edge)}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  className={cls(
                    'egg-edge',
                    focusId && (edge.from === focusId || edge.to === focusId) && 'is-active',
                    !inFocus && 'is-muted',
                  )}
                />
              )
            })}
          </svg>

          {graph.placed.map((node) => {
            const style = NODE_STYLE[node.type] ?? { icon: 'grid' as IconName, tone: '#64748b', label: node.type }
            const isAnchor = node.id === anchorId
            const canExpand = EXPANDABLE.has(node.type) && availableGroups(node.id).length > 0
            const muted = focusSet ? !focusSet.has(node.id) : false
            return (
              <button
                key={node.id}
                type="button"
                className={cls(
                  'egg-node',
                  isAnchor && 'is-anchor',
                  selectedId === node.id && 'is-selected',
                  focusId === node.id && 'is-focus',
                  muted && 'is-muted',
                )}
                style={{
                  transform: `translate(${node.x}px, ${node.y}px)`,
                  ['--egg-tone' as string]: style.tone,
                }}
                onClick={() => {
                  setSelectedId(node.id === selectedId ? null : node.id)
                  setFocusId(node.id === focusId ? null : node.id)
                }}
              >
                <span className="egg-node__dot">
                  <Icon name={style.icon} />
                  {canExpand ? <span className="egg-node__more" aria-hidden /> : null}
                </span>
                <span className="egg-node__label">{node.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="egg-controls">
        <button type="button" onClick={onToggleFullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>
          <Icon name={fullscreen ? 'close' : 'maximize'} />
        </button>
        <button type="button" onClick={() => zoom(1.3)} aria-label="Zoom in"><Icon name="chevron-up" /></button>
        <button type="button" onClick={() => zoom(1 / 1.3)} aria-label="Zoom out"><Icon name="chevron-down" /></button>
        <button type="button" onClick={fitAll} aria-label="Fit all"><Icon name="grid" /></button>
        <button
          type="button"
          onClick={fitSelection}
          disabled={!focusId}
          aria-label="Fit to selection"
        >
          <Icon name="target" />
        </button>
      </div>

      <div className="egg-stats">
        {graph.placed.length} nodes · {graph.edges.length} links
        {graph.history.length > 0 ? ` · ${graph.history.length} expansions` : ''}
        {focusId ? ' · focused' : ''}
      </div>

      {graph.history.length > 0 ? (
        <button type="button" className="egg-undo" onClick={collapseLast}>
          <Icon name="arrow-down-left" />
          Collapse last
        </button>
      ) : null}

      {selected ? (
        <div className="egg-inspect">
          <div className="egg-inspect__head">
            <span
              className="egg-inspect__badge"
              style={{ ['--egg-tone' as string]: (NODE_STYLE[selected.type] ?? { tone: '#64748b' }).tone }}
            >
              {(NODE_STYLE[selected.type] ?? { label: selected.type }).label}
            </span>
            <strong>{selected.label}</strong>
            <button
              type="button"
              className="egg-inspect__close"
              onClick={() => { setSelectedId(null); setFocusId(null) }}
              aria-label="Clear selection"
            >
              <Icon name="close" />
            </button>
          </div>

          {EXPANDABLE.has(selected.type) && selectedGroups.length > 0 ? (
            <>
              <div className="egg-inspect__hint">Expand along</div>
              <div className="egg-inspect__groups">
                {selectedGroups.map((group) => {
                  const meta = RELATIONSHIP_GROUPS.find((g) => g.key === group)!
                  const busy = expanding === `${selected.id}|${group}`
                  return (
                    <button
                      key={group}
                      type="button"
                      className="egg-group"
                      disabled={Boolean(expanding)}
                      onClick={() => void expand(selected, group)}
                    >
                      {busy ? '…' : meta.label}
                    </button>
                  )
                })}
              </div>
            </>
          ) : EXPANDABLE.has(selected.type) ? (
            <div className="egg-inspect__hint">All relationships expanded.</div>
          ) : null}

          <div className="egg-inspect__actions">
            {dossierTypeFor(selected.type) ? (
              <button
                type="button"
                className="egg-inspect__btn is-primary"
                onClick={() => onInspect(selected.type, selected.id.slice(selected.id.indexOf(':') + 1))}
              >
                <Icon name="eye" />
                Open inspector
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="egg-hint">
          Tap a node to focus · drag to pan · pinch to zoom
          {anchor ? ` · anchored on ${resolveIdentity(scope, anchor).primary}` : ''}
        </div>
      )}
    </div>
  )
}
