import type { IconName } from '../../../shared/icons'
import type { EntityGraphEdge, EntityGraphNode } from '../../../domain/entity-graph/entity-graph.types'

export const NODE_STYLE: Record<string, { icon: IconName; tone: string; label: string }> = {
  property: { icon: 'home', tone: '#488aec', label: 'Property' },
  master_owner: { icon: 'briefcase', tone: '#c084fc', label: 'Owner' },
  organization: { icon: 'briefcase', tone: '#a78bfa', label: 'Entity' },
  prospect: { icon: 'user', tone: '#3ecf8e', label: 'Person' },
  phone: { icon: 'phone', tone: '#f5a524', label: 'Phone' },
  email: { icon: 'mail', tone: '#fbbf24', label: 'Email' },
  market: { icon: 'map', tone: '#64748b', label: 'Market' },
  zip: { icon: 'hash', tone: '#64748b', label: 'ZIP' },
  thread: { icon: 'message', tone: '#38bdf8', label: 'Thread' },
}

/** Node types that have their own dossier neighborhood to pull in. */
export const EXPANDABLE = new Set(['property', 'master_owner', 'organization', 'prospect', 'phone', 'email'])

/** Dossier api type for a graph node type. */
export function dossierTypeFor(nodeType: string): string | null {
  if (nodeType === 'prospect') return 'prospect'
  if (nodeType === 'master_owner') return 'master_owner'
  if (nodeType === 'organization') return 'organization'
  if (nodeType === 'property') return 'property'
  if (nodeType === 'phone' || nodeType === 'email') return nodeType
  return null
}

export type Placed = EntityGraphNode & { x: number; y: number; hop: number }

const RING_RADIUS = [0, 150, 268, 372]

/**
 * Deterministic radial placement by hop distance from the anchor.
 *
 * Not a force simulation: on a phone a settling simulation fights the user's
 * pan, and re-running it on every expansion makes previously-read nodes jump.
 * Rings keep already-placed nodes exactly where they were, so an expansion only
 * ever *adds* to the picture.
 */
export function layout(
  nodes: EntityGraphNode[],
  edges: EntityGraphEdge[],
  anchorId: string,
  previous: Map<string, Placed>,
): Placed[] {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, [])
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, [])
    adjacency.get(edge.from)!.push(edge.to)
    adjacency.get(edge.to)!.push(edge.from)
  }

  const hops = new Map<string, number>([[anchorId, 0]])
  const queue = [anchorId]
  while (queue.length) {
    const current = queue.shift() as string
    const hop = hops.get(current) ?? 0
    for (const next of adjacency.get(current) ?? []) {
      if (hops.has(next)) continue
      hops.set(next, hop + 1)
      queue.push(next)
    }
  }

  const byHop = new Map<number, EntityGraphNode[]>()
  for (const node of nodes) {
    const hop = hops.get(node.id) ?? 3
    if (!byHop.has(hop)) byHop.set(hop, [])
    byHop.get(hop)!.push(node)
  }

  const placed: Placed[] = []
  for (const [hop, ring] of [...byHop.entries()].sort((a, b) => a[0] - b[0])) {
    const radius = RING_RADIUS[Math.min(hop, RING_RADIUS.length - 1)] + Math.max(0, hop - 3) * 96
    const existing = ring.filter((n) => previous.has(n.id))
    const fresh = ring.filter((n) => !previous.has(n.id))

    for (const node of existing) {
      const prior = previous.get(node.id) as Placed
      placed.push({ ...node, x: prior.x, y: prior.y, hop })
    }

    const step = (Math.PI * 2) / Math.max(fresh.length, 1)
    // Offset alternate rings by half a step so nodes don't line up radially and
    // hide each other behind their labels.
    const offset = (hop % 2) * (step / 2) - Math.PI / 2
    fresh.forEach((node, index) => {
      if (hop === 0) {
        placed.push({ ...node, x: 0, y: 0, hop })
        return
      }
      const angle = offset + step * index
      placed.push({ ...node, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, hop })
    })
  }
  return placed
}

/**
 * Relationship groups an operator expands along, rather than "expand
 * everything". A property with a 40-property portfolio should not dump 40 nodes
 * because you wanted its phone numbers.
 */
export type RelationshipGroup = 'ownership' | 'people' | 'contacts' | 'properties' | 'geography' | 'threads'

export const RELATIONSHIP_GROUPS: Array<{ key: RelationshipGroup; label: string; types: string[] }> = [
  { key: 'ownership', label: 'Ownership', types: ['master_owner', 'organization'] },
  { key: 'people', label: 'People', types: ['prospect'] },
  { key: 'contacts', label: 'Contacts', types: ['phone', 'email'] },
  { key: 'properties', label: 'Properties', types: ['property'] },
  { key: 'geography', label: 'Geography', types: ['market', 'zip'] },
  { key: 'threads', label: 'Conversations', types: ['thread'] },
]

export function groupForType(type: string): RelationshipGroup | null {
  return RELATIONSHIP_GROUPS.find((g) => g.types.includes(type))?.key ?? null
}

/** Node ids within `hops` edges of `rootId`, for focus de-emphasis. */
export function neighborhoodOf(
  rootId: string,
  edges: EntityGraphEdge[],
  hops = 1,
): Set<string> {
  const adjacency = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set())
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set())
    adjacency.get(edge.from)!.add(edge.to)
    adjacency.get(edge.to)!.add(edge.from)
  }
  const seen = new Set([rootId])
  let frontier = [rootId]
  for (let i = 0; i < hops; i += 1) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (seen.has(neighbor)) continue
        seen.add(neighbor)
        next.push(neighbor)
      }
    }
    frontier = next
  }
  return seen
}
