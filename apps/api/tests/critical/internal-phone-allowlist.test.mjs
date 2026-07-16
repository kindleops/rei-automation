/**
 * internal-phone-allowlist.test.mjs
 *
 * Guards the internal test-phone allowlist and the internal_only inbound gate.
 * The live negotiation certification depends on:
 *   - the approved physical phone (+16124515970) being recognized in any format
 *   - the Stage 1 canary recipient (+16128072000) being recognized
 *   - the existing control phone (+16127433952) remaining allowlisted
 *   - a random non-internal number being blocked under internal_only
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isInternalTestPhone,
  INTERNAL_TEST_PHONE_SET,
} from '../../src/lib/config/internal-phones.js'
import { autoReplyModeAllowsQueue } from '../../src/lib/domain/seller-flow/auto-reply-mode.js'

const NEW_INTERNAL = '+16124515970'
const CANARY_INTERNAL = '+16128072000'
const EXISTING_INTERNAL = '+16127433952'
const RANDOM_NON_INTERNAL = '+14155550123'

test('all approved internal numbers are in INTERNAL_TEST_PHONE_SET', () => {
  assert.equal(INTERNAL_TEST_PHONE_SET.has(NEW_INTERNAL), true)
  assert.equal(INTERNAL_TEST_PHONE_SET.has(CANARY_INTERNAL), true)
  assert.equal(INTERNAL_TEST_PHONE_SET.has(EXISTING_INTERNAL), true)
})

test('+16128072000 is recognized in E.164, 10-digit, 11-digit, and formatted forms', () => {
  assert.equal(isInternalTestPhone('+16128072000'), true)
  assert.equal(isInternalTestPhone('6128072000'), true)
  assert.equal(isInternalTestPhone('16128072000'), true)
  assert.equal(isInternalTestPhone('(612) 807-2000'), true)
})

test('+16124515970 is recognized in E.164, 10-digit, 11-digit, and formatted forms', () => {
  assert.equal(isInternalTestPhone('+16124515970'), true) // E.164
  assert.equal(isInternalTestPhone('6124515970'), true) // 10-digit
  assert.equal(isInternalTestPhone('16124515970'), true) // 11-digit w/ country code
  assert.equal(isInternalTestPhone('(612) 451-5970'), true) // formatted
  assert.equal(isInternalTestPhone('612-451-5970'), true) // dashed
  assert.equal(isInternalTestPhone(' +1 612 451 5970 '), true) // spaced/padded
})

test('existing internal number +16127433952 stays allowlisted', () => {
  assert.equal(isInternalTestPhone('+16127433952'), true)
  assert.equal(isInternalTestPhone('6127433952'), true)
})

test('a random non-internal number is not an internal test phone', () => {
  assert.equal(isInternalTestPhone(RANDOM_NON_INTERNAL), false)
  assert.equal(isInternalTestPhone(null), false)
  assert.equal(isInternalTestPhone(''), false)
})

test('under internal_only, the canary internal number is allowed (internal_test_phone)', () => {
  const gate = autoReplyModeAllowsQueue({ mode: 'internal_only', inboundFrom: CANARY_INTERNAL })
  assert.equal(gate.allowed, true)
  assert.equal(gate.reason, 'internal_test_phone')
  assert.equal(gate.internal_test_phone, true)
})

test('under internal_only, the alternate internal number is allowed (internal_test_phone)', () => {
  const gate = autoReplyModeAllowsQueue({ mode: 'internal_only', inboundFrom: NEW_INTERNAL })
  assert.equal(gate.allowed, true)
  assert.equal(gate.reason, 'internal_test_phone')
  assert.equal(gate.internal_test_phone, true)
})

test('under internal_only, the existing internal number is allowed (internal_test_phone)', () => {
  const gate = autoReplyModeAllowsQueue({ mode: 'internal_only', inboundFrom: EXISTING_INTERNAL })
  assert.equal(gate.allowed, true)
  assert.equal(gate.reason, 'internal_test_phone')
})

test('under internal_only, a random non-internal number is blocked (internal_only_non_internal)', () => {
  const gate = autoReplyModeAllowsQueue({ mode: 'internal_only', inboundFrom: RANDOM_NON_INTERNAL })
  assert.equal(gate.allowed, false)
  assert.equal(gate.reason, 'internal_only_non_internal')
  assert.equal(gate.internal_test_phone, false)
})

test('internal_only gate also honors 10-digit and formatted inbound for the new number', () => {
  for (const form of ['6124515970', '(612) 451-5970', '612-451-5970']) {
    const gate = autoReplyModeAllowsQueue({ mode: 'internal_only', inboundFrom: form })
    assert.equal(gate.allowed, true, `expected ${form} to be allowed`)
    assert.equal(gate.reason, 'internal_test_phone')
  }
})
