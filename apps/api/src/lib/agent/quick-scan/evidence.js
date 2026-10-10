// Quick Scan evidence rules (S3): tool output → governed findings, and the
// deterministic conflict model. Pure functions; no I/O.
//
// Source-class assignment (contracts/evidence.js EVIDENCE_SOURCE_CLASSES):
//   official_public_record / 'recorded'
//       ONLY a recorded instrument row that carries its own recording/filing
//       date (mortgage, lien, foreclosure filing, deed transfer). Vendor-
//       transcribed: limitation stated on every such finding.
//   third_party_vendor / 'vendor_reported' (→ 'stale' past its window)
//       properties / seller.property attributes, flags and estimates, and the
//       vendor estimates carried on recorded rows (est_balance, rate …)
//   internal_record / 'internal_record'
//       campaign target graph eligibility, outreach state, Decision Engine
//       output, MI rollups, the record's Street View reference
//   derived_inferred / 'derived'
//       equity under rule equity_known_v1 — never stronger than its inputs
//   unavailable_blocked / 'unavailable'
//       anything not read, not captured, or absent from a feed that is not
//       proven complete. value === null; is_negative_claim === false. ALWAYS.
import { contactReadinessDisplay } from './contact-readiness.js'
import {
  EXTENDED_EVIDENCE_STATUS_META,
  EVIDENCE_AUTHORITY_WEIGHT,
  confidenceBand,
  findingViolations,
  sourceClassViolations,
} from '../contracts/evidence.js'
import { hashCanonical } from '../runtime/canonical.js'
import { AgentError } from '../runtime/store.js'
import { quickScanSource } from './sources.js'

const DAY = 86_400_000
/** Freshness windows (days) per finding type for VENDOR snapshot data (DR §7.1 spirit). */
export const VENDOR_FRESH_DAYS = Object.freeze({ property_facts: 365, ownership: 180, parcel: 90, tax_status: 90, valuation: 180, mortgage: 180, equity: 180, default: 180 })

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const money = (v) => (num(v) === null ? null : `$${Math.round(num(v)).toLocaleString('en-US')}`)
const day = (v) => (v ? String(v).slice(0, 10) : null)
const ts = (v) => {
  const t = v ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}

export function freshnessFor({ as_of, window_days, now }) {
  const t = ts(as_of)
  if (t === null) return { freshness_state: 'aging', fresh_until: null, as_of_known: false }
  const until = t + window_days * DAY
  const n = now.getTime()
  const state = n > until ? 'stale' : n > until - window_days * DAY * 0.25 ? 'aging' : 'fresh'
  return { freshness_state: state, fresh_until: new Date(until).toISOString(), as_of_known: true }
}

/**
 * Build one governed finding. Throws FINDING_INVARIANT on any contract violation
 * (blocked/unavailable with a value, negative claim, class/status mismatch …).
 */
export function makeFinding({
  run_id, property_id, finding_type, key, source_id, source_class, evidence_status, value = null, display_value = null,
  observed_at = null, retrieved_at, freshness = null, citation, limitations = [], basis_finding_ids = [], confidence_cap = null,
  reason = null, provenance = null, is_discovery = false,
}) {
  const src = quickScanSource(source_id)
  const noValue = evidence_status === 'unavailable' || evidence_status === 'blocked'
  const status = evidence_status
  let confidence = noValue ? 0 : EVIDENCE_AUTHORITY_WEIGHT[status] ?? 0
  if (freshness?.freshness_state === 'aging' && !noValue) confidence *= freshness.as_of_known ? 0.9 : 0.8
  if (confidence_cap !== null) confidence = Math.min(confidence, confidence_cap)
  confidence = Math.round(confidence * 1000) / 1000
  const finding = {
    finding_id: `fnd_${hashCanonical({ run_id, property_id, finding_type, key }).slice(0, 24).replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)])}`,
    run_id,
    property_id,
    finding_type,
    key,
    value: noValue ? null : value,
    display_value: noValue ? null : display_value,
    evidence_status: status,
    evidence_label: EXTENDED_EVIDENCE_STATUS_META[status]?.label || status,
    source_class: source_class || src.source_class,
    confidence,
    confidence_band: confidenceBand(confidence),
    is_inference: false,
    is_discovery,
    is_negative_claim: false,
    freshness_state: noValue ? 'never' : freshness?.freshness_state ?? 'fresh',
    observed_at: noValue ? null : observed_at,
    retrieved_at,
    fresh_until: noValue ? null : freshness?.fresh_until ?? null,
    source_id,
    source_name: src.name,
    citation,
    provenance: provenance || src.provenance,
    limitations: [...new Set([...(src.limitations || []), ...limitations])],
    basis_finding_ids,
    unavailable_reason: noValue ? reason || 'not_captured' : null,
    supersedes_id: null,
    contradicted_by: null,
    conflict_group_id: null,
    live: true,
  }
  const v = [...findingViolations(finding), ...sourceClassViolations(finding)]
  if (v.length) throw new AgentError('FINDING_INVARIANT', v.join(','), { violations: v, finding_type, key })
  return finding
}

const unavailable = (base, { finding_type, key, source_id, reason, citation, limitations = [] }) =>
  makeFinding({ ...base, finding_type, key, source_id, source_class: 'unavailable_blocked', evidence_status: 'unavailable', reason, citation, limitations })

function vendorStatus(freshness) {
  return freshness.freshness_state === 'stale' ? 'stale' : 'vendor_reported'
}

