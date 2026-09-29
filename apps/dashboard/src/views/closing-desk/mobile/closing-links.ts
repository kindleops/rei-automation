import { pushRoutePath } from '../../../app/router'
import { setPropertyLocator } from '../../../domain/locator/property-locator'
import type { Closing } from './closing-execution-api'

/**
 * Where Closing Desk hands off. Closing Desk executes; it does not re-host
 * Inbox, Email, Buyer Match, Deal Intelligence, Entity Graph, Map or Calendar
 * — it opens them on this transaction's exact context.
 */
export type LinkKind = 'conversation' | 'email' | 'pipeline' | 'buyer_match' | 'underwriting' | 'entity_property' | 'entity_owner' | 'map' | 'calendar'

const q = (params: Record<string, string | null | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v)
  const t = s.toString()
  return t ? `?${t}` : ''
}

export function linkAvailable(kind: LinkKind, c: Closing): boolean {
  switch (kind) {
    case 'conversation': return Boolean(c.threadKey)
    case 'pipeline': return Boolean(c.opportunityId)
    case 'entity_owner': return Boolean(c.masterOwnerId)
    case 'calendar': return Boolean(c.closing || c.deadlines.length)
    default: return Boolean(c.propertyId)
  }
}

export function openLink(kind: LinkKind, c: Closing) {
  const locate = () => setPropertyLocator({ propertyId: c.propertyId, threadKey: c.threadKey, masterOwnerId: c.masterOwnerId, opportunityId: c.opportunityId, address: c.property.address })
  switch (kind) {
    case 'conversation': return pushRoutePath(`/inbox${q({ thread: c.threadKey })}`)
    case 'email': locate(); return pushRoutePath(`/email-command${q({ property_id: c.propertyId, master_owner_id: c.masterOwnerId })}`)
    case 'pipeline': return pushRoutePath(`/pipeline${q({ opp: c.opportunityId })}`)
    case 'buyer_match': locate(); return pushRoutePath(`/buyer-match${q({ property_id: c.propertyId })}`)
    case 'underwriting': locate(); return pushRoutePath(`/deal-intelligence${q({ property_id: c.propertyId, thread_key: c.threadKey, master_owner_id: c.masterOwnerId })}`)
    case 'entity_property': return pushRoutePath(`/entity-graph/property/${encodeURIComponent(c.propertyId || '')}`)
    case 'entity_owner': return pushRoutePath(`/entity-graph/owner/${encodeURIComponent(c.masterOwnerId || '')}`)
    case 'map': locate(); return pushRoutePath('/map')
    case 'calendar': return pushRoutePath(`/calendar${q({ date: c.closing?.date || c.deadlines[0]?.date })}`)
  }
}

/**
 * The model names an action per blocker/milestone; only those with a real
 * destination get a button. Everything else is shown as a fact (who has the
 * ball) — never a button that pretends to do something the backend can't.
 */
export function actionLink(action: string | null | undefined, c: Closing): { label: string; kind: LinkKind } | null {
  switch (action) {
    case 'email_title': return linkAvailable('email', c) ? { label: 'Email title', kind: 'email' } : null
    case 'chase_emd':
    case 'nudge_buyer': return linkAvailable('email', c) ? { label: 'Email buyer', kind: 'email' } : null
    case 'nudge_seller': return linkAvailable('conversation', c) ? { label: 'Message seller', kind: 'conversation' } : null
    case 'select_buyer':
    case 'replace_buyer': return linkAvailable('buyer_match', c) ? { label: 'Open Buyer Match', kind: 'buyer_match' } : null
    default: return null
  }
}
