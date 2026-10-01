/**
 * Deterministic auto-layout contract — run with vitest.
 * Uses the REAL seller-inbound topology recorded from the observatory API.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { branchOf, layoutTopology } from './layout'
import type { Topology } from '../lib/types'

const FIX = path.resolve(process.cwd(), 'artifacts/workflow-studio-3/fixtures.json')
const topo: Topology | null = fs.existsSync(FIX) ? JSON.parse(fs.readFileSync(FIX, 'utf8')).responses['/api/cockpit/workflow-studio/observatory/workflows/seller_inbound?period=7d']?.topology ?? null : null

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w - 1 && Math.abs(a.y - b.y) * 2 < a.h + b.h - 1

describe.skipIf(!topo)('workflow layout', () => {
  const all = () => new Set(topo!.groups.map((g) => g.key))

  it('same input → same pixels, both directions', () => {
    for (const direction of ['LR', 'TB'] as const) {
      const a = layoutTopology(topo!, new Set(), { direction })
      const b = layoutTopology(topo!, new Set(), { direction })
      expect(a.nodes.map((n) => [n.key, n.x, n.y])).toEqual(b.nodes.map((n) => [n.key, n.x, n.y]))
      expect(a.edges.map((e) => e.path)).toEqual(b.edges.map((e) => e.path))
    }
  })

  it('no two nodes overlap — collapsed and fully expanded, LR and TB', () => {
    for (const direction of ['LR', 'TB'] as const) {
      for (const expanded of [new Set<string>(), all()]) {
        const l = layoutTopology(topo!, expanded, { direction })
        for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) expect(overlaps(l.nodes[i], l.nodes[j]), `${direction}: ${l.nodes[i].key} × ${l.nodes[j].key}`).toBe(false)
      }
    }
  })

  it('sections are contiguous bands in stage order that never overlap, and hold their members', () => {
    for (const direction of ['LR', 'TB'] as const) {
      const l = layoutTopology(topo!, all(), { direction })
      expect(l.sections.length).toBeGreaterThan(4)
      const lo = (s: (typeof l.sections)[number]) => (direction === 'LR' ? s.x : s.y)
      const hi = (s: (typeof l.sections)[number]) => (direction === 'LR' ? s.x + s.w : s.y + s.h)
      for (let i = 1; i < l.sections.length; i++) expect(lo(l.sections[i]), `${l.sections[i].key} after ${l.sections[i - 1].key}`).toBeGreaterThanOrEqual(hi(l.sections[i - 1]) - 0.5)
      for (const s of l.sections) for (const k of s.members) {
        const n = l.byKey.get(k)!
        const c = direction === 'LR' ? n.x : n.y
        expect(c).toBeGreaterThan(lo(s))
        expect(c).toBeLessThan(hi(s))
      }
      // every visible node belongs to exactly one section
      expect(new Set(l.sections.flatMap((s) => s.members)).size).toBe(l.nodes.length)
    }
  })

  it('progressive disclosure: a collapsed group is one node standing for its members', () => {
    const collapsed = layoutTopology(topo!, new Set())
    const expanded = layoutTopology(topo!, all())
    for (const g of topo!.groups) {
      expect(collapsed.byKey.has(`group:${g.key}`)).toBe(true)
      for (const m of topo!.nodes.filter((n) => n.group === g.key)) { expect(collapsed.owner.get(m.key)).toBe(`group:${g.key}`); expect(expanded.byKey.has(m.key)).toBe(true) }
    }
    expect(collapsed.nodes.length).toBeLessThan(expanded.nodes.length)
    for (const e of collapsed.edges) { expect(collapsed.byKey.has(e.from)).toBe(true); expect(collapsed.byKey.has(e.to)).toBe(true); expect(e.from).not.toBe(e.to) }
  })

  it('flow direction: forward edges never go backwards; human review before the spine, failures after it', () => {
    const l = layoutTopology(topo!, new Set())
    const trigger = l.nodes.find((n) => n.family === 'TRIGGER')!
    for (const n of l.nodes) expect(n.x).toBeGreaterThanOrEqual(trigger.x)
    for (const e of l.edges.filter((x) => !x.back)) expect(l.byKey.get(e.to)!.rank).toBeGreaterThanOrEqual(l.byKey.get(e.from)!.rank)
    const human = l.byKey.get('human_review')
    const failed = l.byKey.get('reply_failed')
    if (human) expect(human.y).toBeLessThan(0)
    if (failed) expect(failed.y).toBeGreaterThan(0)
  })

  it('focus branch keeps the node, its ancestors and descendants', () => {
    const l = layoutTopology(topo!, new Set())
    const b = branchOf(l, 'contactable_now')
    expect(b.has('contactable_now') && b.has('reply_received') && b.has('run_recorded')).toBe(true)
  })
})
