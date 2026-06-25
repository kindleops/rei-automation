/**
 * Resolve E.164 thread_key required by /api/cockpit/inbox/thread-state.
 * Returns null when no canonical phone identity is available.
 */

const E164_RE = /^\+1\d{10}$/

const toCanonicalE164 = (value: unknown): string | null => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
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

export const resolveCanonicalThreadStateKey = (thread: Record<string, unknown>): string | null => {
  const candidates = [
    thread.canonicalE164,
    thread.canonical_e164,
    thread.sellerPhone,
    thread.seller_phone,
    thread.bestPhone,
    thread.best_phone,
    thread.phoneNumber,
    thread.phone_number,
    thread.phone,
    thread.displayPhone,
    thread.display_phone,
    thread.normalizedPhone,
    thread.normalized_phone,
    thread.conversationThreadId,
    thread.conversation_thread_id,
    thread.threadKey,
    thread.thread_key,
    thread.id,
  ]
  for (const candidate of candidates) {
    const compositePhone = extractPhoneFromCompositeKey(candidate)
    if (compositePhone) return compositePhone
    const resolved = toCanonicalE164(candidate)
    if (resolved) return resolved
  }
  return null
}