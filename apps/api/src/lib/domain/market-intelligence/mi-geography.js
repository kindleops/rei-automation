/**
 * MARKET INTELLIGENCE: the canonical geography model (brief §5, §6).
 *
 * Stable ids, never ambiguous strings:
 *   nation:US · state:TX · market:<canonical_markets.id> · county:TX:dallas
 *   city:TX:dallas · zip:75217
 *
 * Membership (how a sale belongs to an area):
 *   zip     the sale's recorded 5-digit ZIP
 *   city    the sale's recorded city within its state
 *   county  the ZIP's county: census ZCTA cell first, else the ZIP's
 *           parcel-majority county (comp_properties)
 *   market  the ZIP's market_zip_membership row (canonical market authority).
 *           Never hull containment.
 *   state   the sale's state
 *
 * Geometry is what we own: ZIP and state polygons (US Census TIGER).
 * Counties, cities and markets have a centroid and bbox but NO polygon, and say so.
 */
export const STATE_NAMES = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine',
  MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
})
export const LEVEL_ORDER = Object.freeze(['nation', 'state', 'market', 'county', 'city', 'zip'])
export const LEVEL_LABEL = Object.freeze({ nation: 'Nationwide', state: 'State', market: 'Market', county: 'County', city: 'City', zip: 'ZIP' })

