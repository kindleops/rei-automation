/**
 * COMMAND WALL — per-display configuration vocabulary (server authority).
 *
 * A display's configuration is VIEW state only: which preset it shows, its
 * theme, privacy, rotation, camera behaviour and OLED protection. Nothing here
 * can reach an operational write; the wall API never accepts anything but
 * these fields, and the operator edits them from Settings → Displays.
 *
 * The dashboard mirrors these ids in modules/command-wall/wall-presets.ts; the
 * parity test pins the two lists together.
 */

export const PRESET_IDS = Object.freeze([
  'national_command',
  'acquisition_pulse',
  'campaign_operations',
  'market_intelligence',
  'spatial_intelligence',
  'custom',
])

export const THEME_IDS = Object.freeze(['dark', 'true_black', 'light', 'red_ops'])

/** OPERATIONS = detail, PRIVACY = geography + aggregates, PUBLIC_SAFE = very limited. */
export const PRIVACY_MODES = Object.freeze(['operations', 'privacy', 'public_safe'])

export const OLED_LEVELS = Object.freeze(['off', 'low', 'high'])

export const CAMERA_MODES = Object.freeze(['static', 'active_market', 'tour', 'event_follow'])

export const AUDIO_MODES = Object.freeze(['off', 'critical', 'high_value', 'all_selected'])

export const LAYER_IDS = Object.freeze([
  'campaigns', 'activity', 'pipeline', 'sales', 'investor', 'mi_heat', 'cameras', 'crime', 'boundaries',
])

/** New displays default to PRIVACY (§15) and OLED Low (§32). */
export const DEFAULT_DISPLAY_CONFIG = Object.freeze({
  preset: 'national_command',
  theme: 'dark',
  privacy_mode: 'privacy',
  oled_protection: 'low',
  camera_mode: 'static',
  audio: 'off',
  show_feed: true,
  overnight_low_light: false,
  rotation: Object.freeze({ enabled: false, steps: Object.freeze([]) }),
  layers: null, // null = the preset's own layers
  watched_markets: Object.freeze([]),
  map_view: null, // null = the preset's framing
})

/** Default rotation from the brief (§34): National 4m → Pulse 3m → MI 3m → Campaign Ops 2m. */
export const DEFAULT_ROTATION_STEPS = Object.freeze([
  Object.freeze({ preset: 'national_command', minutes: 4 }),
  Object.freeze({ preset: 'acquisition_pulse', minutes: 3 }),
  Object.freeze({ preset: 'market_intelligence', minutes: 3 }),
  Object.freeze({ preset: 'campaign_operations', minutes: 2 }),
])

export const MIN_ROTATION_MINUTES = 1
export const MAX_ROTATION_MINUTES = 60
const MAX_NAME = 48
const MAX_WATCHED = 8
const MARKET_ID = /^[a-z0-9][a-z0-9-]{1,62}$/

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
const clean = (v) => String(v ?? '').trim()

export function cleanDisplayName(raw) {
  // Printable, single line, no markup: a display name is shown on the TV.
  const name = clean(raw).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').slice(0, MAX_NAME)
  return name || null
}

function cleanRotation(raw) {
  if (!raw || typeof raw !== 'object') return null
  const steps = Array.isArray(raw.steps)
    ? raw.steps
      .filter((s) => s && PRESET_IDS.includes(s.preset) && s.preset !== 'custom')
      .slice(0, 8)
      .map((s) => { const m = Number(s.minutes); return { preset: s.preset, minutes: Math.min(MAX_ROTATION_MINUTES, Math.max(MIN_ROTATION_MINUTES, Number.isFinite(m) ? Math.round(m) : 3)) } })
    : []
  return { enabled: Boolean(raw.enabled) && steps.length > 1, steps }
}

function cleanMapView(raw) {
  if (!raw || typeof raw !== 'object') return null
  const lng = Number(raw.lng)
  const lat = Number(raw.lat)
  const zoom = Number(raw.zoom)
  if (![lng, lat, zoom].every(Number.isFinite)) return null
  if (Math.abs(lat) > 85 || Math.abs(lng) > 180) return null
  return { lng: Math.round(lng * 1e4) / 1e4, lat: Math.round(lat * 1e4) / 1e4, zoom: Math.min(16, Math.max(2, Math.round(zoom * 10) / 10)) }
}

/**
 * Validates an operator's configuration PATCH. Unknown keys are dropped, not
 * stored: the config document can only ever hold view state.
 * Returns { ok, patch, rejected }.
 */
