/**
 * N.2 — what a failed control write shows the operator, and what it must never show.
 *
 * Covers three defects found while wiring, each of which had already reached this branch:
 *   1. the operator-facing message was the RAW server reason code, or the transport's own
 *      diagnostic string — which embeds the request URL, and the thread key in that URL is
 *      the seller's phone number;
 *   2. the message table was indexed with `MAP[key]`, so `constructor` returned the
 *      `Object` function through the prototype chain, typed as a string;
 *   3. a rollback after a successful write restored the pre-success row instead of the
 *      value the server had just confirmed.
 *
 * (3) is a property of `useCanonicalControlMutations`' overlay reducer and is asserted here
 * against the source, because the hook has no headless harness on this branch. The browser
 * spec exercises it end to end.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { describeControlFailure } from '../../src/modules/inbox/useCanonicalControlMutation'

const HOOK_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/modules/inbox/useCanonicalControlMutation.ts', import.meta.url)),
  'utf8',
)
const BAR_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/modules/inbox/components/ThreadStateBar.tsx', import.meta.url)),
  'utf8',
)

// ── 1. every refusal is localised and identifier-free ────────────────────────

const SERVER_REASONS = [
  'automation_resume_blocked_suppressed',
  'automation_resume_blocked_archived',
  'automation_resume_blocked_closed',
  'automation_resume_blocked_contactability',
  'automation_resume_blocked_execution_off',
  'automation_resume_blocked_execution_completed',
  'manual_stage_lock_blocked_stage_write',
  'invalid_canonical_thread_key',
  'no_allowed_patch_fields',
]

test('every server refusal resolves to an operator-safe sentence', () => {
  for (const code of SERVER_REASONS) {
    const message = describeControlFailure(code)
    assert.ok(message.length > 0, code)
    assert.match(message, /[.!]$/, `${code} must read as a sentence, not an identifier`)
    assert.doesNotMatch(message, /_/, `${code} leaked a snake_case identifier`)
    assert.doesNotMatch(message, /https?:/, `${code} leaked a URL`)
    assert.doesNotMatch(message, /\+1\d{10}/, `${code} leaked a phone number`)
  }
})

test('the raw reason code is never echoed back as the message', () => {
  for (const code of SERVER_REASONS) {
    assert.notEqual(describeControlFailure(code), code)
    assert.notEqual(describeControlFailure(code, code), code,
      'a fallback that is itself an identifier must not be forwarded')
  }
})

test('a transport diagnostic is never forwarded to the operator', () => {
  // This is the real shape of `BackendClientError.message`.
  const diagnostic =
    '[400] no_allowed_patch_fields — https://api.example.com/api/cockpit/lead-state/patch'
    + ' (body: {"thread_key":"+19015551234"})'
  const rendered = describeControlFailure(undefined, diagnostic)
  assert.doesNotMatch(rendered, /https?:/)
  assert.doesNotMatch(rendered, /\+1\d{10}/)
  assert.doesNotMatch(rendered, /\(body:/)
  assert.equal(rendered, 'The change could not be saved.')
})

test('a genuine operator-facing fallback is preserved', () => {
  const message = 'Automation cannot resume while this conversation is suppressed.'
  assert.equal(describeControlFailure(undefined, message), message)
})

test('an unknown reason falls back to a neutral sentence', () => {
  assert.equal(describeControlFailure('mystery_code'), 'The change could not be saved.')
  assert.equal(describeControlFailure(null), 'The change could not be saved.')
  assert.equal(describeControlFailure(undefined), 'The change could not be saved.')
  assert.equal(describeControlFailure(''), 'The change could not be saved.')
})

// ── 2. the lookup cannot reach the prototype chain ───────────────────────────

test('prototype keys cannot escape the message table', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    const rendered = describeControlFailure(key)
    assert.equal(typeof rendered, 'string', `${key} returned a non-string`)
    assert.equal(rendered, 'The change could not be saved.', key)
  }
})

test('the message table is read through an own-property check', () => {
  assert.match(
    HOOK_SOURCE,
    /Object\.prototype\.hasOwnProperty\.call\(SERVER_REASON_MESSAGES/,
    'a bare MAP[key] index would return Object.prototype members as if they were messages',
  )
})

// ── 3. a rollback restores the last confirmed value ──────────────────────────

test('a failed overlay carries the rollback target forward from a confirmed one', () => {
  assert.match(HOOK_SOURCE, /rollbackValue: rollbackValueOf\(existing, lastConfirmedRef\.current\[key\]\)/,
    'the failure branch must inherit the rollback target rather than drop it')
  assert.match(HOOK_SOURCE, /existing\?\.kind === 'confirmed'\) return existing\.persistedValue/,
    'the target is the last SERVER-confirmed value, not the pre-success row')
})

test('the rollback baseline survives the confirmed overlay retiring', () => {
  // The confirmed overlay retires as soon as the authoritative row agrees with it. A stale
  // list read can then flip the row back, so the last confirmed value is remembered
  // separately or a later failure would roll back to a value the server no longer holds.
  assert.match(HOOK_SOURCE, /lastConfirmedRef\.current\[key\] = persisted/)
  assert.match(HOOK_SOURCE, /return lastConfirmed/)
})

test('the rollback baseline is scoped to one conversation', () => {
  // The key is `${scope}::${field}` and `scope` is the canonical selection key, so a
  // remembered value can never be applied to a different thread.
  assert.match(HOOK_SOURCE, /const overlayKey = \(scope: string, field: string\): string => `\$\{scope\}::\$\{field\}`/)
})

test('a rollback target retires as soon as the authoritative row changes', () => {
  assert.match(HOOK_SOURCE, /rollbackStillApplies/,
    'without this the target would mask every later server-side change to the field')
  assert.match(HOOK_SOURCE, /overlay\.serverValueAtStart === serverValue/)
})

// ── 4. the portal dropdown survives a real mouse ─────────────────────────────

test('the outside-click handler ignores mousedown inside the portal menu', () => {
  // The menu is a portal into document.body, so an option is outside the trigger button.
  // Closing on mousedown unmounted the option before its click could fire — every option
  // was unselectable with a real mouse and the stage confirm dialog never opened.
  assert.match(BAR_SOURCE, /menuRef\.current\?\.contains\(event\.target as Node\)\) return/)
  assert.match(BAR_SOURCE, /ref=\{menuRef\}/)
  const menuRefBeforeHandler = BAR_SOURCE.indexOf('const menuRef')
  const handler = BAR_SOURCE.indexOf('menuRef.current?.contains')
  assert.ok(menuRefBeforeHandler >= 0 && handler > menuRefBeforeHandler)
})
