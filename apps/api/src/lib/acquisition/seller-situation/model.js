// ─── seller-situation/model.js ──────────────────────────────────────────────
// SELLER SITUATION v2 · input model raw_facts_v1 (Acquisition OS §2–6, §14, §78).
//
// Pure + deterministic. Every point carries an evidence item (code, component,
// source table/field, value, provenance). No Podio-era score, no protected
// class, no age/marital/familial proxy is EVER read here: see EXCLUDED_INPUTS
// (pinned by tests/critical/seller-situation-v2.test.mjs).
//
// SOURCES (field coverage measured on prod 2026-10-07, see A1/REPORT.md):
//   seller.property_features_v1  (feature_version v1.0.0, as_of 2026-08-07) — PRIMARY.
//       Built from the DealMachine property record + recorded documents
//       (seller.property_lien / property_foreclosure / property_mortgage / property_sale).
//   public.properties            — FALLBACK per fact when the feature row is
//       missing (≈3% of properties) + the DealMachine flag list
//       (property_flags_text). Same import as seller.property: tax_delinquent and
//       active_lien agree 100% on a 10% sample.
// A fact names the table it came from; the two sources are never blended
// silently (§78).

export const SCORE_VERSION = 'seller_situation_v2';
export const INPUT_MODEL_VERSION = 'raw_facts_v1.1';
// raw_facts_v1.1 (owner rule 2026-10-07): a blank or 0 loan balance means
// equity UNKNOWN, never 100%. Equity % / LTV are known only when loan > 0 AND
// value > 0; otherwise only an explicit DealMachine flag gives a CLASS
// ("Free And Clear" / "High Equity" = high, "Low Equity" = low) with
// provenance vendor_flag. No flag ⇒ equity_unlock is null and coverage drops.
export const WEIGHTS_VERSION = 'ssv2_weights_2026_10_07b';

export const COMPONENTS = Object.freeze([
  'forced_sale_pressure',
  'landlord_fatigue',
  'equity_unlock',
  'property_burden',
  'tax_pain',
  'debt_pressure',
]);

/**
 * Inputs this model must never read. Legacy = Podio-era outputs (§3);
 * fairness = protected classes or direct proxies (owner rule 2026-10-06:
 * protected classes are never inputs; age is shadow-only for negotiation and
 * NOT an input to targeting; marital status is state-gated for negotiation and
 * NOT an input to targeting).
 */
export const EXCLUDED_INPUTS = Object.freeze({
  legacy: Object.freeze([
    'final_acquisition_score',
    'structured_motivation_score',
    'tag_distress_score',
    'deal_strength_score',
    'distress_purchase_score',
    'ai_score',
    'podio_tags',
    'priority_tier',
    'financial_pressure_score',
    'urgency_score',
    'priority_score',
    'contactability_score',
    'seller_tags_text', // Podio-era tag mirror (4.5% populated); the DealMachine list is property_flags_text
    'seller_tags_json',
    'motivation_score', // seller.property_scores_v1 (another model's output)
    'distress_score',
  ]),
  fairness: Object.freeze([
    'own_senior_owner_vendor', // age proxy
    'vendor_empty_nester', // age + familial-status proxy
    'life_divorce_event', // marital status
    'est_household_income',
    'net_asset_value',
    'buying_power',
    'language',
    'race',
    'ethnicity',
    'national_origin',
    'religion',
    'sex',
    'gender',
    'disability',
    'familial_status',
    'marital_status',
    'age',
    'birth_date',
  ]),
  vendor_flags: Object.freeze(['senior owner', 'empty nester', 'cash buyer', 'likely to move']),
});

/** DealMachine flags that are evidence. Anything else in the list is ignored. */
export const VENDOR_FLAG_CODES = Object.freeze({
  'tired landlord': 'VF_TIRED_LANDLORD',
  'heavily dated': 'VF_HEAVILY_DATED',
  'no updates': 'VF_NO_UPDATES',
  'vacant home': 'VF_VACANT',
  'tax delinquent': 'VF_TAX_DELINQUENT',
  preforeclosure: 'VF_PREFORECLOSURE',
  probate: 'VF_PROBATE',
  'active lien': 'VF_ACTIVE_LIEN',
  'out of state owner': 'VF_OUT_OF_STATE',
  'absentee owner': 'VF_ABSENTEE',
  'high equity': 'VF_HIGH_EQUITY',
  'free and clear': 'VF_FREE_AND_CLEAR',
  'adjustable loan': 'VF_ADJUSTABLE_LOAN',
  'low equity': 'VF_LOW_EQUITY',
  'bank owned': 'VF_BANK_OWNED',
});

