/**
 * CAMPAIGNS adapter — campaign lifecycle.
 *
 *   campaign_events            created · updated · targets built · activated · sends scheduled
 *                              (launch passes that placed rows only — a pass that placed
 *                              nothing is a scheduler tick, not an event) · blocked · archived
 *   campaigns.*_at columns     paused · resumed · completed · failed — transitions campaign_events
 *                              does not record (the campaign row owns campaign state)
 *
 * Reads go through the (campaign_id, created_at) index: the campaign id list
 * is the campaigns table itself (small), so no read scans the event table.
 */
import { canonicalTime, envelope, links, refs, humanize, severityOfCampaignEvent } from '../envelope.js'
import { cmpKey, readKeyed, maxKey } from '../keyset.js'

const LAUNCH = 'campaign.launch_scheduled'
const SKIP = new Set(['campaign.launch_no_send_planned'])
const TYPE = {
  'campaign.created': 'campaign.created', 'campaign.cloned': 'campaign.created', 'campaign.updated': 'campaign.updated',
  'campaign.targets_built': 'campaign.hydrated', 'campaign.activated': 'campaign.activated', 'campaign.converted_to_live': 'campaign.activated',
  [LAUNCH]: 'campaign.queue_planned', 'campaign.archived': 'campaign.archived',
}
const OPERATOR_TYPES = new Set(['campaign.created', 'campaign.cloned', 'campaign.updated', 'campaign.archived', 'campaign.converted_to_live', 'campaign.composer_launched'])
export const TRANSITIONS = Object.freeze([
  { col: 'paused_at', type: 'campaign.paused', text: 'paused', severity: 'attention' },
  { col: 'resumed_at', type: 'campaign.resumed', text: 'resumed', severity: 'info' },
  { col: 'completed_at', type: 'campaign.completed', text: 'completed', severity: 'info' },
  { col: 'failed_at', type: 'campaign.failed', text: 'failed', severity: 'warning' },
])

/** Pure: one campaign_events row → envelope (null for no-op scheduler passes). */
export function campaignEvent(r, c = null) {
  if (SKIP.has(r.event_type)) return null
  const placed = Number(r.metadata?.send_queue_rows_created ?? NaN)
  if (r.event_type === LAUNCH && !(placed > 0)) return null
  const blocked = /blocked|refused|quarantined|skipped/.test(r.event_type)
  const type = TYPE[r.event_type] || (blocked ? 'campaign.blocked' : 'campaign.updated')
  const name = c?.name || 'Campaign'
  const title = type === 'campaign.queue_planned' ? `${placed.toLocaleString('en-US')} ${placed === 1 ? 'send' : 'sends'} scheduled` : (r.title || humanize(r.event_type.replace(/^campaign\./, '')))
  return envelope({
    event_id: `ce:${r.id}`, occurred_at: r.created_at, source_system: 'campaign', event_type: type,
    severity: blocked ? (severityOfCampaignEvent(r.severity) === 'info' ? 'warning' : severityOfCampaignEvent(r.severity)) : 'info',
    actor: OPERATOR_TYPES.has(r.event_type) ? { kind: 'operator', label: 'You' } : { kind: 'automation', label: 'Campaign runtime' },
    entity_refs: [refs.campaign(r.campaign_id, c?.name || null)], campaign_id: r.campaign_id, market: c?.market || null,
    summary: `${name} · ${title}`,
    details: { title: r.title || null, description: r.description ? String(r.description).slice(0, 240) : null, ledger_type: r.event_type, placed: placed > 0 ? placed : null, run_id: r.run_id || null },
    deep_link: links.campaign(r.campaign_id),
    provenance: { table: 'campaign_events', row_id: r.id, adapter: 'campaigns' },
  })
}

/** Pure: a campaign row's transition columns → envelopes inside (since, cursor). */
export function transitionEvents(c, { since = null, cursor = null, until = null } = {}) {
  const out = []
  for (const t of TRANSITIONS) {
    const at = canonicalTime(c[t.col])
    if (!at || (since && at < since) || (until && at >= until)) continue
    const e = envelope({
      event_id: `cs-${t.col}:${c.id}`, occurred_at: at, source_system: 'campaign', event_type: t.type, severity: t.severity,
      actor: { kind: 'system', label: 'Campaign state' }, entity_refs: [refs.campaign(c.id, c.name)], campaign_id: c.id, market: c.market,
      summary: `${c.name || 'Campaign'} · ${t.text}`, details: { status_now: c.status || null, column: t.col },
      deep_link: links.campaign(c.id), provenance: { table: 'campaigns', row_id: c.id, adapter: 'campaigns', ledger: `campaigns.${t.col} (latest transition only)` },
    })
    if (e && (!cursor || cmpKey({ t: e.occurred_at, id: e.event_id }, cursor) < 0)) out.push(e)
  }
  return out
}

export const campaignsAdapter = {
  name: 'campaigns',
  table: 'campaign_events',
  systems: ['campaign'],
  types: ['campaign.created', 'campaign.updated', 'campaign.hydrated', 'campaign.activated', 'campaign.queue_planned', 'campaign.blocked', 'campaign.archived', 'campaign.paused', 'campaign.resumed', 'campaign.completed', 'campaign.failed'],
  supports: (subject) => !subject || subject.type === 'campaign',

  async read(scope, { db }) {
    const { subject } = scope
    let cq = db.from('campaigns').select('id, name, status, market, paused_at, resumed_at, completed_at, failed_at')
    if (subject?.campaign_id) cq = cq.eq('id', subject.campaign_id)
    const { data: camps, error } = await cq.limit(1000)
    if (error) throw error
    const byId = new Map((camps || []).map((c) => [String(c.id), c]))
    const ids = [...byId.keys()]
    if (!ids.length) return { events: [], complete_above: null }
    const opts = { toId: (r) => `ce:${r.id}`, cursor: scope.cursor, since: scope.since, until: scope.until, limit: scope.limit }
    const [a, b] = await Promise.all([
      readKeyed(() => db.from('campaign_events').select('id, campaign_id, run_id, event_type, severity, title, description, metadata, created_at').in('campaign_id', ids).neq('event_type', LAUNCH), opts),
      readKeyed(() => db.from('campaign_events').select('id, campaign_id, run_id, event_type, severity, title, description, metadata, created_at').in('campaign_id', ids).eq('event_type', LAUNCH).gt('metadata->send_queue_rows_created', 0), opts),
    ])
    const events = [...a.rows, ...b.rows].map((x) => campaignEvent(x.row, byId.get(String(x.row.campaign_id)) || null)).filter(Boolean)
    for (const c of byId.values()) events.push(...transitionEvents(c, { since: scope.since, cursor: scope.cursor, until: scope.until }))
    return { events, complete_above: maxKey(a.complete_above, b.complete_above) }
  },
}
