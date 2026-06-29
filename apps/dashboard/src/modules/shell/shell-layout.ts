import type { Breakpoint } from '../mobile/useBreakpoint'

export type PresentationShell = 'desktop' | 'mobile'

/** Resolves which presentation shell should mount — never render both. */
export function resolvePresentationShell(input: {
  breakpoint: Breakpoint
  isPortrait: boolean
}): PresentationShell {
  if (input.breakpoint === 'phone' && input.isPortrait) return 'mobile'
  return 'desktop'
}