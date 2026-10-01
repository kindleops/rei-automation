/**
 * Campaign market identity + schedule timezone — derived from the cohort.
 *
 * ROOT CAUSES THIS ADDRESSES (RC 7.1, measured in prod 2026-10-01)
 *
 * 1. A campaign only got a `market` when its filters contained a literal
 *    `properties.market = X` value (dashboard campaign-builder-launch.ts
 *    extractMarketFromFilterDraft). Map-area (polygon) and Entity Graph
 *    (property_id list) campaigns never carry such a filter, so every active
 *    campaign of those kinds had `campaigns.market = NULL` — even though every
 *    one of their targets carries a canonical market.
 *
 * 2. The campaign's timezone was resolved in the operator's BROWSER
 *    (`Intl.DateTimeFormat().resolvedOptions().timeZone`) whenever the market
 *    filter was absent, and then persisted as `metadata.timezone`. "75+ ACQ
 *    SCORE" — 146 targets, all Miami (America/New_York) — was stored as
 *    America/Chicago; a 22-market Entity Graph campaign (5 zones) was stored as
 *    one Chicago zone.
 *
 * WHAT THIS MODULE DOES
 * It reads the market identity off the BUILT targets — `campaign_targets.market`
 * is the canonical market display name (the 2026-09-24 canonical-market
 * backfill rewrote it; 0 non-canonical labels in live campaigns) and
 * `campaign_targets.timezone` is the property-derived IANA zone. It never infers
 * a market or zone from a campaign NAME or from the operator's clock.
 *
 *   single_market  one canonical market        → campaigns.market = that name
 *   multi_market   2+ canonical markets        → campaigns.market = NULL, all listed
 *   unresolved     no target carries a market  → campaigns.market = NULL
 *
 * The schedule timezone is likewise honest: one zone when every recipient shares
 * it; `per_recipient` with the full list when they do not. Recipient-level
 * contact windows are always enforced per target downstream
 * (createCampaignQueuePlan groups by target timezone) — the campaign-level zone
 * only anchors "when may the next batch start" and "what is today".
 */

const clean = (value) => String(value ?? '').trim()

export const CAMPAIGN_MARKET_IDENTITY_VERSION = 'campaign_market_identity_v1'

export const MARKET_IDENTITY_KIND = {
  SINGLE: 'single_market',
  MULTI: 'multi_market',
  UNRESOLVED: 'unresolved',
}

