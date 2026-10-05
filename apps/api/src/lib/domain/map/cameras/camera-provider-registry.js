/**
 * CAMERA PROVIDER REGISTRY — the one place a provider's facts live.
 *
 * An entry says who the source is, which adapter translates it, what its
 * terms allow (proxy a still, reference it directly, or only link out), the
 * exact attribution it requires, how often it really updates, and which hosts
 * its images may come from. The Map never branches on a provider; the service
 * reads these facts and the adapter does the translation.
 *
 * Runtime state (health, counts, leases) lives in public.map_world_providers
 * and is mirrored from these entries on every refresh. API keys are never
 * stored here or in the database — only the NAME of the server-side env var
 * that holds one, and that name is never sent to a client.
 */

/**
 * @typedef {object} CameraProvider
 * @property {'cameras'} domain                world-provider domain (shared runtime)
 * @property {string} provider_id           snake_case, stable forever
 * @property {string} name                  operator-facing ("MnDOT", "FL511")
 * @property {string|null} state            2-letter; null for multi-state
 * @property {string|null} region
 * @property {'state_dot'|'state_511'|'regional'|'municipal'|'county'|'federal'} provider_type
 * @property {string} adapter_type          key into camera-adapters
 * @property {'FULL'|'PARTIAL'|'METRO_ONLY'|'METADATA_ONLY'|'NO_PUBLIC_FEED'|'UNKNOWN'} coverage_status
 * @property {boolean} enabled_by_default   discovery + terms verified
 * @property {boolean} requires_api_key
 * @property {string|null} api_key_env      server env var holding the key (never sent to clients)
 * @property {'proxy'|'direct'|'link_only'} image_policy
 * @property {string[]} image_hosts         exact hosts (or ".suffix") stills/streams may come from
 * @property {string[]} metadata_hosts      hosts the inventory may be pulled from
 * @property {boolean} [allow_http]         only for agencies that serve images over http alone
 * @property {number} refresh_interval_sec  inventory/status pull cadence
 * @property {number|null} snapshot_cadence_sec  how often a still really changes
 * @property {number|null} [stale_after_sec]
 * @property {string} attribution           shown with every image
 * @property {string|null} terms_url
 * @property {string|null} [terms_note]     what the terms allow, in one line (internal)
 * @property {number} priority              dedupe: lower wins (official owner first)
 * @property {'public'|'needs_key'|'needs_permission'} [access]  how the feed is reached (SOURCES.txt classification)
 * @property {string} [signup_url]          where the OWNER registers for a key (never a key itself)
 * @property {object} [adapter_config]      adapter-specific, non-secret
 * @property {{west:number,south:number,east:number,north:number}} [bounds]  where its cameras can be (a viewport outside never pulls it)
 */

