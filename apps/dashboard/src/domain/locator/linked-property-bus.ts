/**
 * THE LINKED-PROPERTY BUS — how a selection in one app reaches every other
 * open app in the desktop workspace.
 *
 * This is not a second locator. `setPropertyLocator` (./property-locator) is
 * still the ONE place a selection is published; it persists the locator and
 * fires the immediate `nexus:property-locator` event exactly as before (the
 * Command Deck chip, the dock and the launcher read that). On top of it, this
 * module emits a FOLLOW signal for the apps that move with the selection:
 *
 *   seq      monotonically increasing — a follower acts only on the latest
 *   source   the workspace instance the operator was acting in when the
 *            selection was made (resolved by the shell). A follower never
 *            follows its own selection, so nothing ping-pongs
 *   debounce rapid clicks collapse into one signal for the LAST click, so fast
 *            list navigation does not fan out N heavy reads (Map preview,
 *            comps, buyer match) per click
 *   dedupe   a publish that names the subject already broadcast is not
 *            re-broadcast (a follower that re-selects the same property while
 *            catching up enriches the stored locator and stops there)
 *   apply    while a follower is applying a linked selection
 *            (`withLinkedApply`), its own re-selection never re-broadcasts and
 *            never re-aims the locator at a different subject
 *
 * Read-only by construction: the bus carries identifiers. It never launches an
 * app (only already-mounted followers hear it), never focuses one, never
 * writes anything server-side.
 */
import type { PropertyLocator } from './property-locator'

export const LINKED_PROPERTY_EVENT = 'nexus:linked-property'
export const LINKED_DEBOUNCE_MS = 140

export interface LinkedPropertySignal {
  locator: PropertyLocator
  seq: number
  /** the workspace instance id the selection came from, when the shell knows it */
  source: string | null
  at: number
}

type Ids = Pick<PropertyLocator, 'propertyId' | 'threadKey' | 'opportunityId'> & Partial<PropertyLocator>

/**
 * Do two locators name the same subject? The property is the anchor: when
 * both carry one it decides. Otherwise a shared deal or thread does.
 */
export function sameSubject(a: Ids | null | undefined, b: Ids | null | undefined): boolean {
  if (!a || !b) return false
  if (a.propertyId && b.propertyId) return a.propertyId === b.propertyId
  if (a.opportunityId && b.opportunityId) return a.opportunityId === b.opportunityId
  if (a.threadKey && b.threadKey) return a.threadKey === b.threadKey
  return false
}

/** Same subject: the newer publish wins field by field, but never erases what it does not carry. */
export function mergeSameSubject(prev: PropertyLocator, next: PropertyLocator): PropertyLocator {
  return {
    propertyId: next.propertyId ?? prev.propertyId,
    threadKey: next.threadKey ?? prev.threadKey,
    masterOwnerId: next.masterOwnerId ?? prev.masterOwnerId,
    prospectId: next.prospectId ?? prev.prospectId,
    opportunityId: next.opportunityId ?? prev.opportunityId,
    address: next.address ?? prev.address,
    setAt: next.setAt,
  }
}

/* ── source attribution (registered by the desktop shell) ─────────────── */

let sourceResolver: (() => string | null) | null = null
export function setLinkedSourceResolver(fn: (() => string | null) | null) { sourceResolver = fn }
const resolveSource = (): string | null => { try { return sourceResolver?.() ?? null } catch { return null } }

/* ── follower re-selection guard ──────────────────────────────────────── */

let applying = 0
export const isApplyingLinked = () => applying > 0
/** Run a follower's re-selection: anything it publishes is not a new selection. */
export function withLinkedApply<T>(fn: () => T): T {
  applying += 1
  try { return fn() } finally { applying -= 1 }
}

/* ── broadcast ────────────────────────────────────────────────────────── */

let seq = 0
let last: LinkedPropertySignal | null = null
let pending: LinkedPropertySignal | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function dispatch(signal: LinkedPropertySignal) {
  last = signal
  try { window.dispatchEvent(new CustomEvent(LINKED_PROPERTY_EVENT, { detail: signal })) } catch { /* non-DOM */ }
}

function flushPending() {
  if (timer !== null) { clearTimeout(timer); timer = null }
  const p = pending
  pending = null
  if (p) dispatch(p)
}

export type AnnounceOutcome = 'scheduled' | 'coalesced' | 'deduped' | 'suppressed' | 'held'

/* ── explicit opens ───────────────────────────────────────────────────── */

