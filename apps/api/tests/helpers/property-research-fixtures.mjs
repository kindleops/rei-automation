// 8.5.20-b fixtures: an engine score row, a property row (with name / contact / protected
// columns that must NEVER reach any output), recorded rows, and an in-memory research source.
export const NOW = Date.parse('2026-10-15T15:00:00.000Z')
export const PID = '2127709832'
export const SECRET_PHONE = '+12145550147'
export const SECRET_NAME = 'Jane Q Ownerperson'

export function score({ mid = 200000, mao = 150000, offer = 140000, conf = 80, comps = 9, tier = 'AUTO_HARD_OFFER', demand = 70, investorMid = 172000, repairs = 0, computed = '2026-10-10T12:00:00.000Z', assetType = 'single_family', extra = {} } = {}) {
  return {
    id: 'pas-1', property_id: PID, valuation_mid: mid, valuation_low: Math.round(mid * 0.92), valuation_high: Math.round(mid * 1.08), valuation_confidence: conf, comp_count: comps, confidence: conf,
    decision_tier: tier, recommended_cash_offer: offer, minimum_acceptable_offer: offer - 5000, investor_ceiling_mid: investorMid, estimated_repairs: repairs, buyer_demand_score: demand, liquidity_score: 65, expected_assignment_fee: 15000,
    computed_at: computed,
    evidence: {
      immutable_snapshot_id: 'snap-1',
      offer_calculation: { method: 'repair_adjusted_exit_ceiling_less_assignment_target', effective_authorized_ceiling: mao, ceiling_basis: 'valuation_ceiling', estimated_repairs: repairs, target_assignment_fee: 15000, protected_margin: 15000, assignment_margin_policy: { target_margin: 15000, protected_margin: 15000, minimum_margin: 15000 } },
      subject: { asset_type: assetType },
      decision_inputs: { inputs: { property: { estimated_value: mid } } },
      selected_comps: [
        { comp_id: 'c1', source: 'mls_sold', sale_price: 205000, sale_date: '2026-06-01', distance_miles: 0.4 },
        { comp_id: 'c2', source: 'Public Record Sold', sale_price: 188000, sale_date: '2026-05-12', distance_miles: 0.6 },
        { comp_id: 'c3', source: 'Off-Market Sold', sale_price: 176000, sale_date: '2026-03-20', distance_miles: 0.8 },
        { comp_id: 'c4', source: 'mls_sold', sale_price: 214000, sale_date: '2026-02-02', distance_miles: 0.9 },
      ],
    },
    ...extra,
  }
}

export function propertyRow(over = {}) {
  return {
    property_id: PID, apn_parcel_id: '00-123-456', property_address_full: '1830 Example St, Grand Prairie, TX 75051', property_address_city: 'Grand Prairie', property_address_state: 'TX', property_address_zip: '75051', property_address_county_name: 'Dallas',
    market: 'dallas-tx', canonical_market_id: 'dallas-tx', latitude: 32.73, longitude: -97.0,
    property_type: 'Single Family Residential', units_count: 1, total_bedrooms: 3, total_baths: 2, building_square_feet: 1260, year_built: 1950, building_condition: 'Average',
    lot_square_feet: 7150, zoning: 'SF-7', flood_zone: 'X', subdivision_name: 'EXAMPLE PARK', ownership_years: 22, is_corporate_owner: false, out_of_state_owner: false,
    sale_date: '2004-05-01', sale_price: 92000, estimated_value: 205000, arv_estimate: 240000, estimated_repair_cost: 18000, equity_percent: 78, total_loan_balance: 41000,
    tax_amt: 4100, tax_delinquent: false, active_lien: false, assd_total_value: 188000, mls_market_status: null, mls_current_listing_price: null,
    updated_at: '2026-10-01T00:00:00.000Z',
    // never allowed out:
    owner_1_name: SECRET_NAME, owner_name: SECRET_NAME, best_phone: SECRET_PHONE, best_email: 'owner@example.com', owner_address_full: '9 Private Rd',
    age: 71, marital_status: 'widowed', race: 'x', religion: 'y', familial_status: 'z',
    ...over,
  }
}

export const SALES = [
  { property_id: PID, event_date: '2004-05-01', event_date_kind: 'recording', price: 92000, price_code: 'full', doc_type: 'Warranty Deed', is_arms_length: true, is_cash_purchase: false, buyer_1_name: SECRET_NAME, seller_1_name: 'Somebody Else' },
]
export const MORTGAGES = [{ property_id: PID, recording_date: '2015-03-01', loan_amount: 80000, est_balance: 41000, loan_type: 'Conventional', lien_position: 1, interest_rate: 3.9, is_private_lender: false, lender_name: 'Private Person Lender' }]
export const LIENS = [{ property_id: PID, lien_type: 'HOA', amount_due: 1200, recording_date: '2025-11-01', party_1_name: SECRET_NAME, date_of_death: '2025-01-01', date_of_divorce: '2020-01-01' }]

export function marketSales({ n = 14, investorEvery = 3 } = {}) {
  const out = []
  for (let i = 0; i < n; i += 1) {
    out.push({ comp_id: `m${i}`, source: 'public_record', price: 170000 + i * 4000, sold_on: `2026-0${1 + (i % 8)}-1${i % 9}`, lat: 32.73 + i * 0.001, lng: -97.0 + i * 0.001, units: 1, is_investor: i % investorEvery === 0, buyer_kind: i % investorEvery === 0 ? 'company' : 'person', is_cash_purchase: i % 2 === 0, is_arms_length: true, is_priced: true, year_built: 1960 + i, property_type: 'Single Family' })
  }
  return out
}

/** In-memory research source with the production interface. */
export function memorySource({ property = propertyRow(), valuation = score(), sales = SALES, mortgages = MORTGAGES, liens = LIENS, inbound = [], opportunity = null, offers = [], sold = [], market = marketSales(), area = {} } = {}) {
  return {
    kind: 'memory',
    property: async (id) => (id === PID ? property : null),
    valuation: async () => valuation,
    sales: async () => sales,
    mortgages: async () => mortgages,
    liens: async () => liens,
    sellerThread: async () => ({ inbound, outbound_count: 2, last_outbound_at: '2026-10-12T15:00:00.000Z' }),
    opportunity: async () => opportunity,
    offers: async () => offers,
    soldComps: async () => sold,
    marketSales: async () => market,
    area: async () => area,
  }
}
