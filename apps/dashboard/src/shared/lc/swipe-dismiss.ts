/**
 * SWIPE TO DISMISS — the decision, separate from the gesture (pure).
 *
 * The pointer drives the card 1:1 while it is held (mouse, trackpad drag, pen
 * or touch). On release the card either leaves the screen in the direction it
 * was thrown, or springs back home:
 *
 *   distance   dragged past max(MIN_DISTANCE_PX, DISTANCE_RATIO × width)   → dismiss
 *   flick      released faster than FLICK_VELOCITY in the drag's direction
 *              after at least FLICK_MIN_DISTANCE_PX of travel             → dismiss
 *   thrown back  released moving back toward home faster than
 *              FLICK_VELOCITY                                            → springs back,
 *                                                                          however far it was
 *   otherwise                                                             → springs back
 *
 * Dismissing a notification is VISIBILITY ONLY — the host decides what that
 * means (drop a toast, hide/read an alert); nothing here touches a lead.
 */

export const SWIPE_DISMISS = Object.freeze({
  /** fraction of the card's width that dismisses on a slow drag */
  DISTANCE_RATIO: 0.4,
  /** never less than this many px (narrow cards) */
  MIN_DISTANCE_PX: 80,
  /** px/s — a flick */
  FLICK_VELOCITY: 600,
  /** a flick still has to travel this far (a tap with jitter is not a flick) */
  FLICK_MIN_DISTANCE_PX: 24,
  /** px before the gesture decides it is horizontal (vertical = scroll) */
  AXIS_LOCK_PX: 8,
  /** extra px past the edge the card travels on its way out */
  EXIT_OVERSHOOT_PX: 48,
})

export type SwipeDirection = 'left' | 'right'

export interface SwipeRelease {
  /** px from home at release (negative = left) */
  offset: number
  /** px/s at release (negative = moving left) */
  velocity: number
  /** the card's width in px */
  width: number
}

/** The threshold a slow drag must pass for a card this wide. */
export const dismissDistance = (width: number): number =>
  Math.max(SWIPE_DISMISS.MIN_DISTANCE_PX, Math.max(0, width) * SWIPE_DISMISS.DISTANCE_RATIO)

/** Release → the direction it leaves in, or null (spring back). */
export function settleSwipeDismiss({ offset, velocity, width }: SwipeRelease): SwipeDirection | null {
  const o = Number.isFinite(offset) ? offset : 0
  const v = Number.isFinite(velocity) ? velocity : 0
  if (o === 0) return null
  const dir: SwipeDirection = o < 0 ? 'left' : 'right'
  const sameWay = Math.sign(v) === Math.sign(o)
  // thrown back toward home: it returns, however far it had travelled
  if (!sameWay && Math.abs(v) >= SWIPE_DISMISS.FLICK_VELOCITY) return null
  if (Math.abs(o) >= dismissDistance(width)) return dir
  if (sameWay && Math.abs(v) >= SWIPE_DISMISS.FLICK_VELOCITY && Math.abs(o) >= SWIPE_DISMISS.FLICK_MIN_DISTANCE_PX) return dir
  return null
}

/** Where the card goes on its way out (fully off its own width, plus a little). */
export const exitOffset = (dir: SwipeDirection, width: number): number =>
  (dir === 'left' ? -1 : 1) * (Math.max(0, width) + SWIPE_DISMISS.EXIT_OVERSHOOT_PX)

/** Opacity while dragged: fades as it approaches the dismiss line, never below 0.35 while held. */
export const dragOpacity = (offset: number, width: number): number =>
  Math.max(0.35, 1 - (Math.abs(offset) / Math.max(1, dismissDistance(width))) * 0.45)

/** Which axis a gesture is, once it has moved enough to say (null = not yet). */
export function lockAxis(dx: number, dy: number): 'x' | 'y' | null {
  if (Math.abs(dx) < SWIPE_DISMISS.AXIS_LOCK_PX && Math.abs(dy) < SWIPE_DISMISS.AXIS_LOCK_PX) return null
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
}

/**
 * Release velocity from the last pointer samples (px/s). Uses the samples in
 * the final `windowMs` so a pause before letting go reads as a slow release.
 */
export function releaseVelocity(samples: Array<{ x: number; t: number }>, windowMs = 100): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]
  let first = samples[samples.length - 2]
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > windowMs) break
    first = samples[i]
  }
  const dt = last.t - first.t
  return dt > 0 ? ((last.x - first.x) / dt) * 1000 : 0
}
