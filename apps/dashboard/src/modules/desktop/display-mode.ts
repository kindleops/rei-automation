import { useEffect, useState } from 'react'

/**
 * DISPLAY MODE — Standard, or Ultrawide for a 49″ 32:9 panel (5120×1440 and
 * friends). Auto picks Ultrawide when the window is very wide for its height.
 */
export type DisplayMode = 'auto' | 'standard' | 'ultrawide'

const KEY = 'nexus.desktop.display'
const EVT = 'nexus:display-mode'

export const readDisplayMode = (): DisplayMode => {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'standard' || v === 'ultrawide' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

export const setDisplayMode = (mode: DisplayMode) => {
  try { if (mode === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode) } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent(EVT))
}

/** A 32:9 panel is ~3.56 wide; anything past 2.6 with real width is ultrawide. */
export const looksUltrawide = (w: number, h: number) => w >= 2400 && w / Math.max(1, h) >= 2.6

export function useDisplayMode(): { mode: DisplayMode; ultrawide: boolean } {
  const [mode, setMode] = useState<DisplayMode>(readDisplayMode)
  const [size, setSize] = useState(() => ({ w: typeof window === 'undefined' ? 1440 : window.innerWidth, h: typeof window === 'undefined' ? 900 : window.innerHeight }))
  useEffect(() => {
    const onMode = () => setMode(readDisplayMode())
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener(EVT, onMode)
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener(EVT, onMode); window.removeEventListener('resize', onResize) }
  }, [])
  const ultrawide = mode === 'ultrawide' || (mode === 'auto' && looksUltrawide(size.w, size.h))
  return { mode, ultrawide }
}
