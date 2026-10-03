import { useEffect, useState } from 'react'
import type { SunMode } from './sun-dynamic'

/**
 * LIVING MAP settings — the physical world under the glass. One master
 * switch plus a few smart defaults; nothing here changes what data the map
 * shows, only how the world beneath it is rendered.
 */
export interface LivingSettings {
  /** Master switch. Off = the map renders exactly as before. */
  enabled: boolean
  /** Real day/night from the sun's position over each place. */
  daylight: boolean
  /** Local time + seller contact window for the geography in view. */
  localTime: boolean
  /** Real building volumes (heights from the map source) when tilted. */
  buildings: boolean
  /** Zone clocks + market contact state at national zoom. */
  zones: boolean
  /**
   * How daylight is drawn: 'ambient' breathes under the theme; 'dynamic'
   * (desktop) makes the real night side dark and the day side light.
   */
  sun: SunMode
}

export const LIVING_DEFAULTS: LivingSettings = { enabled: true, daylight: true, localTime: true, buildings: true, zones: true, sun: 'ambient' }
const KEY = 'nexus.map.living'
const EVT = 'nexus:living-map'

export function readLivingSettings(): LivingSettings {
  try { return { ...LIVING_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch { return LIVING_DEFAULTS }
}

export function writeLivingSettings(patch: Partial<LivingSettings>) {
  const next = { ...readLivingSettings(), ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent(EVT, { detail: next }))
  return next
}

/** Shared across the map renderer and the settings sheet (same tab + other tabs). */
export function useLivingSettings(): [LivingSettings, (patch: Partial<LivingSettings>) => void] {
  const [s, setS] = useState<LivingSettings>(readLivingSettings)
  useEffect(() => {
    const sync = () => setS(readLivingSettings())
    window.addEventListener(EVT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(EVT, sync); window.removeEventListener('storage', sync) }
  }, [])
  return [s, (patch) => setS(writeLivingSettings(patch))]
}

/** Effective flags: sub-features only act while the master switch is on. */
export const living = (s: LivingSettings) => ({
  daylight: s.enabled && s.daylight,
  localTime: s.enabled && s.localTime,
  buildings: s.enabled && s.buildings,
  zones: s.enabled && s.zones,
  dynamicSun: s.enabled && s.daylight && s.sun === 'dynamic',
})
