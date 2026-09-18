import { useEffect, useRef, useState } from 'react'
import { pushBackHandler, peekBack, subscribeBackStack } from './back-stack'

/**
 * Register this surface's Back destination while a nested state is open.
 *
 * The one line a surface has to add to stop being a trap:
 *
 *   useBackHandler(Boolean(selectedComp), 'comp-detail', 'Comparables',
 *     () => setSelectedComp(null))
 *
 * The handler is held in a ref so re-rendering with a fresh closure does not
 * re-register on every paint — registration is keyed by `id` and replaces rather
 * than stacks, but churning it would still notify every subscriber each frame.
 */
export function useBackHandler(
  active: boolean,
  id: string,
  label: string,
  handler: () => boolean | void,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!active) return undefined
    return pushBackHandler({ id, label, handler: () => handlerRef.current() })
  }, [active, id, label])
}

/** What the Back control should render right now. */
export function useBackTarget(): { kind: 'handler' | 'route' | 'none'; label: string } {
  const [target, setTarget] = useState(peekBack)

  useEffect(() => {
    const sync = () => setTarget(peekBack())
    sync()
    const unsubscribe = subscribeBackStack(sync)
    // Route depth changes on navigation, and that changes whether Back has a
    // route to fall back to even when no handler is registered.
    window.addEventListener('popstate', sync)
    return () => {
      unsubscribe()
      window.removeEventListener('popstate', sync)
    }
  }, [])

  return target
}
