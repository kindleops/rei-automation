const CACHE_PREFIX = 'lc.streetview.v1:'
const MAX_ENTRIES = 400

type CacheEntry = {
  url: string
  ok: boolean
  at: number
}

const memory = new Map<string, CacheEntry>()

function cacheKey(url: string): string {
  return `${CACHE_PREFIX}${url}`
}

function readSession(key: string): CacheEntry | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CacheEntry
    if (!parsed?.url) return null
    return parsed
  } catch {
    return null
  }
}

function writeSession(key: string, entry: CacheEntry) {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(key, JSON.stringify(entry))
  } catch {
    /* quota */
  }
}

export function getCachedStreetViewStatus(url: string | null | undefined): 'unknown' | 'ok' | 'failed' {
  if (!url) return 'unknown'
  const mem = memory.get(url)
  if (mem) return mem.ok ? 'ok' : 'failed'
  const stored = readSession(cacheKey(url))
  if (!stored) return 'unknown'
  memory.set(url, stored)
  return stored.ok ? 'ok' : 'failed'
}

export function rememberStreetViewResult(url: string, ok: boolean) {
  const entry: CacheEntry = { url, ok, at: Date.now() }
  memory.set(url, entry)
  if (memory.size > MAX_ENTRIES) {
    const oldest = [...memory.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0]
    if (oldest) memory.delete(oldest)
  }
  writeSession(cacheKey(url), entry)
}