import { describe, expect, it } from 'vitest'
import { defaultNode, draftTopology, exitsOf, insertAfter, removeNode, setExit, type Catalog, type Graph } from './graph-model'
import { delayBefore, replayStepsOf, type ReplayStep } from '../runs/replay'
import { layoutSystemMap, neighbourhood } from '../overview/system-layout'
import type { RunDetailResponse, SystemEdge, SystemNode } from '../lib/types'

const CAT: Catalog = {
  capabilities: [
    { key: 'notify.operator', domain: 'notifications', label: 'Notify operator', description: '', policy: 'AUTO', inputs: { title: { type: 'string', required: true } }, availability: { state: 'AVAILABLE' } },
    { key: 'outbound.send_sms', domain: 'outbound', label: 'Send SMS', description: '', policy: 'APPROVAL', inputs: {}, availability: { state: 'AVAILABLE' } },
    { key: 'seller.pause_automation', domain: 'seller', label: 'Pause seller automation', description: '', policy: 'AUTO', inputs: {}, availability: { state: 'UNAVAILABLE', reason: 'No canonical writer yet' } },
  ],
  conditions: [{ key: 'seller.conversation_open', label: 'Still needs a human?', reads: 'buckets', inputs: ['seller'], exits: ['Open', 'Handled'] }],
  triggers: [{ key: 'seller_needs_review', label: 'Seller conversation needs review', when: 'a seller conversation needs review', source: 'automation_events', domain: 'seller', scope: [], event_types: [], volume30d: 95 }],
}
const G: Graph = { schema: 'lc.workflow/v1', trigger: { type: 'seller_needs_review' }, nodes: [], edges: [] }

describe('authoring model — the draft a Studio workflow is edited as', () => {
  it('never offers an unavailable capability as the default action', () => {
    const n = defaultNode('action', CAT)
    expect(n.config.capability).toBe('notify.operator')
  })

  it('insertAfter wires the first free exit, then splices into a wired one', () => {
    const a = defaultNode('condition', CAT)
    let g = insertAfter(G, 'trigger', a, CAT)
    expect(g.edges).toEqual([{ from: 'trigger', to: a.id }])
    const b = defaultNode('terminate', CAT)
    g = insertAfter(g, a.id, b, CAT)
    expect(g.edges.find((e) => e.from === a.id)).toEqual({ from: a.id, to: b.id, exit: 'Open' })
    const c = defaultNode('terminate', CAT)
    g = insertAfter(g, a.id, c, CAT)
    expect(g.edges.find((e) => e.from === a.id && e.exit === 'Handled')?.to).toBe(c.id)
  })

  it('a decision’s exits come from its typed condition; a wait-for-event always has a Timeout', () => {
    expect(exitsOf(defaultNode('condition', CAT), CAT)).toEqual(['Open', 'Handled'])
    expect(exitsOf(defaultNode('wait', CAT, 'event'), CAT)).toEqual(['Event', 'Timeout'])
    expect(exitsOf(defaultNode('approval', CAT), CAT)).toContain('Rejected')
  })

  it('removing a step bridges a simple chain so the graph stays connected', () => {
    const a = defaultNode('wait', CAT)
    const b = defaultNode('terminate', CAT)
    let g = insertAfter(insertAfter(G, 'trigger', a, CAT), a.id, b, CAT)
    g = removeNode(g, a.id)
    expect(g.edges).toEqual([{ from: 'trigger', to: b.id }])
    g = setExit(g, 'trigger', 'Next', null)
    expect(g.edges).toEqual([])
  })

  it('the draft topology is a single-trigger board with typed families and labelled branches', () => {
    const cond = defaultNode('condition', CAT)
    const end = defaultNode('terminate', CAT)
    const g = insertAfter(insertAfter(G, 'trigger', cond, CAT), cond.id, end, CAT)
    const t = draftTopology('x', g, CAT)
    expect(t.nodes.filter((n) => n.family === 'TRIGGER')).toHaveLength(1)
    expect(t.nodes.find((n) => n.key === cond.id)?.family).toBe('CONDITION')
    expect(t.edges.find((e) => e.from === cond.id)?.label).toBe('OPEN')
  })
})