/**
 * Tool output → findings. `ctx` = { run_id, property_id, retrieved_at, now }.
 * @returns {Object[]} findings
 */
export function findingsFromTool(tool, output, ctx) {
  const base = { run_id: ctx.run_id, property_id: ctx.property_id, retrieved_at: ctx.retrieved_at }
  const now = ctx.now || new Date()
  const out = []
  switch (tool) {
    case 'eg.property_core': {
      const f = output.facts || {}
      const fr = freshnessFor({ as_of: output.provenance?.vendor_as_of, window_days: VENDOR_FRESH_DAYS.property_facts, now })
      const bits = [f.normalized_asset_class || f.property_type, f.units_count > 1 ? `${f.units_count} units` : null, f.total_bedrooms != null ? `${f.total_bedrooms} bd / ${f.total_baths ?? '?'} ba` : null, f.building_square_feet ? `${Number(f.building_square_feet).toLocaleString('en-US')} sqft` : null, f.year_built ? `built ${f.year_built}` : null].filter(Boolean)
      if (!bits.length) {
        out.push(unavailable(base, { finding_type: 'property_facts', key: 'core', source_id: 'lc.property_record', reason: 'facts_not_captured', citation: 'properties.*' }))
      } else {
        out.push(makeFinding({ ...base, finding_type: 'property_facts', key: 'core', source_id: 'lc.property_record', evidence_status: vendorStatus(fr), value: f, display_value: bits.join(' · '), observed_at: output.provenance?.vendor_as_of, freshness: fr, citation: 'properties (via getEntityGraphDossier summary)', limitations: fr.as_of_known ? [] : ['Vendor as-of date unknown.'] }))
      }
      break
    }
    case 'eg.ownership': {
      const fr = freshnessFor({ as_of: output.provenance?.vendor_as_of, window_days: VENDOR_FRESH_DAYS.ownership, now })
      const kindLabel = { individual: 'Individual', llc: 'LLC', company: 'Company', trust: 'Trust', estate: 'Estate', institution: 'Institution' }[output.owner_kind] || 'Unknown'
      const bits = [kindLabel, output.out_of_state_owner ? 'out-of-state' : output.out_of_state_owner === false ? 'in-state' : null, output.ownership_years != null ? `owned ${output.ownership_years} yrs` : null, output.owner_portfolio_count ? `${output.owner_portfolio_count} ${output.owner_portfolio_count === 1 ? 'property' : 'properties'} in portfolio` : null].filter(Boolean)
      out.push(makeFinding({ ...base, finding_type: 'ownership', key: 'owner_profile', source_id: 'lc.property_record', evidence_status: vendorStatus(fr), value: { owner_kind: output.owner_kind, owner_linked: output.owner_linked, is_corporate_owner: output.is_corporate_owner, out_of_state_owner: output.out_of_state_owner, ownership_years: output.ownership_years, owner_portfolio_count: output.owner_portfolio_count, owner_entity_count: output.owner_entity_count }, display_value: bits.join(' · '), observed_at: output.provenance?.vendor_as_of, freshness: fr, citation: 'properties.owner_* + master_owners (owner kind via classifyHolder)', limitations: ['Owner kind is LeadCommand\'s classifyHolder rule over the vendor owner-of-record; names are not stored.', ...(output.owner_linked ? [] : ['No master owner linked to this property.'])] }))
      break
    }
    case 'eg.recorded_documents': {
      if (!output.available) {
        for (const [ft, key] of [['mortgage', 'recorded_mortgages'], ['lien', 'recorded_liens'], ['foreclosure', 'recorded_foreclosures'], ['parcel', 'vendor_parcel']]) {
          out.push(unavailable(base, { finding_type: ft, key, source_id: ft === 'parcel' ? 'lc.vendor_parcel' : 'lc.recorded_documents', reason: 'records_read_failed', citation: 'entity_graph_property_records' }))
        }
        break
      }
      const parcel = output.parcel
      const vendorAsOfParcel = parcel?.last_observed_at || parcel?.updated_at || parcel?.valuation_date || null
      // mortgages
      const recMtg = (output.mortgages || []).filter((m) => m.recorded)
      if (recMtg.length) {
        const open = recMtg.filter((m) => m.open)
        const latest = [...recMtg].sort((a, b) => (ts(b.recorded) || 0) - (ts(a.recorded) || 0))[0]
        out.push(makeFinding({ ...base, finding_type: 'mortgage', key: 'recorded_mortgages', source_id: 'lc.recorded_documents', evidence_status: 'recorded', value: { recorded_count: recMtg.length, open_slot_count: open.length, latest_recorded: latest.recorded, latest_amount: latest.amount, instruments: recMtg.map((m) => ({ recorded: m.recorded, amount: m.amount, position: m.position, open_slot: m.open, loan_type: m.loan_type, private_lender: m.private_lender })) }, display_value: `${recMtg.length} recorded mortgage${recMtg.length === 1 ? '' : 's'} (${open.length} in open slots) · latest ${day(latest.recorded)}${latest.amount ? ` · ${money(latest.amount)}` : ''}`, observed_at: latest.recorded, freshness: { freshness_state: 'fresh', fresh_until: null, as_of_known: true }, citation: 'seller.property_mortgage.recording_date / loan_amount', limitations: open.length !== recMtg.length ? [] : ['Open-slot status is the vendor\'s, not a recorder release search.'] }))
        const est = open.filter((m) => m.est_balance != null)
        if (est.length) {
          const fr = freshnessFor({ as_of: vendorAsOfParcel, window_days: VENDOR_FRESH_DAYS.mortgage, now })
          const bal = est.reduce((s, m) => s + Number(m.est_balance || 0), 0)
          out.push(makeFinding({ ...base, finding_type: 'mortgage', key: 'vendor_loan_estimate', source_id: 'lc.vendor_parcel', evidence_status: vendorStatus(fr), value: { est_balance: bal, est_payment: est.reduce((s, m) => s + Number(m.est_payment || 0), 0) || null, rates: est.map((m) => m.rate).filter((r) => r != null) }, display_value: `Vendor-estimated open balance ${money(bal)}`, observed_at: vendorAsOfParcel, freshness: fr, citation: 'seller.property_mortgage.est_balance (vendor estimate)', limitations: ['Balance is an amortization estimate by the vendor, not a payoff figure.'] }))
        }
      } else {
        out.push(unavailable(base, { finding_type: 'mortgage', key: 'recorded_mortgages', source_id: 'lc.recorded_documents', reason: (output.mortgages || []).length ? 'mortgage_rows_without_recording_date' : 'none_in_vendor_recorded_feed', citation: 'seller.property_mortgage', limitations: ['No recorded mortgage in the vendor feed is NOT evidence the property is free and clear.'] }))
      }
      // liens
      const recLiens = (output.liens || []).filter((l) => l.recorded)
      if (recLiens.length) {
        const latest = [...recLiens].sort((a, b) => (ts(b.recorded) || 0) - (ts(a.recorded) || 0))[0]
        const cats = [...new Set(recLiens.map((l) => l.category || l.type).filter(Boolean))]
        const distress = recLiens.filter((l) => l.distress).length
        out.push(makeFinding({ ...base, finding_type: 'lien', key: 'recorded_liens', source_id: 'lc.recorded_documents', evidence_status: 'recorded', value: { recorded_count: recLiens.length, distress_count: distress, categories: cats, latest_recorded: latest.recorded, total_amount_due: recLiens.reduce((s, l) => s + Number(l.amount_due || 0), 0) || null, instruments: recLiens.map((l) => ({ recorded: l.recorded, category: l.category, type: l.type, amount_due: l.amount_due, distress: l.distress })) }, display_value: `${recLiens.length} recorded lien/filing${recLiens.length === 1 ? '' : 's'}${cats.length ? ` (${cats.slice(0, 3).join(', ')})` : ''}${distress ? ` · ${distress} distress` : ''} · latest ${day(latest.recorded)}`, observed_at: latest.recorded, freshness: { freshness_state: 'fresh', fresh_until: null, as_of_known: true }, citation: 'seller.property_lien.recording_date / doc_category', is_discovery: distress > 0 }))
      } else {
        out.push(unavailable(base, { finding_type: 'lien', key: 'recorded_liens', source_id: 'lc.recorded_documents', reason: (output.liens || []).length ? 'lien_rows_without_recording_date' : 'none_in_vendor_recorded_feed', citation: 'seller.property_lien', limitations: ['No recorded lien in the vendor feed is NOT evidence that none exists.'] }))
      }
      // foreclosures
      const recFc = (output.foreclosures || []).filter((f) => f.recorded || f.default_date)
      if (recFc.length) {
        const latest = [...recFc].sort((a, b) => (ts(b.recorded || b.default_date) || 0) - (ts(a.recorded || a.default_date) || 0))[0]
        out.push(makeFinding({ ...base, finding_type: 'foreclosure', key: 'recorded_foreclosures', source_id: 'lc.recorded_documents', evidence_status: 'recorded', value: { filing_count: recFc.length, latest_stage: latest.stage, latest_recorded: latest.recorded, default_date: latest.default_date, auction_date: latest.auction_date, unpaid_balance: latest.unpaid_balance }, display_value: `${recFc.length} foreclosure filing${recFc.length === 1 ? '' : 's'} · ${latest.stage || 'stage unknown'} · ${day(latest.recorded || latest.default_date)}${latest.auction_date ? ` · auction ${day(latest.auction_date)}` : ''}`, observed_at: latest.recorded || latest.default_date, freshness: { freshness_state: 'fresh', fresh_until: null, as_of_known: true }, citation: 'seller.property_foreclosure.recording_date / doc_type', is_discovery: true, limitations: ['A filing is not its outcome: reinstatement, sale or dismissal is not established here.'] }))
      } else {
        out.push(unavailable(base, { finding_type: 'foreclosure', key: 'recorded_foreclosures', source_id: 'lc.recorded_documents', reason: 'none_in_vendor_recorded_feed', citation: 'seller.property_foreclosure', limitations: ['No foreclosure filing in the vendor feed is NOT evidence that none exists.'] }))
      }
      // vendor parcel flags
      if (parcel) {
        const fr = freshnessFor({ as_of: vendorAsOfParcel, window_days: VENDOR_FRESH_DAYS.parcel, now })
        const flags = { tax_delinquent: parcel.tax_delinquent, tax_delinquent_year: parcel.tax_delinquent_year, active_lien: parcel.active_lien, open_mortgage_count: parcel.open_mortgage_count, total_loan_balance: parcel.total_loan_balance, equity_percent: parcel.equity_percent, preforeclosure_status: parcel.preforeclosure_status, is_vacant: parcel.is_vacant, is_mls_active: parcel.is_mls_active }
        const bits = [parcel.tax_delinquent === true ? `tax delinquent${parcel.tax_delinquent_year ? ` (${parcel.tax_delinquent_year})` : ''}` : parcel.tax_delinquent === false ? 'not tax delinquent' : null, parcel.active_lien === true ? 'active lien flag' : null, parcel.open_mortgage_count != null ? `${parcel.open_mortgage_count} open mortgage(s)` : null, parcel.preforeclosure_status ? `pre-foreclosure: ${parcel.preforeclosure_status}` : null, parcel.is_vacant === true ? 'vacant' : null].filter(Boolean)
        out.push(makeFinding({ ...base, finding_type: 'tax_status', key: 'vendor_parcel_flags', source_id: 'lc.vendor_parcel', evidence_status: vendorStatus(fr), value: flags, display_value: bits.length ? `Vendor: ${bits.join(' · ')}` : 'Vendor parcel snapshot (no distress flags set)', observed_at: vendorAsOfParcel, freshness: fr, citation: 'seller.property (vendor parcel snapshot)', limitations: ['"Not tax delinquent" here is the vendor\'s flag, not a county tax-collector read.'] }))
      } else {
        out.push(unavailable(base, { finding_type: 'tax_status', key: 'vendor_parcel_flags', source_id: 'lc.vendor_parcel', reason: 'no_vendor_parcel_row', citation: 'seller.property' }))
      }
      break
    }
    case 'eg.sales_history': {
      if (!output.available) {
        out.push(unavailable(base, { finding_type: 'transfer_history', key: 'recorded_transfers', source_id: 'lc.recorded_documents', reason: 'records_read_failed', citation: 'entity_graph_property_records.sales' }))
        break
      }
      const sales = (output.sales || []).filter((s) => s.date)
      if (sales.length) {
        const last = [...sales].sort((a, b) => (ts(b.date) || 0) - (ts(a.date) || 0))[0]
        const bits = [`Last transfer ${day(last.date)}`, last.price ? money(last.price) : 'price not disclosed', last.doc_type || null, last.cash === true ? 'cash' : null, last.arms_length === false ? 'non-arms-length' : null, last.buyer?.kind ? `buyer: ${last.buyer.kind}${last.buyer.status ? ` (${last.buyer.status})` : ''}` : null].filter(Boolean)
        out.push(makeFinding({ ...base, finding_type: 'transfer_history', key: 'recorded_transfers', source_id: 'lc.recorded_documents', evidence_status: 'recorded', value: { transfer_count: sales.length, last_date: last.date, last_price: last.price, last_doc_type: last.doc_type, last_cash: last.cash, last_arms_length: last.arms_length, transfers: sales.map((s) => ({ date: s.date, price: s.price, doc_type: s.doc_type, cash: s.cash, arms_length: s.arms_length, buyer_kind: s.buyer?.kind ?? null })) }, display_value: bits.join(' · '), observed_at: last.date, freshness: { freshness_state: 'fresh', fresh_until: null, as_of_known: true }, citation: 'seller.property_sale.event_date / price / doc_type', limitations: ['Buyer kind/activity is LeadCommand\'s buyer index resolution; names are not stored.'] }))
      } else {
        out.push(unavailable(base, { finding_type: 'transfer_history', key: 'recorded_transfers', source_id: 'lc.recorded_documents', reason: 'none_in_vendor_recorded_feed', citation: 'seller.property_sale', limitations: ['No transfer in the vendor feed is NOT evidence of no transfer.'] }))
      }
      if (output.owner_buyer) {
        const b = output.owner_buyer
        out.push(makeFinding({ ...base, finding_type: 'investor_demand', key: 'owner_is_buyer', source_id: 'lc.market_intelligence', evidence_status: 'internal_record', value: b, display_value: `Current owner is in the buyer index (${b.kind || 'entity'}${b.status ? `, ${b.status}` : ''}${b.purchases ? `, ${b.purchases} purchases` : ''})`, observed_at: null, freshness: { freshness_state: 'fresh', fresh_until: null, as_of_known: false }, citation: 'eg_property_owner_buyer → eg_buyer_index', is_discovery: true }))
      }
      break
    }
    case 'valuation.read': {
      const v = output.vendor || {}
      const fr = freshnessFor({ as_of: v.valuation_date || output.provenance?.vendor_as_of, window_days: VENDOR_FRESH_DAYS.valuation, now })
      let vendorValue = null
      if (v.estimated_value != null && v.estimated_value > 0) {
        vendorValue = makeFinding({ ...base, finding_type: 'valuation', key: 'vendor_value_estimate', source_id: 'lc.property_record', evidence_status: vendorStatus(fr), value: { estimated_value: v.estimated_value, value_low: v.value_low, value_high: v.value_high, value_confidence: v.value_confidence, valuation_date: v.valuation_date }, display_value: `Vendor AVM ${money(v.estimated_value)}${v.value_low && v.value_high ? ` (${money(v.value_low)}–${money(v.value_high)})` : ''}`, observed_at: v.valuation_date, freshness: fr, citation: 'properties.estimated_value / value_low / value_high', limitations: ['A vendor AVM is not a LeadCommand valuation lane (SFR investor cluster / MLS ARV / MF per unit or door).'] })
        out.push(vendorValue)
      } else {
        out.push(unavailable(base, { finding_type: 'valuation', key: 'vendor_value_estimate', source_id: 'lc.property_record', reason: 'vendor_value_not_captured', citation: 'properties.estimated_value' }))
      }
      const e = output.engine
      if (e && e.valuation_mid != null) {
        out.push(makeFinding({ ...base, finding_type: 'valuation', key: 'decision_engine_valuation', source_id: 'lc.decision_engine', evidence_status: 'internal_record', value: e, display_value: `Decision Engine ${money(e.valuation_mid)}${e.valuation_low && e.valuation_high ? ` (${money(e.valuation_low)}–${money(e.valuation_high)})` : ''}${e.comp_count != null ? ` · ${e.comp_count} comps` : ''}${e.decision_tier ? ` · tier ${e.decision_tier}` : ''}`, observed_at: e.computed_at, freshness: freshnessFor({ as_of: e.computed_at, window_days: 90, now }), citation: 'property_acquisition_scores.valuation_* (via column enrichment)', limitations: ['The engine row carries no valuation-lane label; treat as a reference, not the binding lane value.'] }))
      } else {
        out.push(unavailable(base, { finding_type: 'valuation', key: 'decision_engine_valuation', source_id: 'lc.decision_engine', reason: 'decision_engine_not_run', citation: 'property_acquisition_scores', limitations: ['The Decision Engine has not produced a valuation for this property.'] }))
      }
      const eq = output.equity || {}
      if (eq.known) {
        const rec = ['recorded_mortgage_balance', 'no_recorded_mortgage'].includes(eq.rule)
        const negativeBasis = eq.rule === 'no_recorded_mortgage'
        out.push(makeFinding({ ...base, finding_type: 'equity', key: 'equity_known_v1', source_id: 'lc.derived_rules', evidence_status: 'derived', value: { percent: eq.percent, amount: eq.amount, class: eq.class, rule: eq.rule }, display_value: `Equity ${eq.percent}% (${eq.class}) · rule ${eq.rule}`, observed_at: null, freshness: fr, citation: `equityTruth(rule ${eq.rule}) over properties.estimated_value${rec ? ' + v_entity_graph_properties.rec_mortgage_*' : ' + properties.total_loan_balance / flags'}`, basis_finding_ids: vendorValue ? [vendorValue.finding_id] : [], confidence_cap: negativeBasis ? 0.45 : Math.min(EVIDENCE_AUTHORITY_WEIGHT[vendorStatus(fr)] ?? 0.6, EVIDENCE_AUTHORITY_WEIGHT.derived), limitations: [...(negativeBasis ? ['Rests on NO open mortgage appearing in the vendor recorded-document feed, which is not proven complete.'] : []), 'Uses the vendor AVM as value; not a LeadCommand valuation lane.'] }))
      } else {
        out.push(unavailable(base, { finding_type: 'equity', key: 'equity_known_v1', source_id: 'lc.derived_rules', reason: eq.class && eq.class !== 'unknown' ? 'equity_percent_unknown_vendor_class_only' : 'equity_unknown_under_equity_known_v1', citation: 'equityTruth', limitations: ['Equity is unknown — never shown as 0% or 100%.'] }))
      }
      const flags = v.equity_flags || []
      if (flags.length) {
        out.push(makeFinding({ ...base, finding_type: 'equity', key: 'vendor_equity_flag', source_id: 'lc.property_record', evidence_status: vendorStatus(fr), value: { flags, class: flags.includes('free and clear') || flags.includes('high equity') ? 'high' : flags.includes('low equity') ? 'low' : 'unknown' }, display_value: `Vendor flag: ${flags.map((f) => f.replace(/\b\w/g, (c) => c.toUpperCase())).join(', ')}`, observed_at: v.valuation_date || output.provenance?.vendor_as_of, freshness: fr, citation: 'properties.property_flags_text (vendor equity flags)', limitations: ['A vendor equity flag gives a class, never a percentage (rule equity_known_v1).'] }))
      }
      break
    }
    case 'eg.outreach_state': {
      if (!output.available) {
        out.push(unavailable(base, { finding_type: 'outreach_state', key: 'outreach', source_id: 'lc.outreach', reason: output.reason || 'outreach_unavailable', citation: 'getEntityGraphOutreachState' }))
        break
      }
      const bits = [output.stage ? `stage ${output.stage.value} (${output.stage.source})` : 'no stage', output.status ? `status ${output.status.value}` : null, output.last_contact ? `last contact ${day(output.last_contact.at)} ${output.last_contact.direction}` : 'no contact on record', output.campaigns?.count ? `${output.campaigns.count} campaign(s)` : null, output.conversation?.suppressed ? 'thread suppressed' : null].filter(Boolean)
      const lim = output.unavailable_sources?.length ? [`Not read this pass: ${output.unavailable_sources.join(', ')}.`] : []
      const cr = output.contact_readiness
      if (cr) {
        const crLim = ['Contact evidence, not eligibility: campaign eligibility is the campaign target graph\'s verdict.']
        if (cr.state === 'relationship_unresolved') crLim.push('People / phones exist, but the entity-contact relationship requires review — this is not missing contact data.')
        if (cr.state === 'vendor_associated_phone') crLim.push('Phones are linked to the property by the vendor only; the owner identity is not resolved.')
        if (!cr.review_checked) crLim.push('Entity-contact review flags could not be read this pass.')
        if (cr.state === 'unknown') out.push(unavailable(base, { finding_type: 'outreach_state', key: 'contact_readiness', source_id: 'lc.outreach', reason: 'contact_reads_failed', citation: 'campaign_target_graph · prospects · entity-contact review', limitations: crLim }))
        else out.push(makeFinding({ ...base, finding_type: 'outreach_state', key: 'contact_readiness', source_id: 'lc.outreach', evidence_status: 'internal_record', value: cr, display_value: contactReadinessDisplay(cr), observed_at: null, freshness: { freshness_state: 'fresh', fresh_until: null, as_of_known: true }, citation: 'campaign_target_graph · prospects.linked_property_ids_json · seller.property_entity_contact_v1 (review flags)', limitations: crLim }))
      }
      out.push(makeFinding({ ...base, finding_type: 'outreach_state', key: 'outreach', source_id: 'lc.outreach', evidence_status: 'internal_record', value: { stage: output.stage, status: output.status, last_contact: output.last_contact, deal_linked: output.deal_linked, conversation: output.conversation, campaigns: output.campaigns, contact_candidates: output.contact_candidates }, display_value: bits.join(' · '), observed_at: output.last_contact?.at || null, freshness: { freshness_state: 'fresh', fresh_until: null, as_of_known: true }, citation: 'inbox_thread_state / acquisition_opportunities / campaign_targets', limitations: lim }))
      break
    }
    case 'eg.sms_eligibility': {
      if (!output.available) {
        out.push(unavailable(base, { finding_type: 'sms_eligibility', key: 'sms', source_id: 'lc.campaign_target_graph', reason: output.reason || 'sms_eligibility_unavailable', citation: 'campaign_target_graph' }))
        break
      }
      const lim = output.reviewChecked === false ? ['Entity-contact review flags could not be checked this pass.'] : []
      out.push(makeFinding({ ...base, finding_type: 'sms_eligibility', key: 'sms', source_id: 'lc.campaign_target_graph', evidence_status: 'internal_record', value: { eligible: output.eligible, reason: output.reason, rows: output.rows, ready: output.ready, review_checked: output.reviewChecked }, display_value: output.eligible ? `SMS-eligible (${output.ready}/${output.rows} graph rows ready)` : `Not SMS-eligible — ${output.reason}`, observed_at: output.generated_at, freshness: { freshness_state: 'fresh', fresh_until: null, as_of_known: true }, citation: 'campaign_target_graph → resolveCampaignTargetReadiness', limitations: lim }))
      break
    }
    case 'mi.zip_context': {
      if (!output.available) {
        out.push(unavailable(base, { finding_type: 'market_context', key: 'zip_market', source_id: 'lc.market_intelligence', reason: output.reason || 'zip_context_unavailable', citation: 'mi_geo_period_rollup' }))
        break
      }
      const bits = [`ZIP ${output.zip}`, output.sales1y != null ? `${output.sales1y} sales (1y)` : null, output.investorShare1y != null ? `${output.investorShare1y}% investor` : null, output.cashShare1y != null ? `${output.cashShare1y}% cash` : null, output.medianPrice1y ? `median ${money(output.medianPrice1y)}` : null].filter(Boolean)
      if (bits.length > 1) {
        out.push(makeFinding({ ...base, finding_type: 'market_context', key: 'zip_market', source_id: 'lc.market_intelligence', evidence_status: 'internal_record', value: { zip: output.zip, sales90d: output.sales90d, sales1y: output.sales1y, investorShare1y: output.investorShare1y, cashShare1y: output.cashShare1y, medianPrice1y: output.medianPrice1y, medianPpsf1y: output.medianPpsf1y, latestSale: output.latestSale, build_id: output.build_id }, display_value: bits.join(' · '), observed_at: output.latestSale, freshness: { freshness_state: 'fresh', fresh_until: null, as_of_known: Boolean(output.latestSale) }, citation: `mi_geo_period_rollup (build ${output.build_id ?? 'n/a'}, geo_level zip, asset all)` }))
      } else {
        out.push(unavailable(base, { finding_type: 'market_context', key: 'zip_market', source_id: 'lc.market_intelligence', reason: 'no_rollup_row_for_zip', citation: 'mi_geo_period_rollup' }))
      }
      if (output.buyers != null) {
        out.push(makeFinding({ ...base, finding_type: 'investor_demand', key: 'zip_buyers', source_id: 'lc.market_intelligence', evidence_status: 'internal_record', value: { buyers: output.buyers, active_buyers: output.activeBuyers }, display_value: `${output.buyers} buyers have bought in ZIP ${output.zip} · ${output.activeBuyers ?? '?'} active`, observed_at: null, freshness: { freshness_state: 'fresh', fresh_until: null, as_of_known: false }, citation: 'eg_buyer_index.zips (count)' }))
      } else {
        out.push(unavailable(base, { finding_type: 'investor_demand', key: 'zip_buyers', source_id: 'lc.market_intelligence', reason: 'buyer_count_unavailable', citation: 'eg_buyer_index' }))
      }
      if (!output.demographics_available) {
        out.push(unavailable(base, { finding_type: 'market_context', key: 'zip_demographics', source_id: 'lc.market_intelligence', reason: 'census_geo_metrics_empty', citation: 'census_geo_metrics', limitations: ['The demographics table is empty in production; nothing is inferred in its place.'] }))
      }
      break
    }
    case 'eg.street_view_availability': {
      if (output.image_reference_on_record) {
        out.push(makeFinding({ ...base, finding_type: 'street_view', key: 'availability', source_id: 'lc.property_record', source_class: 'internal_record', evidence_status: 'internal_record', value: { image_reference_on_record: true, image_host: output.image_host, has_coordinates: output.has_coordinates }, display_value: `Street View reference on record (${output.image_host})${output.has_coordinates ? ' · coordinates on file' : ''}`, observed_at: null, freshness: { freshness_state: 'fresh', fresh_until: null, as_of_known: false }, citation: 'properties.streetview_image (presence only)', limitations: ['Metadata only: no image was fetched or viewed; imagery date and condition are not established.'] }))
      } else {
        out.push(unavailable(base, { finding_type: 'street_view', key: 'availability', source_id: 'lc.property_record', reason: output.has_coordinates ? 'no_image_reference_on_record' : 'no_image_reference_or_coordinates', citation: 'properties.streetview_image', limitations: ['No reference on the record is not evidence that Street View imagery does not exist.'] }))
      }
      break
    }
    default:
      throw new AgentError('UNKNOWN_QUICK_SCAN_TOOL', tool)
  }
  return out
}

