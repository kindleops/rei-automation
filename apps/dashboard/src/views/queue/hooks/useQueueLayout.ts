import { useEffect, useRef, useState } from 'react'
import { getViewLayoutMode, type ViewLayoutMode } from '../../../domain/inbox/view-layout'

export function useQueueLayout(defaultDensity: 'compact' = 'compact') {
  const rootRef = useRef<HTMLDivElement>(null)
  const [layoutMode, setLayoutMode] = useState<ViewLayoutMode>('full')
  const [paneWidth, setPaneWidth] = useState<'25' | '50' | '75' | '100'>('100')

  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      let percent: '25' | '50' | '75' | '100' = '100'
      if (width < 520) percent = '25'
      else if (width < 860) percent = '50'
      else if (width < 1180) percent = '75'
      setPaneWidth(percent)
      setLayoutMode(getViewLayoutMode(percent))
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return { rootRef, layoutMode, paneWidth, defaultDensity }
}