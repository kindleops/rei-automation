/**
 * Experience System motion — one set of reasons to move, shared by CSS
 * (lc-tokens.css --lc-dur-* / --lc-ease-*) and framer-motion.
 *
 * Motion happens because the operator acted, data changed, a state
 * transitioned, something arrived or something completed. Nothing here
 * loops. Every primitive asks useLcReducedMotion() and falls back to an
 * immediate change or a short fade.
 */
import { useSyncExternalStore } from 'react'
import { useReducedMotion as useOsReducedMotion, type Transition } from 'framer-motion'
import { loadSettings, subscribeSettings } from '../settings'

export const LC_EASE = {
  standard: [0.22, 1, 0.36, 1],
  enter: [0.16, 1, 0.3, 1],
  exit: [0.4, 0, 1, 1],
  glide: [0.2, 0.8, 0.2, 1],
} as const

/** seconds, mirroring --lc-dur-* */
export const LC_DUR = {
  instant: 0.09,
  fast: 0.15,
  select: 0.18,
  surface: 0.26,
  layout: 0.38,
  morph: 0.46,
  arrival: 1.4,
  complete: 0.9,
} as const

export const LC_SPRING = {
  /** selection lens, highlight glide — fast, no visible overshoot */
  snappy: { type: 'spring', stiffness: 520, damping: 42, mass: 0.7 },
  /** surfaces settling (popover, inspector) */
  surface: { type: 'spring', stiffness: 380, damping: 34, mass: 0.8 },
  /** a shape changing into its next state (trigger width, value roll) */
  morph: { type: 'spring', stiffness: 300, damping: 32, mass: 0.9 },
  /** layout reflow of rows and planes */
  layout: { type: 'spring', stiffness: 260, damping: 32, mass: 1 },
} as const satisfies Record<string, Transition>

const animationsOff = () => loadSettings().animationsEnabled === false

/** OS "reduce motion" OR LeadCommand's own Animations switch. */
export function useLcReducedMotion(): boolean {
  const os = useOsReducedMotion()
  const off = useSyncExternalStore(subscribeSettings, animationsOff, () => false)
  return Boolean(os) || off
}

/** A transition that becomes an immediate change under reduced motion. */
export function lcTransition(reduced: boolean, t: Transition): Transition {
  return reduced ? { duration: 0 } : t
}

/** A short opacity-only fade: the reduced-motion alternative for surfaces. */
export const LC_FADE: Transition = { duration: LC_DUR.fast, ease: [...LC_EASE.standard] }

/** A mutable copy of an LC easing, for framer-motion's `ease`. */
export const lcEase = (name: keyof typeof LC_EASE): [number, number, number, number] => [...LC_EASE[name]] as [number, number, number, number]
