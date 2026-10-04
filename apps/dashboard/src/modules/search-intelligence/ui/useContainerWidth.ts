import { useCallback, useRef, useState } from 'react'

/** Width of an element via ResizeObserver (callback ref; disconnects when the element goes away). */
export function useContainerWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0)
      setWidth((prev) => (Math.abs(prev - w) > 4 ? w : prev))
    })
    ro.observe(el)
    observer.current = ro
  }, [])
  return [ref, width]
}
