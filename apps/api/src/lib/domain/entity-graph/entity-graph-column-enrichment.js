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
import { withRepairTruth } from './entity-graph-truth.js'

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
  scores: Object.freeze(new Set([
    'aos_score', 'decision_tier', 'confidence', 'best_strategy', 'valuation_low', 'valuation_mid', 'valuation_high',
    'valuation_confidence', 'comp_count', 'recommended_cash_offer', 'minimum_acceptable_offer', 'expected_assignment_fee',
    'buyer_demand_score', 'liquidity_score', 'estimated_repairs', 'transaction_probability_90', 'transaction_probability_365',
    'seller_financial_pressure_score', 'foreclosure_risk_score', 'owner_situation_primary', 'recommended_conversation_angle', 'computed_at',
  ])),
  contact: Object.freeze(new Set([
    'person', 'person_count', 'phone_count', 'line_type', 'phone_activity', 'identity', 'matching', 'phone_owner',
  ])),
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
  const emailCols = want('email')
  const put = (id, key, v) => {
    if (!present(v)) return
    values[id] = values[id] || {}
    values[id][key] = v
  }

  let ownerOf = null
  if (ownerCols.length || entityCols.length || emailCols.length) {
    const rows = await readIn(client, 'properties', 'property_id, master_owner_id', 'property_id', ids)
    ownerOf = new Map(rows.filter((r) => clean(r.master_owner_id)).map((r) => [clean(r.property_id), clean(r.master_owner_id)]))
  }
  const ownerIds = ownerOf ? [...new Set(ownerOf.values())] : []

  await Promise.all([
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
      // the repair estimate is checked against value / sqft / units before it is shown (repairTruth)
      const helper = columns.includes('estimated_repair_cost') ? ['estimated_value', 'building_square_feet', 'units_count'].filter((c) => !columns.includes(c)) : []
      const { data: raw, error } = await client.from('properties').select(['property_id', ...columns, ...helper].join(',')).in('property_id', part)
      const data = columns.includes('estimated_repair_cost') ? (raw || []).map((r) => { const t = withRepairTruth(r); return { ...t, estimated_repair_cost_status: t.estimated_repair_cost_status } }) : raw
      if (error) throw error
      for (const row of data || []) {
        const id = clean(row.property_id)
        if (!id) continue
        const vals = values[id] || {}
        for (const c of columns) if (vals[c] === undefined && row[c] !== null && row[c] !== undefined && row[c] !== '') vals[c] = row[c]
        if (row.estimated_repair_cost_status && row.estimated_repair_cost_status !== 'unknown') vals.estimated_repair_cost_status = row.estimated_repair_cost_status
        values[id] = vals
      }
    }
  }
  return { values, requested, generatedAt: new Date().toISOString() }
}
