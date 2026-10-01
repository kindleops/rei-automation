import type { CommandResult, GlobalCommandProvider, GlobalCommandSearchContext } from '../../../domain/command-center/command.types'
import { resolveInboxStageBadge } from '../../inbox/inbox-card-signals'
import { limitResults, withScoredResult } from './providerUtils'
import { searchInboxDeck, type InboxDeckHit } from './inboxDeckSearch'

/**
 * SELLERS — the Inbox's conversations, found server-side.
 *
 * One result per conversation: who (seller), where (street · market), what
 * they last said, and their canonical stage. Choosing one opens THAT
 * conversation (payload kind `focus_thread`, executed by the app shell through
 * openInboxThread — fetched by key when it is not in the loaded page).
 *
 * Inbox-first: when the Inbox is the focused pane these rank above everything
 * else; elsewhere they still appear, under Sellers.
 */

const excerpt = (text: string | null, max = 96): string | null => {
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

export function toConversationResult(hit: InboxDeckHit, context: GlobalCommandSearchContext): CommandResult {
  const stage = resolveInboxStageBadge({ seller_stage: hit.stage })
  const place = [hit.street, hit.market ?? hit.locality].filter(Boolean).join(' · ')
  const said = excerpt(hit.latest)
  const inboxFocused = context.routePath === '/inbox' || context.routePath === '/conversation'
  return {
    id: `conversation-${hit.threadKey}`,
    type: 'conversation',
    title: hit.name,
    subtitle: place || 'Property not linked',
    description: said ? `${hit.latestDirection === 'outbound' ? 'You: ' : ''}“${said}”` : undefined,
    badge: hit.suppressed ? 'Suppressed' : stage?.short,
    icon: 'message',
    route: '/inbox',
    score: inboxFocused ? 60 : 26,
    payload: { kind: 'focus_thread', threadId: hit.threadKey, propertyId: hit.propertyId },
    preview: {
      eyebrow: 'Conversation',
      title: hit.name,
      summary: said ? `“${said}”` : place,
      details: [
        { label: 'Property', value: [hit.street, hit.locality].filter(Boolean).join(', ') || 'Not linked' },
        { label: 'Stage', value: stage?.label ?? 'No stage recorded' },
        { label: 'Market', value: hit.market ?? '—' },
      ],
    },
    meta: {
      provider: 'inbox',
      groupLabel: 'Sellers',
      hint: 'Open conversation',
      keywords: [hit.name, hit.street, hit.locality, hit.market, hit.latest, hit.threadKey].filter(Boolean) as string[],
    },
  }
}

export const sellerSearchProvider: GlobalCommandProvider = {
  id: 'seller',
  search: async (query, context) => {
    const hits = await searchInboxDeck(query)
    if (!hits.length) return []
    return limitResults(hits.map((hit) => withScoredResult(toConversationResult(hit, context), query, context)), 8)
  },
}
