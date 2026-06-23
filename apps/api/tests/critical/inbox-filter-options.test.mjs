import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildInboxFilterConditions,
  resolveOptionsFieldSpec,
  collectPreserveValues,
} from '../../src/lib/domain/inbox/inbox-filter-conditions.js'

test('resolveOptionsFieldSpec maps catalog keys to hydrated columns', () => {
  assert.equal(resolveOptionsFieldSpec('states').column, 'state')
  assert.equal(resolveOptionsFieldSpec('markets').column, 'market')
  assert.equal(resolveOptionsFieldSpec('building_conditions').column, 'building_condition')
  assert.equal(resolveOptionsFieldSpec('propertyFlags').kind, 'property_flags')
})

test('buildInboxFilterConditions excludes faceted field columns', () => {
  const conditions = buildInboxFilterConditions(
    { market: 'Phoenix', state: 'AZ', filter: 'all_messages' },
    { excludeFieldKeys: ['state'], excludeColumns: ['state'] },
  )
  assert.ok(conditions.some((c) => c.op === 'eq' && c.column === 'market' && c.value === 'Phoenix'))
  assert.ok(!conditions.some((c) => c.column === 'state'))
})

test('collectPreserveValues keeps selected categorical values', () => {
  const spec = resolveOptionsFieldSpec('states')
  const preserved = collectPreserveValues({ state: 'WY' }, spec)
  assert.deepEqual(preserved, ['WY'])
})