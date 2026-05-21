import { useEffect, useMemo, useState } from 'react'
import {
  loadLiveActivitySettings,
  persistLiveActivitySettings,
  type CommandMapLiveActivitySettings,
} from './commandMapLiveActivity'

export function useCommandMapLiveActivitySettings(isUltrawide: boolean) {
  const [settings, setSettings] = useState<CommandMapLiveActivitySettings>(() => loadLiveActivitySettings(isUltrawide))

  useEffect(() => {
    setSettings((current) => {
      const loaded = loadLiveActivitySettings(isUltrawide)
      if (JSON.stringify(current) === JSON.stringify(loaded)) return current
      return loaded
    })
  }, [isUltrawide])

  useEffect(() => {
    persistLiveActivitySettings(settings)
  }, [settings])

  const api = useMemo(() => ({
    settings,
    setSettings,
    patchSettings: (patch: Partial<CommandMapLiveActivitySettings>) => {
      setSettings((current) => ({ ...current, ...patch }))
    },
  }), [settings])

  return api
}
