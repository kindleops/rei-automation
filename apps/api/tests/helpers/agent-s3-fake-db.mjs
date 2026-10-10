// Agent S3 test double: an in-memory, READ-ONLY Supabase-like client that the
// real Entity Graph services run against unchanged. Supports the query
// surface those services use (select/eq/in/not like/contains/overlaps/or/
// order/limit/maybeSingle/single/head counts/rpc). Any write method throws,
// so a test fails loudly if a tool ever tries to write.
//
// Fixture people/phones are deliberately recognisable (FIXTURE_PII) so tests
// can assert they never reach events, findings or the persisted store.

export const FIXTURE_PII = Object.freeze({ ownerName: 'Zebulon Q Fixtureowner', prospectName: 'Ophelia Fixtureperson', phone: '+16125550147', phoneDigits: '6125550147', email: 'fixture.owner@example.test', mailing: '77 Fixture Mailing Rd' })

function like(value, pattern) {
  const re = new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i')
  return re.test(String(value ?? ''))
}

function parseJsonish(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}

function builder(db, table) {
  const filters = []
  let orderBy = null
  let limitN = null
  let head = false
  let countMode = null
  const q = {
    select(_cols, opts = {}) { head = Boolean(opts.head); countMode = opts.count || null; return q },
    eq(col, v) { filters.push((r) => String(r[col] ?? '') === String(v)); return q },
    neq(col, v) { filters.push((r) => String(r[col] ?? '') !== String(v)); return q },
    in(col, arr) { const s = new Set((arr || []).map(String)); filters.push((r) => s.has(String(r[col] ?? ''))); return q },
    not(col, op, v) { if (op === 'like') filters.push((r) => !like(r[col], v)); else if (op === 'is') filters.push((r) => r[col] !== null && r[col] !== undefined); return q },
    is(col, v) { filters.push((r) => (v === null ? r[col] === null || r[col] === undefined : r[col] === v)); return q },
    gte(col, v) { filters.push((r) => r[col] >= v); return q },
    lte(col, v) { filters.push((r) => r[col] <= v); return q },
    contains(col, v) { const need = parseJsonish(v).map(String); filters.push((r) => { const have = parseJsonish(r[col]).map(String); return need.every((x) => have.includes(x)) }); return q },
    overlaps(col, arr) { const s = new Set((arr || []).map(String)); filters.push((r) => (Array.isArray(r[col]) ? r[col] : []).some((x) => s.has(String(x)))); return q },
    or() { return q }, // OR filters are not modelled: fixtures only hold rows for the subject
    order(col, { ascending = true } = {}) { orderBy = { col, ascending }; return q },
    limit(n) { limitN = n; return q },
    range() { return q },
    maybeSingle() { return run().then(({ data, error }) => ({ data: data?.[0] ?? null, error })) },
    single() { return run().then(({ data, error }) => ({ data: data?.[0] ?? null, error: data?.length ? error : { message: 'no rows' } })) },
    then(resolve, reject) { return run().then(resolve, reject) },
    insert() { throw new Error(`WRITE_ATTEMPT:${table}.insert`) },
    update() { throw new Error(`WRITE_ATTEMPT:${table}.update`) },
    upsert() { throw new Error(`WRITE_ATTEMPT:${table}.upsert`) },
    delete() { throw new Error(`WRITE_ATTEMPT:${table}.delete`) },
  }
  async function run() {
    db.calls.push({ kind: 'table', table })
    if (db.failTables?.has(table)) return { data: null, error: { message: `${table} unavailable`, code: 'XX000' } }
    let rows = [...(db.tables[table] || [])].filter((r) => filters.every((f) => f(r)))
    if (orderBy) rows.sort((a, b) => (a[orderBy.col] > b[orderBy.col] ? 1 : a[orderBy.col] < b[orderBy.col] ? -1 : 0) * (orderBy.ascending ? 1 : -1))
    if (limitN != null) rows = rows.slice(0, limitN)
    const copy = structuredClone(rows)
    if (head) return { data: null, count: countMode ? copy.length : null, error: null }
    return { data: copy, count: countMode ? copy.length : null, error: null }
  }
  return q
}

export function createFakeReadDb({ tables = {}, rpcs = {}, failTables = [] } = {}) {
  const db = { tables, calls: [], failTables: new Set(failTables) }
  return {
    calls: db.calls,
    from: (table) => builder(db, table),
    rpc: async (fn, args) => {
      db.calls.push({ kind: 'rpc', fn })
      if (!rpcs[fn]) return { data: null, error: { message: `function ${fn} does not exist`, code: 'PGRST202' } }
      return { data: structuredClone(rpcs[fn](args)), error: null }
    },
  }
}

