/**
 * COMMAND WALL — privacy projection (§15, §43, §65).
 *
 * Applied to every payload on the way out, per display:
 *   operations   detail: campaign names, market, ZIP, property-level geography
 *                (rounded), asking/offer amounts when the source carries them.
 *   privacy      (default) geography + aggregates: market and ZIP, coordinates
 *                snapped to the ZIP centroid (or a ~2 km grid), no amounts, no
 *                campaign names. Never names, phones, addresses or message text.
 *   public_safe  very limited: market-level only, no ZIP, no campaign names,
 *                no amounts, no individual signal subjects.
 *
 * Wall events are built from a closed vocabulary (wall-projection.js) and never
 * carry free text from a source row, so even OPERATIONS mode has no seller
 * name, phone, address or message body to leak. This module removes what a
 * mode must not show from what is left.
 */
import { PRIVACY_MODES } from './wall-config.js'

const GRID = { privacy: 0.02, public_safe: null }

const snap = (v, step) => Math.round(v / step) * step
const round = (v, dp) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null)

export function normalizePrivacyMode(mode) {
  return PRIVACY_MODES.includes(mode) ? mode : 'privacy'
}

export function projectGeo(geo, mode) {
  if (!geo) return null
  const m = normalizePrivacyMode(mode)
  const market = geo.market_id || geo.market_name ? { market_id: geo.market_id || null, market_name: geo.market_name || null } : {}
  if (m === 'public_safe') {
    return Number.isFinite(geo.market_lat) && Number.isFinite(geo.market_lng)
      ? { ...market, lat: round(geo.market_lat, 2), lng: round(geo.market_lng, 2), precision: 'market' }
      : { ...market, lat: null, lng: null, precision: 'none' }
  }
  if (m === 'privacy') {
    if (Number.isFinite(geo.zip_lat) && Number.isFinite(geo.zip_lng)) return { ...market, zip: geo.zip || null, lat: round(geo.zip_lat, 3), lng: round(geo.zip_lng, 3), precision: 'zip' }
    if (Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) return { ...market, zip: geo.zip || null, lat: round(snap(geo.lat, GRID.privacy), 3), lng: round(snap(geo.lng, GRID.privacy), 3), precision: 'grid' }
    if (Number.isFinite(geo.market_lat)) return { ...market, zip: geo.zip || null, lat: round(geo.market_lat, 2), lng: round(geo.market_lng, 2), precision: 'market' }
    return { ...market, zip: geo.zip || null, lat: null, lng: null, precision: 'none' }
  }
  // operations: property-level, rounded to ~100 m
  if (Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) return { ...market, zip: geo.zip || null, lat: round(geo.lat, 3), lng: round(geo.lng, 3), precision: 'property' }
  if (Number.isFinite(geo.zip_lat)) return { ...market, zip: geo.zip || null, lat: round(geo.zip_lat, 3), lng: round(geo.zip_lng, 3), precision: 'zip' }
  if (Number.isFinite(geo.market_lat)) return { ...market, zip: geo.zip || null, lat: round(geo.market_lat, 2), lng: round(geo.market_lng, 2), precision: 'market' }
  return { ...market, zip: geo.zip || null, lat: null, lng: null, precision: 'none' }
}

/** One wall event → what this display may see. */
export function projectEvent(ev, mode) {
  const m = normalizePrivacyMode(mode)
  const out = {
    id: ev.id,
    seq: ev.seq,
    kind: ev.kind,
    priority: ev.priority,
    tone: ev.tone,
    label: ev.label,
    occurred_at: ev.occurred_at,
    count: ev.count ?? 1,
    window_ms: ev.window_ms ?? null,
    geo: projectGeo(ev.geo, m),
  }
  if (ev.intent && m !== 'public_safe') out.intent = ev.intent
  if (m === 'operations') {
    if (ev.campaign) out.campaign = ev.campaign
    if (Number.isFinite(ev.amount)) out.amount = ev.amount
    if (ev.signal) out.signal = ev.signal
  } else if (m === 'privacy') {
    if (ev.signal) out.signal = { rule_key: ev.signal.rule_key, severity: ev.signal.severity }
  } else if (ev.signal) {
    out.signal = { severity: ev.signal.severity }
  }
  return out
}

/** The shared snapshot → what this display may see. */
export function projectSnapshot(snap, mode) {
  const m = normalizePrivacyMode(mode)
  if (!snap) return null
  const campaigns = (snap.campaigns || []).map((c) => {
    const base = { id: c.id, market_id: c.market_id, market_name: c.market_name, status: c.status, sent: c.sent, queued: c.queued, replied: c.replied, positive: c.positive, progress_pct: c.progress_pct, synced_at: c.synced_at }
    if (m === 'operations') return { ...base, name: c.name }
    if (m === 'privacy') return { ...base, name: null }
    return { id: c.id, market_id: c.market_id, market_name: c.market_name, status: c.status, progress_pct: c.progress_pct, name: null }
  })
  const signals = (snap.signals || []).map((s) => (m === 'public_safe'
    ? { id: s.id, severity: s.severity, label: 'System attention', fired_at: s.fired_at }
    : { id: s.id, rule_key: s.rule_key, severity: s.severity, label: s.label, subject_type: s.subject_type, fired_at: s.fired_at }))
  const mi = snap.mi
    ? {
      ...snap.mi,
      markets: (snap.mi.markets || []).map((mk) => ({
        ...mk,
        top_zips: m === 'public_safe' ? [] : mk.top_zips,
      })),
    }
    : null
  return { ...snap, campaigns, signals, mi, privacy_mode: m }
}