describe('replay timing — the recorded granularity, never invented', () => {
  const steps: ReplayStep[] = [
    { node: 'a', at: 0, status: 'succeeded', label: null },
    { node: 'b', at: 50, status: 'succeeded', label: null },
    { node: 'c', at: 4 * 3600e3, status: 'succeeded', label: null },
  ]
  it('recorder / inferred / single timings replay as order only (uniform spacing)', () => {
    for (const q of ['recorder', 'inferred', 'single'] as const) expect(delayBefore(steps, 1, q)).toBe(delayBefore(steps, 2, q))
  })
  it('measured timings keep their order of magnitude, compressed', () => {
    expect(delayBefore(steps, 2, 'measured')).toBeGreaterThan(delayBefore(steps, 1, 'measured'))
    expect(delayBefore(steps, 2, 'measured')).toBeLessThanOrEqual(1900)
  })
  it('steps follow the path order and never replay a skipped step', () => {
    const run = { path: { order: ['a', 'b'], edges: [], focus: 'b', nodes: { a: { status: 'succeeded', at: '2026-10-01T10:00:00.000Z', reason: null }, b: { status: 'blocked', at: '2026-10-01T10:00:00.050Z', reason: 'unclear_low_confidence' }, c: { status: 'skipped', at: null, reason: null } } } } as unknown as RunDetailResponse
    const s = replayStepsOf(run)
    expect(s.map((x) => x.node)).toEqual(['a', 'b'])
    expect(s[1].label).toBe('unclear low confidence')
  })
})

