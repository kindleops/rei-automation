/**
 * Liquid glass — one operator setting for every glass surface in the product.
 *
 * The shared glass tokens (--nx-glass-*, --nx-shell-glass-*, and the Map's
 * --mx-*) read four variables written on <html>:
 *   --lg-blur   backdrop blur
 *   --lg-sat    backdrop saturation
 *   --lg-alpha  multiplier on every glass fill's opacity (lower = clearer)
 *   --lg-sheen  multiplier on the specular edge highlights
 *   --lg-fill   the fill colour ("r g b"), per preset
 * "Theme default" writes nothing: every surface keeps its theme's own values.
 */
import { applyThemeToDOM, loadSettings, updateSetting } from './settings'

export type LiquidGlassPreset = 'theme' | 'clear' | 'frosted' | 'crystal' | 'smoke' | 'custom'

export interface LiquidGlassPrefs {
  preset: LiquidGlassPreset
  /** 0–60 px */
  blur: number
  /** 0–100: how much of the world shows through */
  transparency: number
  /** 0–100: specular edge light */
  sheen: number
}

export const LIQUID_GLASS_DEFAULT: LiquidGlassPrefs = { preset: 'theme', blur: 28, transparency: 45, sheen: 50 }

export const LIQUID_GLASS_PRESETS: ReadonlyArray<{ id: Exclude<LiquidGlassPreset, 'custom'>; label: string; sub: string; values: Omit<LiquidGlassPrefs, 'preset'> }> = [
  { id: 'theme', label: 'Theme', sub: 'Each theme’s own glass', values: { blur: 28, transparency: 45, sheen: 50 } },
  { id: 'clear', label: 'Clear', sub: 'Barely there — the map shows through', values: { blur: 10, transparency: 82, sheen: 60 } },
  { id: 'frosted', label: 'Frosted', sub: 'Heavy frost, soft and milky', values: { blur: 48, transparency: 30, sheen: 45 } },
  { id: 'crystal', label: 'Crystal', sub: 'Sharp, vivid, bright edges', values: { blur: 22, transparency: 62, sheen: 95 } },
  { id: 'smoke', label: 'Smoke', sub: 'Dark tinted, high contrast', values: { blur: 30, transparency: 18, sheen: 30 } },
]

export function readLiquidGlass(): LiquidGlassPrefs {
  const s = loadSettings() as unknown as { liquidGlass?: Partial<LiquidGlassPrefs> }
  return { ...LIQUID_GLASS_DEFAULT, ...(s.liquidGlass ?? {}) }
}

/** transparency 0 → fills 1.5× their theme opacity; 100 → 0.12×. */
export const alphaForTransparency = (t: number) => Math.max(0.12, 1.5 - (Math.min(100, Math.max(0, t)) / 100) * 1.38)
export const saturationFor = (p: LiquidGlassPrefs) => (p.preset === 'crystal' ? 2.3 : p.preset === 'smoke' ? 1.15 : p.preset === 'frosted' ? 1.35 : 1.6 + p.sheen / 250)

/** Re-applies theme + glass (the glass vars are written by applyThemeToDOM). */
export function applyLiquidGlassToDOM(): void {
  applyThemeToDOM()
}

export function setLiquidGlass(next: LiquidGlassPrefs): void {
  updateSetting('liquidGlass', next)
  applyThemeToDOM()
}
