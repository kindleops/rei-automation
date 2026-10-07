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
// The stub below returns a well-formed UNKNOWN result; the real model lives in
// ./model.js and replaces it via the re-export at the bottom of this file.

export const SCORE_VERSION = 'seller_situation_v2';
export const INPUT_MODEL_VERSION = 'raw_facts_v1';

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
 * @property {'A'|'B'|'C'|'UNKNOWN'} opportunity_tier   A acute (≥2 hard signals) / B stacked (1 strong + ≥2 supporting, or ≥4 supporting) / C soft / UNKNOWN (coverage too low)
 * @property {string[]} tier_reasons                    evidence codes that decided the tier
 * @property {EvidenceItem[]} evidence
 * @property {{fields_known:number, fields_total:number, ratio:number, missing:string[]}} coverage
 * @property {number} confidence                        0–1, from coverage + provenance quality
 * @property {{final_acquisition_score:number|null, structured_motivation_score:number|null, tag_distress_score:number|null, deal_strength_score:number|null}} legacy_shadow  comparison only
 */

/**
 * @param {SellerRawFacts} rawFacts
 * @param {{now?: Date|string, legacy?: Object}} [ctx]
 * @returns {SellerSituationResult}
 */
export function scoreSellerSituationStub(rawFacts, ctx = {}) {
  const legacy = { ...(rawFacts?.legacy ?? {}), ...(ctx?.legacy ?? {}) };
  return {
    score_version: SCORE_VERSION,
    input_model_version: INPUT_MODEL_VERSION,
    scored_at: new Date(ctx?.now ?? Date.now()).toISOString(),
    property_id: rawFacts?.property_id ?? null,
    components: {
      forced_sale_pressure: null,
      landlord_fatigue: null,
      equity_unlock: null,
      property_burden: null,
      tax_pain: null,
      debt_pressure: null,
    },
    sell_probability: { d90: null, d180: null, d365: null },
    seller_situation: 'NO_CLEAR_SITUATION',
    conversation_angle: null,
    opportunity_tier: 'UNKNOWN',
    tier_reasons: ['STUB'],
    evidence: [],
    coverage: { fields_known: 0, fields_total: 0, ratio: 0, missing: [] },
    confidence: 0,
    legacy_shadow: {
      final_acquisition_score: legacy.final_acquisition_score ?? null,
      structured_motivation_score: legacy.structured_motivation_score ?? null,
      tag_distress_score: legacy.tag_distress_score ?? null,
      deal_strength_score: legacy.deal_strength_score ?? null,
    },
  };
}

export const scoreSellerSituation = scoreSellerSituationStub;

/**
 * Batched loader. One query per source table for the whole id list.
 * @param {string[]} propertyIds
 * @param {{ query?: (sql:string, params:any[]) => Promise<{rows:any[]}>, from?: Function }} db
 * @returns {Promise<Map<string, SellerRawFacts>>}
 */
export async function loadSellerRawFacts(propertyIds, db) { // eslint-disable-line no-unused-vars
  return new Map();
}
