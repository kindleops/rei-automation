/**
 * N.1 — canonical thread-reference contract.
 *
 * Covers DD-003: reads and writes must resolve thread identity through one contract, a
 * UUID/composite key must never reach phone validation, and a missing writable contact
 * route must produce an explicit typed result rather than a silent fallback.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeThreadReference,
  extractCanonicalPhoneFromCompositeKey,
  isSameCanonicalThread,
  isServerWritableThreadKey,
  isUuidLikeIdentity,
  normalizeCanonicalE164,
  resolveCanonicalThreadReference,
  resolveDialablePhoneFromThread,
  resolveWritableThreadKey,
  rowMatchesThreadReference,
} from '../../src/domain/inbox/canonical-thread-reference.ts'

const UUID = '550e8400-e29b-41d4-a716-446655440000'
const COMPOSITE = 'ct:prospect:p-1|property:prop-9|phone:+19015551234'

// ── phone normalization: exactly one place, and it refuses non-phones ────────

test('normalizeCanonicalE164 accepts the three real US phone shapes', () => {
  assert.equal(normalizeCanonicalE164('+19015551234'), '+19015551234')
  assert.equal(normalizeCanonicalE164('9015551234'), '+19015551234')
  assert.equal(normalizeCanonicalE164('19015551234'), '+19015551234')
  assert.equal(normalizeCanonicalE164('(901) 555-1234'), '+19015551234')
  assert.equal(normalizeCanonicalE164('901.555.1234'), '+19015551234')
})

test('normalizeCanonicalE164 never reinterprets a UUID as a phone number', () => {
  assert.equal(normalizeCanonicalE164(UUID), null)
  // A UUID stripped of punctuation is a 32-char digit/hex run — must not survive.
  assert.equal(normalizeCanonicalE164('11111111-2222-3333-4444-555555555555'), null)
})

test('normalizeCanonicalE164 refuses composite and synthetic identifiers', () => {
  assert.equal(normalizeCanonicalE164(COMPOSITE), null)
  assert.equal(normalizeCanonicalE164('property:prop-9'), null)
  assert.equal(normalizeCanonicalE164('owner:9015551234'), null)
  assert.equal(normalizeCanonicalE164('prospect:abc'), null)
})

test('normalizeCanonicalE164 refuses digit runs that are not US numbers', () => {
  assert.equal(normalizeCanonicalE164('12345'), null)
  assert.equal(normalizeCanonicalE164('449015551234'), null)
  assert.equal(normalizeCanonicalE164(''), null)
  assert.equal(normalizeCanonicalE164(null), null)
})

test('isServerWritableThreadKey mirrors the server /^\\+1\\d{10}$/ guard', () => {
  assert.equal(isServerWritableThreadKey('+19015551234'), true)
  assert.equal(isServerWritableThreadKey('9015551234'), false)
  assert.equal(isServerWritableThreadKey(UUID), false)
  assert.equal(isServerWritableThreadKey(COMPOSITE), false)
})

test('isUuidLikeIdentity identifies row ids', () => {
  assert.equal(isUuidLikeIdentity(UUID), true)
  assert.equal(isUuidLikeIdentity('+19015551234'), false)
})

// ── composite key handling ───────────────────────────────────────────────────

test('extractCanonicalPhoneFromCompositeKey pulls the phone segment only', () => {
  assert.equal(extractCanonicalPhoneFromCompositeKey(COMPOSITE), '+19015551234')
  assert.equal(
    extractCanonicalPhoneFromCompositeKey('ct:prospect:p-1|property:prop-9'),
    null,
    'a composite with no phone segment must not invent one',
  )
  assert.equal(extractCanonicalPhoneFromCompositeKey('ct:property:prop-9'), null)
})

// ── reference resolution ─────────────────────────────────────────────────────

test('resolveCanonicalThreadReference keeps threadId and canonicalE164 distinct', () => {
  const reference = resolveCanonicalThreadReference({
    id: UUID,
    canonicalE164: '+19015551234',
    propertyId: 'prop-9',
  })
  assert.ok(reference)
  assert.equal(reference.threadId, UUID)
  assert.equal(reference.canonicalE164, '+19015551234')
  assert.equal(reference.selectionKey, UUID)
  assert.equal(reference.source, 'thread_id')
  assert.equal(reference.writable, true)
  assert.equal(reference.reason, undefined)
})

test('a composite conversation id becomes the selection key, not the thread id', () => {
  const reference = resolveCanonicalThreadReference({
    id: UUID,
    threadKey: COMPOSITE,
    canonical_e164: '+19015551234',
  })
  assert.ok(reference)
  assert.equal(reference.conversationId, COMPOSITE)
  assert.equal(reference.selectionKey, COMPOSITE)
  assert.equal(reference.source, 'conversation_id')
  assert.equal(reference.threadId, UUID, 'row identity stays the row identity')
  assert.equal(reference.writable, true)
})

test('an injected composite conversation id is adopted; a bare fallback is not', () => {
  const withComposite = resolveCanonicalThreadReference(
    { id: UUID, canonicalE164: '+19015551234' },
    { conversationId: COMPOSITE },
  )
  assert.equal(withComposite?.selectionKey, COMPOSITE)
  assert.equal(withComposite?.source, 'conversation_id')

  // `buildConversationThreadIdFromRecord` falls back to `threadKey || id` when a row has
  // no linkable parts. That fallback is a row identity and must not be relabelled.
  const withBareFallback = resolveCanonicalThreadReference(
    { id: UUID, canonicalE164: '+19015551234' },
    { conversationId: UUID },
  )
  assert.equal(withBareFallback?.selectionKey, UUID)
  assert.equal(withBareFallback?.source, 'thread_id')
  assert.equal(withBareFallback?.conversationId, null)
})

test('selection key stays byte-compatible with the pre-existing cache key', () => {
  // Legacy key was `conversationThreadId || threadKey || id`.
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ conversationThreadId: COMPOSITE, threadKey: '+19015551234', id: UUID }, COMPOSITE],
    [{ threadKey: '+19015551234', id: UUID }, '+19015551234'],
    [{ id: UUID }, UUID],
  ]
  for (const [thread, expected] of cases) {
    assert.equal(resolveCanonicalThreadReference(thread)?.selectionKey, expected)
  }
})

test('missing canonical phone yields an explicit unwritable reference, not a guess', () => {
  const reference = resolveCanonicalThreadReference({ id: UUID, propertyId: 'prop-9' })
  assert.ok(reference)
  assert.equal(reference.canonicalE164, null, 'no phone must be fabricated')
  assert.equal(reference.writable, false)
  assert.equal(reference.reason, 'no_canonical_phone')
})

test('a synthetic property key never becomes a phone or a writable key', () => {
  const reference = resolveCanonicalThreadReference({
    id: 'property:prop-9',
    threadKey: 'property:prop-9',
  })
  assert.ok(reference)
  assert.equal(reference.canonicalE164, null)
  assert.equal(reference.writable, false)
  assert.equal(reference.reason, 'no_canonical_phone')
})

test('resolveCanonicalThreadReference returns null when there is no identity at all', () => {
  assert.equal(resolveCanonicalThreadReference({}), null)
  assert.equal(resolveCanonicalThreadReference(null), null)
  assert.equal(resolveCanonicalThreadReference({ propertyId: '', id: '  ' }), null)
})

test('a phone-only stub resolves with source canonical_e164', () => {
  const reference = resolveCanonicalThreadReference({ phoneNumber: '9015551234' })
  assert.ok(reference)
  assert.equal(reference.source, 'canonical_e164')
  assert.equal(reference.selectionKey, '+19015551234')
  assert.equal(reference.writable, true)
})

// ── write-key resolution ─────────────────────────────────────────────────────

test('resolveWritableThreadKey only ever returns a server-writable E.164', () => {
  const ok = resolveWritableThreadKey({ id: UUID, canonicalE164: '(901) 555-1234' })
  assert.ok(ok)
  assert.equal(ok.ok, true)
  assert.equal(ok.ok === true && ok.threadKey, '+19015551234')
})

test('resolveWritableThreadKey fails loudly instead of sending a UUID', () => {
  const result = resolveWritableThreadKey({ id: UUID })
  assert.ok(result)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'no_canonical_phone')
  // The UUID is still available for diagnostics but is never offered as a thread key.
  assert.equal(result.reference.threadId, UUID)
})

test('resolveWritableThreadKey fails loudly instead of sending a composite key', () => {
  const result = resolveWritableThreadKey({ id: UUID, threadKey: 'ct:property:prop-9' })
  assert.ok(result)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'no_canonical_phone')
})

test('a composite key carrying a phone segment IS writable, via that segment', () => {
  const result = resolveWritableThreadKey({ id: UUID, threadKey: COMPOSITE })
  assert.ok(result)
  assert.equal(result.ok, true)
  assert.equal(result.ok === true && result.threadKey, '+19015551234')
})

// ── phone-field precedence ───────────────────────────────────────────────────

test('resolveDialablePhoneFromThread prefers explicit phone fields over identity fields', () => {
  assert.equal(
    resolveDialablePhoneFromThread({
      canonicalE164: '+19015551234',
      threadKey: '+14045559999',
    }),
    '+19015551234',
  )
  assert.equal(resolveDialablePhoneFromThread({ id: UUID }), null)
})

// ── identity comparison / list reconciliation ────────────────────────────────

test('isSameCanonicalThread matches a refreshed row object with the same identity', () => {
  const before = resolveCanonicalThreadReference({ id: UUID, canonicalE164: '+19015551234' })
  const afterRefresh = resolveCanonicalThreadReference({
    id: UUID,
    canonicalE164: '+19015551234',
    unreadCount: 3,
  })
  assert.equal(isSameCanonicalThread(before, afterRefresh), true)
})

test('isSameCanonicalThread does not match a different conversation', () => {
  const a = resolveCanonicalThreadReference({ id: UUID, canonicalE164: '+19015551234' })
  const b = resolveCanonicalThreadReference({
    id: '11111111-2222-3333-4444-555555555555',
    canonicalE164: '+14045559999',
  })
  assert.equal(isSameCanonicalThread(a, b), false)
})

test('rowMatchesThreadReference reconciles by identity, not object reference', () => {
  const reference = resolveCanonicalThreadReference({ id: UUID, canonicalE164: '+19015551234' })
  assert.equal(rowMatchesThreadReference({ id: UUID, canonicalE164: '+19015551234' }, reference), true)
  assert.equal(rowMatchesThreadReference({ id: 'other' }, reference), false)
  assert.equal(rowMatchesThreadReference({ id: UUID }, null), false)
})

test('describeThreadReference never leaks an unwritable key as if it were usable', () => {
  const reference = resolveCanonicalThreadReference({ id: UUID })
  const described = describeThreadReference(reference)
  assert.match(described, /writable=false/)
  assert.match(described, /reason=no_canonical_phone/)
  assert.match(described, /phone=none/)
})

test('describeThreadReference never emits a full phone number', () => {
  const reference = resolveCanonicalThreadReference({ id: UUID, canonicalE164: '+19015551234' })
  const described = describeThreadReference(reference)
  assert.equal(
    described.includes('+19015551234'),
    false,
    'a diagnostic can reach a log sink or telemetry payload — it must not carry a phone',
  )
  assert.match(described, /phone=\+1\*+1234/, 'masked, but still useful for correlation')
})

test('describeThreadReference masks a phone embedded in the selection key too', () => {
  // A bare E.164 selection key would otherwise leak the number through `key=`.
  const phoneKeyed = resolveCanonicalThreadReference({ phoneNumber: '9015551234' })
  const describedPhoneKey = describeThreadReference(phoneKeyed)
  assert.equal(describedPhoneKey.includes('+19015551234'), false)

  // …and so would a composite key carrying a phone segment.
  const compositeKeyed = resolveCanonicalThreadReference({ id: 'x', threadKey: COMPOSITE })
  const describedComposite = describeThreadReference(compositeKeyed)
  assert.equal(describedComposite.includes('+19015551234'), false)
  assert.match(describedComposite, /key=ct:prospect:p-1\|property:prop-9\|phone:\+1\*+1234/)
})
