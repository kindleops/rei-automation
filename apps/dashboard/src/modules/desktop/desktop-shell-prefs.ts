import { useCallback, useEffect, useState } from 'react'

/**
 * Desktop command-center chrome preferences: sidebar collapsed, and which app
 * sections are folded. Per browser, shared across tabs.
 */
export interface DesktopShellPrefs {
  collapsed: boolean
  closedGroups: string[]
}

const KEY = 'nexus.desktop.shell'
const EVT = 'nexus:desktop-shell'
const DEFAULTS: DesktopShellPrefs = { collapsed: false, closedGroups: [] }

function read(): DesktopShellPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<DesktopShellPrefs>
    return { collapsed: Boolean(raw.collapsed), closedGroups: Array.isArray(raw.closedGroups) ? raw.closedGroups.filter((g) => typeof g === 'string') : [] }
  } catch {
    return DEFAULTS
  }
}

export function useDesktopShellPrefs(): [DesktopShellPrefs, (patch: Partial<DesktopShellPrefs>) => void] {
  const [prefs, setPrefs] = useState<DesktopShellPrefs>(read)
  useEffect(() => {
    const sync = () => setPrefs(read())
    window.addEventListener(EVT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(EVT, sync); window.removeEventListener('storage', sync) }
  }, [])
  const update = useCallback((patch: Partial<DesktopShellPrefs>) => {
    const next = { ...read(), ...patch }
    try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private mode */ }
    setPrefs(next)
    window.dispatchEvent(new CustomEvent(EVT))
  }, [])
  return [prefs, update]
}
