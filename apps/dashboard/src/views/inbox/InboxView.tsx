import type { InboxWorkspaceView } from '../../modules/inbox/active-context'
import InboxPage from '../../modules/inbox/InboxPage'

export type InboxRouteMode = 'workspace' | 'fullscreen'

interface InboxViewProps {
  initialWorkspaceView?: InboxWorkspaceView
  routeMode?: InboxRouteMode
}

export function InboxView({
  initialWorkspaceView,
  routeMode = 'workspace',
}: InboxViewProps = {}) {
  return (
    <InboxPage
      initialWorkspaceView={initialWorkspaceView}
      routeMode={routeMode}
    />
  )
}