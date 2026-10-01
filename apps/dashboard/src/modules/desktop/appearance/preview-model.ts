import type { CSSProperties } from 'react'
import { APPEARANCE_VERSION, GLASS_PRESET_VALUES, type AppearanceSnapshot, type MaterialState } from '../../../shared/color/appearance'
import { FOUNDATIONS, deriveMaterial, type GlassFamily, type MaterialTokens } from '../../../shared/color/derive'
import { toHex, toSpaceTriplet, toTriplet } from '../../../shared/color/oklch'
import { computeAppearance, MOTION_TEMPO, type AppearanceComputed, type AppearanceInput } from '../../../shared/color/tokens'

/**
 * Previews are rendered from tokens, never screenshots: a saved environment's
 * thumbnail is its own snapshot run through the same engine, painted with
 * the same field the desktop uses.
 */

export function snapshotInput(s: AppearanceSnapshot): AppearanceInput {
  return {
    nexusTheme: s.theme,
    accentPalette: s.accent.palette,
    appearance: { version: APPEARANCE_VERSION, accent: { custom: s.accent.custom, intensity: s.accent.intensity }, environment: s.environment, motion: s.motion },
    liquidGlass: s.material,
  }
}

/** The environment variables a stage needs to paint a field that is not the live one. */
export function envVars(c: AppearanceComputed, focal?: { x: number; y: number }): CSSProperties {
  const e = c.env
  return {
    ['--lc-env-base' as string]: toSpaceTriplet(e.base),
    ['--lc-env-a' as string]: toSpaceTriplet(e.anchors[0]),
    ['--lc-env-b' as string]: toSpaceTriplet(e.anchors[1]),
    ['--lc-env-c' as string]: toSpaceTriplet(e.anchors[2]),
    ['--lc-env-d' as string]: toSpaceTriplet(e.anchors[3]),
    ['--lc-env-o' as string]: String(Math.min(1, e.opacity * 1.12)),
    ['--lc-env-blend' as string]: String(e.blend),
    ['--lc-env-spread' as string]: String(e.spread),
    ['--lc-env-depth' as string]: String(e.depth),
    ['--lc-env-amp' as string]: String(MOTION_TEMPO[c.motion].amp),
    ...(focal ? { ['--lc-env-fx' as string]: `${Math.round(focal.x * 100)}%`, ['--lc-env-fy' as string]: `${Math.round(focal.y * 100)}%` } : {}),
  }
}

/** A snapshot's whole look for a thumbnail: field + glass plate + accent. */
export function thumbStyle(s: AppearanceSnapshot): { style: CSSProperties; scheme: 'dark' | 'light'; computed: AppearanceComputed } {
  const c = computeAppearance(snapshotInput(s))
  const m = c.material
  return {
    computed: c,
    scheme: c.foundation.scheme,
    style: {
      ...envVars(c, { x: s.environment.focalX, y: s.environment.focalY }),
      ['--th-accent' as string]: toHex(c.accent.base),
      ['--th-accent-rgb' as string]: toTriplet(c.accent.base),
      ['--th-select-rgb' as string]: toTriplet(c.accent.select),
      ['--th-fill' as string]: toSpaceTriplet(m.fill),
      ['--th-alpha' as string]: String(Math.min(1, c.foundation.paneAlpha * m.alpha + 0.12)),
      ['--th-ink' as string]: toHex(c.foundation.ink),
      ['--th-ink-3' as string]: toHex(c.foundation.ink3),
      ['--th-edge' as string]: c.foundation.scheme === 'light' ? 'rgba(15, 17, 22, 0.08)' : 'rgba(255, 255, 255, 0.09)',
    },
  }
}

/** What a glass family would look like over the live environment (for the material tiles). */
export function materialPreview(c: AppearanceComputed, family: GlassFamily, current: MaterialState): MaterialTokens {
  const v = GLASS_PRESET_VALUES[family]
  return deriveMaterial(c.foundation, { family, blur: v.blur, transparency: v.transparency, sheen: v.sheen, edge: current.edge ?? 'balanced' }, c.env, c.accent)
}

export function materialStyle(c: AppearanceComputed, m: MaterialTokens): CSSProperties {
  return {
    ['--pane-fill' as string]: toSpaceTriplet(m.fill),
    ['--pane-alpha' as string]: String(Math.min(0.97, c.foundation.paneAlpha * m.alpha + 0.08)),
    ['--pane-blur' as string]: `${(m.blur * 0.22).toFixed(1)}px`,
    ['--pane-sat' as string]: String(m.sat),
    ['--pane-sheen' as string]: String(m.sheen),
    ['--pane-edge' as string]: String(m.edge),
  }
}

export const isLight = (c: AppearanceComputed) => FOUNDATIONS[c.foundation.id].scheme === 'light'
