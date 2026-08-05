/**
 * WorkspaceSplit — the Deal Desk split-pane engine.
 *
 * Constitution §12. Owns geometry only: the flex container, the gutters,
 * snapping, collapse/maximise, the stack fallback, and the width signal handed
 * to each pane. It never renders or reasons about pane content — that belongs
 * to Lanes C (Inbox), D (Conversation/Composer) and E (Deal Intelligence).
 *
 * Performance contract (R12.7)
 * ----------------------------
 * A pointer drag never touches React state and never changes a pane's box.
 * Only the gutter's own absolutely-positioned ghost moves, via `translate3d`,
 * inside a rAF. The real `flex-grow` values are committed once, on release. So
 * the cost per pointermove is one compositor transform and one textContent
 * write on a `contain: layout` element — no reflow of the heavy pane trees, and
 * therefore no scroll disturbance while dragging (R12.6).
 *
 * Collapse/maximise keep every pane mounted. A parked pane's inner body is
 * frozen at its last live pixel width and clipped, so its scroll containers
 * never relayout and scroll position survives collapse and restore (R12.6).
 */

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  GUTTER_PX,
  MIN_PANE_BASIS,
  RAIL_PX,
  clampBasis,
  resolveBandFromWidth,
  snapBasis,
  type WorkspaceLayout,
} from '../../../shared/workspace/pane-geometry'
import { PaneWidthProvider } from '../../../shared/workspace/PaneWidthContext'
import { useElementWidth } from '../../../shared/workspace/useElementWidth'
import { deriveWidthPercentFromFlex, getViewLayoutMode } from '../../../domain/inbox/view-layout'
import type { ViewWidthPercent } from '../../../domain/inbox/view-layout'
import './workspace-split.css'

const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ')

const ChevronLeft = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const ChevronRight = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const MaximizeGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
)
const RestoreGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6.5 3.5v9" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
)

/* ── Pane ────────────────────────────────────────────────────────────────── */

interface WorkspacePaneProps {
  paneId: string
  label: string
  basis: number
  collapsed: boolean
  /** Mounted but given no space: another pane is maximised, or the stack hides it. */
  parked: boolean
  maximized: boolean
  stacked: boolean
  isPrimary: boolean
  widthLabel: ViewWidthPercent
  registerElement: (paneId: string, element: HTMLDivElement | null) => void
  onExpand: (paneId: string) => void
  children: ReactNode
}

