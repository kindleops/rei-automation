import { useEffect, useState } from 'react'

/**
 * How much of the layout viewport the virtual keyboard is covering.
 *
 * iOS does NOT shrink the layout viewport when the keyboard opens -- it shrinks
 * the VISUAL viewport and slides the page. A full-height flex shell
 * (html { height: 100lvh }) therefore keeps its height, the composer stays at the
 * bottom of a box that is now partly behind the keyboard, and the operator types
 * into a field they cannot see. The only correct source for the overlap is
 * window.visualViewport; a hardcoded keyboard height is wrong on every device,
 * every orientation, and every time a suggestion strip or autofill bar appears.
 *
 * The value is published to the document element as well as returned, because
 * the surfaces that have to react are not all inside the composer: the thread
 * pane must give up height, and the global app dock must get out of the way.
 */
const INSET_VAR = '--nx-keyboard-inset'
const OPEN_CLASS = 'is-keyboard-open'

/**
 * Below this, the "overlap" is an accessory/URL bar settling rather than a
 * keyboard. Reacting to those would make the shell twitch on every scroll.
 */
const KEYBOARD_OPEN_THRESHOLD_PX = 120

let activeSubscribers = 0

function publish(inset: number) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty(INSET_VAR, `${inset}px`)
  root.classList.toggle(OPEN_CLASS, inset >= KEYBOARD_OPEN_THRESHOLD_PX)
}

function clear() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty(INSET_VAR, '0px')
  root.classList.remove(OPEN_CLASS)
}

export function useMobileKeyboardInset(enabled = true): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined
    const viewport = window.visualViewport
    if (!viewport) return undefined

    activeSubscribers += 1

    const update = () => {
      const overlap = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      const rounded = Math.round(overlap)
      setInset(rounded)
      publish(rounded)
    }

    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      activeSubscribers -= 1
      // Only the LAST subscriber clears. Unmounting one composer while another
      // is still listening must not tell the shell the keyboard closed.
      if (activeSubscribers <= 0) {
        activeSubscribers = 0
        clear()
      }
    }
  }, [enabled])

  return inset
}

/** True once the overlap is large enough to be a keyboard rather than a browser bar. */
export function isKeyboardInsetOpen(inset: number): boolean {
  return inset >= KEYBOARD_OPEN_THRESHOLD_PX
}

export const KEYBOARD_INSET_CSS_VAR = INSET_VAR
export const KEYBOARD_OPEN_CLASS = OPEN_CLASS
export const KEYBOARD_OPEN_THRESHOLD = KEYBOARD_OPEN_THRESHOLD_PX
