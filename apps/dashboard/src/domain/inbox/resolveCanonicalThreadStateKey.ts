/**
 * Resolve E.164 thread_key required by /api/cockpit/inbox/thread-state.
 * Returns null when no canonical phone identity is available.
 */

const E164_RE = /^\+1\d{10}$/

const SYNTHETIC_THREAD_IDENTITY_RE = /^(property|owner|lead|prospect):/i

export const isSyntheticThreadIdentity = (value: unknown): boolean => {
  const raw = String(value ?? '').trim()
  return Boolean(raw) && SYNTHETIC_THREAD_IDENTITY_RE.test(raw)
}

const toCanonicalE164 = (value: unknown): string | null => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (isSyntheticThreadIdentity(raw)) return null
  if (E164_RE.test(raw)) return raw
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

const extractPhoneFromCompositeKey = (value: unknown): string | null => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const phoneSegment = raw.match(/(?:^|\|)phone:(\+1\d{10})\b/i)?.[1]
  if (phoneSegment) return phoneSegment
  const legacyPhonePrefix = raw.match(/^phone:(\+1\d{10})$/i)?.[1]
  if (legacyPhonePrefix) return legacyPhonePrefix
  return null
}

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
  'prospect_best_phone',
  'prospectBestPhone',
  'normalizedPhone',
  'normalized_phone',
] as const

const THREAD_IDENTITY_CANDIDATES = [
  'conversationThreadId',
  'conversation_thread_id',
  'threadKey',
  'thread_key',
  'id',
] as const

const resolveFromCandidates = (
  thread: Record<string, unknown>,
  keys: readonly string[],
): string | null => {
  for (const key of keys) {
    const candidate = thread[key]
    const compositePhone = extractPhoneFromCompositeKey(candidate)
    if (compositePhone) return compositePhone
    const resolved = toCanonicalE164(candidate)
    if (resolved) return resolved
  }
  return null
}

/** Resolve dialable seller phone from explicit phone fields only (never synthetic property:* keys). */
export const resolveDialablePhoneFromThread = (thread: Record<string, unknown>): string | null =>
  resolveFromCandidates(thread, PHONE_FIELD_CANDIDATES)

export const resolveCanonicalThreadStateKey = (thread: Record<string, unknown>): string | null => {
  const dialablePhone = resolveDialablePhoneFromThread(thread)
  if (dialablePhone) return dialablePhone
  return resolveFromCandidates(thread, THREAD_IDENTITY_CANDIDATES)
}