/**
 * CINEMATIC MAP FOCUS — the camera grammar (System Refinement 8.2 §3).
 *
 * Pure planning + one small controller, so the 11k-line Command Map only
 * decides WHAT to focus; HOW the camera travels lives here and is tested.
 *
 *   Travel     a spatial fly of ~500–900 ms, scaled by how far the target is
 *              (in screen space) and how much the zoom changes. A long hop
 *              arcs out and back in (MapLibre flyTo); a short one eases.
 *   Zoom       by context: a property lands at parcel/neighbourhood zoom
 *              (closer zoom the operator already chose is kept); a market at
 *              market zoom; a cohort at its bounds — never "the first pin".
 *   Control    any drag / wheel / pinch / rotate / tilt during an automatic
 *              flight stops it at once: the operator owns the camera.
 *   Motion     reduced motion jumps (0 ms).
 */

export type LngLat = [number, number]
export type FocusContext = 'property' | 'market' | 'cohort'

/** Parcel / neighbourhood: streets and neighbours readable, the parcel unmistakable. */
export const PROPERTY_ZOOM = 15.6
/** If the operator is already this close, a property focus keeps their zoom. */
export const PROPERTY_KEEP_ZOOM = 14.6
export const MARKET_ZOOM = 10.2
export const MIN_FLIGHT_MS = 500
export const MAX_FLIGHT_MS = 900

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function contextZoom(ctx: FocusContext, current: number): number {
  if (ctx === 'market') return MARKET_ZOOM
  if (ctx === 'property') return current >= PROPERTY_KEEP_ZOOM ? Math.min(current, 18) : PROPERTY_ZOOM
  return current
}

/** 500–900 ms by screen distance (in viewport diagonals) and zoom change. */
export function flightDuration(distancePx: number, viewportDiagPx: number, zoomDelta: number): number {
  const diag = Math.max(1, viewportDiagPx)
  const travel = Math.log2(1 + Math.max(0, distancePx) / diag)
  return Math.round(clamp(MIN_FLIGHT_MS + 140 * travel + 45 * Math.abs(zoomDelta), MIN_FLIGHT_MS, MAX_FLIGHT_MS))
}

export interface CameraPlan {
  kind: 'jump' | 'ease' | 'fly'
  center: LngLat
  zoom: number
  duration: number
}

/**
 * Plan a focus on one point. `distancePx` is the target's screen distance from
 * the current centre at the current zoom (the caller projects it — a target far
 * off screen projects far away, which is what makes a long hop arc).
 */
export function planPointFocus(opts: { to: LngLat; fromZoom: number; distancePx: number; viewport: { width: number; height: number }; ctx?: FocusContext; reducedMotion?: boolean }): CameraPlan {
  const zoom = contextZoom(opts.ctx ?? 'property', opts.fromZoom)
  const diag = Math.hypot(opts.viewport.width, opts.viewport.height)
  if (opts.reducedMotion) return { kind: 'jump', center: opts.to, zoom, duration: 0 }
  const dz = zoom - opts.fromZoom
  const duration = flightDuration(opts.distancePx, diag, dz)
  // On screen (or nearly) and a modest zoom change: a straight ease, no arc.
  const near = opts.distancePx < diag * 0.75 && Math.abs(dz) < 2.5
  return { kind: near ? 'ease' : 'fly', center: opts.to, zoom, duration }
}

export interface BoundsPlan {
  kind: 'bounds'
  bounds: [LngLat, LngLat]
  padding: { top: number; right: number; bottom: number; left: number }
  maxZoom: number
  duration: number
}

/** The bounding box of every usable point (never the first pin). Null when there is none. */
export function boundsOf(points: ReadonlyArray<{ lat: number; lng: number }>): [LngLat, LngLat] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue
    w = Math.min(w, p.lng); e = Math.max(e, p.lng); s = Math.min(s, p.lat); n = Math.max(n, p.lat)
  }
  return Number.isFinite(w) ? [[w, s], [e, n]] : null
}

/**
 * Frame a set. One distinct place is a property focus; several fit their
 * bounds with padding scaled to the pane (ultrawide panes get proportionally
 * more room, narrow panes are never padded to nothing).
 */
