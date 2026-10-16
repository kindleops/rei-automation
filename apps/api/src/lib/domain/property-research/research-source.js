// ─── PROPERTY RESEARCH — READ-ONLY SOURCES (8.5.20-b) ────────────────────────
// One interface, two implementations (the discovery-source pattern):
//   createResearchSupabaseSource({ db })   production: the guarded GET-only PostgREST read
//                                          client (quick-scan/read-client.js) — select only
//   createResearchSqlSource({ query })     a read-only SQL runner (local PG / the read-only
//                                          proof over the pooler inside BEGIN READ ONLY)
//
// Every read is BOUNDED (limit) and PROJECTED (explicit column whitelists from dossier.js:
// no names, phones, e-mails, mailing addresses, party / lender names, dates of death or
// divorce). The 1-2 MB score evidence document is never pulled whole: only the parts the
// engines' gates read are projected.
//
// Interface:
//   property(id) · valuation(id) · sales(id) · mortgages(id) · liens(id)
//   sellerThread(id) → { inbound: [{id, body, at, intent}], outbound_count, last_outbound_at }
//   opportunity(id)  → { stage, asking_price, seller_facts } | null
//   offers(id)       → [{ amount, at, kind }]
//   soldComps({ lat, lng, zip, since, limit }) · marketSales({ lat, lng, zip, since, limit })
//   area({ zip, county, state }) → { geo_transactions, buyer_demand, flood, fundamentals }
import { DOSSIER_PROPERTY_COLUMNS, DOSSIER_SALE_COLUMNS, DOSSIER_MORTGAGE_COLUMNS, DOSSIER_LIEN_COLUMNS } from './dossier.js'
import { AREA_FUNDAMENTALS_FIELDS } from './comps-area.js'

export const SCORE_PROJECTION_SQL = `property_id, computed_at, decision_tier, valuation_low, valuation_mid, valuation_high, valuation_confidence, comp_count,
  investor_ceiling_low, investor_ceiling_mid, investor_ceiling_high, buyer_demand_score, liquidity_score, estimated_repairs, recommended_cash_offer,
  minimum_acceptable_offer, expected_assignment_fee, confidence, id,
  jsonb_build_object(
    'immutable_snapshot_id', evidence->'immutable_snapshot_id',
    'engine', jsonb_build_object('version', evidence->'engine'->'version'),
    'backfill', evidence->'backfill',
    'offer_calculation', evidence->'offer_calculation',
    'selected_comps', coalesce((select jsonb_agg(jsonb_build_object('comp_id', c->'comp_id', 'source', c->'source', 'sale_price', c->'sale_price', 'sale_date', c->'sale_date', 'sold_date', c->'sold_date', 'distance_miles', c->'distance_miles', 'property_id', c->'property_id', 'adjusted_price', c->'adjusted_price'))
                                from jsonb_array_elements(case when jsonb_typeof(evidence->'selected_comps') = 'array' then evidence->'selected_comps' else '[]'::jsonb end) c), '[]'::jsonb),
    'subject', jsonb_build_object('asset_type', evidence->'subject'->'asset_type', 'asset_identity_conflict', evidence->'subject'->'asset_identity_conflict', 'units', evidence->'subject'->'units',
                                  'normalized_features', jsonb_build_object('units', evidence->'subject'->'normalized_features'->'units', 'estimated_value', evidence->'subject'->'normalized_features'->'estimated_value')),
    'decision_inputs', jsonb_build_object('inputs', jsonb_build_object('property', jsonb_build_object('estimated_value', evidence->'decision_inputs'->'inputs'->'property'->'estimated_value'))),
    'repair_estimate', jsonb_build_object('amount', evidence->'repair_estimate'->'amount'),
    'investor_ceiling_summary', jsonb_build_object('method', evidence->'investor_ceiling_summary'->'method',
                                                  'sample_purchases', case when jsonb_typeof(evidence->'investor_ceiling_summary'->'sample_purchases') = 'array' then jsonb_build_array() end),
    'comp_data_status', jsonb_build_object('status', evidence->'comp_data_status'->'status', 'selected_comp_count', evidence->'comp_data_status'->'selected_comp_count')
  ) as evidence`

const cols = (list) => list.map((c) => `"${c}"`).join(', ')
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))
const rad = (miles) => ({ dLat: miles / 69, dLng: (lat) => miles / (69 * Math.max(0.2, Math.cos((lat * Math.PI) / 180))) })