function isValidIana(zone) {
  const tz = clean(zone)
  if (!tz || !tz.includes('/')) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function tally(map, key) {
  map.set(key, (map.get(key) || 0) + 1)
}

/**
 * Summarise the market identity of a built cohort.
 *
 * @param {Array<{market?: string, state?: string, timezone?: string}>} rows  campaign_targets rows
 * @param {object} [opts]
 * @param {(label: string, state: string|null) => ({market_id: string, market_name: string}|null)} [opts.resolveMarket]
 *        canonical directory lookup (lib/domain/geography/canonical-market.js resolveMarketLabel)
 * @param {string} [opts.derivedAt]
 */
export function summarizeCampaignMarketIdentity(rows = [], { resolveMarket = null, derivedAt = null } = {}) {
  const markets = new Map()
  const marketState = new Map()
  const zones = new Map()
  let unresolvedMarket = 0
  let unresolvedZone = 0
  for (const row of rows || []) {
    const market = clean(row?.market)
    if (market) {
      tally(markets, market)
      if (!marketState.has(market)) marketState.set(market, clean(row?.state).toUpperCase() || null)
    } else {
      unresolvedMarket += 1
    }
    const tz = clean(row?.timezone)
    if (isValidIana(tz)) tally(zones, tz)
    else unresolvedZone += 1
  }

  const byCount = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  const marketList = [...markets.entries()].sort(byCount).map(([name, targets]) => {
    let canonical = null
    if (typeof resolveMarket === 'function') {
      try { canonical = resolveMarket(name, marketState.get(name)) } catch { canonical = null }
    }
    return {
      market_name: canonical?.market_name || name,
      canonical_market_id: canonical?.market_id || null,
      state: marketState.get(name) || null,
      targets,
    }
  })
  const timezoneList = [...zones.entries()].sort(byCount).map(([timezone, targets]) => ({ timezone, targets }))

  const kind = marketList.length === 0
    ? MARKET_IDENTITY_KIND.UNRESOLVED
    : marketList.length === 1 ? MARKET_IDENTITY_KIND.SINGLE : MARKET_IDENTITY_KIND.MULTI

  return {
    version: CAMPAIGN_MARKET_IDENTITY_VERSION,
    basis: 'campaign_targets',
    derived_at: derivedAt || new Date().toISOString(),
    kind,
    target_count: (rows || []).length,
    markets: marketList,
    canonical_market_ids: marketList.map((m) => m.canonical_market_id).filter(Boolean),
    unresolved_market_targets: unresolvedMarket,
    timezones: timezoneList,
    timezone_mode: timezoneList.length === 1 ? 'single' : timezoneList.length > 1 ? 'per_recipient' : 'unresolved',
    unresolved_timezone_targets: unresolvedZone,
  }
}

/**
 * The campaign-row patch that records an identity. Only the canonical fields
 * the identity actually proves are written; a multi-market cohort clears a
 * stale single `market` rather than keeping whichever one was there first.
 */
export function campaignMarketIdentityPatch(identity, campaign = {}) {
  const metadata = campaign.metadata && typeof campaign.metadata === 'object' && !Array.isArray(campaign.metadata) ? campaign.metadata : {}
  const single = identity.kind === MARKET_IDENTITY_KIND.SINGLE ? identity.markets[0] : null
  const zones = identity.timezones.map((z) => z.timezone)
  const nextMetadata = {
    ...metadata,
    market_identity: identity,
    canonical_market_id: single?.canonical_market_id || null,
    canonical_market_ids: identity.canonical_market_ids,
    recipient_timezones: zones,
  }
  if (zones.length === 1) {
    nextMetadata.timezone = zones[0]
    nextMetadata.launch_timezone = zones[0]
    nextMetadata.timezone_basis = 'campaign_targets'
  } else if (zones.length > 1) {
    // No single zone is true for this cohort. Leave no single-zone claim
    // behind; consumers read recipient_timezones / market_identity.
    nextMetadata.timezone = null
    nextMetadata.launch_timezone = null
    nextMetadata.timezone_basis = 'per_recipient'
  }
  return {
    market: single ? single.market_name : null,
    state: single ? single.state : null,
    metadata: nextMetadata,
  }
}

/** Legacy label map, used ONLY for campaigns built before market_identity existed. */
const LEGACY_MARKET_TIMEZONES = {
  'miami, fl': 'America/New_York',
  'jacksonville, fl': 'America/New_York',
  'dallas, tx': 'America/Chicago',
  'houston, tx': 'America/Chicago',
  'los angeles, ca': 'America/Los_Angeles',
  'minneapolis, mn': 'America/Chicago',
  'charlotte, nc': 'America/New_York',
  'atlanta, ga': 'America/New_York',
}

export const CAMPAIGN_DEFAULT_SCHEDULE_TIMEZONE = 'America/New_York'

/**
 * Which zone(s) anchor this campaign's schedule.
 *
 * Authority order:
 *   1. metadata.market_identity / recipient_timezones — derived from targets
 *   2. legacy: canonical market label (pre-identity rows; unchanged behaviour)
 *   3. legacy: metadata.timezone / launch_timezone (may be operator-browser)
 *   4. default America/New_York, reported as basis 'default' (never silent)
 *
 * @returns {{ timezones: string[], primary: string, mode: 'single'|'per_recipient', basis: string }}
 */
export function resolveCampaignScheduleTimezones(campaign = {}) {
  const md = campaign.metadata && typeof campaign.metadata === 'object' ? campaign.metadata : {}
  const identityZones = Array.isArray(md.market_identity?.timezones)
    ? md.market_identity.timezones.map((z) => clean(z?.timezone)).filter(isValidIana)
    : []
  const listed = identityZones.length
    ? identityZones
    : (Array.isArray(md.recipient_timezones) ? md.recipient_timezones.map(clean).filter(isValidIana) : [])
  if (listed.length) {
    const unique = [...new Set(listed)]
    return {
      timezones: unique,
      primary: easternmostZone(unique),
      mode: unique.length === 1 ? 'single' : 'per_recipient',
      basis: 'campaign_targets',
    }
  }
  const legacyMarket = LEGACY_MARKET_TIMEZONES[clean(campaign.market || md.market).toLowerCase()]
  if (legacyMarket) return { timezones: [legacyMarket], primary: legacyMarket, mode: 'single', basis: 'legacy_market_label' }
  const declared = clean(md.timezone || md.recipient_timezone || md.launch_timezone)
  if (isValidIana(declared)) return { timezones: [declared], primary: declared, mode: 'single', basis: 'legacy_campaign_metadata' }
  return {
    timezones: [CAMPAIGN_DEFAULT_SCHEDULE_TIMEZONE],
    primary: CAMPAIGN_DEFAULT_SCHEDULE_TIMEZONE,
    mode: 'single',
    basis: 'default',
  }
}

function utcOffsetMinutes(zone, at = new Date()) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(at).map((p) => [p.type, p.value]))
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute))
    return Math.round((local - Math.floor(at.getTime() / 60000) * 60000) / 60000)
  } catch {
    return 0
  }
}

