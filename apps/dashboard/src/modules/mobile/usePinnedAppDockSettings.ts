import { useCallback, useEffect, useState } from 'react'
import { subscribeSettings } from '../../shared/settings'
import {
  loadPinnedAppDockSettings,
  savePinnedAppDockSettings,
} from './pinned-app-dock-store'
import type { PinnedAppDockSettings } from './pinned-app-dock.types'

export function usePinnedAppDockSettings(): [
  PinnedAppDockSettings,
  (next: PinnedAppDockSettings | ((current: PinnedAppDockSettings) => PinnedAppDockSettings)) => void,
] {
  const [dockSettings, setDockSettings] = useState(loadPinnedAppDockSettings)

  useEffect(() => subscribeSettings(() => {
    setDockSettings(loadPinnedAppDockSettings())
  }), [])

  const persist = useCallback((
    next: PinnedAppDockSettings | ((current: PinnedAppDockSettings) => PinnedAppDockSettings),
  ) => {
    setDockSettings((current) => {
      const resolved = typeof next === 'function' ? next(current) : next
      savePinnedAppDockSettings(resolved)
      return resolved
    })
  }, [])

  return [dockSettings, persist]
}