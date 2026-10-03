/**
 * TxDOT ITS — Texas district camera inventory (positions, roads, status).
 *
 * Source: https://its.txdot.gov/its/DistrictIts/GetCctvStatusListByDistrict?districtCode={code}
 * — the JSON TxDOT's own public district camera pages load (no key, no login).
 * It is NOT a documented developer API, and TxDOT's terms are silent on reuse
 * of camera imagery; the stills exist only as base64 inside internal JSON.
 * So this provider is LINK-ONLY: the Map draws where TxDOT's cameras are, what
 * road and direction they watch and whether TxDOT reports them online, and an
 * operator opens the picture on TxDOT's own page. No TxDOT image is fetched,
 * proxied or re-encoded by LeadCommand until TxDOT grants permission (a C2C /
 * data-sharing agreement) — see docs/cameras/discovery/priority-states.md.
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
      feed_type: 'PROVIDER_PAGE_ONLY',
      provider_page_url: txdotDistrictPage(district),
      city: TXDOT_DISTRICTS[district] || null,
      metadata: { district, has_snapshot: raw.hasSnapshot === true },
    }
  },
}
