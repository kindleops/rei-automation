// ─── seller-situation/index.js ──────────────────────────────────────────────
// SELLER SITUATION v2 — raw-facts seller selection model (Acquisition OS §2–10).
//
// CONTRACT (published first so ranking/screener/Composer and negotiation can
// code against it; see CONTRACT_seller_situation.md in the job folder).
//
//   scoreSellerSituation(rawFacts, ctx) -> SellerSituationResult   (pure, sync)
//   loadSellerRawFacts(propertyIds, db)  -> Map<property_id, SellerRawFacts>
//                                           (batched: one query per source
//                                            table per call, never per row)
//
// Hard rules:
//   * NO Podio-era input. final_acquisition_score / structured_motivation_score
//     / tag_distress_score / deal_strength_score / podio_tags / ai_score /
//     master_owners.*_score are NEVER read as inputs. They may be passed in
//     ctx.legacy and are echoed back under `legacy_shadow` for comparison only.
//   * Protected classes are never inputs (race/ethnicity, national origin,
//     language, sex, religion, disability, familial status). Age / marital
//     status are not inputs of THIS model at all (they are negotiation-only,
//     state-gated, see negotiation-signal-opening-config.js).
//   * Not monetary authority (§75). Rows target / rank / explain / pick an
//     angle; they never produce a quoted amount.
//
// Implementation: ./model.js (scoring), ./loader.js (batched raw facts),
// ./codec.js (slim storage row), ./flag.js (SELLER_SCORING_RAW_FACTS double gate).

/** @typedef {'forced_sale_pressure'|'landlord_fatigue'|'equity_unlock'|'property_burden'|'tax_pain'|'debt_pressure'} ComponentKey */

/**
 * @typedef {Object} EvidenceItem
 * @property {string} code            stable evidence code, e.g. 'TAX_DELINQUENT', 'LIEN_RECORDED', 'VACANT_VENDOR_FLAG'
 * @property {number} points          contribution to `component` (0–100 scale component)
 * @property {ComponentKey} component
 * @property {string} source_table    e.g. 'properties', 'master_owners', 'prospects', 'seller.tax_records'
 * @property {string} source_field    e.g. 'tax_delinquent', 'property_flags_text'
 * @property {string|number|boolean|null} value  the raw value that fired (scalar, trimmed)
 * @property {'vendor_record'|'public_record'|'derived_ratio'|'vendor_flag'|'formula_estimate'} provenance
 */

/**
 * @typedef {Object} SellerRawFacts
 * @property {string} property_id
 * @property {string|null} master_owner_id
 * @property {string|null} state          2-letter property state
 * @property {string|null} market
 * @property {string|null} zip
 * @property {string|null} asset_lane     'sfr' | 'small_mf' | 'mf' | 'commercial' | 'land' | 'other'
 * @property {Object<string, any>} facts  normalized raw facts (see model.js FACT_FIELDS); null = unknown
 * @property {Object<string, {table:string, field:string}>} sources  fact key -> source column
 * @property {Object<string, number|null>} legacy  Podio-era values, SHADOW ONLY (never read by the model)
 */

/**
 * @typedef {Object} SellerSituationResult
 * @property {'seller_situation_v2'} score_version
 * @property {'raw_facts_v1'} input_model_version
 * @property {string} scored_at                         ISO timestamp (ctx.now)
 * @property {string} property_id
 * @property {Record<ComponentKey, number|null>} components   0–100; null = no evidence coverage for that component
 * @property {{d90:number|null, d180:number|null, d365:number|null}} sell_probability  percent 0–95; heuristic, NOT a calibrated probability until §10 sign-off
 * @property {string} seller_situation                  'FINANCIALLY_PRESSURED'|'FATIGUED_LANDLORD'|'EQUITY_RICH_ABSENTEE'|'INHERITED_PROBATE'|'TAX_DISTRESSED'|'HIGH_REPAIR_BURDEN'|'WEALTH_PRESERVATION'|'NO_CLEAR_SITUATION'
 * @property {string|null} conversation_angle           'SPEED_CERTAINTY'|'AS_IS_NO_REPAIRS'|'TENANT_RELIEF'|'CONVENIENCE'|'TAX_FLEXIBILITY'|'SELLER_FINANCE'|'LEASE_OPTION'|null (null unless evidence supports one)
 * @property {'A'|'B'|'C'|'UNKNOWN'} opportunity_tier   A acute (≥2 hard families, or 1 acute hard signal + equity ≥40%) / B stacked (1 hard + ≥2 supporting, or ≥4 supporting) / C soft / UNKNOWN (coverage too low)
 * @property {string[]} tier_reasons                    evidence codes that decided the tier
 * @property {EvidenceItem[]} evidence
 * @property {string[]} hard_signal_families           TAX / FORECLOSURE / LEGAL_LIEN / PROBATE / VACANCY / CONDITION that fired
 * @property {string} weights_version
 * @property {{fields_known:number, fields_total:number, ratio:number, missing:string[]}} coverage
 * @property {number} confidence                        0–1, from coverage + provenance quality
 * @property {{final_acquisition_score:number|null, structured_motivation_score:number|null, tag_distress_score:number|null, deal_strength_score:number|null}} legacy_shadow  comparison only
 */

export {
  SCORE_VERSION,
  INPUT_MODEL_VERSION,
  WEIGHTS_VERSION,
  COMPONENTS,
  EXCLUDED_INPUTS,
  VENDOR_FLAG_CODES,
  FACT_FIELDS,
  CORE_FIELDS,
  HARD_FAMILIES,
  SUPPORTING_CODES,
  STRONG_SUPPORTING_CODES,
  scoreSellerSituation,
  buildRawFactsFromRows,
  parseVendorFlags,
  resolveSituation,
  engineMotivationDistress,
} from './model.js';
export { loadSellerRawFacts, loaderColumns, MAX_IDS_PER_CALL } from './loader.js';
export { EVIDENCE_CATALOG, evidenceLabel, whyTargeted } from './evidence-catalog.js';
export { encodeSellerSituationRow, decodeEvidence, rowBytes, SOURCE_REGISTRY, ROW_COLUMNS } from './codec.js';
export {
  SELLER_SCORING_RAW_FACTS_ENV,
  SELLER_SCORING_RAW_FACTS_CONTROL,
  primeSellerScoringRawFactsFlag,
  isSellerScoringRawFactsActive,
} from './flag.js';
