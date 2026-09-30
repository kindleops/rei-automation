/**
 * Deterministic auto-layout contract (run: npx tsx --test src/views/workflow-studio/desktop/canvas/layout.test.ts).
 * Uses the REAL seller-inbound topology recorded from the observatory API.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { layoutTopology, branchOf } from './layout'
import type { Topology } from '../observatory-types'

const FIX = path.resolve(process.cwd(), 'artifacts/workflow-studio-3/fixtures.json')
const topo: Topology | null = fs.existsSync(FIX) ? JSON.parse(fs.readFileSync(FIX, 'utf8')).responses['/api/cockpit/workflow-studio/observatory/workflows/seller_inbound?period=7d']?.topology ?? null : null

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w - 1 && Math.abs(a.y - b.y) * 2 < a.h + b.h - 1

test('same input → same pixels', { skip: !topo }, () => {
  const a = layoutTopology(topo!, new Set())
  const b = layoutTopology(topo!, new Set())
  assert.deepEqual(a.nodes.map((n) => [n.key, n.x, n.y]), b.nodes.map((n) => [n.key, n.x, n.y]))
  assert.deepEqual(a.edges.map((e) => e.path), b.edges.map((e) => e.path))
})

test('no two nodes overlap — collapsed and fully expanded', { skip: !topo }, () => {
  for (const expanded of [new Set<string>(), new Set(topo!.groups.map((g) => g.key))]) {
    const l = layoutTopology(topo!, expanded)
    for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) assert.ok(!overlaps(l.nodes[i], l.nodes[j]), `${l.nodes[i].key} overlaps ${l.nodes[j].key}`)
  }
})

test('progressive disclosure: a collapsed group is one node standing for its members', { skip: !topo }, () => {
  const collapsed = layoutTopology(topo!, new Set())
  const expanded = layoutTopology(topo!, new Set(topo!.groups.map((g) => g.key)))
  for (const g of topo!.groups) {
    assert.ok(collapsed.byKey.has(`group:${g.key}`))
    const members = topo!.nodes.filter((n) => n.group === g.key)
    for (const m of members) { assert.equal(collapsed.owner.get(m.key), `group:${g.key}`); assert.ok(expanded.byKey.has(m.key)) }
  }
  assert.ok(collapsed.nodes.length < expanded.nodes.length)
  for (const e of collapsed.edges) { assert.ok(collapsed.byKey.has(e.from)); assert.ok(collapsed.byKey.has(e.to)); assert.notEqual(e.from, e.to) }
})

test('direction and lanes: left to right; human review above the spine, exceptions below', { skip: !topo }, () => {
  const l = layoutTopology(topo!, new Set())
  const trigger = l.nodes.find((n) => n.family === 'TRIGGER')!
  for (const n of l.nodes) assert.ok(n.x >= trigger.x)
  for (const e of l.edges.filter((x) => !x.back)) assert.ok(l.byKey.get(e.to)!.rank >= l.byKey.get(e.from)!.rank)
  const human = l.byKey.get('human_review')
  const failed = l.byKey.get('reply_failed')
  if (human) assert.ok(human.y < 0, 'human review sits above the primary path')
  if (failed) assert.ok(failed.y > 0, 'failures sit below it')
})

test('focus branch keeps the node, its ancestors and descendants', { skip: !topo }, () => {
  const l = layoutTopology(topo!, new Set())
  const b = branchOf(l, 'contactable_now')
  assert.ok(b.has('contactable_now') && b.has('reply_received') && b.has('run_recorded'))
})
