/**
 * Offline per-subject runner for the MERGED V3 shadow backtest
 * (scripts/acquisition-v3-merged-shadow-backtest.mjs --mode=run).
 *
 * Input: one cached read (subject row, geography, canonical rows strictly before
 * the as-of date, multi-parcel rows, buyer-demand rows). Runs the PRODUCTION
 * engine in SHADOW mode exactly as scoreProperty would with the canonical
 * loader, and the frozen v3.1 oracle on the same rows. No I/O, no writes.
 */
import { assembleCanonicalCandidates, investorSubjectFrom } from '../../src/lib/acquisition/v3CanonicalCandidates.js'

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const day = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null)

export function runMergedSubject(c, { engine, v31, engineGate, env = null }) {
  const pid = String(c.property_id)
  const nowDate = new Date(c.now)
  const asOf = c.as_of
  const subject = engine.normalizePropertyFeatures(c.raw, { source: 'properties', now: nowDate })
  const investorSubject = investorSubjectFrom({ subject, raw: c.raw, own: c.own, neighbors: c.neighbors })
  const assembled = assembleCanonicalCandidates({ rows: c.rows, subject, investorSubject, asOf, bulkRows: c.bulkRows })
  // Widened-rung rows (second read, only when cached) + an env without margin overrides.
  if (c.wideRows) assembled.investor_evidence.wideRows = c.wideRows
  assembled.investor_evidence.env = env ?? {}
  const t0 = Date.now()
  const d = engine.calculateAcquisitionDecision({
    subject, comps: [], buyerPurchases: c.buyerPurchases ?? [], now: nowDate,
    v3Enabled: true, v3Mode: 'shadow',
    v3CompCandidates: assembled.candidates, v3LoaderDiagnostics: assembled.diagnostics, v3InvestorEvidence: assembled.investor_evidence,
  })
  const engineMs = Date.now() - t0
  const v = d.evidence?.v3_shadow
  if (!v) return { property_id: pid, error: 'no_v3_shadow_block' }
  const inv = v.universes?.LOCAL_INVESTOR_VALUE ?? {}
  const co = v.cash_offer ?? {}
  const oa = v.offer_authorization ?? {}
  const selected = (inv.comps ?? [])
  const leak = selected.filter((x) => day(x.sold_on) >= asOf || String(x.property_id) === pid).length
    + assembled.candidates.filter((x) => (x.sale_date && day(x.sale_date) >= asOf) || String(x.property_id) === pid).length

  // Frozen v3.1 oracle on the same cached rows (parity).
  let oracle = null
  if (v31 && engineGate) {
    const gate = engineGate(subject, nowDate)
    const o = v31.valueSubjectV3({ subject: c.s3, rows: c.rows, bulkRows: c.bulkRows, asOf, gate })
    oracle = { value: o.value.mid, method: o.value.method, confidence: o.value.confidence, n: o.value.selected, offer: o.offer.recommended_cash_offer, ceiling: o.offer.buyer_ceiling, lane: o.value.lane }
  }
  return {
    property_id: pid, frame: c.frame, as_of: asOf,
    subject: { market: c.raw?.market ?? null, address: subject.address, asset_family: subject.asset_family, units: subject.units ?? null, lane: v.merged?.offer_lane ?? null, investor_subject_matches_cache: investorSubject.census_tract === c.s3.census_tract && investorSubject.units === c.s3.units },
    shadow_proof: {
      // In SHADOW the V2 objects must be untouched by V3 and evidence.v3 must stay null.
      evidence_v3_is_null: d.evidence.v3 === null,
      decision_v3_is_null: d.v3 === null,
      v2_valuation_override: Boolean(d.valuation?.calculation?.v3_override),
      authority_mode: v.authority?.mode ?? null,
    },
    merged: {
      engine_version: v.engine_version, formula_version: v.formula_version,
      execution_state: v.execution_state, value_classification: v.value_classification, final_confidence: v.final_confidence,
      investor: { available: Boolean(inv.available), mid: inv.mid ?? null, low: inv.low ?? null, high: inv.high ?? null, method: inv.method ?? null, confidence: inv.confidence ?? null, n: inv.accepted_independent_transaction_count ?? 0, n_eff: inv.effective_sample_size ?? null, reason: inv.unavailable_reason ?? null, per_door: inv.per_door ?? null, weighted_distance: inv.investor_value?.weighted_distance_miles ?? null },
      market_mid: v.reconciliation?.reconciled_market_value_mid ?? null,
      exit_base: v.reconciliation?.base_investor_exit ?? null,
      offer: co.available ? { recommended: co.recommended_cash_offer, minimum: co.minimum_acceptable_offer, ceiling: co.buyer_ceiling, investor_price: co.investor_value, spread: co.projected_assignment_fee, calibration_pct: co.calibration_pct, margin_pct: co.margin_pct, margin_source: co.margin_source, haircut_pct: co.confidence_haircut_pct, offer_to_value: co.sanity?.offer_to_value, reasons: co.reasons, per_unit: co.per_unit ?? null } : { unavailable: co.unavailable_reason ?? 'n/a' },
      lane: v.merged?.lane ?? null, rung: v.merged?.rung ?? null, ring: v.merged?.ring ?? null, radius_miles: v.merged?.radius_miles ?? null, grade: v.merged?.confidence_grade ?? null, identity: v.merged?.identity ?? null,
      institutional: v.merged?.institutional ?? null, retail_arv: v.merged?.retail_arv ?? null, flipper: v.merged?.flipper_signal ?? null,
      noi: v.merged?.noi_cross_check ?? null, condition_position: v.merged?.condition_position ?? null, ladder: v.merged?.ladder ?? [],
      authorized_recommended: oa.authorized_recommended_offer ?? null,
      authorized_ceiling: oa.authorized_buyer_ceiling ?? null,
      scenario_recommended: oa.scenario_recommended_offer ?? null,
      gates: v.merged?.gates ?? [],
      asset_identity_conflict: v.merged?.asset_identity_conflict ?? null,
      repair: { source: v.repair?.repair_source ?? null, confidence: v.repair?.repair_confidence ?? null },
      material_anomaly_reasons: (v.material_anomaly_reasons ?? []).slice(0, 6),
      reasons_tail: (v.execution_state_basis?.reasons ?? []).slice(-4),
      loader: assembled.diagnostics,
      selected_comps: selected.slice(0, 12).map((x) => ({ comp_id: x.comp_id, sold_on: x.sold_on, price: x.price, adjusted_price: x.adjusted_price, distance_miles: x.distance_miles, buyer_type: x.buyer_type, share: x.share })),
    },
    oracle_v31: oracle,
    leak,
    engine_ms: engineMs,
  }
}
