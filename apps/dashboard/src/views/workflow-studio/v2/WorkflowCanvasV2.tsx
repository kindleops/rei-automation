import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { Icon } from '../../../shared/icons'
import type { IconName } from '../../../shared/icons'
import { getWorkflowNodeByType, type WorkflowNodeLibraryItem } from '../WorkflowList'
import type {
  WorkflowDetail,
  WorkflowDryRunResult,
  WorkflowDryRunStep,
  WorkflowStep,
} from '../workflow.types'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const CANVAS_WIDTH = 6400
const CANVAS_HEIGHT = 4200
const NODE_WIDTH = 380
const NODE_HEIGHT = 160
const NODE_CENTER_Y = 80
const GRID_SIZE = 24
const LEVEL_GAP = 460
const LANE_GAP = 160
const ROOT_X = 960
const ROOT_Y = 1180

type ConnectionKind = 'true' | 'false' | 'next'
type NodePlacementAction = 'insert-before' | 'insert-after' | 'add-branch' | 'replace'

type NodeFamily =
  | 'trigger'
  | 'send'
  | 'wait'
  | 'condition'
  | 'intelligence'
  | 'safety'
  | 'ops'

export interface CanvasNodeV2 {
  id: string
  key: string
  label: string
  nodeType: string
  x: number
  y: number
  step?: WorkflowStep
  paths?: {
    true_path?: string
    false_path?: string
    next_path?: string
  }
}

interface CanvasConnectionV2 {
  id: string
  from: CanvasNodeV2
  to: CanvasNodeV2
  kind: ConnectionKind
}

