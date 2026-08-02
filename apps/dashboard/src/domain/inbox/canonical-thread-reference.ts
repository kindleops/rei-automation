/**
 * Canonical Deal Desk thread reference — the single thread-identity contract.
 *
 * Audit background (docs/audits/DEAL_DESK_FRONTEND_RUNTIME_AUDIT.md):
 *   §B.3 / DD-003 — reads resolve a thread key through `resolveCanonicalThreadStateKey`
 *   (phone-first) while writes resolve it through `toThreadKey` (`thread.threadKey ||
 *   thread.id || owner:prop:phone`, `inboxWorkflowData.ts:286-289`). The server's write
 *   guard is `isCanonicalThreadKey = /^\+1\d{10}$/` (`cockpit-service.js:27-31`), so any
 *   thread whose `threadKey` is a `ct:…` composite or a UUID is silently unwritable.
 *
 * This module replaces both resolvers with one structured contract. It deliberately does
 * NOT widen or narrow suppression scope, participant identity, or the server's thread-key
 * schema — those are N.2 / N.4 concerns. It only makes the identity that already exists
 * explicit and non-substitutable.
 *
 * Hard rules enforced here:
 *   - `threadId` is an opaque client row identity. It is never phone-validated and never
 *     substituted for a contact route.
 *   - `canonicalE164` is a dialable phone. It is never assumed to be the row identity.
 *   - A UUID or a composite (`ct:…`, `property:…`) identifier is never fed through phone
 *     normalization or phone validation.
 *   - Phone normalization happens in exactly one function: `normalizeCanonicalE164`.
 *   - A missing writable contact route produces an explicit typed result, never a
 *     fabricated phone number and never a silent fallback to an unrelated identifier.
 *
 * This module is intentionally dependency-free so it can be unit-tested under
 * `node --test` without pulling in the Supabase client. Application code must call
 * `resolveDealDeskThreadReference` (see `deal-desk-thread-reference.ts`), which injects
 * the repository's existing composite conversation-id builder.
 */

/** Which identifier the stable selection key was derived from. */
export type CanonicalThreadReferenceSource = 'conversation_id' | 'thread_id' | 'canonical_e164'

/** Why a reference cannot be used as a server thread-state write key. */
export type ThreadReferenceUnwritableReason =
  | 'no_canonical_phone'
  | 'phone_not_server_writable'

export interface CanonicalThreadReference {
  /**
   * Opaque client row identity. Never phone-validated, never sent as a write key.
   * When a row carries no id at all this mirrors `selectionKey`; `source` records which
   * kind of identifier that actually was.
   */
  threadId: string
  /** Dialable seller phone in +1XXXXXXXXXX form, or null when none is known. */
  canonicalE164: string | null
  /** Composite conversation identity (`ct:prospect:…|property:…|phone:…`), or null. */
  conversationId: string | null
  /**
   * The one key every Deal Desk panel, cache and effect derives from. Stable across list
   * refreshes, realtime patches and bucket switches for the same underlying conversation.
   *
   * Byte-compatible with the pre-existing message-cache key
   * (`conversationThreadId || threadKey || id`) so existing caches keep hitting.
   */
  selectionKey: string
  source: CanonicalThreadReferenceSource
  /** True iff `canonicalE164` satisfies the server's thread-state write guard. */
  writable: boolean
  reason?: ThreadReferenceUnwritableReason
}

export type WritableThreadKeyResult =
  | { ok: true; threadKey: string; reference: CanonicalThreadReference }
  | { ok: false; reason: ThreadReferenceUnwritableReason; reference: CanonicalThreadReference }

/**
 * Mirror of the server guard at `apps/api/src/lib/cockpit/cockpit-service.js:27-31`
 * (duplicated at `patch-universal-lead-state.js:255`). Kept as a literal so a drift
 * between client and server is a visible one-line diff.
 */
const SERVER_THREAD_KEY_RE = /^\+1\d{10}$/

/** Identifiers that name a non-phone entity. Never phone-normalized. */
const SYNTHETIC_THREAD_IDENTITY_RE = /^(property|owner|lead|prospect|campaign|ct):/i

/** Canonical UUID shape — a thread `id` in the live inbox is frequently one of these. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const asTrimmedString = (value: unknown): string => String(value ?? '').trim()

export const isSyntheticThreadIdentity = (value: unknown): boolean => {
  const raw = asTrimmedString(value)
  return Boolean(raw) && SYNTHETIC_THREAD_IDENTITY_RE.test(raw)
}

export const isUuidLikeIdentity = (value: unknown): boolean => UUID_RE.test(asTrimmedString(value))

/** True iff the value is a composite/structured identifier rather than a scalar identity. */
export const isCompositeThreadIdentity = (value: unknown): boolean => {
  const raw = asTrimmedString(value)
  if (!raw) return false
  return raw.includes('|') || isSyntheticThreadIdentity(raw)
}