export function validateConfigPatch(input = {}) {
  const patch = {}
  const rejected = []
  const src = input && typeof input === 'object' ? input : {}
  const take = (key, allowed) => {
    if (!(key in src)) return
    if (allowed.includes(src[key])) patch[key] = src[key]
    else rejected.push(key)
  }
  if ('name' in src) {
    const name = cleanDisplayName(src.name)
    if (name) patch.name = name
    else rejected.push('name')
  }
  take('preset', PRESET_IDS)
  take('theme', THEME_IDS)
  take('privacy_mode', PRIVACY_MODES)
  take('oled_protection', OLED_LEVELS)
  take('camera_mode', CAMERA_MODES)
  take('audio', AUDIO_MODES)
  if ('show_feed' in src) patch.show_feed = Boolean(src.show_feed)
  if ('overnight_low_light' in src) patch.overnight_low_light = Boolean(src.overnight_low_light)
  if ('rotation' in src) {
    const r = cleanRotation(src.rotation)
    if (r) patch.rotation = r
    else rejected.push('rotation')
  }
  if ('layers' in src) {
    if (src.layers === null) patch.layers = null
    else if (Array.isArray(src.layers)) patch.layers = [...new Set(src.layers.filter((l) => LAYER_IDS.includes(l)))]
    else rejected.push('layers')
  }
  if ('watched_markets' in src) {
    if (Array.isArray(src.watched_markets)) {
      patch.watched_markets = [...new Set(src.watched_markets.map(clean).filter((m) => MARKET_ID.test(m)))].slice(0, MAX_WATCHED)
    } else rejected.push('watched_markets')
  }
  if ('map_view' in src) {
    if (src.map_view === null) patch.map_view = null
    else {
      const v = cleanMapView(src.map_view)
      if (v) patch.map_view = v
      else rejected.push('map_view')
    }
  }
  return { ok: rejected.length === 0, patch, rejected }
}

/** The effective config: defaults ⊕ stored settings, every field re-validated. */
export function resolveDisplayConfig(row = {}) {
  const s = row?.settings_json && typeof row.settings_json === 'object' ? row.settings_json : {}
  const merged = { ...DEFAULT_DISPLAY_CONFIG, ...s }
  return {
    preset: pick(row.preset ?? merged.preset, PRESET_IDS, DEFAULT_DISPLAY_CONFIG.preset),
    theme: pick(row.theme ?? merged.theme, THEME_IDS, DEFAULT_DISPLAY_CONFIG.theme),
    privacy_mode: pick(row.privacy_mode ?? merged.privacy_mode, PRIVACY_MODES, DEFAULT_DISPLAY_CONFIG.privacy_mode),
    oled_protection: pick(row.oled_protection ?? merged.oled_protection, OLED_LEVELS, DEFAULT_DISPLAY_CONFIG.oled_protection),
    camera_mode: pick(merged.camera_mode, CAMERA_MODES, DEFAULT_DISPLAY_CONFIG.camera_mode),
    audio: pick(merged.audio, AUDIO_MODES, DEFAULT_DISPLAY_CONFIG.audio),
    show_feed: merged.show_feed !== false,
    overnight_low_light: Boolean(merged.overnight_low_light),
    rotation: cleanRotation(row.rotation_config ?? merged.rotation) || { enabled: false, steps: [] },
    layers: Array.isArray(merged.layers) ? merged.layers.filter((l) => LAYER_IDS.includes(l)) : null,
    watched_markets: Array.isArray(merged.watched_markets) ? merged.watched_markets.filter((m) => MARKET_ID.test(clean(m))).slice(0, MAX_WATCHED) : [],
    map_view: cleanMapView(merged.map_view),
  }
}

/**
 * Splits a validated patch into the proposed table's first-class columns and
 * the settings_json remainder.
 */
export function patchToRow(patch, currentRow = {}) {
  const row = {}
  const settings = { ...(currentRow.settings_json || {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'name' || k === 'preset' || k === 'theme' || k === 'privacy_mode' || k === 'oled_protection') row[k] = v
    else if (k === 'rotation') row.rotation_config = v
    else settings[k] = v
  }
  row.settings_json = settings
  return row
}

/**
 * Remote view command (§37): "Send to Command Wall → Living Room → Dallas MI".
 * It changes the VIEW only. Returns { ok, command } or { ok:false, error }.
 */
export function validateViewCommand(input = {}) {
  const src = input && typeof input === 'object' ? input : {}
  const preset = src.preset == null ? null : pick(src.preset, PRESET_IDS, undefined)
  if (preset === undefined) return { ok: false, error: 'bad_preset' }
  const market = src.market == null ? null : clean(src.market)
  if (market !== null && !MARKET_ID.test(market)) return { ok: false, error: 'bad_market' }
  const campaignId = src.campaign_id == null ? null : clean(src.campaign_id).slice(0, 64)
  if (campaignId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(campaignId)) return { ok: false, error: 'bad_campaign' }
  const holdMinutes = Math.min(240, Math.max(1, Math.round(Number(src.hold_minutes) || 30)))
  if (!preset && !market && !campaignId) return { ok: false, error: 'empty_command' }
  return { ok: true, command: { preset, market, campaign_id: campaignId, hold_minutes: holdMinutes } }
}
