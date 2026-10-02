import { useEffect, type RefObject } from 'react'
import { useInspector } from '../../../modules/desktop/inspector/inspector-store'

/**
 * Where the floating Universal Inspector covers this Map pane, publish how
 * much of its right edge is covered (--mxd-occlude-right on the Map root) so
 * the legend and zoom stack move out from under it. Measured, not assumed:
 * a Map pane on the left of the workspace is never covered and never moves.
 */
export function useInspectorOcclusion(anchorRef: RefObject<HTMLElement | null>) {
  const open = Boolean(useInspector().current)
  useEffect(() => {
    const root = anchorRef.current?.closest<HTMLElement>('.mx') ?? null
    if (!root) return
    const clear = () => { root.removeAttribute('data-occluded'); root.style.removeProperty('--mxd-occlude-right') }
    if (!open) { clear(); return }
    let raf = 0
    const measure = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const insp = document.querySelector<HTMLElement>('.lc-insp.uinsp')
        if (!insp) { clear(); return }
        const a = root.getBoundingClientRect()
        const b = insp.getBoundingClientRect()
        const overlaps = b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top
        const covered = overlaps ? Math.min(a.width, Math.max(0, a.right - b.left)) : 0
        if (covered < 1) { clear(); return }
        root.setAttribute('data-occluded', '')
        root.style.setProperty('--mxd-occlude-right', `${Math.round(covered + 8)}px`)
      })
    }
    measure()
    // the inspector settles after its entrance (and may be resized by the operator)
    const late = window.setTimeout(measure, 420)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(root)
    const insp = document.querySelector<HTMLElement>('.lc-insp.uinsp')
    if (insp) ro?.observe(insp)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(late)
      ro?.disconnect()
      window.removeEventListener('resize', measure)
      clear()
    }
  }, [open, anchorRef])
}
