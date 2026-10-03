/**
 * RESEARCH adapter — research_source_audit (Browser 1.0 Save Source).
 *
 * Only the meaningful event reaches the Machine Feed: a source was saved to a
 * property or company (`research.source_saved`). Removals, broken-destination
 * reports and navigation never appear — the Browser keeps no browsing history.
 *
 * The table is a PROPOSED migration (supabase/migrations-draft/browser/…). Until
 * it is applied this adapter reads nothing and says so quietly (an empty
 * answer, not a degraded feed): a feature that is not switched on is not a
 * failure of the feed.
 */
import { envelope, refs } from '../envelope.js'
import { readKeyed } from '../keyset.js'

const missing = (e) => /PGRST205|PGRST204|42P01/.test(String(e?.code || '')) || /does not exist|schema cache|could not find the table/i.test(String(e?.message || ''))

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return null } }

/** Pure: audit row → envelope (attach only). */
export function researchEvent(r) {
  if (r.action !== 'attach') return null
  const host = hostOf(r.url)
  const isProperty = r.object_type === 'property'
  return envelope({
    event_id: `rsa:${r.id}`, occurred_at: r.created_at, source_system: 'search', event_type: 'research.source_saved',
    severity: 'info',
    // the feed is shared: say an operator saved it, never who, and never the page itself
    actor: { kind: 'operator', label: 'Operator' },
    entity_refs: [isProperty ? refs.property(r.object_id, null) : null],
    property_id: isProperty ? r.object_id : null,
    summary: `Source saved${host ? ` · ${host}` : ''}`,
    details: { host, destination_type: r.destination_type || null, object_type: r.object_type },
    deep_link: isProperty && r.object_id ? `/deal-intelligence?property_id=${encodeURIComponent(r.object_id)}` : null,
    provenance: { table: 'research_source_audit', row_id: r.id, adapter: 'research' },
  })
}

export const researchAdapter = {
  name: 'research',
  table: 'research_source_audit',
  systems: ['search'],
  types: ['research.source_saved'],
  supports: (subject) => !subject || subject.type === 'property',
  async read(scope, { db }) {
    const build = () => {
      let q = db.from('research_source_audit').select('id, action, object_type, object_id, url, destination_type, created_at').eq('action', 'attach')
      if (scope.subject?.type === 'property') q = q.eq('object_type', 'property').in('object_id', scope.subject.property_ids)
      return q
    }
    try {
      const { rows, complete_above } = await readKeyed(build, { toId: (r) => `rsa:${r.id}`, cursor: scope.cursor, since: scope.since, until: scope.until, limit: scope.limit })
      return { events: rows.map((x) => researchEvent(x.row)).filter(Boolean), complete_above }
    } catch (error) {
      if (missing(error)) return { events: [], complete_above: null }
      throw error
    }
  },
}
