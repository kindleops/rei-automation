import { WorkspaceView } from './workspace/WorkspaceView'

/**
 * The desktop stage: a composable workspace of application panes. Every app —
 * including the one the URL names — renders through the workspace, keyed by
 * its instance, so rearranging panes never reloads an application.
 */
export function DesktopWorkspace() {
  return <WorkspaceView />
}
