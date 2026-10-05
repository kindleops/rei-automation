/**
 * WHO MAY MOVE THE CAMERA — the Map's three camera drivers, reconciled.
 *
 *   linked / Show on Map   a focus request (the workspace bus, an explicit
 *                          Show on Map) — the newest operator selection
 *   arrival                the host's active property (activeContext) changed
 *   auto-nav               the host's selected thread changed
 *
 * QA (owner, RC 8.3.2): a Pipeline table click flew the Map to the deal, then
 * it snapped BACK to the previous property. The host's activeContext still
 * named the previous property (the deal had no thread to re-select), and the
 * arrival effect re-ran when the pin field reloaded for the new viewport. It
 * compared against `arrivedPropertyRef`, which the focus request had just
 * overwritten with the NEW property — so the old, unchanged active property
 * looked like a fresh arrival and the camera flew back to it.
 *
 * The rules, kept pure so they are testable:
 *   - arrival acts only when the active property CHANGED since it was last
 *     handled; a focus request marks the current active value handled
 *     (superseded), so a re-run never resurrects it
 *   - an active property the camera already shows is settled, not re-flown
 *   - auto-nav never re-flies the same thread on a coordinate refinement
 *     after a focus request has taken the camera elsewhere
 */

export type ArrivalDecision = 'idle' | 'skip' | 'settle' | 'arrive'

export function decideArrival(input: {
  /** the host's active property id ('' / null = none) */
  active: string | null
  /** the active value arrival last handled (or a focus request superseded) */
  handled: string | null
  /** the property the camera last focused, by any driver */
  lastFocused: string | null
}): ArrivalDecision {
  const { active, handled, lastFocused } = input
  if (!active) return 'idle'
  if (handled === active) return 'skip'
  if (lastFocused === active) return 'settle'
  return 'arrive'
}

export interface AutoNavMark { threadId: string; key: string; claim: number }

export type AutoNavDecision = 'skip' | 'mark' | 'fly'

/**
 * `claim` increments on every focus request. A changed key for the SAME
 * thread is only a coordinate refinement; once the camera was claimed since
 * that thread was flown to, the refinement must not drag it back.
 */
export function decideAutoNav(prev: AutoNavMark | null, next: { threadId: string; key: string }, claim: number): AutoNavDecision {
  if (prev && prev.key === next.key) return 'skip'
  if (prev && prev.threadId === next.threadId && prev.claim !== claim) return 'mark'
  return 'fly'
}

/**
 * Seller pins: the first load of a pane is staged (a fast capped pass, then
 * the full field). A RESUME — the host's message load lifted `paused` — must
 * not run the capped pass again: it replaced the visible field with 500 pins
 * and then refilled it, the blink on every Inbox click.
 */
export function pinLoadPlan(hasPins: boolean): Array<'stage_1' | 'stage_2'> {
  return hasPins ? ['stage_2'] : ['stage_1', 'stage_2']
}
