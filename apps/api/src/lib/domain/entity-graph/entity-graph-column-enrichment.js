/**
 * ENTITY GRAPH TABLE · COLUMN ENRICHMENT — the property fields the desktop
 * Entity Graph table can show beyond the browse projection.
 *
 * Why this exists (owner report, RC 8.3.1): the column picker offered ~60
 * property fields (year built, zoning, beds, baths, sqft, repair estimate,
 * last sale date, …) whose cells render from `details.row` — and the browse
 * adapter never returned `details.row`. Every one of those columns was "—"
 * on every row. The data is populated (measured 10-04 on the first 200 rows:
 * year_built 163, zoning 152, beds 197, sqft 200, repair 200, sale_date 129).
 *
 * Same load contract as the Pipeline table's /pipeline/command/columns
 * (pipeline-column-enrichment.js), so the two tables behave identically:
 *   - only the columns the operator has VISIBLE are requested (`fields`), and
 *     only from a fixed whitelist — never `*`, never a client-named column
 *     (one unknown column fails the whole PostgREST select);
 *   - keyed reads only: `in (...)` on properties.property_id
 *     (uq_properties_property_id), at most MAX_IDS per call, CHUNK per read;
 *   - absent rows / columns come back absent — the UI renders "—", never 0.
 *
 * Reads go through the server's service-role client; nothing here depends on
 * the authenticated role's grants (the 10-03 operator lockdown).
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

export const MAX_IDS = 300
const CHUNK = 150

/**
 * Every column is verified to exist on public.properties (information_schema,
 * 2026-10-04). Adding one here without checking prod breaks every read.
 */
export const ENTITY_GRAPH_PROPERTY_COLUMNS = Object.freeze(new Set([
  'property_address_county_name', 'subdivision_name', 'school_district_name', 'flood_zone', 'zoning',
  'latitude', 'longitude', 'apn_parcel_id',
  'year_built', 'effective_year_built', 'stories', 'total_bedrooms', 'total_baths', 'building_square_feet',
  'lot_acreage', 'lot_square_feet', 'building_condition', 'building_quality', 'garage', 'pool', 'basement',
  'heating_type', 'roof_cover', 'sewer', 'water', 'property_class',
  'owner_name', 'owner_address_full', 'ownership_years', 'is_corporate_owner', 'out_of_state_owner', 'priority_tier',
  'best_phone', 'best_email', 'sms_eligible', 'contact_status', 'best_language', 'timezone',
  'tax_delinquent', 'tax_delinquent_year', 'active_lien', 'is_hot_preforeclosure', 'seller_tags_text', 'acquisition_bucket',
  'equity_amount', 'total_loan_balance', 'assd_total_value', 'sale_price', 'sale_date', 'arv_estimate',
  'rent_estimate', 'cap_rate', 'ppsf', 'estimated_repair_cost', 'rehab_level',
  'master_owner_id', 'source_system', 'created_at', 'updated_at', 'exported_at_utc',
]))

const clean = (v) => String(v ?? '').trim()
const list = (v) => [...new Set(String(v ?? '').split(',').map(clean).filter(Boolean))]

/** `fields=year_built,zoning,…` against the whitelist. Unknown fields are dropped, never forwarded. */
export function parseEntityGraphColumnFields(raw) {
  return list(raw).filter((c) => ENTITY_GRAPH_PROPERTY_COLUMNS.has(c))
}

/**
 * Returns { values: { [property_id]: { col: value } }, requested: [...cols] }.
 * An id with no row, or a column with no value, is simply absent.
 */
export async function getEntityGraphColumnEnrichment(params = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const columns = parseEntityGraphColumnFields(params.fields)
  const ids = list(params.property_ids).slice(0, MAX_IDS)
  const values = {}
  if (columns.length && ids.length) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK)
      const { data, error } = await client.from('properties').select(['property_id', ...columns].join(',')).in('property_id', part)
      if (error) throw error
      for (const row of data || []) {
        const id = clean(row.property_id)
        if (!id || values[id]) continue
        const vals = {}
        for (const c of columns) if (row[c] !== null && row[c] !== undefined && row[c] !== '') vals[c] = row[c]
        values[id] = vals
      }
    }
  }
  return { values, requested: columns, generatedAt: new Date().toISOString() }
}
