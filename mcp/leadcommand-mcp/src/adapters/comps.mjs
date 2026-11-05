// Recorded market sales near a subject property — EVIDENCE, not a valuation.
//
// Source: public.mv_map_market_sales (canonical, deduplicated market sales; the
// corpus Market Intelligence, the Map comp card and Comp Intelligence read).
// Bounded: one subject read (properties, property_id) + ONE bounding-box read
// on the (lat, lng) btree, sold_on window, ≤ 50 rows read, ≤ 25 returned.
//
// Buyer evidence — REUSED rule code (mi-inferred-investor.js#saleBuyerOfRecord):
//   * a deed buyer is the RECORDED buyer of that sale; it is never asserted to be
//     the property's current owner (owner linkage needs the comp_private owner
//     snapshot, which this read path cannot see → "not_evaluated");
//   * a sale with no recorded buyer stays UNRESOLVED ("not_on_record");
//   * names are withheld (companyName → null): kind + basis only;
//   * the MV's investor_inferred_current_owner flag is reported as INFERRED with
//     its rule ids (mi_owner_link@1 / mi_owner_tier@2), never as fact.
// Distance / lane: canonical-corpus-reads.js#haversineMiles + #corpusLaneOf.
// These rows are NOT engine-qualified comps (no eligibility gates were run) and
// no value is computed from them; the engine's own comp count is in
// leadcommand_get_acquisition_score.
import { saleBuyerOfRecord, LINK_RULE, TIER_RULE } from '@/lib/domain/market-intelligence/mi-inferred-investor.js'
import { haversineMiles, corpusLaneOf } from '@/lib/domain/comp-intelligence/canonical-corpus-reads.js'
import { err } from '../errors.mjs'
import { prov } from '../provenance.mjs'
import { num, clean, untrusted, dayOrNull, read } from './common.mjs'

export const COMP_READ_ROWS = 50
export const COMP_COLUMNS = 'comp_id,source,sold_on,price,lat,lng,property_id,city,state,zip,property_type,beds,baths,sqft,year_built,units,per_door,ppsf,is_investor,buyer,buyer_kind,doc_type,is_cash_purchase,is_arms_length,is_priced,price_source,investor_inferred_current_owner'

const laneOfUnits = (units, type) => corpusLaneOf({ units_count: units, asset_family: /multi|duplex|triplex|fourplex|apartment/i.test(String(type || '')) ? 'multifamily' : '' })

