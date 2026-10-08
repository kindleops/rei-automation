// Run: node --experimental-strip-types --test apps/dashboard/src/domain/entity-graph/entity-graph-selection.node.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_SELECTION,
  addRows,
  addConfirmedCohort,
  removeRows,
  toggleRow,
  selectedIds,
  toCampaignTargetFilter,
  toPreviewSelectionPayload,
  serializeSelection,
  deserializeSelection,
} from './entity-graph-selection.ts'

test('accumulates rows across pages and filter runs without duplicates', () => {
  let s = addRows(EMPTY_SELECTION, [{ propertyId: '227990249' }, { propertyId: '232476849' }]) // page 1, filter A
  s = addRows(s, [{ propertyId: '232476849' }, { propertyId: '232481638' }])                     // page 2 / filter B
  assert.deepEqual(selectedIds(s), ['227990249', '232476849', '232481638'])
})

test('toggle and remove only touch the named rows', () => {
  let s = addRows(EMPTY_SELECTION, [{ propertyId: 'a' }, { propertyId: 'b' }])
  s = toggleRow(s, { propertyId: 'a' })
  assert.deepEqual(selectedIds(s), ['b'])
  s = toggleRow(s, { propertyId: 'c' })
  s = removeRows(s, ['b'])
  assert.deepEqual(selectedIds(s), ['c'])
})

test('whole cohort requires the confirmed count to match; nothing added otherwise', () => {
  const s = addConfirmedCohort(EMPTY_SELECTION, { cohortKey: 'q1', cohortIds: ['x', 'y', 'z'], confirmedCount: 3, now: 't' })
  assert.deepEqual(selectedIds(s), ['x', 'y', 'z'])
  assert.throws(() => addConfirmedCohort(EMPTY_SELECTION, { cohortKey: 'q1', cohortIds: ['x', 'y', 'z', 'w'], confirmedCount: 3 }), /cohort_count_changed/)
})

test('the payload and target filter contain exactly the selection', () => {
  const s = addRows(EMPTY_SELECTION, [{ propertyId: '227990249' }, { propertyId: '232476849' }, { propertyId: '232481638' }])
  assert.deepEqual(toPreviewSelectionPayload(s), { property_ids: ['227990249', '232476849', '232481638'] })
  assert.deepEqual(toCampaignTargetFilter(s), { field_key: 'properties.property_id', operator: 'in', value: ['227990249', '232476849', '232481638'] })
})

test('persistence round-trips; corrupt storage restores an empty selection, never a guess', () => {
  const s = addRows(EMPTY_SELECTION, [{ propertyId: 'a', label: 'A' }])
  assert.deepEqual(deserializeSelection(serializeSelection(s)), s)
  assert.deepEqual(deserializeSelection('{not json'), EMPTY_SELECTION)
  assert.deepEqual(deserializeSelection(JSON.stringify({ version: 9, items: [{ propertyId: 'a' }] })), EMPTY_SELECTION)
})
