/**
 * ONE SURFACE, ONE VOICE.
 *
 * The desktop Sound System (shared/sound) claims the surface while the modern
 * desktop shell is mounted; everywhere else (phones, the classic desktop) the
 * legacy sounds keep it. While the desktop owns it, the legacy interface
 * sounds and the legacy alert sounds stay silent: a seller reply never plays
 * an old alert AND a desktop cue. Dependency-free, so the legacy modules can
 * ask without pulling the desktop audio engine in.
 */
let desktop = false
const listeners = new Set<() => void>()

export const desktopSoundOwnsSurface = (): boolean => desktop

export function claimSoundSurface(isDesktop: boolean): void {
  if (desktop === isDesktop) return
  desktop = isDesktop
  for (const fn of listeners) fn()
}

export function subscribeSoundSurface(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
