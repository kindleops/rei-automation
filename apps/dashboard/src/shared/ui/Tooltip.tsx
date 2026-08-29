import { cloneElement, useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

/**
 * The single tooltip primitive — constitution §11.13–§11.16.
 *
 *  - supplementary only; never interactive (anything with a control is a popover)
 *  - 400ms open delay, 100ms close; adjacent targets open immediately
 *  - touch devices get no hover tooltip (§11.16)
 */

const OPEN_DELAY = 400
const CLOSE_DELAY = 100
const ADJACENT_WINDOW = 300

let lastClosedAt = 0

export interface TooltipProps {
  label: string
  children: ReactElement<{
    onMouseEnter?: (e: React.MouseEvent) => void
    onMouseLeave?: (e: React.MouseEvent) => void
    onFocus?: (e: React.FocusEvent) => void
    onBlur?: (e: React.FocusEvent) => void
    'aria-describedby'?: string
  }>
  placement?: 'top' | 'bottom'
}

const isTouch = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches === true

export const Tooltip = ({ label, children, placement = 'top' }: TooltipProps) => {
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const timer = useRef<number | null>(null)
  const id = useId()

  const clearTimer = () => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
  }

  useEffect(() => clearTimer, [])

  const place = useCallback(
    (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      const top = placement === 'top' ? rect.top - 8 : rect.bottom + 8
      setPosition({ top, left: rect.left + rect.width / 2 })
    },
    [placement],
  )

  const show = useCallback(
    (element: HTMLElement, immediate = false) => {
      if (isTouch()) return
      clearTimer()
      const delay = immediate || Date.now() - lastClosedAt < ADJACENT_WINDOW ? 0 : OPEN_DELAY
      timer.current = window.setTimeout(() => {
        place(element)
        setVisible(true)
      }, delay)
    },
    [place],
  )

  const hide = useCallback(() => {
    clearTimer()
    timer.current = window.setTimeout(() => {
      setVisible(false)
      lastClosedAt = Date.now()
    }, CLOSE_DELAY)
  }, [])

  useEffect(() => {
    if (!visible) return
    const dismiss = () => setVisible(false)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [visible])

  // The handlers below close over `timer` (a ref). react-hooks/refs cannot see
  // that it is only ever read inside those handlers, never during render.
  // eslint-disable-next-line react-hooks/refs
  const trigger = cloneElement(children, {
    'aria-describedby': visible ? id : undefined,
    onMouseEnter: (event: React.MouseEvent) => {
      show(event.currentTarget as HTMLElement)
      children.props.onMouseEnter?.(event)
    },
    onMouseLeave: (event: React.MouseEvent) => {
      hide()
      children.props.onMouseLeave?.(event)
    },
    onFocus: (event: React.FocusEvent) => {
      show(event.currentTarget as HTMLElement, true)
      children.props.onFocus?.(event)
    },
    onBlur: (event: React.FocusEvent) => {
      hide()
      children.props.onBlur?.(event)
    },
  })

  return (
    <>
      {trigger}
      {visible && position && typeof document !== 'undefined'
        ? createPortal(
            <div
              id={id}
              role="tooltip"
              className="lc-ui lc-tooltip"
              style={{
                top: position.top,
                left: position.left,
                transform:
                  placement === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
              }}
            >
              {label}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
