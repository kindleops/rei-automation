/**
 * PIPELINE TABLE · COLUMN ENRICHMENT — the property, owner and engine-score
 * fields the desktop Pipeline table can show beside its deals.
 *
 * Load rules (prod had DB overloads; these are the contract):
 *   - only the columns the operator has VISIBLE are requested (`fields`), and
 *     only from a fixed whitelist — never `*`, never a client-named column;
 *   - keyed reads only: `in (...)` on an indexed key (properties.property_id —
 *     uq_properties_property_id; master_owners_pkey; the unique
 *     property_acquisition_scores.property_id), at most MAX_IDS per call, in
 *     CHUNK-sized pieces;
 *   - one read per table per chunk; a table no visible field needs is not read;
 *   - absent rows / columns come back absent — the UI renders "—", never 0.
 *
 * property_acquisition_scores is the canonical engine authority (Decision
 * Engine authority, 09-12) — the same row Deal Intelligence reads.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

export const MAX_IDS = 300
const CHUNK = 150

export const ENRICHMENT_SOURCES = Object.freeze({
  property: {
    table: 'properties',
    key: 'property_id',
    columns: new Set([
      'property_address_city', 'property_address_zip', 'property_address_county_name', 'property_class', 'asset_subtype',
      'units_count', 'total_bedrooms', 'total_baths', 'building_square_feet', 'lot_square_feet', 'lot_acreage', 'year_built',
      'stories', 'building_condition', 'rehab_level', 'estimated_value', 'equity_amount', 'equity_percent', 'total_loan_balance',
      'tax_delinquent', 'tax_delinquent_year', 'active_lien', 'ownership_years', 'sale_date', 'sale_price', 'owner_type',
      'is_corporate_owner', 'out_of_state_owner', 'market_status_label', 'mls_market_status', 'foreclosure_status',
      'property_flags_text', 'phone_type', 'best_language', 'sms_eligible', 'final_acquisition_score',
      'structured_motivation_score', 'deal_strength_score', 'estimated_repair_cost', 'rent_estimate', 'zoning',
      'acquisition_bucket', 'property_strategy',
    ]),
  },
  owner: {
    table: 'master_owners',
    key: 'master_owner_id',
    columns: new Set([
      'owner_type_guess', 'best_language', 'priority_tier', 'property_count', 'portfolio_total_value', 'portfolio_total_equity',
      'contactability_score', 'financial_pressure_score', 'urgency_score', 'routing_timezone', 'best_channel',
    ]),
  },
  scores: {
    table: 'property_acquisition_scores',
    key: 'property_id',
    columns: new Set([
      'aos_score', 'decision_tier', 'confidence', 'best_strategy', 'valuation_low', 'valuation_mid', 'valuation_high',
      'valuation_confidence', 'comp_count', 'recommended_cash_offer', 'minimum_acceptable_offer', 'expected_assignment_fee',
      'transaction_probability_90', 'buyer_demand_score', 'liquidity_score', 'estimated_repairs', 'computed_at',
    ]),
  },
})

const clean = (v) => String(v ?? '').trim()
const list = (v) => [...new Set(String(v ?? '').split(',').map(clean).filter(Boolean))]

/** Parse `fields=property.year_built,scores.decision_tier,…` against the whitelist. Unknown fields are dropped. */
export function parseEnrichmentFields(raw) {
  const out = { property: [], owner: [], scores: [] }
  for (const f of list(raw)) {
    const [source, column] = f.split('.')
    const spec = ENRICHMENT_SOURCES[source]
    if (spec && spec.columns.has(column) && !out[source].includes(column)) out[source].push(column)
  }
  return out
}

async function keyed(client, spec, ids, columns) {
  const out = {}
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK)
    const { data, error } = await client.from(spec.table).select([spec.key, ...columns].join(',')).in(spec.key, part)
    if (error) throw error
    for (const row of data || []) {
      const id = clean(row[spec.key])
      if (!id || out[id]) continue
      const vals = {}
      for (const c of columns) if (row[c] !== null && row[c] !== undefined && row[c] !== '') vals[c] = row[c]
      out[id] = vals
    }
  }
  return out
}

/**
 * Returns { property: { [property_id]: { col: value } }, owner: {...}, scores: {...},
 * requested: { property: [...cols], ... } }. An id with no row is simply absent.
 */
export async function getPipelineColumnEnrichment(params = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const fields = parseEnrichmentFields(params.fields)
  const propertyIds = list(params.property_ids).slice(0, MAX_IDS)
  const ownerIds = list(params.owner_ids).slice(0, MAX_IDS)
  const want = (source, ids) => fields[source].length > 0 && ids.length > 0
  const [property, owner, scores] = await Promise.all([
    want('property', propertyIds) ? keyed(client, ENRICHMENT_SOURCES.property, propertyIds, fields.property) : Promise.resolve({}),
    want('owner', ownerIds) ? keyed(client, ENRICHMENT_SOURCES.owner, ownerIds, fields.owner) : Promise.resolve({}),
    want('scores', propertyIds) ? keyed(client, ENRICHMENT_SOURCES.scores, propertyIds, fields.scores) : Promise.resolve({}),
  ])
  return {
    property, owner, scores,
    requested: fields,
    generatedAt: new Date().toISOString(),
  }
}
