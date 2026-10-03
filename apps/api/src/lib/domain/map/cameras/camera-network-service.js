/**
 * LEADCOMMAND CAMERA NETWORK — the service the Map talks to.
 *
 *   Map ──▶ /api/cockpit/map/cameras* ──▶ this service ──▶ public.map_cameras
 *                                               │
 *                        refresh (scheduled) ──▶ adapter per provider ──▶ official feed
 *
 * The browser never calls a DOT. Reads are bounded (a viewport, a radius, one
 * camera); inventory is refreshed per provider cadence under a lease, with
 * bounded backoff, and a failed pull never deletes what we already know.
 * Media is fetched only for the one camera an operator opens.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { deriveTimezoneFromGeography } from '@/lib/domain/campaigns/contact-window-timezone.js'
import { loadMapAreas, resolvePlace } from '@/lib/domain/map/map-world-service.js'
import { cameraFreshness, distanceKm, finalizeCamera, orderCorridor, providerOfCameraId } from './camera-model.js'
import { CAMERA_PROVIDERS, coverageByState, effectiveProvider, providerById, publicProvider } from './camera-provider-registry.js'
import { CAMERA_ADAPTERS } from './camera-adapters.js'
import { resolveDuplicates } from './camera-dedupe.js'
import { fetchUpstreamImage, snapshotCacheGet, snapshotCacheSet, snapshotTtlSec, validateUpstreamUrl } from './camera-media.js'
import { makeProviderFetch, scrubProviderError } from '../world-providers/provider-fetch.js'
import { markFailure, markSuccess, readProviderHealth, runDueProviders, startRun } from '../world-providers/provider-runtime.js'
import { boxesOverlap, memoryHealth, memoryInventory } from './camera-memory-store.js'

const MIN = 60_000
// Individual points only for a metro-sized box; anything larger is coverage cells.
const POINTS_MAX_SPAN_LNG = 40
const POINTS_MAX_SPAN_LAT = 25
const POINT_LIMIT = 2500
const MISSING_RETIRE_MS = 72 * 60 * MIN

/**
 * Which inventory the reads use. 'db' = public.map_cameras (migration
 * 20260930120000 + the refresh cron); 'memory' = camera-memory-store, pulled
 * live from each official feed. Production runs 'memory' until the migration
 * is applied (MAP_CAMERAS_STORE=db switches). A caller that injects its own
 * database (tests, the refresh job) gets the DB store unless it says otherwise.
 */
function storeFor(deps, env) {
  const want = String(deps.store || env.MAP_CAMERAS_STORE || '').trim().toLowerCase()
  if (want === 'db' || want === 'memory') return want
  return deps.supabase ? 'db' : 'memory'
}

const deps0 = (deps = {}) => ({
  store: storeFor(deps, deps.env || process.env),
  db: deps.supabase || defaultSupabase,
  registry: deps.registry || CAMERA_PROVIDERS,
  adapters: deps.adapters || CAMERA_ADAPTERS,
  env: deps.env || process.env,
  fetchImpl: deps.fetchImpl || globalThis.fetch,
  now: deps.now ?? Date.now(),
})

const providersOf = (d) => d.registry.map((p) => effectiveProvider(p, d.env))

/* ── viewport ─────────────────────────────────────────────────────────────── */

