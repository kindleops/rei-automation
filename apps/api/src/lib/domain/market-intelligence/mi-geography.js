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

/** Raw-index facts (dev fallback): per-ZIP majority state/city, sales, bounds; city and state sales. */
export function factsFromIndex(index) {
  const zips = []
  for (let z = 0; z < index.dicts.zips.length; z += 1) {
    const a = index.byZip.offsets[z]; const b = index.byZip.offsets[z + 1]
    const st = new Map(); const ct = new Map()
    let w = Infinity; let s = Infinity; let e = -Infinity; let nn = -Infinity
    for (let j = a; j < b; j += 1) {
      const i = index.byZip.rows[j]
      st.set(index.cols.state[i], (st.get(index.cols.state[i]) || 0) + 1)
      if (index.cols.city[i] >= 0) ct.set(index.cols.city[i], (ct.get(index.cols.city[i]) || 0) + 1)
      const la = index.cols.lat[i]; const lo = index.cols.lng[i]
      if (Number.isFinite(la) && Number.isFinite(lo)) { if (lo < w) w = lo; if (lo > e) e = lo; if (la < s) s = la; if (la > nn) nn = la }
    }
    const sk = majority(st); const ck = majority(ct)
    zips.push({ zip: index.dicts.zips[z], state: sk === null ? null : index.dicts.states[sk], cityKey: ck === null ? null : index.dicts.cities[ck], sales: b - a, bbox: Number.isFinite(w) ? [w, s, e, nn] : null })
  }
  const count = (csr, k) => csr.offsets[k + 1] - csr.offsets[k]
  return {
    zips,
    cities: new Map(index.dicts.cities.map((key, k) => [key, count(index.byCity, k)])),
    states: new Map(index.dicts.states.map((st, k) => [st, count(index.byState, k)])),
    total: index.n,
  }
}

/** Summary facts: mi_zip_geo rows + the city / state 'all'-period rows of the summary. */
export function factsFromSummary(zipGeo, cityRows, stateRows, total) {
  const box = (r) => ([r.min_lng, r.min_lat, r.max_lng, r.max_lat].every((v) => v !== null && v !== undefined && Number.isFinite(Number(v))) ? [Number(r.min_lng), Number(r.min_lat), Number(r.max_lng), Number(r.max_lat)] : null)
  return {
    zips: zipGeo.filter((r) => Number(r.sales_n) > 0).map((r) => ({ zip: r.zip, state: r.state, cityKey: r.city_key, sales: Number(r.sales_n), bbox: box(r) })),
    cities: new Map(cityRows.map((r) => [r.geo_key, Number(r.sale_count) || 0])),
    states: new Map(stateRows.map((r) => [r.geo_key, Number(r.sale_count) || 0])),
    total: Number(total) || 0,
  }
}

/**
 * Build the catalog. Pure given its inputs (tests pass fixtures).
 *   facts                factsFromIndex() or factsFromSummary()
 *   aux.searchAreas      mv_map_search_areas rows (no outline)
 *   aux.markets          canonical_markets rows {id, display_name, state}
 *   aux.zipMarket        [{zip5, canonical_market_id}] (summary: from mi_zip_geo)
 *   aux.aliases          market_aliases rows {alias, state, canonical_market_id}
 *   aux.zipCounty        [{zip, key, name, via}] resolved counties (summary: mi_zip_geo), else
 *   aux.censusZipCounty  [{zip, state, county_key, county_name}] and
 *   aux.parcelZipCounty  [{zip, state, county, n}] (raw dev path)
 *   aux.outlined         { zip: Set<zip>, state: Set<ST> } polygons we own
 */
