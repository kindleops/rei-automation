import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { clampPlaneWidth, PLANE_MIN } from './plane-split'

const VAR = '--ciw-plane-user'

/** Live geometry, read only inside event handlers (never during render). */
function geometry(handle: HTMLElement) {
  const body = handle.closest<HTMLElement>('.ciw-body')
  const root = handle.closest<HTMLElement>('.ciw')
  const plane = body?.querySelector<HTMLElement>(':scope > .ciw-plane') ?? null
  const insights = body?.querySelector<HTMLElement>(':scope > .ciw-insights') ?? null
  return { root, plane: plane?.getBoundingClientRect().width ?? PLANE_MIN, body: body?.clientWidth ?? 0, insights: insights?.getBoundingClientRect().width ?? 0 }
}

/**
 * The map ↔ plane splitter. Dragging writes the CSS variable straight onto the
 * app root (no React render per pointer move — the map stays smooth) and
 * commits once on release. Keyboard: ←/→ resize (Shift = larger steps),
 * Home/End = narrowest/widest, Enter or double-click = back to the layout's
 * own width.
 */
export function PlaneSplitter({ width, onCommit }: { width: number | null; onCommit: (w: number | null) => void }) {
  const drag = useRef<{ x: number; start: number; body: number; insights: number; root: HTMLElement | null; last: number } | null>(null)

  const apply = (root: HTMLElement | null, w: number) => { root?.style.setProperty(VAR, `${w}px`) }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const g = geometry(e.currentTarget)
    drag.current = { x: e.clientX, start: g.plane, body: g.body, insights: g.insights, root: g.root, last: Math.round(g.plane) }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.dataset.dragging = '1'
    e.preventDefault()
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    // the plane is to the RIGHT of the handle: moving left widens it
    d.last = clampPlaneWidth(d.start - (e.clientX - d.x), d.body, d.insights)
    apply(d.root, d.last)
  }
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    delete e.currentTarget.dataset.dragging
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (Math.abs(d.last - d.start) >= 1) onCommit(d.last)
  }
  const reset = (el: HTMLElement) => { el.closest<HTMLElement>('.ciw')?.style.removeProperty(VAR); onCommit(null) }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const g = geometry(e.currentTarget)
    const step = e.shiftKey ? 120 : 32
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = g.plane + step
    else if (e.key === 'ArrowRight') next = g.plane - step
    else if (e.key === 'Home') next = PLANE_MIN
    else if (e.key === 'End') next = Number.MAX_SAFE_INTEGER
    else if (e.key === 'Enter') { e.preventDefault(); reset(e.currentTarget); return }
    if (next === null) return
    e.preventDefault()
    const w = clampPlaneWidth(next, g.body, g.insights)
    apply(g.root, w)
    onCommit(w)
  }

  return (
    <div
      className="ciw-split"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the map and the evidence plane"
      aria-valuenow={width ?? undefined}
      aria-valuetext={width ? `Plane ${width} pixels wide` : 'Plane at its default width'}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(e) => reset(e.currentTarget)}
      onKeyDown={onKeyDown}
    >
      <span className="ciw-split__grip" aria-hidden="true" />
    </div>
  )
}
