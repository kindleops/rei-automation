/**
 * LEAD STATE adapter — universal_lead_state_events (the change log of the
 * seller's canonical state). Owner of seller stage movement.
 *
 * Projected fields: lifecycle_stage, lead_temperature, contactability_status,
 * disposition, is_archived, manual_stage_lock. Not projected (machine-internal
 * routing state or send side-effects): operational_status, next_action, and
 * every row written by the send success seam (one per campaign send).
 */
import { sellerNames } from '@/lib/domain/workflow-studio/observatory/adapters/shared.js'
import { envelope, links, refs, humanize, capFirst } from '../envelope.js'
import { readKeyed } from '../keyset.js'

export const LEAD_FIELDS = Object.freeze(['lifecycle_stage', 'lead_temperature', 'contactability_status', 'disposition', 'is_archived', 'manual_stage_lock'])
export const LEAD_STAGE_INDEX = Object.freeze({ ownership_confirmation: 1, offer_interest: 2, asking_price: 3, property_condition: 4, offer: 5, negotiation: 6, contract: 7, title: 8, closing: 9, closed: 10 })
const SEAM = 'send_success_seam'
const clean = (v) => String(v ?? '').trim()
const stageLabel = (s) => (LEAD_STAGE_INDEX[s] ? `S${LEAD_STAGE_INDEX[s]} ${humanize(s)}` : humanize(s) || '—')

export function actorOfLead(r) {
  const src = clean(r.change_source).toLowerCase()
  if (src === 'manual' || src === 'operator') return { kind: 'operator', label: 'You' }
  if (src === 'autopilot') return { kind: 'automation', label: 'Seller automation' }
  return { kind: 'system', label: r.source_view ? humanize(r.source_view) : null }
}

/** Pure: one lead-state change → envelope (null when it is machine-internal). */
export function leadStateEvent(r, { name = null, address = null } = {}) {
  if (!LEAD_FIELDS.includes(r.field_name) || clean(r.source_view) === SEAM) return null
  const prev = clean(r.previous_value) || null
  const next = clean(r.new_value) || null
  if (prev === next) return null
  const who = name || 'Seller'
  const base = {
    event_id: `lse:${r.id}`, occurred_at: r.created_at, thread_key: r.thread_key, property_id: r.property_id,
    actor: actorOfLead(r), entity_refs: [refs.seller(r.thread_key, name), refs.property(r.property_id, address)],
    deep_link: links.thread(r.thread_key),
    provenance: { table: 'universal_lead_state_events', row_id: r.id, adapter: 'lead_state' },
    details: { field: r.field_name, from: prev, to: next, reason: r.reason ? humanize(r.reason) : null, source: r.source_view || null, change_source: r.change_source || null },
  }
  switch (r.field_name) {
    case 'lifecycle_stage': {
      const forward = (LEAD_STAGE_INDEX[next] ?? 0) >= (LEAD_STAGE_INDEX[prev] ?? 0)
      return envelope({ ...base, source_system: 'pipeline', event_type: forward ? 'stage.advanced' : 'stage.regressed', severity: 'info', summary: `${who} · ${prev ? `${stageLabel(prev)} → ` : 'entered '}${stageLabel(next)}` })
    }
    case 'contactability_status':
      return next === 'opted_out'
        ? envelope({ ...base, source_system: 'inbox', event_type: 'seller.opted_out', severity: 'attention', summary: `${who} opted out — suppression applied` })
        : envelope({ ...base, source_system: 'inbox', event_type: 'lead.contactability_changed', severity: 'info', summary: `${who} · ${humanize(next) || 'contactability cleared'}` })
    case 'lead_temperature':
      return envelope({ ...base, source_system: 'inbox', event_type: 'lead.temperature_changed', severity: 'info', summary: `${who} · ${prev ? `${humanize(prev)} → ` : ''}${humanize(next) || 'temperature cleared'}` })
    case 'disposition':
      return envelope({ ...base, source_system: 'inbox', event_type: 'lead.disposition_changed', severity: 'info', summary: `${who} · ${capFirst(humanize(next)) || 'disposition cleared'}` })
    case 'is_archived':
      return envelope({ ...base, source_system: 'inbox', event_type: 'lead.archived', severity: 'info', summary: `${who} · ${next === 'true' ? 'conversation archived' : 'conversation restored'}` })
    case 'manual_stage_lock':
      return envelope({ ...base, source_system: 'inbox', event_type: 'lead.stage_locked', severity: 'info', summary: `${who} · stage ${next === 'true' ? 'locked by operator' : 'unlocked'}` })
    default:
      return null
  }
}

export const leadStateAdapter = {
  name: 'lead_state',
  table: 'universal_lead_state_events',
  systems: ['pipeline', 'inbox'],
  types: ['stage.advanced', 'stage.regressed', 'seller.opted_out', 'lead.contactability_changed', 'lead.temperature_changed', 'lead.disposition_changed', 'lead.archived', 'lead.stage_locked'],
  supports: (subject) => !subject || subject.type === 'seller' || subject.type === 'property',

  async read(scope, { db }) {
    const { subject } = scope
    if (subject && !subject.thread_keys.length && !subject.property_ids.length) return { events: [], complete_above: null }
    const build = () => {
      let q = db.from('universal_lead_state_events').select('id, thread_key, property_id, field_name, previous_value, new_value, operator_id, source_view, reason, change_source, created_at').in('field_name', LEAD_FIELDS)
      if (subject) q = subject.thread_keys.length ? q.in('thread_key', subject.thread_keys) : q.in('property_id', subject.property_ids)
      return q
    }
    // the send seam writes one lifecycle row per campaign send: read wider than the page
    const { rows, complete_above } = await readKeyed(build, { toId: (r) => `lse:${r.id}`, cursor: scope.cursor, since: scope.since, until: scope.until, limit: Math.min(1000, scope.limit * 4) })
    const kept = rows.filter((x) => clean(x.row.source_view) !== SEAM)
    const nm = await sellerNames(db, kept.map((x) => x.row.thread_key), kept.map((x) => x.row.property_id), [])
    const events = kept.map((x) => leadStateEvent(x.row, { name: nm.name(x.row.thread_key), address: nm.address(x.row.thread_key, x.row.property_id) })).filter(Boolean)
    return { events, complete_above }
  },
}
