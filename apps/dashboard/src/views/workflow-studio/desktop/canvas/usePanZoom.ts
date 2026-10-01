import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * PAN / ZOOM for the spatial board. The transform lives in a ref and is
 * written straight to the world layer inside requestAnimationFrame — React
 * never re-renders while you drag or zoom. React state changes only when the
 * zoom TIER changes (far → mid → near), which swaps the level of detail.
 *
 *   wheel / two-finger scroll   pan
 *   ⌘ / ctrl + wheel, pinch     zoom at the cursor
 *   drag the background         pan
 *   fit · zoomBy · flyTo · recenter   toolbar, keys, deep links
 *
 * PANE-SAFE: the board frames itself once, when it first has a usable size.
 * While the page is still settling (the first ~1.2 s, untouched by the
 * operator) a size change re-applies that same automatic framing, so a late
 * layout never leaves the graph framed for the wrong box. After that — or as
 * soon as the operator pans, zooms or flies — a resize (a pane dragged, an
 * inspector opening, a window snapping) keeps the zoom and keeps the world
 * point under the centre where it was; it never resets. The last view of each
 * board (viewKey) survives leaving and re-entering a mode.
 *
 * Reduced motion turns every animated move into an immediate change.
 */

export interface View { x: number; y: number; k: number }
export type Tier = 'far' | 'mid' | 'near'
export interface Bounds { x: number; y: number; w: number; h: number }

export const tierOf = (k: number): Tier => (k < 0.5 ? 'far' : k < 1.02 ? 'mid' : 'near')
/** room kept clear around the framed graph: floating tools, toolbar, status line */
export interface Pad { t: number; r: number; b: number; l: number }
const SETTLE_MS = 1200

const remembered = new Map<string, View & { w: number; h: number }>()

interface Options {
  bounds: Bounds
  interactive: boolean
  reducedMotion: boolean
  minK?: number
  maxK?: number
  pad?: number | Pad
  /** the largest zoom an automatic fit may choose */
  maxFit?: number
  /** room the caller keeps clear on the right (an open inspector) */
  insetRight?: number
  /** first framing: the whole graph, or a reading zoom anchored on the trigger */
  fitMode?: 'contain' | 'readable'
  /** remembers the operator's view of this board across remounts */
  viewKey?: string | null
}

