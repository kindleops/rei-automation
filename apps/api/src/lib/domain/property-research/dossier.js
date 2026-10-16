// ─── PROPERTY DOSSIER (8.5.20-b, mission kind property.research) ─────────────
// buildPropertyDossier() — pure. Assembles a TYPED dossier from internal data FIRST
// (properties, property_acquisition_scores, seller.property_sale / _mortgage / _lien,
// the conversation fact ledger, internal thread + offer history). Web research only
// fills the gaps this function reports (dossier.gaps) and is merged afterwards as
// kind 'inferred' fields with a web source (mergeWebFindings).
//
// Every field obeys the provenance contract (provenance.js).
//
// PRIVACY + FAIR HOUSING (binding):
//   • the column whitelists below carry NO names, phones, e-mails, mailing addresses,
//     lender / party names, dates of death or divorce;
//   • protected-attribute keys are stripped from every input before it is read
//     (stripProtectedAttributes — the same list the economics + negotiation use);
//   • nothing demographic (area composition, income, language, age, marital status)
//     is ever an input: property and market evidence only.
import { stripProtectedAttributes, resolveEconomicsLane } from '../opportunity-economics/classify-opportunity.js'
import { evaluateOfferReadiness } from '../../acquisition/offerReadiness.js'
import { inferPotentialUnits } from '../opportunity-economics/zoning-density.js'
import { field, validateFieldMap, coverage, PROVENANCE_VERSION } from './provenance.js'

export { inferPotentialUnits }

export const DOSSIER_VERSION = 'property-dossier.v1'

/** properties columns the dossier may read (explicit whitelist; nothing name / contact shaped). */
export const DOSSIER_PROPERTY_COLUMNS = Object.freeze([
  'property_id', 'apn_parcel_id', 'property_address_full', 'property_address_city', 'property_address_state', 'property_address_zip', 'property_address_county_name',
  'market', 'canonical_market_id', 'latitude', 'longitude',
  'property_type', 'property_class', 'asset_type', 'asset_subtype', 'normalized_asset_class', 'units_count', 'multifamily_units', 'commercial_units',
  'total_bedrooms', 'total_baths', 'building_square_feet', 'year_built', 'effective_year_built', 'stories', 'construction_type', 'building_condition', 'building_quality',
  'lot_square_feet', 'lot_acreage', 'zoning', 'land_use', 'county_land_use_code', 'property_use', 'flood_zone', 'subdivision_name',
  'is_land', 'is_vacant_land', 'is_raw_land', 'is_development_land', 'is_infill_lot',
  'ownership_years', 'is_corporate_owner', 'out_of_state_owner', 'owner_type',
  'sale_date', 'sale_price', 'last_sale_doc_type', 'recording_date',
  'estimated_value', 'arv_estimate', 'estimated_repair_cost', 'equity_amount', 'equity_percent', 'total_loan_balance',
  'tax_amt', 'tax_year', 'tax_delinquent', 'tax_delinquent_year', 'active_lien', 'past_due_amount', 'assd_total_value', 'assd_land_value', 'assd_improvement_value', 'assd_year',
  'is_preforeclosure', 'is_hot_preforeclosure', 'foreclosure_stage', 'default_amount',
  'mls_market_status', 'mls_current_listing_price', 'mls_sold_date', 'mls_sold_price', 'market_status_label',
  'rent_estimate', 'updated_at',
])
export const DOSSIER_SALE_COLUMNS = Object.freeze(['property_id', 'event_date', 'event_date_kind', 'price', 'price_code', 'doc_type', 'is_arms_length', 'is_cash_purchase'])
export const DOSSIER_MORTGAGE_COLUMNS = Object.freeze(['property_id', 'recording_date', 'loan_amount', 'est_balance', 'loan_type', 'financing_type', 'lien_position', 'interest_rate', 'is_private_lender', 'due_date', 'term_months'])
export const DOSSIER_LIEN_COLUMNS = Object.freeze(['property_id', 'lien_type', 'doc_type', 'doc_category', 'transaction_type', 'amount_due', 'nod_default_amount', 'hoa_lien_amount', 'recording_date', 'filing_date', 'hoa_auction_date'])
export const DOSSIER_SCORE_COLUMNS = Object.freeze(['property_id', 'computed_at', 'decision_tier', 'valuation_low', 'valuation_mid', 'valuation_high', 'valuation_confidence', 'comp_count', 'investor_ceiling_low', 'investor_ceiling_mid', 'investor_ceiling_high', 'buyer_demand_score', 'liquidity_score', 'estimated_repairs', 'recommended_cash_offer', 'minimum_acceptable_offer', 'expected_assignment_fee', 'confidence', 'evidence'])