/**
 * The ONE phone normalization point for Deal Desk.
 *
 * Returns a `+1XXXXXXXXXX` string or null. Explicitly refuses:
 *   - synthetic/composite identifiers (`property:…`, `ct:…|…`)
 *   - UUIDs (their digit runs must never be reinterpreted as a phone)
 *   - any digit run that is not a US 10-digit or 1+10-digit number
 */
export const normalizeCanonicalE164 = (value: unknown): string | null => {
  const raw = asTrimmedString(value)
  if (!raw) return null
  if (isCompositeThreadIdentity(raw)) return null
  if (isUuidLikeIdentity(raw)) return null
  if (SERVER_THREAD_KEY_RE.test(raw)) return raw
  // Reject anything carrying non-phone characters before touching the digits, so a UUID
  // or a slug can never have its digit run reinterpreted as a phone number.
  if (/[^\d\s()+.\-]/.test(raw)) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

/** Server-side write guard, mirrored. Only ever applied to an already-normalized phone. */
export const isServerWritableThreadKey = (value: unknown): boolean =>
  SERVER_THREAD_KEY_RE.test(asTrimmedString(value))

/**
 * Pull the phone segment out of a composite conversation identity.
 * `ct:prospect:abc|property:def|phone:+19015551234` → `+19015551234`.
 * Never invents a phone: returns null when the composite carries none.
 */
export const extractCanonicalPhoneFromCompositeKey = (value: unknown): string | null => {
  const raw = asTrimmedString(value)
  if (!raw) return null
  const segment = raw.match(/(?:^|[|:])phone:(\+?1?\d{10,11})(?:$|\|)/i)?.[1]
  if (!segment) return null
  // The extracted segment is a phone by construction — normalize it through the one point.
  return normalizeCanonicalE164(segment)
}

/** Loose record shape — Deal Desk threads arrive in camelCase and snake_case forms. */
export type ThreadIdentityInput = Record<string, unknown> | null | undefined

export interface ResolveThreadReferenceOptions {
  /**
   * Composite conversation identity computed by the repository's existing builder
   * (`buildConversationThreadIdFromRecord`). Injected rather than reimplemented so this
   * module does not become a sixth independent identity implementation.
   */
  conversationId?: string | null
}

/** Fields that genuinely hold a dialable phone. Ordered most- to least-authoritative. */
const PHONE_FIELD_CANDIDATES = [
  'canonicalE164',
  'canonical_e164',
  'sellerPhone',
  'seller_phone',
  'bestPhone',
  'best_phone',
  'phoneNumber',
  'phone_number',
  'phone',
  'displayPhone',
  'display_phone',
  'prospectBestPhone',
  'prospect_best_phone',
  'normalizedPhone',
  'normalized_phone',
] as const

/** Fields that hold an explicit composite conversation identity. */
const CONVERSATION_ID_CANDIDATES = [
  'conversationThreadId',
  'conversation_thread_id',
  'conversationId',
  'conversation_id',
] as const

const firstNonEmpty = (thread: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) {
    const candidate = asTrimmedString(thread[key])
    if (candidate) return candidate
  }
  return ''
}

/**
 * Resolve the dialable phone for a thread.
 *
 * Explicit phone fields first; only then the composite conversation id / thread key, and
 * only via `phone:` segment extraction or a bare E.164 string (which is the current
 * server thread identity, DD-012). A UUID or `property:*` key produces null, not a guess.
 */
export const resolveDialablePhoneFromThread = (thread: ThreadIdentityInput): string | null => {
  if (!thread) return null
  for (const key of PHONE_FIELD_CANDIDATES) {
    const resolved = normalizeCanonicalE164(thread[key])
    if (resolved) return resolved
  }
  for (const key of [...CONVERSATION_ID_CANDIDATES, 'threadKey', 'thread_key']) {
    const raw = thread[key]
    const fromComposite = extractCanonicalPhoneFromCompositeKey(raw)
    if (fromComposite) return fromComposite
    const direct = normalizeCanonicalE164(raw)
    if (direct) return direct
  }
  return null
}

/**
 * Resolve the one canonical reference for a thread-shaped record.
 *
 * Returns null only when the record carries no usable identity at all — callers must
 * treat that as "no selection", never as an empty-string key.
 */