/** @type {CameraProvider[]} — every entry has its adapter + a contract test on a real response fixture. */
export const CAMERA_PROVIDERS = [
  {
    domain: 'cameras',
    provider_id: 'mn_mndot_iris',
    name: 'MnDOT',
    state: 'MN',
    region: null,
    provider_type: 'state_dot',
    adapter_type: 'mndot_iris',
    coverage_status: 'FULL',
    enabled_by_default: true,
    requires_api_key: false,
    api_key_env: null,
    image_policy: 'proxy',
    image_hosts: ['video.dot.state.mn.us'],
    metadata_hosts: ['data.dot.state.mn.us'],
    refresh_interval_sec: 6 * 3600,
    snapshot_cadence_sec: 60,
    attribution: 'Minnesota Department of Transportation (MnDOT) · 511MN',
    terms_url: 'https://www.dot.state.mn.us/information/disclaimer.html',
    terms_note: 'Public government data (Minn. Stat. §13.03); no camera licence published. Proxy a still briefly in memory, never persist, credit MnDOT, no framing.',
    priority: 10,
    bounds: { west: -97.3, south: 43.4, east: -89.4, north: 49.1 },
  },
  {
    domain: 'cameras',
    provider_id: 'tx_txdot_its',
    name: 'TxDOT ITS',
    state: 'TX',
    region: 'Dallas · Fort Worth · Houston · San Antonio · Austin',
    provider_type: 'state_dot',
    adapter_type: 'txdot_its',
    coverage_status: 'METRO_ONLY',
    enabled_by_default: true,
    requires_api_key: false,
    api_key_env: null,
    // INTERNAL USE (owner-approved 2026-10-03, pending a TxDOT data-sharing
    // agreement): the one still an operator opens is passed through, never cached.
    image_policy: 'proxy',
    image_hosts: ['its.txdot.gov'],
    metadata_hosts: ['its.txdot.gov'],
    refresh_interval_sec: 3600,
    snapshot_cadence_sec: 120,
    attribution: 'Source: TxDOT · internal use, pending TxDOT data-sharing agreement',
    terms_url: 'https://www.txdot.gov/about/disclaimer.html',
    terms_note: 'Internal (undocumented) public JSON; terms silent on image reuse. Internal-use pass-through approved by the owner; no cache, operator-gated, rate-limited, until a TxDOT data-sharing agreement.',
    priority: 20,
    adapter_config: { districts: ['DAL', 'FTW', 'HOU', 'SAT', 'AUS'], no_cache: true, internal_use: true },
    bounds: { west: -100.2, south: 28.6, east: -94.3, north: 33.6 },
  },
  {
    domain: 'cameras',
    provider_id: 'tx_austin_mobility',
    name: 'City of Austin',
    state: 'TX',
    region: 'Austin',
    provider_type: 'municipal',
    adapter_type: 'austin_mobility',
    coverage_status: 'METRO_ONLY',
    enabled_by_default: true,
    requires_api_key: false,
    api_key_env: null,
    image_policy: 'proxy',
    image_hosts: ['cctv.austinmobility.io'],
    metadata_hosts: ['data.austintexas.gov'],
    refresh_interval_sec: 6 * 3600,
    snapshot_cadence_sec: 300,
    attribution: 'City of Austin Transportation & Public Works · data.austintexas.gov',
    terms_url: 'https://data.austintexas.gov/stories/s/City-of-Austin-Open-Data-Terms-of-Use/ranj-cccq/',
    terms_note: 'Public domain ("free and without restriction"); credit the City and the department.',
    priority: 30,
    bounds: { west: -98.2, south: 29.9, east: -97.4, north: 30.7 },
  },
  {
    domain: 'cameras',
    provider_id: 'ca_caltrans_cwwp2',
    name: 'Caltrans',
    state: 'CA',
    region: 'Districts 1–12',
    provider_type: 'state_dot',
    adapter_type: 'caltrans_cwwp2',
    coverage_status: 'FULL',
    enabled_by_default: true,
    requires_api_key: false,
    api_key_env: null,
    image_policy: 'proxy',
    // stills from cwwp2; live HLS referenced at Caltrans's own Wowza host (browser-direct, click-to-play)
    image_hosts: ['cwwp2.dot.ca.gov', 'wzmedia.dot.ca.gov'],
    metadata_hosts: ['cwwp2.dot.ca.gov'],
    refresh_interval_sec: 6 * 3600,
    snapshot_cadence_sec: 120,
    attribution: 'Camera imagery: Caltrans (California Department of Transportation)',
    terms_url: 'https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm',
    terms_note: 'Public domain, built for integration; fair use — never degrade the streaming service: stills proxied with a short TTL, video only on click, never prefetched or re-streamed.',
    priority: 10,
    bounds: { west: -124.5, south: 32.4, east: -114.0, north: 42.1 },
  },
  // ── 2026-10-05 expansion (SOURCES.txt): public, keyless, terms read ──────
  {
    domain: 'cameras', provider_id: 'il_idot_gateway', name: 'IDOT', state: 'IL', region: null,
    provider_type: 'state_dot', adapter_type: 'idot_gateway', coverage_status: 'FULL', access: 'public',
    enabled_by_default: true, requires_api_key: false, api_key_env: null,
    image_policy: 'proxy', image_hosts: ['cctv.travelmidwest.com'], metadata_hosts: ['services2.arcgis.com'],
    refresh_interval_sec: 6 * 3600, snapshot_cadence_sec: 300,
    attribution: 'Illinois Department of Transportation (IDOT) · Gateway Traveler Information · CC BY-SA 2.0',
    terms_url: 'https://gis-idot.opendata.arcgis.com/datasets/illinois-gateway-traffic-cameras',
    terms_note: 'Item licence CC BY-SA 2.0: credit IDOT; stills proxied briefly, never persisted.',
    priority: 10, bounds: { west: -91.6, south: 36.9, east: -87.0, north: 42.6 },
  },
  {
    domain: 'cameras', provider_id: 'wa_wsdot', name: 'WSDOT', state: 'WA', region: null,
    provider_type: 'state_dot', adapter_type: 'wsdot_kml', coverage_status: 'FULL', access: 'public',
    enabled_by_default: true, requires_api_key: false, api_key_env: null,
    image_policy: 'proxy', image_hosts: ['images.wsdot.wa.gov'], metadata_hosts: ['wsdot.wa.gov'],
    refresh_interval_sec: 6 * 3600, snapshot_cadence_sec: 120,
    attribution: 'Washington State Department of Transportation (WSDOT)',
    terms_url: 'https://wsdot.wa.gov/about/policies/travel-information-disclaimer',
    terms_note: 'As-is disclaimer only; no use restriction published. Stills proxied briefly, never persisted.',
    priority: 10, bounds: { west: -124.9, south: 45.5, east: -116.9, north: 49.1 },
  },
  {
    domain: 'cameras', provider_id: 'md_mdot_chart', name: 'MDOT SHA CHART', state: 'MD', region: null,
    provider_type: 'state_dot', adapter_type: 'mdot_chart', coverage_status: 'METADATA_ONLY', access: 'public',
    enabled_by_default: true, requires_api_key: false, api_key_env: null,
    // CHART publishes live video only; live video is MN + CA only → positions + CHART's own page.
    image_policy: 'link_only', image_hosts: [], metadata_hosts: ['chart.maryland.gov'],
    refresh_interval_sec: 6 * 3600, snapshot_cadence_sec: null,
    attribution: 'Maryland Department of Transportation State Highway Administration (CHART)',
    terms_url: 'https://chart.maryland.gov/DataFeeds/GetDataFeeds',
    terms_note: 'MD iMAP licence: freely distributable with metadata intact; credit the State of Maryland.',
    priority: 10, bounds: { west: -79.5, south: 37.9, east: -75.0, north: 39.8 },
  },
  {
    domain: 'cameras', provider_id: 'mo_modot_traveler', name: 'MoDOT', state: 'MO', region: null,
    provider_type: 'state_dot', adapter_type: 'modot_traveler', coverage_status: 'METADATA_ONLY', access: 'public',
    enabled_by_default: true, requires_api_key: false, api_key_env: null,
    // MoDOT publishes live video only; live video is MN + CA only → positions + MoDOT's map.
    image_policy: 'link_only', image_hosts: [], metadata_hosts: ['traveler.modot.org'],
    refresh_interval_sec: 6 * 3600, snapshot_cadence_sec: null,
    attribution: 'Missouri Department of Transportation (MoDOT) Traveler Information',
    terms_url: 'https://traveler.modot.org/map/',
    terms_note: 'State of Missouri data terms (disclaimer; display contemplated). Provisional: courtesy note to MoDOT advised.',
    priority: 10, bounds: { west: -95.8, south: 35.99, east: -89.1, north: 40.62 },
  },
  {
    domain: 'cameras', provider_id: 'ia_iowa_dot', name: 'Iowa DOT', state: 'IA', region: null,
    provider_type: 'state_dot', adapter_type: 'iowa_dot', coverage_status: 'FULL', access: 'needs_permission',
    // Built, OFF: the layer is CC BY 4.0 but Iowa's site terms limit "Content" to noncommercial use.
    enabled_by_default: false, requires_api_key: false, api_key_env: null,
    image_policy: 'proxy', image_hosts: ['atmsqf.iowadot.gov'], metadata_hosts: ['services.arcgis.com'],
    refresh_interval_sec: 6 * 3600, snapshot_cadence_sec: 300,
    attribution: 'Iowa Department of Transportation · CC BY 4.0',
    terms_url: 'https://iowadot.gov/policies-statements/terms-use',
    terms_note: 'Confirm with Iowa DOT that stills are licensed data (CC BY 4.0), not noncommercial site content.',
    priority: 10, bounds: { west: -96.7, south: 40.3, east: -90.1, north: 43.6 },
  },
  // ── keyed: built, configured OFF until the owner registers and installs the key ──
  ...[
    ['fl_fl511', 'FL511', 'FL', 'fl511.com', 'FL511_API_KEY', { west: -87.7, south: 24.4, east: -79.9, north: 31.1 }],
    ['ga_511ga', '511GA', 'GA', '511ga.org', 'GA511_API_KEY', { west: -85.7, south: 30.3, east: -80.8, north: 35.1 }],
    ['nc_drivenc', 'DriveNC', 'NC', 'www.drivenc.gov', 'NC_DRIVENC_API_KEY', { west: -84.4, south: 33.8, east: -75.4, north: 36.6 }],
    ['az_az511', 'AZ511', 'AZ', 'az511.com', 'AZ511_API_KEY', { west: -114.9, south: 31.3, east: -109.0, north: 37.1 }],
    ['ut_udot', 'UDOT Traffic', 'UT', 'udottraffic.utah.gov', 'UDOT_API_KEY', { west: -114.1, south: 36.9, east: -109.0, north: 42.1 }],
    ['nv_nvroads', 'NVRoads', 'NV', 'www.nvroads.com', 'NVROADS_API_KEY', { west: -120.1, south: 35.0, east: -114.0, north: 42.1 }],
    ['la_511la', '511LA', 'LA', 'www.511la.org', 'LA511_API_KEY', { west: -94.1, south: 28.9, east: -88.8, north: 33.1 }],
  ].map(([provider_id, name, state, site, env, bounds]) => ({
    domain: 'cameras', provider_id, name, state, region: null,
    provider_type: 'state_511', adapter_type: 'ibi_511', coverage_status: 'FULL', access: 'needs_key',
    enabled_by_default: true, requires_api_key: true, api_key_env: env,
    image_policy: 'proxy', image_hosts: [site], metadata_hosts: [site],
    refresh_interval_sec: 6 * 3600, snapshot_cadence_sec: 120,
    attribution: `${name} · state DOT traveler information`,
    terms_url: `https://${site}/developers/doc`,
    signup_url: `https://${site}/my511/register`,
    terms_note: 'Developer key via /my511/register; the use agreement is shown at key request (owner reads it). Ten calls / 60 s.',
    priority: 10, bounds, adapter_config: { site },
  })),
  {
    domain: 'cameras', provider_id: 'oh_ohgo', name: 'OHGO', state: 'OH', region: null,
    provider_type: 'state_dot', adapter_type: 'ohgo', coverage_status: 'FULL', access: 'needs_key',
    enabled_by_default: true, requires_api_key: true, api_key_env: 'OHGO_API_KEY',
    image_policy: 'proxy', image_hosts: ['itscameras.dot.state.oh.us'], metadata_hosts: ['publicapi.ohgo.com'],
    refresh_interval_sec: 6 * 3600, snapshot_cadence_sec: 60,
    attribution: 'Ohio Department of Transportation · OHGO',
    terms_url: 'https://publicapi.ohgo.com/docs/terms-of-use',
    signup_url: 'https://publicapi.ohgo.com/accounts/registration',
    terms_note: 'Free key; "a free service with some stipulations to prevent abuse"; revocable; no display ban found.',
    priority: 10, bounds: { west: -84.9, south: 38.4, east: -80.5, north: 42.0 },
  },
]

