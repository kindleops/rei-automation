/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PANE SCROLL RETENTION — R12.6
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Scroll position is preserved across resize, collapse, and restore."
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 * The first implementation bracketed the operator's *own* geometry actions:
 * snapshot on the way into `onCommitResize` / `onToggleCollapse` / …, re-apply
 * afterwards. That covers a gutter drag and a collapse. It does not cover a
 * VIEWPORT resize, because no handler of ours runs — the browser relayouts, the
 * virtualised list re-measures, and the offset is gone. Measured: scroll 220px,
 * viewport 1728 → 1500, scroll back to 0.
 *
 * ── The shape of the fix ───────────────────────────────────────────────────
 * 1. RECORD CONTINUOUSLY, not at the start of an action. Every scroll inside a
 *    pane updates a per-container target. By the time a resize arrives the
 *    operator's intended offset is already known, which is the only way to
 *    survive an event we do not originate.
 * 2. RESTORE ON SETTLE, not on a timer. The previous code re-applied at
 *    +0/+160/+420ms and still drifted ~20px on expand-Deal-Intelligence,
 *    because the virtualiser settles after 420ms. Widening the timer is a
 *    guess. Instead a ResizeObserver watches each scroll container and its
 *    content; every observed size change re-applies the target and pushes the
 *    quiet deadline out. Retention ends when the layout has been quiet for
 *    `QUIET_MS` and every target is met — i.e. when the thing that was
 *    clobbering the offset has stopped, whenever that is.
 * 3. NEVER RECORD A CLAMP. When a pane narrows, the browser clamps scrollTop
 *    and fires a scroll event. Recording that would overwrite the operator's
 *    position with the clamped value — the retention loop would then faithfully
 *    restore 0. Recording is therefore suppressed inside a retention window
 *    unless a real input gesture (wheel / touch / key / pointer) was seen, and
 *    any such gesture ends retention immediately so we never fight the
 *    operator.
 *
 * This module is geometry-only. It never reads or reasons about pane content.
 */
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'

interface Offsets {
  top: number
  left: number
}

/** Layout must be quiet this long before retention is considered finished. */
const QUIET_MS = 260
/** Absolute ceiling on one retention window. Never fight the operator forever. */
const MAX_RETENTION_MS = 5_000
/** A gesture this recent means the operator is driving; record what they do. */
const INTENT_GRACE_MS = 220

const isScrollable = (el: Element): boolean =>
  el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1

/**
 * Structural path from the pane root to a descendant: `2.0.1`.
 *
 * The obvious key — "nth scrollable inside this pane" — is not stable. A pane
 * that narrows can gain or lose a scroll container (a toolbar that starts
 * overflowing, a list that no longer does), which shifts every ordinal after
 * it, and the retention loop then restores one container's offset onto a
 * different container. A child-index path does not move when a sibling's
 * overflow state changes.
 */
function pathKey(pane: HTMLElement, el: Element): string | null {
  const parts: number[] = []
  let node: Element | null = el
  while (node && node !== pane) {
    const parent: HTMLElement | null = node.parentElement
    if (!parent) return null
    parts.push(Array.prototype.indexOf.call(parent.children, node))
    node = parent
  }
  if (node !== pane) return null
  return parts.reverse().join('.')
}

/** Scroll containers inside a pane, with their structural keys. */
function scrollablesIn(pane: HTMLElement): Array<{ el: HTMLElement; path: string }> {
  const out: Array<{ el: HTMLElement; path: string }> = []
  for (const el of pane.querySelectorAll<HTMLElement>('*')) {
    if (!isScrollable(el)) continue
    const path = pathKey(pane, el)
    if (path) out.push({ el, path })
  }
  return out
}

export interface PaneScrollRetention {
  /** Snapshot current offsets synchronously, before a geometry change lands. */
  record: () => void
  /** A geometry change has happened (ours or the viewport's). Hold the offsets. */
  markGeometryChange: () => void
  /** Re-apply immediately — used pre-paint, from a layout effect. */
  applyNow: () => void
}

