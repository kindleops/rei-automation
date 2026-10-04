/**
 * Multi-Inbox layout: 1 pane full width · 2 = 50/50 · 3 = thirds on ultrawide,
 * 50/25/25 otherwise · 4 = four columns on ultrawide, 2×2 on a narrower desk.
 * Decided from the Inbox's own measured width (container, never viewport).
 *
 * The dividers are the workspace's own seam (.ws-divider, same pointer + arrow-
 * key behaviour as desktop/workspace) bound to this layout's proportions, which
 * persist with the Inbox instance. Each pane is its own error boundary.
 */
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ErrorBoundary } from '../../../shared/ErrorBoundary'
import { LCSegmented, cx } from '../../../shared/lc'
import './multi-inbox.css'
import { MIN_PANE_PX, PANE_COUNTS, layoutFor, paneFlex, paneIndexForKey, setSizes, focusPane, type MultiInboxState, type PaneCount } from './multi-inbox-model'

export function MultiInboxCountControl({ count, onChange }: { count: PaneCount; onChange: (n: PaneCount) => void }) {
  return (
    <LCSegmented
      className="ixm-count"
      size="sm"
      label="Inbox panes"
      options={PANE_COUNTS.map((n) => ({ value: String(n), label: String(n), title: n === 1 ? 'One Inbox' : `${n} Inboxes side by side` }))}
      value={String(count)}
      onChange={(value) => onChange(Number(value) as PaneCount)}
    />
  )
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

function Seam({ index, sizes, containerRef, onSizes }: { index: number; sizes: number[]; containerRef: React.RefObject<HTMLDivElement>; onSizes: (s: number[]) => void }) {
  const [active, setActive] = useState(false)
  const clamp = useCallback((a: number, start: number[], length: number) => {
    const pair = start[index] + start[index + 1]
    const min = Math.min(MIN_PANE_PX / Math.max(1, length), pair / 2)
    return Math.min(pair - min, Math.max(min, a))
  }, [index])
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = containerRef.current
    if (!el) return
    const box = el.getBoundingClientRect()
    const start = [...sizes]
    const before = start.slice(0, index).reduce((s, v) => s + v, 0)
    let raf = 0
    let last = start
    setActive(true)
    const move = (ev: PointerEvent) => {
      const a = clamp((ev.clientX - box.left) / box.width - before, start, box.width)
      last = [...start]
      last[index + 1] = start[index] + start[index + 1] - a
      last[index] = a
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; onSizes(last) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (raf) { cancelAnimationFrame(raf); onSizes(last) }
      setActive(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const width = containerRef.current?.getBoundingClientRect().width ?? 1
    const step = (e.shiftKey ? 80 : 24) / width
    const next = [...sizes]
    const a = clamp(sizes[index] + (e.key === 'ArrowLeft' ? -step : step), sizes, width)
    next[index + 1] = sizes[index] + sizes[index + 1] - a
    next[index] = a
    onSizes(next)
  }
  return (
    <div
      className={cx('ws-divider', 'is-row', 'ixm-seam', active && 'is-active')}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize Inbox ${index + 1} and Inbox ${index + 2}`}
      aria-valuenow={Math.round(sizes[index] * 100)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <i aria-hidden="true" />
    </div>
  )
}

export function MultiInboxLayout(props: {
  state: MultiInboxState
  /** false → exactly Inbox 1, no layout chrome (count 1) */
  active: boolean
  update: (fn: (s: MultiInboxState) => MultiInboxState) => void
  /** Inbox 1 (the desk) */
  primary: ReactNode
  /** Inboxes 2..count */
  secondaries: ReactNode[]
}) {
  if (!props.active) return <>{props.primary}</>
  return <MultiInboxColumns {...props} />
}

function MultiInboxColumns({
  state, update, primary, secondaries,
}: {
  state: MultiInboxState
  update: (fn: (s: MultiInboxState) => MultiInboxState) => void
  primary: ReactNode
  secondaries: ReactNode[]
}) {
  const paneNodes = [primary, ...secondaries]
  const [ref, width] = useWidth<HTMLDivElement>()
  const layout = layoutFor(state.count, width || 1920, state.sizes[state.count])

  // ⌥1-⌥4 focus a pane — only inside the Inbox, never in a text field (audited: no conflict)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    const index = paneIndexForKey(e)
    if (index == null || index >= state.count) return
    e.preventDefault()
    update((s) => focusPane(s, index))
    ref.current?.querySelector<HTMLElement>(`[data-ixm-pane="${index}"] .ixl-list, [data-ixm-pane="${index}"] [role="listbox"]`)?.focus({ preventScroll: true })
  }

  const slots: ReactNode[] = paneNodes.slice(0, state.count).flatMap((node, i) => {
    const flex = layout.kind === 'columns' ? paneFlex(layout.sizes, i) : undefined
    const pane = (
      <div
        key={`pane-${i}`}
        className={cx('ixm-pane', state.focused === i && 'is-focused')}
        data-ixm-pane={i}
        style={flex ? { flex } : undefined}
        onFocusCapture={() => { if (state.focused !== i) update((s) => focusPane(s, i)) }}
        onPointerDownCapture={() => { if (state.focused !== i) update((s) => focusPane(s, i)) }}
      >
        <ErrorBoundary label={`Inbox ${i + 1}`} resetKey={`${i}`}>{node}</ErrorBoundary>
      </div>
    )
    if (layout.kind !== 'columns' || i >= state.count - 1) return [pane]
    return [pane, <Seam key={`seam-${i}`} index={i} sizes={layout.sizes} containerRef={ref} onSizes={(sizes) => update((s) => setSizes(s, s.count, sizes))} />]
  })

  return (
    <div
      ref={ref}
      className={cx('ixm', `is-count-${state.count}`, `is-${layout.kind}`)}
      onKeyDown={onKeyDown}
      data-ixm-width={width}
    >
      {slots}
    </div>
  )
}

