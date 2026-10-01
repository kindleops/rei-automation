import { pushRoutePath } from '../../../app/router'
import { setPropertyLocator } from '../../../domain/locator/property-locator'
import { writeMapFocusSet } from '../../../domain/map/map-focus-set'
import { openInboxThread } from '../../../modules/mobile/mobile-inbox-bridge'
import type { DiDecision } from './di-types'

/**
 * Where Deal Intelligence hands the operator off. Every path below is one the
 * destination already reads (see domain/locator/property-locator.ts). Each
 * hand-off publishes the property locator first, so the destination — and
 * any linked pane — lands on THIS subject. Messaging always goes through the
 * in-app conversation (never an sms: link), so the number pool, queue,
 * contact windows and suppression all apply.
 */
export interface DiLinks {
  conversation: (() => void) | null
  pipeline: (() => void) | null
  comps: () => void
  buyers: () => void
  graph: () => void
  map: (() => void) | null
  workflow: () => void
}

export function diLinks(d: DiDecision): DiLinks {
  const pid = d.subject.propertyId
  const threadKey = d.contact?.threadKey ?? d.pipeline?.threadKey ?? null
  const publish = () => setPropertyLocator({
    propertyId: pid,
    threadKey,
    opportunityId: d.pipeline?.opportunityId ?? null,
    address: d.subject.address,
  })
  const go = (path: string) => () => { publish(); pushRoutePath(path) }
  const subjectPoint = d.subject.lat !== null && d.subject.lng !== null ? { lat: d.subject.lat, lng: d.subject.lng, id: pid, label: d.subject.address } : null
  const compPoints = (d.comps?.top ?? [])
    .map((c) => (typeof c.lat === 'number' && typeof c.lng === 'number' ? { lat: c.lat, lng: c.lng, id: c.propertyId ?? c.id ?? undefined, label: c.address } : null))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
  const points = subjectPoint ? [subjectPoint, ...compPoints] : compPoints
  const street = d.subject.address ? d.subject.address.split(',')[0] : 'This property'
  return {
    conversation: threadKey ? () => { publish(); openInboxThread({ threadKey }) } : null,
    pipeline: d.pipeline ? go(`/pipeline?opp=${encodeURIComponent(d.pipeline.opportunityId)}`) : null,
    comps: go(`/comp-intelligence?property_id=${encodeURIComponent(pid)}`),
    buyers: go(`/buyer-match?property_id=${encodeURIComponent(pid)}`),
    graph: go(`/entity-graph/property/${encodeURIComponent(pid)}`),
    map: points.length
      ? () => {
          publish()
          writeMapFocusSet({ label: compPoints.length ? `${street} + ${compPoints.length} comps` : street, tone: 'property', points })
          pushRoutePath('/map')
        }
      : null,
    workflow: go('/workflow-studio?wf=seller_inbound'),
  }
}
