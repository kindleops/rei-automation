import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Icon, type IconName } from '../icons'
import { playSound } from '../sounds'
import { cx } from './cx'
import { LC_DUR, LC_SPRING, lcEase, useLcReducedMotion } from './motion'
import { subscribeToasts, TOAST_TONE, type LCToastMessage, type LCToastSeverity } from './toast-bus'
import { LCSwipeDismiss } from './SwipeDismiss'
import { LCMonogram } from './Monogram'
import { upsertToast } from './toast-stack'
import './lc-feedback.css'

/**
 * LCToast — the SystemToast renderer. Mount once per shell; raise toasts
 * with `lcToast({...})` from anywhere.
 *
 * Toast = immediate local confirmation of an operator action. It is quiet
 * (smoke material, one tone dot), short-lived, never stacks more than four,
 * and critical toasts stay until dismissed. Nothing here persists: that is
 * the Notification Center's job.
 *
 * Dismiss: the X, Escape / Delete while it has focus, or drag it sideways and
 * flick it away (LCSwipeDismiss — mouse, trackpad drag or touch). A toast
 * raised with the `key` of one on screen updates that one in place.
 */

const MAX_VISIBLE = 4

const GLYPH: Record<LCToastSeverity, IconName> = {
  info: 'bell',
  success: 'check',
  warning: 'alert',
  critical: 'alert-circle',
}

export interface LCToastProps {
  className?: string
  /** skip the bus sound (a host that owns its own sound layer) */
  muted?: boolean
}

export function LCToast({ className, muted }: LCToastProps) {
  const [toasts, setToasts] = useState<LCToastMessage[]>([])
  // the stack is mirrored in a ref so a keyed toast can find (and replace) its slot synchronously
  const stack = useRef<LCToastMessage[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const reduced = useLcReducedMotion()

  const dismiss = useCallback((id: string) => {
    stack.current = stack.current.filter((t) => t.id !== id)
    setToasts(stack.current)
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  useEffect(() => {
    const live = timers.current
    const unsub = subscribeToasts((toast) => {
      const { toasts: next, replacedId } = upsertToast(stack.current, toast, MAX_VISIBLE + 2)
      stack.current = next
      setToasts(next)
      if (!muted && !toast.silent) {
        playSound(toast.sound ?? (toast.severity === 'critical' ? 'alert-triggered' : 'notification'))
      }
      const id = replacedId ?? toast.id
      const prevTimer = live.get(id)
      if (prevTimer) { clearTimeout(prevTimer); live.delete(id) }
      if (toast.autoDismiss !== false) {
        live.set(id, setTimeout(() => dismiss(id), toast.dismissMs ?? 6000))
      }
    })
    return () => {
      unsub()
      for (const timer of live.values()) clearTimeout(timer)
      live.clear()
    }
  }, [dismiss, muted])

  return (
    <div className={cx('lc-toasts', className)} role="region" aria-label="Confirmations" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.slice(0, MAX_VISIBLE).map((toast) => (
          <motion.div
            key={toast.id}
            layout={!reduced}
            className="lc-toast"
            data-tone={TOAST_TONE[toast.severity]}
            role={toast.severity === 'critical' ? 'alert' : 'status'}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, x: 18, transition: { duration: LC_DUR.fast, ease: lcEase('exit') } }}
            transition={reduced ? { duration: LC_DUR.instant } : LC_SPRING.surface}
            aria-roledescription="notification"
          >
          <LCSwipeDismiss className="lc-toast__swipe" onDismiss={() => dismiss(toast.id)}>
            <div
              className={cx('lc-toast__face', toast.onOpen && 'is-openable')}
              tabIndex={0}
              role="group"
              aria-label={`${toast.title}${toast.detail ? `. ${toast.detail}` : ''}. Swipe sideways, press Escape or use Dismiss to clear.`}
              onClick={toast.onOpen ? () => { toast.onOpen?.(); dismiss(toast.id) } : undefined}
              onKeyDown={toast.onOpen ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); toast.onOpen?.(); dismiss(toast.id) } } : undefined}
            >
            {toast.avatar
              ? <span className="lc-toast__avatar" aria-hidden="true"><LCMonogram name={toast.avatar.name} seed={toast.avatar.seed} size={30} /></span>
              : <span className="lc-toast__glyph" aria-hidden="true"><Icon name={GLYPH[toast.severity]} size={14} /></span>}
            <div className="lc-toast__text">
              <b className="lc-toast__title">{toast.title}</b>
              {toast.detail ? <span className="lc-toast__detail">{toast.detail}</span> : null}
              {toast.action ? (
                <button
                  type="button"
                  className="lc-toast__action"
                  onClick={(e) => {
                    e.stopPropagation()
                    toast.action?.onClick()
                    dismiss(toast.id)
                  }}
                >
                  {toast.action.label}
                </button>
              ) : null}
            </div>
            <button type="button" className="lc-toast__close" aria-label="Dismiss" onClick={(e) => { e.stopPropagation(); dismiss(toast.id) }}>
              <Icon name="close" size={12} />
            </button>
            </div>
          </LCSwipeDismiss>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
