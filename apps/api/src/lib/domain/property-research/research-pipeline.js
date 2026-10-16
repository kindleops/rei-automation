// ─── PROPERTY RESEARCH PIPELINE (8.5.20-b) ───────────────────────────────────
// runInternalResearch()  internal data FIRST ($0, read-only): dossier → comps + area →
//                        opportunity economics (+ Phase 7 judgment) → MAO + opening plan.
// applyWebResearch()     merges parsed web findings (listings stay listings) and re-runs
//                        the comps/area assembly; the MAO / plan never read web data.
// planOfferForProperty() the negotiation-interface hook (deps.planOffer for preparePosition).
//
// Nothing here writes, sends, or grants: the plan is a recommendation for an operator.
// rc-8.5.20: the ONE canonical thread ledger (conversation-ai/ledger.js) — the same facts the
// conversation pipeline and the negotiation service read
import { factLedgerOf, factSummaryOf, threadLedgerFromRows } from '../conversation-ai/ledger.js'
import { classifyOpportunityEconomics, stripProtectedAttributes } from '../opportunity-economics/classify-opportunity.js'
import { askFromLedger } from '../opportunity-economics/economics-service.js'
import { maskContacts } from '../../agent/research/pii.js'
import { buildPropertyDossier, mergeWebFindings } from './dossier.js'
import { assembleCompsAndArea } from './comps-area.js'
import { planOffer } from './offer-plan.js'
import { coverage } from './provenance.js'

export const RESEARCH_PIPELINE_VERSION = 'property-research.pipeline.v1'
const num = (v) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null }

/** Read everything one property needs (bounded, projected, read-only). */
export async function loadResearchInputs(source, property_id, { now = Date.now() } = {}) {
  const id = String(property_id || '').trim()
  if (!id) throw Object.assign(new Error('PROPERTY_ID_REQUIRED'), { code: 'PROPERTY_ID_REQUIRED' })
  const safe = (p, fallback) => p.catch(() => fallback)
  const [property, valuation, sales, mortgages, liens, thread, opportunity, offers] = await Promise.all([
    source.property(id), safe(source.valuation(id), null), safe(source.sales(id), []), safe(source.mortgages(id), []), safe(source.liens(id), []),
    safe(source.sellerThread(id), { inbound: [], outbound_count: 0, last_outbound_at: null }), safe(source.opportunity(id), null), safe(source.offers(id), []),
  ])
  if (!property) return { found: false, property_id: id }
  const lat = num(property.latitude)
  const lng = num(property.longitude)
  const zip = property.property_address_zip ? String(property.property_address_zip).slice(0, 5) : null
  const since = new Date(now - 12 * 30.44 * 864e5).toISOString().slice(0, 10)
  const [soldComps, marketSales, area] = await Promise.all([
    safe(source.soldComps({ lat, lng, zip, since }), []),
    safe(source.marketSales({ lat, lng, zip, since }), []),
    safe(source.area({ zip, county: property.property_address_county_name, state: property.property_address_state }), {}),
  ])
  return { found: true, property_id: id, property, valuation, sales, mortgages, liens, thread, opportunity, offers, soldComps, marketSales, area, subject: lat != null && lng != null ? { lat, lng } : null, zip }
}

/**
 * @param {object} inputs  loadResearchInputs() result (or a fixture of the same shape)
 * @param {{ now?: number, zip_cell?: object|null, zip_prior?: object|null, listings?: Array, web_notes?: Array }} [opts]
 *   zip_prior (8.5.21-b): zip-prior.resolveZipPrior() for the subject — a labelled market prior the
 *   offer plan carries as context when engine evidence is thin (never a price)
 */