/** Unavailable findings for a tool that failed / timed out / was refused. */
export function unavailableFindingsForTool(tool, ctx, reason) {
  const base = { run_id: ctx.run_id, property_id: ctx.property_id, retrieved_at: ctx.retrieved_at }
  const map = {
    'eg.property_core': [['property_facts', 'core', 'lc.property_record']],
    'eg.ownership': [['ownership', 'owner_profile', 'lc.property_record']],
    'eg.recorded_documents': [['mortgage', 'recorded_mortgages', 'lc.recorded_documents'], ['lien', 'recorded_liens', 'lc.recorded_documents'], ['foreclosure', 'recorded_foreclosures', 'lc.recorded_documents'], ['tax_status', 'vendor_parcel_flags', 'lc.vendor_parcel']],
    'eg.sales_history': [['transfer_history', 'recorded_transfers', 'lc.recorded_documents']],
    'valuation.read': [['valuation', 'vendor_value_estimate', 'lc.property_record'], ['valuation', 'decision_engine_valuation', 'lc.decision_engine'], ['equity', 'equity_known_v1', 'lc.derived_rules']],
    'eg.outreach_state': [['outreach_state', 'outreach', 'lc.outreach']],
    'eg.sms_eligibility': [['sms_eligibility', 'sms', 'lc.campaign_target_graph']],
    'mi.zip_context': [['market_context', 'zip_market', 'lc.market_intelligence']],
    'eg.street_view_availability': [['street_view', 'availability', 'lc.property_record']],
  }
  return (map[tool] || []).map(([finding_type, key, source_id]) => unavailable(base, { finding_type, key, source_id, reason, citation: tool }))
}

