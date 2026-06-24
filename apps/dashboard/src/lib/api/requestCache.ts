type CacheEntry<T> = {
  expiresAt: number
  value?: T
  promise?: Promise<T>
}

const cache = new Map<string, CacheEntry<unknown>>()

const inflightControllers = new Map<string, AbortController>()

export function buildRequestCacheKey(path: string, method = 'GET', body?: string): string {
  return `${method}:${path}:${body || ''}`
}

export function readCachedRequest<T>(key: string): T | null {
  const entry = cache.get(key)
  if (!entry || entry.expiresAt <= Date.now()) return null
  return (entry.value ?? null) as T | null
}

export async function cachedGetRequest<T>(
  key: string,
  ttlMs: number,
  fetcher: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const now = Date.now()
  const existing = cache.get(key)

  if (existing && existing.expiresAt > now) {
    if (existing.promise) return existing.promise as Promise<T>
    if ('value' in existing) return existing.value as T
  }

  const prior = inflightControllers.get(key)
  if (prior) prior.abort()

  const controller = new AbortController()
  inflightControllers.set(key, controller)

  const promise = fetcher(controller.signal)
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + Math.max(0, ttlMs) })
      inflightControllers.delete(key)
      return value
    })
    .catch((error) => {
      cache.delete(key)
      inflightControllers.delete(key)
      throw error
    })

  cache.set(key, { promise, expiresAt: Date.now() + Math.max(0, ttlMs) })
  return promise
}

export function invalidateRequestCache(prefix = ''): void {
  for (const key of cache.keys()) {
    if (!prefix || key.includes(prefix)) cache.delete(key)
  }
}