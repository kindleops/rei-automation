import type { NodeFamily, Topology } from '../observatory-types'

/**
 * lc.workflow/v1 on the client — the draft a Studio workflow is edited as.
 * The server stays the authority: validation, description, diff and
 * simulation come from POST /simulate (pure, no writes) and publishing goes
 * through the existing orchestrator action (immutable version n+1).
 */
export type Kind = 'action' | 'condition' | 'wait' | 'approval' | 'follow_up_loop' | 'terminate'
export interface GNode { id: string; kind: Kind; label: string; config: Record<string, unknown> }
export interface GEdge { from: string; to: string; exit?: string }
export interface Graph { schema: 'lc.workflow/v1'; trigger: { type: string }; nodes: GNode[]; edges: GEdge[]; key?: string; name?: string; domain?: string | null }

export interface CatalogCapability { key: string; domain: string; label: string; description: string; policy: string; inputs: Record<string, { type: string; required?: boolean; values?: string[] }>; availability: { state: string; reason?: string } }
export interface CatalogCondition { key: string; label: string; reads: string; exits: string[] }
export interface CatalogTrigger { key: string; label: string; when: string; source: string; volume30d: number | null }
export interface Catalog { capabilities: CatalogCapability[]; conditions: CatalogCondition[]; triggers: CatalogTrigger[] }

export function exitsOf(n: GNode, cat: Catalog | null): string[] {
  const c = n.config || {}
  switch (n.kind) {
    case 'condition': return cat?.conditions.find((x) => x.key === c.condition)?.exits || []
    case 'wait': return c.mode === 'event' ? ['Event', 'Timeout'] : ['Next']
    case 'approval': return c.timeout_hours ? ['Approved', 'Rejected', 'Timeout'] : ['Approved', 'Rejected']
    case 'follow_up_loop': return ['Stopped', 'Exhausted']
    case 'action': return c.on_failure === 'branch' ? ['Success', 'Failed'] : ['Next']
    default: return []
  }
}

const FAMILY_OF: Record<Kind, NodeFamily> = { action: 'ACTION', condition: 'CONDITION', wait: 'WAIT', approval: 'APPROVAL', follow_up_loop: 'RETRY', terminate: 'TERMINAL' }

/** Same projection the server uses for studio topologies: the first exit of each node is the spine. */
export function draftTopology(key: string, g: Graph, cat: Catalog | null): Topology {
  const out = new Map<string, GEdge[]>()
  for (const e of g.edges) (out.get(e.from) || out.set(e.from, []).get(e.from)!).push(e)
  const spine = new Set(['trigger'])
  let cur = 'trigger'
  for (let i = 0; i < 60; i++) {
    const n = g.nodes.find((x) => x.id === cur)
    const exits = cur === 'trigger' ? ['Next'] : n ? exitsOf(n, cat) : []
    const first = [...(out.get(cur) || [])].sort((a, b) => exits.indexOf(a.exit || 'Next') - exits.indexOf(b.exit || 'Next'))[0]
    if (!first || spine.has(first.to)) break
    spine.add(first.to); cur = first.to
  }
  const trig = cat?.triggers.find((t) => t.key === g.trigger.type)
  return {
    workflow_key: key,
    topology_version: 'draft',
    direction: 'LR',
    badge: 'DRAFT · not published · runs stay on the published version',
    groups: [],
    nodes: [
      { key: 'trigger', family: 'TRIGGER', label: trig?.label || g.trigger.type || 'Choose a trigger', summary: trig?.source || null },
      ...g.nodes.map((n) => {
        const cap = cat?.capabilities.find((c) => c.key === (n.config.capability || (n.config.action as { capability?: string } | undefined)?.capability))
        return {
          key: n.id,
          family: n.kind === 'action' && cap?.key === 'notify.operator' ? 'NOTIFICATION' as NodeFamily : FAMILY_OF[n.kind],
          label: n.label || n.id,
          summary: cap?.label || cat?.conditions.find((c) => c.key === n.config.condition)?.label || (n.kind === 'wait' ? String(n.config.mode || '') : null),
          lane: spine.has(n.id) ? 0 : n.kind === 'approval' ? -1 : 1,
          terminal: n.kind === 'terminate' ? ('success' as const) : null,
        }
      }),
    ],
    edges: g.edges.map((e) => ({ id: `${e.from}__${e.to}__${e.exit || 'Next'}`, from: e.from, to: e.to, kind: e.exit && e.exit !== 'Next' ? (/Timeout|Rejected|Failed|Exhausted/.test(e.exit) ? 'exception' : 'branch') : 'primary', label: e.exit && e.exit !== 'Next' ? e.exit.toUpperCase() : null })),
  }
}

