import InboxPage from '../../modules/inbox/InboxPage'

type InboxInitialWorkspaceView =
  | 'comp_intelligence'
  | 'pipeline'
  | 'calendar'
  | 'command_map'

interface InboxViewProps {
  initialWorkspaceView?: InboxInitialWorkspaceView
}

export function InboxView({ initialWorkspaceView }: InboxViewProps = {}) {
  return <InboxPage initialWorkspaceView={initialWorkspaceView} />
}
