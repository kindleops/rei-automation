import { useEffect, useState } from 'react'
import { ACCENT_PALETTE_IDS, ACCENT_PALETTES, LIGHT_ACCENT_PALETTES, loadSettings, subscribeSettings } from '../../shared/settings'

/**
 * THE DESKTOP BACKDROP — flowing colour underneath the Liquid Glass.
 *
 *   style      liquid (soft drifting colour) · waves (layered flowing bands)
 *              · aurora (a slow sweep) · still (a quiet static mesh)
 *   palette    accent (the chosen accent and two companions) · spectrum (every accent)
 *   intensity  0–100, how much colour reaches the glass
 *   motion     the flow can be stilled without changing the look
 */
export type BackdropStyle = 'liquid' | 'waves' | 'aurora' | 'still'
export type BackdropPalette = 'accent' | 'spectrum'
export interface BackdropSettings { style: BackdropStyle; palette: BackdropPalette; intensity: number; motion: boolean }

const KEY = 'nexus.desktop.backdrop'
const EVT = 'nexus:desktop-backdrop'
export const BACKDROP_DEFAULTS: BackdropSettings = { style: 'liquid', palette: 'accent', intensity: 55, motion: true }

export function readBackdrop(): BackdropSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<BackdropSettings>
    const style = (['liquid', 'waves', 'aurora', 'still'] as const).includes(raw.style as BackdropStyle) ? raw.style as BackdropStyle : BACKDROP_DEFAULTS.style
    const palette = raw.palette === 'spectrum' ? 'spectrum' : 'accent'
    const intensity = Number.isFinite(Number(raw.intensity)) ? Math.max(0, Math.min(100, Number(raw.intensity))) : BACKDROP_DEFAULTS.intensity
    return { style, palette, intensity, motion: raw.motion !== false }
  } catch {
    return BACKDROP_DEFAULTS
  }
}

export function writeBackdrop(patch: Partial<BackdropSettings>) {
  const next = { ...readBackdrop(), ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent(EVT))
  return next
}

export function useBackdropSettings(): [BackdropSettings, (patch: Partial<BackdropSettings>) => void] {
  const [s, set] = useState(readBackdrop)
  useEffect(() => {
    const sync = () => set(readBackdrop())
    window.addEventListener(EVT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(EVT, sync); window.removeEventListener('storage', sync) }
  }, [])
  return [s, (patch) => set(writeBackdrop(patch))]
}

/* ── colour ─────────────────────────────────────────────────────────────── */

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s * 100, l * 100]
}
const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`

/** Four colours for the backdrop: the accent family, or the whole accent spectrum. */
export function backdropColors(palette: BackdropPalette): string[] {
  const settings = loadSettings()
  const light = settings.nexusTheme === 'light'
  const table = light ? LIGHT_ACCENT_PALETTES : ACCENT_PALETTES
  if (palette === 'spectrum') {
    const pick: Array<keyof typeof ACCENT_PALETTES> = ['violet', 'blue', 'cyan', 'emerald', 'amber', 'rose']
    return pick.filter((k) => ACCENT_PALETTE_IDS.includes(k)).map((k) => table[k].primary)
  }
  const [h, s, l] = hexToHsl(table[settings.accentPalette]?.primary ?? '#06b6d4')
  // The accent, a cooler and a warmer companion, and a deep anchor — one family.
  return [hsl(h, s, l), hsl(h - 38, s * 0.9, l * 0.95), hsl(h + 32, s * 0.85, l * 1.05), hsl(h - 70, s * 0.7, l * 0.7)]
}

export function useBackdropColors(palette: BackdropPalette): string[] {
  const [colors, setColors] = useState(() => backdropColors(palette))
  useEffect(() => {
    setColors(backdropColors(palette))
    return subscribeSettings(() => setColors(backdropColors(palette)))
  }, [palette])
  return colors
}
