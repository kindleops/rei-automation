/**
 * APPEARANCE RUNTIME — live preview, publication, and the one transition.
 *
 *  · A DRAFT overlays the stored settings while the operator drags (hue,
 *    intensity, blur …). It repaints the product through CSS variables only:
 *    nothing is written to storage, nothing in the React tree re-renders
 *    except the control being dragged. The Studio commits the draft (one
 *    save) when the gesture settles.
 *  · publishAppearance writes the generated token sheet (<style id=
 *    "lc-appearance">) and a few attributes — only when they changed.
 *  · withAppearanceTransition runs a discrete change (theme, preset, saved
 *    environment, material) inside one short crossfade of the whole system
 *    instead of a hard swap; under reduced motion it is immediate.
 */
import type { AccentId } from './accents'
import type { AppearanceState, MaterialState } from './appearance'
import { appearanceAttributes, computeAppearance, type AppearanceComputed, type AppearanceInput } from './tokens'

export interface AppearanceDraft {
  accentPalette?: AccentId
  appearance?: AppearanceState
  liquidGlass?: MaterialState
}

let draft: AppearanceDraft | null = null
let frame = 0
const listeners = new Set<() => void>()

const notify = () => {
  frame = 0
  for (const fn of listeners) fn()
}

export const getAppearanceDraft = () => draft

/** Replace the live-preview overlay (null clears it). Repaints at most once per frame. */
export function setAppearanceDraft(next: AppearanceDraft | null): void {
  draft = next
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return notify()
  if (!frame) frame = window.requestAnimationFrame(notify)
}

export function subscribeAppearanceDraft(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

const STYLE_ID = 'lc-appearance'
let lastComputed: AppearanceComputed | null = null

/** Write the token sheet + attributes for these settings. Cheap when nothing changed. */
export function publishAppearance(input: AppearanceInput): AppearanceComputed {
  const computed = computeAppearance(input)
  lastComputed = computed
  if (typeof document === 'undefined') return computed
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  if (el.textContent !== computed.css) el.textContent = computed.css
  const root = document.documentElement
  for (const [name, value] of Object.entries(appearanceAttributes(computed, input.appearance, input.liquidGlass))) {
    if (value === null) root.removeAttribute(name)
    else if (root.getAttribute(name) !== value) root.setAttribute(name, value)
  }
  return computed
}

/** The most recently published appearance (what is on screen now). */
export const currentAppearance = () => lastComputed

export type AppearanceTransitionKind = 'theme' | 'accent' | 'material' | 'environment'

/** Crossfade durations (ms) — mirror LC_MOTION in shared/lc/motion.ts. */
const DURATION: Record<AppearanceTransitionKind, number> = { theme: 300, accent: 180, material: 340, environment: 420 }

type ViewTransition = { finished: Promise<void>; ready?: Promise<void>; updateCallbackDone?: Promise<void>; skipTransition?: () => void }
type ViewTransitionDoc = Document & { startViewTransition?: (cb: () => void) => ViewTransition }

function motionReduced(): boolean {
  if (typeof window === 'undefined') return true
  if (document.documentElement.getAttribute('data-lc-motion') === 'off') return true
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Updates waiting for the current transition's DOM-update callback, in click order. */
let queued: Array<() => void> | null = null
/** A transition is animating (its update already ran; the live DOM is under the new snapshot). */
let animating = false
/** Never let a transition hold the system longer than this (a busy machine can stall frames). */
const SAFETY_MS = 1200

function runQueued() {
  const list = queued ?? []
  queued = null
  for (const fn of list) fn()
}

/**
 * Run a discrete appearance change as one coherent transition of the whole
 * system (a single crossfade — never every token animating on its own).
 *
 * Ordering is guaranteed: a change made while a transition is still waiting
 * to capture is queued behind it and applied in the same update, in order.
 * The overlay never blocks the pointer (see desktop-backdrop.css), and a
 * transition that stalls is skipped after SAFETY_MS — the change still lands.
 */
export function withAppearanceTransition(kind: AppearanceTransitionKind, update: () => void): void {
  if (queued) { queued.push(update); return }
  const doc = (typeof document === 'undefined' ? null : document) as ViewTransitionDoc | null
  if (!doc || animating || motionReduced() || typeof doc.startViewTransition !== 'function' || doc.visibilityState !== 'visible') {
    update()
    return
  }
  const root = doc.documentElement
  queued = [update]
  animating = true
  root.setAttribute('data-lc-vt', kind)
  root.style.setProperty('--lc-vt-duration', `${DURATION[kind]}ms`)
  let settled = false
  const done = () => {
    if (settled) return
    settled = true
    window.clearTimeout(safety)
    if (queued) runQueued()
    animating = false
    root.removeAttribute('data-lc-vt')
    root.style.removeProperty('--lc-vt-duration')
  }
  let transition: ViewTransition | null = null
  const safety = window.setTimeout(() => {
    try { transition?.skipTransition?.() } catch { /* already finished */ }
    done()
  }, SAFETY_MS)
  try {
    transition = doc.startViewTransition(runQueued)
    // a skipped transition rejects `ready` — expected, not an error
    void transition.ready?.catch(() => undefined)
    void transition.updateCallbackDone?.catch(() => undefined)
    void transition.finished.catch(() => undefined).finally(done)
  } catch {
    done()
  }
}
