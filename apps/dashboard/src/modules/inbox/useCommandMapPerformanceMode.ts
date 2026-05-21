import { useEffect, useMemo, useState } from 'react'
import {
  loadPerformanceSettings,
  persistPerformanceSettings,
  type CommandMapPerformanceSettings,
} from './commandMapLiveActivity'

export function useCommandMapPerformanceMode(isUltrawide: boolean) {
  const [settings, setSettings] = useState<CommandMapPerformanceSettings>(() => loadPerformanceSettings(isUltrawide))

  useEffect(() => {
    setSettings((current) => {
      const loaded = loadPerformanceSettings(isUltrawide)
      if (JSON.stringify(current) === JSON.stringify(loaded)) return current
      return loaded
    })
  }, [isUltrawide])

  useEffect(() => {
    persistPerformanceSettings(settings)
  }, [settings])

  const api = useMemo(() => ({
    settings,
    setSettings,
    patchSettings: (patch: Partial<CommandMapPerformanceSettings>) => {
      setSettings((current) => ({ ...current, ...patch }))
    },
  }), [settings])

  return api
}
