// Live Quick Scan T0 read tools (S3). Each wraps an AUTHORITATIVE app service
// (quick-scan/services.js) and declares the full S1 permission contract
// (defineTool). The projection functions below are pure: they take the
// service's own output and keep only the fields the scan may store/show.
//
// Never projected (stays on the server, never stored in the agent store):
// phone numbers, emails, seller / owner / prospect / borrower / party / buyer
// names, mailing addresses, message text, Street View URLs (may embed a key),
// protected-class and demographic person fields.
import { createToolRegistry } from '../tools/registry.js'
import { classifyContactReadiness } from './contact-readiness.js'
import { classifyHolder } from '@/lib/domain/entity-graph/entity-network-service.js'
import { equityTruth } from '@/lib/domain/entity-graph/entity-graph-truth.js'
import { parseJsonArray } from '@/lib/domain/entity-graph/entity-graph-normalize.js'

const NEVER = ['phone', 'email', 'e164', 'owner_name', 'seller_name', 'buyer_name', 'display_name', 'full_name', 'borrower', 'party1', 'party2', 'trustee', 'mailing', 'preview', 'body', 'ssn', 'dob', 'age', 'gender', 'marital', 'race', 'religion', 'demographic', 'income']
const PROPERTY_ID = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_.:-]+$' }
const ZIP = { type: 'string', minLength: 5, maxLength: 5, pattern: '^[0-9]{5}$' }
const propertyInput = { type: 'object', additionalProperties: false, properties: { property_id: PROPERTY_ID }, required: ['property_id'] }

const clean = (v) => String(v ?? '').trim()
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const bool = (v) => (v === null || v === undefined || v === '' ? null : v === true || /^(true|t|yes|y|1)$/i.test(String(v)))
const pick = (obj, keys) => {
  const out = {}
  for (const k of keys) out[k] = obj?.[k] ?? null
  return out
}

function unavailableError(code, message) {
  const e = new Error(message)
  e.code = code
  e.unavailable = true
  return e
}

async function requireDossier(services, propertyId) {
  const d = await services.dossier(propertyId)
  if (!d) throw unavailableError('PROPERTY_NOT_FOUND', 'no LeadCommand property record for this id')
  return d
}

/** Vendor as-of date for the properties row (the vendor's snapshot, not our refresh). */
export function vendorAsOf(summary = {}) {
  return summary.valuation_date || summary.exported_at_utc || summary.created_at || null
}

// ── pure projections (exported for the authority tests) ─────────────────────

export const PROPERTY_FACT_KEYS = Object.freeze([
  'property_type', 'property_class', 'normalized_asset_class', 'asset_subclass', 'units_count', 'total_bedrooms',
  'total_baths', 'building_square_feet', 'year_built', 'effective_year_built', 'lot_square_feet', 'lot_acreage',
  'property_address_city', 'property_address_state', 'property_address_zip', 'property_address_county_name', 'zoning',
])

export function projectPropertyCore(dossier) {
  const s = dossier.summary || {}
  return {
    property_id: clean(dossier.entityId),
    display_address: clean(s.property_address_full) || null,
    market: s.marketLabel ?? null,
    facts: pick(s, PROPERTY_FACT_KEYS),
    has_coordinates: num(s.latitude) !== null && num(s.longitude) !== null && Math.abs(num(s.latitude)) > 0.0001,
    provenance: { source_updated_at: s.updated_at || null, vendor_as_of: vendorAsOf(s), source_system: s.source_system || null },
  }
}

export function projectOwnership(dossier) {
  const s = dossier.summary || {}
  const owner = dossier.owner || null
  return {
    property_id: clean(dossier.entityId),
    owner_linked: Boolean(owner),
    owner_kind: classifyHolder(owner?.display_name || s.owner_name, owner?.owner_type_guess || s.owner_type || ''),
    is_corporate_owner: bool(s.is_corporate_owner),
    out_of_state_owner: bool(s.out_of_state_owner),
    ownership_years: num(s.ownership_years),
    owner_portfolio_count: owner ? num(owner.property_count) : null,
    owner_entity_count: owner ? parseJsonArray(owner.joined_sub_owner_ids_json).length : null,
    linked_people_count: Array.isArray(dossier.prospects) ? dossier.prospects.length : null,
    provenance: { source_updated_at: s.updated_at || null, vendor_as_of: vendorAsOf(s) },
  }
}

