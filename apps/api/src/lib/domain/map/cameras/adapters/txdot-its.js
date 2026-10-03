/**
 * TxDOT ITS — Texas district camera inventory (positions, roads, status) and,
 * INTERNAL USE ONLY, an on-demand still pass-through.
 *
 * Source: https://its.txdot.gov/its/DistrictIts/GetCctvStatusListByDistrict?districtCode={code}
 * — the JSON TxDOT's own public district camera pages load (no key, no login).
 * It is NOT a documented developer API, and TxDOT's terms are silent on reuse
 * of camera imagery; the stills exist only as base64 inside internal JSON.
 *
 * INTERNAL USE — PENDING A TxDOT DATA-SHARING AGREEMENT. The owner approved
 * (2026-10-03) a strictly limited still pass-through for the internal
 * LeadCommand app: TxDOT publishes no image URL (stills exist only as base64
 * inside GetCctvSnapshotByIcdId JSON, with no CORS), so a browser cannot load
 * one directly. `snapshotFetch` fetches the ONE still an operator opens,
 * decodes it and hands the bytes back to be streamed to that browser —
 * nothing is cached (not even in memory), stored or prefetched; the route is
 * operator-gated and rate-limited, and answers Cache-Control: no-store. Every
 * still is labelled "Source: TxDOT · internal use" with a link to TxDOT's page.
 * See docs/cameras/discovery/priority-states.md for the terms review.
 */

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim())

export const TXDOT_DISTRICTS = Object.freeze({
  DAL: 'Dallas',
  FTW: 'Fort Worth',
  HOU: 'Houston',
  SAT: 'San Antonio',
  AUS: 'Austin',
})

export const txdotStatusUrl = (code) => `https://its.txdot.gov/its/DistrictIts/GetCctvStatusListByDistrict?districtCode=${encodeURIComponent(code)}`
export const txdotDistrictPage = (code) => `https://its.txdot.gov/its/District/${encodeURIComponent(code)}/cameras`
export const txdotSnapshotUrl = (icdId, code) => `https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId?icdId=${encodeURIComponent(icdId)}&districtCode=${encodeURIComponent(code)}`
export const TXDOT_INTERNAL_USE_LABEL = 'Source: TxDOT · internal use, pending TxDOT data-sharing agreement'
export const TXDOT_STILL_MAX_BYTES = 2 * 1024 * 1024

/**
 * TxDOT's "10/3/2026 4:18 PM" (district local time, no zone; all five
 * districts are US Central) → ISO. Central daylight time runs from the second
 * Sunday of March to the first Sunday of November.
 */
