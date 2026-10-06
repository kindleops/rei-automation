/**
 * Command Wall rotation (§34), remote view commands (§37) and camera policy
 * (§35, §36). Pure.
 */
import type { WallCameraMode, WallEvent, WallPresetId, WallRotationStep, WallViewCommand } from './wall-types'

export interface ActiveView { preset: WallPresetId; market: string | null; source: 'command' | 'local' | 'rotation' | 'config'; untilMs: number | null }

/** Which preset rotation shows at `elapsedMs` since rotation started. */
export function rotationAt(steps: WallRotationStep[], elapsedMs: number): { preset: WallPresetId; index: number; nextInMs: number } | null {
  const valid = steps.filter((s) => s && s.minutes > 0)
  if (valid.length < 2) return null
  const cycle = valid.reduce((s, x) => s + x.minutes * 60_000, 0)
  let t = ((elapsedMs % cycle) + cycle) % cycle
  for (let i = 0; i < valid.length; i += 1) {
    const d = valid[i].minutes * 60_000
    if (t < d) return { preset: valid[i].preset, index: i, nextInMs: d - t }
    t -= d
  }
  return { preset: valid[0].preset, index: 0, nextInMs: valid[0].minutes * 60_000 }
}

/**
 * Precedence: an unexpired remote command → a local TV choice (until the
 * server config changes) → rotation (unless paused) → the configured preset.
 */
export function resolveActiveView({ now, configPreset, rotation, rotationStartedAt, rotationPaused, command, localPreset }: {
  now: number
  configPreset: WallPresetId
  rotation: { enabled: boolean; steps: WallRotationStep[] }
  rotationStartedAt: number
  rotationPaused: boolean
  command: WallViewCommand | null
  localPreset: WallPresetId | null
}): ActiveView {
  if (command && Date.parse(command.expires_at) > now) {
    return { preset: command.preset || configPreset, market: command.market, source: 'command', untilMs: Date.parse(command.expires_at) }
  }
  if (localPreset) return { preset: localPreset, market: null, source: 'local', untilMs: null }
  if (rotation.enabled && !rotationPaused) {
    const r = rotationAt(rotation.steps, now - rotationStartedAt)
    if (r) return { preset: r.preset, market: null, source: 'rotation', untilMs: now + r.nextInMs }
  }
  return { preset: configPreset, market: null, source: 'config', untilMs: null }
}

// ── camera policy ────────────────────────────────────────────────────────────
export const FOLLOW_KINDS = new Set(['reply', 'interest', 'offer', 'counter', 'deal'])
export const FOLLOW_MIN_GAP_MS = 45_000
export const FOLLOW_HOLD_MS = 20_000
export const TOUR_DWELL_MS = 90_000
export const MANUAL_PAUSE_MS = 10 * 60_000

export interface CameraState { lastMoveAt: number; followUntil: number; tourIndex: number; manualUntil: number }
export type CameraMove = { type: 'none' } | { type: 'frame' } | { type: 'focus'; lng: number; lat: number; zoom: number; reason: string } | { type: 'tour'; index: number }

/**
 * Decide a camera move. Routine sends never move the camera; pinned/static
 * never moves; follow only for reply/offer/deal (P1) with ≥ 45 s between moves;
 * any manual input pauses automatic movement for 10 minutes.
 */
export function cameraDecision(mode: WallCameraMode, state: CameraState, now: number, ev: WallEvent | null, { tourStops = 0, reducedMotion = false } = {}): CameraMove {
  if (mode === 'static') return { type: 'none' }
  if (now < state.manualUntil) return { type: 'none' }
  if (mode === 'event_follow') {
    if (ev && ev.priority === 1 && FOLLOW_KINDS.has(ev.kind) && ev.geo && Number.isFinite(ev.geo.lat) && Number.isFinite(ev.geo.lng) && now - state.lastMoveAt >= FOLLOW_MIN_GAP_MS && !reducedMotion) {
      return { type: 'focus', lng: ev.geo.lng as number, lat: ev.geo.lat as number, zoom: ev.geo.precision === 'market' ? 8.5 : 10, reason: ev.kind }
    }
    if (!ev && state.followUntil && now >= state.followUntil) return { type: 'frame' }
    return { type: 'none' }
  }
  if (mode === 'tour' || mode === 'active_market') {
    if (tourStops < 2) return { type: 'none' }
    if (now - state.lastMoveAt >= TOUR_DWELL_MS) return { type: 'tour', index: (state.tourIndex + 1) % tourStops }
  }
  return { type: 'none' }
}

/** Distance-aware easing: long hops get long, gentle flights; never < 4 s. */
export function flightDurationMs(fromZoom: number, toZoom: number, kmDistance: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0
  const zoomDelta = Math.abs(toZoom - fromZoom)
  return Math.round(Math.min(9_000, 4_000 + kmDistance * 2.2 + zoomDelta * 450))
}

export function haversineKm(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