export const PARCEL_KEYS = Object.freeze([
  'fips', 'county_name', 'tax_delinquent', 'tax_delinquent_year', 'tax_year', 'tax_amount', 'active_lien', 'lien_count',
  'mortgage_count', 'open_mortgage_count', 'total_loan_balance', 'equity_percent', 'estimated_equity', 'estimated_value',
  'preforeclosure_status', 'preforeclosure_type', 'is_vacant', 'is_mls_active', 'mls_status', 'distress_flags',
  'updated_at', 'valuation_date',
])

export function projectRecordedDocuments(dossier) {
  const r = dossier.records
  if (!r) return { property_id: clean(dossier.entityId), available: false, reason: 'records_unavailable' }
  return {
    property_id: clean(dossier.entityId),
    available: true,
    mortgages: (r.mortgages || []).map((m) => ({
      open: m.open, position: m.position, recorded: m.recorded, amount: m.amount, loan_type: m.loanType, financing: m.financing,
      private_lender: m.privateLender, lender: m.privateLender ? null : m.lender,
      // vendor estimates on the row (not on the recorded instrument)
      est_balance: m.balance, est_payment: m.payment, rate: m.rate, due: m.due, term_months: m.termMonths,
    })),
    liens: (r.liens || []).map((l) => ({
      category: l.category, type: l.type, title: l.title, description: l.description, amount_due: l.amountDue,
      recorded: l.recorded, distress: l.distress, county: l.county, tax_period: l.taxPeriod, default_amount: l.defaultAmount,
    })),
    foreclosures: (r.foreclosures || []).map((f) => ({
      stage: f.stage, recorded: f.recorded, default_date: f.defaultDate, auction_date: f.auctionDate, case_number: f.caseNumber,
      unpaid_balance: f.unpaidBalance, min_bid: f.minBid, lender: f.lender, original_loan: f.originalLoan,
    })),
    parcel: r.parcel ? pick(r.parcel, PARCEL_KEYS) : null,
    totals: r.totals || null,
  }
}

export function projectSalesHistory(dossier) {
  const r = dossier.records
  if (!r) return { property_id: clean(dossier.entityId), available: false, reason: 'records_unavailable' }
  const party = (p) => (p ? { kind: p.kind, status: p.status, purchases: p.purchases, sold: p.sold, resolution: p.method || p.basis || null } : null)
  return {
    property_id: clean(dossier.entityId),
    available: true,
    sales: (r.sales || []).map((s) => ({
      date: s.date, price: s.price, doc_type: s.docType, cash: s.cash, arms_length: s.armsLength, price_note: s.priceNote,
      loan_amount: s.loanAmount, current: s.current, buyer: party(s.buyer), seller: party(s.seller),
    })),
    owner_buyer: party(r.ownerBuyer),
  }
}

export function projectValuation(dossier, enrichment) {
  const s = dossier.summary || {}
  const id = clean(dossier.entityId)
  const e = enrichment?.values?.[id] || {}
  const de = dossier.scores?.decisionEngine || null
  const equityInputs = {
    estimated_value: s.estimated_value ?? null,
    total_loan_balance: s.total_loan_balance ?? null,
    property_flags_text: s.property_flags_text ?? null,
    rec_mortgage_balance: e['rec.mortgage_balance'] ?? null,
    rec_mortgage_count: e['rec.mortgage_count'] ?? null,
  }
  const flags = String(s.property_flags_text ?? '').split(/[;,|]/).map((t) => t.trim().toLowerCase()).filter(Boolean)
  return {
    property_id: id,
    vendor: { estimated_value: num(s.estimated_value), value_low: num(s.value_low), value_high: num(s.value_high), value_confidence: s.value_confidence ?? null, valuation_date: s.valuation_date || null, equity_percent: num(s.equity_percent), total_loan_balance: num(s.total_loan_balance), equity_flags: flags.filter((f) => /equity|free and clear/.test(f)) },
    engine: de || Object.keys(e).some((k) => k.startsWith('scores.'))
      ? {
          ran: Boolean(de),
          decision_tier: de?.decisionTier ?? e['scores.decision_tier'] ?? null,
          best_strategy: de?.bestStrategy ?? e['scores.best_strategy'] ?? null,
          valuation_low: e['scores.valuation_low'] ?? null,
          valuation_mid: e['scores.valuation_mid'] ?? null,
          valuation_high: e['scores.valuation_high'] ?? null,
          valuation_confidence: e['scores.valuation_confidence'] ?? null,
          comp_count: e['scores.comp_count'] ?? null,
          computed_at: de?.computedAt ?? e['scores.computed_at'] ?? null,
          lane: null, // the engine row carries no valuation-lane label (limitation)
        }
      : null,
    equity: equityTruth(equityInputs),
    equity_inputs: equityInputs,
    recorded_mortgage_count: e['rec.mortgage_count'] ?? null,
    provenance: { source_updated_at: s.updated_at || null, vendor_as_of: vendorAsOf(s), enrichment_generated_at: enrichment?.generatedAt || null },
  }
}