export function buildGeographyCatalog(facts, aux = {}) {
  const nodes = new Map()
  const areas = new Map((aux.searchAreas || []).map((a) => [`${a.kind}|${a.key}`, a]))
  const outlinedZip = aux.outlined?.zip || new Set()
  const outlinedState = aux.outlined?.state || new Set()
  const put = (n) => { nodes.set(n.id, n); return n }
  const zipFacts = new Map(facts.zips.map((z) => [z.zip, z]))

  // ── counties ──
  const zipCountyKey = new Map()
  if (aux.zipCounty) {
    for (const r of aux.zipCounty) if (r.zip && r.key) zipCountyKey.set(r.zip, { key: r.key, name: r.name || titleCase(r.key.slice(3)), via: r.via || null })
  } else {
    for (const r of aux.censusZipCounty || []) if (r.zip && r.county_key) zipCountyKey.set(r.zip, { key: r.county_key, name: r.county_name, via: 'census' })
    const parcel = new Map()
    for (const r of aux.parcelZipCounty || []) {
      if (!r.zip || !r.county) continue
      const cur = parcel.get(r.zip)
      if (!cur || r.n > cur.n) parcel.set(r.zip, { key: `${clean(r.state).toUpperCase()}:${normCounty(r.county)}`, name: titleCase(normCounty(r.county)), n: r.n })
    }
    for (const [zip, v] of parcel) if (!zipCountyKey.has(zip)) zipCountyKey.set(zip, { key: v.key, name: v.name, via: 'parcel_majority' })
  }

  // ── markets ──
  const markets = (aux.markets || []).map((m) => ({ id: m.id, name: m.display_name, state: clean(m.state).toUpperCase() }))
  const marketById = new Map(markets.map((m) => [m.id, m]))
  const zipMarketSlug = new Map()
  for (const r of aux.zipMarket || []) { const z = clean(r.zip5); if (z && marketById.has(r.canonical_market_id)) zipMarketSlug.set(z, r.canonical_market_id) }

  const zipCounty = new Map([...zipCountyKey].map(([z, v]) => [z, v.key]))
  const salesOf = (zips) => zips.reduce((t, z) => t + (zipFacts.get(z)?.sales || 0), 0)
  const boxOf = (zips) => unionBox(zips.map((z) => zipFacts.get(z)?.bbox))

  // ── nation / states ──
  put({ id: 'nation:US', level: 'nation', key: 'US', name: 'United States', label: 'Nationwide', state: null, parent_id: null, parents: {}, centroid: [-96.5, 38.5], bbox: [-125, 24, -66.5, 49.5], geometry: 'none', aliases: ['usa', 'us', 'national', 'nationwide', 'united states'], sources: ['sales'], coverage: { sales: facts.total } })
  const stateCodes = new Set([...facts.states.keys(), ...(aux.searchAreas || []).filter((a) => a.kind === 'state').map((a) => a.key)])
  for (const st of stateCodes) {
    const a = areas.get(`state|${st}`)
    const sales = facts.states.get(st) || 0
    put({ id: `state:${st}`, level: 'state', key: st, name: STATE_NAMES[st] || st, label: STATE_NAMES[st] ? `${STATE_NAMES[st]} (${st})` : st, state: st, parent_id: 'nation:US', parents: { nation: 'nation:US' },
      centroid: centerOf(a), bbox: bboxOf(a), geometry: outlinedState.has(st) ? 'census_state' : 'none', aliases: [st.toLowerCase(), normName(STATE_NAMES[st] || st)], sources: [sales ? 'sales' : null, a ? 'properties' : null].filter(Boolean),
      coverage: { sales, properties: a ? Number(a.n) || 0 : 0 } })
  }

  // ── markets ──
  const marketZips = new Map(markets.map((m) => [m.id, []]))
  for (const [z, slug] of zipMarketSlug) if (zipFacts.has(z)) marketZips.get(slug).push(z)
  const aliasByMarket = new Map()
  for (const al of aux.aliases || []) {
    if (!al.canonical_market_id) continue
    const list = aliasByMarket.get(al.canonical_market_id) || []
    list.push(normName(al.alias))
    aliasByMarket.set(al.canonical_market_id, list)
  }
  for (const m of markets) {
    const a = areas.get(`market|${m.name}`)
    const zs = marketZips.get(m.id)
    put({ id: `market:${m.id}`, level: 'market', key: m.id, name: m.name, label: m.name, state: m.state, parent_id: `state:${m.state}`, parents: { nation: 'nation:US', state: `state:${m.state}` },
      centroid: centerOf(a), bbox: bboxOf(a) || boxOf(zs), geometry: 'none',
      aliases: [...new Set([normName(m.name), normName(m.name.split(',')[0]), ...(aliasByMarket.get(m.id) || [])])], sources: ['canonical_markets', zs.length ? 'sales' : null].filter(Boolean),
      coverage: { sales: salesOf(zs), properties: a ? Number(a.n) || 0 : 0, zips: zs.length } })
  }

  // ── counties ──
  const countyZips = new Map()
  for (const z of zipFacts.keys()) { const k = zipCounty.get(z); if (k) { const l = countyZips.get(k) || []; l.push(z); countyZips.set(k, l) } }
  const countyName = new Map()
  for (const v of zipCountyKey.values()) if (!countyName.has(v.key)) countyName.set(v.key, v.name)
  const majorityBy = (zs, keyOf) => { const votes = new Map(); for (const z of zs) { const k = keyOf(z); if (k) votes.set(k, (votes.get(k) || 0) + (zipFacts.get(z)?.sales || 0)) } return majority(votes) }
  const countyAll = new Set([...countyZips.keys(), ...(aux.searchAreas || []).filter((a) => a.kind === 'county').map((a) => a.key)])
  for (const ck of countyAll) {
    const st = ck.slice(0, 2); const nm = ck.slice(3)
    const a = areas.get(`county|${ck}`)
    const zs = countyZips.get(ck) || []
    const name = titleCase(countyName.get(ck) || nm)
    const mk = majorityBy(zs, (z) => zipMarketSlug.get(z))
    put({ id: `county:${ck}`, level: 'county', key: ck, name: `${name} County`, label: `${name} County, ${st}`, state: st, parent_id: `state:${st}`,
      parents: { nation: 'nation:US', state: `state:${st}`, ...(mk ? { market: `market:${mk}` } : {}) },
      centroid: centerOf(a), bbox: bboxOf(a) || boxOf(zs), geometry: 'none', aliases: [normName(`${name} county`), normName(name)],
      sources: [zs.length ? 'sales' : null, a ? 'properties' : null].filter(Boolean), coverage: { sales: salesOf(zs), properties: a ? Number(a.n) || 0 : 0, zips: zs.length } })
  }

  // ── cities ──
  const cityZips = new Map()
  for (const z of facts.zips) if (z.cityKey) { const l = cityZips.get(z.cityKey) || []; l.push(z.zip); cityZips.set(z.cityKey, l) }
  const cityAll = new Set([...facts.cities.keys(), ...(aux.searchAreas || []).filter((a) => a.kind === 'city').map((a) => a.key)])
  for (const key of cityAll) {
    const st = key.slice(0, 2); const raw = key.slice(3)
    const a = areas.get(`city|${key}`)
    const zs = cityZips.get(key) || []
    const name = titleCase(raw)
    const cty = majorityBy(zs, (z) => zipCounty.get(z)); const mk = majorityBy(zs, (z) => zipMarketSlug.get(z))
    const sales = facts.cities.get(key) || 0
    put({ id: `city:${key}`, level: 'city', key, name, label: `${name}, ${st}`, state: st, parent_id: cty ? `county:${cty}` : `state:${st}`,
      parents: { nation: 'nation:US', state: `state:${st}`, ...(cty ? { county: `county:${cty}` } : {}), ...(mk ? { market: `market:${mk}` } : {}) },
      centroid: centerOf(a), bbox: bboxOf(a) || boxOf(zs), geometry: 'none', aliases: [normName(name)],
      sources: [sales ? 'sales' : null, a ? 'properties' : null].filter(Boolean), coverage: { sales, properties: a ? Number(a.n) || 0 : 0 } })
  }

  // ── ZIPs ──
  const zipAll = new Set([...zipFacts.keys(), ...(aux.searchAreas || []).filter((a) => a.kind === 'zip').map((a) => a.key)])
  for (const zip of zipAll) {
    const f = zipFacts.get(zip)
    const a = areas.get(`zip|${zip}`)
    const st = f?.state || clean(a?.state).toUpperCase() || null
    const cityKey = f?.cityKey || null
    const ck = zipCounty.get(zip) || null
    const mk = zipMarketSlug.get(zip) || null
    put({ id: `zip:${zip}`, level: 'zip', key: zip, name: zip, label: cityKey ? `${zip} · ${titleCase(cityKey.slice(3))}, ${st}` : `${zip}${st ? `, ${st}` : ''}`, state: st,
      parent_id: cityKey ? `city:${cityKey}` : ck ? `county:${ck}` : st ? `state:${st}` : 'nation:US',
      parents: { nation: 'nation:US', ...(st ? { state: `state:${st}` } : {}), ...(ck ? { county: `county:${ck}` } : {}), ...(cityKey ? { city: `city:${cityKey}` } : {}), ...(mk ? { market: `market:${mk}` } : {}) },
      centroid: centerOf(a) || (f?.bbox ? [(f.bbox[0] + f.bbox[2]) / 2, (f.bbox[1] + f.bbox[3]) / 2] : null),
      bbox: bboxOf(a) || f?.bbox || null, geometry: outlinedZip.has(zip) ? 'census_zcta' : 'none', aliases: [zip],
      county_via: zipCountyKey.get(zip)?.via || null,
      sources: [f ? 'sales' : null, a ? 'properties' : null].filter(Boolean), coverage: { sales: f?.sales || 0, properties: a ? Number(a.n) || 0 : 0 } })
  }

  const levelNodes = Object.fromEntries(LEVEL_ORDER.map((lv) => [lv, []]))
  for (const n of nodes.values()) levelNodes[n.level].push(n)
  const membershipCoverage = {
    sales_with_zip: salesOf([...zipFacts.keys()]),
    sales_with_county: salesOf([...zipFacts.keys()].filter((z) => zipCounty.has(z))),
    sales_with_market: salesOf([...zipFacts.keys()].filter((z) => zipMarketSlug.has(z))),
    sales_total: facts.total,
  }
  return {
    nodes, levelNodes, membershipCoverage, zipCounty, zipMarket: zipMarketSlug,
    marketZips: new Map([...marketZips].map(([k, v]) => [k, v])),
    get: (id) => nodes.get(id) || null,
    /** Children of a parent at a level, by membership (ZIP → its majority city / county / market). */
    childrenOf(level, parentId) {
      const parent = nodes.get(parentId)
      if (!parent) return []
      const list = levelNodes[level] || []
      if (parent.level === 'nation') return list
      return list.filter((n) => n.parents?.[parent.level] === parentId || (parent.level === 'state' && n.state === parent.key))
    },
  }
}