// Fact keys + their primary (features) and fallback (properties) columns.
// [factKey, featuresField|null, propertiesField|null, provenance]
export const FACT_FIELDS = Object.freeze([
  ['tax_delinquent', 'lien_tax_delinquent', 'tax_delinquent', 'public_record'],
  ['tax_delinquent_years', 'lien_tax_delinq_years', null, 'public_record'],
  ['tax_lien', 'lien_has_tax', null, 'public_record'],
  ['lien_active', 'lien_active', 'active_lien', 'public_record'],
  ['lien_judgment', 'lien_has_judgment', null, 'public_record'],
  ['lien_lis_pendens', 'lien_has_lis_pendens', null, 'public_record'],
  ['lien_municipal', 'lien_has_municipal', null, 'public_record'],
  ['lien_hoa', 'lien_has_hoa', null, 'public_record'],
  ['lien_amount_due', 'lien_total_amount_due', null, 'public_record'],
  ['foreclosure_any', 'fcl_any', 'is_preforeclosure', 'public_record'],
  ['foreclosure_stale', 'fcl_stale_nod', null, 'public_record'],
  ['foreclosure_stage', 'fcl_stage', null, 'public_record'],
  ['auction_within_90d', 'fcl_auction_within_90d', null, 'public_record'],
  ['probate', 'life_probate', null, 'public_record'],
  ['death_event', 'life_death_event', null, 'public_record'],
  ['entity_dissolved', 'ent_owner_dissolved', null, 'public_record'],
  ['vacant', 'phy_is_vacant', null, 'vendor_record'],
  ['owner_occupied', 'own_owner_occupied', null, 'vendor_record'],
  ['absentee', 'own_absentee', null, 'vendor_record'],
  ['absentee_class', 'own_absentee_class', null, 'vendor_record'],
  ['out_of_state', null, 'out_of_state_owner', 'vendor_record'],
  ['corporate', 'own_is_corporate', 'is_corporate_owner', 'vendor_record'],
  ['bank_reo', 'own_is_bank_reo', null, 'vendor_record'],
  ['tenure_years', 'own_tenure_years', 'ownership_years', 'vendor_record'],
  ['portfolio_count', 'prt_total_properties', null, 'vendor_record'],
  ['tired_landlord_corroborated', 'prt_tired_landlord_corroborated', null, 'derived_ratio'],
  ['estimated_value', 'val_estimated_value', 'estimated_value', 'vendor_record'],
  ['equity_percent', 'eqt_equity_percent', 'equity_percent', 'vendor_record'],
  ['free_and_clear', 'eqt_free_and_clear', null, 'vendor_record'],
  ['high_equity_corroborated', 'eqt_high_equity_corroborated', null, 'derived_ratio'],
  ['ltv', 'eqt_ltv', null, 'derived_ratio'],
  ['loan_balance', 'dbt_total_balance', 'total_loan_balance', 'vendor_record'],
  ['monthly_payment', 'dbt_total_payment_mo', 'total_loan_payment', 'vendor_record'],
  ['payment_to_value', 'dbt_payment_to_value', null, 'derived_ratio'],
  ['arm', 'dbt_has_adjustable', null, 'public_record'],
  ['maturity_24m', 'dbt_maturity_within_24m', null, 'public_record'],
  ['junior_liens', 'dbt_junior_lien_count', null, 'public_record'],
  ['annual_tax', 'val_tax_amount', 'tax_amt', 'vendor_record'],
  ['eff_tax_rate', 'val_eff_tax_rate', null, 'derived_ratio'],
  ['appreciation_ratio', 'txn_appreciation_ratio', null, 'derived_ratio'],
  ['price_reliable', 'txn_price_reliable', null, 'public_record'],
  ['condition_class', 'phy_condition_class', null, 'vendor_record'],
  ['condition_text', null, 'building_condition', 'vendor_record'],
  ['year_built', 'phy_year_built', 'year_built', 'vendor_record'],
  ['repair_tier', 'phy_repair_tier', null, 'formula_estimate'],
  ['asset_class', 'phy_asset_class', 'normalized_asset_class', 'vendor_record'],
  ['units', 'phy_units_count', 'units_count', 'vendor_record'],
  ['buyer_liquidity', 'dsp_buyer_liquidity', null, 'derived_ratio'],
  ['sale_velocity_5y', 'mkt_sale_velocity_5y', null, 'derived_ratio'],
  ['as_of_date', 'as_of_date', null, 'vendor_record'],
]);

/** Fields that decide coverage (a component is unknown when all of its fields are). */
export const CORE_FIELDS = Object.freeze([
  'tax_delinquent', 'lien_active', 'foreclosure_any', 'probate', 'vacant', 'absentee',
  'tenure_years', 'equity_known', 'ltv', 'annual_tax', 'condition_class', 'year_built',
  'portfolio_count', 'estimated_value',
]);

const COMPONENT_FIELDS = Object.freeze({
  forced_sale_pressure: ['tax_delinquent', 'lien_active', 'foreclosure_any', 'probate', 'vacant'],
  landlord_fatigue: ['absentee', 'owner_occupied', 'out_of_state', 'tenure_years', 'portfolio_count'],
  equity_unlock: ['equity_percent', 'equity_class'],
  property_burden: ['condition_class', 'condition_text', 'year_built', 'vacant'],
  tax_pain: ['tax_delinquent', 'annual_tax', 'eff_tax_rate'],
  debt_pressure: ['ltv'],
});

const CONDITION_TEXT_CLASS = Object.freeze({ unsound: 1, poor: 2, fair: 3, average: 4, good: 5, 'very good': 6, excellent: 7 });

// ── helpers ────────────────────────────────────────────────────────────────
function clean(v) { return String(v ?? '').trim(); }
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(v) {
  if (v === true || v === false) return v;
  if (v === null || v === undefined || v === '') return null;
  const s = clean(v).toLowerCase();
  if (['true', 't', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', 'f', '0', 'no', 'n'].includes(s)) return false;
  return null;
}
function clamp(n, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, n)); }
function known(v) { return v !== null && v !== undefined && v !== ''; }
function scalar(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Math.round(v * 10000) / 10000;
  if (typeof v === 'boolean') return v;
  return clean(v).slice(0, 40);
}

/**
 * Owner rule 2026-10-07 (raw_facts_v1.1). Mutates facts/sources:
 *   loan > 0 AND value > 0 ⇒ equity_percent (vendor % if present, else computed) and ltv are KNOWN;
 *   otherwise equity_percent / ltv / free_and_clear / high_equity_corroborated are UNKNOWN (null) —
 *   a 0 or blank loan balance is not evidence of 100% equity, and LTV 0 is not evidence of no debt;
 *   equity_class comes ONLY from an explicit DealMachine flag (free_and_clear | high | low), provenance vendor_flag.
 */
