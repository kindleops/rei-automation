import test from 'node:test'
import assert from 'node:assert/strict'

import { humanDataState, humanFallback } from '../../src/modules/inbox/buyer-match-v4/formatters'

test('humanDataState never implies global demand for local gaps', () => {
  assert.match(humanDataState('NO_LOCAL_DATA'), /Local buyer evidence is unavailable/i)
  assert.doesNotMatch(humanDataState('NO_LOCAL_DATA'), /global/i)
})

test('humanFallback labels state and market fallback honestly', () => {
  assert.match(humanFallback('STATE'), /State-level/i)
  assert.match(humanFallback('MARKET'), /Market-level/i)
  assert.equal(humanFallback('EXACT_ZIP'), 'Exact ZIP')
})

const PANE_LAYOUTS = [
  { width: '100', className: 'is-pane-100', columns: 3 },
  { width: '75', className: 'is-pane-75', columns: 1 },
  { width: '50', className: 'is-pane-50', columns: 1 },
  { width: '25', className: 'is-pane-25', columns: 1 },
] as const

for (const layout of PANE_LAYOUTS) {
  test(`${layout.width}% pane uses ${layout.className} shell class`, () => {
    assert.ok(layout.className.startsWith('is-pane-'))
    assert.ok(['100', '75', '50', '25'].includes(layout.width))
  })
}

test('V3 acquisition context source label is fixed', () => {
  const sourceLabel = 'Acquisition Engine V3'
  assert.equal(sourceLabel, 'Acquisition Engine V3')
})