const emptyBlueprint: CanvasNodeV2[] = [
  {
    id: 'preview-trigger',
    key: 'new_lead_trigger',
    label: 'New Lead',
    nodeType: 'trigger_new_lead',
    x: ROOT_X,
    y: ROOT_Y,
    paths: { next_path: 'send_initial_sms' },
  },
  {
    id: 'preview-sms',
    key: 'send_initial_sms',
    label: 'Send SMS',
    nodeType: 'send_sms',
    x: ROOT_X + LEVEL_GAP,
    y: ROOT_Y,
    paths: { next_path: 'wait_two_days' },
  },
  {
    id: 'preview-wait',
    key: 'wait_two_days',
    label: 'Wait 2 Days',
    nodeType: 'wait',
    x: ROOT_X + LEVEL_GAP * 2,
    y: ROOT_Y,
    paths: { next_path: 'if_no_reply' },
  },
  {
    id: 'preview-condition',
    key: 'if_no_reply',
    label: 'If No Reply',
    nodeType: 'condition_no_reply',
    x: ROOT_X + LEVEL_GAP * 3,
    y: ROOT_Y,
    paths: {
      true_path: 'send_follow_up_sms',
      false_path: 'seller_replied',
    },
  },
  {
    id: 'preview-followup',
    key: 'send_follow_up_sms',
    label: 'Follow-Up SMS',
    nodeType: 'send_sms',
    x: ROOT_X + LEVEL_GAP * 4,
    y: ROOT_Y - LANE_GAP,
  },
  {
    id: 'preview-reply',
    key: 'seller_replied',
    label: 'Seller Replied',
    nodeType: 'condition_seller_replied',
    x: ROOT_X + LEVEL_GAP * 4,
    y: ROOT_Y + LANE_GAP,
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function snap(value: number) {
  return Math.round(value / GRID_SIZE) * GRID_SIZE
}

function safeNumber(value: unknown) {
  const next = Number(value)
  return Number.isFinite(next) ? next : NaN
}

function nodeFamily(nodeType: string): NodeFamily {
  if (nodeType.startsWith('trigger_')) return 'trigger'
  if (nodeType.startsWith('send_') || nodeType === 'email_title_company') return 'send'
  if (nodeType.startsWith('wait')) return 'wait'
  if (nodeType.startsWith('condition') || nodeType === 'branch') return 'condition'

  if (
    nodeType.includes('suppress') ||
    nodeType.includes('opt_out') ||
    nodeType.includes('stop') ||
    nodeType.includes('approval')
  ) {
    return 'safety'
  }

  if (['run_comps', 'run_buyer_match', 'calculate_offer'].includes(nodeType)) {
    return 'intelligence'
  }

  return 'ops'
}

function familyLabel(family: string) {
  return (
    {
      trigger: 'Trigger',
      send: 'Communication',
      wait: 'Timing',
      condition: 'Condition',
      intelligence: 'AI / Intelligence',
      safety: 'Safety',
      ops: 'Operations',
    }[family] ?? 'Node'
  )
}

function connectionLabel(kind: ConnectionKind) {
  if (kind === 'true') return 'yes'
  if (kind === 'false') return 'no'
  return 'next'
}

function nodeIcon(nodeType: string): IconName {
  const library = getWorkflowNodeByType(nodeType)
  if (library?.icon) return library.icon

  const family = nodeFamily(nodeType)
  if (family === 'trigger') return 'bolt'
  if (family === 'send') return 'send'
  if (family === 'wait') return 'clock'
  if (family === 'condition') return 'layout-split'
  if (family === 'safety') return 'shield'
  if (family === 'intelligence') return 'brain'
  return 'settings'
}

function stepPosition(step: WorkflowStep, index: number) {
  const ui = step.config?.ui
  const position = step.config?.position

  const px = isRecord(position) && 'x' in position ? safeNumber(position.x) : NaN
  const py = isRecord(position) && 'y' in position ? safeNumber(position.y) : NaN
  const ux = isRecord(ui) && 'x' in ui ? safeNumber(ui.x) : NaN
  const uy = isRecord(ui) && 'y' in ui ? safeNumber(ui.y) : NaN

  return {
    x: Number.isFinite(px) ? px : Number.isFinite(ux) ? ux : ROOT_X + index * LEVEL_GAP,
    y: Number.isFinite(py) ? Math.max(80, py) : Number.isFinite(uy) ? Math.max(80, uy) : ROOT_Y,
  }
}

function getStepConditions(node: CanvasNodeV2) {
  return node.step?.conditions ?? node.paths ?? {}
}

function getOutgoingKeys(node: CanvasNodeV2) {
  const conditions = getStepConditions(node)
  return {
    next: String(conditions.next_path ?? ''),
    yes: String(conditions.true_path ?? ''),
    no: String(conditions.false_path ?? ''),
  }
}

function findRootNode(nodes: CanvasNodeV2[]) {
  const referenced = new Set<string>()

  nodes.forEach((node) => {
    const outgoing = getOutgoingKeys(node)
    if (outgoing.next) referenced.add(outgoing.next)
    if (outgoing.yes) referenced.add(outgoing.yes)
    if (outgoing.no) referenced.add(outgoing.no)
  })

  return (
    nodes.find((node) => nodeFamily(node.nodeType) === 'trigger' && !referenced.has(node.key)) ??
    nodes.find((node) => nodeFamily(node.nodeType) === 'trigger') ??
    nodes.find((node) => !referenced.has(node.key)) ??
    nodes[0]
  )
}

function autoLayout(nodes: CanvasNodeV2[]) {
  if (!nodes.length) return nodes

  const byKey = new Map(nodes.map((node) => [node.key, node]))
  const visited = new Set<string>()
  const occupied = new Map<string, number>()

  function laneSlot(depth: number, lane: number) {
    const key = `${depth}:${lane}`
    const used = occupied.get(key) ?? 0
    occupied.set(key, used + 1)
    return used
  }

  function place(node: CanvasNodeV2, depth: number, lane: number) {
    const slot = laneSlot(depth, lane)

    node.x = ROOT_X + depth * LEVEL_GAP
    node.y = ROOT_Y + lane * LANE_GAP + slot * 72
  }

  function fallbackAfter(node: CanvasNodeV2) {
    const index = nodes.findIndex((item) => item.id === node.id)
    const fallback = nodes[index + 1]

    return fallback && !visited.has(fallback.id) ? fallback : null
  }

  function walk(node: CanvasNodeV2, depth: number, lane: number) {
    if (visited.has(node.id)) return

    visited.add(node.id)
    place(node, depth, lane)

    const outgoing = getOutgoingKeys(node)
    const next = byKey.get(outgoing.next)
    const yes = byKey.get(outgoing.yes)
    const no = byKey.get(outgoing.no)

    const primary = next ?? yes ?? fallbackAfter(node)

    if (primary) {
      walk(primary, depth + 1, lane)
    }

    if (yes && primary?.id !== yes.id) {
      walk(yes, depth + 1, lane - 1)
    }

    if (no) {
      walk(no, depth + 1, lane + 1)
    }
  }

  const root = findRootNode(nodes)
  if (root) walk(root, 0, 0)

  let orphanIndex = 0
  nodes.forEach((node) => {
    if (visited.has(node.id)) return

    const depth = orphanIndex % 4
    const lane = 2 + Math.floor(orphanIndex / 4)

    node.x = ROOT_X + depth * LEVEL_GAP
    node.y = ROOT_Y + lane * LANE_GAP
    orphanIndex += 1
  })

  return nodes
}

export function buildCanvasNodes(detail: WorkflowDetail | null): CanvasNodeV2[] {
  if (!detail?.steps?.length) return autoLayout(emptyBlueprint.map((node) => ({ ...node })))

  const built = [...detail.steps]
    .sort((a, b) => Number(a.step_order) - Number(b.step_order))
    .map((step, index) => {
      const position = stepPosition(step, index)

      return {
        id: step.id,
        key: step.step_key,
        label: step.label,
        nodeType: step.node_type,
        x: position.x,
        y: position.y,
        step,
      }
    })

  return autoLayout(built)
}

function buildConnections(nodes: CanvasNodeV2[]): CanvasConnectionV2[] {
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  const connections: CanvasConnectionV2[] = []

  nodes.forEach((node, index) => {
    const outgoing = getOutgoingKeys(node)

    const trueNode = byKey.get(outgoing.yes)
    const falseNode = byKey.get(outgoing.no)
    const nextNode = byKey.get(outgoing.next)

    if (trueNode) {
      connections.push({
        id: `${node.id}-true-${trueNode.id}`,
        from: node,
        to: trueNode,
        kind: 'true',
      })
    }

    if (falseNode) {
      connections.push({
        id: `${node.id}-false-${falseNode.id}`,
        from: node,
        to: falseNode,
        kind: 'false',
      })
    }

    if (!trueNode && !falseNode && nextNode) {
      connections.push({
        id: `${node.id}-next-${nextNode.id}`,
        from: node,
        to: nextNode,
        kind: 'next',
      })
    }

    if (!trueNode && !falseNode && !nextNode && nodes[index + 1]) {
      connections.push({
        id: `${node.id}-next-${nodes[index + 1].id}`,
        from: node,
        to: nodes[index + 1],
        kind: 'next',
      })
    }
  })

  return connections
}

function dryRunByNode(result: WorkflowDryRunResult | null) {
  const map = new Map<string, WorkflowDryRunStep>()

  for (const step of result?.steps ?? []) {
    if (step.step_id) map.set(step.step_id, step)
    if (step.step_key) map.set(step.step_key, step)
  }

  return map
}

function isSendCapable(nodeType: string) {
  return nodeType.startsWith('send_') || nodeType === 'email_title_company'
}

function nodeSubtitle(node: CanvasNodeV2, dryRunStep?: WorkflowDryRunStep) {
  const library = getWorkflowNodeByType(node.nodeType)

  if (dryRunStep?.rendered_template) {
    return `${dryRunStep.rendered_template.sms?.character_count ?? 0} chars rendered`
  }

  return library?.description ?? familyLabel(nodeFamily(node.nodeType))
}

function nodeStatus(
  node: CanvasNodeV2,
  detail: WorkflowDetail | null,
  dryRunStep?: WorkflowDryRunStep,
) {
  if (
    dryRunStep?.live_send_blocked ||
    (isSendCapable(node.nodeType) && detail?.workflow.live_send_enabled !== true)
  ) {
    return 'Live Blocked'
  }

  if (dryRunStep) return dryRunStep.status === 'blocked' ? 'Blocked' : 'Dry Run'
  return node.step?.is_active === false ? 'Inactive' : 'Ready'
}

function edgeAnchor(connection: CanvasConnectionV2) {
  const branchOffset =
    connection.kind === 'true' ? -30 : connection.kind === 'false' ? 30 : 0

  const x1 = connection.from.x + NODE_WIDTH
  const y1 = connection.from.y + NODE_CENTER_Y + branchOffset
  const x2 = connection.to.x
  const y2 = connection.to.y + NODE_CENTER_Y

  return { x1, y1, x2, y2 }
}

function edgePath(connection: CanvasConnectionV2) {
  const { x1, y1, x2, y2 } = edgeAnchor(connection)

  const deltaX = x2 - x1
  const midX = x1 + Math.max(80, Math.min(180, Math.abs(deltaX) * 0.45))

  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
}

function edgeLabelPosition(connection: CanvasConnectionV2) {
  const { x1, y1, x2, y2 } = edgeAnchor(connection)
  return {
    x: (x1 + x2) / 2,
    y: (y1 + y2) / 2 - 12,
  }
}

function graphBounds(nodes: CanvasNodeV2[]) {
  if (!nodes.length) {
    return { minX: 0, minY: 0, maxX: 1200, maxY: 800 }
  }

  return {
    minX: Math.max(0, Math.min(...nodes.map((node) => node.x)) - 340),
    minY: Math.max(0, Math.min(...nodes.map((node) => node.y)) - 340),
    maxX: Math.max(...nodes.map((node) => node.x + NODE_WIDTH)) + 380,
    maxY: Math.max(...nodes.map((node) => node.y + NODE_HEIGHT)) + 420,
  }
}

function cloneNodes(nodes: CanvasNodeV2[]) {
  return nodes.map((node) => ({ ...node, step: node.step ? { ...node.step } : undefined }))
}

function hitTestNode(point: { x: number; y: number }, nodes: CanvasNodeV2[]) {
  return (
    [...nodes]
      .reverse()
      .find(
        (node) =>
          point.x >= node.x &&
          point.x <= node.x + NODE_WIDTH &&
          point.y >= node.y &&
          point.y <= node.y + NODE_HEIGHT,
      ) ?? null
  )
}

function distanceToEdge(point: { x: number; y: number }, connection: CanvasConnectionV2) {
  const label = edgeLabelPosition(connection)
  const dx = point.x - label.x
  const dy = point.y - label.y
  return Math.hypot(dx, dy)
}

function hitTestEdge(point: { x: number; y: number }, connections: CanvasConnectionV2[]) {
  let best: CanvasConnectionV2 | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const connection of connections) {
    const distance = distanceToEdge(point, connection)
    if (distance < 72 && distance < bestDistance) {
      best = connection
      bestDistance = distance
    }
  }

  return best
}

export interface WorkflowCanvasV2Handle {
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  fitView: () => void
  centerView: () => void
  getZoom: () => number
}

interface WorkflowCanvasV2Props {
  detail: WorkflowDetail | null
  dryRunResult: WorkflowDryRunResult | null
  selectedNodeId: string | null
  selectedNodeIds?: string[]
  onSelectNode: (nodeId: string) => void
  onSelectNodes?: (nodeIds: string[]) => void
  onCreateDraft?: () => void
  onDropNode?: (item: WorkflowNodeLibraryItem, position: { x: number; y: number }) => void
  onDropOnNode?: (
    item: WorkflowNodeLibraryItem,
    targetNode: CanvasNodeV2,
    placement: NodePlacementAction,
  ) => void
  onDropOnEdge?: (
    item: WorkflowNodeLibraryItem,
    connection: CanvasConnectionV2,
    position: { x: number; y: number },
  ) => void
  onDeleteNodes?: (nodeIds: string[]) => void
  layoutRevision?: number
  liveOverlay?: ReactNode
  busy?: boolean
}

export const WorkflowCanvasV2 = forwardRef<WorkflowCanvasV2Handle, WorkflowCanvasV2Props>(function WorkflowCanvasV2({
  detail,
  dryRunResult,
  selectedNodeId,
  selectedNodeIds = [],
  onSelectNode,
  onSelectNodes,
  onCreateDraft,
  onDropNode,
  onDropOnNode,
  onDropOnEdge,
  onDeleteNodes,
  layoutRevision = 0,
  liveOverlay,
  busy,
}, ref) {
  const [zoom, setZoom] = useState(0.78)
  const [localNodes, setLocalNodes] = useState<CanvasNodeV2[]>(() =>
    buildCanvasNodes(detail),
  )
  const [historyPast, setHistoryPast] = useState<CanvasNodeV2[][]>([])
  const [historyFuture, setHistoryFuture] = useState<CanvasNodeV2[][]>([])
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  const [placementMenu, setPlacementMenu] = useState<{
    item: WorkflowNodeLibraryItem
    target: CanvasNodeV2
    x: number
    y: number
  } | null>(null)
  const [panStart, setPanStart] = useState<{
    x: number
    y: number
    left: number
    top: number
  } | null>(null)

  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const clipboardRef = useRef<CanvasNodeV2[]>([])
  const dragItemRef = useRef<WorkflowNodeLibraryItem | null>(null)

  const pushHistory = useCallback((nextNodes: CanvasNodeV2[]) => {
    setHistoryPast((past) => [...past.slice(-39), cloneNodes(localNodes)])
    setHistoryFuture([])
    setLocalNodes(nextNodes)
  }, [localNodes])

  useEffect(() => {
    setLocalNodes(buildCanvasNodes(detail))
    setHistoryPast([])
    setHistoryFuture([])
  }, [detail])

  const nodes = localNodes
  const connections = useMemo(() => buildConnections(nodes), [nodes])
  const bounds = useMemo(() => graphBounds(nodes), [nodes])
  const dryRunMap = useMemo(() => dryRunByNode(dryRunResult), [dryRunResult])
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null
  const selectedIds = useMemo(() => {
    if (selectedNodeIds.length) return new Set(selectedNodeIds)
    if (selectedNodeId) return new Set([selectedNodeId])
    return new Set<string>()
  }, [selectedNodeId, selectedNodeIds])

  useEffect(() => {
    if (!selectedNodeId && nodes[0]) onSelectNode(nodes[0].id)
  }, [nodes, onSelectNode, selectedNodeId])

  const selectedConnections = useMemo(() => {
    if (!selectedIds.size) return new Set<string>()

    return new Set(
      connections
        .filter(
          (connection) =>
            selectedIds.has(connection.from.id) ||
            selectedIds.has(connection.to.id),
        )
        .map((connection) => connection.id),
    )
  }, [connections, selectedIds])

  const toCanvasPoint = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const viewport = scrollRef.current
      if (!viewport) return { x: 0, y: 0 }

      const rect = viewport.getBoundingClientRect()

      return {
        x: (event.clientX - rect.left + viewport.scrollLeft) / zoom,
        y: (event.clientY - rect.top + viewport.scrollTop) / zoom,
      }
    },
    [zoom],
  )

  const fitView = useCallback(() => {
    const viewport = scrollRef.current
    if (!viewport) return

    const width = Math.max(850, bounds.maxX - bounds.minX)
    const height = Math.max(560, bounds.maxY - bounds.minY)

    const nextZoom = Math.max(
      0.42,
      Math.min(1.08, Math.min(viewport.clientWidth / width, viewport.clientHeight / height)),
    )

    setZoom(nextZoom)

    window.requestAnimationFrame(() => {
      viewport.scrollTo({
        left: bounds.minX * nextZoom,
        top: bounds.minY * nextZoom,
        behavior: 'smooth',
      })
    })
  }, [bounds.maxX, bounds.minX, bounds.maxY, bounds.minY])

  const centerView = useCallback(() => {
    const viewport = scrollRef.current
    if (!viewport) return

    const centerX = ((bounds.minX + bounds.maxX) / 2) * zoom
    const centerY = ((bounds.minY + bounds.maxY) / 2) * zoom

    viewport.scrollTo({
      left: Math.max(0, centerX - viewport.clientWidth / 2),
      top: Math.max(0, centerY - viewport.clientHeight / 2),
      behavior: 'smooth',
    })
  }, [bounds.maxX, bounds.minX, bounds.maxY, bounds.minY, zoom])

  const undo = useCallback(() => {
    setHistoryPast((past) => {
      if (!past.length) return past
      const previous = past[past.length - 1]
      setHistoryFuture((future) => [cloneNodes(localNodes), ...future])
      setLocalNodes(previous)
      return past.slice(0, -1)
    })
  }, [localNodes])

  const redo = useCallback(() => {
    setHistoryFuture((future) => {
      if (!future.length) return future
      const next = future[0]
      setHistoryPast((past) => [...past, cloneNodes(localNodes)])
      setLocalNodes(next)
      return future.slice(1)
    })
  }, [localNodes])

  useImperativeHandle(ref, () => ({
    undo,
    redo,
    canUndo: () => historyPast.length > 0,
    canRedo: () => historyFuture.length > 0,
    fitView,
    centerView,
    getZoom: () => zoom,
  }), [centerView, fitView, historyFuture.length, historyPast.length, redo, undo, zoom])

  useEffect(() => {
    if (!layoutRevision) return
    window.requestAnimationFrame(() => {
      fitView()
    })
  }, [fitView, layoutRevision])

  const zoomToSelected = () => {
    const viewport = scrollRef.current
    if (!viewport || !selectedNode) return

    const nextZoom = Math.max(0.62, Math.min(1.02, zoom))
    setZoom(nextZoom)

    window.requestAnimationFrame(() => {
      viewport.scrollTo({
        left: Math.max(0, (selectedNode.x + NODE_WIDTH / 2) * nextZoom - viewport.clientWidth / 2),
        top: Math.max(0, (selectedNode.y + NODE_HEIGHT / 2) * nextZoom - viewport.clientHeight / 2),
        behavior: 'smooth',
      })
    })
  }

  const snapPosition = useCallback((point: { x: number; y: number }) => ({
    x: snap(Math.max(80, Math.min(CANVAS_WIDTH - NODE_WIDTH - 80, point.x - NODE_WIDTH / 2))),
    y: snap(Math.max(80, Math.min(CANVAS_HEIGHT - NODE_HEIGHT - 80, point.y - NODE_HEIGHT / 2))),
  }), [])

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setHoveredEdgeId(null)

    const raw = event.dataTransfer.getData('application/x-workflow-node')
    if (!raw) return

    try {
      const item = JSON.parse(raw) as WorkflowNodeLibraryItem
      const point = toCanvasPoint(event)
      const targetNode = hitTestNode(point, nodes)
      const targetEdge = hitTestEdge(point, connections)

      if (targetNode && (onDropOnNode || onDropNode)) {
        const rect = scrollRef.current?.getBoundingClientRect()
        setPlacementMenu({
          item,
          target: targetNode,
          x: rect ? event.clientX - rect.left : point.x,
          y: rect ? event.clientY - rect.top : point.y,
        })
        return
      }

      if (targetEdge && onDropOnEdge) {
        onDropOnEdge(item, targetEdge, snapPosition(point))
        return
      }

      if (onDropNode) {
        onDropNode(item, snapPosition(point))
      }
    } catch {
      // Ignore malformed drag payloads.
    }
  }

  const applyPlacement = (placement: NodePlacementAction) => {
    if (!placementMenu) return
    const { item, target } = placementMenu
    setPlacementMenu(null)

    if (onDropOnNode) {
      onDropOnNode(item, target, placement)
      return
    }

    onDropNode?.(item, { x: target.x + 120, y: target.y })
  }

  const handleNodePointerDown = (
    event: PointerEvent<HTMLButtonElement>,
    node: CanvasNodeV2,
  ) => {
    event.stopPropagation()

    const point = toCanvasPoint(event)
    const multi = event.metaKey || event.ctrlKey || event.shiftKey

    dragOffsetRef.current = {
      x: point.x - node.x,
      y: point.y - node.y,
    }

    setDraggingId(node.id)

    if (multi && onSelectNodes) {
      const next = selectedIds.has(node.id)
        ? [...selectedIds].filter((id) => id !== node.id)
        : [...selectedIds, node.id]
      onSelectNodes(next)
      onSelectNode(node.id)
    } else {
      onSelectNode(node.id)
      onSelectNodes?.([node.id])
    }

    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleNodePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!draggingId || !dragOffsetRef.current) return

    const point = toCanvasPoint(event)

    const nextX = snap(
      Math.max(
        80,
        Math.min(CANVAS_WIDTH - NODE_WIDTH - 80, point.x - dragOffsetRef.current.x),
      ),
    )

    const nextY = snap(
      Math.max(
        80,
        Math.min(CANVAS_HEIGHT - NODE_HEIGHT - 80, point.y - dragOffsetRef.current.y),
      ),
    )

    setLocalNodes((current) =>
      current.map((node) =>
        node.id === draggingId ? { ...node, x: nextX, y: nextY } : node,
      ),
    )
  }

  const handleNodePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (draggingId) {
      event.currentTarget.releasePointerCapture(event.pointerId)
      pushHistory(localNodes)
    }

    setDraggingId(null)
    dragOffsetRef.current = null
  }

  const duplicateSelection = useCallback(() => {
    const selected = nodes.filter((node) => selectedIds.has(node.id))
    if (!selected.length) return

    const clones = selected.map((node, index) => ({
      ...node,
      id: `${node.id}-copy-${Date.now()}-${index}`,
      key: `${node.key}_copy_${Date.now().toString(36)}`,
      x: node.x + 48,
      y: node.y + 48,
    }))

    pushHistory([...nodes, ...clones])
    const cloneIds = clones.map((node) => node.id)
    onSelectNodes?.(cloneIds)
    onSelectNode(cloneIds[0])
  }, [localNodes, nodes, onSelectNode, onSelectNodes, pushHistory, selectedIds])

  const deleteSelection = useCallback(() => {
    const ids = [...selectedIds]
    if (!ids.length) return
    const next = nodes.filter((node) => !selectedIds.has(node.id))
    pushHistory(next)
    onDeleteNodes?.(ids)
    if (next[0]) {
      onSelectNode(next[0].id)
      onSelectNodes?.([next[0].id])
    }
  }, [nodes, onDeleteNodes, onSelectNode, onSelectNodes, pushHistory, selectedIds])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['input', 'textarea', 'select'].includes(target.tagName.toLowerCase())) return

      const meta = event.metaKey || event.ctrlKey

      if (meta && event.key.toLowerCase() === 'c') {
        clipboardRef.current = nodes.filter((node) => selectedIds.has(node.id))
        return
      }

      if (meta && event.key.toLowerCase() === 'v' && clipboardRef.current.length) {
        event.preventDefault()
        const pasted = clipboardRef.current.map((node, index) => ({
          ...node,
          id: `${node.id}-paste-${Date.now()}-${index}`,
          key: `${node.key}_paste_${Date.now().toString(36)}`,
          x: node.x + 72,
          y: node.y + 72,
        }))
        pushHistory([...nodes, ...pasted])
        const pastedIds = pasted.map((node) => node.id)
        onSelectNodes?.(pastedIds)
        onSelectNode(pastedIds[0])
        return
      }

      if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        duplicateSelection()
        return
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelection()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleteSelection, duplicateSelection, nodes, onSelectNode, onSelectNodes, pushHistory, selectedIds])

  const handlePanStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return

    const target = event.target as HTMLElement
    if (target.closest('.wfs2-node')) return

    const viewport = scrollRef.current
    if (!viewport) return

    setPanStart({
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    })

    viewport.setPointerCapture(event.pointerId)
  }

  const handlePanMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!panStart) return

    const viewport = scrollRef.current
    if (!viewport) return

    viewport.scrollLeft = panStart.left - (event.clientX - panStart.x)
    viewport.scrollTop = panStart.top - (event.clientY - panStart.y)
  }

  const handlePanEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!panStart) return

    scrollRef.current?.releasePointerCapture(event.pointerId)
    setPanStart(null)
  }

  const miniMap = useMemo(() => {
    const width = 178
    const height = 116
    const graphWidth = Math.max(1, bounds.maxX - bounds.minX)
    const graphHeight = Math.max(1, bounds.maxY - bounds.minY)

    return {
      width,
      height,
      nodes: nodes.map((node) => ({
        id: node.id,
        family: nodeFamily(node.nodeType),
        x: ((node.x - bounds.minX) / graphWidth) * width,
        y: ((node.y - bounds.minY) / graphHeight) * height,
        w: Math.max(5, (NODE_WIDTH / graphWidth) * width),
        h: Math.max(4, (NODE_HEIGHT / graphHeight) * height),
      })),
    }
  }, [bounds, nodes])

  return (
    <section className="wfs2-canvas-wrap">
      <div className="wfs2-canvas-toolbar">
        <div>
          <span className="wfs2-cmd__kicker">Canvas Engine</span>
          <strong>
            {nodes.length} nodes · {connections.length} paths
          </strong>
        </div>

        <div className="wfs2-canvas-toolbar__tools">
          <button type="button" className="wfs2__btn is-ghost" onClick={fitView}>
            <Icon name="maximize" /> Fit
          </button>

          <button type="button" className="wfs2__btn is-ghost" onClick={centerView}>
            <Icon name="target" /> Center
          </button>

          <button
            type="button"
            className="wfs2__btn is-ghost"
            disabled={!selectedNode}
            onClick={zoomToSelected}
          >
            Focus
          </button>

          <button
            type="button"
            className="wfs2__btn is-ghost"
            onClick={() => setZoom((value) => Math.max(0.25, value - 0.08))}
          >
            −
          </button>

          <span className="wfs2-cmd__chip">{Math.round(zoom * 100)}%</span>

          <button
            type="button"
            className="wfs2__btn is-ghost"
            onClick={() => setZoom((value) => Math.min(1.24, value + 0.08))}
          >
            +
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className={cls('wfs2-canvas-scroll', panStart && 'is-panning')}
        onDragOver={(event) => {
          event.preventDefault()
          const raw = event.dataTransfer.getData('application/x-workflow-node')
          if (!raw) return
          try {
            dragItemRef.current = JSON.parse(raw) as WorkflowNodeLibraryItem
            const point = toCanvasPoint(event)
            const edge = hitTestEdge(point, connections)
            setHoveredEdgeId(edge?.id ?? null)
          } catch {
            setHoveredEdgeId(null)
          }
        }}
        onDragLeave={() => setHoveredEdgeId(null)}
        onDrop={handleDrop}
        onPointerDown={handlePanStart}
        onPointerMove={handlePanMove}
        onPointerUp={handlePanEnd}
        onPointerCancel={handlePanEnd}
      >
        <div
          className="wfs2-canvas-spacer"
          style={{
            width: CANVAS_WIDTH * zoom,
            height: CANVAS_HEIGHT * zoom,
          }}
        >
          <div
            className="wfs2-canvas-stage"
            style={{
              width: CANVAS_WIDTH,
              height: CANVAS_HEIGHT,
              transform: `scale(${zoom})`,
            }}
          >
            <div className="wfs2-canvas-aura" />

            <svg
              className="wfs2-canvas-lines"
              viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="wfs2-arrow"
                  markerWidth="12"
                  markerHeight="12"
                  refX="10"
                  refY="6"
                  orient="auto"
                  markerUnits="userSpaceOnUse"
                >
                  <path d="M 0 0 L 12 6 L 0 12 z" className="wfs2-arrow" />
                </marker>

                <filter id="wfs2-edge-glow" x="-30%" y="-30%" width="160%" height="160%">
                  <feGaussianBlur stdDeviation="4" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              {connections.map((connection) => {
                const fromRun = dryRunMap.has(connection.from.id) || dryRunMap.has(connection.from.key)
                const toRun = dryRunMap.has(connection.to.id) || dryRunMap.has(connection.to.key)

                const selected = selectedConnections.has(connection.id)
                const hovered = hoveredEdgeId === connection.id
                const active = (fromRun && toRun) || selected || hovered
                const path = edgePath(connection)
                const pathId = `wfs2-edge-path-${connection.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
                const label = edgeLabelPosition(connection)

                return (
                  <g
                    key={connection.id}
                    className={cls(
                      'wfs2-edge-group',
                      `is-${connection.kind}`,
                      active && 'is-active',
                      selected && 'is-selected',
                      hovered && 'is-drop-target',
                    )}
                  >
                    <path
                      id={pathId}
                      className={cls('wfs2-edge-shadow', `is-${connection.kind}`)}
                      d={path}
                    />

                    <path
                      className={cls(
                        'wfs2-edge',
                        `is-${connection.kind}`,
                        active && 'is-active',
                      )}
                      d={path}
                      markerEnd="url(#wfs2-arrow)"
                      filter={active ? 'url(#wfs2-edge-glow)' : undefined}
                    />

                    {active && (
                      <>
                        <circle className="wfs2-edge-particle" r="6">
                          <animateMotion dur="1.45s" repeatCount="indefinite" path={path} />
                        </circle>
                        <circle className="wfs2-edge-particle is-secondary" r="3.5">
                          <animateMotion
                            dur="1.45s"
                            begin="0.48s"
                            repeatCount="indefinite"
                            path={path}
                          />
                        </circle>
                      </>
                    )}

                    <g className={cls('wfs2-edge-label-wrap', active && 'is-active')}>
                      <rect
                        x={label.x - 28}
                        y={label.y - 13}
                        width="56"
                        height="24"
                        rx="12"
                        className="wfs2-edge-label-bg"
                      />
                      <text
                        className={cls('wfs2-edge-label', `is-${connection.kind}`)}
                        x={label.x}
                        y={label.y + 4}
                        textAnchor="middle"
                      >
                        {connectionLabel(connection.kind)}
                      </text>
                    </g>
                  </g>
                )
              })}
            </svg>

            {nodes.map((node) => {
              const dryStep = dryRunMap.get(node.id) ?? dryRunMap.get(node.key)
              const status = nodeStatus(node, detail, dryStep)
              const family = nodeFamily(node.nodeType)
              const isCondition = family === 'condition'
              const isSelected = selectedIds.has(node.id)

              return (
                <button
                  key={node.id}
                  type="button"
                  className={cls(
                    'wfs2-node',
                    `is-${family}`,
                    isSelected && 'is-selected',
                    dryStep && 'is-dry-run',
                    draggingId === node.id && 'is-dragging',
                  )}
                  style={{ left: node.x, top: node.y }}
                  onPointerDown={(event) => handleNodePointerDown(event, node)}
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={handleNodePointerUp}
                  onPointerCancel={handleNodePointerUp}
                  onDoubleClick={zoomToSelected}
                >
                  <span className="wfs2-node__halo" />
                  <span className="wfs2-node__port is-in" />

                  {isCondition ? (
                    <>
                      <span className="wfs2-node__port is-true" title="True branch" />
                      <span className="wfs2-node__port is-false" title="False branch" />
                    </>
                  ) : (
                    <span className="wfs2-node__port is-out" />
                  )}

                  <span className="wfs2-node__accent" />

                  <span className="wfs2-node__icon">
                    <Icon name={nodeIcon(node.nodeType)} />
                  </span>

                  <span className="wfs2-node__main">
                    <small>{familyLabel(family)}</small>
                    <strong>{node.label}</strong>
                    <em>{nodeSubtitle(node, dryStep)}</em>
                  </span>

                  <span className="wfs2-node__badges">
                    <span
                      className={cls(
                        'wfs2-node__status',
                        status === 'Live Blocked' && 'is-live-blocked',
                        status === 'Dry Run' && 'is-dry-run',
                      )}
                    >
                      {status}
                    </span>

                    {isSendCapable(node.nodeType) && (
                      <span className="wfs2-node__status is-live-blocked">
                        <Icon name="shield" />
                      </span>
                    )}
                  </span>
                </button>
              )
            })}

            {liveOverlay}

            {!detail && (
              <div className="wfs2-canvas-empty">
                <strong>Preview mode</strong>
                <span>Select or create a workflow to edit the canvas.</span>

                {onCreateDraft && (
                  <button
                    type="button"
                    className="wfs2__btn is-primary"
                    disabled={busy}
                    onClick={onCreateDraft}
                    style={{ pointerEvents: 'auto' }}
                  >
                    <Icon name="check" /> Create Draft
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="wfs2-minimap" aria-hidden="true">
        <div className="wfs2-minimap__head">
          <span>Workflow Radar</span>
          <strong>{nodes.length}</strong>
        </div>

        <svg viewBox={`0 0 ${miniMap.width} ${miniMap.height}`}>
          {miniMap.nodes.map((node) => (
            <rect
              key={node.id}
              className={cls('wfs2-minimap__node', `is-${node.family}`)}
              x={node.x}
              y={node.y}
              width={node.w}
              height={node.h}
              rx="2"
            />
          ))}
        </svg>
      </div>

      {placementMenu && (
        <div
          className="wfs2-canvas-placement"
          style={{ left: placementMenu.x, top: placementMenu.y }}
        >
          <strong>Place node</strong>
          <button type="button" onClick={() => applyPlacement('insert-before')}>Insert Before</button>
          <button type="button" onClick={() => applyPlacement('insert-after')}>Insert After</button>
          <button type="button" onClick={() => applyPlacement('add-branch')}>Add Branch</button>
          <button type="button" onClick={() => applyPlacement('replace')}>Replace</button>
          <button type="button" className="is-cancel" onClick={() => setPlacementMenu(null)}>Cancel</button>
        </div>
      )}

      {hoveredEdgeId && (
        <div className="wfs2-canvas-edge-hint">Insert Here</div>
      )}
    </section>
  )
})