/**
 * ENTITY NETWORK — one relationship network around a property, owner or person.
 *
 * The phone Entity Graph's hero is this payload: who controls a property, the
 * names it is held under (LLC / trust / estate), the people behind it, how to
 * reach them, where they get their mail, which OTHER owners are really the same
 * party (same household, same owner cluster, same mailing address), the
 * portfolio, the debt across it, and every recorded sale.
 *
 * Grounded in what production actually holds (measured 2026-09-27):
 *   - debt: loan balance (76k props), original amount, payment, active-lien flag,
 *     tax delinquency. Lender / lien position / foreclosure fields are EMPTY in
 *     prod, so they are not returned rather than rendered as blanks.
 *   - history: last sale on the property row + every sale in mv_map_sold_comps
 *     for that property_id (MLS, public record, investor purchases).
 *   - related owners: household_key (3,183 multi-owner households),
 *     owner_cluster_key (5,882 clusters), shared primary_owner_address (5,723).
 *
 * Legacy Podio-era acquisition fields (cash_offer, final_acquisition_score,
 * ai_score, structured_motivation_score, deal_strength_score) are never
 * selected, so they cannot reach the surface.
 *
 * Read-only. Every query is indexed; the network is capped at 60 properties.
 */
import { displayableCompanyName } from './buyer-name-privacy.js'
import { equityTruth, repairTruth } from './entity-graph-truth.js'
import { prospectsLinkedToProperties, resolvePropertyOwners } from './entity-graph-owner-link.js'
import { classifyRecordedDocument, isLienClass, recordedDocumentLabel, splitRecordedCategories } from './entity-graph-recorded-docs.js'
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { clean, enrichedPropertyType, formatReadablePhone, parseJsonArray } from './entity-graph-normalize.js'

const PORTFOLIO_CAP = 60
const RELATED_CAP = 12

const PROPERTY_SELECT = [
  'property_id', 'master_owner_id', 'property_address_full', 'property_address_city', 'property_address_state',
  'property_address_zip', 'property_zip', 'property_address_county_name', 'market', 'latitude', 'longitude',
  'property_type', 'asset_type_label', 'normalized_asset_class', 'asset_subclass', 'acquisition_bucket', 'style', 'units_count', 'total_bedrooms', 'total_baths',
  'building_square_feet', 'year_built', 'lot_acreage', 'estimated_value', 'equity_percent', 'equity_amount',
  'total_loan_balance', 'total_loan_amt', 'total_loan_payment', 'active_lien', 'tax_amt', 'tax_delinquent',
  'tax_delinquent_year', 'sale_date', 'sale_price', 'last_sale_doc_type', 'ownership_years', 'streetview_image',
  'owner_display_name', 'owner_name', 'owner_type_guess', 'is_corporate_owner', 'out_of_state_owner',
  'owner_address_full', 'owner_address_city', 'owner_address_state', 'owner_address_zip', 'owner_name_addr_key',
  'seller_tags_text', 'estimated_repair_cost', 'property_flags_text',
  // recorded documents (v_entity_graph_properties): equityTruth rule c reads the
  // recorded mortgages exactly as the grid does — without them the hover card
  // said "High (flag)" while the grid said "$111M · 100%" for the same property
  'rec_mortgage_count', 'rec_mortgage_balance', 'rec_lien_categories',
].join(',')
/** Same source as the browse grid (properties + property_record_summary), keyed reads only. */
const PROPERTY_SOURCE = 'v_entity_graph_properties'

const OWNER_SELECT = [
  'master_owner_id', 'display_name', 'owner_type_guess', 'primary_owner_address', 'household_key', 'owner_cluster_key',
  'markets_text', 'counties_text', 'best_language', 'best_channel', 'contactability_score', 'priority_tier',
  'portfolio_total_value', 'portfolio_total_equity', 'portfolio_total_loan_balance', 'portfolio_total_loan_payment',
  'portfolio_total_tax_amount', 'portfolio_total_units', 'property_count', 'tax_delinquent_count',
  'oldest_tax_delinquent_year', 'active_lien_count', 'seller_tags_text', 'last_sale_doc_type', 'max_ownership_years',
  'joined_property_ids_json', 'joined_prospect_ids_json',
].join(',')

const RELATED_OWNER_SELECT = 'master_owner_id, display_name, owner_type_guess, property_count, portfolio_total_value, primary_owner_address, household_key, owner_cluster_key'

const PERSON_SELECT = [
  'prospect_id', 'master_owner_id', 'full_name', 'first_name', 'language_preference', 'occupation_group',
  'est_household_income', 'net_asset_value', 'likely_owner', 'likely_renting', 'is_primary_prospect', 'rank_position',
  'source_slot', 'slot_label', 'contact_score_final', 'sms_eligible', 'best_phone', 'best_email',
  // Vendor contact-matching tags ("Likely Owner, Family", "Resident, Likely Renting", …):
  // shown verbatim as evidence; a missing tag is absence of evidence, never negative.
  'matching_flags',
].join(',')

const PHONE_SELECT = 'phone_id, canonical_e164, phone, phone_type, primary_prospect_id, canonical_prospect_id, activity_status, contact_score_final, sort_rank, wrong_number_at, phone_contact_status, usage_12_months'
const EMAIL_SELECT = 'email_id, email_normalized, email, primary_prospect_id, canonical_prospect_id, contact_score_final, sort_rank'
const ENTITY_SELECT = 'sub_owner_id, master_owner_id, owner_entity_id, owner_name, owner_address_full, owner_address_city, owner_address_state, owner_address_zip'

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const bool = (v) => v === true || ['true', 't', '1', 'yes', 'y'].includes(String(v ?? '').trim().toLowerCase())
const titleCase = (s) => clean(s).toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Llc|Lp|Llp|Inc|Ii|Iii|Iv|Po|Nw|Ne|Sw|Se)\b/g, (w) => w.toUpperCase())