export async function searchComps(input, svc, { now }) {
  const { rows: subj } = await read(svc.db.from('properties').select('property_id,latitude,longitude,property_type,units_count,building_square_feet,property_address_zip').eq('property_id', input.property_id).limit(1), 'properties')
  const s = subj[0]
  if (!s) throw err('not_found', 'no LeadCommand property record for this id', { code: 'PROPERTY_NOT_FOUND' })
  const lat = num(s.latitude)
  const lng = num(s.longitude)
  if (lat === null || lng === null || Math.abs(lat) < 0.0001) throw err('data_unavailable', 'the subject property has no coordinates', { code: 'NO_COORDINATES' })
  const r = input.radius_miles
  const dLat = r / 69
  const dLng = r / (69 * Math.max(Math.cos((lat * Math.PI) / 180), 0.2))
  const since = new Date(now.getTime() - input.months * 30.44 * 86_400_000).toISOString().slice(0, 10)
  let q = svc.db.from('mv_map_market_sales').select(COMP_COLUMNS)
    .gte('lat', lat - dLat).lte('lat', lat + dLat).gte('lng', lng - dLng).lte('lng', lng + dLng)
    .gte('sold_on', since).order('sold_on', { ascending: false }).limit(COMP_READ_ROWS)
  if (svc.signal && typeof q.abortSignal === 'function') q = q.abortSignal(svc.signal)
  const { rows } = await read(q, 'mv_map_market_sales')
  const subjectLane = laneOfUnits(num(s.units_count), s.property_type)
  const scored = rows
    .filter((c) => String(c.property_id ?? '') !== String(s.property_id))
    .map((c) => ({ c, d: haversineMiles(lat, lng, num(c.lat), num(c.lng)), lane: laneOfUnits(num(c.units), c.property_type) }))
    .filter((x) => x.d !== null && x.d <= r && (!input.same_lane_only || x.lane === subjectLane))
    .sort((a, b) => a.d - b.d)
  const out = scored.slice(0, input.limit).map(({ c, d, lane }) => {
    const buyer = saleBuyerOfRecord({ buyer: c.buyer, buyer_kind: c.buyer_kind }, null, () => null)
    return {
      comp_id: String(c.comp_id),
      sold_on: dayOrNull(c.sold_on), price: num(c.price), price_per_sqft: num(c.ppsf), price_per_door: num(c.per_door),
      distance_miles: Math.round(d * 100) / 100, lane,
      city: clean(c.city), state: clean(c.state), zip: clean(c.zip),
      property_type: untrusted(c.property_type, 60), beds: num(c.beds), baths: num(c.baths), sqft: num(c.sqft), units: num(c.units), year_built: num(c.year_built),
      doc_type: untrusted(c.doc_type, 60), arms_length: c.is_arms_length ?? null, cash_purchase: c.is_cash_purchase ?? null, priced: c.is_priced ?? null, price_source: untrusted(c.price_source, 60), source: clean(c.source),
      buyer: {
        basis: buyer.basis, // recorded_buyer | not_on_record (unresolved)
        kind: buyer.kind, label: buyer.label,
        current_owner_link: 'not_evaluated',
        provenance: buyer.basis === 'recorded_buyer'
          ? prov({ kind: 'fact', source: 'recorded deed buyer (mv_map_market_sales.buyer / buyer_kind)', as_of: c.sold_on, rule: 'mi-inferred-investor#saleBuyerOfRecord' })
          : { kind: 'missing', source: 'recorded deed', as_of: dayOrNull(c.sold_on), rule: 'mi-inferred-investor#saleBuyerOfRecord', reason: 'buyer_not_on_record (unresolved; not inferred from the current owner)', window_days: null },
      },
      investor: {
        recorded_company_buyer: c.is_investor ?? null,
        recorded_provenance: prov({ kind: 'derived', source: 'mv_map_market_sales.is_investor (recorded buyer is a company)', as_of: c.sold_on }),
        inferred_current_owner_investor: c.investor_inferred_current_owner ?? null,
        inferred_provenance: c.investor_inferred_current_owner == null
          ? { kind: 'missing', source: 'mv_map_market_sales.investor_inferred_current_owner', as_of: null, rule: `${LINK_RULE.id} + ${TIER_RULE.id}`, reason: 'not_linked', window_days: null }
          : { kind: 'inferred', source: 'mv_map_market_sales.investor_inferred_current_owner', as_of: dayOrNull(c.sold_on), rule: `${LINK_RULE.id} + ${TIER_RULE.id}`, reason: 'heuristic owner link + tier; not a recorded fact', window_days: null },
      },
    }
  })
  return {
    subject: { property_id: String(s.property_id), lane: subjectLane, units: num(s.units_count), building_sqft: num(s.building_square_feet), zip: clean(s.property_address_zip) },
    search: { radius_miles: r, months: input.months, sold_on_or_after: since, same_lane_only: input.same_lane_only, rows_read: rows.length, read_cap: COMP_READ_ROWS, more_may_exist: rows.length >= COMP_READ_ROWS },
    rows: out,
    not_a_valuation: 'Recorded market sales near the subject. Not engine-qualified comps; no value is computed from them.',
    provenance: prov({ kind: 'fact', source: 'mv_map_market_sales (canonical deduplicated market sales, daily refresh)', as_of: rows[0]?.sold_on ?? null, now }),
  }
}
