// ─── Opportunity economics — READ-ONLY service ───────────────────────────────
// Loads what classifyOpportunityEconomics needs, from the canonical sources, and
// never writes, never runs the Decision Engine and never recomputes a valuation:
//
//   properties                      one row by property_id (lane, zoning, land flags, AVM, ARV)
//   property_acquisition_scores     the engine's current row (canonical economics, per lane)
//   decision freshness              decisionAuthority.evaluateDecisionFreshness against a stamp
//                                   built from the property row + the seller's stated facts
//                                   (asking price moved ⇒ the decision is stale ⇒ INVESTIGATE
//                                   until the engine is rerun through ensurePropertyAcquisitionDecision)
//   buyer demand                    the score row (buyer_demand_score / liquidity_score) and,
//                                   when injected, deal_market_demand (read-only RPC) investor counts
//   seller facts                    the conversation-ai FACT LEDGER (buildFactLedger / factSummary);
//                                   the engine-input facts of record (acquisition_opportunities
//                                   .metadata.seller_facts, what persist-seller-transition hands the
//                                   engine) complete the freshness stamp, with the ledger's ask on top
//
// A missing source is reported in uncertainty.missing; it never becomes a guess.
import { buildDecisionInputStamp, evaluateDecisionFreshness, MATERIAL_PROPERTY_FIELDS } from '../../acquisition/decisionAuthority.js'
import { factSummary } from '../conversation-ai/facts.js'
import { classifyOpportunityEconomics } from './classify-opportunity.js'

export const ECONOMICS_PROPERTY_FIELDS = Object.freeze([...new Set([
  'property_id', ...MATERIAL_PROPERTY_FIELDS,
  'arv_estimate', 'asset_type', 'asset_subtype', 'property_use', 'land_use', 'county_land_use_code', 'zoning',
  'is_land', 'is_vacant_land', 'is_raw_land', 'is_development_land', 'is_infill_lot', 'lot_acreage', 'multifamily_units',
  'commercial_property_type',
])])

async function one(q) {
  const r = await q
  if (r?.error) throw Object.assign(new Error('ECONOMICS_READ_FAILED'), { code: 'ECONOMICS_READ_FAILED', detail: String(r.error.message || '').slice(0, 160) })
  return Array.isArray(r?.data) ? r.data[0] || null : r?.data || null
}

/** The seller's current ask + its history from a conversation-ai fact ledger (seller_stated / model_extracted only). */
export function askFromLedger(ledger = {}) {
  const slot = ledger?.asking_price
  const cur = slot?.current
  const usable = cur && cur.origin !== 'record_derived' && Number(cur.value?.amount) > 0
  const history = (slot?.history || []).filter((h) => h.origin !== 'record_derived' && Number(h.value?.amount) > 0).map((h) => ({ amount: Number(h.value.amount), source_message_id: h.source_message_id, at: h.at }))
  return {
    ask: usable ? { amount: Number(cur.value.amount), price_type: cur.value.price_type || null, source_message_id: cur.source_message_id || null, origin: cur.origin } : null,
    history,
  }
}

/**
 * @param {object} a
 * @param {object} a.supabase           injected client (read-only usage: select only)
 * @param {string} a.property_id
 * @param {object} [a.ledger]           conversation-ai fact ledger for the SAME thread + property
 * @param {string} [a.thread_key]       when given, the opportunity's engine-input seller facts are read
 * @param {object} [a.seller_facts]     engine-input seller facts of record (overrides the read)
 * @param {object} [a.complexity]       { owners_count, probate, multi_property, liens, foreclosure, title_issue }
 * @param {Function} [a.getMarketDemand] optional deal-intelligence/market-demand-service#getMarketDemand
 * @param {Function} [a.loadFinishedHomeReference] optional ({ property }) → { median, source } for land lots
 * @param {Date|string} [a.now]
 */
export async function assessOpportunityEconomics({ supabase, property_id, ledger = {}, thread_key = null, seller_facts = null, complexity = {}, getMarketDemand = null, loadFinishedHomeReference = null, now = new Date() } = {}) {
  if (!supabase?.from) throw Object.assign(new Error('NO_CLIENT'), { code: 'NO_CLIENT' })
  const id = String(property_id ?? '').trim()
  const nowDate = now instanceof Date ? now : new Date(now)
  const { ask, history } = askFromLedger(ledger)
  if (!id) return classifyOpportunityEconomics({ ask, ask_history: history, facts: factSummary(ledger), now: nowDate.getTime() })

  const [property, valuation, opportunity] = await Promise.all([
    one(supabase.from('properties').select(ECONOMICS_PROPERTY_FIELDS.join(',')).eq('property_id', id).limit(1)),
    one(supabase.from('property_acquisition_scores').select('*').eq('property_id', id).limit(1)),
    !seller_facts && thread_key ? one(supabase.from('acquisition_opportunities').select('id,metadata').eq('primary_thread_key', thread_key).eq('primary_property_id', id).limit(1)) : null,
  ])
  const factsOfRecord = seller_facts || (opportunity?.metadata && typeof opportunity.metadata === 'object' ? opportunity.metadata.seller_facts || {} : {})
  const stamp = property ? buildDecisionInputStamp(property, { ...factsOfRecord, asking_price: ask?.amount ?? factsOfRecord.asking_price ?? null }, nowDate) : null
  const freshness = evaluateDecisionFreshness({ score: valuation, stamp, now: nowDate })

  let market = null
  if (typeof getMarketDemand === 'function') {
    const m = await getMarketDemand({ propertyId: id, radiusMiles: 1.5, months: 12 }, { supabase }).catch(() => null)
    if (m?.ok) market = { investor_count: m.investorVsRetail?.investor?.count ?? null, unclassified_count: m.investorVsRetail?.unclassifiedCount ?? null, priced_sales: m.totals?.pricedSales ?? null, family: m.subject?.family ?? null, median_price: m.overall?.medianPrice ?? null, data_age_days: m.window?.dataAgeDays ?? null }
  }
  if (typeof loadFinishedHomeReference === 'function' && property) {
    const ref = await loadFinishedHomeReference({ property }).catch(() => null)
    if (ref?.median > 0) market = { ...(market || {}), completed_home_median: ref.median, completed_home_source: ref.source || 'injected' }
  }

  const result = classifyOpportunityEconomics({
    ask, ask_history: history, property: property || {}, valuation, freshness, market, facts: factSummary(ledger), complexity, now: nowDate.getTime(),
  })
  return {
    ...result,
    evidence: { ...result.evidence, property_found: Boolean(property), freshness: { status: freshness.status, reason: freshness.reason, changed_inputs: (freshness.changed_inputs || []).map((c) => `${c.scope}.${c.field}`).slice(0, 12) } },
  }
}

export default assessOpportunityEconomics