const WorkspacePane = memo(function WorkspacePane({
  paneId,
  label,
  basis,
  collapsed,
  parked,
  maximized,
  stacked,
  isPrimary,
  widthLabel,
  registerElement,
  onExpand,
  children,
}: WorkspacePaneProps) {
  const paneRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const frozen = collapsed || parked
  const lastLiveWidthRef = useRef(0)

  // Observe the pane, not the body: the pane's width comes from flex-grow, so
  // it can never be pushed around by its own content. Quantized to a 16px grid
  // so a pane subtree re-renders at most once per 16px of drag.
  const measuredWidth = useElementWidth(paneRef, { enabled: !frozen, quantum: 16 })

  useEffect(() => {
    if (!frozen && measuredWidth > 0) lastLiveWidthRef.current = measuredWidth
  }, [frozen, measuredWidth])

  // Exact width is published to CSS imperatively — no render, no feedback loop.
  useLayoutEffect(() => {
    const pane = paneRef.current
    if (!pane || frozen) return
    let frame = 0
    const publish = () => {
      frame = 0
      pane.style.setProperty('--lc-pane-width', `${Math.round(pane.getBoundingClientRect().width)}px`)
    }
    publish()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (frame) return
      frame = requestAnimationFrame(publish)
    })
    observer.observe(pane)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [frozen])

  // Freeze the inner body at its last live width before paint, so nothing
  // inside the pane relayouts when it folds — that is what preserves scroll.
  useLayoutEffect(() => {
    const pane = paneRef.current
    const body = bodyRef.current
    if (!pane || !body) return
    if (frozen) {
      const width = lastLiveWidthRef.current || Math.round(body.getBoundingClientRect().width) || 360
      pane.style.setProperty('--lc-pane-frozen-w', `${width}px`)
      // Belt and braces alongside `overflow: clip` — a pane must never scroll.
      if (pane.scrollLeft !== 0) pane.scrollLeft = 0
      if (pane.scrollTop !== 0) pane.scrollTop = 0
    } else {
      pane.style.removeProperty('--lc-pane-frozen-w')
      const width = Math.round(body.getBoundingClientRect().width)
      if (width > 0) lastLiveWidthRef.current = width
    }
  }, [frozen, basis, stacked])

  useLayoutEffect(() => {
    registerElement(paneId, paneRef.current)
    return () => registerElement(paneId, null)
  }, [paneId, registerElement])

  const style = useMemo<CSSProperties>(() => {
    if (stacked) {
      return parked || collapsed
        ? { flex: '0 0 0px', minHeight: 0 }
        : { flex: '1 1 auto', minHeight: 0, minWidth: 0 }
    }
    if (parked) return { flex: '0 0 0px', minWidth: 0 }
    if (collapsed) return { flex: `0 0 ${RAIL_PX}px`, minWidth: `${RAIL_PX}px` }
    return { flexGrow: basis, flexShrink: 1, flexBasis: 0, minWidth: 0 }
  }, [basis, collapsed, parked, stacked])

  const layoutMode = getViewLayoutMode(widthLabel)

  return (
    <div
      ref={paneRef}
      className={cx(
        'nx-workspace-pane',
        `is-view-${paneId}`,
        `is-width-${widthLabel}`,
        `is-layout-${layoutMode}`,
        isPrimary && 'is-primary',
        collapsed && 'is-collapsed',
        parked && 'is-parked',
        maximized && 'is-maximized',
        frozen && 'is-frozen',
      )}
      data-pane-band={collapsed ? 'rail' : resolveBandFromWidth(measuredWidth)}
      data-pane-id={paneId}
      style={{ ...style, ['--lc-pane-basis' as string]: String(basis) }}
      aria-hidden={parked || undefined}
    >
      <div className="nx-workspace-pane__body" ref={bodyRef}>
        <PaneWidthProvider
          paneId={paneId}
          basis={basis}
          widthPx={measuredWidth}
          frozenWidthPx={measuredWidth}
          collapsed={collapsed}
          maximized={maximized}
          stacked={stacked}
          isActive={!parked}
        >
          {children}
        </PaneWidthProvider>
      </div>

      {collapsed && !stacked && (
        <button
          type="button"
          className="nx-workspace-rail"
          onClick={() => onExpand(paneId)}
          aria-label={`Expand ${label} pane`}
          title={`Expand ${label}`}
        >
          <span className="nx-workspace-rail__glyph" aria-hidden="true"><ChevronRight /></span>
          <span className="nx-workspace-rail__label">{label}</span>
        </button>
      )}
    </div>
  )
})

/* ── Gutter ──────────────────────────────────────────────────────────────── */

interface WorkspaceGutterProps {
  leftId: string
  rightId: string
  leftLabel: string
  rightLabel: string
  leftBasis: number
  rightBasis: number
  /** A neighbour is folded — the divider stays focusable but does not drag. */
  inactive: boolean
  measurePair: (leftId: string, rightId: string) => { leftPx: number; rightPx: number }
  onCommit: (leftId: string, rightId: string, nextLeftBasis: number, snap: boolean) => void
  onToggleCollapse: (paneId: string) => void
  onReset: () => void
}

interface DragSession {
  pointerId: number
  startX: number
  pxPerUnit: number
  startBasis: number
  total: number
  next: number
  offset: number
  frame: number
}