let seq = 0
export const newId = (kind: Kind) => `${kind === 'follow_up_loop' ? 'loop' : kind}_${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`

export function defaultNode(kind: Kind, cat: Catalog | null, pick?: string): GNode {
  const id = newId(kind)
  switch (kind) {
    case 'action': { const cap = cat?.capabilities.find((c) => c.key === pick) || cat?.capabilities.find((c) => c.availability.state === 'AVAILABLE'); return { id, kind, label: cap?.label || 'Action', config: { capability: cap?.key || '', inputs: {} } } }
    case 'condition': { const c = cat?.conditions.find((x) => x.key === pick) || cat?.conditions[0]; return { id, kind, label: c?.label || 'Condition', config: { condition: c?.key || '' } } }
    case 'wait': return { id, kind, label: 'Wait', config: pick === 'event' ? { mode: 'event', event: cat?.triggers[0]?.key || '', timeout_hours: 48 } : pick === 'until' ? { mode: 'until', until: '' } : { mode: 'duration', duration_hours: 4, anchor: 'run' } }
    case 'approval': return { id, kind, label: 'Operator approval', config: { title: 'Approve this step', timeout_hours: 24 } }
    case 'follow_up_loop': return { id, kind, label: 'Follow-up loop', config: { action: { capability: 'notify.operator', inputs: {} }, cadence_hours: 24, max_attempts: 3, stop: { condition: 'seller.replied_since', when: 'Replied' } } }
    default: return { id, kind: 'terminate', label: 'End', config: { outcome: 'completed' } }
  }
}

/** Insert `node` after `after` on its first free exit (or re-route that exit through the new node). */
export function insertAfter(g: Graph, after: string, node: GNode, cat: Catalog | null): Graph {
  const from = after === 'trigger' ? null : g.nodes.find((n) => n.id === after)
  const exits = after === 'trigger' ? ['Next'] : from ? exitsOf(from, cat) : ['Next']
  const used = new Set(g.edges.filter((e) => e.from === after).map((e) => e.exit || 'Next'))
  const free = exits.find((x) => !used.has(x))
  const nodes = [...g.nodes, node]
  if (free) return { ...g, nodes, edges: [...g.edges, { from: after, to: node.id, ...(free !== 'Next' ? { exit: free } : {}) }] }
  // every exit is wired: splice into the first one
  const first = g.edges.find((e) => e.from === after)!
  const mine = exitsOf(node, cat)[0]
  return { ...g, nodes, edges: [...g.edges.filter((e) => e !== first), { ...first, to: node.id }, ...(mine ? [{ from: node.id, to: first.to, ...(mine !== 'Next' ? { exit: mine } : {}) }] : [])] }
}

export function removeNode(g: Graph, id: string): Graph {
  const incoming = g.edges.filter((e) => e.to === id)
  const outgoing = g.edges.filter((e) => e.from === id)
  // bridge a simple chain so the graph stays connected
  const bridge = incoming.length === 1 && outgoing.length === 1 ? [{ ...incoming[0], to: outgoing[0].to }] : []
  return { ...g, nodes: g.nodes.filter((n) => n.id !== id), edges: [...g.edges.filter((e) => e.from !== id && e.to !== id), ...bridge] }
}

export function setExit(g: Graph, from: string, exit: string, to: string | null): Graph {
  const rest = g.edges.filter((e) => !(e.from === from && (e.exit || 'Next') === exit))
  return { ...g, edges: to ? [...rest, { from, to, ...(exit !== 'Next' ? { exit } : {}) }] : rest }
}
