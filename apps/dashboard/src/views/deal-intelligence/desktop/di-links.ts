import { pushRoutePath } from '../../../app/router'
import { setPropertyLocator } from '../../../domain/locator/property-locator'
import { propertyObject, showOnMap, type ObjectRef } from '../../../modules/desktop/objects'
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
  /** the subject as a canonical object (Inspect, Show on Map, the object menu) */
  object: ObjectRef
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
  const object = propertyObject({ propertyId: pid, threadKey, opportunityId: d.pipeline?.opportunityId ?? null, label: d.subject.address, source: 'deal-intelligence', lat: d.subject.lat, lng: d.subject.lng })
  const comps = (d.comps?.top ?? [])
    .filter((c) => typeof c.lat === 'number' && typeof c.lng === 'number')
    .map((c) => propertyObject({ propertyId: c.propertyId ?? c.id ?? c.address ?? 'comp', label: c.address, source: 'deal-intelligence', lat: c.lat, lng: c.lng, canonical: c.canonicalProperty === false ? false : null }))
  const street = d.subject.address ? d.subject.address.split(',')[0] : 'This property'
  return {
    conversation: threadKey ? () => { publish(); openInboxThread({ threadKey }) } : null,
    pipeline: d.pipeline ? go(`/pipeline?opp=${encodeURIComponent(d.pipeline.opportunityId)}`) : null,
    comps: go(`/comp-intelligence?property_id=${encodeURIComponent(pid)}`),
    buyers: go(`/buyer-match?property_id=${encodeURIComponent(pid)}`),
    graph: go(`/entity-graph/property/${encodeURIComponent(pid)}`),
    // [8.2] Show on Map: the subject (canonical selection) — or the subject with
    // its comps framed as one set. The Map opens BESIDE; DI stays where it is.
    map: () => {
      publish()
      if (comps.length) showOnMap([object, ...comps], { source: 'deal-intelligence', setLabel: `${street} + ${comps.length} comps` })
      else showOnMap(object, { source: 'deal-intelligence' })
    },
    workflow: go('/workflow-studio?wf=seller_inbound'),
    object,
  }
}