/** Keys never copied out of any input row (second net after the whitelists). */
const NEVER_KEY_RE = /(^|_)(name|names|firstname|lastname|phone|phones|e164|email|emails|mailing|owner_address|party_[12]|date_of_death|date_of_divorce|trustee|beneficiary|lender_name|borrower|ssn|dob)($|_)/i

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null }
const txt = (v) => { const s = String(v ?? '').trim(); return s ? s.slice(0, 160) : null }
const bool = (v) => (v === true || v === false ? v : v === 'true' ? true : v === 'false' ? false : null)
const iso = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? new Date(t).toISOString() : null }

/** Copy a row keeping only whitelisted keys that are not name / contact / protected shaped. */
export function projectRow(row, columns) {
  if (!row || typeof row !== 'object') return null
  const { value } = stripProtectedAttributes(row)
  const out = {}
  for (const c of columns) if (c in value && !NEVER_KEY_RE.test(c)) out[c] = value[c]
  return out
}

/**
 * @param {object} a
 * @param {object} a.property        properties row (any shape; projected through DOSSIER_PROPERTY_COLUMNS)
 * @param {object|null} [a.valuation] property_acquisition_scores row
 * @param {Array<object>} [a.sales]   seller.property_sale rows
 * @param {Array<object>} [a.mortgages] seller.property_mortgage rows
 * @param {Array<object>} [a.liens]   seller.property_lien rows
 * @param {object} [a.facts]          conversation-ai factSummary(ledger) for the thread
 * @param {object} [a.history]        { inbound_count, outbound_count, last_inbound_at, last_outbound_at, pipeline_stage, offers: [{ amount, at, kind }] }
 * @param {string} [a.property_as_of] when the properties row was last refreshed (else property.updated_at)
 * @param {number|string} [a.now]
 */