export function projectOutreach(result, propertyId, entityContact = null) {
  const st = result?.states?.[propertyId]
  const unavailable = (result?.unavailable || []).map((u) => u.source)
  if (!st) return { property_id: propertyId, available: false, reason: 'no_state', unavailable_sources: unavailable }
  const cc = st.contactCandidates
  // names never leave: resolution + masked phones only
  const candidates = cc ? { people: cc.people, phones: cc.phones, unresolved: cc.unresolved, candidates: (cc.candidates || []).map((c) => ({ resolution: c.resolution, phones: (c.phones || []).map((p) => ({ masked: p.masked, type: p.type ?? null, inCampaignGraph: Boolean(p.inCampaignGraph) })) })) } : null
  const contact_readiness = classifyContactReadiness({
    sms: st.sms,
    graphRead: !unavailable.includes('campaign_target_graph') && st.sms !== null,
    candidates,
    candidatesLookedUp: cc !== null || unavailable.includes('contact_candidates'),
    candidatesRead: !unavailable.includes('contact_candidates'),
    review: entityContact?.available ? entityContact.row : null,
    reviewRead: Boolean(entityContact?.available),
    suppressedThread: Boolean(st.conversation?.suppressed),
  })
  return {
    property_id: propertyId,
    available: true,
    stage: st.stage,
    status: st.status,
    last_contact: st.lastContact ? pick(st.lastContact, ['at', 'direction', 'channel', 'source']) : null,
    deal_linked: Boolean(st.dealId),
    conversation: st.conversation ? { at: st.conversation.at, direction: st.conversation.direction, suppressed: st.conversation.suppressed } : null,
    campaigns: st.campaigns ? { count: st.campaigns.count, latest: st.campaigns.latest ? pick(st.campaigns.latest, ['status', 'targetStatus', 'blockReason']) : null } : null,
    contact_candidates: st.contactCandidates ? pick(st.contactCandidates, ['people', 'phones', 'unresolved']) : null,
    contact_readiness,
    unavailable_sources: unavailable,
    generated_at: result.generatedAt || null,
  }
}

export function projectSmsEligibility(result, propertyId) {
  const st = result?.states?.[propertyId]
  const unavailable = (result?.unavailable || []).map((u) => u.source)
  if (!st || !st.sms) return { property_id: propertyId, available: false, reason: unavailable.includes('campaign_target_graph') ? 'campaign_target_graph_unavailable' : 'no_state', unavailable_sources: unavailable }
  return { property_id: propertyId, available: true, ...pick(st.sms, ['eligible', 'reason', 'rows', 'ready', 'source', 'reviewChecked']), unavailable_sources: unavailable, generated_at: result.generatedAt || null }
}

export function projectZipContext(result, zip) {
  const z = result?.zips?.[zip]
  if (!z) return { zip, available: false, reason: 'no_zip_row', build_id: result?.buildId ?? null }
  const { demographics, ...rest } = z
  return { zip, available: true, ...rest, demographics_available: Boolean(demographics), build_id: result.buildId ?? null }
}

