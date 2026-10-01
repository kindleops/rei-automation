import { useCallback, useRef, useState } from 'react'

/**
 * The rendered width of an element, via a callback ref + ResizeObserver.
 * Layout that CSS container queries can express stays in CSS; this is only
 * for the few decisions that need a number in JS (label lanes, whether the
 * inspector docks). React 18: the observer is released when the ref is
 * called with null (unmount) or re-pointed at another node.
 */
export function useWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!node) return
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0)
      setWidth((prev) => (Math.abs(prev - w) >= 1 ? w : prev))
    })
    ro.observe(node)
    observer.current = ro
  }, [])
  return [ref, width]
}
