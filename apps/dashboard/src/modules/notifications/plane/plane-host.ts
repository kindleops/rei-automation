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

/**
 * Layers the plane opens that portal OUTSIDE its DOM (confirm / prompt dialogs and their scrim,
 * sheets, menus / popovers, toasts, the inspector). A press inside one of them is not an "outside"
 * press: dismissing the plane there would unmount the confirm before its action runs.
 */
export const PLANE_LAYERS = '.lc-dialog, .lc-scrim, .lc-sheet, [role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper], .lc-toast, .lc-inspector'
const BELL = 'button.cd-btn[aria-label^="Notifications"]'

type Closest = { closest?: (sel: string) => unknown } | null | undefined

/** Pure: should a press on `target` dismiss the plane? (`inside` = the target is within the plane itself) */
export function pressDismissesPlane(target: Closest, inside: boolean): boolean {
  if (!target || inside) return false
  if (typeof target.closest !== 'function') return true
  if (target.closest(BELL)) return false // the bell toggles the plane itself
  return !target.closest(PLANE_LAYERS)
}

/** Pure: an Escape is owned by an open dialog layer (it closes that layer, never the plane under it). */
export const dialogLayerOpen = (doc: { querySelector: (s: string) => unknown } | null | undefined) => Boolean(doc?.querySelector('.lc-dialog, .lc-sheet'))
