/**
 * CAMERA MEMORY STORE — the camera inventory held in the API process, pulled
 * straight from each official feed on that provider's cadence.
 *
 * Why it exists: the durable store (public.map_cameras, migration
 * 20260930120000) was never applied to production. Until it is, the Map's
 * camera layer reads this store instead: the same adapters, the same
 * canonical model (finalizeCamera), the same allowlisted fetch helpers, the
 * same freshness rules — only the rows live in memory, not Postgres.
 *
 *   · metadata only — no imagery is held here (stills go through camera-media's
 *     short-lived cache, by canonical id, exactly as with the DB store)
 *   · one pull per provider per refresh_interval_sec; concurrent readers share
 *     one in-flight pull; a stale inventory is served while it refreshes
 *   · a failed pull keeps the last good inventory and backs off
 *   · a provider is only pulled when a viewport (or a camera id) needs it
 *
 * Switch to the DB store with MAP_CAMERAS_STORE=db once the migration is
 * applied and the refresh cron runs.
 */
import { finalizeCamera, orderCorridor } from './camera-model.js'
import { makeProviderFetch, scrubProviderError } from '../world-providers/provider-fetch.js'
import { backoffMs } from '../world-providers/provider-runtime.js'

const STATE = new Map()

export function _resetCameraMemoryStore() { STATE.clear() }

/** Two lng/lat boxes overlap. A provider without bounds is assumed to overlap. */
export function boxesOverlap(a, b) {
  if (!a || !b) return true
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south
}

function buildEntry(p, cameras, now) {
  const byId = new Map()
  for (const c of cameras) if (!byId.has(c.camera_id)) byId.set(c.camera_id, c)
  const byCorridor = new Map()
  for (const c of byId.values()) {
    if (!c.corridor_key) continue
    if (!byCorridor.has(c.corridor_key)) byCorridor.set(c.corridor_key, [])
    byCorridor.get(c.corridor_key).push(c)
  }
  for (const [key, list] of byCorridor) {
    const { ranks, basis } = orderCorridor(list)
    for (const c of list) { c.corridor_rank = ranks.get(c.camera_id) ?? null; c.metadata = { ...c.metadata, corridor_basis: basis } }
    byCorridor.set(key, list.filter((c) => Number.isFinite(c.corridor_rank)).sort((a, b) => a.corridor_rank - b.corridor_rank))
  }
  return { cameras: byId, byCorridor, at: now }
}

async function pull({ provider: p, adapter, fetchImpl, env, now }) {
  const apiKey = p.requires_api_key ? String(env[p.api_key_env] || '').trim() : null
  const raw = await adapter.listRaw({ provider: p, fetch: makeProviderFetch(p, { fetchImpl }), apiKey, now })
  const refreshedAt = new Date(now).toISOString()
  const out = []
  for (const item of raw || []) {
    const cam = finalizeCamera(p, adapter.normalize(item, { provider: p, now }), { refreshedAt })
    if (cam) out.push(cam)
  }
  if (!out.length) throw new Error('provider_returned_no_cameras')
  return { cameras: out, received: (raw || []).length }
}

/**
 * The provider's inventory, pulling it if it is missing or due. Never throws:
 * returns { cameras: Map, byCorridor, at, ...health } — `cameras` is empty
 * (size 0) when the provider has never answered.
 */
export async function memoryInventory({ provider: p, adapter, fetchImpl = globalThis.fetch, env = process.env, now = Date.now() }) {
  let e = STATE.get(p.provider_id)
  if (!e) { e = { cameras: new Map(), byCorridor: new Map(), at: 0, failures: 0, lastSuccessAt: null, lastFailureAt: null, failureReason: null, received: 0, inflight: null }; STATE.set(p.provider_id, e) }
  const due = !e.at || now - e.at >= p.refresh_interval_sec * 1000
  const backingOff = e.lastFailureAt && now - Date.parse(e.lastFailureAt) < backoffMs(e.failures, p.refresh_interval_sec)
  if (!due || (backingOff && !e.inflight)) return e
  if (!e.inflight) {
    e.inflight = (async () => {
      try {
        const got = await pull({ provider: p, adapter, fetchImpl, env, now })
        Object.assign(e, buildEntry(p, got.cameras, now), { failures: 0, lastSuccessAt: new Date(now).toISOString(), failureReason: null, received: got.received })
      } catch (error) {
        e.failures += 1
        e.lastFailureAt = new Date(now).toISOString()
        e.failureReason = scrubProviderError(error?.message || 'refresh_failed')
      } finally {
        e.inflight = null
      }
      return e
    })()
  }
  // Serve the last good inventory while it refreshes; wait only when there is none.
  if (e.cameras.size) return e
  await e.inflight
  return e
}

/** Health as the providers endpoint reports it (no URLs, no keys). */
export function memoryHealth(providerId) {
  const e = STATE.get(providerId)
  if (!e) return null
  return {
    item_count: e.cameras.size,
    health_state: e.cameras.size ? (e.failures ? 'degraded' : 'healthy') : e.failures ? 'failing' : 'unknown',
    last_success_at: e.lastSuccessAt,
    last_failure_at: e.lastFailureAt,
    failure_reason: e.failureReason,
    consecutive_failures: e.failures,
  }
}