/** One property with recorded docs, vendor flags that conflict, outreach + MI context. */
export function fixtureTables({ propertyId = '9000000001', freeAndClear = true, mortgageRecorded = '2026-06-15', vendorDate = '2026-04-22', withRecords = true } = {}) {
  const ownerId = 'mo_fixture_1'
  const tables = {
    properties: [{
      property_id: propertyId, master_owner_id: ownerId, property_address_full: '100 Fixture Ave, Testville, MN 55411', property_address_city: 'Testville', property_address_state: 'MN',
      property_address_zip: '55411', property_zip: '55411', property_address_county_name: 'Hennepin', market: 'Minneapolis', latitude: 44.98, longitude: -93.3,
      property_type: 'Single Family', normalized_asset_class: 'sfr', units_count: 1, total_bedrooms: 3, total_baths: 2, building_square_feet: 1450, year_built: 1958,
      estimated_value: 250000, value_low: 230000, value_high: 270000, valuation_date: vendorDate, equity_percent: 100, total_loan_balance: 0,
      property_flags_text: freeAndClear ? 'Free And Clear; High Equity' : 'Low Equity', owner_name: FIXTURE_PII.ownerName, owner_address_full: FIXTURE_PII.mailing,
      is_corporate_owner: false, out_of_state_owner: true, ownership_years: 12, tax_delinquent: false, active_lien: false,
      streetview_image: 'https://maps.googleapis.com/maps/api/streetview?location=1&key=SECRETKEY123', updated_at: '2026-08-06T05:13:56Z', created_at: '2026-04-25T00:00:00Z', exported_at_utc: '2026-04-25T00:00:00Z',
      best_phone: FIXTURE_PII.phone, best_email: FIXTURE_PII.email, cash_offer: 99999, final_acquisition_score: 88,
    }],
    master_owners: [{ master_owner_id: ownerId, display_name: FIXTURE_PII.ownerName, owner_type_guess: 'Individual', property_count: 3, joined_property_ids_json: JSON.stringify([propertyId]), joined_sub_owner_ids_json: '[]', best_phone_1: FIXTURE_PII.phone, best_email_1: FIXTURE_PII.email }],
    prospects: [{ prospect_id: 'pr_1', master_owner_id: ownerId, full_name: FIXTURE_PII.prospectName, best_phone: FIXTURE_PII.phone, linked_property_ids_json: JSON.stringify([propertyId]), phones_json: [{ canonical_e164: FIXTURE_PII.phone, phone_type: 'mobile' }] }],
    phones: [{ phone_id: 'ph_1', canonical_e164: FIXTURE_PII.phone, phone: FIXTURE_PII.phone, master_owner_id: ownerId, sort_rank: 1, owner_display_name: FIXTURE_PII.ownerName }],
    emails: [{ email_id: 'em_1', email: FIXTURE_PII.email, email_normalized: FIXTURE_PII.email, master_owner_id: ownerId, sort_rank: 1 }],
    inbox_thread_state: [{ thread_key: FIXTURE_PII.phone, property_id: propertyId, latest_message_at: '2026-09-30T15:00:00Z', latest_direction: 'outbound', latest_message_body: `Hi ${FIXTURE_PII.prospectName}, call ${FIXTURE_PII.phone}`, seller_stage: 'S2', conversation_status: 'awaiting_reply', is_suppressed: false, last_outbound_at: '2026-09-30T15:00:00Z', master_owner_id: ownerId }],
    property_acquisition_scores: [{ property_id: propertyId, aos_score: 71, decision_tier: 'B', confidence: 0.7, best_strategy: 'wholesale', recommended_cash_offer: 160000, computed_at: '2026-09-01T00:00:00Z', valuation_low: 200000, valuation_mid: 215000, valuation_high: 230000, valuation_confidence: 0.6, comp_count: 7 }],
    v_entity_graph_properties: [{ property_id: propertyId, rec_mortgage_count: withRecords ? 1 : 0, rec_mortgage_balance: withRecords ? 150000 : null }],
    campaign_target_graph: [{ property_id: propertyId, queue_eligible: false, queue_block_reason: 'missing_phone', seller_person_key: 'pk_1', canonical_e164: null, timezone: 'America/Chicago', identity_alignment: 'aligned', last_outbound_at: '2026-09-29T15:00:00Z', last_inbound_at: null }],
    acquisition_opportunities: [],
    campaign_targets: [{ property_id: propertyId, campaign_id: 'camp_1', target_status: 'held', block_reason: 'outbound_paused', created_at: '2026-09-28T00:00:00Z' }],
    campaigns: [{ id: 'camp_1', name: 'Fixture MSP Campaign', status: 'paused' }],
    mi_rollup_builds: [{ build_id: 42, status: 'ready' }],
    mi_geo_period_rollup: [
      { build_id: 42, geo_level: 'zip', asset: 'all', period: '1y', geo_key: '55411', sale_count: 48, investor_count: 18, buyer_known_count: 40, cash_known_count: 30, cash_count: 12, median_price: 210000, median_ppsf: 150, median_inv_price: 180000, latest_sale: '2026-07-20', mf_sale_count: 3 },
      { build_id: 42, geo_level: 'zip', asset: 'all', period: '90d', geo_key: '55411', sale_count: 11 },
    ],
    census_geo_metrics: [],
    eg_buyer_index: [{ buyer_id: 'b1', zips: ['55411'], activity_status: 'active' }, { buyer_id: 'b2', zips: ['55411'], activity_status: 'dormant' }],
  }
  const records = {
    mortgages: withRecords ? [{ slot: 'mtg1', lien_position: 1, lender_name: 'FIXTURE NATIONAL BANK', loan_amount: 180000, est_balance: 150000, est_payment: 1100, interest_rate: 3.25, loan_type: 'Conventional', recording_date: mortgageRecorded, due_date: '2056-06-01', term_months: 360, is_private_lender: false }] : [],
    liens: [],
    sales: withRecords ? [{ slot: 'current', event_date: '2014-03-10', price: 120000, doc_type: 'Warranty Deed', buyer_1_name: FIXTURE_PII.ownerName, seller_1_name: 'PRIOR FIXTURE SELLER', is_cash_purchase: false, is_arms_length: true, canonical_transaction_id: 77, buyer: { buyer_id: 'b9', entity_type: 'person', basis: 'name', acquisition_count: 1, activity_status: 'dormant', name: FIXTURE_PII.ownerName } }] : [],
    foreclosures: [],
    owner_buyer: null,
    parcel: { fips: '27053', county_name: 'Hennepin', tax_delinquent: false, active_lien: false, open_mortgage_count: 0, total_loan_balance: 0, equity_percent: 100, owner_name: FIXTURE_PII.ownerName, mail_address_full: FIXTURE_PII.mailing, last_observed_at: vendorDate, first_observed_at: '2026-01-01', updated_at: vendorDate },
  }
  return {
    tables,
    rpcs: {
      entity_graph_property_records: ({ p_property_id }) => (p_property_id === propertyId ? records : { mortgages: [], liens: [], sales: [], foreclosures: [], owner_buyer: null, parcel: null }),
      campaign_entity_contact_review_flags: () => [],
    },
  }
}