/** What kind of holder a name is, from the name itself. */
export function classifyHolder(name, typeGuess = '') {
  const n = ` ${clean(name).toUpperCase().replace(/[.,]/g, ' ')} `
  const g = clean(typeGuess).toUpperCase()
  if (/\b(BANK|MORTGAGE|FEDERAL|NATIONAL ASSOC|SAVINGS|CREDIT UNION|HOUSING AUTHORITY|FANNIE|FREDDIE|HUD|SECRETARY OF)\b/.test(n) || g.includes('BANK')) return 'institution'
  if (/\b(TRUST|TRUSTEE|TRS|TR|REVOCABLE|LIVING TRUST)\b/.test(n)) return 'trust'
  if (/\b(ESTATE|EST|HEIRS|DECEASED)\b/.test(n) || g.includes('ESTATE')) return 'estate'
  if (/\b(LLC|L L C)\b/.test(n)) return 'llc'
  if (/\b(INC|CORP|CORPORATION|CO|COMPANY|LP|LLP|LTD|HOLDINGS|PROPERTIES|INVESTMENTS|GROUP|PARTNERS|VENTURES|CAPITAL|REALTY|ENTERPRISES|ASSOCIATES|MANAGEMENT|FUND|HOMES|RENTALS)\b/.test(n)) return 'company'
  if (g.includes('LLC') || g.includes('CORP')) return 'company'
  if (g.includes('TRUST')) return 'trust'
  return 'individual'
}

function mapProperty(p) {
  const value = num(p.estimated_value)
  const balance = num(p.total_loan_balance)
  return {
    id: String(p.property_id),
    ownerId: p.master_owner_id ? String(p.master_owner_id) : null,
    address: titleCase(p.property_address_full) || 'Address unknown',
    city: titleCase(p.property_address_city),
    state: clean(p.property_address_state).toUpperCase(),
    zip: clean(p.property_address_zip || p.property_zip).slice(0, 5),
    county: titleCase(p.property_address_county_name),
    market: clean(p.market),
    lat: num(p.latitude),
    lng: num(p.longitude),
    type: enrichedPropertyType(p, clean(p.asset_type_label || p.property_type || p.normalized_asset_class) || null) || '',
    units: num(p.units_count),
    beds: num(p.total_bedrooms),
    baths: num(p.total_baths),
    sqft: num(p.building_square_feet),
    yearBuilt: num(p.year_built),
    lotAcres: num(p.lot_acreage),
    value,
    // equity_known_v1 (entity-graph-truth.js): no loan on file is UNKNOWN, not 100%.
    equityPct: equityOf(p).known ? equityOf(p).percent : null,
    equity: equityOf(p).known ? equityOf(p).amount : null,
    equityClass: equityOf(p).class,
    equityRule: equityOf(p).rule,
    loanBalance: balance,
    loanAmount: num(p.total_loan_amt),
    loanPayment: num(p.total_loan_payment),
    ltv: value && balance != null ? Math.round((balance / value) * 1000) / 10 : null,
    freeAndClear: equityOf(p).rule === 'free_and_clear',
    activeLien: bool(p.active_lien),
    taxAmount: num(p.tax_amt),
    taxDelinquent: bool(p.tax_delinquent),
    taxDelinquentYear: num(p.tax_delinquent_year),
    lastSale: p.sale_date || num(p.sale_price)
      ? { date: p.sale_date || null, price: num(p.sale_price), docType: clean(p.last_sale_doc_type) || null }
      : null,
    ownershipYears: num(p.ownership_years),
    // NOT a property figure (valuation lanes): a plausible SFR / 2–4 vendor repair
    // figure is only an MLS-ARV-lane reference, "vendor estimate · unverified"
    repairReference: (() => { const t = repairTruth(p); return t.value === null ? null : { value: t.value, lane: t.lane, label: t.label } })(),
    // which recorded documents on this property are liens vs other filings (portfolio rows too)
    recordedLiens: splitRecordedCategories(p.rec_lien_categories).liens.map((d) => d.label),
    recordedFilings: splitRecordedCategories(p.rec_lien_categories).filings.map((d) => d.label),
    streetview: clean(p.streetview_image) || null,
    // vendor property flags + seller tags, deduplicated (the client maps them to one signal vocabulary)
    tags: [...new Set([...clean(p.property_flags_text).split(/[;|]/), ...clean(p.seller_tags_text).split(/[,|;]/)].map((t) => t.trim()).filter(Boolean))].slice(0, 16),
    outOfStateOwner: bool(p.out_of_state_owner),
    corporateOwner: bool(p.is_corporate_owner),
  }
}

function debtSummary(properties) {
  let value = 0, equity = 0, balance = 0, payment = 0, withDebt = 0, freeClear = 0, liens = 0, delinquent = 0, valued = 0, equityKnown = 0
  for (const p of properties) {
    if (p.value) { value += p.value; valued += 1 }
    if (p.equity !== null && p.equity !== undefined) { equity += p.equity; equityKnown += 1 }
    if (p.loanBalance) { balance += p.loanBalance; withDebt += 1 }
    if (p.loanPayment) payment += p.loanPayment
    if (p.freeAndClear) freeClear += 1
    if (p.activeLien) liens += 1
    if (p.taxDelinquent) delinquent += 1
  }
  return {
    properties: properties.length,
    totalValue: value || null,
    // Known equity only, and how many properties it covers — never value − 0.
    totalEquity: equityKnown ? equity : null,
    equityKnown,
    totalLoanBalance: balance,
    monthlyPayment: payment || null,
    withDebt,
    freeAndClear: freeClear,
    activeLiens: liens,
    taxDelinquent: delinquent,
    blendedLtv: value && valued ? Math.round((balance / value) * 1000) / 10 : null,
  }
}

async function loadOwner(supabase, ownerId) {
  if (!ownerId) return null
  const { data } = await supabase.from('master_owners').select(OWNER_SELECT).eq('master_owner_id', ownerId).maybeSingle()
  return data || null
}

async function loadRelatedOwners(supabase, owner) {
  if (!owner) return []
  const jobs = []
  if (owner.household_key) jobs.push(['household', supabase.from('master_owners').select(RELATED_OWNER_SELECT).eq('household_key', owner.household_key).neq('master_owner_id', owner.master_owner_id).limit(RELATED_CAP)])
  if (owner.owner_cluster_key) jobs.push(['cluster', supabase.from('master_owners').select(RELATED_OWNER_SELECT).eq('owner_cluster_key', owner.owner_cluster_key).neq('master_owner_id', owner.master_owner_id).limit(RELATED_CAP)])
  if (clean(owner.primary_owner_address)) jobs.push(['mailing', supabase.from('master_owners').select(RELATED_OWNER_SELECT).eq('primary_owner_address', owner.primary_owner_address).neq('master_owner_id', owner.master_owner_id).limit(RELATED_CAP)])
  const results = await Promise.all(jobs.map(([, q]) => q))
  const byId = new Map()
  results.forEach(({ data }, i) => {
    const reason = jobs[i][0]
    for (const r of data || []) {
      const id = String(r.master_owner_id)
      const cur = byId.get(id)
      if (cur) { if (!cur.reasons.includes(reason)) cur.reasons.push(reason); continue }
      byId.set(id, {
        id,
        name: titleCase(r.display_name) || 'Owner',
        kind: classifyHolder(r.display_name, r.owner_type_guess),
        propertyCount: num(r.property_count) || 0,
        value: num(r.portfolio_total_value),
        mailing: titleCase(r.primary_owner_address) || null,
        reasons: [reason],
      })
    }
  })
  return [...byId.values()]
    .sort((a, b) => b.reasons.length - a.reasons.length || b.propertyCount - a.propertyCount)
    .slice(0, RELATED_CAP)
}