describe('system map layout', () => {
  const nodes: SystemNode[] = ['campaign_execution', 'queue_dispatch', 'textgrid', 'seller_inbound', 'offer_negotiation', 'unknown_runtime'].map((key) => ({ key, kind: key === 'textgrid' ? 'external' : 'system', label: key }))
  const edges: SystemEdge[] = [
    { id: 'campaign__dispatch', from: 'campaign_execution', to: 'queue_dispatch', kind: 'action', label: 'Queue plan', evidence: '', measure: 'x', traffic: { window: '24h', count: 3 }, state: 'carrying' },
    { id: 'seller__dispatch', from: 'seller_inbound', to: 'queue_dispatch', kind: 'action', label: 'Replies', evidence: '', measure: 'x', traffic: { window: '24h', count: 1 }, state: 'carrying' },
    { id: 'seller__negotiation', from: 'seller_inbound', to: 'offer_negotiation', kind: 'subworkflow', label: 'Offer stages', evidence: '', measure: 'x', traffic: { window: '24h', count: 0 }, state: 'quiet' },
  ]
  it('places every system (an unknown one in the open row), draws every edge, never overlaps two modules', () => {
    const l = layoutSystemMap(nodes, edges)
    expect(l.nodes).toHaveLength(nodes.length)
    expect(l.edges).toHaveLength(edges.length)
    for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) {
      const a = l.nodes[i]; const b = l.nodes[j]
      expect(Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h, `${a.key} × ${b.key}`).toBe(false)
    }
  })
  it('dependencies and downstream effects come from the real edges only', () => {
    expect(neighbourhood('queue_dispatch', edges)).toEqual({ up: ['campaign_execution', 'seller_inbound'], down: [] })
    expect(neighbourhood('seller_inbound', edges).down).toEqual(['queue_dispatch', 'offer_negotiation'])
  })

  // the production map (system-map.js SYSTEM_MAP_EDGES): no connector may pass through a module
  const FULL: Array<[string, string, string]> = [
    ['campaign__dispatch', 'campaign_execution', 'queue_dispatch'], ['dispatch__textgrid', 'queue_dispatch', 'textgrid'], ['textgrid__dispatch', 'textgrid', 'queue_dispatch'],
    ['reconcile__dispatch', 'delivery_reconcile', 'queue_dispatch'], ['textgrid__seller', 'textgrid', 'seller_inbound'], ['seller__dispatch', 'seller_inbound', 'queue_dispatch'],
    ['seller__negotiation', 'seller_inbound', 'offer_negotiation'], ['negotiation__dispatch', 'offer_negotiation', 'queue_dispatch'], ['seller__decision', 'seller_inbound', 'decision_engine'],
    ['reconcile_state__decision', 'lead_state_reconcile', 'decision_engine'], ['seller__dnc', 'seller_inbound', 'dnc_opt_out'], ['dnc__suppression', 'dnc_opt_out', 'suppression'],
    ['suppression__dispatch', 'suppression', 'queue_dispatch'], ['seller__pipeline', 'seller_inbound', 'pipeline'], ['lead_state__seller', 'lead_state_reconcile', 'seller_inbound'],
    ['seller__bridge', 'seller_inbound', 'event_bridge'], ['dispatch__bridge', 'queue_dispatch', 'event_bridge'], ['bridge__studio', 'event_bridge', 'studio_orchestrator'],
    ['pipeline__studio', 'pipeline', 'studio_orchestrator'], ['studio__notifications', 'studio_orchestrator', 'operator_notifications'], ['seller__notifications', 'seller_inbound', 'operator_notifications'],
    ['campaign__notifications', 'campaign_execution', 'operator_notifications'], ['closing__email', 'closing_execution', 'email_dispatch'], ['closing__pipeline', 'closing_execution', 'pipeline'],
    ['closing__notifications', 'closing_execution', 'operator_notifications'], ['email__brevo', 'email_dispatch', 'brevo'],
  ]
  const fullNodes: SystemNode[] = [...new Set([...FULL.flatMap(([, f, t]) => [f, t]), 'buyer_matching'])].map((key) => ({ key, kind: 'system', label: key }))
  const fullEdges: SystemEdge[] = FULL.map(([id, from, to]) => ({ id, from, to, kind: 'action', label: id, evidence: '', measure: 'x', traffic: { window: '24h', count: 1 }, state: 'carrying' }))
  /** sample an M/L/Q path into points */
  const sample = (d: string): Array<[number, number]> => {
    const tok = d.replace(/,/g, ' ').trim().split(/\s+/)
    const pts: Array<[number, number]> = []
    let cur: [number, number] = [0, 0]
    for (let i = 0; i < tok.length;) {
      const c = tok[i++]
      if (c === 'M') { cur = [+tok[i++], +tok[i++]]; pts.push(cur) }
      else if (c === 'L') { const n: [number, number] = [+tok[i++], +tok[i++]]; for (let s = 1; s <= 24; s++) pts.push([cur[0] + (n[0] - cur[0]) * s / 24, cur[1] + (n[1] - cur[1]) * s / 24]); cur = n }
      else if (c === 'Q') { const q: [number, number] = [+tok[i++], +tok[i++]]; const n: [number, number] = [+tok[i++], +tok[i++]]; for (let s = 1; s <= 8; s++) { const t = s / 8; pts.push([(1 - t) ** 2 * cur[0] + 2 * (1 - t) * t * q[0] + t * t * n[0], (1 - t) ** 2 * cur[1] + 2 * (1 - t) * t * q[1] + t * t * n[1]]) } cur = n }
      else throw new Error(`unexpected path command ${c}`)
    }
    return pts
  }
  it('routes every production connector without passing through a module', () => {
    const l = layoutSystemMap(fullNodes, fullEdges)
    expect(l.edges).toHaveLength(FULL.length)
    for (const e of l.edges) {
      const pts = sample(e.path)
      for (const n of l.nodes) {
        if (n.key === e.from || n.key === e.to) continue
        const inside = pts.some(([x, y]) => Math.abs(x - n.x) < n.w / 2 - 1 && Math.abs(y - n.y) < n.h / 2 - 1)
        expect(inside, `${e.id} passes through ${n.key}`).toBe(false)
      }
      // and stays inside the framed bounds
      for (const [x, y] of pts) expect(x >= l.bounds.x - 1 && x <= l.bounds.x + l.bounds.w + 1 && y >= l.bounds.y - 1 && y <= l.bounds.y + l.bounds.h + 1, `${e.id} leaves the frame`).toBe(true)
    }
  })
  it('keeps crossings to the two structural ones', () => {
    const l = layoutSystemMap(fullNodes, fullEdges)
    type Pt = [number, number]
    const segs = l.edges.map((e) => { const p = sample(e.path); return { e, ends: [p[0], p[p.length - 1]] as Pt[], s: p.slice(1).map((q, i) => [p[i], q] as const) } })
    /** the intersection point of two segments (touching counts), or null */
    const meet = (a: readonly [Pt, Pt], b: readonly [Pt, Pt]): Pt | null => {
      const [[x1, y1], [x2, y2]] = a; const [[x3, y3], [x4, y4]] = b
      const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
      if (Math.abs(den) < 1e-9) return null // parallel / collinear: shared lanes are checked by eye, not here
      const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
      const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den
      return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? [x1 + t * (x2 - x1), y1 + t * (y2 - y1)] : null
    }
    const nearPort = (p: Pt, ends: Pt[]) => ends.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 4)
    const found: string[] = []
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const A = segs[i]; const B = segs[j]
      const hit = A.s.some((sa) => B.s.some((sb) => { const m = meet(sa, sb); return Boolean(m && !nearPort(m, A.ends) && !nearPort(m, B.ends)) }))
      if (hit) found.push([A.e.id, B.e.id].sort().join(' × '))
    }
    expect(found.sort()).toEqual(['bridge__studio × seller__notifications', 'campaign__notifications × closing__pipeline'])
  })
})
