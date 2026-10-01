import { useSyncExternalStore } from 'react'
import { useReducedMotion } from 'framer-motion'
import { loadSettings, saveSettings, subscribeSettings } from '../../shared/settings'
import { getAppearanceDraft, subscribeAppearanceDraft } from '../../shared/color/runtime'
import type { EnvironmentType, MotionLevel } from '../../shared/color/appearance'

/**
 * THE DESKTOP ENVIRONMENT — the colour that lives under the glass.
 *
 * Since Environment Studio 3.0 this is part of the one appearance store
 * (`nexus-settings.appearance`, versioned and migrated from the old
 * `nexus.desktop.backdrop` key). This module keeps the small read API other
 * surfaces already use (style · intensity · motion) and adds the live view
 * the backdrop renders from, draft included, so a drag repaints instantly.
 */
export type BackdropStyle = EnvironmentType
/** Legacy: "accent" = Auto Harmony on, "spectrum" = the operator's own anchors. */
export type BackdropPalette = 'accent' | 'spectrum'
export interface BackdropSettings { style: BackdropStyle; palette: BackdropPalette; intensity: number; motion: boolean }

export const BACKDROP_DEFAULTS: BackdropSettings = { style: 'liquid', palette: 'accent', intensity: 55, motion: true }

let cacheKey = ''
let cacheValue: BackdropSettings = BACKDROP_DEFAULTS

export function readBackdrop(): BackdropSettings {
  const s = loadSettings()
  const draft = getAppearanceDraft()
  const ap = draft?.appearance ?? s.appearance
  const env = ap.environment
  const motion = ap.motion !== 'still' && s.animationsEnabled !== false
  const key = `${env.type}|${env.autoHarmony}|${env.intensity}|${motion}`
  if (key !== cacheKey) {
    cacheKey = key
    cacheValue = { style: env.type, palette: env.autoHarmony ? 'accent' : 'spectrum', intensity: env.intensity, motion }
  }
  return cacheValue
}

/** Writes through the appearance store (one save, one broadcast). */
export function writeBackdrop(patch: Partial<BackdropSettings>): BackdropSettings {
  const s = loadSettings()
  const env = { ...s.appearance.environment }
  if (patch.style) env.type = patch.style
  if (typeof patch.intensity === 'number') env.intensity = Math.round(Math.max(0, Math.min(100, patch.intensity)))
  if (patch.palette) env.autoHarmony = patch.palette === 'accent'
  const motion: MotionLevel = patch.motion === undefined ? s.appearance.motion : patch.motion ? (s.appearance.motion === 'still' ? 'calm' : s.appearance.motion) : 'still'
  saveSettings({ ...s, appearance: { ...s.appearance, environment: env, motion } })
  return readBackdrop()
}

const subscribe = (fn: () => void) => {
  const a = subscribeSettings(fn)
  const b = subscribeAppearanceDraft(fn)
  return () => { a(); b() }
}

export function useBackdropSettings(): [BackdropSettings, (patch: Partial<BackdropSettings>) => void] {
  const value = useSyncExternalStore(subscribe, readBackdrop, () => BACKDROP_DEFAULTS)
  return [value, writeBackdrop]
}

export interface EnvironmentShape {
  type: EnvironmentType
  level: MotionLevel
  /** the environment is actually moving (level, LeadCommand's Animations switch, the OS) */
  moving: boolean
}

let shapeKey = ''
let shapeValue: EnvironmentShape = { type: 'liquid', level: 'calm', moving: true }

function readShape(): EnvironmentShape {
  const s = loadSettings()
  const ap = getAppearanceDraft()?.appearance ?? s.appearance
  const moving = ap.motion !== 'still' && s.animationsEnabled !== false
  const key = `${ap.environment.type}|${ap.motion}|${moving}`
  if (key !== shapeKey) {
    shapeKey = key
    shapeValue = { type: ap.environment.type, level: ap.motion, moving }
  }
  return shapeValue
}

/**
 * What the backdrop needs to re-render for: its type and whether it moves.
 * Colours, intensity and the composer are CSS variables — they never re-render it.
 */
export function useEnvironmentShape(): EnvironmentShape {
  const shape = useSyncExternalStore(subscribe, readShape, () => shapeValue)
  const osReduced = useReducedMotion()
  return osReduced && shape.moving ? { ...shape, moving: false } : shape
}