export function createResearchSqlSource({ query }) {
  const one = async (sql, params) => (await query(sql, params))[0] || null
  return Object.freeze({
    kind: 'sql',
    property: (id) => one(`select ${cols(DOSSIER_PROPERTY_COLUMNS)} from public.properties where property_id = $1 limit 1`, [id]),
    valuation: (id) => one(`select ${SCORE_PROJECTION_SQL} from public.property_acquisition_scores where property_id = $1 order by computed_at desc limit 1`, [id]),
    sales: (id) => query(`select ${cols(DOSSIER_SALE_COLUMNS)} from seller.property_sale where property_id = $1 order by event_date desc nulls last limit 20`, [id]),
    mortgages: (id) => query(`select ${cols(DOSSIER_MORTGAGE_COLUMNS)} from seller.property_mortgage where property_id = $1 order by recording_date desc nulls last limit 10`, [id]),
    liens: (id) => query(`select ${cols(DOSSIER_LIEN_COLUMNS)} from seller.property_lien where property_id = $1 order by recording_date desc nulls last limit 20`, [id]),
    async sellerThread(id) {
      const rows = await query(`select id::text as id, message_body as body, coalesce(event_timestamp, created_at) as at, detected_intent as intent, direction
                                  from public.message_events where property_id = $1 order by created_at asc limit 80`, [id])
      const inbound = rows.filter((r) => r.direction === 'inbound').map((r) => ({ id: String(r.id), body: r.body || '', at: iso(r.at), intent: r.intent || null }))
      const out = rows.filter((r) => r.direction === 'outbound')
      return { inbound, outbound_count: out.length, last_outbound_at: iso(out[out.length - 1]?.at) }
    },
    async opportunity(id) {
      const r = await one(`select acquisition_stage as stage, asking_price, metadata->'seller_facts' as seller_facts from public.acquisition_opportunities where primary_property_id = $1 order by updated_at desc limit 1`, [id])
      return r ? { stage: r.stage, asking_price: r.asking_price, seller_facts: r.seller_facts || {} } : null
    },
    offers: async (id) => (await query(`select purchase_price as amount, coalesce(sent_at, created_at) as at, offer_type as kind from public.seller_offers where property_id = $1 order by created_at desc limit 8`, [id])).map((r) => ({ amount: r.amount, at: iso(r.at), kind: r.kind })),
    async soldComps({ lat, lng, zip, since, limit = 120 }) {
      if (lat != null && lng != null) {
        const r = rad(1.5)
        return query(`select id, sale_price, sale_date, sale_source, latitude, longitude, computed_ppsf, units_count, building_condition, year_built
                        from public.v_recent_sold_comps where latitude between $1 and $2 and longitude between $3 and $4 and sale_date >= $5::date limit $6`,
        [lat - r.dLat, lat + r.dLat, lng - r.dLng(lat), lng + r.dLng(lat), since, limit])
      }
      return zip ? query(`select id, sale_price, sale_date, sale_source, latitude, longitude, computed_ppsf, units_count, building_condition, year_built from public.v_recent_sold_comps where property_address_zip = $1 and sale_date >= $2::date limit $3`, [zip, since, limit]) : []
    },
    async marketSales({ lat, lng, zip, since, limit = 400 }) {
      if (lat != null && lng != null) {
        const r = rad(1.5)
        return query(`select comp_id, source, price, sold_on, lat, lng, ppsf, units, is_investor, is_cash_purchase, is_arms_length, is_priced, year_built, property_type
                        from public.mv_map_market_sales where lat between $1 and $2 and lng between $3 and $4 and sold_on >= $5::date limit $6`,
        [lat - r.dLat, lat + r.dLat, lng - r.dLng(lat), lng + r.dLng(lat), since, limit])
      }
      return zip ? query(`select comp_id, source, price, sold_on, lat, lng, ppsf, units, is_investor, is_cash_purchase, is_arms_length, is_priced, year_built, property_type from public.mv_map_market_sales where zip = $1 and sold_on >= $2::date limit $3`, [zip, since, limit]) : []
    },
    async area({ zip }) {
      if (!zip) return {}
      const [gt, bd, fl, fu] = await Promise.all([
        one(`select median_price, cash_purchase_share, confidence, as_of, window_end, sample_size, property_use from reivesti.geo_transaction_aggregates where geo_level = 'zip5' and geo_key = $1 order by (property_use ilike 'single%') desc, as_of desc nulls last limit 1`, [zip]).catch(() => null),
        one(`select corporate_buyer_share, repeat_buyer_share, confidence, as_of, window_end, sample_size from reivesti.buyer_demand_aggregates where geo_level = 'zip5' and geo_key = $1 order by as_of desc nulls last limit 1`, [zip]).catch(() => null),
        one(`select sfha_share, floodway_share, coverage_state, retrieved_at from public.exchange_flood_exposure_cells where geo_level = 'zip5' and source_key = $1 limit 1`, [zip]).catch(() => null),
        one(`select ${cols(AREA_FUNDAMENTALS_FIELDS)} from public.exchange_market_fundamentals_cells where geo_level = 'zip5' and source_key = $1 order by vintage desc nulls last limit 1`, [zip]).catch(() => null),
      ])
      return { geo_transactions: gt, buyer_demand: bd, flood: fl, fundamentals: fu }
    },
  })
}