export function usePanZoom({ bounds, interactive, reducedMotion, minK = 0.12, maxK = 2, pad = 64, maxFit = 1.05, insetRight = 0, fitMode = 'readable', viewKey = null }: Options) {
  const viewport = useRef<HTMLDivElement | null>(null)
  const world = useRef<HTMLDivElement | null>(null)
  const view = useRef<View>({ x: 0, y: 0, k: 1 })
  const framed = useRef(false)
  /** the current view is the automatic framing, made at this time and not touched since */
  const auto = useRef<number | null>(null)
  const size = useRef({ w: 0, h: 0 })
  const frame = useRef(0)
  const anim = useRef(0)
  const listeners = useRef(new Set<(v: View) => void>())
  const [tier, setTier] = useState<Tier>('mid')
  const tierRef = useRef<Tier>('mid')
  const opts = useRef({ bounds, insetRight, pad, maxFit, minK, maxK, fitMode, reducedMotion, viewKey })
  useLayoutEffect(() => { opts.current = { bounds, insetRight, pad, maxFit, minK, maxK, fitMode, reducedMotion, viewKey } })

  const apply = useCallback(() => {
    frame.current = 0
    const { x, y, k } = view.current
    const w = world.current
    const vp = viewport.current
    if (w) w.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${k})`
    if (vp) {
      vp.style.setProperty('--k', String(k))
      vp.style.setProperty('--grid-x', `${x}px`)
      vp.style.setProperty('--grid-y', `${y}px`)
    }
    const t = tierOf(k)
    if (t !== tierRef.current) { tierRef.current = t; setTier(t) }
    const key = opts.current.viewKey
    if (key && framed.current) remembered.set(key, { ...view.current, w: size.current.w, h: size.current.h })
    listeners.current.forEach((l) => l(view.current))
  }, [])

  const schedule = useCallback(() => { if (!frame.current) frame.current = requestAnimationFrame(apply) }, [apply])

  const set = useCallback((v: View) => {
    const { minK: lo, maxK: hi } = opts.current
    view.current = { x: v.x, y: v.y, k: Math.min(hi, Math.max(lo, v.k)) }
    schedule()
  }, [schedule])

  const animateTo = useCallback((target: View, ms = 440) => {
    cancelAnimationFrame(anim.current)
    if (opts.current.reducedMotion || ms <= 0) { set(target); return }
    const from = { ...view.current }
    const t0 = performance.now()
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms)
      const e = 1 - (1 - p) ** 3
      set({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e })
      if (p < 1) anim.current = requestAnimationFrame(step)
    }
    anim.current = requestAnimationFrame(step)
  }, [set])

  /** contain = the whole graph · readable = contain if legible, else a reading zoom anchored on the trigger */
  const fitView = useCallback((mode: 'contain' | 'readable' = 'contain'): View | null => {
    const vp = viewport.current
    const { bounds: b, insetRight: inset, pad: raw, minK: lo, maxFit: hiFit } = opts.current
    if (!vp) return null
    const p: Pad = typeof raw === 'number' ? { t: raw, r: raw, b: raw, l: raw } : raw
    const W = vp.clientWidth - inset
    const H = vp.clientHeight
    const aw = W - p.l - p.r
    const ah = H - p.t - p.b
    if (aw < 40 || ah < 40 || !b.w) return null
    const contain = Math.min(hiFit, Math.max(lo, Math.min(aw / b.w, ah / Math.max(b.h, 1))))
    if (mode === 'readable' && contain < 0.7) {
      // open at a reading zoom anchored on the trigger; the spine (y = 0) centred when the board is taller than the view
      const k = Math.max(0.62, Math.min(0.82, ah / Math.max(b.h, 1)))
      const y = b.h * k <= ah ? p.t + (ah - b.h * k) / 2 - b.y * k : p.t + ah / 2
      return { k, x: p.l - b.x * k, y }
    }
    return { k: contain, x: p.l + (aw - b.w * contain) / 2 - b.x * contain, y: p.t + (ah - b.h * contain) / 2 - b.y * contain }
  }, [])

  const fit = useCallback((animate = true, mode: 'contain' | 'readable' = 'contain') => {
    const v = fitView(mode)
    if (!v) return
    framed.current = true
    auto.current = null
    if (animate) animateTo(v)
    else set(v)
  }, [animateTo, fitView, set])

  /** the automatic framing — re-applied on a resize while the page settles, until the operator moves */
  const autoFrame = useCallback(() => {
    const started = auto.current ?? performance.now()
    fit(false, opts.current.fitMode)
    if (framed.current) auto.current = started
  }, [fit])

  /** Frame a world box in the visible area (left of an open inspector), never zooming past maxK — "show this system's dependencies". */
  const frameBox = useCallback((box: Bounds, maxK = 1) => {
    const vp = viewport.current
    if (!vp || !box.w) return
    const { insetRight: inset, pad: raw, minK: lo } = opts.current
    const p: Pad = typeof raw === 'number' ? { t: raw, r: raw, b: raw, l: raw } : raw
    const aw = vp.clientWidth - inset - p.l - p.r
    const ah = vp.clientHeight - p.t - p.b
    if (aw < 40 || ah < 40) return
    framed.current = true
    auto.current = null
    const k = Math.max(lo, Math.min(maxK, aw / box.w, ah / Math.max(box.h, 1)))
    animateTo({ k, x: p.l + (aw - box.w * k) / 2 - box.x * k, y: p.t + (ah - box.h * k) / 2 - box.y * k })
  }, [animateTo])

  /** Centre a world point (optionally at a zoom) — "open the run centred on the node that holds it". */
  const flyTo = useCallback((wx: number, wy: number, k?: number) => {
    const vp = viewport.current
    if (!vp) return
    const { minK: lo, maxK: hi, insetRight: inset } = opts.current
    framed.current = true
    auto.current = null
    const kk = Math.min(hi, Math.max(lo, k ?? Math.max(view.current.k, 0.86)))
    const W = vp.clientWidth - inset
    animateTo({ k: kk, x: W / 2 - wx * kk, y: vp.clientHeight / 2 - wy * kk })
  }, [animateTo])

  /** Centre the graph at the current zoom. */
  const recenter = useCallback(() => {
    const b = opts.current.bounds
    flyTo(b.x + b.w / 2, b.y + b.h / 2, view.current.k)
  }, [flyTo])

  const zoomBy = useCallback((f: number, cx?: number, cy?: number) => {
    const vp = viewport.current
    if (!vp) return
    const { minK: lo, maxK: hi } = opts.current
    framed.current = true
    auto.current = null
    const { x, y, k } = view.current
    const nk = Math.min(hi, Math.max(lo, k * f))
    const px = cx ?? (vp.clientWidth - opts.current.insetRight) / 2
    const py = cy ?? vp.clientHeight / 2
    set({ k: nk, x: px - ((px - x) / k) * nk, y: py - ((py - y) / k) * nk })
  }, [set])

  const panBy = useCallback((dx: number, dy: number) => {
    framed.current = true
    auto.current = null
    set({ ...view.current, x: view.current.x + dx, y: view.current.y + dy })
  }, [set])

  // frame once; afterwards a resize keeps zoom and keeps the centre's world point centred
  useEffect(() => {
    const vp = viewport.current
    if (!vp) return
    const onSize = () => {
      const w = vp.clientWidth
      const h = vp.clientHeight
      if (w < 40 || h < 40) return
      const prev = size.current
      size.current = { w, h }
      if (!framed.current) {
        const key = opts.current.viewKey
        const saved = key ? remembered.get(key) : null
        if (saved) {
          framed.current = true
          // restore, keeping the remembered centre centred in the new size
          set({ k: saved.k, x: saved.x + (w - saved.w) / 2, y: saved.y + (h - saved.h) / 2 })
        } else autoFrame()
        return
      }
      if (!prev.w || !prev.h || (prev.w === w && prev.h === h)) return
      // still settling and untouched: the automatic framing follows the late layout
      if (auto.current !== null && performance.now() - auto.current < SETTLE_MS) { autoFrame(); return }
      auto.current = null
      set({ ...view.current, x: view.current.x + (w - prev.w) / 2, y: view.current.y + (h - prev.h) / 2 })
    }
    onSize()
    const ro = new ResizeObserver(onSize)
    ro.observe(vp)
    return () => ro.disconnect()
  }, [autoFrame, set])

  useEffect(() => {
    const vp = viewport.current
    if (!vp || !interactive) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      cancelAnimationFrame(anim.current)
      const r = vp.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0024)), e.clientX - r.left, e.clientY - r.top)
      else panBy(-e.deltaX, -e.deltaY)
    }
    let drag: { id: number; x: number; y: number; moved: boolean } | null = null
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const t = e.target as HTMLElement
      if (t.closest('[data-node], [data-edge-hit], button, a, input, select, textarea, [data-no-pan]')) return
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }
      cancelAnimationFrame(anim.current)
    }
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      if (!drag.moved && Math.hypot(dx, dy) < 3) return
      if (!drag.moved) { drag.moved = true; vp.setPointerCapture(e.pointerId); vp.classList.add('is-panning') }
      drag.x = e.clientX; drag.y = e.clientY
      panBy(dx, dy)
    }
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      if (drag.moved) { vp.classList.remove('is-panning'); try { vp.releasePointerCapture(e.pointerId) } catch { /* released */ } }
      else vp.dispatchEvent(new CustomEvent('ws4:background-click', { bubbles: true }))
      drag = null
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    vp.addEventListener('pointerdown', onDown)
    vp.addEventListener('pointermove', onMove)
    vp.addEventListener('pointerup', onUp)
    vp.addEventListener('pointercancel', onUp)
    return () => {
      vp.removeEventListener('wheel', onWheel)
      vp.removeEventListener('pointerdown', onDown)
      vp.removeEventListener('pointermove', onMove)
      vp.removeEventListener('pointerup', onUp)
      vp.removeEventListener('pointercancel', onUp)
    }
  }, [interactive, panBy, zoomBy])

  useEffect(() => () => { cancelAnimationFrame(frame.current); cancelAnimationFrame(anim.current) }, [])

  /** Frame again from scratch (a new graph, the toolbar's "Layout" switch). */
  const reframe = useCallback((mode?: 'contain' | 'readable') => { framed.current = false; auto.current = null; const key = opts.current.viewKey; if (key) remembered.delete(key); fit(false, mode ?? opts.current.fitMode) }, [fit])
  const subscribe = useCallback((l: (v: View) => void) => { listeners.current.add(l); return () => { listeners.current.delete(l) } }, [])
  const getView = useCallback(() => view.current, [])

  return { viewportRef: viewport, worldRef: world, tier, fit, flyTo, frameBox, recenter, zoomBy, panBy, reframe, subscribe, getView }
}