async function loadHistory(supabase, propertyIds, propertiesById) {
  if (!propertyIds.length) return []
  const { data } = await supabase
    .from('mv_map_sold_comps')
    .select('comp_id, property_id, source, sold_on, price, buyer, buyer_class, per_door, portfolio_size')
    .in('property_id', propertyIds.slice(0, PORTFOLIO_CAP))
    .order('sold_on', { ascending: false })
    .limit(120)
  const events = []
  const seen = new Set()
  for (const r of data || []) {
    const key = `${r.property_id}|${r.sold_on}|${Math.round(num(r.price) || 0)}`
    if (seen.has(key)) continue
    seen.add(key)
    const prop = propertiesById.get(String(r.property_id))
    events.push({
      id: String(r.comp_id),
      propertyId: String(r.property_id),
      address: prop?.address ?? null,
      date: r.sold_on,
      price: num(r.price),
      perDoor: num(r.per_door),
      source: clean(r.source) || null,
      buyer: titleCase(r.buyer) || null,
      buyerClass: clean(r.buyer_class) || null,
      portfolioSale: (num(r.portfolio_size) || 0) > 1,
    })
  }
  // The recorded last sale on each property, when the comp record does not already carry it.
  for (const p of propertiesById.values()) {
    if (!p.lastSale?.date) continue
    const d = String(p.lastSale.date).slice(0, 10)
    if (events.some((e) => e.propertyId === p.id && String(e.date).slice(0, 10) === d)) continue
    events.push({ id: `last:${p.id}`, propertyId: p.id, address: p.address, date: p.lastSale.date, price: p.lastSale.price, perDoor: null, source: 'deed', buyer: null, buyerClass: null, docType: p.lastSale.docType, portfolioSale: false })
  }
  return events.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 80)
}

async function loadOutreach(supabase, { ownerId, propertyIds }) {
  const select = 'thread_key, property_id, master_owner_id, prospect_id, latest_message_at, latest_message_body, status, stage, seller_stage, is_hot_lead, last_intent, next_action'
  let q = supabase.from('inbox_thread_state').select(select).order('latest_message_at', { ascending: false, nullsFirst: false }).limit(12)
  if (ownerId) q = q.eq('master_owner_id', ownerId)
  else if (propertyIds.length) q = q.in('property_id', propertyIds.slice(0, 30))
  else return { threads: [], lastSend: null }
  const sendQ = propertyIds.length
    ? supabase.from('send_queue').select('queue_status, created_at, property_id').in('property_id', propertyIds.slice(0, 30)).order('created_at', { ascending: false }).limit(1)
    : Promise.resolve({ data: [] })
  const [{ data: threads }, { data: sends }] = await Promise.all([q, sendQ])
  return {
    threads: (threads || []).map((t) => ({
      threadKey: t.thread_key,
      propertyId: t.property_id ? String(t.property_id) : null,
      personId: t.prospect_id ? String(t.prospect_id) : null,
      at: t.latest_message_at,
      preview: clean(t.latest_message_body).slice(0, 140) || null,
      stage: clean(t.seller_stage || t.stage) || null,
      hot: t.is_hot_lead === true,
      intent: clean(t.last_intent) || null,
      nextAction: clean(t.next_action) || null,
    })),
    lastSend: sends?.[0] ? { status: sends[0].queue_status, at: sends[0].created_at, propertyId: String(sends[0].property_id) } : null,
  }
}

/** Same normalisation as public.eg_name_key — the buyer alias join key. */
export function nameKey(value) {
  const key = clean(value).replace(/[^A-Za-z0-9]+/g, ' ').trim().toUpperCase()
  return key || null
}

// every recorded non-mortgage document, classified (entity-graph-recorded-docs.js):
// only the lien / judgment classes are liens — a UCC financing statement is not
const lienLabel = (l) => (clean(l.doc_category) || l.lien_type === 'hoa_lien' ? recordedDocumentLabel(l.doc_category, l.lien_type) : titleCase(l.doc_type_description) || 'Recorded document')
const DISTRESS_CATEGORIES = new Set(['PROBATE', 'LIS PENDENS', 'AFFIDAVIT OF DEATH', 'JUDGMENT', 'STATE TAX LIEN', 'MECHANICS LIEN'])

/**
 * The anchor property's recorded documents, shaped for the graph + sheet.
 * Only the ANCHOR property is expanded (bounded): a 60-property portfolio does
 * not fan out into hundreds of mortgage nodes.
 */
