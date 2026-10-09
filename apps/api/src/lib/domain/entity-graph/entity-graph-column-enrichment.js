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
import { primaryLinkedProspect, prospectsLinkedToProperties, resolvePropertyOwners } from './entity-graph-owner-link.js'

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
  'rent_estimate', 'cap_rate', 'ppsf', 'rehab_level',
  'master_owner_id', 'source_system', 'created_at', 'updated_at', 'exported_at_utc',
  // field audit 2026-10-08: every public.properties column with data (≥1% of a 2% sample), not internal
  'property_address2', 'property_address_range', 'owner_type', 'owner_location', 'owner_1_name', 'owner_2_name',
  'equity_amount', 'total_loan_amt', 'total_loan_payment', 'tax_amt', 'tax_year', 'last_sale_doc_type',
  'air_conditioning', 'construction_type', 'county_land_use_code', 'exterior_walls', 'floor_cover', 'heating_fuel_type',
  'interior_walls', 'porch', 'deck', 'driveway', 'roof_type', 'legal_description', 'geographic_features',
  'hoa1_name', 'hoa1_type', 'hoa_fee_amount', 'market_status_label', 'avg_sqft_per_unit', 'beds_per_unit', 'sqft_range',
  'assd_improvement_value', 'assd_land_value', 'assd_year', 'calculated_improvement_value', 'calculated_land_value',
  'calculated_total_value', 'lot_nbr', 'lot_size_depth_feet', 'lot_size_frontage_feet', 'num_of_fireplaces',
  'situs_census_tract', 'style', 'topography', 'sum_buildings_nbr', 'sum_commercial_units', 'sum_garage_sqft',
  'original_property_type', 'asset_class', 'asset_subclass', 'market_region',
  'deal_list_label', 'source_list_label', 'source_list_category', 'property_export_id', 'canonical_market_id',
]))

/**
 * LINKED-ENTITY COLUMNS (owner, 2026-10-08: "the column picker must offer
 * every field for every linked entity"). Requested as `<source>.<field>`;
 * each source is ONE keyed read per chunk, only when a visible column needs it:
 *
 *   owner.*     master_owners via properties.master_owner_id (master_owners_pkey).
 *               Only ~25% of properties carry a master owner — the rest answer
 *               "—" for these, and the Contact columns below (keyed on the
 *               property itself) are the per-property truth.
 *   scores.*    property_acquisition_scores (unique property_id) — the Decision
 *               Engine; absent = the engine has not run for that property.
 *   contact.*   campaign_target_graph by property_id (indexed): the canonical
 *               person + phone resolution the campaigns use. Several rows per
 *               property → a primary value (best phone score) + a count.
 *               The phone NUMBER is never returned.
 *   entity.*    sub_owners (title-holding names) via master_owner_id.
 *   email.*     emails via master_owner_id (count only).
 */
