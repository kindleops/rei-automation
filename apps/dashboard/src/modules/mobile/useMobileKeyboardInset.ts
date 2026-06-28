import { useEffect, useState } from 'react'

/** Tracks iOS/Android virtual keyboard overlap for sticky composers. */
export function useMobileKeyboardInset(enabled = true): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined
    const viewport = window.visualViewport
    if (!viewport) return undefined

    const update = () => {
      const overlap = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      setInset(Math.round(overlap))
    }

    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [enabled])

  return inset
}