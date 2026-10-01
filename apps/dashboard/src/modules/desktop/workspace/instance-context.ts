import { createContext, useContext } from 'react'

/**
 * What an application can know about the pane it lives in — and nothing more.
 * Apps never reach into the workspace; they read this.
 *
 *   follows  — the pane follows the workspace selection (linked context). A
 *              pinned pane, or a workspace set to Independent, does not: an app
 *              that listens to the property locator must ignore it then.
 *   visible  — false while the instance is a background tab in a stack or
 *              sits behind a maximized pane. Polling may slow down; nothing
 *              should animate.
 *
 * Outside the desktop workspace (phone, single-app shells) the defaults
 * reproduce the old behaviour exactly: follow everything, always visible.
 */
export interface AppInstanceInfo {
  instanceId: string | null
  app: string | null
  follows: boolean
  pinned: boolean
  pinLabel: string | null
  visible: boolean
}

const OUTSIDE: AppInstanceInfo = { instanceId: null, app: null, follows: true, pinned: false, pinLabel: null, visible: true }

export const AppInstanceContext = createContext<AppInstanceInfo>(OUTSIDE)

export function useAppInstance(): AppInstanceInfo {
  return useContext(AppInstanceContext)
}

/** The linked-context switch for apps that follow the selection. */
export function useWorkspaceLink(): { follows: boolean; pinned: boolean; pinLabel: string | null } {
  const { follows, pinned, pinLabel } = useContext(AppInstanceContext)
  return { follows, pinned, pinLabel }
}