export function planSetFocus(opts: {
  points: ReadonlyArray<{ lat: number; lng: number }>
  fromZoom: number
  distancePx: number
  viewport: { width: number; height: number }
  /** room the map's own chrome takes on each side (rail, legend) */
  inset?: Partial<BoundsPlan['padding']>
  reducedMotion?: boolean
  maxZoom?: number
}): CameraPlan | BoundsPlan | null {
  const b = boundsOf(opts.points)
  if (!b) return null
  const [[w, s], [e, n]] = b
  if (Math.abs(e - w) < 1e-6 && Math.abs(n - s) < 1e-6) {
    return planPointFocus({ to: [w, s], fromZoom: opts.fromZoom, distancePx: opts.distancePx, viewport: opts.viewport, reducedMotion: opts.reducedMotion })
  }
  const pad = (side: keyof BoundsPlan['padding'], frac: number, along: number) =>
    Math.round(clamp(along * frac, 24, 140) + (opts.inset?.[side] ?? 0))
  const { width, height } = opts.viewport
  const diag = Math.hypot(width, height)
  return {
    kind: 'bounds',
    bounds: b,
    padding: { top: pad('top', 0.12, height), right: pad('right', 0.08, width), bottom: pad('bottom', 0.14, height), left: pad('left', 0.08, width) },
    maxZoom: opts.maxZoom ?? 15,
    duration: opts.reducedMotion ? 0 : flightDuration(opts.distancePx, diag, 1.5),
  }
}

/* ── the controller ───────────────────────────────────────────────────── */

/** The slice of maplibregl.Map the controller uses (so tests can drive a fake). */
export interface FramerMap {
  flyTo(o: Record<string, unknown>): unknown
  easeTo(o: Record<string, unknown>): unknown
  jumpTo(o: Record<string, unknown>): unknown
  fitBounds(b: [LngLat, LngLat], o: Record<string, unknown>): unknown
  stop(): unknown
  on(type: string, fn: (e: { originalEvent?: unknown }) => void): unknown
  off(type: string, fn: (e: { originalEvent?: unknown }) => void): unknown
}

export interface FlightHandlers {
  /** the camera arrived (not interrupted) */
  onLand?: () => void
  /** the operator took the camera mid-flight */
  onCancel?: () => void
}

/**
 * Runs automatic camera moves and gets out of the way the moment the operator
 * touches the map. One flight at a time; asking for the flight already in the
 * air is a no-op (two triggers for the same focus never stutter the camera).
 */
export function createAutoFramer(map: FramerMap) {
  let active: { key: string; token: number; h: FlightHandlers } | null = null
  let token = 0
  let lastLanded: { key: string; at: number } | null = null

  const finish = (land: boolean) => {
    const a = active
    active = null
    if (!a) return
    if (land) { lastLanded = { key: a.key, at: Date.now() }; a.h.onLand?.() } else a.h.onCancel?.()
  }

  // A gesture (an event with an originalEvent) during an automatic move is the operator taking over.
  const grab = (e: { originalEvent?: unknown }) => {
    if (!active || !e?.originalEvent) return
    map.stop()
    finish(false)
  }
  const onEnd = () => { if (active) finish(true) }
  const GESTURES = ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart', 'wheel', 'touchstart'] as const
  for (const g of GESTURES) map.on(g, grab)
  map.on('moveend', onEnd)

  function run(plan: CameraPlan | BoundsPlan, key: string, h: FlightHandlers = {}): 'started' | 'duplicate' {
    if (active?.key === key) return 'duplicate'
    // the same focus that just landed (two triggers for one action): no second flight
    if (!active && lastLanded?.key === key && Date.now() - lastLanded.at < 1500) { h.onLand?.(); return 'duplicate' }
    if (active) { const prev = active; active = null; prev.h.onCancel?.() }
    token += 1
    active = { key, token, h }
    const mine = token
    const common = { essential: true }
    if (plan.kind === 'bounds') {
      map.fitBounds(plan.bounds, { ...common, padding: plan.padding, maxZoom: plan.maxZoom, duration: plan.duration })
    } else if (plan.kind === 'jump' || plan.duration === 0) {
      map.jumpTo({ center: plan.center, zoom: plan.zoom })
    } else if (plan.kind === 'ease') {
      map.easeTo({ ...common, center: plan.center, zoom: plan.zoom, duration: plan.duration })
    } else {
      map.flyTo({ ...common, center: plan.center, zoom: plan.zoom, duration: plan.duration, curve: 1.42 })
    }
    // a jump (or a move to where the camera already is) may not emit moveend: land it now
    if ((plan.kind === 'jump' || plan.duration === 0) && active?.token === mine) finish(true)
    return 'started'
  }

  return {
    run,
    isFlying: () => active !== null,
    /** stop the current automatic move without blaming the operator */
    cancel: () => { if (active) { map.stop(); finish(false) } },
    dispose: () => {
      for (const g of GESTURES) map.off(g, grab)
      map.off('moveend', onEnd)
      active = null
    },
  }
}

export type AutoFramer = ReturnType<typeof createAutoFramer>
