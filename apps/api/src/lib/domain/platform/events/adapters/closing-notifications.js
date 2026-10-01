/**
 * CLOSING adapter — closing_activity_events (closing authority's activity log).
 * NOTIFICATIONS adapter — notification_events → alert.triggered.
 *
 * Notifications that only restate a fact another adapter owns (a message
 * arrived, a campaign was activated/archived/scheduled/created) are skipped:
 * the source event is the event; the alert is awareness on top of it.
 */
import { envelope, links, refs, humanize, capFirst, severityOfNotification } from '../envelope.js'
import { readKeyed } from '../keyset.js'

/** Pure: closing activity row → envelope. */
export function closingEvent(r) {
  const t = String(r.event_type || '').toLowerCase()
  const type = /closed|finali[sz]ed|funded|recorded/.test(t) ? 'closing.completed' : /escalat|blocked|operator|missing|overdue/.test(t) ? 'closing.attention' : 'closing.milestone'
  const actor = String(r.actor || '').toLowerCase()
  return envelope({
    event_id: `cae:${r.id}`, occurred_at: r.created_at, source_system: 'closing', event_type: type,
    severity: type === 'closing.attention' ? 'attention' : 'info',
    actor: /operator|user|manual/.test(actor) ? { kind: 'operator', label: 'You' } : { kind: 'automation', label: r.source ? humanize(r.source) : 'Closing automation' },
    entity_refs: [refs.closing(r.closing_case_id, null)], closing_id: r.closing_case_id,
    summary: capFirst(humanize(r.event_type)) || 'Closing activity',
    details: { ledger_type: r.event_type, source: r.source || null },
    deep_link: links.closing(r.closing_case_id),
    provenance: { table: 'closing_activity_events', row_id: r.id, adapter: 'closing' },
  })
}

export const closingAdapter = {
  name: 'closing',
  table: 'closing_activity_events',
  systems: ['closing'],
  types: ['closing.milestone', 'closing.attention', 'closing.completed'],
  supports: (subject) => !subject || subject.type === 'closing',
  async read(scope, { db }) {
    const build = () => {
      let q = db.from('closing_activity_events').select('id, closing_case_id, event_type, actor, source, created_at')
      if (scope.subject?.closing_id) q = q.eq('closing_case_id', scope.subject.closing_id)
      return q
    }
    const { rows, complete_above } = await readKeyed(build, { toId: (r) => `cae:${r.id}`, cursor: scope.cursor, since: scope.since, until: scope.until, limit: scope.limit })
    return { events: rows.map((x) => closingEvent(x.row)).filter(Boolean), complete_above }
  },
}

export const RESTATEMENTS = Object.freeze(['inbox_message_received', 'campaign_activated', 'campaign_archived', 'campaign_scheduled', 'campaign_created'])
const DOMAIN_LINK = { campaigns: (r) => links.campaign(r.campaign_id), closing: (r) => links.closing(r.closing_id), pipeline: (r) => links.deal(r.deal_id) }

/** Pure: notification row → alert.triggered (null for restatements). */
export function notificationEvent(r) {
  if (RESTATEMENTS.includes(r.event_type)) return null
  const thread = ['thread', 'seller_thread'].includes(r.source_entity_type) ? r.source_entity_id : null
  return envelope({
    event_id: `ne:${r.id}`, occurred_at: r.created_at, source_system: 'notification', event_type: 'alert.triggered',
    severity: severityOfNotification(r.severity),
    actor: { kind: 'system', label: 'Notifications' },
    entity_refs: [refs.seller(thread, null), refs.property(r.property_id, null), refs.campaign(r.campaign_id, null), refs.closing(r.closing_id, null)],
    thread_key: thread, property_id: r.property_id, campaign_id: r.campaign_id, closing_id: r.closing_id, market: r.market_id,
    summary: r.title || capFirst(humanize(r.event_type)),
    details: { domain: r.domain || null, kind: r.event_type, status: r.status || null, description: r.description ? String(r.description).slice(0, 240) : null, source_severity: r.severity || null },
    deep_link: DOMAIN_LINK[r.domain]?.(r) || links.thread(thread),
    provenance: { table: 'notification_events', row_id: r.id, adapter: 'notifications' },
  })
}

export const notificationsAdapter = {
  name: 'notifications',
  table: 'notification_events',
  systems: ['notification'],
  types: ['alert.triggered'],
  supports: () => true,
  async read(scope, { db }) {
    const s = scope.subject
    if (s?.type === 'workflow') return { events: [], complete_above: null }
    const build = () => {
      let q = db.from('notification_events').select('id, event_type, domain, severity, title, description, source_entity_type, source_entity_id, property_id, campaign_id, market_id, deal_id, closing_id, status, created_at')
        .not('event_type', 'in', `(${RESTATEMENTS.join(',')})`)
      if (s?.type === 'seller') q = q.in('source_entity_id', s.thread_keys)
      else if (s?.type === 'property') q = q.in('property_id', s.property_ids)
      else if (s?.type === 'campaign') q = q.eq('campaign_id', s.campaign_id)
      else if (s?.type === 'closing') q = q.eq('closing_id', s.closing_id)
      return q
    }
    if ((s?.type === 'seller' && !s.thread_keys.length) || (s?.type === 'property' && !s.property_ids.length)) return { events: [], complete_above: null }
    const { rows, complete_above } = await readKeyed(build, { toId: (r) => `ne:${r.id}`, cursor: scope.cursor, since: scope.since, until: scope.until, limit: scope.limit })
    return { events: rows.map((x) => notificationEvent(x.row)).filter(Boolean), complete_above }
  },
}
