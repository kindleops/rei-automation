/**
 * COMMAND WALL — geography for wall events and markets.
 *
 * Batched, cached reads only:
 *   canonical_markets (≈60 rows, 6 h), market centroids from mi_zip_geo
 *   (per market, sales-weighted ZIP bbox centres, 6 h), property → ZIP/lat/lng/
 *   market via properties (LRU), ZIP centroids via mi_zip_geo (LRU).
 * A property is read at most once per process lifetime of its LRU entry.
 */
import { propertyIndex } from '@/lib/domain/home/home-read-kit.js'

const clean = (v) => String(v ?? '').trim()
const HOURS6 = 6 * 3600_000

function lru(max) {
  const m = new Map()
  return {
    get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v },
    set(k, v) { m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value) },
    has: (k) => m.has(k),
    size: () => m.size,
  }
}

export function createWallGeo(db, { now = () => Date.now(), readProperties = propertyIndex } = {}) {
  let markets = null
  let marketsAt = 0
  let marketsPending = null
  const centroids = new Map() // market id -> { lat, lng, at }
  const props = lru(20_000)
  const zips = lru(10_000)

  async function marketTable() {
    if (markets && now() - marketsAt < HOURS6) return markets
    if (marketsPending) return marketsPending
    marketsPending = (async () => {
      const { data, error } = await db.from('canonical_markets').select('id,display_name,state').limit(1000)
      if (error) throw error
      const byId = new Map()
      const byName = new Map()
      for (const r of data || []) {
        const id = clean(r.id)
        if (!id) continue
        const rec = { id, name: clean(r.display_name) || id, state: clean(r.state) || null }
        byId.set(id, rec)
        byName.set(rec.name.toLowerCase(), id)
      }
      markets = { byId, byName }
      marketsAt = now()
      return markets
    })().finally(() => { marketsPending = null })
    return marketsPending
  }

  async function ensureCentroids(ids) {
    const t = now()
    const need = [...new Set(ids)].filter((id) => id && !(centroids.has(id) && t - centroids.get(id).at < HOURS6))
    for (const id of need.slice(0, 12)) {
      const { data, error } = await db.from('mi_zip_geo').select('min_lat,max_lat,min_lng,max_lng,sales_n').eq('market_key', id).limit(1000)
      if (error) { centroids.set(id, { lat: null, lng: null, at: t }); continue }
      let w = 0; let lat = 0; let lng = 0
      for (const r of data || []) {
        const weight = Math.max(1, Number(r.sales_n) || 1)
        const la = (Number(r.min_lat) + Number(r.max_lat)) / 2
        const ln = (Number(r.min_lng) + Number(r.max_lng)) / 2
        if (!Number.isFinite(la) || !Number.isFinite(ln)) continue
        w += weight; lat += la * weight; lng += ln * weight
      }
      centroids.set(id, w ? { lat: lat / w, lng: lng / w, at: t } : { lat: null, lng: null, at: t })
    }
  }

  async function ensureZips(list) {
    const need = [...new Set(list)].filter((z) => z && !zips.has(z))
    for (let i = 0; i < need.length; i += 200) {
      const chunk = need.slice(i, i + 200)
      const { data, error } = await db.from('mi_zip_geo').select('zip,min_lat,max_lat,min_lng,max_lng').in('zip', chunk).limit(1000)
      if (error) break
      const seen = new Set()
      for (const r of data || []) {
        seen.add(clean(r.zip))
        zips.set(clean(r.zip), { lat: (Number(r.min_lat) + Number(r.max_lat)) / 2, lng: (Number(r.min_lng) + Number(r.max_lng)) / 2 })
      }
      for (const z of chunk) if (!seen.has(z)) zips.set(z, null)
    }
  }

  function marketIdFor(table, ref) {
    if (ref.market_id && table.byId.has(clean(ref.market_id))) return clean(ref.market_id)
    const name = clean(ref.market).toLowerCase()
    if (name && table.byName.has(name)) return table.byName.get(name)
    const slug = name.replace(/,\s*/g, '-').replace(/\s+/g, '-')
    if (slug && table.byId.has(slug)) return slug
    return null
  }

  return {
    marketTable,
    /** Batch-resolves refs { property_id, market, market_id } → geoFor(ref). */
    async resolver(refs) {
      const table = await marketTable().catch(() => ({ byId: new Map(), byName: new Map() }))
      const propIds = [...new Set(refs.map((r) => clean(r.property_id)).filter((id) => id && !props.has(id)))]
      if (propIds.length) {
        try {
          const found = await readProperties(db, propIds.slice(0, 600))
          for (const id of propIds) props.set(id, found.get(id) || null)
        } catch {
          // geography is best effort; an event without it simply does not pulse
        }
      }
      const zipList = []
      const marketIds = []
      for (const r of refs) {
        const p = props.get(clean(r.property_id))
        if (p?.zip) zipList.push(p.zip)
        const mid = (p?.mkt && table.byId.has(p.mkt) ? p.mkt : null) || marketIdFor(table, r)
        if (mid) marketIds.push(mid)
      }
      await Promise.all([ensureZips(zipList).catch(() => {}), ensureCentroids(marketIds).catch(() => {})])
      return (ref) => {
        if (!ref) return null
        const p = props.get(clean(ref.property_id)) || null
        const mid = (p?.mkt && table.byId.has(p.mkt) ? p.mkt : null) || marketIdFor(table, ref)
        const m = mid ? table.byId.get(mid) : null
        const c = mid ? centroids.get(mid) : null
        const z = p?.zip ? zips.get(p.zip) : null
        if (!m && !p) return null
        return {
          market_id: mid,
          market_name: m?.name || null,
          market_lat: c?.lat ?? null,
          market_lng: c?.lng ?? null,
          zip: p?.zip || null,
          zip_lat: z?.lat ?? null,
          zip_lng: z?.lng ?? null,
          lat: p?.lat ?? null,
          lng: p?.lng ?? null,
        }
      }
    },
    async marketsWithCentroids(ids) {
      const table = await marketTable()
      const valid = [...new Set(ids)].filter((id) => table.byId.has(id))
      await ensureCentroids(valid)
      return valid.map((id) => ({ ...table.byId.get(id), lat: centroids.get(id)?.lat ?? null, lng: centroids.get(id)?.lng ?? null }))
    },
    marketIdForName: async (name) => marketIdFor(await marketTable(), { market: name }),
    _stats: () => ({ props: props.size(), zips: zips.size(), centroids: centroids.size }),
  }
}