/**
 * Registered state systems that are NOT connected and cannot be by code
 * alone — the agency's permission or agreement is required first (or its
 * terms do not allow this use). The Map names them so "no cameras here" is
 * explained, never implied to be empty.
 */
export const CAMERA_ACCESS_PENDING = Object.freeze([
  { provider: 'TDOT SmartWay', state: 'TN', access: 'needs_permission', bounds: { west: -90.4, south: 34.9, east: -81.6, north: 36.7 } },
  { provider: 'TrafficWise (INDOT)', state: 'IN', access: 'needs_permission', bounds: { west: -88.1, south: 37.7, east: -84.7, north: 41.8 } },
  { provider: '511WI', state: 'WI', access: 'needs_permission', bounds: { west: -92.9, south: 42.4, east: -86.7, north: 47.1 } },
  { provider: '511PA', state: 'PA', access: 'needs_permission', bounds: { west: -80.6, south: 39.7, east: -74.6, north: 42.3 } },
  { provider: '511NY', state: 'NY', access: 'needs_permission', bounds: { west: -79.8, south: 40.5, east: -71.8, north: 45.1 } },
  { provider: 'VDOT SmarterRoads', state: 'VA', access: 'needs_permission', bounds: { west: -83.7, south: 36.5, east: -75.2, north: 39.5 } },
  { provider: 'COtrip', state: 'CO', access: 'needs_permission', bounds: { west: -109.1, south: 36.9, east: -102.0, north: 41.1 } },
  { provider: 'ALGO Traffic', state: 'AL', access: 'needs_permission', bounds: { west: -88.5, south: 30.1, east: -84.9, north: 35.1 } },
  { provider: 'GoKY', state: 'KY', access: 'needs_permission', bounds: { west: -89.6, south: 36.5, east: -81.9, north: 39.2 } },
  { provider: '511SC', state: 'SC', access: 'needs_permission', bounds: { west: -83.4, south: 32.0, east: -78.5, north: 35.3 } },
  { provider: 'KanDrive', state: 'KS', access: 'needs_permission', bounds: { west: -102.1, south: 36.9, east: -94.6, north: 40.1 } },
  { provider: 'OKTraffic', state: 'OK', access: 'needs_permission', bounds: { west: -103.0, south: 33.6, east: -94.4, north: 37.1 } },
  { provider: 'Mi Drive (MDOT)', state: 'MI', access: 'not_permitted', bounds: { west: -90.5, south: 41.7, east: -82.1, north: 48.3 } },
])