export const resolveCanonicalThreadReference = (
  thread: ThreadIdentityInput,
  options: ResolveThreadReferenceOptions = {},
): CanonicalThreadReference | null => {
  if (!thread) return null
  const record = thread as Record<string, unknown>

  const canonicalE164 = resolveDialablePhoneFromThread(record)

  const rawThreadKey = asTrimmedString(record.threadKey ?? record.thread_key)
  const explicitConversationId = firstNonEmpty(record, CONVERSATION_ID_CANDIDATES)
  const injectedConversationId = asTrimmedString(options.conversationId)

  // Only a composite/explicit value is a conversation identity. The repository's builder
  // falls back to `threadKey || id` when a row has no linkable parts; that fallback is a
  // row identity, not a conversation identity, and must not be relabelled as one.
  const conversationId =
    explicitConversationId ||
    (isCompositeThreadIdentity(injectedConversationId) ? injectedConversationId : '') ||
    (isCompositeThreadIdentity(rawThreadKey) ? rawThreadKey : '')

  // Row identity precedence mirrors the pre-existing cache key (`threadKey || id`) so the
  // resulting `selectionKey` stays byte-compatible with already-warm caches.
  const threadIdCandidate =
    (isCompositeThreadIdentity(rawThreadKey) ? '' : rawThreadKey) ||
    firstNonEmpty(record, ['id', 'threadId', 'thread_id'])

  let selectionKey = ''
  let source: CanonicalThreadReferenceSource = 'thread_id'
  if (conversationId) {
    selectionKey = conversationId
    source = 'conversation_id'
  } else if (threadIdCandidate) {
    selectionKey = threadIdCandidate
    source = 'thread_id'
  } else if (canonicalE164) {
    selectionKey = canonicalE164
    source = 'canonical_e164'
  }

  if (!selectionKey) return null

  const threadId = threadIdCandidate || selectionKey

  const writable = Boolean(canonicalE164) && isServerWritableThreadKey(canonicalE164)
  const reason: ThreadReferenceUnwritableReason | undefined = writable
    ? undefined
    : canonicalE164
      ? 'phone_not_server_writable'
      : 'no_canonical_phone'

  return {
    threadId,
    canonicalE164,
    conversationId: conversationId || null,
    selectionKey,
    source,
    writable,
    ...(reason ? { reason } : {}),
  }
}

/**
 * Resolve the key a server thread-state write must use.
 *
 * Never returns a UUID, a composite key or a fabricated phone. When no writable contact
 * route exists the caller receives a typed failure and must surface it — the previous
 * behaviour (send the composite key anyway and let the server 400 silently) is what
 * DD-003 describes.
 */
export const resolveWritableThreadKey = (
  thread: ThreadIdentityInput,
  options: ResolveThreadReferenceOptions = {},
): WritableThreadKeyResult | null => {
  const reference = resolveCanonicalThreadReference(thread, options)
  if (!reference) return null
  if (reference.writable && reference.canonicalE164) {
    return { ok: true, threadKey: reference.canonicalE164, reference }
  }
  return { ok: false, reason: reference.reason ?? 'no_canonical_phone', reference }
}

/** Stable key for any Deal Desk cache, selection or effect dependency. */
export const threadSelectionKey = (
  thread: ThreadIdentityInput,
  options: ResolveThreadReferenceOptions = {},
): string | null => resolveCanonicalThreadReference(thread, options)?.selectionKey ?? null

/** Identity comparison — two references name the same conversation. */
export const isSameCanonicalThread = (
  a: CanonicalThreadReference | null | undefined,
  b: CanonicalThreadReference | null | undefined,
): boolean => {
  if (!a || !b) return false
  if (a.selectionKey === b.selectionKey) return true
  if (a.conversationId && b.conversationId) return a.conversationId === b.conversationId
  if (a.threadId && b.threadId && a.threadId === b.threadId) return true
  return false
}

/**
 * Does a candidate row refer to the same conversation as a reference?
 * Used for list-refresh reconciliation, where the row object is a new object reference
 * but the underlying conversation is unchanged.
 */
export const rowMatchesThreadReference = (
  row: ThreadIdentityInput,
  reference: CanonicalThreadReference | null | undefined,
  options: ResolveThreadReferenceOptions = {},
): boolean => {
  if (!reference) return false
  return isSameCanonicalThread(resolveCanonicalThreadReference(row, options), reference)
}

/** Human-readable diagnostic — used in dev logs and error surfaces, never in a request. */
export const describeThreadReference = (reference: CanonicalThreadReference | null): string => {
  if (!reference) return 'no_thread_reference'
  return [
    `key=${reference.selectionKey}`,
    `source=${reference.source}`,
    `phone=${reference.canonicalE164 ?? 'none'}`,
    `writable=${reference.writable}`,
    reference.reason ? `reason=${reference.reason}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}