/**
 * AN EXPLICIT OPEN OUTRANKS AMBIENT SELECTION.
 *
 * "Open Deal Intelligence / Entity Graph / Buyer Match / Comps" for a deal
 * names its subject. It used to go through the same debounced, latest-wins
 * publish as any selection — so a different subject published in the same
 * moment (a host re-publishing its own active thread, a follower's late
 * write) could win the debounce, and the pane the operator just opened was
 * re-aimed at the OTHER property (QA: DI for 2939 Lyndale showed 3226 Aldrich,
 * the Inbox thread's property).
 *
 * An explicit publish is broadcast at once with a fresh sequence (never
 * debounced, coalesced or deduped) and holds its subject for EXPLICIT_HOLD_MS:
 * a publish naming a DIFFERENT subject inside the hold is not broadcast and
 * does not re-aim the locator. The hold is shorter than any deliberate second
 * click in another pane while the new pane materializes.
 */
export const EXPLICIT_HOLD_MS = 900
let hold: { locator: PropertyLocator; until: number } | null = null

/** True while an explicit open holds a different subject than `locator`. */
export function isHeldAgainst(locator: Ids, now = Date.now()): boolean {
  if (!hold) return false
  if (now > hold.until) { hold = null; return false }
  return !sameSubject(hold.locator, locator)
}

/**
 * Called by setPropertyLocator for every real publish. Schedules (or
 * coalesces into) one trailing signal; returns what it did, for tests.
 */
export function announceLinkedProperty(locator: PropertyLocator): AnnounceOutcome {
  if (isApplyingLinked()) return 'suppressed'
  if (isHeldAgainst(locator)) return 'held'
  const source = resolveSource()
  if (pending) {
    if (sameSubject(pending.locator, locator)) {
      pending = { ...pending, locator: mergeSameSubject(pending.locator, locator) }
      return 'coalesced'
    }
  } else if (last && sameSubject(last.locator, locator)) {
    last = { ...last, locator: mergeSameSubject(last.locator, locator) }
    return 'deduped'
  }
  seq += 1
  pending = { locator, seq, source, at: Date.now() }
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(flushPending, LINKED_DEBOUNCE_MS)
  return 'scheduled'
}

/** Broadcast an explicit open now (fresh seq, no debounce / dedupe) and hold its subject. */
export function announceExplicitProperty(locator: PropertyLocator): LinkedPropertySignal {
  if (timer !== null) { clearTimeout(timer); timer = null }
  pending = null
  seq += 1
  const signal: LinkedPropertySignal = { locator, seq, source: resolveSource(), at: Date.now() }
  hold = { locator, until: signal.at + EXPLICIT_HOLD_MS }
  dispatch(signal)
  return signal
}

/** The selection was cleared: nothing is pending and the next publish is new. */
export function resetLinkedProperty() {
  if (timer !== null) { clearTimeout(timer); timer = null }
  pending = null
  last = null
  hold = null
}

/** The last selection broadcast (a re-linked pane catches up with it). */
export const readLastLinkedSignal = (): LinkedPropertySignal | null => last

export function subscribeLinkedProperty(fn: (signal: LinkedPropertySignal) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const on = (e: Event) => { const d = (e as CustomEvent<LinkedPropertySignal>).detail; if (d?.locator) fn(d) }
  window.addEventListener(LINKED_PROPERTY_EVENT, on)
  return () => window.removeEventListener(LINKED_PROPERTY_EVENT, on)
}

/* ── follower core (React-free so it is testable) ─────────────────────── */

export interface LinkedApplyContext {
  seq: number
  /** aborted the moment a newer selection arrives (or the follower unmounts) */
  signal: AbortSignal
  /** run a re-selection under the guard — skipped when this run is stale */
  apply: <T>(fn: () => T) => T | undefined
}

export type LinkedHandler = (locator: PropertyLocator, ctx: LinkedApplyContext) => void

/**
 * One follower: skips its own selections, ignores a subject it already
 * shows, and cancels the previous run when a newer one arrives (latest wins).
 */
export function createLinkedFollower(instanceId: string | null, handler: LinkedHandler) {
  let shown: PropertyLocator | null = null
  let run: AbortController | null = null
  const onSignal = (s: LinkedPropertySignal) => {
    if (instanceId && s.source === instanceId) { shown = s.locator; return }
    if (sameSubject(shown, s.locator)) return
    run?.abort()
    const ctl = new AbortController()
    run = ctl
    shown = s.locator
    const ctx: LinkedApplyContext = {
      seq: s.seq,
      signal: ctl.signal,
      apply: (fn) => (ctl.signal.aborted ? undefined : withLinkedApply(fn)),
    }
    withLinkedApply(() => handler(s.locator, ctx))
  }
  return {
    onSignal,
    /** the follower changed subject by itself (no broadcast) */
    setShown: (loc: PropertyLocator | null) => { shown = loc },
    dispose: () => { run?.abort(); run = null },
  }
}

/** Test seam. */
export const __linkedTest = {
  flush: flushPending,
  reset: () => { resetLinkedProperty(); seq = 0; applying = 0; sourceResolver = null; hold = null },
  last: () => last,
}
