// Canonical operating markets — the application's read of the one resolver.
//
// The authority lives in the database: public.canonical_markets (one id, one
// display name per market), public.market_aliases (every other spelling, keyed
// with its state), the county/ZIP membership tables and
// public.resolve_canonical_market(), which the properties ingestion trigger
// runs on every write. This module never decides a market on its own: it loads
// that directory and applies the resolver's LABEL step (step 4) to strings that
// were written before canonicalisation — send_queue.market, message_events.market,
// a filter value from a client — so historical rows are derived, not rewritten.
//
// A raw city is never a market. A label that the directory cannot place stays
// unresolved; callers keep it as its own bucket rather than guessing.

const DIRECTORY_TTL_MS = 10 * 60 * 1000
const PAGE_SIZE = 1000

let cachedDirectory = null
let cachedAt = 0
let inflight = null

/** Parity with SQL public.canonical_geo_key(). */
export function canonicalGeoKey(value) {
  const key = String(value ?? '')
    .toLowerCase()
    .replace(/\b(saint|st)\b\.?/g, 'st')
    .replace(/\bft\b\.?/g, 'fort')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return key || null
}

/** "Diamond Bar, CA" → { name: "Diamond Bar", state: "CA" }; state null when absent. */
export function splitMarketLabel(label) {
  const text = String(label ?? '').trim()
  if (!text) return { name: null, state: null }
  const match = text.match(/,\s*([A-Za-z]{2})\s*$/)
  if (!match) return { name: text, state: null }
  return { name: text.slice(0, match.index).trim(), state: match[1].toUpperCase() }
}

export function buildCanonicalMarketDirectory({ markets = [], aliases = [] } = {}) {
  const byId = new Map()
  const byName = new Map()
  for (const row of markets) {
    if (!row?.id || !row?.display_name) continue
    const market = { market_id: row.id, market_name: row.display_name, state: row.state ?? null }
    byId.set(row.id, market)
    byName.set(row.display_name, market)
  }
  const byAliasKey = new Map()
  const aliasesByMarket = new Map()
  for (const row of aliases) {
    const market = byId.get(row?.canonical_market_id)
    if (!row?.alias_key || !market) continue
    byAliasKey.set(row.alias_key, market)
    const list = aliasesByMarket.get(market.market_id) ?? []
    list.push(row.alias)
    aliasesByMarket.set(market.market_id, list)
  }
  return { byId, byName, byAliasKey, aliasesByMarket, size: byId.size }
}

async function fetchAll(supabase, table, columns) {
  const rows = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order(table === 'canonical_markets' ? 'id' : 'alias_key', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(`${table}: ${error.message || error}`)
    const page = Array.isArray(data) ? data : []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

/** Loads (and caches) the canonical market directory. Throws when unavailable. */
export async function loadCanonicalMarketDirectory({ supabase, force = false, now = Date.now() } = {}) {
  if (!supabase) throw new Error('canonical_market_directory_requires_supabase')
  if (!force && cachedDirectory && now - cachedAt < DIRECTORY_TTL_MS) return cachedDirectory
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const [markets, aliases] = await Promise.all([
        fetchAll(supabase, 'canonical_markets', 'id,display_name,state,is_active'),
        fetchAll(supabase, 'market_aliases', 'alias_key,alias,state,canonical_market_id,alias_type'),
      ])
      cachedDirectory = buildCanonicalMarketDirectory({ markets, aliases })
      cachedAt = Date.now()
      return cachedDirectory
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function resetCanonicalMarketDirectoryCache() {
  cachedDirectory = null
  cachedAt = 0
  inflight = null
}

/**
 * The resolver's label step: a market label is trusted only inside its own
 * state. Accepts a canonical id, a canonical display name, or any alias
 * spelling carrying ", ST". Returns null when the label cannot be placed.
 */
export function resolveMarketLabel(directory, label, state = null) {
  if (!directory) return null
  const text = String(label ?? '').trim()
  if (!text) return null
  const recordState = String(state ?? '').trim().toUpperCase() || null
  const exact = directory.byName.get(text) ?? directory.byId.get(text)
  if (exact) {
    if (recordState && exact.state && recordState !== exact.state) return null
    return { ...exact, resolution_source: 'canonical' }
  }

  const { name, state: labelState } = splitMarketLabel(text)
  if (!labelState) return null
  if (recordState && recordState !== labelState) return null
  const key = canonicalGeoKey(name)
  if (!key) return null
  const market = directory.byAliasKey.get(`${key}|${labelState}`)
  return market ? { ...market, resolution_source: 'existing_label' } : null
}

/**
 * Display bucket for a historical label: the canonical name when the label
 * resolves, the label itself when it does not (never merged by guesswork).
 */
export function canonicalMarketBucket(directory, label, state = null) {
  const resolved = resolveMarketLabel(directory, label, state)
  if (resolved) return resolved.market_name
  const text = String(label ?? '').trim()
  return text || null
}

/**
 * Market ids a free-text search should surface: matches on the canonical name
 * or on any alias ("Diamond Bar" finds Los Angeles, CA; "Fort Worth" finds
 * Dallas, TX). Server-side so the client carries no alias table.
 */
export function searchCanonicalMarketIds(directory, search) {
  const needle = canonicalGeoKey(search)
  if (!directory || !needle) return []
  const ids = new Set()
  for (const market of directory.byId.values()) {
    if (canonicalGeoKey(market.market_name)?.includes(needle)) ids.add(market.market_id)
  }
  for (const [marketId, aliases] of directory.aliasesByMarket) {
    if (aliases.some((alias) => canonicalGeoKey(alias)?.includes(needle))) ids.add(marketId)
  }
  return [...ids]
}

/**
 * Full resolution for a record with geography (ZIP → county → locality →
 * label → unresolved) — delegated to the database resolver, never re-derived.
 */
export async function resolveCanonicalMarket({ supabase, zip = null, county = null, city = null, state = null, label = null } = {}) {
  if (!supabase) throw new Error('canonical_market_resolver_requires_supabase')
  const { data, error } = await supabase.rpc('resolve_canonical_market', {
    p_zip: zip,
    p_county: county,
    p_city: city,
    p_state: state,
    p_existing_market: label,
  })
  if (error) throw new Error(`resolve_canonical_market: ${error.message || error}`)
  const row = Array.isArray(data) ? data[0] : data
  return {
    market_id: row?.market_id ?? null,
    market_name: row?.market_name ?? null,
    resolution_source: row?.resolution_source ?? null,
    status: row?.status ?? 'unresolved',
  }
}
