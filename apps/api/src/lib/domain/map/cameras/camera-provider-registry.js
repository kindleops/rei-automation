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
]

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
      label: live.length ? null : 'No public camera source connected',
      camera_count: live.length ? cams : null,
      providers: live.map((p) => p.name),
    }
  }
  return out
}
