/**
 * THE INBOX LIST NEVER MOVES ITSELF.
 *
 * Only an explicit operator gesture (scrolling, keyboard cursor movement, a
 * "jump to newest" control, switching bucket) may change where the list is
 * scrolled. Data updates, realtime events, Load More and selection changes
 * must leave what the operator is reading exactly where it is.
 *
 * Two defects violated that:
 *  - the desk ledger re-ran `scrollToRow(cursor)` whenever the row ids
 *    changed (every realtime event / poll / Load More rebuilds them), so the
 *    list snapped back to the last opened conversation the moment the
 *    operator scrolled away from it;
 *  - its scroll anchor followed ONE row (the first visible). When that row
 *    received a reply and re-sorted to the top, the "anchor" moved the whole
 *    viewport to the top with it.
 *
 * `anchoredRowShift` replaces the single-row anchor: it measures how far the
 * rows the operator can SEE moved, by majority, so one row re-sorting away
 * never drags the viewport, while rows inserted above the fold are
 * compensated so the visible content stays put.
 */

export interface VisibleRowsSnapshot {
  /** Index of the first visible row when the snapshot was taken. */
  startIndex: number
  /** Ids of the visible rows, in order, starting at `startIndex`. */
  ids: readonly string[]
}

export function snapshotVisibleRows(rowIds: readonly string[], startIndex: number, stopIndex: number): VisibleRowsSnapshot | null {
  if (startIndex < 0 || stopIndex < startIndex || startIndex >= rowIds.length) return null
  return { startIndex, ids: rowIds.slice(startIndex, Math.min(rowIds.length, stopIndex + 1)) }
}

/**
 * How many rows the visible content moved between `before` and `nextRowIds`
 * (positive = pushed down by rows inserted above). The majority shift of the
 * visible rows that still exist wins; ties prefer the smallest movement, and
 * no evidence means no movement.
 */
export function anchoredRowShift(before: VisibleRowsSnapshot | null, nextRowIds: readonly string[]): number {
  if (!before || before.ids.length === 0) return 0
  const nextIndex = new Map<string, number>()
  nextRowIds.forEach((id, index) => { if (!nextIndex.has(id)) nextIndex.set(id, index) })
  const votes = new Map<number, number>()
  before.ids.forEach((id, offset) => {
    const next = nextIndex.get(id)
    if (next === undefined) return
    const shift = next - (before.startIndex + offset)
    votes.set(shift, (votes.get(shift) ?? 0) + 1)
  })
  let best = 0
  let bestVotes = 0
  for (const [shift, count] of votes) {
    if (count > bestVotes || (count === bestVotes && Math.abs(shift) < Math.abs(best))) {
      best = shift
      bestVotes = count
    }
  }
  return bestVotes === 0 ? 0 : best
}

/**
 * The scrollTop that keeps the visible content in place after the rows
 * changed. At the very top the list stays at the top (newest-first: a new
 * reply should be seen, not hidden above the fold).
 */
export function heldScrollTop(currentScrollTop: number, before: VisibleRowsSnapshot | null, nextRowIds: readonly string[], rowHeight: number): number {
  if (currentScrollTop <= 0) return currentScrollTop
  const shift = anchoredRowShift(before, nextRowIds)
  if (shift === 0) return currentScrollTop
  return Math.max(0, currentScrollTop + shift * rowHeight)
}

/**
 * An `initialScrollOffset` is applied once, when the list first has rows.
 * Re-applying it on later prop changes turned the offset the list itself
 * reports into a feedback loop that snapped the viewport back while the
 * operator scrolled.
 */
export function shouldApplyInitialOffset(alreadyApplied: boolean, itemCount: number): boolean {
  return !alreadyApplied && itemCount > 0
}
