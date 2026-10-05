import type { Instance } from './layout'

/**
 * ONE APP, ONE MOUNT. The primary pane keeps its instance id when the
 * address bar moves it to another application (workspace-store onUrl), and
 * /inbox, /map, /pipeline and /calendar all render the same InboxView — so
 * without a key React reused the Inbox's component (its workspace views, its
 * open conversation) for the Map: rail → Map showed the conversation (owner,
 * RC 8.3.2). Keyed by the app, another app is a fresh mount; the same app
 * changing its path (/map → /map?property_id=…, a linked retarget) is not.
 */
export const instanceBodyKey = (inst: Pick<Instance, 'app'>): string => inst.app