export function usePaneScrollRetention(
  paneElementsRef: RefObject<Map<string, HTMLDivElement>>,
): PaneScrollRetention {
  /** `${paneId}@${structuralPath}` → the offset the operator last chose. */
  const targetsRef = useRef(new Map<string, Offsets>())
  const keyByElementRef = useRef(new WeakMap<Element, string>())

  const retentionUntilRef = useRef(0)
  const quietDeadlineRef = useRef(0)
  const lastIntentRef = useRef(0)
  const frameRef = useRef(0)
  const observerRef = useRef<ResizeObserver | null>(null)
  const tickRef = useRef(0)

  const keyFor = useCallback((el: Element): string | null => {
    const cached = keyByElementRef.current.get(el)
    if (cached) return cached
    const pane = el.closest<HTMLElement>('[data-pane-id]')
    const paneId = pane?.dataset.paneId
    if (!pane || !paneId) return null
    const path = pathKey(pane, el)
    if (!path) return null
    const key = `${paneId}@${path}`
    keyByElementRef.current.set(el, key)
    return key
  }, [])

  /** Walk every pane and write down where each scroll container currently sits. */
  const record = useCallback(() => {
    const panes = paneElementsRef.current
    if (!panes) return
    panes.forEach((pane, paneId) => {
      for (const { el, path } of scrollablesIn(pane)) {
        const key = `${paneId}@${path}`
        keyByElementRef.current.set(el, key)
        if (el.scrollTop > 0 || el.scrollLeft > 0 || targetsRef.current.has(key)) {
          targetsRef.current.set(key, { top: el.scrollTop, left: el.scrollLeft })
        }
      }
    })
  }, [paneElementsRef])

  /**
   * Re-apply every known target. Returns true when nothing needed changing —
   * i.e. every container is already where the operator left it, or physically
   * cannot get there yet because its content has not grown back.
   */
  const applyTargets = useCallback((): boolean => {
    const panes = paneElementsRef.current
    if (!panes || targetsRef.current.size === 0) return true
    let settled = true
    panes.forEach((pane, paneId) => {
      for (const { el, path } of scrollablesIn(pane)) {
        const key = `${paneId}@${path}`
        keyByElementRef.current.set(el, key)
        const target = targetsRef.current.get(key)
        if (!target) continue
        const maxTop = Math.max(0, el.scrollHeight - el.clientHeight)
        const maxLeft = Math.max(0, el.scrollWidth - el.clientWidth)
        const wantTop = Math.min(target.top, maxTop)
        const wantLeft = Math.min(target.left, maxLeft)
        if (Math.abs(el.scrollTop - wantTop) > 0.5) {
          el.scrollTop = wantTop
          settled = false
        }
        if (Math.abs(el.scrollLeft - wantLeft) > 0.5) {
          el.scrollLeft = wantLeft
          settled = false
        }
        // The content has not finished growing back, so the target is not yet
        // reachable. Not settled, even though we changed nothing this pass.
        if (wantTop < target.top || wantLeft < target.left) settled = false
      }
    })
    return settled
  }, [paneElementsRef])

  const stopRetention = useCallback(() => {
    retentionUntilRef.current = 0
    quietDeadlineRef.current = 0
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
    if (tickRef.current) {
      window.clearTimeout(tickRef.current)
      tickRef.current = 0
    }
    observerRef.current?.disconnect()
  }, [])

  const scheduleApply = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      applyTargets()
    })
  }, [applyTargets])

  /**
   * Observe every scroll container and its immediate children. A virtualiser
   * settling shows up as a size change on the spacer child; that is the event
   * that used to lose the offset, so that is the event we restore on.
   */
  const observeContainers = useCallback(() => {
    const panes = paneElementsRef.current
    const observer = observerRef.current
    if (!panes || !observer) return
    observer.disconnect()
    panes.forEach((pane) => {
      for (const { el } of scrollablesIn(pane)) {
        observer.observe(el)
        for (const child of el.children) observer.observe(child)
      }
    })
  }, [paneElementsRef])

  const pump = useCallback(() => {
    const now = Date.now()
    const settled = applyTargets()
    const expired = now > retentionUntilRef.current
    const quiet = now > quietDeadlineRef.current
    if (expired || (settled && quiet)) {
      stopRetention()
      return
    }
    observeContainers()
    tickRef.current = window.setTimeout(pump, 80)
  }, [applyTargets, observeContainers, stopRetention])

  const markGeometryChange = useCallback(() => {
    const now = Date.now()
    retentionUntilRef.current = now + MAX_RETENTION_MS
    quietDeadlineRef.current = now + QUIET_MS
    if (!observerRef.current && typeof ResizeObserver !== 'undefined') {
      observerRef.current = new ResizeObserver(() => {
        if (Date.now() > retentionUntilRef.current) return
        // Something re-laid out. Push the quiet deadline and restore again.
        quietDeadlineRef.current = Date.now() + QUIET_MS
        scheduleApply()
      })
    }
    applyTargets()
    scheduleApply()
    observeContainers()
    if (tickRef.current) window.clearTimeout(tickRef.current)
    tickRef.current = window.setTimeout(pump, 80)
  }, [applyTargets, observeContainers, pump, scheduleApply])

  const applyNow = useCallback(() => {
    applyTargets()
  }, [applyTargets])

  useEffect(() => {
    const onScroll = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const now = Date.now()
      const retaining = now < retentionUntilRef.current
      const operatorDriving = now - lastIntentRef.current < INTENT_GRACE_MS
      // A clamp during retention is the browser talking, not the operator.
      if (retaining && !operatorDriving) return
      const key = keyFor(target)
      if (!key) return
      targetsRef.current.set(key, { top: target.scrollTop, left: target.scrollLeft })
    }

    const onIntent = (event: Event) => {
      const target = event.target
      if (target instanceof Element && !target.closest('[data-pane-id]')) return
      lastIntentRef.current = Date.now()
      // The operator is scrolling. Stop restoring, immediately.
      if (retentionUntilRef.current) stopRetention()
    }

    const onResize = () => {
      // Fires after the browser has relaid out but before the clamp's scroll
      // events are dispatched, so opening the retention window here is what
      // stops the clamped value being recorded as the operator's choice.
      markGeometryChange()
    }

    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    document.addEventListener('wheel', onIntent, { capture: true, passive: true })
    document.addEventListener('touchstart', onIntent, { capture: true, passive: true })
    document.addEventListener('touchmove', onIntent, { capture: true, passive: true })
    document.addEventListener('pointerdown', onIntent, { capture: true, passive: true })
    document.addEventListener('keydown', onIntent, { capture: true, passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      document.removeEventListener('wheel', onIntent, { capture: true })
      document.removeEventListener('touchstart', onIntent, { capture: true })
      document.removeEventListener('touchmove', onIntent, { capture: true })
      document.removeEventListener('pointerdown', onIntent, { capture: true })
      document.removeEventListener('keydown', onIntent, { capture: true })
      window.removeEventListener('resize', onResize)
    }
  }, [keyFor, markGeometryChange, stopRetention])

  useEffect(() => () => {
    stopRetention()
    observerRef.current = null
  }, [stopRetention])

  // Stable identity: consumers put this in effect dependency arrays, and a new
  // object every render would re-open a retention window on every render.
  return useMemo(
    () => ({ record, markGeometryChange, applyNow }),
    [record, markGeometryChange, applyNow],
  )
}
