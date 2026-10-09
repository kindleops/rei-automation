// Run: node --experimental-strip-types --test apps/dashboard/src/modules/entity-graph/desk/desk-selection.node.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { DESK_SELECTION_KEY, entityIdsOf, mergeGridSelection, readDeskSelection, withScopeSelection, writeDeskSelection } from './desk-selection.ts'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
}

test('three properties picked in three different searches stay one selection', () => {
  let sel = new Set<string>()
  sel = mergeGridSelection(sel, ['property:227990249', 'property:111'], new Set(['property:227990249']))   // search 1
  sel = mergeGridSelection(sel, ['property:232476849', 'property:222'], new Set(['property:232476849']))   // search 2
  sel = mergeGridSelection(sel, ['property:232481638'], new Set(['property:232481638']))                   // filter run 3
  assert.deepEqual(entityIdsOf(sel), ['227990249', '232476849', '232481638'])
})

test("the grid's header checkbox / Cmd+A only governs the rows it shows", () => {
  const prev = new Set(['property:off-screen', 'property:a'])
  assert.deepEqual([...mergeGridSelection(prev, ['property:a', 'property:b'], new Set(['property:a', 'property:b']))].sort(), ['property:a', 'property:b', 'property:off-screen'])
  assert.deepEqual([...mergeGridSelection(prev, ['property:a', 'property:b'], new Set())], ['property:off-screen'], 'clearing the visible rows keeps the off-screen pick')
})

test('persists per scope; corrupt or foreign storage restores nothing rather than a guess', () => {
  const s = memory()
  writeDeskSelection(withScopeSelection({}, 'properties', new Set(['property:1', 'property:2'])), s)
  assert.deepEqual(readDeskSelection(s), { properties: ['property:1', 'property:2'] })
  assert.deepEqual(withScopeSelection({ properties: ['property:1'] }, 'properties', new Set()), {})
  s.setItem(DESK_SELECTION_KEY, '{not json')
  assert.deepEqual(readDeskSelection(s), {})
  s.setItem(DESK_SELECTION_KEY, JSON.stringify({ properties: [1, 'no-colon', 'property:9'] }))
  assert.deepEqual(readDeskSelection(s), { properties: ['property:9'] })
})