export function applyEquityKnownRule(facts, sources, flags) {
  const loan = num(facts.loan_balance);
  const value = num(facts.estimated_value);
  const loanKnown = loan !== null && loan > 0 && value !== null && value > 0;
  if (loanKnown) {
    if (num(facts.equity_percent) === null) {
      facts.equity_percent = Math.round(((value - loan) / value) * 1000) / 10;
      sources.equity_percent = { ...(sources.loan_balance || {}), field: sources.loan_balance?.field ?? 'loan_balance', provenance: 'derived_ratio' };
    }
    if (num(facts.ltv) === null || num(facts.ltv) === 0) {
      facts.ltv = loan / value;
      sources.ltv = { ...(sources.loan_balance || {}), field: sources.loan_balance?.field ?? 'loan_balance', provenance: 'derived_ratio' };
    }
  } else {
    for (const k of ['equity_percent', 'ltv', 'free_and_clear', 'high_equity_corroborated', 'payment_to_value']) {
      facts[k] = null;
      delete sources[k];
    }
  }
  facts.free_and_clear = null; // a computed 0-loan "free & clear" is never evidence; only the vendor flag is
  delete sources.free_and_clear;
  const f = flags instanceof Set ? flags : new Set();
  facts.equity_class = f.has('free and clear') ? 'free_and_clear' : f.has('high equity') ? 'high' : f.has('low equity') ? 'low' : null;
  if (facts.equity_class) sources.equity_class = { table: 'properties', field: 'property_flags_text', provenance: 'vendor_flag' };
  facts.equity_known = loanKnown || facts.equity_class !== null ? true : null;
  if (facts.equity_known) sources.equity_known = loanKnown ? sources.equity_percent : sources.equity_class;
}