const clean = (v) => String(v ?? '').trim()
export const normName = (v) => clean(v).toLowerCase().replace(/^saint\b/, 'st').replace(/^st\.\s*/, 'st ').replace(/[.,']/g, '').replace(/\s+/g, ' ').trim()
export const titleCase = (v) => clean(v).toLowerCase().replace(/(^|[\s\-/'.(])([a-z])/g, (_, a, b) => a + b.toUpperCase())

/** Parse a geography id → { level, key, state?, name? } or null. */
export function parseGeoId(id) {
  const s = clean(id)
  if (s === 'nation:US') return { level: 'nation', key: 'US' }
  let m = /^state:([A-Z]{2})$/.exec(s)
  if (m) return { level: 'state', key: m[1], state: m[1] }
  m = /^zip:(\d{5})$/.exec(s)
  if (m) return { level: 'zip', key: m[1] }
  m = /^market:([a-z0-9-]+)$/.exec(s)
  if (m) return { level: 'market', key: m[1] }
  m = /^(county|city):([A-Z]{2}):(.+)$/.exec(s)
  if (m) return { level: m[1], key: `${m[2]}:${m[3]}`, state: m[2], name: m[3] }
  return null
}

const bboxOf = (a) => (a && [a.min_lng, a.min_lat, a.max_lng, a.max_lat].every((v) => Number.isFinite(Number(v)))
  ? [Number(a.min_lng), Number(a.min_lat), Number(a.max_lng), Number(a.max_lat)] : null)
const centerOf = (a) => (a && Number.isFinite(Number(a.center_lng)) && Number.isFinite(Number(a.center_lat)) ? [Number(a.center_lng), Number(a.center_lat)] : null)
const unionBox = (boxes) => {
  const b = boxes.filter(Boolean)
  if (!b.length) return null
  return [Math.min(...b.map((x) => x[0])), Math.min(...b.map((x) => x[1])), Math.max(...b.map((x) => x[2])), Math.max(...b.map((x) => x[3]))]
}
const majority = (counts) => { let best = null; let bn = -1; for (const [k, n] of counts) if (n > bn) { best = k; bn = n } return best }

/**
 * Build the catalog. Pure given its inputs (tests pass fixtures).
 *   index        the sales index (dicts, cols, byZip)
 *   aux.searchAreas      mv_map_search_areas rows (no outline)
 *   aux.markets          canonical_markets rows {id, display_name, state}
 *   aux.zipMarket        market_zip_membership rows {zip5, state, canonical_market_id}
 *   aux.aliases          market_aliases rows {alias, state, canonical_market_id}
 *   aux.censusZipCounty  [{zip, state, county_key, county_name}] from census ZIP cells
 *   aux.parcelZipCounty  [{zip, state, county, n}] from comp_properties
 *   aux.outlined         { zip: Set<zip>, state: Set<ST> } polygons we own
 */
export function buildGeographyCatalog(index, aux = {}) {
  const nodes = new Map()
  const areas = new Map((aux.searchAreas || []).map((a) => [`${a.kind}|${a.key}`, a]))
  const outlinedZip = aux.outlined?.zip || new Set()
  const outlinedState = aux.outlined?.state || new Set()
  const put = (n) => { nodes.set(n.id, n); return n }
  const nZips = index.dicts.zips.length

  // ── per-ZIP facts from sales ──
  const zipState = new Array(nZips).fill(null)
  const zipCity = new Int32Array(nZips).fill(-1)
  const zipSales = new Int32Array(nZips)
  const zipBox = new Array(nZips).fill(null)
  for (let z = 0; z < nZips; z += 1) {
    const a = index.byZip.offsets[z]; const b = index.byZip.offsets[z + 1]
    zipSales[z] = b - a
    const st = new Map(); const ct = new Map()
    let w = Infinity; let s = Infinity; let e = -Infinity; let nn = -Infinity
    for (let j = a; j < b; j += 1) {
      const i = index.byZip.rows[j]
      st.set(index.cols.state[i], (st.get(index.cols.state[i]) || 0) + 1)
      if (index.cols.city[i] >= 0) ct.set(index.cols.city[i], (ct.get(index.cols.city[i]) || 0) + 1)
      const la = index.cols.lat[i]; const lo = index.cols.lng[i]
      if (Number.isFinite(la) && Number.isFinite(lo)) { if (lo < w) w = lo; if (lo > e) e = lo; if (la < s) s = la; if (la > nn) nn = la }
    }
    const sk = majority(st)
    zipState[z] = sk === null ? null : index.dicts.states[sk]
    const ck = majority(ct)
    zipCity[z] = ck === null ? -1 : ck
    zipBox[z] = Number.isFinite(w) ? [w, s, e, nn] : null
  }

  // ── counties: census ZIP cell first, else the parcel majority ──
  const zipCountyKey = new Map()
  for (const r of aux.censusZipCounty || []) if (r.zip && r.county_key) zipCountyKey.set(r.zip, { key: r.county_key, name: r.county_name, via: 'census' })
  const parcel = new Map()
  for (const r of aux.parcelZipCounty || []) {
    if (!r.zip || !r.county) continue
    const cur = parcel.get(r.zip)
    if (!cur || r.n > cur.n) parcel.set(r.zip, { key: `${clean(r.state).toUpperCase()}:${normCounty(r.county)}`, name: titleCase(r.county), n: r.n })
  }
  for (const [zip, v] of parcel) if (!zipCountyKey.has(zip)) zipCountyKey.set(zip, { key: v.key, name: v.name, via: 'parcel_majority' })

  // ── markets ──
  const marketIdBySlug = new Map()
  const markets = (aux.markets || []).map((m) => ({ id: m.id, name: m.display_name, state: clean(m.state).toUpperCase() }))
  markets.forEach((m, i) => marketIdBySlug.set(m.id, i))
  const zipMarketSlug = new Map((aux.zipMarket || []).map((r) => [clean(r.zip5), r.canonical_market_id]))

  // Membership arrays over sales ZIP indexes.
  const countyKeys = []
  const countyOrd = new Map()
  const zipCounty = new Int32Array(nZips).fill(-1)
  const zipMarket = new Int32Array(nZips).fill(-1)
  index.dicts.zips.forEach((zip, z) => {
    const c = zipCountyKey.get(zip)
    if (c) {
      let o = countyOrd.get(c.key)
      if (o === undefined) { o = countyKeys.length; countyOrd.set(c.key, o); countyKeys.push(c.key) }
      zipCounty[z] = o
    }
    const slug = zipMarketSlug.get(zip)
    if (slug && marketIdBySlug.has(slug)) zipMarket[z] = marketIdBySlug.get(slug)
  })

  // ── nodes ──
  const nation = put({ id: 'nation:US', level: 'nation', key: 'US', name: 'United States', label: 'Nationwide', state: null, parent_id: null, parents: {}, centroid: [-96.5, 38.5], bbox: [-125, 24, -66.5, 49.5], geometry: 'none', aliases: ['usa', 'us', 'national', 'nationwide', 'united states'], sources: ['sales'] })
  nation.coverage = { sales: index.n }

  const stateCodes = new Set([...index.dicts.states, ...(aux.searchAreas || []).filter((a) => a.kind === 'state').map((a) => a.key)])
  for (const st of stateCodes) {
    const a = areas.get(`state|${st}`)
    const si = index.lookup.state.get(st)
    put({ id: `state:${st}`, level: 'state', key: st, name: STATE_NAMES[st] || st, label: STATE_NAMES[st] ? `${STATE_NAMES[st]} (${st})` : st, state: st, parent_id: 'nation:US', parents: { nation: 'nation:US' },
      centroid: centerOf(a), bbox: bboxOf(a), geometry: outlinedState.has(st) ? 'census_state' : 'none', aliases: [st.toLowerCase(), normName(STATE_NAMES[st] || st)], sources: [si !== undefined ? 'sales' : null, a ? 'properties' : null].filter(Boolean),
      coverage: { sales: si === undefined ? 0 : index.byState.offsets[si + 1] - index.byState.offsets[si], properties: a ? Number(a.n) || 0 : 0 } })
  }

  const marketZips = markets.map(() => [])
  for (let z = 0; z < nZips; z += 1) if (zipMarket[z] >= 0) marketZips[zipMarket[z]].push(z)
  const aliasByMarket = new Map()
  for (const al of aux.aliases || []) {
    if (!al.canonical_market_id) continue
    const list = aliasByMarket.get(al.canonical_market_id) || []
    list.push(normName(al.alias))
    aliasByMarket.set(al.canonical_market_id, list)
  }
  markets.forEach((m, i) => {
    const a = areas.get(`market|${m.name}`)
    const zs = marketZips[i]
    put({ id: `market:${m.id}`, level: 'market', key: m.id, name: m.name, label: m.name, state: m.state, parent_id: `state:${m.state}`, parents: { nation: 'nation:US', state: `state:${m.state}` },
      centroid: centerOf(a), bbox: bboxOf(a) || unionBox(zs.map((z) => zipBox[z])), geometry: 'none',
      aliases: [...new Set([normName(m.name), normName(m.name.split(',')[0]), ...(aliasByMarket.get(m.id) || [])])], sources: ['canonical_markets', zs.length ? 'sales' : null].filter(Boolean),
      coverage: { sales: zs.reduce((t, z) => t + zipSales[z], 0), properties: a ? Number(a.n) || 0 : 0, zips: zs.length } })
  })

  const countyZips = countyKeys.map(() => [])
  for (let z = 0; z < nZips; z += 1) if (zipCounty[z] >= 0) countyZips[zipCounty[z]].push(z)
  const countyName = new Map()
  for (const v of zipCountyKey.values()) if (!countyName.has(v.key)) countyName.set(v.key, v.name)
  const countyAll = new Set([...countyKeys, ...(aux.searchAreas || []).filter((a) => a.kind === 'county').map((a) => a.key)])
  for (const ck of countyAll) {
    const [st, nm] = ck.split(':')
    const a = areas.get(`county|${ck}`)
    const o = countyOrd.get(ck)
    const zs = o === undefined ? [] : countyZips[o]
    const name = titleCase(countyName.get(ck) || nm)
    const mkVotes = new Map()
    for (const z of zs) if (zipMarket[z] >= 0) mkVotes.set(zipMarket[z], (mkVotes.get(zipMarket[z]) || 0) + zipSales[z])
    const mk = majority(mkVotes)
    put({ id: `county:${ck}`, level: 'county', key: ck, name: `${name} County`, label: `${name} County, ${st}`, state: st, parent_id: `state:${st}`,
      parents: { nation: 'nation:US', state: `state:${st}`, ...(mk !== null ? { market: `market:${markets[mk].id}` } : {}) },
      centroid: centerOf(a), bbox: bboxOf(a) || unionBox(zs.map((z) => zipBox[z])), geometry: 'none', aliases: [normName(`${name} county`), normName(name)],
      sources: [zs.length ? 'sales' : null, a ? 'properties' : null].filter(Boolean), coverage: { sales: zs.reduce((t, z) => t + zipSales[z], 0), properties: a ? Number(a.n) || 0 : 0, zips: zs.length } })
  }

  // Cities: from sales (recorded city) and the property universe.
  const cityZips = new Map()
  for (let z = 0; z < nZips; z += 1) if (zipCity[z] >= 0) { const l = cityZips.get(zipCity[z]) || []; l.push(z); cityZips.set(zipCity[z], l) }
  const cityAll = new Set([...index.dicts.cities, ...(aux.searchAreas || []).filter((a) => a.kind === 'city').map((a) => a.key)])
  for (const key of cityAll) {
    const [st, raw] = [key.slice(0, 2), key.slice(3)]
    const a = areas.get(`city|${key}`)
    const ci = index.lookup.city.get(key)
    const zs = ci === undefined ? [] : cityZips.get(ci) || []
    const name = titleCase(raw)
    const ctyVotes = new Map(); const mkVotes = new Map()
    for (const z of zs) { if (zipCounty[z] >= 0) ctyVotes.set(zipCounty[z], (ctyVotes.get(zipCounty[z]) || 0) + zipSales[z]); if (zipMarket[z] >= 0) mkVotes.set(zipMarket[z], (mkVotes.get(zipMarket[z]) || 0) + zipSales[z]) }
    const cty = majority(ctyVotes); const mk = majority(mkVotes)
    const sales = ci === undefined ? 0 : index.byCity.offsets[ci + 1] - index.byCity.offsets[ci]
    put({ id: `city:${key}`, level: 'city', key, name, label: `${name}, ${st}`, state: st, parent_id: cty !== null ? `county:${countyKeys[cty]}` : `state:${st}`,
      parents: { nation: 'nation:US', state: `state:${st}`, ...(cty !== null ? { county: `county:${countyKeys[cty]}` } : {}), ...(mk !== null ? { market: `market:${markets[mk].id}` } : {}) },
      centroid: centerOf(a), bbox: bboxOf(a) || unionBox(zs.map((z) => zipBox[z])), geometry: 'none', aliases: [normName(name)],
      sources: [sales ? 'sales' : null, a ? 'properties' : null].filter(Boolean), coverage: { sales, properties: a ? Number(a.n) || 0 : 0 } })
  }

  const zipAll = new Set([...index.dicts.zips, ...(aux.searchAreas || []).filter((a) => a.kind === 'zip').map((a) => a.key)])
  for (const zip of zipAll) {
    const z = index.lookup.zip.get(zip)
    const a = areas.get(`zip|${zip}`)
    const st = (z !== undefined ? zipState[z] : null) || clean(a?.state).toUpperCase() || null
    const cityKey = z !== undefined && zipCity[z] >= 0 ? index.dicts.cities[zipCity[z]] : null
    const ck = z !== undefined && zipCounty[z] >= 0 ? countyKeys[zipCounty[z]] : zipCountyKey.get(zip)?.key || null
    const mi = z !== undefined ? zipMarket[z] : (zipMarketSlug.has(zip) ? marketIdBySlug.get(zipMarketSlug.get(zip)) ?? -1 : -1)
    put({ id: `zip:${zip}`, level: 'zip', key: zip, name: zip, label: cityKey ? `${zip} · ${titleCase(cityKey.slice(3))}, ${st}` : `${zip}${st ? `, ${st}` : ''}`, state: st,
      parent_id: cityKey ? `city:${cityKey}` : ck ? `county:${ck}` : st ? `state:${st}` : 'nation:US',
      parents: { nation: 'nation:US', ...(st ? { state: `state:${st}` } : {}), ...(ck ? { county: `county:${ck}` } : {}), ...(cityKey ? { city: `city:${cityKey}` } : {}), ...(mi >= 0 ? { market: `market:${markets[mi].id}` } : {}) },
      centroid: centerOf(a) || (z !== undefined && zipBox[z] ? [(zipBox[z][0] + zipBox[z][2]) / 2, (zipBox[z][1] + zipBox[z][3]) / 2] : null),
      bbox: bboxOf(a) || (z !== undefined ? zipBox[z] : null), geometry: outlinedZip.has(zip) ? 'census_zcta' : 'none', aliases: [zip],
      county_via: zipCountyKey.get(zip)?.via || null,
      sources: [z !== undefined ? 'sales' : null, a ? 'properties' : null].filter(Boolean), coverage: { sales: z === undefined ? 0 : zipSales[z], properties: a ? Number(a.n) || 0 : 0 } })
  }

  // Selectors: how to find a geography's sale rows.
  const countyZipList = new Map(countyKeys.map((k, o) => [k, countyZips[o]]))
  const marketZipList = new Map(markets.map((m, i) => [m.id, marketZips[i]]))
  function selectorFor(id) {
    const g = parseGeoId(id)
    if (!g) return null
    if (g.level === 'nation') return { all: true }
    if (g.level === 'state') return { buckets: [['byState', index.lookup.state.get(g.key) ?? -1]] }
    if (g.level === 'zip') return { buckets: [['byZip', index.lookup.zip.get(g.key) ?? -1]] }
    if (g.level === 'city') return { buckets: [['byCity', index.lookup.city.get(g.key) ?? -1]] }
    if (g.level === 'county') return { buckets: (countyZipList.get(g.key) || []).map((z) => ['byZip', z]) }
    if (g.level === 'market') return { buckets: (marketZipList.get(g.key) || []).map((z) => ['byZip', z]) }
    return null
  }
  /** Child key for a row at a level, and the id for a child key. */
  const child = {
    state: { of: (i) => index.cols.state[i], id: (k) => `state:${index.dicts.states[k]}` },
    market: { of: (i) => (index.cols.zip[i] >= 0 ? zipMarket[index.cols.zip[i]] : -1), id: (k) => `market:${markets[k].id}` },
    county: { of: (i) => (index.cols.zip[i] >= 0 ? zipCounty[index.cols.zip[i]] : -1), id: (k) => `county:${countyKeys[k]}` },
    city: { of: (i) => index.cols.city[i], id: (k) => `city:${index.dicts.cities[k]}` },
    zip: { of: (i) => index.cols.zip[i], id: (k) => `zip:${index.dicts.zips[k]}` },
  }
  const membershipCoverage = {
    sales_with_zip: zipSales.reduce((t, v) => t + v, 0),
    sales_with_county: [...countyZipList.values()].flat().reduce((t, z) => t + zipSales[z], 0),
    sales_with_market: [...marketZipList.values()].flat().reduce((t, z) => t + zipSales[z], 0),
    sales_total: index.n,
  }
  return { nodes, selectorFor, child, membershipCoverage, get: (id) => nodes.get(id) || null }
}

function normCounty(v) {
  return clean(v).toLowerCase().replace(/\s+(county|parish|borough)$/, '').replace(/\s+/g, ' ')
}

// ── Search ────────────────────────────────────────────────────────────────

const LEVEL_BOOST = { state: 9, market: 8, city: 6, county: 5, zip: 4, nation: 2 }

/**
 * Typed geography search: "55411", "Dallas", "Harris County", "Minneapolis",
 * "Texas", "dallas tx". Pure. Returns ranked matches. `ambiguous` is set when
 * the best name matches more than one level or state, so the UI lists them all
 * and never silently picks one.
 */
export function searchGeographies(catalog, query, { limit = 12 } = {}) {
  const raw = clean(query)
  if (!raw) return { query: raw, results: [], ambiguous: false }
  let q = normName(raw)
  let stateHint = null
  const tail = /^(.*?)[\s,]+([a-z]{2})$/.exec(q)
  if (tail && STATE_NAMES[tail[2].toUpperCase()] && tail[1].length >= 2) { q = tail[1].trim(); stateHint = tail[2].toUpperCase() }
  const out = []
  if (/^\d{3,5}$/.test(q)) {
    for (const n of catalog.nodes.values()) {
      if (n.level !== 'zip') continue
      if (n.key === q) out.push({ n, score: 200 })
      else if (q.length < 5 && n.key.startsWith(q)) out.push({ n, score: 120 })
    }
  } else {
    const countyAsk = /\bcounty$/.test(q)
    const bare = q.replace(/\s+county$/, '')
    for (const n of catalog.nodes.values()) {
      if (n.level === 'zip') continue
      if (stateHint && n.state && n.state !== stateHint) continue
      if (countyAsk && n.level !== 'county') continue
      const names = [normName(n.name), ...(n.aliases || [])]
      let s = 0
      for (const nm of names) {
        if (!nm) continue
        if (nm === q || nm === bare) s = Math.max(s, 100)
        else if (nm.startsWith(q) || (countyAsk && nm.startsWith(bare))) s = Math.max(s, 70)
        else if (q.length >= 3 && nm.includes(q)) s = Math.max(s, 40)
      }
      if (n.level === 'state' && (n.key.toLowerCase() === q)) s = Math.max(s, 110)
      if (s) out.push({ n, score: s })
    }
  }
  const weight = (n) => Math.log10(1 + (n.coverage?.sales || 0) + (n.coverage?.properties || 0))
  out.sort((a, b) => (b.score - a.score) || (LEVEL_BOOST[b.n.level] - LEVEL_BOOST[a.n.level]) || (weight(b.n) - weight(a.n)) || a.n.label.localeCompare(b.n.label))
  const top = out[0]?.score ?? 0
  const best = out.filter((x) => x.score === top)
  const ambiguous = best.length > 1 && new Set(best.map((x) => `${x.n.level}|${x.n.state}`)).size > 1
  return { query: raw, state_hint: stateHint, ambiguous, results: out.slice(0, limit).map(({ n, score }) => ({ ...summaryOf(n), match: score >= 100 ? 'exact' : score >= 70 ? 'prefix' : 'contains' })) }
}

export function summaryOf(n) {
  return { id: n.id, level: n.level, level_label: LEVEL_LABEL[n.level], name: n.name, label: n.label, state: n.state, parent_id: n.parent_id, parents: n.parents, centroid: n.centroid, bbox: n.bbox, geometry: n.geometry, coverage: n.coverage }
}