export const ENTITY_GRAPH_LINKED_COLUMNS = Object.freeze({
  owner: Object.freeze(new Set([
    'display_name', 'owner_type_guess', 'priority_tier', 'follow_up_cadence', 'best_language', 'best_channel',
    'best_contact_window', 'routing_timezone', 'routing_market', 'markets_text', 'contactability_score',
    'financial_pressure_score', 'urgency_score', 'priority_score', 'property_count', 'portfolio_total_value',
    'portfolio_total_equity', 'portfolio_total_loan_balance', 'portfolio_total_loan_payment', 'portfolio_total_tax_amount',
    'portfolio_total_units', 'tax_delinquent_count', 'oldest_tax_delinquent_year', 'active_lien_count',
    'max_ownership_years', 'seller_tags_text', 'agent_persona', 'primary_owner_address',
  ])),
  // (no estimated_repairs: the engine's repair input IS the vendor estimate — not an Entity Graph field)
  scores: Object.freeze(new Set([
    'aos_score', 'decision_tier', 'confidence', 'best_strategy', 'valuation_low', 'valuation_mid', 'valuation_high',
    'valuation_confidence', 'comp_count', 'recommended_cash_offer', 'minimum_acceptable_offer', 'expected_assignment_fee',
    'buyer_demand_score', 'liquidity_score', 'transaction_probability_90', 'transaction_probability_365',
    'seller_financial_pressure_score', 'foreclosure_risk_score', 'owner_situation_primary', 'recommended_conversation_angle', 'computed_at',
  ])),
  contact: Object.freeze(new Set([
    'person', 'person_count', 'phone_count', 'line_type', 'phone_activity', 'identity', 'matching', 'phone_owner',
  ])),
  // recorded documents (seller.* via public.v_entity_graph_properties rec_* — loans, liens, sales, foreclosure)
  rec: Object.freeze(new Set([
    'mortgage_count', 'mortgage_balance', 'mortgage_payment', 'first_rate', 'max_rate', 'first_lender', 'first_loan_type',
    'first_recording_date', 'first_due_date', 'has_private_lender', 'has_heloc', 'has_fha', 'has_va', 'has_seller_financing',
    'has_adjustable', 'lien_count', 'lien_amount_due', 'lien_categories', 'has_probate', 'has_lis_pendens', 'has_death_record',
    'has_divorce_record', 'has_judgment', 'has_mechanics_lien', 'has_tax_lien', 'has_hoa_lien', 'has_default_notice',
    'sale_count', 'last_sale_date', 'last_sale_price', 'last_sale_doc_type', 'last_sale_distress', 'last_sale_intrafamily',
    'years_owned', 'foreclosure_count', 'foreclosure_stage', 'auction_date',
  ])),
  // the canonical person on the campaign graph's best row (prospects by individual_key)
  person: Object.freeze(new Set([
    'language_preference', 'gender', 'marital_status', 'occupation_group', 'education_model', 'est_household_income',
    'net_asset_value', 'buying_power', 'age', 'person_flags_text', 'matching_flags', 'timezone', 'contact_window',
  ])),
  // the property's ZIP market (entity-graph-zip-context.js: MI rollup + buyer index)
  zip: Object.freeze(new Set(['sales_90d', 'sales_1y', 'investor_share', 'cash_share', 'median_price', 'median_ppsf', 'latest_sale', 'buyers', 'active_buyers'])),
  entity: Object.freeze(new Set(['name', 'count'])),
  email: Object.freeze(new Set(['count'])),
})

const clean = (v) => String(v ?? '').trim()
const list = (v) => [...new Set(String(v ?? '').split(',').map(clean).filter(Boolean))]

function isLinkedField(field) {
  const [source, col, extra] = field.split('.')
  return !extra && Boolean(ENTITY_GRAPH_LINKED_COLUMNS[source]?.has(col))
}

/** `fields=year_built,zoning,owner.priority_tier,…` against the whitelists. Unknown fields are dropped, never forwarded. */
export function parseEntityGraphColumnFields(raw) {
  return list(raw).filter((c) => ENTITY_GRAPH_PROPERTY_COLUMNS.has(c) || isLinkedField(c))
}

async function readIn(client, table, select, key, ids) {
  const out = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await client.from(table).select(select).in(key, ids.slice(i, i + CHUNK))
    if (error) throw error
    out.push(...(data || []))
  }
  return out
}

const present = (v) => v !== null && v !== undefined && v !== ''

