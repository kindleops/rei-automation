/**
 * CAMERA MEDIA — how LeadCommand touches third-party imagery, and how it can't.
 *
 * The snapshot proxy takes a canonical camera id, never a URL. The upstream
 * URL comes from our own inventory (written by an adapter from the provider's
 * official metadata) and must still pass the provider's host allowlist: https
 * only (unless the registry says an agency serves http alone), no credentials
 * in the URL, no IP literals or single-label hosts, default port, redirects
 * followed only onto allowlisted hosts. There is no `?url=` anywhere.
 *
 * Stills are held in memory for about one provider cadence so ten operators
 * opening the same camera cost the agency one request — then they are gone.
 * Nothing is written to disk or the database; there is no history.
 */

import { hostAllowed, USER_AGENT, validateUpstreamUrl } from '../world-providers/provider-fetch.js'

export { hostAllowed, validateUpstreamUrl }

const MAX_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 8000
const MAX_REDIRECTS = 2
const CACHE_MAX_ENTRIES = 300
const CACHE_MAX_BYTES = 64 * 1024 * 1024
const IMAGE_TYPES = /^image\/(jpeg|jpg|png|webp|gif)\b/i

async function readCapped(response, maxBytes) {
  const len = Number(response.headers.get('content-length'))
  if (Number.isFinite(len) && len > maxBytes) throw Object.assign(new Error('image_too_large'), { code: 'image_too_large' })
  if (!response.body?.getReader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > maxBytes) throw Object.assign(new Error('image_too_large'), { code: 'image_too_large' })
    return buf
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) { try { await reader.cancel() } catch { /* ignore */ } throw Object.assign(new Error('image_too_large'), { code: 'image_too_large' }) }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/**
 * Fetch one upstream image under the allowlist, following at most two
 * redirects and only onto allowlisted hosts. Never throws with the upstream
 * URL in the message: a keyed URL must not reach a log line or a client.
 */
export async function fetchUpstreamImage(request, provider, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, userAgent = USER_AGENT } = {}) {
  let target = validateUpstreamUrl(request?.url, provider)
  if (!target.ok) return { ok: false, status: 400, reason: target.reason }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    let res
    const started = Date.now()
    try {
      res = await fetchImpl(target.url, { method: 'GET', redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': userAgent, Accept: 'image/*', ...(request.headers || {}) } })
    } catch (error) {
      clearTimeout(timer)
      return { ok: false, status: 504, reason: error?.name === 'AbortError' ? 'upstream_timeout' : 'upstream_unreachable' }
    }
    clearTimeout(timer)
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return { ok: false, status: 502, reason: 'redirect_without_location' }
      let next
      try { next = new URL(loc, target.url).toString() } catch { return { ok: false, status: 502, reason: 'bad_redirect' } }
      target = validateUpstreamUrl(next, provider)
      if (!target.ok) return { ok: false, status: 502, reason: `redirect_${target.reason}` }
      continue
    }
    if (!res.ok) return { ok: false, status: res.status === 404 ? 404 : 502, reason: `upstream_${res.status}` }
    const type = res.headers.get('content-type') || ''
    if (!IMAGE_TYPES.test(type)) return { ok: false, status: 502, reason: 'upstream_not_an_image' }
    let bytes
    try { bytes = await readCapped(res, maxBytes) } catch (error) { return { ok: false, status: 502, reason: error?.code || 'upstream_read_failed' } }
    const lm = res.headers.get('last-modified')
    const lmMs = lm ? Date.parse(lm) : NaN
    return {
      ok: true,
      bytes,
      content_type: type.split(';')[0].trim().toLowerCase(),
      upstream_last_modified: Number.isFinite(lmMs) ? new Date(lmMs).toISOString() : null,
      latency_ms: Date.now() - started,
    }
  }
  return { ok: false, status: 502, reason: 'too_many_redirects' }
}

/* ── short-lived in-memory still cache (LRU, bounded by count and bytes) ── */

const cache = new Map()
let cacheBytes = 0

export function snapshotCacheGet(key, now = Date.now()) {
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.expires <= now) { cache.delete(key); cacheBytes -= hit.bytes.length; return null }
  cache.delete(key); cache.set(key, hit) // refresh recency
  return hit
}

export function snapshotCacheSet(key, value, ttlSec, now = Date.now()) {
  const prev = cache.get(key)
  if (prev) { cache.delete(key); cacheBytes -= prev.bytes.length }
  const entry = { ...value, expires: now + Math.max(5, ttlSec) * 1000 }
  cache.set(key, entry)
  cacheBytes += entry.bytes.length
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const [oldKey, old] = cache.entries().next().value
    cache.delete(oldKey)
    cacheBytes -= old.bytes.length
  }
  return entry
}

export function _resetSnapshotCache() { cache.clear(); cacheBytes = 0 }
export function snapshotCacheStats() { return { entries: cache.size, bytes: cacheBytes } }

/** Hold a still for about one provider cadence: never shorter than 10 s, never longer than 2 min. */
export function snapshotTtlSec(cadenceSec) {
  const c = Number(cadenceSec)
  return Math.min(120, Math.max(10, Number.isFinite(c) && c > 0 ? Math.round(c * 0.5) : 30))
}
