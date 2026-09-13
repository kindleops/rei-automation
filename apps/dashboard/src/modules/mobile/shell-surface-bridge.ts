/**
 * SHELL SURFACE BRIDGE.
 *
 * `useShellSurface` is per-component state, so two pieces of the mobile shell cannot
 * coordinate through it. The app launcher lives in the dock and the notification
 * centre lives in the top bar, and the launcher must be able to open it.
 *
 * The alternative — giving the launcher its own LeadCommandNotificationCenter — would
 * put two notification centres in the DOM at once, each with independent open state.
 * A one-line event keeps exactly one owner per surface, which is the same pattern
 * mobile-inbox-bridge already uses for the Deal Intelligence panel.
 */

export const NEXUS_OPEN_NOTIFICATIONS_EVENT = 'nexus:open-notifications'

export function requestNotificationsSurface() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(NEXUS_OPEN_NOTIFICATIONS_EVENT))
}

/** Subscribe the surface owner. Returns the unsubscribe for the effect cleanup. */
export function onNotificationsSurfaceRequested(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = () => handler()
  window.addEventListener(NEXUS_OPEN_NOTIFICATIONS_EVENT, listener)
  return () => window.removeEventListener(NEXUS_OPEN_NOTIFICATIONS_EVENT, listener)
}