export function shapeRecords(raw) {
  if (!raw) return null
  const mortgages = (raw.mortgages || []).map((m) => ({
    slot: m.slot,
    open: String(m.slot || '').startsWith('mtg'),
    position: num(m.lien_position),
    lender: titleCase(m.lender_name) || null,
    amount: num(m.loan_amount),
    balance: num(m.est_balance),
    payment: num(m.est_payment),
    rate: num(m.interest_rate),
    loanType: clean(m.loan_type) || null,
    financing: clean(m.financing_type) || null,
    recorded: m.recording_date || null,
    due: m.due_date || null,
    termMonths: num(m.term_months),
    privateLender: m.is_private_lender === true,
  }))
  const liens = (raw.liens || []).map((l, i) => ({
    id: `${i}`,
    label: lienLabel(l),
    category: clean(l.doc_category) || null,
    docClass: classifyRecordedDocument(l.doc_category, l.lien_type),
    isLien: isLienClass(classifyRecordedDocument(l.doc_category, l.lien_type)),
    type: clean(l.lien_type) || null,
    title: titleCase(l.doc_title) || null,
    description: titleCase(l.doc_type_description) || null,
    amountDue: num(l.amount_due ?? l.hoa_lien_amount),
    recorded: l.recording_date || l.filing_date || l.nod_recording_date || l.date_updated || null,
    party1: titleCase(l.party_1_name) || null,
    party2: titleCase(l.party_2_name) || null,
    hoaName: titleCase(l.hoa_lien_name) || null,
    defaultAmount: num(l.nod_default_amount),
    dateOfDeath: l.date_of_death || null,
    taxPeriod: l.tax_period_begin ? [l.tax_period_begin, l.tax_period_end] : null,
    county: titleCase(l.county) || null,
    distress: DISTRESS_CATEGORIES.has(clean(l.doc_category)) || Boolean(l.nod_recording_date),
  }))
  const party = (ref) => (ref ? {
    id: ref.buyer_id,
    name: ref.name || (ref.entity_type === 'person' ? 'Individual buyer' : null),
    kind: ref.entity_type || null,
    basis: ref.basis || null,
    method: ref.method || null,
    confidence: num(ref.confidence),
    purchases: num(ref.acquisition_count),
    sold: num(ref.sold_count),
    status: ref.activity_status || null,
    archetype: ref.archetype || null,
  } : null)
  const sales = (raw.sales || []).map((s, i) => ({
    id: s.canonical_transaction_id ? String(s.canonical_transaction_id) : `sale-${i}`,
    date: s.event_date || null,
    price: num(s.price),
    docType: clean(s.doc_type) || null,
    buyerName: titleCase(s.buyer_1_name) || null,
    buyer2Name: titleCase(s.buyer_2_name) || null,
    sellerName: titleCase(s.seller_1_name) || null,
    seller2Name: titleCase(s.seller_2_name) || null,
    cash: s.is_cash_purchase ?? null,
    armsLength: s.is_arms_length ?? (/non-arms/i.test(clean(s.price_code)) ? false : null),
    priceNote: clean(s.price_code) || null,
    lender: titleCase(s.concurrent_lender) || null,
    loanAmount: num(s.concurrent_loan_amount),
    current: s.slot === 'current',
    buyer: party(s.buyer),
    seller: party(s.seller_entity),
  }))
  const foreclosures = (raw.foreclosures || []).map((f) => ({
    stage: clean(f.doc_type) || null,
    recorded: f.recording_date || null,
    defaultDate: f.default_date || null,
    auctionDate: f.auction_date || null,
    auctionTime: clean(f.auction_time) || null,
    auctionLocation: titleCase(f.auction_location || f.auction_city) || null,
    caseNumber: clean(f.case_number) || null,
    unpaidBalance: num(f.unpaid_balance),
    minBid: num(f.min_bid_amount),
    lender: titleCase(f.current_lender || f.original_lender) || null,
    originalLoan: num(f.original_loan_amount),
    trustee: titleCase(f.trustee_name) || null,
    trusteePhone: clean(f.trustee_phone) || null,
    borrower: titleCase(f.borrower_1_name) || null,
  }))
  const open = mortgages.filter((m) => m.open)
  return {
    mortgages,
    liens,
    sales,
    foreclosures,
    ownerBuyer: party(raw.owner_buyer),
    parcel: raw.parcel || null,
    totals: {
      openMortgages: open.length,
      balance: open.reduce((sum, m) => sum + (m.balance || 0), 0) || null,
      payment: open.reduce((sum, m) => sum + (m.payment || 0), 0) || null,
      // true liens only (lien + judgment classes); every other recorded filing counted apart
      liens: liens.filter((l) => l.isLien).length,
      filings: liens.filter((l) => !l.isLien).length,
      distressLiens: liens.filter((l) => l.distress).length,
      sales: sales.length,
    },
  }
}