const WorkspaceGutter = memo(function WorkspaceGutter({
  leftId,
  rightId,
  leftLabel,
  rightLabel,
  leftBasis,
  rightBasis,
  inactive,
  measurePair,
  onCommit,
  onToggleCollapse,
  onReset,
}: WorkspaceGutterProps) {
  const ghostRef = useRef<HTMLSpanElement>(null)
  const readoutRef = useRef<HTMLSpanElement>(null)
  const dragRef = useRef<DragSession | null>(null)
  const [dragging, setDragging] = useState(false)

  const total = leftBasis + rightBasis
  const min = MIN_PANE_BASIS
  const max = Math.max(min, total - MIN_PANE_BASIS)

  const endDrag = useCallback(() => {
    const session = dragRef.current
    if (session?.frame) cancelAnimationFrame(session.frame)
    dragRef.current = null
    setDragging(false)
    document.body.classList.remove('nx-workspace-resizing')
    if (ghostRef.current) ghostRef.current.style.transform = ''
  }, [])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (inactive || event.button !== 0) return
    const element = event.currentTarget
    const { leftPx, rightPx } = measurePair(leftId, rightId)
    const span = leftPx + rightPx
    if (span <= 0 || total <= 0) return

    // preventDefault stops the text selection a drag would otherwise start, but
    // it also suppresses focus — so hand focus to the divider explicitly. That
    // makes "grab it, then nudge with the arrow keys" work (R12.4).
    event.preventDefault()
    element.focus({ preventScroll: true })
    element.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      pxPerUnit: span / total,
      startBasis: leftBasis,
      total,
      next: leftBasis,
      offset: 0,
      frame: 0,
    }
    setDragging(true)
    document.body.classList.add('nx-workspace-resizing')
  }, [inactive, leftBasis, leftId, measurePair, rightId, total])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const session = dragRef.current
    if (!session || session.pointerId !== event.pointerId) return

    const delta = (event.clientX - session.startX) / session.pxPerUnit
    const raw = clampBasis(session.startBasis + delta, min, max)
    const next = snapBasis(raw, min, max)
    if (next === session.next) return
    session.next = next
    session.offset = (next - session.startBasis) * session.pxPerUnit

    if (session.frame) return
    session.frame = requestAnimationFrame(() => {
      session.frame = 0
      // Compositor-only: nothing in the pane trees is invalidated.
      if (ghostRef.current) ghostRef.current.style.transform = `translate3d(${session.offset}px, 0, 0)`
      if (readoutRef.current) {
        readoutRef.current.textContent = `${Math.round(session.next)}% · ${Math.round(session.total - session.next)}%`
      }
    })
  }, [max, min])

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const session = dragRef.current
    if (!session || session.pointerId !== event.pointerId) return
    const next = session.next
    endDrag()
    if (next !== session.startBasis) onCommit(leftId, rightId, next, true)
  }, [endDrag, leftId, onCommit, rightId])

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        event.preventDefault()
        onCommit(leftId, rightId, clampBasis(leftBasis - step, min, max), false)
        break
      case 'ArrowRight':
      case 'ArrowUp':
        event.preventDefault()
        onCommit(leftId, rightId, clampBasis(leftBasis + step, min, max), false)
        break
      case 'Home':
        event.preventDefault()
        onCommit(leftId, rightId, min, false)
        break
      case 'End':
        event.preventDefault()
        onCommit(leftId, rightId, max, false)
        break
      case 'Enter':
        event.preventDefault()
        onToggleCollapse(leftId)
        break
      case 'Escape':
        if (dragRef.current) {
          event.preventDefault()
          endDrag()
        }
        break
      default:
        break
    }
  }, [endDrag, leftBasis, leftId, max, min, onCommit, onToggleCollapse, rightId])

  useEffect(() => () => {
    document.body.classList.remove('nx-workspace-resizing')
  }, [])

  // The anchor is a ZERO-WIDTH flex item; the interactive strip is absolutely
  // positioned and straddles the boundary. A 12px-wide flex item would tax every
  // pane's share of the workspace — at 1728px that clipped the inbox rail's
  // category nav. Panes now keep their exact percentage and still get a
  // comfortable grab target.
  return (
    <div
      className={cx('nx-workspace-gutter', dragging && 'is-dragging', inactive && 'is-inactive')}
      style={{ flex: '0 0 0px' }}
    >
      <div
        className="nx-workspace-gutter__hit"
        style={{ width: `${GUTTER_PX}px`, marginLeft: `${-GUTTER_PX / 2}px` }}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${leftLabel} and ${rightLabel}`}
        aria-valuenow={Math.round(leftBasis)}
        aria-valuemin={Math.round(min)}
        aria-valuemax={Math.round(max)}
        aria-valuetext={`${leftLabel} ${Math.round(leftBasis)} percent, ${rightLabel} ${Math.round(rightBasis)} percent`}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={endDrag}
        onDoubleClick={onReset}
        onKeyDown={handleKeyDown}
      >
        <span className="nx-workspace-gutter__line" aria-hidden="true" />
        <span className="nx-workspace-gutter__grip" aria-hidden="true" />
        <span className="nx-workspace-gutter__ghost" ref={ghostRef} aria-hidden="true">
          <span className="nx-workspace-gutter__readout" ref={readoutRef}>
            {Math.round(leftBasis)}% · {Math.round(rightBasis)}%
          </span>
        </span>
      </div>
    </div>
  )
})

/* ── Geometry bar ────────────────────────────────────────────────────────── */

interface GeometryBarProps {
  order: string[]
  layout: WorkspaceLayout
  labels: Record<string, string>
  stacked: boolean
  activeStackId: string
  onSelectStack: (paneId: string) => void
  onToggleCollapse: (paneId: string) => void
  onToggleMaximize: (paneId: string) => void
  onReset: () => void
}

const GeometryBar = memo(function GeometryBar({
  order,
  layout,
  labels,
  stacked,
  activeStackId,
  onSelectStack,
  onToggleCollapse,
  onToggleMaximize,
  onReset,
}: GeometryBarProps) {
  return (
    <div className={cx('nx-workspace-bar', stacked && 'is-stacked')} role="group" aria-label="Workspace layout">
      <span className="nx-workspace-bar__legend">{stacked ? 'Panel' : 'Layout'}</span>

      <div className={cx('nx-workspace-bar__chips')} role={stacked ? 'tablist' : undefined}>
        {order.map((paneId) => {
          const pane = layout.panes[paneId]
          if (!pane) return null
          const label = labels[paneId] ?? paneId
          const isMax = layout.maximized === paneId
          const isActive = stacked ? activeStackId === paneId : !pane.collapsed

          if (stacked) {
            return (
              <button
                key={paneId}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={cx('nx-workspace-chip', isActive && 'is-active')}
                onClick={() => onSelectStack(paneId)}
              >
                <span className="nx-workspace-chip__label">{label}</span>
              </button>
            )
          }

          return (
            <span key={paneId} className={cx('nx-workspace-chip', isActive && 'is-active', pane.collapsed && 'is-collapsed')}>
              <button
                type="button"
                className="nx-workspace-chip__fold"
                onClick={() => onToggleCollapse(paneId)}
                aria-label={pane.collapsed ? `Expand ${label} pane` : `Collapse ${label} pane to a rail`}
                title={pane.collapsed ? `Expand ${label}` : `Collapse ${label}`}
              >
                {pane.collapsed ? <ChevronRight /> : <ChevronLeft />}
              </button>
              <span className="nx-workspace-chip__label">{label}</span>
              <span className="nx-workspace-chip__pct">
                {pane.collapsed ? 'rail' : `${Math.round(pane.basis)}%`}
              </span>
              <button
                type="button"
                className={cx('nx-workspace-chip__max', isMax && 'is-on')}
                onClick={() => onToggleMaximize(paneId)}
                aria-pressed={isMax}
                aria-label={isMax ? `Restore ${label} pane` : `Maximise ${label} pane`}
                title={isMax ? `Restore ${label}` : `Maximise ${label}`}
              >
                {isMax ? <RestoreGlyph /> : <MaximizeGlyph />}
              </button>
            </span>
          )
        })}
      </div>

      <button type="button" className="nx-workspace-bar__reset" onClick={onReset} title="Reset workspace layout">
        Reset
      </button>
    </div>
  )
})

/* ── Split ───────────────────────────────────────────────────────────────── */

export interface WorkspaceSplitProps {
  order: string[]
  layout: WorkspaceLayout
  labels: Record<string, string>
  /** Pane that owns keyboard focus / is treated as primary. */
  primaryId?: string
  /** R12.8 — below 1024px the split becomes a stack with explicit navigation. */
  stacked: boolean
  onCommitResize: (leftId: string, rightId: string, nextLeftBasis: number, snap: boolean) => void
  onToggleCollapse: (paneId: string) => void
  onExpand: (paneId: string) => void
  onToggleMaximize: (paneId: string) => void
  onReset: () => void
  renderPane: (paneId: string, widthLabel: ViewWidthPercent) => ReactNode
}

export function WorkspaceSplit({
  order,
  layout,
  labels,
  primaryId,
  stacked,
  onCommitResize,
  onToggleCollapse,
  onExpand,
  onToggleMaximize,
  onReset,
  renderPane,
}: WorkspaceSplitProps) {
  const paneElementsRef = useRef(new Map<string, HTMLDivElement>())

  const registerElement = useCallback((paneId: string, element: HTMLDivElement | null) => {
    if (element) paneElementsRef.current.set(paneId, element)
    else paneElementsRef.current.delete(paneId)
  }, [])

  const measurePair = useCallback((leftId: string, rightId: string) => ({
    leftPx: paneElementsRef.current.get(leftId)?.getBoundingClientRect().width ?? 0,
    rightPx: paneElementsRef.current.get(rightId)?.getBoundingClientRect().width ?? 0,
  }), [])

  /* ── Scroll continuity (R12.6) ─────────────────────────────────────────────
   * "Scroll position is preserved across resize, collapse, and restore."
   *
   * A pane whose width did not change is safe by construction — `resizePair`
   * conserves the pair's basis, so no other pane's box moves. The pane that DID
   * change is not: its virtualised lists re-measure on the width change and
   * settle on a different offset, some of it asynchronously.
   *
   * So every geometry commit is bracketed: snapshot the scroll offsets of every
   * scroll container in the workspace *before* the state change (in the event
   * handler, while the old DOM is still live), then re-apply them after layout,
   * after the next frame, and once more after the virtualiser has settled.
   * This is geometry work — it never reaches into what a pane renders. */
  const scrollSnapshotRef = useRef<Array<{ el: Element; top: number; left: number }>>([])
  const restoreTimersRef = useRef<number[]>([])

  const captureScroll = useCallback(() => {
    const snapshot: Array<{ el: Element; top: number; left: number }> = []
    paneElementsRef.current.forEach((pane) => {
      const nodes = pane.querySelectorAll('*')
      for (const node of nodes) {
        if (node.scrollTop > 0 || node.scrollLeft > 0) {
          snapshot.push({ el: node, top: node.scrollTop, left: node.scrollLeft })
        }
      }
    })
    scrollSnapshotRef.current = snapshot
  }, [])

  const restoreScroll = useCallback(() => {
    for (const { el, top, left } of scrollSnapshotRef.current) {
      if (!el.isConnected) continue
      /* The ref holds DOM nodes; writing their scroll offset is the entire
       * purpose. `react-hooks/immutability` reads this as mutating ref state. */
      // eslint-disable-next-line react-hooks/immutability
      if (el.scrollTop !== top) el.scrollTop = top
      if (el.scrollLeft !== left) el.scrollLeft = left
    }
  }, [])

  // Pre-paint pass. Deliberately has no cleanup: the async passes below must
  // survive the unrelated re-renders this page produces constantly (polling,
  // realtime patches). Tying them to an effect's lifecycle cancelled them.
  useLayoutEffect(() => {
    if (scrollSnapshotRef.current.length > 0) restoreScroll()
  }, [layout, restoreScroll])

  const scheduleRestore = useCallback(() => {
    restoreTimersRef.current.forEach((id) => window.clearTimeout(id))
    requestAnimationFrame(restoreScroll)
    // Virtualised lists re-measure asynchronously after a width change. Two
    // staggered late passes catch the offset they settle on; the window stays
    // short enough that it can never fight a deliberate operator scroll.
    restoreTimersRef.current = [
      window.setTimeout(restoreScroll, 160),
      window.setTimeout(() => {
        restoreScroll()
        scrollSnapshotRef.current = []
      }, 420),
    ]
  }, [restoreScroll])

  useEffect(() => () => {
    restoreTimersRef.current.forEach((id) => window.clearTimeout(id))
  }, [])

  const withScrollContinuity = useCallback(<A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      captureScroll()
      action(...args)
      scheduleRestore()
    }, [captureScroll, scheduleRestore])

  const handleCommitResize = useMemo(() => withScrollContinuity(onCommitResize), [withScrollContinuity, onCommitResize])
  const handleToggleCollapse = useMemo(() => withScrollContinuity(onToggleCollapse), [withScrollContinuity, onToggleCollapse])
  const handleExpand = useMemo(() => withScrollContinuity(onExpand), [withScrollContinuity, onExpand])
  const handleToggleMaximize = useMemo(() => withScrollContinuity(onToggleMaximize), [withScrollContinuity, onToggleMaximize])
  const handleReset = useMemo(() => withScrollContinuity(onReset), [withScrollContinuity, onReset])

  // Stack navigation (R12.8). Defaults to the primary pane, follows it when the
  // operator changes focus, and never points at a pane that went away.
  // Adjusted during render rather than in an effect — syncing this in an effect
  // renders the stale pane for a frame and cascades an extra render.
  const [stack, setStack] = useState<{ id: string; primary: string | undefined }>(
    () => ({ id: primaryId ?? order[0] ?? '', primary: primaryId }),
  )
  let stackId = stack.id
  if (stack.primary !== primaryId) {
    stackId = primaryId ?? order[0] ?? ''
    setStack({ id: stackId, primary: primaryId })
  }
  const setStackId = useCallback((id: string) => {
    setStack((current) => ({ ...current, id }))
  }, [])

  const activeStackId = order.includes(stackId) ? stackId : (primaryId ?? order[0] ?? '')

  const isParked = useCallback((paneId: string) => {
    if (stacked) return paneId !== activeStackId
    return Boolean(layout.maximized) && layout.maximized !== paneId
  }, [activeStackId, layout.maximized, stacked])

  const visibleGutterIndexes = useMemo(() => {
    if (stacked || layout.maximized) return new Set<number>()
    const set = new Set<number>()
    for (let index = 1; index < order.length; index += 1) set.add(index)
    return set
  }, [layout.maximized, order, stacked])

  if (order.length === 0) return null

  return (
    <div className={cx('nx-workspace-geometry', stacked && 'is-stacked')} data-pane-count={order.length}>
      {order.length > 1 && (
        <GeometryBar
          order={order}
          layout={layout}
          labels={labels}
          stacked={stacked}
          activeStackId={activeStackId}
          onSelectStack={setStackId}
          onToggleCollapse={handleToggleCollapse}
          onToggleMaximize={handleToggleMaximize}
          onReset={handleReset}
        />
      )}

      <section className="nx-workspace-split-grid" data-orientation={stacked ? 'vertical' : 'horizontal'}>
        {order.map((paneId, index) => {
          const pane = layout.panes[paneId]
          if (!pane) return null
          const parked = isParked(paneId)
          const maximized = layout.maximized === paneId
          const basis = maximized ? 100 : pane.basis
          const widthLabel = pane.collapsed
            ? ('25' as ViewWidthPercent)
            : deriveWidthPercentFromFlex(stacked ? 100 : basis)

          const previousId = order[index - 1]
          const previousPane = previousId ? layout.panes[previousId] : null
          const showGutter = index > 0 && visibleGutterIndexes.has(index) && Boolean(previousPane)

          return (
            <Fragment key={paneId}>
              {showGutter && previousId && previousPane && (
                <WorkspaceGutter
                  leftId={previousId}
                  rightId={paneId}
                  leftLabel={labels[previousId] ?? previousId}
                  rightLabel={labels[paneId] ?? paneId}
                  leftBasis={previousPane.basis}
                  rightBasis={pane.basis}
                  inactive={previousPane.collapsed || pane.collapsed}
                  measurePair={measurePair}
                  onCommit={handleCommitResize}
                  onToggleCollapse={handleToggleCollapse}
                  onReset={handleReset}
                />
              )}
              <WorkspacePane
                paneId={paneId}
                label={labels[paneId] ?? paneId}
                basis={basis}
                collapsed={pane.collapsed && !stacked}
                parked={parked}
                maximized={maximized}
                stacked={stacked}
                isPrimary={paneId === primaryId}
                widthLabel={widthLabel}
                registerElement={registerElement}
                onExpand={handleExpand}
              >
                {renderPane(paneId, widthLabel)}
              </WorkspacePane>
            </Fragment>
          )
        })}
      </section>
    </div>
  )
}