// ── conflict model ──────────────────────────────────────────────────────────

function claim(f, text) {
  return f ? { finding_id: f.finding_id, claim: text, source_id: f.source_id, source_name: f.source_name, source_class: f.source_class, evidence_status: f.evidence_status, as_of: f.observed_at } : null
}

/**
 * Detect conflicts between a property's findings + the raw tool outputs.
 * A conflict is DECISIVE (resolved_by_rule) only when the higher-authority
 * claim is also fresher (DR §7.2). Otherwise it stays OPEN ("unresolved")
 * with the follow-up that would settle it.
 * @returns {Object[]} conflicts
 */
export function detectConflicts({ run_id, property_id, findings, outputs }) {
  const byKey = new Map(findings.map((f) => [`${f.finding_type}:${f.key}`, f]))
  const conflicts = []
  const recDocs = outputs['eg.recorded_documents']
  const valuation = outputs['valuation.read']
  if (!recDocs?.available) return conflicts
  const parcel = recDocs.parcel || {}
  const vendorAsOf = parcel.last_observed_at || parcel.updated_at || valuation?.provenance?.vendor_as_of || null
  const vendorFlags = valuation?.vendor?.equity_flags || []
  const vendorFreeClear = vendorFlags.includes('free and clear')
  const vendorLoan = num(valuation?.vendor?.total_loan_balance)
  const vendorShowsDebt = (vendorLoan !== null && vendorLoan > 0) || vendorFlags.includes('low equity') || num(parcel.open_mortgage_count) > 0
  const mtgFinding = byKey.get('mortgage:recorded_mortgages')
  const openRecorded = (recDocs.mortgages || []).filter((m) => m.open && m.recorded)
  const flagFinding = byKey.get('tax_status:vendor_parcel_flags') || byKey.get('valuation:vendor_value_estimate')
  const mk = (rule, finding_type, members, resolution) => {
    const conflict_group_id = `cfl_${hashCanonical({ run_id, property_id, rule }).slice(0, 20).replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)])}`
    return { conflict_group_id, property_id, finding_type, rule, members: members.filter(Boolean), ...resolution }
  }

  // C1 vendor "Free And Clear" vs a recorded mortgage in an open slot
  if (vendorFreeClear && openRecorded.length && mtgFinding && mtgFinding.evidence_status === 'recorded') {
    const latest = [...openRecorded].sort((a, b) => (ts(b.recorded) || 0) - (ts(a.recorded) || 0))[0]
    const fresher = ts(latest.recorded) !== null && ts(vendorAsOf) !== null && ts(latest.recorded) > ts(vendorAsOf)
    const vendorF = byKey.get('equity:vendor_equity_flag') || flagFinding
    const derivedEq = byKey.get('equity:equity_known_v1')
    const affected = derivedEq && derivedEq.value && ['free_and_clear', 'no_recorded_mortgage'].includes(derivedEq.value.rule) ? claim(derivedEq, `Equity ${derivedEq.value.percent}% under rule ${derivedEq.value.rule} rests on the vendor flag`) : null
    conflicts.push(mk('free_clear_flag_vs_recorded_mortgage', 'mortgage', [claim(vendorF, 'Vendor flags the property "Free And Clear"'), claim(mtgFinding, `A mortgage recorded ${day(latest.recorded)} sits in an open slot`), affected], fresher
      ? { resolution_state: 'resolved_by_rule', best_supported: claim(mtgFinding, `Debt is recorded after the vendor snapshot (${day(vendorAsOf)})`), reason: 'Recorded instrument outranks a vendor flag and is fresher than the vendor snapshot (DR §7.2).', remaining_uncertainty: 'Current balance and payoff status are not established.', follow_up: 'Confirm loan status with a payoff/release search at the county recorder.' }
      : { resolution_state: 'open', best_supported: null, reason: 'The recorded mortgage predates the vendor snapshot; a later release the feed lacks would make the vendor right.', remaining_uncertainty: 'Whether the recorded mortgage was released or satisfied.', follow_up: `Search the county recorder for a release/satisfaction of the mortgage recorded ${day(latest.recorded)}.` }))
  }

  // C2 vendor shows debt, but the recorded feed has no mortgage at all
  if (vendorShowsDebt && !(recDocs.mortgages || []).length) {
    const vendorF = byKey.get('mortgage:vendor_loan_estimate') || byKey.get('equity:vendor_equity_flag') || byKey.get('tax_status:vendor_parcel_flags')
    conflicts.push(mk('vendor_debt_vs_no_recorded_mortgage', 'mortgage', [claim(vendorF, `Vendor shows debt (${vendorLoan ? `loan balance ${money(vendorLoan)}` : vendorFlags.includes('low equity') ? '"Low Equity" flag' : 'open mortgage count'})`), claim(byKey.get('mortgage:recorded_mortgages'), 'No mortgage appears in the vendor recorded-document feed (unavailable, not absent)')],
      { resolution_state: 'open', best_supported: null, reason: 'Absence from a feed that is not proven complete cannot outweigh a positive claim.', remaining_uncertainty: 'Whether a mortgage is recorded and open.', follow_up: 'Run a county recorder grantor/grantee search for open mortgages.' }))
  }

  // C3 vendor lien flag vs recorded liens
  const liens = (recDocs.liens || []).filter((l) => l.recorded)
  const lienF = byKey.get('lien:recorded_liens')
  const parcelF = byKey.get('tax_status:vendor_parcel_flags')
  if (parcel.active_lien === true && !liens.length) {
    conflicts.push(mk('vendor_lien_flag_vs_no_recorded_lien', 'lien', [claim(parcelF, 'Vendor flags an active lien'), claim(lienF, 'No lien appears in the vendor recorded-document feed (unavailable, not absent)')],
      { resolution_state: 'open', best_supported: null, reason: 'A positive vendor flag with no supporting instrument in a feed not proven complete.', remaining_uncertainty: 'Whether a lien is recorded and unreleased.', follow_up: 'Search the county recorder / court index for liens and judgments.' }))
  } else if (parcel.active_lien === false && liens.length) {
    const latest = [...liens].sort((a, b) => (ts(b.recorded) || 0) - (ts(a.recorded) || 0))[0]
    const fresher = ts(latest.recorded) !== null && ts(vendorAsOf) !== null && ts(latest.recorded) > ts(vendorAsOf)
    conflicts.push(mk('vendor_no_lien_flag_vs_recorded_lien', 'lien', [claim(parcelF, 'Vendor shows no active lien'), claim(lienF, `A lien/filing was recorded ${day(latest.recorded)}`)], fresher
      ? { resolution_state: 'resolved_by_rule', best_supported: claim(lienF, 'A lien was recorded after the vendor snapshot'), reason: 'Recorded instrument is higher authority and fresher than the vendor flag.', remaining_uncertainty: 'Release status of the lien.', follow_up: 'Check for a release of the recorded lien.' }
      : { resolution_state: 'open', best_supported: null, reason: 'The lien predates the vendor snapshot; it may have been released.', remaining_uncertainty: 'Whether the recorded lien is still open.', follow_up: `Search for a release of the lien recorded ${day(latest.recorded)}.` }))
  }

  // C4 vendor "not tax delinquent" vs a recorded tax lien
  const taxLiens = liens.filter((l) => /tax/i.test(`${l.category || ''} ${l.type || ''} ${l.title || ''}`))
  if (parcel.tax_delinquent === false && taxLiens.length) {
    const latest = [...taxLiens].sort((a, b) => (ts(b.recorded) || 0) - (ts(a.recorded) || 0))[0]
    const fresher = ts(latest.recorded) !== null && ts(vendorAsOf) !== null && ts(latest.recorded) > ts(vendorAsOf)
    conflicts.push(mk('vendor_not_delinquent_vs_recorded_tax_lien', 'tax_status', [claim(parcelF, 'Vendor shows not tax delinquent'), claim(lienF, `A tax lien was recorded ${day(latest.recorded)}`)], fresher
      ? { resolution_state: 'resolved_by_rule', best_supported: claim(lienF, 'A tax lien was recorded after the vendor snapshot'), reason: 'Recorded instrument is higher authority and fresher.', remaining_uncertainty: 'Current tax balance.', follow_up: 'Read the county tax collector record.' }
      : { resolution_state: 'open', best_supported: null, reason: 'The tax lien predates the vendor snapshot; it may have been paid.', remaining_uncertainty: 'Current tax status.', follow_up: 'Read the county tax collector record for current delinquency.' }))
  }
  return conflicts
}