function buildGraph({ anchor, owner, ownerNode, properties, entities, people, phones, emails, mailing, related, outreach, records, anchorPropertyId }) {
  const nodes = []
  const edges = []
  const ids = new Set()
  const node = (n) => { if (!ids.has(n.id)) { ids.add(n.id); nodes.push(n) } }
  const edge = (from, to, kind, label) => { if (ids.has(from) && ids.has(to) && from !== to) edges.push({ from, to, kind, label }) }

  const ownerId = ownerNode?.id ?? null
  if (ownerNode) node(ownerNode)

  for (const p of properties) {
    node({
      id: `property:${p.id}`, type: 'property', label: p.address, sub: [p.city, p.state].filter(Boolean).join(', '),
      meta: { value: p.value, equityPct: p.equityPct, loanBalance: p.loanBalance, activeLien: p.activeLien, taxDelinquent: p.taxDelinquent, type: p.type, units: p.units, hot: outreach.threads.some((t) => t.propertyId === p.id && t.hot), conversation: outreach.threads.some((t) => t.propertyId === p.id) },
    })
    if (ownerId) edge(ownerId, `property:${p.id}`, 'owns', 'Owns')
  }
  for (const e of entities) {
    node({ id: `entity:${e.id}`, type: 'entity', label: e.name, sub: e.kindLabel, meta: { kind: e.kind, mailing: e.mailing, ownerId: owner?.master_owner_id ? String(owner.master_owner_id) : null } })
    if (ownerId) edge(ownerId, `entity:${e.id}`, 'titled_as', 'Holds title as')
  }
  for (const person of people) {
    node({ id: `person:${person.id}`, type: 'person', label: person.name, sub: person.role, meta: { primary: person.primary, language: person.language, linkedBy: person.linkedBy } })
    if (person.linkedBy === 'property' && anchorPropertyId) edge(`property:${anchorPropertyId}`, `person:${person.id}`, 'linked_person', 'Linked to this property')
    else if (ownerId) edge(ownerId, `person:${person.id}`, 'person_of', person.primary ? 'Decision maker' : 'Linked person')
  }
  for (const ph of phones) {
    node({ id: `phone:${ph.id}`, type: 'phone', label: ph.display, sub: ph.type, meta: { wrong: ph.wrongNumber, score: ph.score, personId: ph.personId, ownerId: owner?.master_owner_id ? String(owner.master_owner_id) : null } })
    const from = ph.personId && ids.has(`person:${ph.personId}`) ? `person:${ph.personId}` : ownerId
    if (from) edge(from, `phone:${ph.id}`, 'reaches', 'Reached at')
  }
  for (const em of emails) {
    node({ id: `email:${em.id}`, type: 'email', label: em.value, sub: 'Email', meta: { personId: em.personId, ownerId: owner?.master_owner_id ? String(owner.master_owner_id) : null } })
    const from = em.personId && ids.has(`person:${em.personId}`) ? `person:${em.personId}` : ownerId
    if (from) edge(from, `email:${em.id}`, 'reaches', 'Reached at')
  }
  if (mailing?.address) {
    node({ id: 'mailing:owner', type: 'mailing', label: mailing.address, sub: [mailing.city, mailing.state].filter(Boolean).join(', ') || 'Mailing address', meta: { outOfState: mailing.outOfState } })
    if (ownerId) edge(ownerId, 'mailing:owner', 'mails_to', 'Mail goes to')
  }
  for (const r of related) {
    node({ id: `related:${r.id}`, type: 'related_owner', label: r.name, sub: `${r.propertyCount} ${r.propertyCount === 1 ? 'property' : 'properties'}`, meta: { reasons: r.reasons, kind: r.kind, value: r.value } })
    const via = r.reasons.includes('mailing') && ids.has('mailing:owner') ? 'mailing:owner' : ownerId
    if (via) edge(via, `related:${r.id}`, r.reasons[0], r.reasons.includes('household') ? 'Same household' : r.reasons.includes('cluster') ? 'Same owner cluster' : 'Same mailing address')
  }
  // Recorded documents hang off the anchor property. The client discloses them
  // progressively (debt / liens / history layers); they are never auto-fanned
  // across the whole portfolio.
  const anchorProp = anchorPropertyId ? `property:${anchorPropertyId}` : null
  if (records && anchorProp && ids.has(anchorProp)) {
    const lenders = new Map()
    for (const m of records.mortgages.filter((row) => row.open)) {
      const id = `mortgage:${m.slot}`
      node({ id, type: 'mortgage', label: m.lender || 'Mortgage', sub: [m.position ? `${m.position === 1 ? '1st' : m.position === 2 ? '2nd' : `${m.position}th`} position` : null, m.rate ? `${m.rate}%` : null].filter(Boolean).join(' · '), meta: { balance: m.balance, amount: m.amount, rate: m.rate, privateLender: m.privateLender, loanType: m.loanType } })
      edge(anchorProp, id, 'financed_by', 'Financed by')
      if (m.lender) lenders.set(m.lender, (lenders.get(m.lender) || 0) + 1)
    }
    const liens = records.liens.slice(0, 6)
    for (const l of liens) {
      const id = `lien:${l.id}`
      node({ id, type: 'lien', label: l.label, sub: [l.recorded ? String(l.recorded).slice(0, 4) : null, l.amountDue ? `$${Math.round(l.amountDue).toLocaleString()}` : null].filter(Boolean).join(' · '), meta: { distress: l.distress, category: l.category } })
      edge(anchorProp, id, 'encumbered_by', 'Recorded against')
    }
    for (const sale of records.sales.slice(0, 4)) {
      const id = `sale:${sale.id}`
      node({ id, type: 'sale', label: sale.price ? `$${sale.price >= 1e6 ? `${(sale.price / 1e6).toFixed(sale.price >= 1e7 ? 0 : 1)}M` : `${Math.round(sale.price / 1e3)}K`}` : 'Transfer', sub: [sale.date ? String(sale.date).slice(0, 4) : null, sale.docType].filter(Boolean).join(' · '), meta: { date: sale.date, price: sale.price, current: sale.current, cash: sale.cash } })
      edge(anchorProp, id, 'sold', sale.current ? 'Last sale' : 'Prior sale')
      // Identity, not role: when the buyer on a sale IS the current owner, the
      // sale points at the owner node rather than minting a duplicate.
      const ownerBuyerId = ownerNode?.meta?.buyerRole?.id
      if (sale.buyer?.id && ownerId && sale.buyer.id === ownerBuyerId) {
        edge(id, ownerId, 'purchased_by', 'Bought by (current owner)')
      } else if (sale.buyer?.id) {
        const bid = `buyer:${sale.buyer.id}`
        node({ id: bid, type: 'buyer', label: sale.buyer.name || sale.buyerName || 'Buyer', sub: sale.buyer.purchases ? `${sale.buyer.purchases} purchase${sale.buyer.purchases === 1 ? '' : 's'}` : 'Buyer', meta: { buyerId: sale.buyer.id, basis: sale.buyer.basis, confidence: sale.buyer.confidence, status: sale.buyer.status, kind: sale.buyer.kind } })
        edge(id, bid, 'purchased_by', 'Bought by')
      }
      if (sale.seller?.id && ownerId && sale.seller.id === ownerBuyerId) {
        edge(ownerId, id, 'sold_by', 'Sold by (this owner)')
      } else if (sale.seller?.id) {
        const sid = `buyer:${sale.seller.id}`
        node({ id: sid, type: 'buyer', label: sale.seller.name || sale.sellerName || 'Seller', sub: sale.seller.purchases ? `${sale.seller.purchases} purchase${sale.seller.purchases === 1 ? '' : 's'}` : 'Seller', meta: { buyerId: sale.seller.id, basis: sale.seller.basis, status: sale.seller.status, kind: sale.seller.kind, role: 'seller' } })
        edge(sid, id, 'sold_by', 'Sold by')
      }
    }
    for (const f of records.foreclosures.slice(0, 2)) {
      const id = `lien:fc-${f.recorded || f.auctionDate || 'x'}`
      node({ id, type: 'lien', label: f.stage || 'Foreclosure', sub: f.auctionDate ? `Auction ${f.auctionDate}` : (f.recorded ? String(f.recorded).slice(0, 10) : ''), meta: { distress: true, foreclosure: true } })
      edge(anchorProp, id, 'encumbered_by', 'Foreclosure')
    }
  }

  for (const t of outreach.threads.slice(0, 6)) {
    node({ id: `thread:${t.threadKey}`, type: 'conversation', label: t.stage ? t.stage.replace(/_/g, ' ') : 'Conversation', sub: t.preview ?? '', meta: { hot: t.hot, at: t.at, threadKey: t.threadKey } })
    const to = t.personId && ids.has(`person:${t.personId}`) ? `person:${t.personId}` : t.propertyId && ids.has(`property:${t.propertyId}`) ? `property:${t.propertyId}` : ownerId
    if (to) edge(`thread:${t.threadKey}`, to, 'conversation', 'In conversation')
  }
  return { anchorId: anchor, nodes, edges }
}

const equityMemo = new WeakMap()
function equityOf(row) {
  let e = equityMemo.get(row)
  if (!e) { e = equityTruth(row); equityMemo.set(row, e) }
  return e
}

