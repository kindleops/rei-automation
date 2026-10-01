import { isAppActive, type NexusApp } from '../../../domain/app-registry/app-registry'
import { isInboxRoute } from '../../mobile/mobile-inbox-bridge'

/** Deal Intelligence is a panel at /inbox: while it shows, it is the active app, not Inbox. */
export function activeFor(routePath: string, app: NexusApp, dealIntelShowing = false): boolean {
  const intelInInbox = dealIntelShowing && isInboxRoute(routePath)
  if (app.action === 'deal_intelligence') return routePath === '/deal-intelligence' || intelInInbox
  if (app.id === 'inbox' && intelInInbox) return false
  return isAppActive(routePath, app)
}
