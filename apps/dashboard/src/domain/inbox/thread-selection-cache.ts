/**
 * Pure thread-selection cache helpers — testable without React.
 * Mirrors InboxPage messageCacheRef / dealContextCacheRef read paths.
 */

export function resolveThreadMessageCacheKey(input: {
  conversationThreadId?: string | null
  threadKey?: string | null
  id?: string | null
}): string {
  return String(input.conversationThreadId || input.threadKey || input.id || '').trim()
}

export function readCachedThreadMessages<T>(
  cache: Record<string, readonly T[]>,
  cacheKey: string,
): readonly T[] | null {
  const key = String(cacheKey || '').trim()
  if (!key) return null
  const hit = cache[key]
  return Array.isArray(hit) && hit.length > 0 ? hit : null
}

export function readCachedDealContext<T>(
  cache: Record<string, T>,
  cacheKey: string,
): T | null {
  const key = String(cacheKey || '').trim()
  if (!key) return null
  return cache[key] ?? null
}

/** Simulates handleSelect + effect cache apply (no network). */
export function measureCachedThreadOpen<T>(
  cache: Record<string, readonly T[]>,
  cacheKey: string,
): { cacheHit: boolean; applyMs: number; messageCount: number } {
  const start = performance.now()
  const messages = readCachedThreadMessages(cache, cacheKey)
  const applyMs = performance.now() - start
  return {
    cacheHit: Boolean(messages),
    applyMs: Math.round(applyMs * 1000) / 1000,
    messageCount: messages?.length ?? 0,
  }
}