// The AUTHORITATIVE app services the Quick Scan tools wrap (S3). Each is the
// exact function an Entity Graph cockpit route calls — no query logic lives
// here. The only thing added is a per-run memo, so the four tools that read
// the property dossier trigger ONE dossier load per property (the same load
// GET /api/cockpit/entity-graph/property/:id performs), not four.
//
//   dossier      getEntityGraphDossier('property', id)   GET /api/cockpit/entity-graph/property/:id
//   enrichment   getEntityGraphColumnEnrichment(...)      GET /api/cockpit/entity-graph/columns
//   outreach     getEntityGraphOutreachState(...)         GET /api/cockpit/entity-graph/outreach-state
//   zipContext   getEntityGraphZipContext(...)            GET /api/cockpit/entity-graph/zip-context
import { getEntityGraphDossier } from '@/lib/domain/entity-graph/entity-graph-service.js'
import { getEntityGraphColumnEnrichment } from '@/lib/domain/entity-graph/entity-graph-column-enrichment.js'
import { getEntityGraphOutreachState } from '@/lib/domain/entity-graph/entity-graph-outreach-state.js'
import { getEntityGraphZipContext } from '@/lib/domain/entity-graph/entity-graph-zip-context.js'

/** Column-enrichment fields the valuation tool requests (all on the service whitelist). */
export const VALUATION_ENRICHMENT_FIELDS = Object.freeze([
  'scores.valuation_low', 'scores.valuation_mid', 'scores.valuation_high', 'scores.valuation_confidence',
  'scores.comp_count', 'scores.computed_at', 'scores.decision_tier', 'scores.best_strategy',
  'rec.mortgage_count', 'rec.mortgage_balance',
])

export const SERVICE_FUNCTIONS = Object.freeze({
  getEntityGraphDossier,
  getEntityGraphColumnEnrichment,
  getEntityGraphOutreachState,
  getEntityGraphZipContext,
})

/**
 * @param {{ db: object, impl?: Partial<typeof SERVICE_FUNCTIONS> }} deps
 *   db: the guarded read client (quick-scan/read-client.js) or a test double
 */
export function createQuickScanServices({ db, impl = {} } = {}) {
  if (!db) throw new Error('db required')
  const fns = { ...SERVICE_FUNCTIONS, ...impl }
  const memo = new Map()
  const once = (key, fn) => {
    if (!memo.has(key)) {
      const p = Promise.resolve().then(fn)
      p.catch(() => memo.delete(key)) // a failed read is retried by the next caller, never cached
      memo.set(key, p)
    }
    return memo.get(key)
  }
  return Object.freeze({
    db,
    dossier: (propertyId) => once(`dossier:${propertyId}`, () => fns.getEntityGraphDossier('property', propertyId, { supabase: db })),
    enrichment: (propertyId) => once(`enrichment:${propertyId}`, () => fns.getEntityGraphColumnEnrichment({ property_ids: String(propertyId), fields: VALUATION_ENRICHMENT_FIELDS.join(',') }, { supabase: db })),
    outreach: (propertyId) => once(`outreach:${propertyId}`, () => fns.getEntityGraphOutreachState({ property_ids: String(propertyId) }, { supabase: db })),
    // entity-contact review facts for one property — the SAME allowlisted read-only accessor the
    // outreach service uses (campaign_entity_contact_review_flags), here kept with its reasons
    entityContact: (propertyId) => once(`entity_contact:${propertyId}`, async () => {
      if (typeof db.rpc !== 'function') return { available: false, reason: 'rpc_unavailable' }
      const { data, error } = await db.rpc('campaign_entity_contact_review_flags', { p_property_ids: [String(propertyId)] })
      if (error) return { available: false, reason: 'entity_contact_review_unavailable' }
      const row = (data || [])[0] || null
      return { available: true, row: row ? { requires_review: row.requires_review === true ? true : row.requires_review === false ? false : null, exclusion_reasons: Array.isArray(row.exclusion_reasons) ? row.exclusion_reasons.map(String) : [] } : null }
    }),
    zipContext: (zip) => once(`zip:${zip}`, () => fns.getEntityGraphZipContext({ zips: String(zip), buyers: '1' }, { supabase: db })),
    clear: () => memo.clear(),
  })
}