export function projectStreetView(dossier) {
  const s = dossier.summary || {}
  const raw = clean(s.streetview_image)
  let host = null
  if (/^https:\/\//.test(raw)) {
    try { host = new URL(raw).hostname } catch { host = null }
  }
  return {
    property_id: clean(dossier.entityId),
    image_reference_on_record: Boolean(host),
    image_host: host, // never the URL: it can embed a key
    has_coordinates: num(s.latitude) !== null && num(s.longitude) !== null && Math.abs(num(s.latitude)) > 0.0001,
    fetched: false,
  }
}

// ── tool specs ───────────────────────────────────────────────────────────────

function t0({ name, capability, label, description, app = 'entity-graph', input_schema = propertyInput, wraps, to_model, execute, sources }) {
  return {
    name,
    version: 1,
    capability,
    label,
    description,
    input_schema,
    output_schema: { type: 'object', description: 'projected fields only; see quick-scan/tools.js' },
    side_effect: 'read',
    permission: { min_role: 'operator', apps: [app] },
    cost_class: 'db_light',
    limits: { rows_to_model: 50, max_rows: 200, timeout_ms: 30_000, per_run: 60 },
    disclosure: { to_model: to_model, never: NEVER },
    wraps: { kind: 'service', ...wraps },
    output_trust: 'system',
    sources,
    s1_stub: false,
    async execute(input, ctx) {
      if (!ctx?.services) throw unavailableError('SERVICE_UNAVAILABLE', 'quick scan services not injected')
      return execute(input, ctx.services)
    },
    audit: (input) => ({ summary: `${name} read`, target_refs: input.property_id ? [`property:${input.property_id}`] : [] }),
    target_refs: (input) => (input.property_id ? [`property:${input.property_id}`] : []),
    failure: { retry: 'read_retry_once', surface: 'tool_error' },
  }
}

const DOSSIER = { module: '@/lib/domain/entity-graph/entity-graph-service.js', export: 'getEntityGraphDossier', route: 'GET /api/cockpit/entity-graph/property/:id' }