const KIND_LABEL = { llc: 'LLC', company: 'Company', trust: 'Trust', estate: 'Estate', institution: 'Institution', individual: 'Name on title' }

/**
 * @param {'property'|'owner'|'person'} type
 */
export async function getEntityNetwork(type, id, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const key = clean(id)
  if (!key) return null

  let anchorProperty = null
  let ownerRow = null
  let anchorPersonId = null
  let personLinkedPropertyIds = []

  if (type === 'property') {
    const { data } = await supabase.from(PROPERTY_SOURCE).select(PROPERTY_SELECT).eq('property_id', key).maybeSingle()
    if (!data) return null
    anchorProperty = data
    // properties.master_owner_id is set on ~23% of properties — the rest are
    // linked through their prospects (entity-graph-owner-link.js), so the
    // inspector no longer draws an owner-less, people-less network for them
    let ownerId = clean(data.master_owner_id)
    if (!ownerId) {
      try {
        const resolved = await resolvePropertyOwners(supabase, [data])
        ownerId = resolved.get(String(data.property_id))?.ownerId || ''
      } catch { ownerId = '' }
    }
    ownerRow = await loadOwner(supabase, ownerId || null)
  } else if (type === 'owner') {
    ownerRow = await loadOwner(supabase, key)
    if (!ownerRow) return null
  } else if (type === 'person') {
    const { data } = await supabase.from('prospects').select('prospect_id, master_owner_id, linked_property_ids_json').eq('prospect_id', key).maybeSingle()
    if (!data) return null
    anchorPersonId = String(data.prospect_id)
    // person → properties: the properties this person is linked to, not only the owner's portfolio
    personLinkedPropertyIds = parseJsonArray(data.linked_property_ids_json).map(String).filter(Boolean).slice(0, PORTFOLIO_CAP)
    let ownerId = clean(data.master_owner_id)
    if (!ownerId && personLinkedPropertyIds.length) {
      try {
        const { data: linkedProps } = await supabase.from('properties').select('property_id, master_owner_id').in('property_id', personLinkedPropertyIds.slice(0, 12))
        ownerId = [...new Set((linkedProps || []).map((r) => clean(r.master_owner_id)).filter(Boolean))].length === 1 ? clean(linkedProps.find((r) => clean(r.master_owner_id)).master_owner_id) : ''
      } catch { ownerId = '' }
    }
    ownerRow = await loadOwner(supabase, ownerId || null)
  } else {
    return null
  }

  const ownerId = ownerRow ? String(ownerRow.master_owner_id) : null
  const joinedPropertyIds = ownerRow ? parseJsonArray(ownerRow.joined_property_ids_json).map(String) : []

  // Wave 1: portfolio, title entities, people, contact points, related owners.
  /**
   * joined_property_ids_json is not one id space: 8,055 of 102,252 owners
   * (measured 2026-10-07) carry property_EXPORT ids ("prop_875d…"), which
   * never match properties.property_id — their networks drew no properties
   * at all (Chandler Stonebridge LP: 1 property, 392 units, $111M, an empty
   * portfolio). Real property ids are read by id; when any export-form id is
   * present the portfolio is also read by properties.master_owner_id (indexed)
   * and the two are merged, rather than scanning the unindexed export column.
   */
  const exportFormJoined = joinedPropertyIds.some((pid) => /^prop_[a-f0-9]{8,}$/i.test(pid))
  const portfolioQuery = ownerId
    ? (joinedPropertyIds.length && !exportFormJoined
      ? supabase.from(PROPERTY_SOURCE).select(PROPERTY_SELECT).in('property_id', joinedPropertyIds.slice(0, PORTFOLIO_CAP))
      : Promise.all([
        joinedPropertyIds.length ? supabase.from(PROPERTY_SOURCE).select(PROPERTY_SELECT).in('property_id', joinedPropertyIds.slice(0, PORTFOLIO_CAP)) : Promise.resolve({ data: [] }),
        supabase.from(PROPERTY_SOURCE).select(PROPERTY_SELECT).eq('master_owner_id', ownerId).limit(PORTFOLIO_CAP),
      ]).then(([byId, byOwner]) => {
        const seen = new Set()
        const data = [...(byId.data || []), ...(byOwner.data || [])].filter((row) => {
          const key = String(row.property_id)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        return { data: data.slice(0, PORTFOLIO_CAP), error: byId.error || byOwner.error || null }
      }))
    : clean(anchorProperty?.owner_name_addr_key)
      // No master owner: the same name-at-the-same-mailing-address on other title records.
      ? supabase.from(PROPERTY_SOURCE).select(PROPERTY_SELECT).eq('owner_name_addr_key', anchorProperty.owner_name_addr_key).limit(PORTFOLIO_CAP)
      : Promise.resolve({ data: anchorProperty ? [anchorProperty] : [] })

  const [
    { data: portfolioRows },
    { data: entityRows },
    { data: personRows },
    { data: phoneRows },
    { data: emailRows },
    related,
  ] = await Promise.all([
    portfolioQuery,
    ownerId ? supabase.from('sub_owners').select(ENTITY_SELECT).eq('master_owner_id', ownerId).limit(24) : Promise.resolve({ data: [] }),
    ownerId ? supabase.from('prospects').select(PERSON_SELECT).eq('master_owner_id', ownerId).order('rank_position', { ascending: true, nullsFirst: false }).limit(12) : Promise.resolve({ data: [] }),
    ownerId ? supabase.from('phones').select(PHONE_SELECT).eq('master_owner_id', ownerId).order('sort_rank').limit(10) : Promise.resolve({ data: [] }),
    ownerId ? supabase.from('emails').select(EMAIL_SELECT).eq('master_owner_id', ownerId).order('sort_rank').limit(6) : Promise.resolve({ data: [] }),
    loadRelatedOwners(supabase, ownerRow),
  ])

  // property → people: prospects linked to the anchor property itself
  // (prospects.linked_property_ids_json — the contact-discovery linkage) join
  // the owner's people, so a property whose people sit under another / no
  // master owner no longer reads "People 0".
  const [linkedPeople, personProps] = await Promise.all([
    anchorProperty
      ? prospectsLinkedToProperties(supabase, [String(anchorProperty.property_id)], `${PERSON_SELECT}, phones_json`)
        .then((m) => m.get(String(anchorProperty.property_id)) || [])
        .catch(() => [])
      : Promise.resolve([]),
    personLinkedPropertyIds.length
      ? supabase.from(PROPERTY_SOURCE).select(PROPERTY_SELECT).in('property_id', personLinkedPropertyIds).then((r) => r.data || []).catch(() => [])
      : Promise.resolve([]),
  ])
  const personRowsAll = [...(personRows || [])]
  const extraPhoneRows = []
  for (const lp of linkedPeople) {
    if (personRowsAll.some((r) => String(r.prospect_id) === String(lp.prospect_id))) continue
    personRowsAll.push(lp)
    const known = new Set((phoneRows || []).map((r) => clean(r.canonical_e164)))
    ;(Array.isArray(lp.phones_json) ? lp.phones_json : []).forEach((ph, i) => {
      const e164 = clean(ph?.canonical_e164 || ph?.phone_raw)
      if (!e164 || known.has(e164)) return
      known.add(e164)
      extraPhoneRows.push({ phone_id: `pj:${lp.prospect_id}:${i}`, canonical_e164: e164, phone_type: ph.phone_type, primary_prospect_id: lp.prospect_id, activity_status: ph.activity_status || null, contact_score_final: ph.phone_score ?? null })
    })
  }

  const propertyRows = [...(portfolioRows || [])]
  for (const r of personProps) if (!propertyRows.some((x) => String(x.property_id) === String(r.property_id))) propertyRows.push(r)
  if (anchorProperty && !propertyRows.some((r) => String(r.property_id) === String(anchorProperty.property_id))) propertyRows.unshift(anchorProperty)
  const properties = propertyRows.map(mapProperty)
    .sort((a, b) => (anchorProperty && a.id === String(anchorProperty.property_id) ? -1 : 0) - (anchorProperty && b.id === String(anchorProperty.property_id) ? -1 : 0) || (b.value || 0) - (a.value || 0))
  const propertiesById = new Map(properties.map((p) => [p.id, p]))
  const propertyIds = properties.map((p) => p.id)

  // Wave 2: sale history + outreach across the network, the anchor property's
  // recorded documents, and whether the owner is a known buyer entity.
  const recordsFor = anchorProperty ? String(anchorProperty.property_id) : null
  const [history, outreach, recordsRaw, ownerBuyer] = await Promise.all([
    loadHistory(supabase, propertyIds, propertiesById),
    loadOutreach(supabase, { ownerId, propertyIds }),
    recordsFor && typeof supabase.rpc === 'function'
      ? Promise.resolve()
        .then(() => supabase.rpc('entity_graph_property_records', { p_property_id: recordsFor }))
        .then((r) => (r?.error ? null : r?.data ?? null))
        .catch(() => null)
      : Promise.resolve(null),
    loadOwnerBuyerRole(supabase, { propertyIds, ownerName: ownerRow?.display_name || anchorProperty?.owner_name }),
  ])
  const records = shapeRecords(recordsRaw)

  const ownerName = titleCase(ownerRow?.display_name || anchorProperty?.owner_display_name || anchorProperty?.owner_name) || 'Unknown owner'
  const ownerKind = classifyHolder(ownerRow?.display_name || anchorProperty?.owner_name, ownerRow?.owner_type_guess || anchorProperty?.owner_type_guess)
  const mailingSrc = ownerRow?.primary_owner_address || anchorProperty?.owner_address_full
  const mailing = clean(mailingSrc)
    ? {
      address: titleCase(mailingSrc),
      city: titleCase(anchorProperty?.owner_address_city),
      state: clean(anchorProperty?.owner_address_state).toUpperCase(),
      zip: clean(anchorProperty?.owner_address_zip).slice(0, 5),
      outOfState: anchorProperty ? bool(anchorProperty.out_of_state_owner) : properties.some((p) => p.outOfStateOwner),
    }
    : null

  const entities = (entityRows || [])
    .map((e) => {
      const kind = classifyHolder(e.owner_name)
      return { id: String(e.sub_owner_id), name: titleCase(e.owner_name) || 'Holder', kind, kindLabel: KIND_LABEL[kind], mailing: titleCase(e.owner_address_full) || null }
    })
    // The master owner's own name is the owner node, not a separate entity.
    .filter((e) => e.name.toLowerCase() !== ownerName.toLowerCase())

  const ownerPersonIds = new Set((personRows || []).map((r) => String(r.prospect_id)))
  const people = personRowsAll.map((r) => ({
    id: String(r.prospect_id),
    // how the person is connected: through the master owner, or linked to the property itself
    linkedBy: ownerPersonIds.has(String(r.prospect_id)) ? 'owner' : 'property',
    name: titleCase(r.full_name) || 'Unnamed person',
    // slot_label is often a technical source path ("phone_numbers[1]|…"): only a human label is shown.
    role: r.is_primary_prospect ? 'Decision maker' : (/^[A-Za-z][A-Za-z ,&'-]{1,40}$/.test(clean(r.slot_label)) ? clean(r.slot_label) : (r.likely_owner ? 'Likely owner' : ownerPersonIds.has(String(r.prospect_id)) ? 'Linked person' : 'Linked to this property')),
    primary: r.is_primary_prospect === true,
    language: clean(r.language_preference) || null,
    occupation: clean(r.occupation_group) || null,
    householdIncome: clean(r.est_household_income) || null,
    netAssets: clean(r.net_asset_value) || null,
    smsEligible: r.sms_eligible !== false,
    bestPhone: clean(r.best_phone) || null,
    bestEmail: clean(r.best_email) || null,
    matchingTags: clean(r.matching_flags).split(',').map((t) => t.trim()).filter(Boolean),
  }))

  const phones = [...(phoneRows || []), ...extraPhoneRows].map((r) => ({
    id: String(r.phone_id),
    e164: clean(r.canonical_e164 || r.phone),
    display: formatReadablePhone(r.canonical_e164 || r.phone) || clean(r.phone),
    type: clean(r.phone_type) || 'Phone',
    personId: clean(r.primary_prospect_id || r.canonical_prospect_id) || null,
    score: num(r.contact_score_final),
    active: clean(r.activity_status) || null,
    wrongNumber: Boolean(r.wrong_number_at) || /wrong/i.test(clean(r.phone_contact_status)),
  }))
  const emails = (emailRows || []).map((r) => ({
    id: String(r.email_id),
    value: clean(r.email_normalized || r.email),
    personId: clean(r.primary_prospect_id || r.canonical_prospect_id) || null,
  })).filter((e) => e.value)

  const ownerNode = {
    id: ownerId ? `owner:${ownerId}` : 'owner:unlinked',
    type: 'owner',
    label: ownerName,
    sub: (() => { const n = ownerRow ? (num(ownerRow.property_count) || properties.length) : properties.length; return `${KIND_LABEL[ownerKind] === 'Name on title' ? 'Owner' : KIND_LABEL[ownerKind]} · ${n} ${n === 1 ? 'property' : 'properties'}` })(),
    meta: { kind: ownerKind, linked: Boolean(ownerId), buyerRole: ownerBuyer },
  }

  const anchorId = type === 'property' ? `property:${key}` : type === 'person' && anchorPersonId ? `person:${anchorPersonId}` : ownerNode.id
  const graph = buildGraph({ anchor: anchorId, owner: ownerRow, ownerNode, properties, entities, people, phones, emails, mailing, related, outreach, records, anchorPropertyId: recordsFor })

  return {
    anchor: { type, id: key, nodeId: anchorId },
    owner: {
      id: ownerId,
      name: ownerName,
      kind: ownerKind,
      kindLabel: KIND_LABEL[ownerKind],
      linked: Boolean(ownerId),
      propertyCount: ownerRow ? (num(ownerRow.property_count) || properties.length) : properties.length,
      units: num(ownerRow?.portfolio_total_units),
      markets: clean(ownerRow?.markets_text).split(/[,|;]/).map((s) => s.trim()).filter(Boolean).slice(0, 6),
      language: clean(ownerRow?.best_language) || null,
      bestChannel: clean(ownerRow?.best_channel) || null,
      maxOwnershipYears: num(ownerRow?.max_ownership_years),
      tags: clean(ownerRow?.seller_tags_text).split(/[,|;]/).map((t) => t.trim()).filter(Boolean).slice(0, 10),
      portfolio: ownerRow
        ? {
          value: num(ownerRow.portfolio_total_value),
          // portfolio_total_equity sums the vendor equity, which reads full
          // value for every property with no loan on file. Known equity
          // only, and only when every loaded property's equity is known.
          equity: (() => { const d = debtSummary(properties); return d.equityKnown && d.equityKnown === properties.length ? d.totalEquity : null })(),
          loanBalance: num(ownerRow.portfolio_total_loan_balance),
          monthlyPayment: num(ownerRow.portfolio_total_loan_payment),
          annualTax: num(ownerRow.portfolio_total_tax_amount),
          taxDelinquent: num(ownerRow.tax_delinquent_count),
          activeLiens: num(ownerRow.active_lien_count),
        }
        : null,
    },
    mailing,
    properties,
    propertiesTruncated: ownerRow ? Math.max(0, (num(ownerRow.property_count) || 0) - properties.length) : 0,
    debt: debtSummary(properties),
    entities,
    people,
    phones,
    emails,
    related,
    history,
    outreach,
    records,
    ownerBuyer,
    graph,
  }
}

/**
 * IS THIS OWNER ALSO A BUYER?
 *
 * Registry/individual-key evidence first (eg_property_owner_buyer on any
 * property in the network), then an exact match of the owner's name against
 * an UNAMBIGUOUS company alias. Returns the buyer's public reference with its
 * basis, or null — never a guess.
 */
async function loadOwnerBuyerRole(supabase, { propertyIds, ownerName }) {
  try {
    let entityKey = null
    let basis = null
    if (propertyIds.length) {
      const { data } = await supabase.from('eg_property_owner_buyer').select('buyer_entity_id, basis').in('property_id', propertyIds.slice(0, PORTFOLIO_CAP)).limit(5)
      const best = (data || []).sort((a, b) => ['registry', 'individual_key', 'name'].indexOf(a.basis) - ['registry', 'individual_key', 'name'].indexOf(b.basis))[0]
      if (best) { entityKey = best.buyer_entity_id; basis = best.basis }
    }
    if (!entityKey) {
      const key = nameKey(ownerName)
      if (key && key.length >= 6) {
        const { data } = await supabase.from('eg_buyer_alias_keys').select('buyer_entity_id').eq('name_key', key).maybeSingle()
        if (data?.buyer_entity_id) { entityKey = data.buyer_entity_id; basis = 'name' }
      }
    }
    if (!entityKey) return null
    const { data: row } = await supabase
      .from('eg_buyer_index')
      .select('buyer_id, display_name, entity_type, acquisition_count, sold_count, owned_count, activity_status, archetype, last_acquisition, primary_market, is_crossover')
      .eq('entity_key', entityKey)
      .maybeSingle()
    if (!row) return null
    return {
      id: row.buyer_id,
      name: (row.entity_type === 'person' ? null : displayableCompanyName(row.display_name)) || (row.entity_type === 'person' ? 'Individual buyer' : row.display_name ? 'Registered entity' : null),
      kind: row.entity_type,
      basis,
      purchases: num(row.acquisition_count),
      sold: num(row.sold_count),
      owned: num(row.owned_count),
      status: row.activity_status || null,
      archetype: row.archetype || null,
      lastPurchase: row.last_acquisition || null,
      market: clean(row.primary_market).split('|').reverse().join(', ') || null,
      crossover: row.is_crossover === true,
    }
  } catch {
    return null
  }
}

/** Landing: the largest ownership networks, optionally inside one market. */
export async function getTopEntityNetworks({ limit = 16, market = '' } = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  let q = supabase
    .from('master_owners')
    .select('master_owner_id, display_name, owner_type_guess, property_count, portfolio_total_value, portfolio_total_equity, portfolio_total_loan_balance, portfolio_total_units, markets_text, household_key, owner_cluster_key')
    .gt('property_count', 1)
    .order('property_count', { ascending: false, nullsFirst: false })
    .limit(Math.min(40, Math.max(1, limit)))
  if (clean(market)) q = q.ilike('markets_text', `%${clean(market)}%`)
  const { data, error } = await q
  if (error) throw error
  return (data || []).map((r) => ({
    id: String(r.master_owner_id),
    name: titleCase(r.display_name) || 'Owner',
    kind: classifyHolder(r.display_name, r.owner_type_guess),
    propertyCount: num(r.property_count) || 0,
    units: num(r.portfolio_total_units),
    value: num(r.portfolio_total_value),
    equity: num(r.portfolio_total_equity),
    loanBalance: num(r.portfolio_total_loan_balance),
    markets: clean(r.markets_text).split(/[,|;]/).map((s) => s.trim()).filter(Boolean).slice(0, 3),
  }))
}
