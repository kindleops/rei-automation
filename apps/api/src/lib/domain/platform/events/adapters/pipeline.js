/**
 * PIPELINE adapter — acquisition_opportunity_history, interpreted ONLY by the
 * Pipeline's own movementFromHistory (no second reading of the ledger).
 *
 *   created → deal.opened · offer → offer.generated · price → fact.captured
 *   counter → offer.countered · status change → deal.status_changed
 *
 * stage_transition rows are not projected here: the same move is recorded in
 * universal_lead_state_events (the stage owner) and projected by lead_state.
 */
import { movementFromHistory } from '@/lib/domain/opportunity/pipeline-command-service.js'
import { envelope, links, refs } from '../envelope.js'
import { readKeyed } from '../keyset.js'

export const PIPELINE_HISTORY_TYPES = Object.freeze(['opportunity_created', 'current_offer_changed', 'asking_price_changed', 'seller_counter_changed', 'opportunity_status_changed'])
const KIND_TYPE = { created: 'deal.opened', offer: 'offer.generated', price: 'fact.captured', counter: 'offer.countered', exit: 'deal.status_changed', advance: 'deal.status_changed' }

/** Pure: history row (+ its opportunity) → envelope, through movementFromHistory. */
export function pipelineEvent(row, opp = null) {
  const m = movementFromHistory(row)
  if (!m) return null
  const type = KIND_TYPE[m.kind]
  if (!type) return null
  const who = opp?.seller_display_name || null
  const addr = opp?.property_address_full || null
  return envelope({
    event_id: `mv:${row.id}`, occurred_at: row.created_at,
    source_system: 'pipeline', event_type: type,
    severity: m.kind === 'exit' ? 'attention' : 'info',
    actor: m.by === 'human' ? { kind: 'operator', label: 'You' } : { kind: 'automation', label: row.actor ? String(row.actor).replace(/_/g, ' ') : null },
    entity_refs: [refs.seller(opp?.primary_thread_key, who), refs.property(opp?.primary_property_id, addr)],
    opportunity_id: row.opportunity_id, thread_key: opp?.primary_thread_key, property_id: opp?.primary_property_id, market: opp?.market,
    summary: `${m.title}${m.detail ? ` · ${m.detail}` : ''}${who ? ` · ${who}` : ''}`,
    details: { kind: m.kind, title: m.title, detail: m.detail || null, history_type: row.event_type, status: m.status || null, source: row.source || null },
    deep_link: links.deal(row.opportunity_id),
    provenance: { table: 'acquisition_opportunity_history', row_id: row.id, adapter: 'pipeline', ledger: 'movementFromHistory' },
  })
}

export const pipelineAdapter = {
  name: 'pipeline',
  table: 'acquisition_opportunity_history',
  systems: ['pipeline'],
  types: ['deal.opened', 'offer.generated', 'fact.captured', 'offer.countered', 'deal.status_changed'],
  supports: (subject) => !subject || subject.type === 'seller' || subject.type === 'property',

  async read(scope, { db }) {
    const { subject } = scope
    let oppIds = null
    if (subject) {
      let q = db.from('acquisition_opportunities').select('id')
      q = subject.thread_keys.length ? q.in('primary_thread_key', subject.thread_keys) : subject.property_ids.length ? q.in('primary_property_id', subject.property_ids) : null
      if (!q) return { events: [], complete_above: null }
      const { data, error } = await q.limit(50)
      if (error) throw error
      oppIds = (data || []).map((o) => o.id)
      if (!oppIds.length) return { events: [], complete_above: null }
    }
    const build = () => {
      let q = db.from('acquisition_opportunity_history').select('id, opportunity_id, event_type, previous_value, new_value, reason, actor, source, metadata, created_at').in('event_type', PIPELINE_HISTORY_TYPES)
      if (oppIds) q = q.in('opportunity_id', oppIds)
      return q
    }
    const { rows, complete_above } = await readKeyed(build, { toId: (r) => `mv:${r.id}`, cursor: scope.cursor, since: scope.since, until: scope.until, limit: scope.limit })
    const ids = [...new Set(rows.map((x) => x.row.opportunity_id).filter(Boolean))]
    const opps = new Map()
    if (ids.length) {
      const { data } = await db.from('acquisition_opportunities').select('id, primary_thread_key, primary_property_id, property_address_full, seller_display_name, market').in('id', ids)
      for (const o of data || []) opps.set(String(o.id), o)
    }
    return { events: rows.map((x) => pipelineEvent(x.row, opps.get(String(x.row.opportunity_id)) || null)).filter(Boolean), complete_above }
  },
}
