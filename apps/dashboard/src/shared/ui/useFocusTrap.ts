import { useEffect, useRef } from 'react'

/**
 * Focus management for overlays — constitution §11.3 / §16.3.
 *
 * There were previously ZERO focus traps in the application. Every overlay
 * primitive in `src/shared/ui` routes through this hook so the behaviour is
 * defined exactly once:
 *
 *  - focus moves into the overlay on open (first focusable, else the container)
 *  - Tab / Shift+Tab cycle within the overlay while `trap` is true
 *  - focus returns to the invoking element on close (never lost to <body>)
 *  - Esc closes, unless the caller opts out
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export const getFocusable = (root: HTMLElement | null): HTMLElement[] => {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.hasAttribute('disabled')) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  })
}

export interface FocusTrapOptions {
  open: boolean
  onClose: () => void
  /** Cycle Tab inside the container. Modals/drawers: true. Popovers: false. */
  trap?: boolean
  /** Esc closes. Default true. */
  closeOnEsc?: boolean
  /** Move focus into the container on open. Default true. */
  autoFocus?: boolean
  /** Explicit element to restore focus to; defaults to document.activeElement at open. */
  restoreFocusRef?: React.RefObject<HTMLElement | null>
}

export function useFocusTrap<T extends HTMLElement>(
  containerRef: React.RefObject<T | null>,
  { open, onClose, trap = true, closeOnEsc = true, autoFocus = true, restoreFocusRef }: FocusTrapOptions,
) {
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // Remember the invoker, move focus in, and restore on close.
  useEffect(() => {
    if (!open) return
    previouslyFocused.current =
      restoreFocusRef?.current ?? (document.activeElement as HTMLElement | null)

    if (autoFocus) {
      // Wait a frame so portalled content is in the DOM and measurable.
      const raf = requestAnimationFrame(() => {
        const container = containerRef.current
        if (!container) return
        if (container.contains(document.activeElement)) return
        const [first] = getFocusable(container)
        if (first) first.focus()
        else {
          container.setAttribute('tabindex', '-1')
          container.focus()
        }
      })
      return () => cancelAnimationFrame(raf)
    }
    return undefined
  }, [open, autoFocus, containerRef, restoreFocusRef])

  useEffect(() => {
    if (!open) return
    // Captured at open time — the invoker cannot change while the overlay is up,
    // and reading at cleanup time would race the unmount.
    const target = restoreFocusRef?.current ?? previouslyFocused.current
    return () => {
      if (target && document.contains(target)) {
        // Restore asynchronously so the closing overlay is already unmounted.
        requestAnimationFrame(() => target.focus())
      }
    }
  }, [open, restoreFocusRef])

  // Esc + Tab cycling.
  useEffect(() => {
    if (!open) return

    const handleKey = (event: KeyboardEvent) => {
      if (closeOnEsc && event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        onCloseRef.current()
        return
      }

      if (!trap || event.key !== 'Tab') return
      const container = containerRef.current
      if (!container) return

      const focusable = getFocusable(container)
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null

      if (!container.contains(active)) {
        event.preventDefault()
        first.focus()
        return
      }

      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKey, true)
    return () => document.removeEventListener('keydown', handleKey, true)
  }, [open, trap, closeOnEsc, containerRef])
}
