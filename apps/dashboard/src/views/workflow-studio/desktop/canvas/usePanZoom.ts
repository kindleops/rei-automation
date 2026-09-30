import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * PAN / ZOOM for the spatial board. The transform lives in a ref and is written
 * straight to the world layer inside requestAnimationFrame — React never
 * re-renders while you drag or zoom. React state changes only when the zoom
 * TIER changes (far → mid → near), which is what swaps the level of detail.
 *
 *   wheel            pan (trackpad two-finger scroll)
 *   ctrl/⌘ + wheel   zoom at the cursor (trackpad pinch arrives as ctrl+wheel)
 *   drag background  pan
 *   fit / zoomBy / flyTo  for the toolbar, keyboard and deep links
 *
 * Reduced motion (OS or the global motion setting) turns every animated move
 * into an immediate state change.
 */

export interface View { x: number; y: number; k: number }
export type Tier = 'far' | 'mid' | 'near'
export interface Bounds { x: number; y: number; w: number; h: number }

export const tierOf = (k: number): Tier => (k < 0.5 ? 'far' : k < 1.02 ? 'mid' : 'near')

interface Options {
  bounds: Bounds
  interactive: boolean
  reducedMotion: boolean
  minK?: number
  maxK?: number
  pad?: number
  /** extra room the caller keeps clear on the right (an open inspector) */
  insetRight?: number
  onView?: (v: View) => void
  /** how the board frames itself before the operator takes the wheel */
  fitMode?: 'contain' | 'readable'
}

export function usePanZoom({ bounds, interactive, reducedMotion, minK = 0.16, maxK = 1.9, pad = 72, insetRight = 0, onView, fitMode = 'readable' }: Options) {
  const viewport = useRef<HTMLDivElement | null>(null)
  const world = useRef<HTMLDivElement | null>(null)
  const view = useRef<View>({ x: 0, y: 0, k: 1 })
  const touched = useRef(false)
  const frame = useRef(0)
  const anim = useRef(0)
  const [tier, setTier] = useState<Tier>('mid')
  const tierRef = useRef<Tier>('mid')
  const onViewRef = useRef(onView)
  onViewRef.current = onView

  const apply = useCallback(() => {
    frame.current = 0
    const { x, y, k } = view.current
    const w = world.current
    const vp = viewport.current
    if (w) w.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${k})`
    if (vp) {
      vp.style.setProperty('--k', String(k))
      vp.style.backgroundPosition = `${x}px ${y}px, ${x}px ${y}px`
      vp.style.backgroundSize = `${24 * k}px ${24 * k}px, ${120 * k}px ${120 * k}px`
    }
    const t = tierOf(k)
    if (t !== tierRef.current) { tierRef.current = t; setTier(t) }
    onViewRef.current?.(view.current)
  }, [])

  const schedule = useCallback(() => { if (!frame.current) frame.current = requestAnimationFrame(apply) }, [apply])

  const set = useCallback((v: View) => {
    view.current = { x: v.x, y: v.y, k: Math.min(maxK, Math.max(minK, v.k)) }
    schedule()
  }, [maxK, minK, schedule])

  const animateTo = useCallback((target: View, ms = 420) => {
    cancelAnimationFrame(anim.current)
    if (reducedMotion || ms <= 0) { set(target); return }
    const from = { ...view.current }
    const t0 = performance.now()
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms)
      const e = 1 - (1 - p) ** 3
      set({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e })
      if (p < 1) anim.current = requestAnimationFrame(step)
    }
    anim.current = requestAnimationFrame(step)
  }, [reducedMotion, set])

  /**
   * contain  — the whole graph in view (toolbar Fit, the mini graph)
   * readable — contain if that is still legible; otherwise open at a reading
   *            zoom anchored on the trigger (left), the rest one pan away
   */
  const fitView = useCallback((b: Bounds = bounds, mode: 'contain' | 'readable' = 'contain'): View | null => {
    const vp = viewport.current
    if (!vp) return null
    const W = vp.clientWidth - insetRight
    const H = vp.clientHeight
    if (W < 40 || H < 40 || !b.w) return null
    const contain = Math.min(1.05, Math.max(minK, Math.min((W - pad * 2) / b.w, (H - pad * 2) / Math.max(b.h, 1))))
    if (mode === 'readable' && contain < 0.6) {
      // open at a reading zoom anchored on the trigger; every lane visible when the pane allows
      const k = Math.max(0.52, Math.min(0.62, (H - pad * 2) / Math.max(b.h, 1)))
      const y = b.h * k <= H - pad ? (H - b.h * k) / 2 - b.y * k : H / 2
      return { k, x: pad - b.x * k, y }
    }
    return { k: contain, x: (W - b.w * contain) / 2 - b.x * contain, y: (H - b.h * contain) / 2 - b.y * contain }
  }, [bounds, insetRight, minK, pad])

  const fit = useCallback((animate = true, mode: 'contain' | 'readable' = 'contain') => {
    const v = fitView(bounds, mode)
    if (v) (animate ? animateTo(v) : set(v))
  }, [animateTo, bounds, fitView, set])

  /** Centre a world point (optionally at a zoom) — used for "open the run centred on the held node". */
  const flyTo = useCallback((wx: number, wy: number, k?: number) => {
    const vp = viewport.current
    if (!vp) return
    touched.current = true
    const kk = Math.min(maxK, Math.max(minK, k ?? Math.max(view.current.k, 0.9)))
    const W = vp.clientWidth - insetRight
    animateTo({ k: kk, x: W / 2 - wx * kk, y: vp.clientHeight / 2 - wy * kk })
  }, [animateTo, insetRight, maxK, minK])

  const zoomBy = useCallback((f: number, cx?: number, cy?: number) => {
    const vp = viewport.current
    if (!vp) return
    touched.current = true
    const { x, y, k } = view.current
    const nk = Math.min(maxK, Math.max(minK, k * f))
    const px = cx ?? vp.clientWidth / 2
    const py = cy ?? vp.clientHeight / 2
    set({ k: nk, x: px - ((px - x) / k) * nk, y: py - ((py - y) / k) * nk })
  }, [maxK, minK, set])

  const panBy = useCallback((dx: number, dy: number) => {
    touched.current = true
    set({ ...view.current, x: view.current.x + dx, y: view.current.y + dy })
  }, [set])

  // first fit, and refit on resize until the operator takes the wheel
  useEffect(() => {
    const vp = viewport.current
    if (!vp) return
    const refit = () => { if (!touched.current) fit(false, fitMode) }
    refit()
    const ro = new ResizeObserver(refit)
    ro.observe(vp)
    return () => ro.disconnect()
  }, [fit, fitMode])

  useEffect(() => {
    const vp = viewport.current
    if (!vp || !interactive) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      touched.current = true
      cancelAnimationFrame(anim.current)
      const r = vp.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0024)), e.clientX - r.left, e.clientY - r.top)
      else panBy(-e.deltaX, -e.deltaY)
    }
    let drag: { id: number; x: number; y: number; moved: boolean } | null = null
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const t = e.target as HTMLElement
      if (t.closest('[data-node], button, a, input, [data-no-pan]')) return
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
      else vp.dispatchEvent(new CustomEvent('ws3:background-click', { bubbles: true }))
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

  const reframe = useCallback(() => { touched.current = false; fit(false, fitMode) }, [fit, fitMode])

  return { viewport, world, view, tier, fit, flyTo, zoomBy, panBy, set, fitView, reframe, markTouched: () => { touched.current = true } }
}