export function parseTxdotTimestamp(raw) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(clean(raw))
  if (!m) return null
  const [, mo, d, y, hh, mm, ap] = m
  let h = Number(hh) % 12
  if (/pm/i.test(ap)) h += 12
  const year = Number(y)
  const nthSunday = (month, n) => { const first = new Date(Date.UTC(year, month, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + 7 * (n - 1) }
  const local = Date.UTC(year, Number(mo) - 1, Number(d), h, Number(mm))
  const dstStart = Date.UTC(year, 2, nthSunday(2, 2), 2)
  const dstEnd = Date.UTC(year, 10, nthSunday(10, 1), 2)
  const offsetH = local >= dstStart && local < dstEnd ? 5 : 6
  const t = local + offsetH * 3_600_000
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** base64 snippet → JPEG bytes, or a reason. Validates size and the JPEG signature. */
export function decodeTxdotSnippet(snippet, maxBytes = TXDOT_STILL_MAX_BYTES) {
  if (typeof snippet !== 'string' || !snippet) return { ok: false, reason: 'no_still_in_response' }
  if (snippet.length > Math.ceil(maxBytes / 3) * 4 + 8) return { ok: false, reason: 'image_too_large' }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(snippet)) return { ok: false, reason: 'still_not_base64' }
  const bytes = Buffer.from(snippet, 'base64')
  if (!bytes.length) return { ok: false, reason: 'no_still_in_response' }
  if (bytes.length > maxBytes) return { ok: false, reason: 'image_too_large' }
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return { ok: false, reason: 'upstream_not_a_jpeg' }
  return { ok: true, bytes }
}

/** TxDOT statusDescription ("Device Online", "Device Offline", …) → canonical. */
export function txdotStatus(desc) {
  const s = clean(desc)
  if (!s) return 'UNKNOWN'
  if (/\bonline\b/i.test(s)) return 'LIVE'
  if (/\b(offline|fail|failed|down|no\s*comm)/i.test(s)) return 'OFFLINE'
  if (/maint/i.test(s)) return 'MAINTENANCE'
  return 'UNKNOWN'
}

/** Flatten { roadwayCctvStatuses: { IH20: [...], ... } } into records tagged with their district. */
export function flattenTxdotDistrict(body, district) {
  const byRoad = body && typeof body === 'object' ? body.roadwayCctvStatuses : null
  if (!byRoad || typeof byRoad !== 'object') return []
  const out = []
  for (const list of Object.values(byRoad)) {
    if (!Array.isArray(list)) continue
    for (const r of list) if (r && typeof r === 'object') out.push({ ...r, __district: district })
  }
  return out
}

export const txdotItsAdapter = {
  async listRaw({ fetch, provider }) {
    const codes = provider?.adapter_config?.districts || Object.keys(TXDOT_DISTRICTS)
    const out = []
    let ok = 0
    for (const code of codes) {
      try {
        out.push(...flattenTxdotDistrict(await fetch.json(txdotStatusUrl(code)), code))
        ok += 1
      } catch { /* one district down never empties the others */ }
    }
    if (!ok) throw new Error('txdot_all_districts_failed')
    return out
  },
  normalize(raw) {
    if (!raw || typeof raw !== 'object') return null
    const district = clean(raw.__district)
    const icd = clean(raw.icd_Id)
    if (!district || !icd) return null
    const road = clean(raw.equipLoc?.roadway) || null
    return {
      // Composite: one icd_Id can repeat across districts.
      external_camera_id: `${district}-${icd}`,
      name: clean(raw.name) || icd,
      road,
      route: road,
      direction: clean(raw.dirDescription || raw.equipLoc?.direction) || null,
      latitude: raw.latitude,
      longitude: raw.longitude,
      status: txdotStatus(raw.statusDescription),
      feed_type: raw.hasSnapshot === true ? 'REFRESHING_STILL' : 'PROVIDER_PAGE_ONLY',
      provider_page_url: txdotDistrictPage(district),
      city: TXDOT_DISTRICTS[district] || null,
      metadata: { district, icd_id: icd, has_snapshot: raw.hasSnapshot === true },
    }
  },
  /**
   * INTERNAL USE pass-through: the one still an operator opened. Uses the
   * provider's allowlisted, timed-out, size-capped metadata fetch (JSON).
   * Returns { ok, bytes, content_type, captured_at } or { ok:false, status, reason }.
   */
  async snapshotFetch(cam, { fetch }) {
    const district = clean(cam?.metadata?.district)
    const icd = clean(cam?.metadata?.icd_id)
    if (!TXDOT_DISTRICTS[district] || !icd) return { ok: false, status: 404, reason: 'no_still_for_camera' }
    let body
    try {
      body = await fetch.json(txdotSnapshotUrl(icd, district))
    } catch (error) {
      const msg = String(error?.message || '')
      return { ok: false, status: /timeout/.test(msg) ? 504 : 502, reason: /JSON|Unexpected token|json/i.test(msg) ? 'upstream_not_json' : /too_large/.test(msg) ? 'image_too_large' : 'upstream_unreachable' }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 502, reason: 'upstream_not_json' }
    const got = decodeTxdotSnippet(body.snippet)
    if (!got.ok) return { ok: false, status: 502, reason: got.reason }
    return { ok: true, bytes: got.bytes, content_type: 'image/jpeg', captured_at: parseTxdotTimestamp(body.timestampFormatted) }
  },
}