export function isoDay(v) {
  if (v instanceof Date) {
    if (Number.isNaN(v.valueOf())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  const s = clean(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

export function parseVendorFlags(text) {
  const out = new Set();
  const raw = Array.isArray(text) ? text.join(';') : clean(text);
  if (!raw) return out;
  for (const part of raw.split(/[;,|]/)) {
    const k = part.trim().toLowerCase();
    if (VENDOR_FLAG_CODES[k]) out.add(k);
  }
  return out;
}

function normalizeAssetLane(assetClass, units) {
  const a = clean(assetClass).toLowerCase();
  const u = num(units);
  if (a === 'sfr' || a.includes('single')) return 'sfr';
  if (a.includes('condo') || a.includes('town')) return 'condo_town';
  if (a === 'small_multi' || (u !== null && u >= 2 && u <= 4)) return 'small_mf';
  if (a.includes('multi') || (u !== null && u >= 5)) return 'mf';
  if (a.includes('land')) return 'land';
  if (a.includes('commercial') || a.includes('retail') || a.includes('office')) return 'commercial';
  return a ? 'other' : null;
}

/**
 * Build SellerRawFacts from one property's source rows. `features` is a
 * seller.property_features_v1 row (or null), `property` a public.properties row.
 * Legacy Podio values are copied to `legacy` (shadow only) and nowhere else.
 */
export function buildRawFactsFromRows({ property = null, features = null } = {}) {
  const p = property || {};
  const f = features || null;
  const facts = {};
  const sources = {};
  for (const [key, fField, pField, provenance] of FACT_FIELDS) {
    let value = null;
    let src = null;
    if (f && fField && known(f[fField])) {
      value = f[fField];
      src = { table: 'seller.property_features_v1', field: fField, provenance };
    } else if (pField && known(p[pField])) {
      value = p[pField];
      // A properties column is the vendor's copy, even of a recorded-document fact.
      src = { table: 'properties', field: pField, provenance: provenance === 'public_record' ? 'vendor_record' : provenance };
    }
    facts[key] = value;
    if (src) sources[key] = src;
  }
  applyEquityKnownRule(facts, sources, parseVendorFlags(p.property_flags_text ?? p.property_flags_json));
  // pg returns `date` columns as a local-midnight Date: keep the calendar day, never String(Date).
  for (const k of ['as_of_date']) if (facts[k] !== null) facts[k] = isoDay(facts[k]);
  // Foreclosure fallback on properties spans several boolean columns.
  if (!sources.foreclosure_any) {
    const cols = ['is_foreclosure', 'is_preforeclosure', 'is_pre_foreclosure', 'is_hot_preforeclosure', 'is_hot_pre_foreclosure'];
    const hit = cols.find((c) => bool(p[c]) === true);
    if (hit) { facts.foreclosure_any = true; sources.foreclosure_any = { table: 'properties', field: hit, provenance: 'vendor_record' }; }
  }
  // Absentee/owner-occupied fallback from properties.owner_location.
  if (!sources.absentee && known(p.owner_location)) {
    const loc = clean(p.owner_location).toLowerCase();
    if (loc.includes('owner occupied') || loc.includes('owner-occupied')) {
      facts.absentee = false; facts.owner_occupied = true;
    } else if (loc.includes('absentee') || loc.includes('out of state')) {
      facts.absentee = true; facts.owner_occupied = false;
    }
    if (facts.absentee !== null) {
      sources.absentee = { table: 'properties', field: 'owner_location', provenance: 'vendor_record' };
      sources.owner_occupied = sources.absentee;
    }
  }
  // out_of_state from the features absentee class when the properties column is absent.
  if (!sources.out_of_state && f && known(f.own_absentee_class)) {
    facts.out_of_state = clean(f.own_absentee_class) === 'out_of_state';
    sources.out_of_state = { table: 'seller.property_features_v1', field: 'own_absentee_class', provenance: 'vendor_record' };
  }
  const flags = parseVendorFlags(p.property_flags_text ?? p.property_flags_json);
  const units = num(facts.units);
  return {
    property_id: clean(p.property_id ?? f?.property_id) || null,
    master_owner_id: clean(p.master_owner_id) || null,
    state: clean(p.property_address_state ?? p.property_state ?? p.state).toUpperCase().slice(0, 2) || null,
    market: clean(p.market) || null,
    zip: clean(p.property_address_zip ?? p.property_zip).slice(0, 5) || null,
    asset_lane: normalizeAssetLane(facts.asset_class ?? p.property_type, units),
    facts,
    sources,
    vendor_flags: [...flags].sort(),
    vendor_flags_source: flags.size ? { table: 'properties', field: 'property_flags_text', provenance: 'vendor_flag' } : null,
    has_features: Boolean(f),
    legacy: {
      final_acquisition_score: num(p.final_acquisition_score),
      structured_motivation_score: num(p.structured_motivation_score),
      tag_distress_score: num(p.tag_distress_score),
      deal_strength_score: num(p.deal_strength_score),
    },
  };
}

// ── weights (versioned by WEIGHTS_VERSION) ─────────────────────────────────
export const HARD_FAMILIES = Object.freeze({
  TAX: ['TAX_DELINQUENT', 'TAX_LIEN', 'VF_TAX_DELINQUENT'],
  FORECLOSURE: ['FORECLOSURE_ACTIVE', 'VF_PREFORECLOSURE'],
  LEGAL_LIEN: ['LIS_PENDENS', 'JUDGMENT_LIEN', 'MUNICIPAL_LIEN', 'HOA_LIEN', 'LIEN_RECORDED', 'VF_ACTIVE_LIEN'],
  PROBATE: ['PROBATE', 'DEATH_EVENT', 'VF_PROBATE'],
  VACANCY: ['VACANT', 'VF_VACANT'],
  CONDITION: ['CONDITION_UNSOUND', 'CONDITION_POOR'],
});
/** Codes that make a single hard signal "acute". */
const ACUTE_CODES = new Set(['FORECLOSURE_ACTIVE', 'LIS_PENDENS', 'TAX_DELINQUENT_MULTI_YEAR', 'AUCTION_WITHIN_90D', 'VF_PREFORECLOSURE']);
export const SUPPORTING_CODES = Object.freeze([
  'ABSENTEE', 'OUT_OF_STATE', 'TENURE_20Y', 'TENURE_15Y', 'PORTFOLIO_5P', 'PORTFOLIO_3P',
  'EQUITY_80P', 'EQUITY_60P', 'EQUITY_40P', 'VF_FREE_AND_CLEAR', 'VF_HIGH_EQUITY', 'CONDITION_FAIR', 'VF_HEAVILY_DATED',
  'BUILT_PRE_1960', 'LTV_95P', 'LTV_80P', 'ARM_LOAN', 'LOAN_MATURES_24M', 'TIRED_LANDLORD_CORROBORATED', 'ENTITY_DISSOLVED',
]);
const SUPPORTING = new Set(SUPPORTING_CODES);
/**
 * STRONG supporting signals. Calibration 2026-10-07 (10,856 delivered first
 * touches): absentee (94%), equity ≥80% (79%), free & clear, pre-1960 stock,
 * DealMachine "Heavily Dated" (79%) and 15y tenure are near-universal in the
 * contacted cohort, so stacking them alone cannot define a strong stack. A
 * Tier-B stack without a hard signal needs ≥2 of these.
 */
export const STRONG_SUPPORTING_CODES = Object.freeze([
  'OUT_OF_STATE', 'TENURE_20Y', 'PORTFOLIO_5P', 'PORTFOLIO_3P', 'CONDITION_FAIR', 'LTV_95P', 'LTV_80P',
  'ARM_LOAN', 'LOAN_MATURES_24M', 'TIRED_LANDLORD_CORROBORATED', 'ENTITY_DISSOLVED',
]);
const STRONG = new Set(STRONG_SUPPORTING_CODES);

function factSource(rf, key) {
  return rf.sources?.[key] ?? { table: 'unknown', field: key, provenance: 'vendor_record' };
}

/**
 * Score one property. Pure; `ctx.now` makes scored_at deterministic.
 * @param {ReturnType<typeof buildRawFactsFromRows>} rawFacts
 * @param {{now?: Date|string, legacy?: object}} [ctx]
 */
export function scoreSellerSituation(rawFacts, ctx = {}) {
  const rf = rawFacts && typeof rawFacts === 'object' ? rawFacts : {};
  const F = rf.facts || {};
  const flags = new Set(rf.vendor_flags || []);
  const now = new Date(ctx?.now ?? Date.now());
  const evidence = [];
  const totals = Object.fromEntries(COMPONENTS.map((c) => [c, 0]));
  const fired = new Set();

  const add = (component, code, points, factKey, value) => {
    const src = factKey === '__flag' ? rf.vendor_flags_source ?? { table: 'properties', field: 'property_flags_text', provenance: 'vendor_flag' } : factSource(rf, factKey);
    evidence.push({ code, points, component, source_table: src.table, source_field: src.field, value: scalar(value), provenance: src.provenance });
    totals[component] += points;
    fired.add(code);
  };
  const flag = (k) => flags.has(k);

  // Normalized facts
  const taxDelinquent = bool(F.tax_delinquent);
  const taxYears = num(F.tax_delinquent_years);
  const fclAny = bool(F.foreclosure_any);
  const fclStale = bool(F.foreclosure_stale) === true;
  const probate = bool(F.probate);
  const death = bool(F.death_event);
  const vacant = bool(F.vacant);
  const ownerOcc = bool(F.owner_occupied);
  const absentee = bool(F.absentee) ?? (ownerOcc === null ? null : !ownerOcc);
  const outOfState = bool(F.out_of_state);
  const tenure = num(F.tenure_years);
  const portfolio = num(F.portfolio_count);
  const equity = num(F.equity_percent);
  const equityClass = F.equity_class ?? null; // vendor flag class, used only when the % is unknown
  const freeClear = equityClass === 'free_and_clear' ? true : null;
  // Lower bound used by tier / situation gates. Vendor classes are conservative floors, never a %.
  const equityFloor = equity !== null ? equity : equityClass === 'free_and_clear' ? 80 : equityClass === 'high' ? 50 : null;
  const equityKnown = equity !== null || equityClass !== null;
  const value = num(F.estimated_value);
  const loan = num(F.loan_balance);
  const ltv = num(F.ltv); // already gated by applyEquityKnownRule (loan > 0 and value > 0)
  const ptv = num(F.payment_to_value) ?? (value && num(F.monthly_payment) !== null ? (num(F.monthly_payment) * 12) / value : null);
  const annualTax = num(F.annual_tax);
  const taxRate = num(F.eff_tax_rate) ?? (value && annualTax !== null ? annualTax / value : null);
  let condClass = num(F.condition_class);
  if (condClass === null && known(F.condition_text)) condClass = CONDITION_TEXT_CLASS[clean(F.condition_text).toLowerCase()] ?? null;
  const condKey = num(F.condition_class) !== null ? 'condition_class' : 'condition_text';
  const yearBuilt = num(F.year_built);
  const age = yearBuilt ? now.getUTCFullYear() - yearBuilt : null;
  const lane = rf.asset_lane;
  const rental = lane === 'small_mf' || lane === 'mf';

  // ── FORCED SALE PRESSURE ──
  if (fclAny === true && !fclStale) add('forced_sale_pressure', 'FORECLOSURE_ACTIVE', 40, 'foreclosure_any', F.foreclosure_stage ?? true);
  else if (fclAny === true && fclStale) add('forced_sale_pressure', 'FORECLOSURE_STALE_NOD', 12, 'foreclosure_stale', true);
  else if (flag('preforeclosure')) add('forced_sale_pressure', 'VF_PREFORECLOSURE', 30, '__flag', 'Preforeclosure');
  if (bool(F.auction_within_90d) === true) add('forced_sale_pressure', 'AUCTION_WITHIN_90D', 15, 'auction_within_90d', true);
  if (taxDelinquent === true) {
    add('forced_sale_pressure', 'TAX_DELINQUENT', 25, 'tax_delinquent', true);
    if (taxYears !== null && taxYears >= 2) add('forced_sale_pressure', 'TAX_DELINQUENT_MULTI_YEAR', 10, 'tax_delinquent_years', taxYears);
  } else if (taxDelinquent === null && flag('tax delinquent')) {
    add('forced_sale_pressure', 'VF_TAX_DELINQUENT', 20, '__flag', 'Tax Delinquent');
  }
  if (bool(F.lien_lis_pendens) === true) add('forced_sale_pressure', 'LIS_PENDENS', 20, 'lien_lis_pendens', true);
  if (bool(F.lien_judgment) === true) add('forced_sale_pressure', 'JUDGMENT_LIEN', 15, 'lien_judgment', true);
  if (bool(F.lien_municipal) === true) add('forced_sale_pressure', 'MUNICIPAL_LIEN', 12, 'lien_municipal', true);
  if (bool(F.lien_hoa) === true) add('forced_sale_pressure', 'HOA_LIEN', 10, 'lien_hoa', true);
  const typedLien = ['LIS_PENDENS', 'JUDGMENT_LIEN', 'MUNICIPAL_LIEN', 'HOA_LIEN'].some((c) => fired.has(c));
  if (!typedLien && bool(F.lien_active) === true && !(taxDelinquent === true && bool(F.tax_lien) === true)) {
    add('forced_sale_pressure', 'LIEN_RECORDED', 8, 'lien_active', true);
  } else if (!typedLien && bool(F.lien_active) === null && flag('active lien')) {
    add('forced_sale_pressure', 'VF_ACTIVE_LIEN', 8, '__flag', 'Active Lien');
  }
  const lienAmt = num(F.lien_amount_due);
  if (lienAmt !== null && value && lienAmt / value >= 0.05) add('forced_sale_pressure', 'LIEN_AMOUNT_GE_5PCT_VALUE', 10, 'lien_amount_due', lienAmt);
  if (probate === true) add('forced_sale_pressure', 'PROBATE', 22, 'probate', true);
  else if (death === true) add('forced_sale_pressure', 'DEATH_EVENT', 12, 'death_event', true);
  else if (probate === null && flag('probate')) add('forced_sale_pressure', 'VF_PROBATE', 18, '__flag', 'Probate');
  if (vacant === true) add('forced_sale_pressure', 'VACANT', 12, 'vacant', true);
  else if (vacant === null && flag('vacant home')) add('forced_sale_pressure', 'VF_VACANT', 10, '__flag', 'Vacant Home');
  if (bool(F.entity_dissolved) === true) add('forced_sale_pressure', 'ENTITY_DISSOLVED', 8, 'entity_dissolved', true);

  // ── LANDLORD FATIGUE ── (owner-occupied SFR/condo is not a landlord)
  const landlordEligible = absentee === true || rental;
  if (landlordEligible) {
    if (absentee === true) add('landlord_fatigue', 'ABSENTEE', 15, 'absentee', true);
    if (outOfState === true) add('landlord_fatigue', 'OUT_OF_STATE', 10, 'out_of_state', true);
    if (rental) add('landlord_fatigue', 'RENTAL_ASSET_CLASS', 8, 'asset_class', lane);
    if (tenure !== null) {
      if (tenure >= 20) add('landlord_fatigue', 'TENURE_20Y', 18, 'tenure_years', tenure);
      else if (tenure >= 15) add('landlord_fatigue', 'TENURE_15Y', 14, 'tenure_years', tenure);
      else if (tenure >= 10) add('landlord_fatigue', 'TENURE_10Y', 9, 'tenure_years', tenure);
      else if (tenure >= 5) add('landlord_fatigue', 'TENURE_5Y', 4, 'tenure_years', tenure);
    }
    if (portfolio !== null) {
      if (portfolio >= 5) add('landlord_fatigue', 'PORTFOLIO_5P', 12, 'portfolio_count', portfolio);
      else if (portfolio >= 3) add('landlord_fatigue', 'PORTFOLIO_3P', 8, 'portfolio_count', portfolio);
      else if (portfolio >= 2) add('landlord_fatigue', 'PORTFOLIO_2', 4, 'portfolio_count', portfolio);
    }
    if (bool(F.tired_landlord_corroborated) === true) add('landlord_fatigue', 'TIRED_LANDLORD_CORROBORATED', 10, 'tired_landlord_corroborated', true);
    if (flag('tired landlord')) add('landlord_fatigue', 'VF_TIRED_LANDLORD', 6, '__flag', 'Tired Landlord');
    if (age !== null && age >= 50) add('landlord_fatigue', 'OLD_RENTAL_STOCK', 6, 'year_built', yearBuilt);
    if (condClass !== null && condClass <= 3) add('landlord_fatigue', 'RENTAL_CONDITION_BURDEN', 8, condKey, condClass);
    if (vacant === true) add('landlord_fatigue', 'VACANT_RENTAL', 8, 'vacant', true);
  }

  // ── EQUITY UNLOCK ──
  if (equity !== null) {
    if (equity >= 80) add('equity_unlock', 'EQUITY_80P', 45, 'equity_percent', equity);
    else if (equity >= 60) add('equity_unlock', 'EQUITY_60P', 35, 'equity_percent', equity);
    else if (equity >= 40) add('equity_unlock', 'EQUITY_40P', 25, 'equity_percent', equity);
    else if (equity >= 20) add('equity_unlock', 'EQUITY_20P', 10, 'equity_percent', equity);
  }
  else if (equityClass === 'free_and_clear') add('equity_unlock', 'VF_FREE_AND_CLEAR', 40, '__flag', 'Free And Clear');
  else if (equityClass === 'high') add('equity_unlock', 'VF_HIGH_EQUITY', 28, '__flag', 'High Equity');
  // Everything below needs KNOWN equity (a % or a vendor class) — never a zero/blank loan.
  const eqHold = equityKnown && equityFloor !== null && equityFloor >= 20;
  if (eqHold && tenure !== null && tenure >= 15) add('equity_unlock', 'LONG_HOLD_EQUITY', 12, 'tenure_years', tenure);
  else if (eqHold && tenure !== null && tenure >= 10) add('equity_unlock', 'MID_HOLD_EQUITY', 7, 'tenure_years', tenure);
  const appr = num(F.appreciation_ratio);
  const apprReliable = bool(F.price_reliable) === true;
  if (eqHold && apprReliable && appr !== null && appr >= 2) add('equity_unlock', 'VALUE_2X_PURCHASE', 12, 'appreciation_ratio', appr);
  if (absentee === true && equityFloor !== null && equityFloor >= 40) add('equity_unlock', 'NON_PRIMARY_EQUITY', 8, 'absentee', true);
  if (equity !== null && bool(F.high_equity_corroborated) === true) add('equity_unlock', 'HIGH_EQUITY_CORROBORATED', 6, 'high_equity_corroborated', true);

  // ── PROPERTY BURDEN ──
  if (condClass !== null) {
    if (condClass <= 1) add('property_burden', 'CONDITION_UNSOUND', 50, condKey, condClass);
    else if (condClass === 2) add('property_burden', 'CONDITION_POOR', 38, condKey, condClass);
    else if (condClass === 3) add('property_burden', 'CONDITION_FAIR', 18, condKey, condClass);
  }
  if (flag('heavily dated')) add('property_burden', 'VF_HEAVILY_DATED', 12, '__flag', 'Heavily Dated');
  else if (flag('no updates')) add('property_burden', 'VF_NO_UPDATES', 8, '__flag', 'No Updates');
  if (age !== null) {
    if (age >= 66) add('property_burden', 'BUILT_PRE_1960', 12, 'year_built', yearBuilt);
    else if (age >= 46) add('property_burden', 'BUILT_PRE_1980', 7, 'year_built', yearBuilt);
  }
  if (clean(F.repair_tier) === 'heavy') add('property_burden', 'REPAIR_TIER_HEAVY_FORMULA', 6, 'repair_tier', 'heavy');
  if (vacant === true || (vacant === null && flag('vacant home'))) add('property_burden', 'VACANT_UPKEEP', 10, vacant === true ? 'vacant' : '__flag', true);
  if (bool(F.lien_municipal) === true) add('property_burden', 'MUNICIPAL_LIEN_UPKEEP', 10, 'lien_municipal', true);

  // ── TAX PAIN ──
  if (taxDelinquent === true) {
    add('tax_pain', 'TAX_DELINQUENT', 40, 'tax_delinquent', true);
    if (taxYears !== null && taxYears >= 2) add('tax_pain', 'TAX_DELINQUENT_MULTI_YEAR', 15, 'tax_delinquent_years', taxYears);
  } else if (taxDelinquent === null && flag('tax delinquent')) {
    add('tax_pain', 'VF_TAX_DELINQUENT', 32, '__flag', 'Tax Delinquent');
  }
  if (bool(F.tax_lien) === true) add('tax_pain', 'TAX_LIEN', 15, 'tax_lien', true);
  if (taxRate !== null) {
    if (taxRate >= 0.02) add('tax_pain', 'TAX_RATE_GE_2PCT', 15, num(F.eff_tax_rate) !== null ? 'eff_tax_rate' : 'annual_tax', taxRate);
    else if (taxRate >= 0.015) add('tax_pain', 'TAX_RATE_GE_1_5PCT', 8, num(F.eff_tax_rate) !== null ? 'eff_tax_rate' : 'annual_tax', taxRate);
  }
  if (apprReliable && appr !== null && appr >= 2 && tenure !== null && tenure >= 10 && absentee === true) {
    add('tax_pain', 'CAPITAL_GAINS_EXPOSURE', 12, 'appreciation_ratio', appr);
  }

  // ── DEBT PRESSURE ──
  if (ltv !== null) {
    if (ltv >= 0.95) add('debt_pressure', 'LTV_95P', 45, 'ltv', ltv);
    else if (ltv >= 0.8) add('debt_pressure', 'LTV_80P', 35, 'ltv', ltv);
    else if (ltv >= 0.65) add('debt_pressure', 'LTV_65P', 22, 'ltv', ltv);
    else if (ltv >= 0.45) add('debt_pressure', 'LTV_45P', 10, 'ltv', ltv);
  }
  if (equity !== null && equity < 0) add('debt_pressure', 'NEGATIVE_EQUITY', 10, 'equity_percent', equity);
  if (ptv !== null && ptv >= 0.06) add('debt_pressure', 'PAYMENT_GE_6PCT_VALUE', 15, num(F.payment_to_value) !== null ? 'payment_to_value' : 'monthly_payment', ptv);
  if (fired.has('FORECLOSURE_ACTIVE') || fired.has('VF_PREFORECLOSURE')) add('debt_pressure', 'FORECLOSURE_DEBT_ENFORCEMENT', 25, fired.has('FORECLOSURE_ACTIVE') ? 'foreclosure_any' : '__flag', true);
  if (bool(F.arm) === true && ltv !== null && ltv >= 0.3) add('debt_pressure', 'ARM_LOAN', 8, 'arm', true);
  if (bool(F.maturity_24m) === true && ltv !== null && ltv >= 0.3) add('debt_pressure', 'LOAN_MATURES_24M', 10, 'maturity_24m', true);
  const jr = num(F.junior_liens);
  if (jr !== null && jr >= 1) add('debt_pressure', 'JUNIOR_LIEN', 8, 'junior_liens', jr);

  // ── components + coverage ──
  // A component is known when one of its fields is known OR evidence fired in it (e.g. foreclosure → debt).
  const componentKnown = (c) => COMPONENT_FIELDS[c].some((k) => known(F[k])) || (c === 'landlord_fatigue' && rental)
    || evidence.some((e) => e.component === c);
  const components = {};
  for (const c of COMPONENTS) components[c] = componentKnown(c) ? Math.round(clamp(totals[c])) : null;
  const missing = CORE_FIELDS.filter((k) => !known(F[k]));
  const fieldsKnown = CORE_FIELDS.length - missing.length;
  const coverageRatio = Math.round((fieldsKnown / CORE_FIELDS.length) * 1000) / 1000;
  const coverage = { fields_known: fieldsKnown, fields_total: CORE_FIELDS.length, ratio: coverageRatio, missing };

  // ── sell probability (transparent heuristic, NOT yet calibrated: §10) ──
  const v = (c) => components[c] ?? 0;
  const lift = 0.45 * v('forced_sale_pressure') + 0.15 * Math.max(v('landlord_fatigue'), v('property_burden'))
    + 0.12 * v('debt_pressure') + 0.1 * v('tax_pain');
  // equity_unlock carries NO sell-probability weight: in calibration higher
  // equity went with LOWER ownership-confirm / interest (AUC 0.46 / 0.455) —
  // "high equity + low urgency: don't assume distress" (§56). It stays a
  // component for targeting and spendability.
  const BASE_365 = 6; // ≈ US annual owner turnover (%); no market override until calibrated
  const unknownTier = coverageRatio < 0.4;
  const sell_probability = unknownTier
    ? { d90: null, d180: null, d365: null }
    : {
        d90: Math.round(clamp(BASE_365 / 4 + 0.3 * v('forced_sale_pressure') + 0.05 * v('debt_pressure'), 0, 95)),
        d180: Math.round(clamp(BASE_365 / 2 + 0.38 * v('forced_sale_pressure') + 0.08 * Math.max(v('landlord_fatigue'), v('property_burden')) + 0.08 * v('debt_pressure') + 0.06 * v('tax_pain'), 0, 95)),
        d365: Math.round(clamp(BASE_365 + lift * 0.75, 0, 95)),
      };
  sell_probability.d180 = sell_probability.d180 === null ? null : Math.max(sell_probability.d180, sell_probability.d90);
  sell_probability.d365 = sell_probability.d365 === null ? null : Math.max(sell_probability.d365, sell_probability.d180);

  // ── tier (§14) ──
  const hardFamilies = Object.entries(HARD_FAMILIES).filter(([, codes]) => codes.some((c) => fired.has(c))).map(([k]) => k);
  const hardCodes = Object.values(HARD_FAMILIES).flat().filter((c) => fired.has(c));
  const acute = [...fired].filter((c) => ACUTE_CODES.has(c));
  const supporting = [...fired].filter((c) => SUPPORTING.has(c));
  const strong = supporting.filter((c) => STRONG.has(c));
  let tier;
  let tier_reasons;
  if (unknownTier) {
    tier = 'UNKNOWN';
    tier_reasons = ['COVERAGE_BELOW_40PCT'];
  } else if (hardFamilies.length >= 2) {
    tier = 'A';
    tier_reasons = hardCodes;
  } else if (hardFamilies.length === 1 && acute.length && equityFloor !== null && equityFloor >= 40) {
    // equityFloor is non-null only for KNOWN equity (loan > 0 and value > 0, or an explicit vendor class).
    tier = 'A';
    tier_reasons = [...hardCodes, ...acute.filter((c) => !hardCodes.includes(c)), 'EQUITY_GE_40'];
  } else if (hardFamilies.length === 1 && supporting.length >= 2) {
    tier = 'B';
    tier_reasons = [...hardCodes, ...supporting];
  } else if (strong.length >= 2 && supporting.length >= 4) {
    tier = 'B';
    tier_reasons = supporting;
  } else {
    tier = 'C';
    tier_reasons = fired.size ? [...hardCodes, ...supporting, ...(fired.has('VF_TIRED_LANDLORD') ? ['VF_TIRED_LANDLORD'] : [])] : ['NO_SIGNAL'];
    if (!tier_reasons.length) tier_reasons = ['SOFT_SIGNALS_ONLY'];
  }

  // ── situation + angle (angle only with supporting evidence) ──
  const { situation, angle } = resolveSituation({ components, fired, absentee, outOfState, equity: equityFloor, tenure, vacant, freeClear, apprReliable, appr, unknownTier });

  // Confidence: coverage × provenance quality × freshness.
  const formulaShare = evidence.length ? evidence.filter((e) => e.provenance === 'formula_estimate').length / evidence.length : 0;
  const asOf = F.as_of_date ? new Date(F.as_of_date) : null;
  const ageDays = asOf && !Number.isNaN(asOf.valueOf()) ? (now - asOf) / 86_400_000 : null;
  const freshness = ageDays === null ? 0.85 : ageDays <= 120 ? 1 : ageDays <= 365 ? 0.9 : 0.75;
  const confidence = Math.round(coverageRatio * (1 - 0.5 * formulaShare) * freshness * (rf.has_features ? 1 : 0.9) * 1000) / 1000;

  const legacy = { ...(rf.legacy || {}), ...(ctx?.legacy || {}) };
  return {
    score_version: SCORE_VERSION,
    input_model_version: INPUT_MODEL_VERSION,
    weights_version: WEIGHTS_VERSION,
    scored_at: now.toISOString(),
    property_id: rf.property_id ?? null,
    components,
    sell_probability,
    seller_situation: situation,
    conversation_angle: angle,
    opportunity_tier: tier,
    tier_reasons: [...new Set(tier_reasons)],
    hard_signal_families: hardFamilies,
    evidence,
    coverage,
    confidence,
    legacy_shadow: {
      final_acquisition_score: num(legacy.final_acquisition_score),
      structured_motivation_score: num(legacy.structured_motivation_score),
      tag_distress_score: num(legacy.tag_distress_score),
      deal_strength_score: num(legacy.deal_strength_score),
    },
  };
}

export function resolveSituation({ components, fired, absentee, outOfState, equity, tenure, vacant, freeClear, apprReliable, appr, unknownTier }) {
  if (unknownTier) return { situation: 'NO_CLEAR_SITUATION', angle: null };
  const c = (k) => components[k] ?? 0;
  const has = (...codes) => codes.some((x) => fired.has(x));
  if (has('PROBATE', 'DEATH_EVENT', 'VF_PROBATE')) {
    return { situation: 'INHERITED_PROBATE', angle: 'CONVENIENCE' };
  }
  if (has('FORECLOSURE_ACTIVE', 'VF_PREFORECLOSURE', 'LIS_PENDENS', 'JUDGMENT_LIEN') || c('debt_pressure') >= 60) {
    return { situation: 'FINANCIALLY_PRESSURED', angle: 'SPEED_CERTAINTY' };
  }
  if (has('TAX_DELINQUENT', 'VF_TAX_DELINQUENT') && c('tax_pain') >= 40) {
    return { situation: 'TAX_DISTRESSED', angle: 'SPEED_CERTAINTY' };
  }
  if (c('property_burden') >= 45) {
    return { situation: 'HIGH_REPAIR_BURDEN', angle: 'AS_IS_NO_REPAIRS' };
  }
  if (c('landlord_fatigue') >= 50) {
    // Tenant relief only when the asset is plausibly tenanted (absentee and not vacant).
    const angle = absentee === true && vacant !== true ? 'TENANT_RELIEF' : 'CONVENIENCE';
    return { situation: 'FATIGUED_LANDLORD', angle };
  }
  const lowUrgency = c('forced_sale_pressure') < 25;
  if (lowUrgency && equity !== null && equity >= 60 && tenure !== null && tenure >= 15 && absentee === true) {
    // High equity + low urgency: don't assume distress (§56). Creative angle only with evidence.
    let angle = null;
    if (apprReliable && appr !== null && appr >= 2) angle = 'TAX_FLEXIBILITY';
    else if (freeClear === true) angle = 'SELLER_FINANCE';
    return { situation: 'WEALTH_PRESERVATION', angle };
  }
  if (lowUrgency && equity !== null && equity >= 50 && absentee === true) {
    return { situation: 'EQUITY_RICH_ABSENTEE', angle: outOfState === true ? 'CONVENIENCE' : null };
  }
  return { situation: 'NO_CLEAR_SITUATION', angle: null };
}

/**
 * Composite used ONLY by the engine's legacy motivation/distress slots when
 * SELLER_SCORING_RAW_FACTS is on (acquisitionDecisionEngine.distressAndMotivation).
 * motivation = sell_probability-weighted pressure; distress = hard-signal pressure.
 */
export function engineMotivationDistress(result) {
  if (!result || result.opportunity_tier === 'UNKNOWN') return { motivation: null, distress: null };
  const v = (k) => result.components?.[k] ?? 0;
  const distress = Math.round(clamp(0.6 * v('forced_sale_pressure') + 0.2 * v('property_burden') + 0.2 * v('tax_pain')));
  const motivation = Math.round(clamp(0.4 * v('forced_sale_pressure') + 0.2 * Math.max(v('landlord_fatigue'), v('property_burden')) + 0.15 * v('debt_pressure') + 0.15 * v('tax_pain') + 0.1 * v('equity_unlock')));
  return { motivation, distress };
}