/** Linked-entity values for `ids`, merged into `values`. */
async function enrichLinked(client, ids, linked, values) {
  const want = (source) => linked.filter((f) => f.startsWith(`${source}.`)).map((f) => f.slice(source.length + 1))
  const ownerCols = want('owner')
  const scoreCols = want('scores')
  const contactCols = want('contact')
  const entityCols = want('entity')
  const recCols = want('rec')
  const emailCols = want('email')
  const put = (id, key, v) => {
    if (!present(v)) return
    values[id] = values[id] || {}
    values[id][key] = v
  }

  // properties.master_owner_id is set on ~23% of properties; the rest are
  // linked through their prospects (entity-graph-owner-link.js) — one read of
  // linked prospects serves both the owner and the person fallback.
  const personCols = want('person')
  let linkedProspects = null
  const linkedFor = async () => {
    if (!linkedProspects) linkedProspects = await prospectsLinkedToProperties(client, ids, ['rank_position', 'is_primary_prospect', 'mob', ...personCols.filter((c) => c !== 'age')].join(','))
    return linkedProspects
  }
  let ownerOf = null
  if (ownerCols.length || entityCols.length || emailCols.length) {
    const rows = await readIn(client, 'properties', 'property_id, master_owner_id', 'property_id', ids)
    const needsLink = rows.some((r) => !clean(r.master_owner_id))
    const resolved = await resolvePropertyOwners(client, rows, { linked: needsLink ? await linkedFor() : new Map() })
    ownerOf = new Map([...resolved].map(([pid, r]) => [pid, r.ownerId]))
  }
  const ownerIds = ownerOf ? [...new Set(ownerOf.values())] : []

  const zipCols = want('zip')
  await Promise.all([
    (async () => {
      if (!zipCols.length) return
      const props = await readIn(client, 'properties', 'property_id, property_address_zip', 'property_id', ids)
      const zipOf = new Map(props.map((p) => [clean(p.property_id), clean(p.property_address_zip).slice(0, 5)]))
      const { getEntityGraphZipContext } = await import('./entity-graph-zip-context.js')
      const wantsBuyers = zipCols.some((c) => c === 'buyers' || c === 'active_buyers')
      const { zips } = await getEntityGraphZipContext({ zips: [...new Set(zipOf.values())].join(','), buyers: wantsBuyers ? '1' : '0' }, { supabase: client })
      const map = { sales_90d: 'sales90d', sales_1y: 'sales1y', investor_share: 'investorShare1y', cash_share: 'cashShare1y', median_price: 'medianPrice1y', median_ppsf: 'medianPpsf1y', latest_sale: 'latestSale', buyers: 'buyers', active_buyers: 'activeBuyers' }
      for (const [pid, zip] of zipOf) for (const c of zipCols) put(pid, `zip.${c}`, zips[zip]?.[map[c]])
    })(),
    (async () => {
      if (!recCols.length) return
      const rows = await readIn(client, 'v_entity_graph_properties', ['property_id', ...recCols.map((c) => `rec_${c}`)].join(','), 'property_id', ids)
      for (const r of rows) for (const c of recCols) {
        const v = r[`rec_${c}`]
        put(clean(r.property_id), `rec.${c}`, Array.isArray(v) ? (v.length ? v.join(', ') : null) : v)
      }
    })(),
    (async () => {
      if (!personCols.length) return
      const graph = await readIn(client, 'campaign_target_graph', 'property_id, seller_person_key, best_phone_score', 'property_id', ids)
      const best = new Map()
      for (const g of graph) {
        const id = clean(g.property_id)
        const cur = best.get(id)
        if (clean(g.seller_person_key) && (!cur || (Number(g.best_phone_score) || -1) > (Number(cur.best_phone_score) || -1))) best.set(id, g)
      }
      const keys = [...new Set([...best.values()].map((g) => clean(g.seller_person_key)))]
      const cols = personCols.filter((c) => c !== 'age')
      const people = keys.length ? await readIn(client, 'prospects', ['individual_key', 'mob', ...cols].join(','), 'individual_key', keys) : []
      const byKey = new Map(people.map((p) => [clean(p.individual_key), p]))
      // the campaign graph's person first; else the property's own linked
      // prospect (seller_person_key joins prospects for only ~42% of properties)
      const personOf = new Map()
      for (const [id, g] of best) { const p = byKey.get(clean(g.seller_person_key)); if (p) personOf.set(id, p) }
      if (ids.some((id) => !personOf.has(id))) {
        const linked = await linkedFor()
        for (const id of ids) if (!personOf.has(id)) { const p = primaryLinkedProspect(linked.get(id)); if (p) personOf.set(id, p) }
      }
      const now = new Date()
      for (const [id, p] of personOf) {
        for (const c of cols) put(id, `person.${c}`, p[c])
        if (personCols.includes('age') && /^\d{6}$/.test(clean(p.mob))) {
          const y = Number(p.mob.slice(0, 4)); const m = Number(p.mob.slice(4))
          put(id, 'person.age', now.getUTCFullYear() - y - (now.getUTCMonth() + 1 < m ? 1 : 0))
        }
      }
    })(),
    (async () => {
      if (!ownerCols.length || !ownerIds.length) return
      const rows = await readIn(client, 'master_owners', ['master_owner_id', ...ownerCols].join(','), 'master_owner_id', ownerIds)
      const byOwner = new Map(rows.map((r) => [clean(r.master_owner_id), r]))
      for (const [pid, oid] of ownerOf) for (const c of ownerCols) put(pid, `owner.${c}`, byOwner.get(oid)?.[c])
    })(),
    (async () => {
      if (!scoreCols.length) return
      const rows = await readIn(client, 'property_acquisition_scores', ['property_id', ...scoreCols].join(','), 'property_id', ids)
      for (const r of rows) for (const c of scoreCols) put(clean(r.property_id), `scores.${c}`, r[c])
    })(),
    (async () => {
      if (!contactCols.length) return
      const rows = await readIn(client, 'campaign_target_graph', 'property_id, seller_full_name, seller_person_key, canonical_e164, best_phone_score, phone_type, phone_activity_status, phone_owner, identity_alignment, matching_flags_text', 'property_id', ids)
      const byProp = new Map()
      for (const r of rows) {
        const id = clean(r.property_id)
        if (!byProp.has(id)) byProp.set(id, [])
        byProp.get(id).push(r)
      }
      for (const [id, group] of byProp) {
        const best = [...group].sort((a, b) => (Number(b.best_phone_score) || -1) - (Number(a.best_phone_score) || -1))[0]
        const persons = new Set(group.map((r) => clean(r.seller_person_key) || clean(r.seller_full_name)).filter(Boolean))
        const phones = new Set(group.map((r) => clean(r.canonical_e164)).filter(Boolean))
        const has = (c) => contactCols.includes(c)
        if (has('person')) put(id, 'contact.person', clean(best?.seller_full_name) || null)
        if (has('person_count')) put(id, 'contact.person_count', persons.size)
        if (has('phone_count')) put(id, 'contact.phone_count', phones.size)
        if (has('line_type')) put(id, 'contact.line_type', clean(best?.phone_type) || null)
        if (has('phone_activity')) put(id, 'contact.phone_activity', clean(best?.phone_activity_status) || null)
        if (has('phone_owner')) put(id, 'contact.phone_owner', clean(best?.phone_owner) || null)
        if (has('identity')) put(id, 'contact.identity', clean(best?.identity_alignment) || null)
        if (has('matching')) put(id, 'contact.matching', clean(best?.matching_flags_text) || null)
      }
    })(),
    (async () => {
      if (!entityCols.length || !ownerIds.length) return
      const rows = await readIn(client, 'sub_owners', 'master_owner_id, owner_name', 'master_owner_id', ownerIds)
      const byOwner = new Map()
      for (const r of rows) {
        const oid = clean(r.master_owner_id)
        if (!byOwner.has(oid)) byOwner.set(oid, [])
        if (clean(r.owner_name)) byOwner.get(oid).push(clean(r.owner_name))
      }
      for (const [pid, oid] of ownerOf) {
        const names = [...new Set(byOwner.get(oid) || [])]
        if (entityCols.includes('name')) put(pid, 'entity.name', names[0] || null)
        if (entityCols.includes('count')) put(pid, 'entity.count', names.length || null)
      }
    })(),
    (async () => {
      if (!emailCols.length || !ownerIds.length) return
      const rows = await readIn(client, 'emails', 'master_owner_id, email_id', 'master_owner_id', ownerIds)
      const count = new Map()
      for (const r of rows) count.set(clean(r.master_owner_id), (count.get(clean(r.master_owner_id)) || 0) + 1)
      for (const [pid, oid] of ownerOf) put(pid, 'email.count', count.get(oid) || null)
    })(),
  ])
}

/**
 * Returns { values: { [property_id]: { col: value } }, requested: [...cols] }.
 * An id with no row, or a column with no value, is simply absent.
 */
export async function getEntityGraphColumnEnrichment(params = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const requested = parseEntityGraphColumnFields(params.fields)
  const columns = requested.filter((c) => ENTITY_GRAPH_PROPERTY_COLUMNS.has(c))
  const linked = requested.filter((c) => !ENTITY_GRAPH_PROPERTY_COLUMNS.has(c))
  const ids = list(params.property_ids).slice(0, MAX_IDS)
  const values = {}
  if (linked.length && ids.length) await enrichLinked(client, ids, linked, values)
  if (columns.length && ids.length) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK)
      const { data, error } = await client.from('properties').select(['property_id', ...columns].join(',')).in('property_id', part)
      if (error) throw error
      for (const row of data || []) {
        const id = clean(row.property_id)
        if (!id) continue
        const vals = values[id] || {}
        for (const c of columns) if (vals[c] === undefined && row[c] !== null && row[c] !== undefined && row[c] !== '') vals[c] = row[c]
        values[id] = vals
      }
    }
  }
  return { values, requested, generatedAt: new Date().toISOString() }
}
