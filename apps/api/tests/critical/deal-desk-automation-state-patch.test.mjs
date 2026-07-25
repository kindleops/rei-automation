import test from 'node:test'
import assert from 'node:assert/strict'

import {
  UNIVERSAL_LEAD_STATE_PATCH_FIELDS,
  normalizePatchToCanonical,
} from '../../src/lib/domain/lead-state/universal-lead-state-registry.js'

test('automation_state is a canonical patchable field', () => {
  assert.ok(UNIVERSAL_LEAD_STATE_PATCH_FIELDS.includes('automation_state'))
  assert.ok(UNIVERSAL_LEAD_STATE_PATCH_FIELDS.includes('automation_status'))
})

test('normalizePatchToCanonical preserves automation pause fields', () => {
  const patch = normalizePatchToCanonical({
    automation_state: 'paused',
    automation_status: 'paused',
    paused_reason: 'manual_pause',
  })
  assert.equal(patch.automation_state, 'paused')
  assert.equal(patch.automation_status, 'paused')
  assert.equal(patch.paused_reason, 'manual_pause')
})

test('normalizePatchToCanonical does not map automation pause onto operational_status', () => {
  const patch = normalizePatchToCanonical({
    automation_state: 'paused',
  })
  assert.equal(patch.automation_state, 'paused')
  assert.equal(patch.operational_status, undefined)
})