/**
 * The zone whose day starts first. For "what is today" on a multi-zone cohort
 * this is the conservative choice: the day (and its caps) begins no later than
 * any recipient's own day.
 */
export function easternmostZone(zones = [], at = new Date()) {
  const list = zones.filter(isValidIana)
  if (!list.length) return CAMPAIGN_DEFAULT_SCHEDULE_TIMEZONE
  return [...list].sort((a, b) => utcOffsetMinutes(b, at) - utcOffsetMinutes(a, at) || a.localeCompare(b))[0]
}

/**
 * Zones a read model should evaluate the contact window in: the cohort's
 * recipient zones when known, else the campaign's declared zone (legacy rows),
 * else none — never a default and never the operator's clock.
 */
export function campaignWindowZones(campaign = {}) {
  const md = campaign.metadata && typeof campaign.metadata === 'object' ? campaign.metadata : {}
  const resolved = resolveCampaignScheduleTimezones(campaign)
  if (resolved.basis === 'campaign_targets') return resolved.timezones
  const declared = clean(md.timezone || md.launch_timezone)
  return declared ? [declared] : []
}

/**
 * Contact-window state across every recipient zone. Open when ANY recipient's
 * window is open (that is when the campaign can send); otherwise the earliest
 * next opening. `stateFor(nowMs, zone, spec)` is map-world-service's canonical
 * contactWindowState, injected to keep this module dependency-free.
 */
export function multiZoneWindowState(nowMs, zones = [], spec, stateFor) {
  const states = zones
    .map((zone) => ({ zone, state: stateFor(nowMs, zone, spec) }))
    .filter((entry) => entry.state)
  if (!states.length) return null
  const open = states.filter((entry) => entry.state.open)
  if (open.length) {
    const pick = open.sort((a, b) => Date.parse(b.state.closes_at || 0) - Date.parse(a.state.closes_at || 0))[0]
    return { ...pick.state, timezone: pick.zone, timezones: zones, open_zones: open.map((e) => e.zone) }
  }
  const pick = states.sort((a, b) => Date.parse(a.state.next_open_at || 0) - Date.parse(b.state.next_open_at || 0))[0]
  return { ...pick.state, timezone: pick.zone, timezones: zones, open_zones: [] }
}
