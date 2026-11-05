// Keyset search over public.eg_property_facts — the Entity Graph property facts
// read model (one row per property, refreshed by the EG refresh job; every filter
// column used here has a (col, property_id) btree or a trigram GIN, verified in
// the production catalog 2026-10-14).
//
// Bounded by construction:
//   * an ANCHOR filter is required (market | zip | state+city | state+county, or a
//     lead-state anchor for leads). Each anchor is index-served, so no request can
//     degrade into a scan of the ~177K-row table;
//   * secondary filters only narrow the anchored range;
//   * order = property_id ASC, keyset `property_id > cursor` (unique btree);
//   * ≤ limit + 1 rows read per page (limit ≤ 25).
import { err } from '../errors.mjs'
import { read } from './common.mjs'

const likeSafe = (v) => String(v).replace(/[%_\\]/g, '')

/** Anchors (one required). Each maps to an indexed predicate. */
export const PROPERTY_ANCHORS = Object.freeze(['market', 'zip', 'city', 'county'])
export const LEAD_ANCHORS = Object.freeze(['market', 'zip', 'conversation_stage', 'pipeline_stage', 'pipeline_status', 'sms_status'])

/** Apply the anchor; returns the anchor key used (part of the cursor binding). */
export function applyAnchor(q, f, allowed) {
  const used = allowed.filter((a) => f[a] != null && f[a] !== '')
  if (!used.length) throw err('unsupported_filter', `one anchor filter is required: ${allowed.join(' | ')}`, { code: 'ANCHOR_REQUIRED', details: { anchors: allowed } })
  if ((f.city || f.county) && !f.state) throw err('unsupported_filter', 'city and county anchors require state (2-letter)', { code: 'ANCHOR_NEEDS_STATE' })
  // exact label on the (market, property_id) btree: the keyset page is one index range scan
  if (f.market) q = q.eq('market', f.market)
  if (f.zip) q = q.eq('zip_code', f.zip)
  // city / county: case-insensitive equality, always inside the state btree range (state is required with them)
  if (f.city) q = q.ilike('property_address_city', likeSafe(f.city))
  if (f.county) q = q.ilike('property_address_county_name', likeSafe(f.county))
  if (f.state) q = q.eq('property_address_state', f.state.toUpperCase())
  if (f.conversation_stage) q = q.eq('conversation_stage', f.conversation_stage)
  if (f.pipeline_stage) q = q.eq('pipeline_stage', f.pipeline_stage)
  if (f.pipeline_status) q = q.eq('pipeline_status', f.pipeline_status)
  if (f.sms_status) q = q.eq('sms_status', f.sms_status)
  return { q, anchors: used }
}

export function applyRanges(q, f, ranges) {
  for (const [key, col, op] of ranges) if (f[key] != null) q = op === 'gte' ? q.gte(col, f[key]) : op === 'lte' ? q.lte(col, f[key]) : q.eq(col, f[key])
  return q
}

/**
 * One keyset page. `after` is the decoded cursor key (or null).
 * @returns {{ rows: object[], has_more: boolean, last: string|null }}
 */
export async function keysetPage(db, { columns, filters, anchors, ranges = [], inFilters = [], after = null, limit, signal = null }) {
  let q = db.from('eg_property_facts').select(columns)
  const a = applyAnchor(q, filters, anchors)
  q = applyRanges(a.q, filters, ranges)
  for (const [key, col] of inFilters) if (Array.isArray(filters[key]) && filters[key].length) q = q.in(col, filters[key])
  if (after) q = q.gt('property_id', after)
  q = q.order('property_id', { ascending: true }).limit(limit + 1)
  if (signal && typeof q.abortSignal === 'function') q = q.abortSignal(signal)
  const { rows } = await read(q, 'eg_property_facts')
  const page = rows.slice(0, limit)
  return { rows: page, has_more: rows.length > limit, last: page.length ? String(page[page.length - 1].property_id) : null }
}