/** Several fixture properties in one fake db. */
export function multiDb(ids, opts = {}) {
  const tables = {}
  const recs = {}
  for (const id of ids) {
    const f = fixtureTables({ propertyId: id, ...opts })
    for (const [t, rows] of Object.entries(f.tables)) {
      tables[t] = tables[t] || []
      for (const r of rows) if (!tables[t].some((x) => JSON.stringify(x) === JSON.stringify(r))) tables[t].push(r)
    }
    recs[id] = f.rpcs.entity_graph_property_records({ p_property_id: id })
  }
  return createFakeReadDb({ tables, rpcs: { entity_graph_property_records: ({ p_property_id }) => recs[p_property_id] || { mortgages: [], liens: [], sales: [], foreclosures: [], owner_buyer: null, parcel: null }, campaign_entity_contact_review_flags: () => [] } })
}

/**
 * Wrap a store so a test can "kill" the worker that uses it: after kill(),
 * every transaction hangs forever (no heartbeats, no writes) — what a
 * SIGKILLed process looks like to everyone else.
 */
export function killableStore(store) {
  let dead = false
  const parked = []
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'kill') return () => { dead = true }
      // revive(): a PAUSED (not killed) worker wakes up and its parked transactions run late
      if (prop === 'revive') return () => { dead = false; for (const go of parked.splice(0)) go() }
      if (prop === 'transaction') return (fn) => (dead ? new Promise((resolve, reject) => parked.push(() => target.transaction(fn).then(resolve, reject))) : target.transaction(fn))
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}
