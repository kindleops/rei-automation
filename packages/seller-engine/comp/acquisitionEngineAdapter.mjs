// Adapter over the EXISTING Acquisition Engine V3 comp infrastructure
// (apps/api/src/lib/acquisition/compCandidateLoader.js — RPC
// get_comp_candidates_for_subject + buyer_comp_raw_v2 identity enrichment).
// We deliberately reuse its selection universe instead of inventing a second
// comp-selection algorithm (P3-8 mandate); this module only maps its candidate
// contract into the snapshot producer's input shape.
//
// Live use (Phase 4 pilot): call loadV3CompCandidates(subject, { db }) in
// apps/api context and pass the result here. This package never opens a
// database connection itself — candidates arrive as data (or fixtures).
import { priceQualifierClass } from '../lib/sentinels.mjs';

export const SOURCE_QUERY_VERSION = 'acq-v3/get_comp_candidates_for_subject@2026-07';

// Mirrors compCandidateLoader eligibilityWindow() so producer decisions agree
// with the loader's universe definition.
export function eligibilityWindow(assetFamily) {
  if (assetFamily === 'land') return { radiusMiles: 20, monthsBack: 48 };
  if (assetFamily === 'commercial') return { radiusMiles: 15, monthsBack: 48 };
  if (assetFamily === 'multifamily') return { radiusMiles: 7, monthsBack: 36 };
  return { radiusMiles: 4, monthsBack: 30 };
}

export function assetFamilyOf(assetClass) {
  if (assetClass === 'vacant_land') return 'land';
  if (['multifamily_5plus', 'apartments'].includes(assetClass)) return 'multifamily';
  if (['self_storage', 'retail', 'office', 'industrial_warehouse', 'mixed_use',
    'hospitality', 'specialty_commercial'].includes(assetClass)) return 'commercial';
  return 'residential';
}

// V3 candidate row (loader contract) -> producer candidate.
export function adaptCandidate(row) {
  return {
    comp_id: String(row.comp_id ?? row.id),
    sale_price: numOrNull(row.sale_price ?? row.mls_sold_price),
    sale_date: row.recording_date ?? row.sale_date ?? null,
    distance_miles: numOrNull(row.distance_miles ?? row.distance),
    building_square_feet: numOrNull(row.building_square_feet ?? row.building_sqft),
    year_built: numOrNull(row.effective_year_built ?? row.year_built),
    asset_class: row.asset_class ?? null,
    document_type: row.document_type ?? row.last_sale_doc_type ?? null,
    price_qualifier_raw: row.sales_price_code ?? null,
    condition_raw: row.building_condition ?? null,
    is_corporate_buyer: row.is_corporate_owner ?? null,
    raw_source: 'buyer_comp_raw_v2',
  };
}

export function adaptLoaderResult(loaderResult) {
  return {
    candidates: (loaderResult.candidates ?? []).map(adaptCandidate),
    diagnostics: loaderResult.diagnostics ?? {},
    source_query_version: SOURCE_QUERY_VERSION,
  };
}

export function transactionReliability(cand) {
  if (cand.price_qualifier_raw) return priceQualifierClass(cand.price_qualifier_raw);
  // fall back to deed-type signal when qualifier absent in comp source
  if (/quit claim|intrafamily|sheriff|foreclosure|deed in lieu/i.test(cand.document_type ?? '')) return 'distress_context';
  return cand.sale_price && cand.sale_price > 1000 ? 'valuation_caution' : 'unusable';
}

const numOrNull = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
