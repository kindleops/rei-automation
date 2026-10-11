import { useCallback, useEffect, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { animate, motion, useMotionValue, type AnimationPlaybackControls } from 'framer-motion'
import { cx } from './cx'
import { useLcReducedMotion } from './motion'
import { dragOpacity, exitOffset, lockAxis, releaseVelocity, settleSwipeDismiss, type SwipeDirection } from './swipe-dismiss'

export interface LCSwipeDismissProps {
  children: ReactNode
  /** called once the card has left the screen (visibility only — the host decides what dismiss means) */
  onDismiss: (dir: SwipeDirection) => void
  disabled?: boolean
  className?: string
  style?: CSSProperties
  /** which ways it may leave (default both) */
  directions?: 'both' | 'left' | 'right'
  /** keyboard: Escape / Delete / Backspace on a focused element inside dismisses (default true) */
  keyboard?: boolean
}

const RELEASE_SPRING = { type: 'spring', stiffness: 520, damping: 36, mass: 0.8 } as const

/**
 * LCSwipeDismiss — drag a notification sideways and flick it away.
 *
 * Follows the pointer 1:1 (mouse, trackpad drag, pen, touch) once the gesture
 * is clearly horizontal; a vertical gesture is left to the scroller. On release
 * it leaves in the thrown direction or springs home with the release velocity
 * (swipe-dismiss.ts decides). A click that ends a drag never reaches the card.
 * Reduced motion: no spring, no travel — it returns at once or fades out.
 */
export function LCSwipeDismiss({ children, onDismiss, disabled, className, style, directions = 'both', keyboard = true }: LCSwipeDismissProps) {
  const reduced = useLcReducedMotion()
  const x = useMotionValue(0)
  const opacity = useMotionValue(1)
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; sx: number; x0: number; y0: number; axis: 'x' | 'y' | null; samples: Array<{ x: number; t: number }> } | null>(null)
  const suppressClick = useRef(false)
  const anim = useRef<AnimationPlaybackControls[]>([])
  const gone = useRef(false)

  const stop = () => { for (const a of anim.current) a.stop(); anim.current = [] }
  useEffect(() => () => stop(), [])

  const allowed = useCallback((dir: SwipeDirection) => directions === 'both' || directions === dir, [directions])

  const leave = useCallback((dir: SwipeDirection, velocity = 0) => {
    if (gone.current) return
    gone.current = true
    stop()
    const width = ref.current?.getBoundingClientRect().width ?? 320
    if (reduced) {
      anim.current = [animate(opacity, 0, { duration: 0.12 })]
      void anim.current[0].finished.then(() => onDismiss(dir))
      return
    }
    const target = exitOffset(dir, width)
    const remaining = Math.abs(target - x.get())
    const speed = Math.max(Math.abs(velocity), 1400)
    const duration = Math.min(0.32, Math.max(0.14, remaining / speed))
    const a = animate(x, target, { duration, ease: [0.2, 0.7, 0.3, 1] })
    anim.current = [a, animate(opacity, 0, { duration })]
    void a.finished.then(() => onDismiss(dir))
  }, [onDismiss, opacity, reduced, x])

  const home = useCallback((velocity = 0) => {
    stop()
    if (reduced) { x.set(0); opacity.set(1); return }
    anim.current = [animate(x, 0, { ...RELEASE_SPRING, velocity }), animate(opacity, 1, { duration: 0.18 })]
  }, [opacity, reduced, x])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || gone.current || (e.pointerType === 'mouse' && e.button !== 0)) return
    // controls inside the card keep their own press (the X, an action) — a drag can still start on the body
    if ((e.target as Element).closest('input, textarea, select, [contenteditable="true"]')) return
    stop()
    suppressClick.current = false
    drag.current = { id: e.pointerId, sx: e.clientX, x0: e.clientX - x.get(), y0: e.clientY, axis: null, samples: [{ x: e.clientX, t: e.timeStamp }] }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x0
    const dy = e.clientY - d.y0
    if (!d.axis) {
      d.axis = lockAxis(e.clientX - d.sx, dy)
      if (d.axis === 'y') { drag.current = null; return }
      if (d.axis === 'x') { try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not capturable */ } }
      else return
    }
    d.samples.push({ x: e.clientX, t: e.timeStamp })
    if (d.samples.length > 8) d.samples.shift()
    // a way it may not leave resists (rubber band), so the card still feels physical
    const next = (dx < 0 && !allowed('left')) || (dx > 0 && !allowed('right')) ? dx * 0.18 : dx
    x.set(next)
    opacity.set(dragOpacity(next, e.currentTarget.getBoundingClientRect().width))
    suppressClick.current = true
  }
  const end = (e: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const d = drag.current
    drag.current = null
    if (!d || d.id !== e.pointerId || d.axis !== 'x') return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* released */ }
    const velocity = releaseVelocity(d.samples)
    const dir = cancelled ? null : settleSwipeDismiss({ offset: x.get(), velocity, width: e.currentTarget.getBoundingClientRect().width })
    if (dir && allowed(dir)) leave(dir, velocity)
    else home(velocity)
  }
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return
    suppressClick.current = false
    e.preventDefault()
    e.stopPropagation()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!keyboard || disabled || e.defaultPrevented) return
    if ((e.target as Element).closest('input, textarea, select, [contenteditable="true"]')) return
    if (e.key === 'Escape' || e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      leave(allowed('right') ? 'right' : 'left')
    }
  }

  return (
    <motion.div
      ref={ref}
      className={cx('lc-swipe', className)}
      style={{ ...style, x, opacity, touchAction: 'pan-y' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => end(e)}
      onPointerCancel={(e) => end(e, true)}
      onClickCapture={onClickCapture}
      onKeyDown={onKeyDown}
    >
      {children}
    </motion.div>
  )
}