/** Raw-index accessors (dev fallback only): row selectors and per-row child keys. */
export function rawAccessors(index, catalog) {
  const nZ = index.dicts.zips.length
  const countyKeys = []; const countyOrd = new Map(); const marketKeys = []; const marketOrd = new Map()
  const zipCountyIdx = new Int32Array(nZ).fill(-1); const zipMarketIdx = new Int32Array(nZ).fill(-1)
  index.dicts.zips.forEach((zip, z) => {
    const ck = catalog.zipCounty.get(zip)
    if (ck) { let o = countyOrd.get(ck); if (o === undefined) { o = countyKeys.length; countyOrd.set(ck, o); countyKeys.push(ck) } zipCountyIdx[z] = o }
    const mk = catalog.zipMarket.get(zip)
    if (mk) { let o = marketOrd.get(mk); if (o === undefined) { o = marketKeys.length; marketOrd.set(mk, o); marketKeys.push(mk) } zipMarketIdx[z] = o }
  })
  const zipsWhere = (pred) => index.dicts.zips.map((zip, z) => [zip, z]).filter(([zip]) => pred(zip)).map(([, z]) => ['byZip', z])
  function selectorFor(id) {
    const g = parseGeoId(id)
    if (!g) return null
    if (g.level === 'nation') return { all: true }
    if (g.level === 'state') return { buckets: [['byState', index.lookup.state.get(g.key) ?? -1]] }
    if (g.level === 'zip') return { buckets: [['byZip', index.lookup.zip.get(g.key) ?? -1]] }
    if (g.level === 'city') return { buckets: [['byCity', index.lookup.city.get(g.key) ?? -1]] }
    if (g.level === 'county') return { buckets: zipsWhere((zip) => catalog.zipCounty.get(zip) === g.key) }
    if (g.level === 'market') return { buckets: zipsWhere((zip) => catalog.zipMarket.get(zip) === g.key) }
    return null
  }
  const child = {
    nation: { of: () => 0, id: () => 'nation:US' },
    state: { of: (i) => index.cols.state[i], id: (k) => `state:${index.dicts.states[k]}` },
    market: { of: (i) => (index.cols.zip[i] >= 0 ? zipMarketIdx[index.cols.zip[i]] : -1), id: (k) => `market:${marketKeys[k]}` },
    county: { of: (i) => (index.cols.zip[i] >= 0 ? zipCountyIdx[index.cols.zip[i]] : -1), id: (k) => `county:${countyKeys[k]}` },
    city: { of: (i) => index.cols.city[i], id: (k) => `city:${index.dicts.cities[k]}` },
    zip: { of: (i) => index.cols.zip[i], id: (k) => `zip:${index.dicts.zips[k]}` },
  }
  return { selectorFor, child }
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
