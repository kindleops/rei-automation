/**
 * NOTIFICATION CENTER 2.0 — which notification surface answers on this desktop.
 *
 * The modern desktop shell mounts the plane; while it is mounted every request
 * for "notifications" (the bell, the sidebar, Home widgets) opens the plane, and
 * alert settings + Signal Center open INSIDE the plane. The legacy Notifications
 * panel is a rollback only: localStorage `lc.notifications.legacy-panel` = '1'.
 * Phones and the legacy shells never mount the plane, so they are unchanged.
 */
export const LEGACY_FLAG_KEY = 'lc.notifications.legacy-panel'

let hosts = 0

/** The plane registers while mounted (returns the unregister). */
export function registerPlaneHost(): () => void {
  hosts += 1
  return () => { hosts = Math.max(0, hosts - 1) }
}

export const planeHostPresent = () => hosts > 0

/** Rollback flag: the legacy Notifications panel instead of the plane. */
export function legacyNotificationsPanel(): boolean {
  try { return typeof window !== 'undefined' && window.localStorage.getItem(LEGACY_FLAG_KEY) === '1' } catch { return false }
}

/** True when a "notifications" request should open the plane (not the legacy panel). */
export const planeOwnsNotifications = () => planeHostPresent() && !legacyNotificationsPanel()