export const QUICK_SCAN_TOOL_SPECS = Object.freeze([
  t0({
    name: 'eg.property_core', capability: 2, label: 'Reading property facts',
    description: 'Core property facts from the LeadCommand property record (type, units, size, year, location).',
    wraps: DOSSIER, to_model: ['property_id', 'display_address', 'market', 'facts'], sources: ['lc.property_record'],
    execute: async (input, services) => projectPropertyCore(await requireDossier(services, input.property_id)),
  }),
  t0({
    name: 'eg.ownership', capability: 2, label: 'Reading ownership',
    description: 'Owner linkage and owner kind (individual / LLC / trust / estate / institution) — never names.',
    wraps: DOSSIER, to_model: ['owner_kind', 'is_corporate_owner', 'out_of_state_owner', 'ownership_years', 'owner_portfolio_count'], sources: ['lc.property_record'],
    execute: async (input, services) => projectOwnership(await requireDossier(services, input.property_id)),
  }),
  t0({
    name: 'eg.recorded_documents', capability: 2, label: 'Reading recorded loans, liens and foreclosures',
    description: 'Recorded mortgages, liens and foreclosure filings (seller.* via entity_graph_property_records) and the vendor parcel snapshot.',
    wraps: { ...DOSSIER, rpc: 'entity_graph_property_records' }, to_model: ['mortgages', 'liens', 'foreclosures', 'parcel', 'totals'], sources: ['lc.recorded_documents', 'lc.vendor_parcel'],
    execute: async (input, services) => projectRecordedDocuments(await requireDossier(services, input.property_id)),
  }),
  t0({
    name: 'eg.sales_history', capability: 2, label: 'Reading sales history',
    description: 'Recorded sales / transfers with cash and arms-length flags; buyer kind and activity, never names.',
    wraps: { ...DOSSIER, rpc: 'entity_graph_property_records' }, to_model: ['sales', 'owner_buyer'], sources: ['lc.recorded_documents'],
    execute: async (input, services) => projectSalesHistory(await requireDossier(services, input.property_id)),
  }),
  t0({
    name: 'valuation.read', capability: 4, label: 'Reading valuation references',
    description: 'Vendor value estimate, the Decision Engine valuation band (when it has run) and equity under rule equity_known_v1.',
    wraps: { module: '@/lib/domain/entity-graph/entity-graph-column-enrichment.js', export: 'getEntityGraphColumnEnrichment', route: 'GET /api/cockpit/entity-graph/columns', also: DOSSIER },
    to_model: ['vendor', 'engine', 'equity'], sources: ['lc.property_record', 'lc.decision_engine', 'lc.derived_rules'],
    execute: async (input, services) => {
      const dossier = await requireDossier(services, input.property_id)
      const enrichment = await services.enrichment(input.property_id)
      return projectValuation(dossier, enrichment)
    },
  }),
  t0({
    name: 'eg.outreach_state', capability: 2, label: 'Reading outreach state',
    description: 'Last contact (date, direction), stage and status with their source, campaign membership. No message text.',
    wraps: { module: '@/lib/domain/entity-graph/entity-graph-outreach-state.js', export: 'getEntityGraphOutreachState', route: 'GET /api/cockpit/entity-graph/outreach-state' },
    to_model: ['stage', 'status', 'last_contact', 'campaigns', 'contact_readiness'], sources: ['lc.outreach'],
    execute: async (input, services) => {
      const [outreach, entityContact] = await Promise.all([services.outreach(input.property_id), services.entityContact ? services.entityContact(input.property_id).catch(() => null) : null])
      return projectOutreach(outreach, input.property_id, entityContact)
    },
  }),
  t0({
    name: 'eg.sms_eligibility', capability: 2, label: 'Reading SMS eligibility',
    description: 'SMS eligibility + blocking reason from the campaign target graph (resolveCampaignTargetReadiness).',
    wraps: { module: '@/lib/domain/entity-graph/entity-graph-outreach-state.js', export: 'getEntityGraphOutreachState', member: 'states[id].sms', route: 'GET /api/cockpit/entity-graph/outreach-state' },
    to_model: ['eligible', 'reason', 'rows', 'ready'], sources: ['lc.campaign_target_graph'],
    execute: async (input, services) => projectSmsEligibility(await services.outreach(input.property_id), input.property_id),
  }),
  t0({
    name: 'mi.zip_context', capability: 10, app: 'market-intel', label: 'Reading ZIP market context',
    description: 'Sales, investor and cash share, median price and buyer counts for the property ZIP (current MI build).',
    input_schema: { type: 'object', additionalProperties: false, properties: { zip: ZIP, property_id: PROPERTY_ID }, required: ['zip'] },
    wraps: { module: '@/lib/domain/entity-graph/entity-graph-zip-context.js', export: 'getEntityGraphZipContext', route: 'GET /api/cockpit/entity-graph/zip-context' },
    to_model: ['sales90d', 'sales1y', 'investorShare1y', 'cashShare1y', 'medianPrice1y', 'buyers', 'activeBuyers'], sources: ['lc.market_intelligence'],
    execute: async (input, services) => projectZipContext(await services.zipContext(input.zip), input.zip),
  }),
  t0({
    name: 'eg.street_view_availability', capability: 2, label: 'Checking Street View availability',
    description: 'Whether the record carries a Street View image reference and coordinates. Metadata only: no image or map API is called.',
    wraps: DOSSIER, to_model: ['image_reference_on_record', 'has_coordinates'], sources: ['lc.property_record'],
    execute: async (input, services) => projectStreetView(await requireDossier(services, input.property_id)),
  }),
])

export const QUICK_SCAN_TOOL_NAMES = Object.freeze(QUICK_SCAN_TOOL_SPECS.map((s) => s.name))
export const QUICK_SCAN_CAPABILITIES = Object.freeze([2, 4, 10])

/**
 * Sealed registry with exactly the Quick Scan T0 tools. Read-only by default
 * (AGENT_READ_ONLY): the registry itself refuses anything but small T0 reads.
 */
export function createQuickScanToolRegistry({ readOnly = true } = {}) {
  const registry = createToolRegistry({ readOnly })
  for (const spec of QUICK_SCAN_TOOL_SPECS) registry.register(spec)
  return registry.seal()
}