/** Production: the guarded GET-only PostgREST client. Same interface, same projections. */
export function createResearchSupabaseSource({ db }) {
  const read = async (q) => { const { data, error } = await q; if (error) throw Object.assign(new Error('RESEARCH_SOURCE_READ_FAILED'), { code: String(error.code) === 'PGRST205' ? 'SOURCE_NOT_APPLIED' : 'SOURCE_UNAVAILABLE' }); return Array.isArray(data) ? data : data ? [data] : [] }
  const first = async (q) => (await read(q))[0] || null
  const SCORE_SELECT = 'property_id,computed_at,decision_tier,valuation_low,valuation_mid,valuation_high,valuation_confidence,comp_count,investor_ceiling_low,investor_ceiling_mid,investor_ceiling_high,buyer_demand_score,liquidity_score,estimated_repairs,recommended_cash_offer,minimum_acceptable_offer,expected_assignment_fee,confidence,id,' +
    'oc:evidence->offer_calculation,snap:evidence->immutable_snapshot_id,engine_version:evidence->engine->>version,backfill:evidence->backfill,comps:evidence->selected_comps,subject_asset_type:evidence->subject->>asset_type,subject_conflict:evidence->subject->>asset_identity_conflict,avm:evidence->decision_inputs->inputs->property->>estimated_value,icm:evidence->investor_ceiling_summary->>method'
  return Object.freeze({
    kind: 'postgrest',
    property: (id) => first(db.from('properties').select(DOSSIER_PROPERTY_COLUMNS.join(',')).eq('property_id', id).limit(1)),
    async valuation(id) {
      const r = await first(db.from('property_acquisition_scores').select(SCORE_SELECT).eq('property_id', id).order('computed_at', { ascending: false }).limit(1))
      if (!r) return null
      const { oc, snap, engine_version, backfill, comps, subject_asset_type, subject_conflict, avm, icm, ...row } = r
      const sc = Array.isArray(comps) ? comps.map((c) => ({ comp_id: c.comp_id, source: c.source, sale_price: c.sale_price, sale_date: c.sale_date, sold_date: c.sold_date, distance_miles: c.distance_miles, property_id: c.property_id, adjusted_price: c.adjusted_price })) : []
      return { ...row, evidence: { immutable_snapshot_id: snap ?? null, engine: { version: engine_version ?? null }, backfill: backfill ?? null, offer_calculation: oc || {}, selected_comps: sc, subject: { asset_type: subject_asset_type ?? null, asset_identity_conflict: subject_conflict === 'true' }, decision_inputs: { inputs: { property: { estimated_value: avm ?? null } } }, investor_ceiling_summary: { method: icm ?? null } } }
    },
    // seller.* is not exposed to the read client: these return [] there (the SQL source reads them)
    sales: (id) => read(db.from('property_sale').select(DOSSIER_SALE_COLUMNS.join(',')).eq('property_id', id).order('event_date', { ascending: false }).limit(20)).catch(() => []),
    mortgages: (id) => read(db.from('property_mortgage').select(DOSSIER_MORTGAGE_COLUMNS.join(',')).eq('property_id', id).limit(10)).catch(() => []),
    liens: (id) => read(db.from('property_lien').select(DOSSIER_LIEN_COLUMNS.join(',')).eq('property_id', id).limit(20)).catch(() => []),
    async sellerThread(id) {
      const rows = await read(db.from('message_events').select('id,message_body,event_timestamp,created_at,detected_intent,direction').eq('property_id', id).order('created_at', { ascending: true }).limit(80))
      const inbound = rows.filter((r) => r.direction === 'inbound').map((r) => ({ id: String(r.id), body: r.message_body || '', at: r.event_timestamp || r.created_at, intent: r.detected_intent || null }))
      const out = rows.filter((r) => r.direction === 'outbound')
      return { inbound, outbound_count: out.length, last_outbound_at: out[out.length - 1]?.created_at || null }
    },
    async opportunity(id) {
      const r = await first(db.from('acquisition_opportunities').select('acquisition_stage,asking_price,metadata').eq('primary_property_id', id).order('updated_at', { ascending: false }).limit(1))
      return r ? { stage: r.acquisition_stage, asking_price: r.asking_price, seller_facts: r.metadata?.seller_facts || {} } : null
    },
    offers: async (id) => (await read(db.from('seller_offers').select('purchase_price,sent_at,created_at,offer_type').eq('property_id', id).order('created_at', { ascending: false }).limit(8))).map((r) => ({ amount: r.purchase_price, at: r.sent_at || r.created_at, kind: r.offer_type })),
    soldComps: ({ zip, since, limit = 120 }) => (zip ? read(db.from('v_recent_sold_comps').select('id,sale_price,sale_date,sale_source,latitude,longitude,computed_ppsf,units_count,building_condition,year_built').eq('property_address_zip', zip).gte('sale_date', since).limit(limit)) : Promise.resolve([])),
    marketSales: ({ zip, since, limit = 400 }) => (zip ? read(db.from('mv_map_market_sales').select('comp_id,source,price,sold_on,lat,lng,ppsf,units,is_investor,is_cash_purchase,is_arms_length,is_priced,year_built,property_type').eq('zip', zip).gte('sold_on', since).limit(limit)) : Promise.resolve([])),
    area: async () => ({}), // the reivesti / exchange relations are not exposed to the read client; the SQL source reads them
  })
}