export function runInternalResearch(inputs, { now = Date.now(), zip_cell = null, zip_prior = null, listings = [], web_notes = [] } = {}) {
  const { value: inp, stripped } = stripProtectedAttributes(inputs || {})
  if (!inp.found) return { version: RESEARCH_PIPELINE_VERSION, found: false, property_id: inp.property_id || null }
  const inbound = (inp.thread?.inbound || []).map((m) => ({ ...m, body: maskContacts(String(m.body || '')).value }))
  // both directions when the source provides them: a bare "No" is an ownership denial only
  // against OUR ownership question (inbound-only threads still build the same ledger)
  const rows = Array.isArray(inp.thread?.messages) && inp.thread.messages.length
    ? inp.thread.messages.map((m) => ({ ...m, body: maskContacts(String(m.body || '')).value }))
    : inbound.map((m) => ({ ...m, direction: 'inbound' }))
  const canonical = threadLedgerFromRows(rows, { now: new Date(now).toISOString() })
  const ledger = factLedgerOf(canonical)
  const facts = factSummaryOf(canonical)
  const fromLedger = askFromLedger(ledger)
  // the pipeline's recorded ask (public.acquisition_opportunities.asking_price) only when the thread yields none
  const oppAsk = num(inp.opportunity?.asking_price) > 0 ? { amount: num(inp.opportunity.asking_price), origin: 'opportunity_record', source_message_id: null } : null
  const ask = fromLedger.ask || oppAsk
  const history = { inbound_count: inbound.length, outbound_count: inp.thread?.outbound_count ?? null, last_inbound_at: inbound[inbound.length - 1]?.at || null, last_outbound_at: inp.thread?.last_outbound_at || null, pipeline_stage: inp.opportunity?.stage || null, offers: inp.offers || [] }
  const factsForDossier = { ...facts }
  if (!factsForDossier.asking_price && oppAsk) factsForDossier.asking_price = { value: { amount: oppAsk.amount, price_type: null }, origin: 'seller_stated', source_message_id: null }

  let dossier = buildPropertyDossier({ property: inp.property, valuation: inp.valuation, sales: inp.sales, mortgages: inp.mortgages, liens: inp.liens, facts: factsForDossier, history, now })
  if (web_notes.length) dossier = mergeWebFindings(dossier, web_notes.map((n) => ({ topic: n.topic === 'flood' ? 'flood_exposure' : n.topic === 'zoning' ? 'zoning' : n.topic, value: n.value, url: n.url, retrieved_at: n.retrieved_at, confidence: n.confidence })))
  const lane = dossier.lane
  const comps = assembleCompsAndArea({
    subject: inp.subject, lane, units: inp.property?.units_count, engine_comps: inp.valuation?.evidence?.selected_comps || [], sold_comps: inp.soldComps || [], market_sales: inp.marketSales || [],
    listings, area: { ...(inp.area || {}), zip_cell }, now,
  })
  const ma = comps.sections.market_activity
  const market = {
    investor_count: ma.investor_share.value != null ? Math.round(ma.investor_share.value * (comps.evidence_counts.market_sales || 0)) : null,
    priced_sales: comps.evidence_counts.market_sales,
    unclassified_count: null,
    completed_home_median: comps.sections.development?.finished_home_median?.value ?? null,
    completed_home_source: comps.sections.development ? 'public.mv_map_market_sales:1.5mi_12m_single_unit' : null,
  }
  const economics = classifyOpportunityEconomics({
    ask: ask ? { amount: ask.amount, price_type: ask.price_type || null, source_message_id: ask.source_message_id || null, origin: ask.origin || null } : null,
    ask_history: fromLedger.history, property: inp.property || {}, valuation: inp.valuation, freshness: null, market, facts,
    seller_messages: inbound.map((m) => m.body), our_last_offer: num(inp.offers?.[0]?.amount), now,
  })
  const plan = planOffer({ valuation: inp.valuation, property: inp.property || {}, ask: ask ? { amount: ask.amount } : null, ask_history: fromLedger.history, facts, market, zip_prior, now })
  const cov = coverage({ ...dossier.sections, ...comps.sections })
  return {
    version: RESEARCH_PIPELINE_VERSION,
    found: true,
    property_id: inp.property_id,
    built_at: new Date(now).toISOString(),
    lane,
    ask: ask ? { amount: ask.amount, origin: ask.origin || 'seller_stated' } : null,
    dossier,
    comps_area: comps,
    economics: { class: economics.class, reasons: economics.reasons, uncertainty: economics.uncertainty, judgment: economics.judgment, execution_friction: economics.execution_friction, metrics: { mao: economics.metrics.mao, recommended_offer: economics.metrics.recommended_offer, price_gap: economics.metrics.price_gap, buyer_demand: economics.metrics.buyer_demand?.level ?? null, decision: economics.metrics.decision } },
    offer_plan: plan,
    ignored: { protected_attributes_stripped: stripped },
    evidence: {
      coverage: cov,
      dossier_contract_ok: dossier.contract.ok,
      gaps: dossier.gaps,
      stale: dossier.stale,
      comps_uncertainty: comps.uncertainty,
      web: { listings: listings.length, notes: web_notes.length },
    },
  }
}

/** Hook for negotiation preparePosition (deps.planOffer): read-only, internal only. */
export function createPlanOfferHook({ source, now = () => Date.now() }) {
  return async ({ property_id }) => {
    const inputs = await loadResearchInputs(source, property_id, { now: now() })
    if (!inputs.found) return null
    return runInternalResearch(inputs, { now: now() }).offer_plan
  }
}