export function buildPropertyDossier(input = {}) {
  const { value: a, stripped } = stripProtectedAttributes(input || {})
  const nowMs = typeof a.now === 'number' ? a.now : Date.parse(a.now || '') || Date.now()
  const p = projectRow(a.property || {}, DOSSIER_PROPERTY_COLUMNS) || {}
  const v = a.valuation ? projectRow(a.valuation, DOSSIER_SCORE_COLUMNS) : null
  const sales = (a.sales || []).map((r) => projectRow(r, DOSSIER_SALE_COLUMNS)).filter(Boolean)
  const morts = (a.mortgages || []).map((r) => projectRow(r, DOSSIER_MORTGAGE_COLUMNS)).filter(Boolean)
  const liens = (a.liens || []).map((r) => projectRow(r, DOSSIER_LIEN_COLUMNS)).filter(Boolean)
  const facts = a.facts || {}
  const hist = a.history || {}
  const propAt = iso(a.property_as_of) || iso(p.updated_at)
  const P = (col, opts = {}) => ({ source: `public.properties.${col}`, as_of: propAt, confidence: 0.8, kind: 'recorded', ...opts })
  const vAt = iso(v?.computed_at)
  const V = (col, opts = {}) => ({ source: `public.property_acquisition_scores.${col}`, as_of: vAt, confidence: 0.75, kind: 'derived', ...opts })
  const S = (key, f) => ({ source: `seller:${f?.source_message_id ? `message.${String(f.source_message_id).slice(0, 40)}` : 'thread'}`, as_of: iso(f?.at) || null, confidence: f?.origin === 'model_extracted' ? 0.55 : 0.7, kind: f?.origin === 'record_derived' ? 'recorded' : f?.origin === 'model_extracted' ? 'inferred' : 'seller_stated' })
  const sf = (key) => { const f = facts?.[key]; return f && f.origin !== 'record_derived' ? f : null }

  const laneInfo = resolveEconomicsLane(p, v)
  const readiness = evaluateOfferReadiness(v, { now: nowMs })

  // ── identity ──
  const identity = {
    address: field(txt(p.property_address_full), P('property_address_full', { confidence: 0.9 })),
    city: field(txt(p.property_address_city), P('property_address_city', { confidence: 0.9 })),
    state: field(txt(p.property_address_state), P('property_address_state', { confidence: 0.95 })),
    zip: field(txt(p.property_address_zip), P('property_address_zip', { confidence: 0.9 })),
    county: field(txt(p.property_address_county_name), P('property_address_county_name', { confidence: 0.9 })),
    parcel: field(txt(p.apn_parcel_id), P('apn_parcel_id', { confidence: 0.85 })),
    market: field(txt(p.canonical_market_id) || txt(p.market), P(p.canonical_market_id ? 'canonical_market_id' : 'market', { confidence: 0.85 })),
    location: field(num(p.latitude) != null && num(p.longitude) != null ? { lat: num(p.latitude), lng: num(p.longitude) } : null, P('latitude', { confidence: 0.85 })),
  }

  // ── characteristics ──
  const characteristics = {
    property_type: field(txt(p.property_type), P('property_type')),
    asset_lane: field(laneInfo.lane === 'unknown' ? null : { lane: laneInfo.lane, asset_lane: laneInfo.asset_lane, family: laneInfo.family }, { source: 'engine:assetClassification.classifyAssetLane', as_of: propAt, confidence: Math.min(0.95, Math.max(0.2, num(laneInfo.confidence) ?? 0.6)), kind: 'derived' }),
    units: field(pos(p.units_count) ?? pos(p.multifamily_units), P(pos(p.units_count) ? 'units_count' : 'multifamily_units', { confidence: 0.7 })),
    beds: field(pos(p.total_bedrooms), P('total_bedrooms', { confidence: 0.75 })),
    baths: field(pos(p.total_baths), P('total_baths', { confidence: 0.75 })),
    building_sqft: field(pos(p.building_square_feet), P('building_square_feet', { confidence: 0.75 })),
    year_built: field(pos(p.year_built), P('year_built', { confidence: 0.8 })),
    effective_year_built: field(pos(p.effective_year_built), P('effective_year_built', { confidence: 0.6 })),
    stories: field(pos(p.stories), P('stories', { confidence: 0.6 })),
    construction: field(txt(p.construction_type), P('construction_type', { confidence: 0.6 })),
  }
  if (laneInfo.identity_conflict || laneInfo.conflicts.length) characteristics.asset_identity_conflict = field({ conflicts: laneInfo.conflicts, identity_conflict: laneInfo.identity_conflict }, { source: 'engine:assetClassification.classifyAssetLane', as_of: propAt, confidence: 0.8, kind: 'derived' })

  // ── lot / zoning / development ──
  const lotSqft = pos(p.lot_square_feet) ?? (pos(p.lot_acreage) ? Math.round(pos(p.lot_acreage) * 43_560) : null)
  const potential = inferPotentialUnits({ zoning: p.zoning, lot_sqft: lotSqft, units: p.units_count })
  const lot_zoning = {
    lot_sqft: field(lotSqft, P(pos(p.lot_square_feet) ? 'lot_square_feet' : 'lot_acreage', { confidence: 0.75 })),
    zoning: field(txt(p.zoning), P('zoning', { confidence: 0.65 })),
    land_use: field(txt(p.land_use) || txt(p.county_land_use_code), P(txt(p.land_use) ? 'land_use' : 'county_land_use_code', { confidence: 0.6 })),
    flood_zone: field(txt(p.flood_zone), P('flood_zone', { confidence: 0.6 })),
    subdivision: field(txt(p.subdivision_name), P('subdivision_name', { confidence: 0.7 })),
    development_flags: field([p.is_land && 'land', p.is_vacant_land && 'vacant_land', p.is_raw_land && 'raw_land', p.is_development_land && 'development_land', p.is_infill_lot && 'infill_lot'].filter(Boolean).length ? [p.is_land && 'land', p.is_vacant_land && 'vacant_land', p.is_raw_land && 'raw_land', p.is_development_land && 'development_land', p.is_infill_lot && 'infill_lot'].filter(Boolean) : null, P('is_development_land', { confidence: 0.6 })),
    potential_units: field(potential.value, { source: 'engine:property-research.inferPotentialUnits(zoning,lot)', as_of: propAt, confidence: potential.confidence, kind: 'inferred' }),
  }

  // ── condition: record vs seller-stated vs engine ──
  const sCond = sf('condition')
  const recCond = txt(p.building_condition)
  const condition = {
    record_condition: field(recCond, P('building_condition', { confidence: 0.5 })),
    record_repair_estimate: field(pos(p.estimated_repair_cost), P('estimated_repair_cost', { confidence: 0.4, kind: 'derived' })),
    engine_repair_estimate: field(num(v?.estimated_repairs), V('estimated_repairs', { confidence: 0.55 })),
    seller_stated_condition: field(sCond ? sCond.value : null, S('condition', sCond)),
  }
  if (sCond && recCond) {
    const sellerBad = /repair|fix|roof|foundation|needs work|tlc|damage|old|poor|bad|gut/i.test(JSON.stringify(sCond.value))
    const recordGood = /good|excellent|average/i.test(recCond)
    if (sellerBad && recordGood) condition.conflict = field('seller_reports_worse_than_record', { source: 'engine:property-research.dossier', as_of: iso(sCond.at) || propAt, confidence: 0.6, kind: 'derived' })
  }

  // ── ownership + recorded transactions ──
  const recorded = sales
    .filter((s) => iso(s.event_date))
    .sort((x, y) => Date.parse(y.event_date) - Date.parse(x.event_date))
    .slice(0, 12)
    .map((s) => ({ date: iso(s.event_date).slice(0, 10), price: pos(s.price), doc_type: txt(s.doc_type), arms_length: bool(s.is_arms_length), cash: bool(s.is_cash_purchase), price_code: txt(s.price_code) }))
  const lastSaleAt = recorded[0]?.date || null
  const ownership = {
    ownership_years: field(num(p.ownership_years), P('ownership_years', { confidence: 0.75 })),
    corporate_owner: field(bool(p.is_corporate_owner), P('is_corporate_owner', { confidence: 0.75 })),
    out_of_state_owner: field(bool(p.out_of_state_owner), P('out_of_state_owner', { confidence: 0.7 })),
    last_sale: field(pos(p.sale_price) || txt(p.sale_date) ? { date: txt(p.sale_date), price: pos(p.sale_price), doc_type: txt(p.last_sale_doc_type) } : null, P('sale_price', { confidence: 0.7 })),
    recorded_transactions: field(recorded.length ? recorded : null, { source: 'seller.property_sale', as_of: lastSaleAt, confidence: 0.85, kind: 'recorded' }),
  }

  // ── tax / liens / distress ──
  const lienRows = liens.map((l) => ({ type: txt(l.lien_type) || txt(l.doc_type) || txt(l.doc_category), amount: pos(l.amount_due) ?? pos(l.nod_default_amount) ?? pos(l.hoa_lien_amount), recorded: (iso(l.recording_date) || iso(l.filing_date) || '').slice(0, 10) || null }))
  const lienAt = lienRows.map((l) => l.recorded).filter(Boolean).sort().pop() || null
  const tax_liens = {
    tax_delinquent: field(bool(p.tax_delinquent), P('tax_delinquent', { confidence: 0.75 })),
    tax_delinquent_year: field(pos(p.tax_delinquent_year), P('tax_delinquent_year', { confidence: 0.7 })),
    annual_tax: field(pos(p.tax_amt), P('tax_amt', { confidence: 0.75 })),
    assessed_total: field(pos(p.assd_total_value), P('assd_total_value', { confidence: 0.8 })),
    active_lien_flag: field(bool(p.active_lien), P('active_lien', { confidence: 0.6 })),
    recorded_liens: field(lienRows.length ? { count: lienRows.length, total_known_amount: lienRows.reduce((s, l) => s + (l.amount || 0), 0) || null, items: lienRows.slice(0, 10) } : null, { source: 'seller.property_lien', as_of: lienAt, confidence: 0.7, kind: 'recorded' }),
    preforeclosure: field(p.is_preforeclosure === true || p.is_hot_preforeclosure === true ? { stage: txt(p.foreclosure_stage), default_amount: pos(p.default_amount) } : bool(p.is_preforeclosure) === false ? false : null, P('is_preforeclosure', { confidence: 0.6 })),
  }

  // ── mortgage / equity ──
  const mortRows = morts.map((m) => ({ recorded: (iso(m.recording_date) || '').slice(0, 10) || null, loan_amount: pos(m.loan_amount), est_balance: pos(m.est_balance), type: txt(m.loan_type) || txt(m.financing_type), position: num(m.lien_position), rate: num(m.interest_rate), private_lender: bool(m.is_private_lender) }))
  const mortAt = mortRows.map((m) => m.recorded).filter(Boolean).sort().pop() || null
  const mortgage = {
    total_loan_balance: field(num(p.total_loan_balance), P('total_loan_balance', { confidence: 0.55, kind: 'derived' })),
    equity_percent: field(num(p.equity_percent), P('equity_percent', { confidence: 0.5, kind: 'derived' })),
    recorded_mortgages: field(mortRows.length ? { count: mortRows.length, est_balance_sum: mortRows.reduce((s, m) => s + (m.est_balance || 0), 0) || null, items: mortRows.slice(0, 6) } : null, { source: 'seller.property_mortgage', as_of: mortAt, confidence: 0.65, kind: 'recorded' }),
  }

  // ── valuation evidence (the engine's; never recomputed here) ──
  const ocev = v?.evidence?.offer_calculation || {}
  const valuation = {
    engine_value_mid: field(pos(v?.valuation_mid), V('valuation_mid')),
    engine_value_range: field(pos(v?.valuation_low) && pos(v?.valuation_high) ? [pos(v.valuation_low), pos(v.valuation_high)] : null, V('valuation_low')),
    engine_confidence: field(num(v?.valuation_confidence), V('valuation_confidence', { confidence: 0.9 })),
    engine_comp_count: field(num(v?.comp_count), V('comp_count', { confidence: 0.9 })),
    decision_tier: field(txt(v?.decision_tier), V('decision_tier', { confidence: 0.9 })),
    investor_ceiling_mid: field(pos(v?.investor_ceiling_mid), V('investor_ceiling_mid', { confidence: 0.6 })),
    authoritative_mao: field(readiness.ready ? readiness.mao : null, { source: 'engine:offerReadiness.evaluateOfferReadiness(effective_authorized_ceiling)', as_of: vAt, confidence: readiness.ready ? 0.8 : 0, kind: 'derived' }),
    offer_readiness: field({ ready: readiness.ready, reason: readiness.reason }, { source: 'engine:offerReadiness.evaluateOfferReadiness', as_of: vAt || new Date(nowMs).toISOString(), confidence: 1, kind: 'derived' }),
    ceiling_basis: field(txt(ocev.ceiling_basis), V('evidence.offer_calculation.ceiling_basis', { confidence: 0.8 })),
    avm_estimate: field(pos(p.estimated_value), P('estimated_value', { confidence: 0.45, kind: 'derived' })),
    retail_arv_estimate: field(pos(p.arv_estimate), P('arv_estimate', { confidence: 0.4, kind: 'derived' })),
  }

  // ── listing status (a LISTING is never a sale) ──
  const listing = {
    mls_status: field(txt(p.mls_market_status) || txt(p.market_status_label), P(txt(p.mls_market_status) ? 'mls_market_status' : 'market_status_label', { confidence: 0.5 })),
    mls_list_price: field(pos(p.mls_current_listing_price), P('mls_current_listing_price', { confidence: 0.5 })),
    mls_last_sold: field(pos(p.mls_sold_price) ? { date: txt(p.mls_sold_date), price: pos(p.mls_sold_price) } : null, P('mls_sold_price', { confidence: 0.75 })),
  }

  // ── seller facts (seller_stated; never presented as record) ──
  const ask = sf('asking_price')
  const seller_facts = {
    asking_price: field(ask ? { amount: pos(ask.value?.amount), price_type: txt(ask.value?.price_type) } : null, S('asking_price', ask)),
    occupancy: field(sf('occupancy')?.value ?? null, S('occupancy', sf('occupancy'))),
    timeline: field(sf('timeline')?.value ?? null, S('timeline', sf('timeline'))),
    listing_status_stated: field(sf('listing_status')?.value ?? null, S('listing_status', sf('listing_status'))),
    motivation: field(sf('motivation')?.value ?? null, S('motivation', sf('motivation'))),
    identity_role: field(sf('identity_role')?.value ?? null, S('identity_role', sf('identity_role'))),
  }

  // ── internal history ──
  const histAt = iso(hist.last_inbound_at) || iso(hist.last_outbound_at) || null
  const history = {
    thread_activity: field(hist.inbound_count != null || hist.outbound_count != null ? { inbound: num(hist.inbound_count) ?? 0, outbound: num(hist.outbound_count) ?? 0, last_inbound_at: iso(hist.last_inbound_at), last_outbound_at: iso(hist.last_outbound_at) } : null, { source: 'public.message_events', as_of: histAt, confidence: 0.9, kind: 'recorded' }),
    pipeline_stage: field(txt(hist.pipeline_stage), { source: 'public.acquisition_opportunities.stage', as_of: histAt, confidence: 0.8, kind: 'recorded' }),
    prior_offers: field(Array.isArray(hist.offers) && hist.offers.length ? hist.offers.slice(0, 8).map((o) => ({ amount: pos(o.amount), at: iso(o.at), kind: txt(o.kind) })) : null, { source: 'public.seller_offers', as_of: (hist.offers || []).map((o) => iso(o.at)).filter(Boolean).sort().pop() || null, confidence: 0.9, kind: 'recorded' }),
  }

  const sections = { identity, characteristics, lot_zoning, condition, ownership, tax_liens, mortgage, valuation, listing, seller_facts, history }

  // ── gaps (what web / an operator should fill) + staleness ──
  const gaps = []
  if (listing.mls_status.value == null && seller_facts.listing_status_stated.value == null) gaps.push('listing_status')
  if (lot_zoning.zoning.value == null) gaps.push('zoning')
  if (characteristics.building_sqft.value == null && laneInfo.lane !== 'land') gaps.push('building_sqft')
  if (condition.seller_stated_condition.value == null && condition.record_condition.value == null) gaps.push('condition')
  if (laneInfo.lane === 'land' && lot_zoning.potential_units.value == null) gaps.push('entitled_density')
  if (lot_zoning.flood_zone.value == null) gaps.push('flood_exposure')
  const stale = []
  if (!v) stale.push('valuation_missing')
  else if (!readiness.ready) stale.push(`valuation_not_offer_ready:${readiness.reason}`)
  if (propAt && nowMs - Date.parse(propAt) > 180 * 864e5) stale.push('property_record_older_than_180d')

  const check = validateFieldMap(sections)
  return {
    version: DOSSIER_VERSION,
    provenance_version: PROVENANCE_VERSION,
    property_id: txt(p.property_id),
    built_at: new Date(nowMs).toISOString(),
    lane: laneInfo.lane,
    sections,
    gaps,
    stale,
    coverage: coverage(sections),
    contract: { ok: check.ok, violations: check.violations },
    ignored: { protected_attributes_stripped: stripped },
  }
}

/**
 * Merge public-web findings (listing status, list price, DOM, reductions, zoning /
 * permitting notes) as kind 'inferred' fields with the web source. Only items that
 * carry a server-observed citation url are merged; a web price is ALWAYS a listing.
 * @param {object} dossier
 * @param {Array<{ topic: string, value: any, url: string, retrieved_at?: string, confidence?: number }>} findings
 */
export function mergeWebFindings(dossier, findings = []) {
  const web = {}
  for (const f of findings || []) {
    if (!f?.url || !f?.topic) continue
    let host = null
    try { host = new URL(f.url).hostname.replace(/^www\./, '') } catch { continue }
    const key = String(f.topic).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40)
    if (web[key]) continue
    web[key] = field(f.value ?? null, { source: `web:${host}`, as_of: f.retrieved_at || null, confidence: Math.min(0.6, Number(f.confidence ?? 0.45)), kind: 'inferred' })
  }
  const sections = { ...dossier.sections, web }
  const check = validateFieldMap(sections)
  return { ...dossier, sections, gaps: dossier.gaps.filter((g) => !web[g]), coverage: coverage(sections), contract: { ok: check.ok, violations: check.violations } }
}