/**
 * Owner decision (2026-10-03): live video plays for MnDOT and Caltrans ONLY.
 * Every other provider is stills (or location) even when its feed carries a
 * stream URL — a new provider never gains live video by accident.
 */
export const LIVE_VIDEO_PROVIDERS = Object.freeze(['mn_mndot_iris', 'ca_caltrans_cwwp2'])
export const videoAllowed = (p) => Boolean(p && LIVE_VIDEO_PROVIDERS.includes(p.provider_id))

export const US_STATES = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
})

const REQUIRED = ['provider_id', 'name', 'provider_type', 'adapter_type', 'coverage_status', 'image_policy', 'attribution', 'refresh_interval_sec', 'priority']

/** Registry invariants, pinned by tests: a bad entry fails loudly, not at 3 a.m. */
export function validateProvider(p) {
  const problems = []
  for (const k of REQUIRED) if (p?.[k] === undefined || p?.[k] === null || p?.[k] === '') problems.push(`missing ${k}`)
  if (p && !/^[a-z0-9_]{3,64}$/.test(p.provider_id || '')) problems.push('provider_id must be snake_case')
  if (p?.state && !US_STATES[p.state]) problems.push(`unknown state ${p.state}`)
  if (p && !['proxy', 'direct', 'link_only'].includes(p.image_policy)) problems.push('bad image_policy')
  if (p && p.image_policy !== 'link_only' && !(Array.isArray(p.image_hosts) && p.image_hosts.length)) problems.push('image_hosts required unless link_only')
  if (p && !(Array.isArray(p.metadata_hosts) && p.metadata_hosts.length)) problems.push('metadata_hosts required')
  if (p?.requires_api_key && !/^[A-Z][A-Z0-9_]{2,63}$/.test(p.api_key_env || '')) problems.push('api_key_env required when requires_api_key')
  if (p && Number(p.refresh_interval_sec) < 300) problems.push('refresh_interval_sec below 300 s')
  if (p && p.domain !== 'cameras') problems.push('domain must be cameras')
  // A keyed image URL must never reach a browser: keyed providers proxy.
  if (p?.requires_api_key && p.image_policy === 'direct' && p.adapter_config?.image_url_carries_key !== false) problems.push('keyed provider must proxy stills unless its image URLs carry no key')
  return problems
}

