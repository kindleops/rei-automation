import { InboxView } from '../inbox/InboxView'
import { useBreakpoint } from '../../modules/mobile/useBreakpoint'

export function ConversationView() {
  const { isMobile } = useBreakpoint()
  if (isMobile) {
    return <InboxView routeMode="workspace" />
  }
  return <InboxView initialWorkspaceView="sms_thread" routeMode="fullscreen" />
}