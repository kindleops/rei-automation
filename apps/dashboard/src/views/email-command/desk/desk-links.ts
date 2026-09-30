import type { IconName } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { openInboxThread } from '../../../modules/mobile/mobile-inbox-bridge'

/** Every linked system the server can name, with its monochrome glyph. */
export const LINK_ICON: Record<string, IconName> = { closing_desk: 'key', inbox: 'message', deal_intelligence: 'target', buyer_match: 'users', workflow_studio: 'layers', campaign_command: 'send', entity_graph: 'link' }

/** Open a linked system. The Inbox opens THAT conversation (its own bridge); every other link is a route the target app reads. */
export function goLink(l: { system: string; href: string; thread_key?: string }) {
  if (l.system === 'inbox' && l.thread_key) { openInboxThread({ threadKey: l.thread_key }); return }
  pushRoutePath(l.href)
}
