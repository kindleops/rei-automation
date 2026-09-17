import type { Breakpoint } from '../mobile/useBreakpoint'

export type PresentationShell = 'desktop' | 'mobile'

/**
 * Resolves which presentation shell should mount — never render both.
 *
 * Orientation is deliberately not a factor: a phone gets the mobile shell held
 * either way. Surfaces that genuinely want a landscape composition read
 * `isLandscapeMobile` and adapt inside the mobile shell.
 */
export function resolvePresentationShell(input: {
  breakpoint: Breakpoint
}): PresentationShell {
  return input.breakpoint === 'phone' ? 'mobile' : 'desktop'
}