export function providerById(id, registry = CAMERA_PROVIDERS) {
  return registry.find((p) => p.provider_id === id) || null
}

export { effectiveProvider } from '../world-providers/provider-runtime.js'

/** The registry facts a client may see. No env names, no hosts, no adapter config. */
export function publicProvider(p, health = null) {
  return {
    provider_id: p.provider_id,
    name: p.name,
    state: p.state || null,
    region: p.region || null,
    coverage_status: p.coverage_status,
    attribution: p.attribution,
    terms_url: p.terms_url || null,
    image_policy: p.image_policy,
    enabled: Boolean(p.enabled),
    camera_count: health?.item_count ?? null,
    health_state: health?.health_state ?? (p.enabled ? 'unknown' : 'disabled'),
    last_success_at: health?.last_success_at ?? null,
  }
}

/** Why a state draws no cameras, in plain words (never "0 cameras"). */
function pendingLabel(mine, code) {
  const keyed = mine.find((p) => p.requires_api_key && !p.key_configured)
  if (keyed) return `${keyed.name} needs an API key (not connected)`
  const held = mine.find((p) => p.access === 'needs_permission')
  if (held) return `${held.name} built · awaiting agency confirmation`
  const pending = CAMERA_ACCESS_PENDING.find((x) => x.state === code)
  if (pending) return pending.access === 'not_permitted' ? `${pending.provider} terms do not allow this use` : `${pending.provider} needs agency permission`
  return 'No public camera source connected'
}

const COVERAGE_RANK = { FULL: 5, PARTIAL: 4, METRO_ONLY: 3, METADATA_ONLY: 2, UNKNOWN: 1, NO_PUBLIC_FEED: 0 }

/**
 * Coverage by state, as it is — never "0 cameras" for a state we simply have
 * not connected. A state with no enabled provider reads "No public camera
 * source connected", which is the truth.
 */
export function coverageByState(providers, healthById = {}) {
  const out = {}
  for (const [code, name] of Object.entries(US_STATES)) {
    const mine = providers.filter((p) => p.state === code)
    const live = mine.filter((p) => p.enabled)
    const cams = live.reduce((a, p) => a + (healthById[p.provider_id]?.item_count || 0), 0)
    const best = live.reduce((b, p) => (COVERAGE_RANK[p.coverage_status] > COVERAGE_RANK[b] ? p.coverage_status : b), 'NO_PUBLIC_FEED')
    out[code] = {
      state: code,
      name,
      connected: live.length > 0,
      coverage_status: live.length ? best : 'NOT_CONNECTED',
      label: live.length ? null : pendingLabel(mine, code),
      camera_count: live.length ? cams : null,
      providers: live.map((p) => p.name),
    }
  }
  return out
}