export function parseBbox(raw) {
  const parts = String(raw || '').split(',').map((s) => Number(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [w, s, e, n] = parts
  if (w >= e || s >= n || Math.abs(s) > 90 || Math.abs(n) > 90 || Math.abs(w) > 180 || Math.abs(e) > 180) return null
  return { west: w, south: s, east: e, north: n }
}

/**
 * Semantic zoom, decided on the server so no client can ask for a continent
 * of points: national → nothing individual; state → coverage cells; metro and
 * closer → points (clustered by the Map), capped; over the cap → finer cells.
 */
export function viewportMode(zoom) {
  const z = Number(zoom)
  if (!Number.isFinite(z) || z < 5) return { mode: 'none' }
  if (z < 8) return { mode: 'coverage', cell_deg: z < 6 ? 1 : z < 7 ? 0.5 : 0.25 }
  return { mode: 'points' }
}

export async function getCamerasInView({ bbox, zoom, coverage = false } = {}, deps = {}) {
  const d = deps0(deps)
  const box = parseBbox(bbox)
  if (!box) return { ok: false, status: 400, error: 'bbox_invalid_or_too_large' }
  const providers = providersOf(d)
  const enabled = providers.filter((p) => p.enabled)
  let plan = coverage && viewportMode(zoom).mode === 'none' ? { mode: 'coverage', cell_deg: 2 } : viewportMode(zoom)
  // A box too large to draw honestly as points (an ultrawide at low zoom) is coverage.
  if (plan.mode === 'points' && (box.east - box.west > POINTS_MAX_SPAN_LNG || box.north - box.south > POINTS_MAX_SPAN_LAT)) plan = { mode: 'coverage', cell_deg: 0.5 }
  const base = { ok: true, generated_at: new Date(d.now).toISOString(), zoom: Number(zoom), mode: plan.mode, providers_connected: enabled.length }
  if (!enabled.length) return { ...base, mode: 'none', cameras: [], cells: [], attributions: [], note: 'no_provider_connected' }
  if (plan.mode === 'none') return { ...base, cameras: [], cells: [], attributions: [], coverage: coverageInView(enabled, box) }
  if (d.store === 'memory') return memoryView(d, enabled, box, plan, base)

  if (plan.mode === 'coverage') {
    const { data, error } = await d.db.rpc('map_camera_grid', { p_west: box.west, p_south: box.south, p_east: box.east, p_north: box.north, p_cell_deg: plan.cell_deg })
    if (error) return { ok: false, status: 502, error: 'camera_grid_unavailable' }
    const cells = (data || []).map((c) => ({ lng: Number(c.lng), lat: Number(c.lat), cameras: Number(c.cameras) || 0, live: Number(c.live) || 0 })).filter((c) => c.cameras > 0)
    return { ...base, cell_deg: plan.cell_deg, cells, cameras: [], attributions: [] }
  }

  const { data, error } = await d.db.rpc('map_cameras_in_bbox', { p_west: box.west, p_south: box.south, p_east: box.east, p_north: box.north, p_limit: POINT_LIMIT + 1 })
  if (error) return { ok: false, status: 502, error: 'cameras_unavailable' }
  const rows = data || []
  if (rows.length > POINT_LIMIT) {
    // Too dense to draw honestly as points: hand back finer coverage cells.
    const { data: cellsRaw, error: gErr } = await d.db.rpc('map_camera_grid', { p_west: box.west, p_south: box.south, p_east: box.east, p_north: box.north, p_cell_deg: 0.1 })
    if (gErr) return { ok: false, status: 502, error: 'camera_grid_unavailable' }
    return { ...base, mode: 'coverage', cell_deg: 0.1, cells: (cellsRaw || []).map((c) => ({ lng: Number(c.lng), lat: Number(c.lat), cameras: Number(c.cameras) || 0, live: Number(c.live) || 0 })), cameras: [], attributions: [] }
  }
  const byId = new Map(enabled.map((p) => [p.provider_id, p]))
  const cameras = []
  const used = new Map()
  for (const r of rows) {
    const p = byId.get(r.provider_id)
    if (!p) continue // provider switched off: its inventory stays, its icons don't
    used.set(p.provider_id, p)
    const f = cameraFreshness({ capturedAt: r.provider_updated_at, cadenceSec: r.snapshot_cadence_sec ?? p.snapshot_cadence_sec, status: r.status, now: d.now, staleAfterSec: p.stale_after_sec })
    cameras.push({
      id: r.camera_id,
      name: r.name,
      road: r.road,
      direction: r.direction,
      lat: Number(r.latitude),
      lng: Number(r.longitude),
      status: r.status,
      feed: r.feed_type,
      video: r.feed_type === 'HLS' || r.feed_type === 'VIDEO_STREAM',
      freshness: f.state,
      corridor: r.corridor_key,
    })
  }
  return { ...base, cameras, cells: [], attributions: [...used.values()].map((p) => ({ provider: p.name, text: p.attribution })) }
}

/** The connected providers whose territory meets this box — the honest coverage line. */
function coverageInView(enabled, box) {
  return enabled.filter((p) => boxesOverlap(p.bounds, box)).map((p) => ({
    provider: p.name, state: p.state || null, region: p.region || null, coverage_status: p.coverage_status,
    image_policy: p.image_policy, attribution: p.attribution, terms_url: p.terms_url || null,
  }))
}

const inBox = (c, b) => c.longitude >= b.west && c.longitude <= b.east && c.latitude >= b.south && c.latitude <= b.north

function gridCells(list, cellDeg) {
  const cells = new Map()
  for (const c of list) {
    const k = `${Math.floor(c.longitude / cellDeg)}:${Math.floor(c.latitude / cellDeg)}`
    const cell = cells.get(k) || { lng: 0, lat: 0, cameras: 0, live: 0 }
    cell.lng += c.longitude; cell.lat += c.latitude; cell.cameras += 1; if (c.status === 'LIVE') cell.live += 1
    cells.set(k, cell)
  }
  return [...cells.values()].map((c) => ({ lng: c.lng / c.cameras, lat: c.lat / c.cameras, cameras: c.cameras, live: c.live }))
}

async function inventoryOf(d, p) {
  const adapter = d.adapters[p.adapter_type]
  if (!adapter) return null
  return memoryInventory({ provider: p, adapter, fetchImpl: d.fetchImpl, env: d.env, now: d.now })
}

const cameraView = (d, p, r) => ({
  id: r.camera_id,
  name: r.name,
  road: r.road,
  direction: r.direction,
  lat: Number(r.latitude),
  lng: Number(r.longitude),
  status: r.status,
  feed: r.feed_type,
  video: false,
  media: p.image_policy === 'link_only' ? 'link' : 'still',
  freshness: cameraFreshness({ capturedAt: r.provider_updated_at, cadenceSec: r.snapshot_cadence_sec ?? p.snapshot_cadence_sec, status: r.status, now: d.now, staleAfterSec: p.stale_after_sec }).state,
  corridor: r.corridor_key,
  provider: p.name,
})

async function memoryView(d, enabled, box, plan, base) {
  const coverage = coverageInView(enabled, box)
  const near = enabled.filter((p) => boxesOverlap(p.bounds, box))
  if (!near.length) return { ...base, cameras: [], cells: [], attributions: [], coverage, note: 'no_provider_in_view' }
  const invs = await Promise.all(near.map(async (p) => ({ p, inv: await inventoryOf(d, p) })))
  const rows = []
  const failed = []
  for (const { p, inv } of invs) {
    if (!inv || (!inv.cameras.size && inv.failures)) { failed.push(p.name); continue }
    for (const c of inv.cameras.values()) if (inBox(c, box)) rows.push({ p, c })
  }
  const extra = { coverage, ...(failed.length ? { unavailable: failed } : {}) }
  const used = new Map()
  for (const { p } of rows) used.set(p.provider_id, p)
  const attributions = [...used.values()].map((p) => ({ provider: p.name, text: p.attribution }))
  if (plan.mode === 'coverage' || rows.length > POINT_LIMIT) {
    const cellDeg = plan.mode === 'coverage' ? plan.cell_deg : 0.1
    return { ...base, ...extra, mode: 'coverage', cell_deg: cellDeg, cells: gridCells(rows.map((r) => r.c), cellDeg), cameras: [], attributions }
  }
  return { ...base, ...extra, cameras: rows.map(({ p, c }) => cameraView(d, p, c)), cells: [], attributions }
}

/** One camera's stored row, from whichever store is active. */
async function cameraRow(d, provider, cameraId, cols) {
  if (d.store === 'memory') {
    const inv = await inventoryOf(d, provider)
    return { data: inv?.cameras.get(cameraId) || null, error: null }
  }
  return d.db.from('map_cameras').select(cols).eq('camera_id', cameraId).maybeSingle()
}

/* ── one camera ───────────────────────────────────────────────────────────── */

// Adapters that build the still URL at fetch time (e.g. keyed) need no stored still_url.
const hasSnapshotBuilder = (d, provider) => Boolean(d.adapters[provider.adapter_type]?.snapshotRequest)

const DETAIL_COLS = 'camera_id, provider_id, external_camera_id, name, state, county, city, road, route, direction, mile_marker, latitude, longitude, status, feed_type, still_url, stream_url, provider_page_url, snapshot_cadence_sec, provider_updated_at, timezone, corridor_key, corridor_rank, duplicate_of, retired_at, leadcommand_refreshed_at'

async function corridorOf(db, camera, memoryList = null) {
  if (!camera.corridor_key) return null
  const { data, error } = memoryList ? { data: memoryList, error: null } : await db.from('map_cameras')
    .select('camera_id, name, corridor_rank, latitude, longitude, direction, status, feed_type')
    .eq('corridor_key', camera.corridor_key).is('retired_at', null).is('duplicate_of', null)
    .order('corridor_rank', { ascending: true }).limit(600)
  if (error || !data?.length) return null
  const list = data.filter((c) => Number.isFinite(Number(c.corridor_rank)))
  const i = list.findIndex((c) => c.camera_id === camera.camera_id)
  if (i < 0 || list.length < 2) return null
  const pick = (c) => (c ? { id: c.camera_id, name: c.name, lat: Number(c.latitude), lng: Number(c.longitude), direction: c.direction, status: c.status, feed: c.feed_type } : null)
  const [st, road] = camera.corridor_key.split('|')
  return { key: camera.corridor_key, road, state: st, index: i + 1, total: list.length, prev: pick(list[i - 1]), next: pick(list[i + 1]) }
}

export async function getCameraDetail(cameraId, deps = {}) {
  const d = deps0(deps)
  const providerId = providerOfCameraId(cameraId)
  const provider = providerId ? providersOf(d).find((p) => p.provider_id === providerId) : null
  if (!provider) return { ok: false, status: 404, error: 'camera_not_found' }
  const { data: cam, error } = await cameraRow(d, provider, cameraId, DETAIL_COLS)
  if (error) return { ok: false, status: 502, error: 'camera_unavailable' }
  if (!cam || cam.retired_at) return { ok: false, status: 404, error: 'camera_not_found' }
  if (!provider.enabled) return { ok: false, status: 409, error: 'provider_disabled', provider: publicProvider(provider) }
  const cadence = cam.snapshot_cadence_sec ?? provider.snapshot_cadence_sec ?? null
  const freshness = cameraFreshness({ capturedAt: cam.provider_updated_at, cadenceSec: cadence, status: cam.status, now: d.now, staleAfterSec: provider.stale_after_sec })
  const video = (cam.feed_type === 'HLS' || cam.feed_type === 'VIDEO_STREAM') && cam.stream_url && validateUpstreamUrl(cam.stream_url, provider).ok
  const media = {
    still: provider.image_policy === 'proxy' && (cam.still_url || hasSnapshotBuilder(d, provider))
      ? { kind: 'proxy', path: `/api/cockpit/map/cameras/${encodeURIComponent(cam.camera_id)}/snapshot`, refresh_sec: cadence }
      : provider.image_policy === 'direct' && cam.still_url && validateUpstreamUrl(cam.still_url, provider).ok
        ? { kind: 'direct', url: cam.still_url, refresh_sec: cadence }
        : null,
    stream: video ? { type: cam.feed_type === 'HLS' ? 'HLS' : 'VIDEO', url: cam.stream_url } : null,
    provider_page_url: cam.provider_page_url || null,
  }
  return {
    ok: true,
    camera: {
      id: cam.camera_id,
      name: cam.name,
      road: cam.road,
      route: cam.route,
      direction: cam.direction,
      mile_marker: cam.mile_marker,
      city: cam.city,
      county: cam.county,
      state: cam.state,
      lat: Number(cam.latitude),
      lng: Number(cam.longitude),
      status: cam.status,
      feed: cam.feed_type,
      timezone: cam.timezone,
      provider_updated_at: cam.provider_updated_at,
      refreshed_at: cam.leadcommand_refreshed_at,
      cadence_sec: cadence,
      freshness,
    },
    media,
    provider: { id: provider.provider_id, name: provider.name, attribution: provider.attribution, terms_url: provider.terms_url || null, image_policy: provider.image_policy },
    corridor: await corridorOf(d.db, cam, d.store === 'memory' ? ((await inventoryOf(d, provider))?.byCorridor.get(cam.corridor_key) || []) : null),
  }
}

/* ── nearby (a selected property) ─────────────────────────────────────────── */

export async function getNearbyCameras({ lat, lng, radiusM = 8000, limit = 6 } = {}, deps = {}) {
  const d = deps0(deps)
  const la = Number(lat); const ln = Number(lng)
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return { ok: false, status: 400, error: 'lat_lng_required' }
  const enabled = new Map(providersOf(d).filter((p) => p.enabled).map((p) => [p.provider_id, p]))
  if (!enabled.size) return { ok: true, cameras: [], note: 'no_provider_connected' }
  const r = Math.min(Math.max(Number(radiusM) || 8000, 100), 50_000)
  const n = Math.min(Math.max(Number(limit) || 6, 1), 20)
  const { data, error } = d.store === 'memory' ? await memoryNearby(d, [...enabled.values()], la, ln, r, n) : await d.db.rpc('map_cameras_nearby', { p_lat: la, p_lng: ln, p_radius_m: r, p_limit: n })
  if (error) return { ok: false, status: 502, error: 'cameras_unavailable' }
  const cameras = (data || []).filter((c) => enabled.has(c.provider_id)).map((c) => {
    const p = enabled.get(c.provider_id)
    return {
      id: c.camera_id,
      name: c.name,
      road: c.road,
      direction: c.direction,
      lat: Number(c.latitude),
      lng: Number(c.longitude),
      status: c.status,
      feed: c.feed_type,
      distance_m: Math.round(Number(c.distance_m)),
      freshness: cameraFreshness({ capturedAt: c.provider_updated_at, cadenceSec: c.snapshot_cadence_sec ?? p.snapshot_cadence_sec, status: c.status, now: d.now, staleAfterSec: p.stale_after_sec }).state,
      provider: p.name,
    }
  })
  return { ok: true, cameras, radius_m: r }
}

async function memoryNearby(d, providers, lat, lng, radiusM, limit) {
  const deg = radiusM / 111_000
  const box = { west: lng - deg / Math.max(0.2, Math.cos((lat * Math.PI) / 180)), east: lng + deg / Math.max(0.2, Math.cos((lat * Math.PI) / 180)), south: lat - deg, north: lat + deg }
  const out = []
  for (const p of providers.filter((x) => boxesOverlap(x.bounds, box))) {
    const inv = await inventoryOf(d, p)
    for (const c of inv?.cameras.values() || []) {
      const dm = distanceKm(lat, lng, c.latitude, c.longitude) * 1000
      if (dm <= radiusM) out.push({ ...c, distance_m: dm })
    }
  }
  out.sort((a, b) => a.distance_m - b.distance_m)
  return { data: out.slice(0, limit), error: null }
}

/* ── registry, coverage, health ───────────────────────────────────────────── */

const healthRows = (db) => readProviderHealth(db, 'cameras')
const memoryHealthRows = (providers) => Object.fromEntries(providers.map((p) => [p.provider_id, memoryHealth(p.provider_id)]).filter(([, h]) => h))

export async function getCameraProviders(deps = {}) {
  const d = deps0(deps)
  const providers = providersOf(d)
  const health = (d.store === 'memory' ? memoryHealthRows(providers) : await healthRows(d.db)) || {}
  return {
    ok: true,
    providers: providers.filter((p) => p.enabled).map((p) => publicProvider(p, health[p.provider_id])),
    coverage: coverageByState(providers, health),
    architecture: 'nationwide_capable',
    store: d.store,
  }
}

/** Internal: adapter heartbeat for operators/admins. No keys, no raw URLs. */
export async function getCameraHealth(deps = {}) {
  const d = deps0(deps)
  const providers = providersOf(d)
  const health = d.store === 'memory' ? memoryHealthRows(providers) : await healthRows(d.db)
  if (!health) return { ok: false, status: 502, error: 'camera_health_unavailable' }
  const { data: runs } = d.store === 'memory' ? { data: [] } : await d.db.from('map_world_provider_runs').select('provider_id, started_at, finished_at, ok, items_received, items_normalized, items_upserted, items_missing, items_retired, duplicates_marked, schema_errors, latency_ms, error').eq('domain', 'cameras').order('started_at', { ascending: false }).limit(40)
  return {
    ok: true,
    providers: providers.map((p) => {
      const h = health[p.provider_id] || {}
      const st = h.stats || {}
      const total = h.item_count || 0
      return {
        provider_id: p.provider_id,
        name: p.name,
        state: p.state || null,
        enabled: p.enabled,
        disabled_reason: p.disabled_reason,
        requires_api_key: Boolean(p.requires_api_key),
        key_configured: p.key_configured,
        health_state: p.enabled ? (h.health_state || 'unknown') : 'disabled',
        cameras: total,
        live: st.live ?? null,
        stale: st.stale ?? null,
        offline: st.offline ?? null,
        fresh_pct: total && Number.isFinite(st.live) ? Math.round((st.live / total) * 100) : null,
        last_success_at: h.last_success_at || null,
        last_failure_at: h.last_failure_at || null,
        failure_reason: h.failure_reason || null,
        consecutive_failures: h.consecutive_failures || 0,
        next_refresh_at: h.next_refresh_at || null,
        last_latency_ms: h.last_latency_ms ?? null,
      }
    }),
    recent_runs: runs || [],
  }
}

/* ── refresh (scheduled; per provider cadence, leased, bounded backoff) ───── */

export { backoffMs } from '../world-providers/provider-runtime.js'

/** Camera-local timezone from our own geography: state (+ nearest ZIP for split-zone states). */
export function timezoneForCamera(cam, areas) {
  const tz0 = cam.state ? deriveTimezoneFromGeography(cam.state, null) : null
  if (tz0?.iana) return tz0.iana
  if (!areas?.length) return null
  const place = resolvePlace(areas, cam.latitude, cam.longitude)
  const st = cam.state || place.state
  if (!st || !place.zip) return null
  return deriveTimezoneFromGeography(st, place.zip)?.iana || null
}

/**
 * Refresh every enabled camera provider that is due (or `providerIds`, or all
 * with `force`). One provider failing never stops the others; each attempt
 * leaves a ledger row and a heartbeat (shared world-provider runtime).
 */
export async function refreshCameraProviders({ providerIds = null, force = false, owner = `refresh:${process.pid}`, budgetMs = 100_000 } = {}, deps = {}) {
  const d = deps0(deps)
  let areas = null
  return runDueProviders({
    db: d.db, domain: 'cameras', providers: providersOf(d), adapters: d.adapters, now: d.now, owner, force, providerIds, budgetMs,
    refreshOne: async (p, adapter, prev) => {
      if (!areas) { try { areas = await loadMapAreas(d.db, d.now) } catch { areas = [] } }
      return refreshOne(d, p, adapter, prev, areas)
    },
  })
}

async function refreshOne(d, p, adapter, prev, areas) {
  const t0 = Date.now()
  const runStart = new Date(d.now).toISOString()
  const finishRun = await startRun(d.db, p, runStart)
  try {
    const apiKey = p.requires_api_key ? String(d.env[p.api_key_env] || '').trim() : null
    const raw = await adapter.listRaw({ provider: p, fetch: makeProviderFetch(p, { fetchImpl: d.fetchImpl }), apiKey, now: d.now })
    const seen = new Map()
    let normalized = 0
    for (const item of raw || []) {
      const cam = finalizeCamera(p, adapter.normalize(item, { provider: p, now: d.now }), { refreshedAt: runStart })
      if (!cam) continue
      normalized += 1
      if (!seen.has(cam.camera_id)) seen.set(cam.camera_id, cam)
    }
    if (!seen.size) throw new Error('provider_returned_no_cameras')
    // corridors: order each road's cameras once per pull
    const byCorridor = new Map()
    for (const c of seen.values()) if (c.corridor_key) { if (!byCorridor.has(c.corridor_key)) byCorridor.set(c.corridor_key, []); byCorridor.get(c.corridor_key).push(c) }
    for (const list of byCorridor.values()) {
      const { ranks, basis } = orderCorridor(list)
      for (const c of list) { c.corridor_rank = ranks.get(c.camera_id) ?? null; c.metadata = { ...c.metadata, corridor_basis: basis } }
    }
    let live = 0; let stale = 0; let offline = 0
    const rows = [...seen.values()].map((c) => {
      if (!c.timezone) c.timezone = timezoneForCamera(c, areas)
      const f = cameraFreshness({ capturedAt: c.provider_updated_at, cadenceSec: c.snapshot_cadence_sec, status: c.status, now: d.now, staleAfterSec: p.stale_after_sec })
      if (f.state === 'offline') offline += 1
      else if (f.state === 'stale') stale += 1
      else if (c.status === 'LIVE' || f.state === 'fresh') live += 1
      return { ...c, last_seen_at: runStart, missing_since: null, retired_at: null }
    })
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await d.db.from('map_cameras').upsert(rows.slice(i, i + 500), { onConflict: 'camera_id' })
      if (error) throw new Error(`upsert_failed:${error.message}`)
    }
    // Not in this pull: missing (kept, still drawn) → retired after 72 h, never deleted.
    const { data: missing } = await d.db.from('map_cameras').update({ missing_since: runStart }).eq('provider_id', p.provider_id).lt('last_seen_at', runStart).is('missing_since', null).is('retired_at', null).select('camera_id')
    const cutoff = new Date(d.now - MISSING_RETIRE_MS).toISOString()
    const { data: retired } = await d.db.from('map_cameras').update({ retired_at: runStart }).eq('provider_id', p.provider_id).lt('missing_since', cutoff).is('retired_at', null).select('camera_id')
    if (retired?.length) {
      const ids = retired.map((r) => r.camera_id)
      for (let i = 0; i < ids.length; i += 200) await d.db.from('map_cameras').update({ duplicate_of: null }).in('duplicate_of', ids.slice(i, i + 200))
    }
    // One device, one icon — across providers.
    let dupMarked = 0
    const { data: pairs, error: pairErr } = await d.db.rpc('map_camera_duplicate_pairs', { p_provider_id: p.provider_id, p_radius_m: 40 })
    if (!pairErr && pairs?.length) {
      const prio = (id) => providerById(id, d.registry)?.priority ?? 100
      for (const a of resolveDuplicates(pairs, prio)) {
        await d.db.from('map_cameras').update({ duplicate_of: a.duplicate_of }).eq('camera_id', a.camera_id)
        if (a.duplicate_of) dupMarked += 1
      }
    }
    const total = rows.length
    await markSuccess(d.db, p, { now: d.now, itemCount: total, stats: { live, stale, offline }, healthState: stale + offline > total * 0.5 ? 'degraded' : 'healthy', latencyMs: Date.now() - t0 })
    await finishRun({ ok: true, items_received: (raw || []).length, items_normalized: normalized, items_upserted: total, items_missing: missing?.length || 0, items_retired: retired?.length || 0, duplicates_marked: dupMarked, schema_errors: (raw || []).length - normalized })
    return { provider_id: p.provider_id, ok: true, cameras: total, live, stale, offline, missing: missing?.length || 0, retired: retired?.length || 0, duplicates: dupMarked, ms: Date.now() - t0 }
  } catch (error) {
    const reason = scrubProviderError(error?.message || 'refresh_failed')
    await markFailure(d.db, p, prev, { now: d.now, reason, latencyMs: Date.now() - t0 })
    await finishRun({ ok: false, error: reason })
    return { provider_id: p.provider_id, ok: false, error: reason, ms: Date.now() - t0 }
  }
}

/* ── snapshot proxy (by canonical id only) ────────────────────────────────── */

export async function fetchCameraSnapshot(cameraId, deps = {}) {
  const d = deps0(deps)
  const providerId = providerOfCameraId(cameraId)
  const provider = providerId ? providersOf(d).find((p) => p.provider_id === providerId) : null
  if (!provider || !provider.enabled) return { ok: false, status: 404, reason: 'camera_not_found' }
  if (provider.image_policy !== 'proxy') return { ok: false, status: 403, reason: 'snapshot_not_proxied_for_provider' }
  const cached = snapshotCacheGet(cameraId, d.now)
  if (cached) return { ok: true, ...cached, from_cache: true, attribution: provider.attribution }
  const { data: cam, error } = await cameraRow(d, provider, cameraId, 'camera_id, external_camera_id, still_url, status, snapshot_cadence_sec, provider_updated_at, retired_at, metadata')
  if (error) return { ok: false, status: 502, reason: 'camera_unavailable' }
  if (!cam || cam.retired_at) return { ok: false, status: 404, reason: 'camera_not_found' }
  const adapter = d.adapters[provider.adapter_type]
  const apiKey = provider.requires_api_key ? String(d.env[provider.api_key_env] || '').trim() : null
  const request = adapter?.snapshotRequest ? adapter.snapshotRequest(cam, { provider, apiKey }) : cam.still_url ? { url: cam.still_url } : null
  if (!request?.url) return { ok: false, status: 404, reason: 'no_still_for_camera' }
  const got = await fetchUpstreamImage(request, provider, { fetchImpl: d.fetchImpl })
  if (!got.ok) return { ok: false, status: got.status, reason: got.reason }
  const cadence = cam.snapshot_cadence_sec ?? provider.snapshot_cadence_sec
  const entry = snapshotCacheSet(cameraId, {
    bytes: got.bytes,
    content_type: got.content_type,
    captured_at: got.upstream_last_modified || cam.provider_updated_at || null,
    captured_basis: got.upstream_last_modified ? 'upstream_last_modified' : cam.provider_updated_at ? 'provider_metadata' : 'unknown',
    fetched_at: new Date(d.now).toISOString(),
  }, snapshotTtlSec(cadence), d.now)
  return { ok: true, ...entry, from_cache: false, attribution: provider.attribution, ttl_sec: snapshotTtlSec(cadence) }
}
