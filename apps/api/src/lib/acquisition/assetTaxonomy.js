// ─── assetTaxonomy.js ───────────────────────────────────────────────────────
// THE canonical asset-class vocabulary for comp compatibility.
//
// WHY THIS EXISTS (proven production defect, property 237838109,
// 6710 Delta Dr Riverdale GA, 2026-09-12):
// The Decision Engine valued the subject off 8 Single Family comps, but the
// Deal Intelligence comp panel for the SAME property reported
// "No usable comps — Asset type mismatch". Both sides were single family.
//
// The panel and the engine built their subject differently. The panel's subject
// came from `normalizeProperty()`, which filled `normalized_asset_class` from
// `hydrated.property_class` when the real columns were null. For this property
// `properties.normalized_asset_class` and `properties.asset_class` are both
// NULL and `property_class` is 'Residential', so the panel's subject asset
// class became the string 'Residential'.
//
// 'Residential' is not an asset TYPE, it is an asset CLASS — a coarser
// vocabulary one semantic level up. `normalizeAssetClass('Residential')`
// therefore matched none of its type patterns and answered 'other', whose
// family is 'other', which is compatible with nothing. Every Single Family comp
// failed `assetCompatible` against a Single Family subject.
//
// THE TWO BUGS THAT COMBINE
//   1. A class-level value ('Residential') was fed to a type-level normalizer.
//   2. That normalizer answers 'other' for two different questions — "an asset
//      we do not model" and "this string does not name an asset at all" — so
//      the caller could not tell an answer from a non-answer, and committed to
//      the non-answer.
//
// THE INVARIANT
//   A value that does not NAME an asset must resolve to UNKNOWN, never to a
//   lane. UNKNOWN is a distinct state with its own verdict, never silently
//   equal to another UNKNOWN and never silently incompatible with a known lane.
//
// This module answers "what asset is this" ONCE, for subjects and comps alike,
// from whichever field actually names one — so `SFR`, `Single Family`,
// `single-family`, `SFH`, `Detached` and `residential_1_unit` all land in the
// same lane without any raw string being equal to any other.

/** Canonical asset classes. */
export const ASSET_CLASS = Object.freeze({
  SINGLE_FAMILY: 'single_family',
  RESIDENTIAL_2_TO_4: 'residential_2_to_4',
  MULTIFAMILY_5_PLUS: 'multifamily_5_plus',
  CONDOMINIUM: 'condominium',
  TOWNHOUSE: 'townhouse',
  MOBILE_HOME: 'mobile_home',
  COMMERCIAL: 'commercial',
  STORAGE: 'storage',
  LAND: 'land',
  UNKNOWN: 'unknown',
});

/** Compatibility verdicts (brief §10). Diagnosis, separate from the outcome. */
export const COMPATIBILITY = Object.freeze({
  EXACT_MATCH: 'exact_match',
  COMPATIBLE: 'compatible',
  UNKNOWN_NEEDS_REVIEW: 'unknown_needs_review',
  INCOMPATIBLE: 'incompatible',
});

const FAMILY = Object.freeze({
  [ASSET_CLASS.SINGLE_FAMILY]: 'residential',
  [ASSET_CLASS.CONDOMINIUM]: 'residential',
  [ASSET_CLASS.TOWNHOUSE]: 'residential',
  [ASSET_CLASS.MOBILE_HOME]: 'residential',
  [ASSET_CLASS.RESIDENTIAL_2_TO_4]: 'multifamily',
  [ASSET_CLASS.MULTIFAMILY_5_PLUS]: 'multifamily',
  [ASSET_CLASS.COMMERCIAL]: 'commercial',
  [ASSET_CLASS.STORAGE]: 'commercial',
  [ASSET_CLASS.LAND]: 'land',
  [ASSET_CLASS.UNKNOWN]: 'unknown',
});

export function assetFamilyOf(assetClass) {
  return FAMILY[assetClass] || 'unknown';
}

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Vocabulary that names an asset CLASS rather than an asset TYPE.
 *
 * These are the strings that produced the Riverdale defect: real data, but one
 * semantic level too coarse to pick a lane. They are recognised explicitly so
 * the resolver can say "not an answer" instead of guessing — a bare
 * 'Residential' could be a house, a duplex or a 40-unit building, and inventing
 * `single_family` from it would be a fabricated match, not a fixed one.
 */
const INDEFINITE_TOKENS = Object.freeze([
  'residential',
  'commercial property',
  'real estate',
  'property',
  'improved',
  'unimproved property',
  'other',
  'unknown',
  'n/a',
  'na',
  'none',
  'misc',
  'miscellaneous',
]);

/** Ordered rules. First match wins; later rules never override an earlier one. */
const RULES = Object.freeze([
  // Land before everything: "vacant residential lot" is land, not a house.
  [/vacant\s*(land|lot)|raw\s*land|\bland\b|unimproved|acreage|vacant\s*residential/, ASSET_CLASS.LAND],
  [/self.?storage|mini.?storage|storage\s*(facility|unit)/, ASSET_CLASS.STORAGE],
  [/mobile\s*home|manufactured\s*(home|housing)|trailer/, ASSET_CLASS.MOBILE_HOME],
  [/condo|condominium/, ASSET_CLASS.CONDOMINIUM],
  [/town\s*(house|home)|townhouse|townhome|row\s*house/, ASSET_CLASS.TOWNHOUSE],
  // 5+ before the generic multi rules so "apartment building" does not land in
  // the 2-4 lane.
  [/apartment|multifamily\s*5|5\+?\s*unit|five\s*or\s*more|\bmf\s*5/, ASSET_CLASS.MULTIFAMILY_5_PLUS],
  [/duplex|triplex|tri-?plex|fourplex|four-?plex|quad(plex|ruplex)?|2\s*-\s*4\s*unit|two\s*to\s*four/, ASSET_CLASS.RESIDENTIAL_2_TO_4],
  [/multi[\s_-]*family|multi[\s_-]*unit|\bmulti\b/, ASSET_CLASS.MULTIFAMILY_5_PLUS],
  [/office|retail|industrial|warehouse|hotel|motel|strip\s*(mall|center)|shopping\s*center|medical|restaurant|commercial/, ASSET_CLASS.COMMERCIAL],
  // Single family last: the widest vocabulary, and the one most likely to be a
  // substring of something more specific ("single tenant retail" is caught
  // above; "detached condo" is caught above).
  [/single[\s_-]*family|\bsfr\b|\bsfh\b|\bsfd\b|single[\s_-]*unit|one[\s_-]*family|1[\s_-]*family|detached|residential[\s_-]*1[\s_-]*unit|res[\s_-]*1[\s_-]*unit|1[\s_-]*unit\b/, ASSET_CLASS.SINGLE_FAMILY],
]);

/**
 * Does this raw value NAME an asset?
 *
 * @returns {{class: string, definite: boolean, reason: string}}
 *   definite=false means "no answer" — either empty, or a class-level token
 *   like 'Residential'. Callers must fall through to another field rather than
 *   commit to it.
 */
export function classifyAssetToken(raw) {
  const value = lower(raw);
  if (!value) return { class: ASSET_CLASS.UNKNOWN, definite: false, reason: 'empty' };

  for (const [pattern, assetClass] of RULES) {
    if (pattern.test(value)) return { class: assetClass, definite: true, reason: 'vocabulary_match' };
  }

  const collapsed = value.replace(/[\s_-]+/g, ' ').trim();
  if (INDEFINITE_TOKENS.includes(collapsed)) {
    return { class: ASSET_CLASS.UNKNOWN, definite: false, reason: 'class_level_token_not_an_asset_type' };
  }
  return { class: ASSET_CLASS.UNKNOWN, definite: false, reason: 'unrecognized_vocabulary' };
}

/**
 * Candidate fields in priority order. Unchanged from the engine's original
 * order — the fix is that an indefinite answer no longer ends the search.
 */
export const ASSET_CLASS_CANDIDATE_FIELDS = Object.freeze([
  'canonical_asset_lane',
  'normalized_asset_class',
  'asset_class',
  'asset_type',
  'normalized_asset_subclass',
  'asset_subclass',
  'asset_subtype',
  'commercial_property_type',
  'property_subtype',
  'property_type',
  'land_use',
  'standardized_land_use_code',
  'property_use_code',
  'zoning_description',
  // property_class is LAST on purpose: it is the class-level vocabulary that
  // caused the Riverdale defect. It can only contribute when nothing more
  // specific named an asset, and even then it resolves indefinite.
  'property_class',
]);

/**
 * Resolve one row's canonical asset class from every field that might name one.
 *
 * Unit count is authoritative over vocabulary for the residential lanes only:
 * a row labelled "Single Family" with units_count = 3 is a 2-4, and a row
 * labelled "Multi-Family" with units_count = 2 is a 2-4 rather than 5+. Unit
 * count never overrides land, storage or commercial.
 *
 * @returns {{class, definite, family, source_field, raw, units, reason}}
 */
export function resolveAssetClass(row = {}) {
  let resolved = null;
  for (const field of ASSET_CLASS_CANDIDATE_FIELDS) {
    if (row[field] === undefined || row[field] === null || row[field] === '') continue;
    const verdict = classifyAssetToken(row[field]);
    if (verdict.definite) {
      resolved = { class: verdict.class, definite: true, source_field: field, raw: row[field], reason: verdict.reason };
      break;
    }
    if (!resolved) {
      // Remember the first indefinite value purely so the diagnosis can name
      // what we DID see ('Residential') instead of reporting nothing.
      resolved = { class: ASSET_CLASS.UNKNOWN, definite: false, source_field: field, raw: row[field], reason: verdict.reason };
    }
  }
  if (!resolved) {
    resolved = { class: ASSET_CLASS.UNKNOWN, definite: false, source_field: null, raw: null, reason: 'no_asset_fields_present' };
  }

  const units = num(row.units_count ?? row.units ?? row.number_of_units ?? row.num_units ?? row.multifamily_units);
  const residentialLane =
    resolved.class === ASSET_CLASS.SINGLE_FAMILY ||
    resolved.class === ASSET_CLASS.RESIDENTIAL_2_TO_4 ||
    resolved.class === ASSET_CLASS.MULTIFAMILY_5_PLUS ||
    (!resolved.definite && resolved.class === ASSET_CLASS.UNKNOWN);

  if (units !== null && units > 1 && residentialLane) {
    const byUnits = units >= 5 ? ASSET_CLASS.MULTIFAMILY_5_PLUS : ASSET_CLASS.RESIDENTIAL_2_TO_4;
    if (byUnits !== resolved.class) {
      resolved = { class: byUnits, definite: true, source_field: 'units_count', raw: units, reason: 'unit_count_governs_residential_lane' };
    }
  }

  return { ...resolved, family: assetFamilyOf(resolved.class), units };
}

/**
 * Compare a subject and a comp. Diagnosis only — the caller decides what a
 * verdict costs.
 *
 * @returns {{verdict: string, subject_class, comp_class, detail: string}}
 */
export function compareAssetClasses(subject = {}, comp = {}, { residentialSubstitution = true } = {}) {
  const s = typeof subject === 'string' ? { class: subject, definite: subject !== ASSET_CLASS.UNKNOWN } : subject;
  const c = typeof comp === 'string' ? { class: comp, definite: comp !== ASSET_CLASS.UNKNOWN } : comp;
  const sClass = s.class || ASSET_CLASS.UNKNOWN;
  const cClass = c.class || ASSET_CLASS.UNKNOWN;
  const base = { subject_class: sClass, comp_class: cClass };

  const sUnknown = sClass === ASSET_CLASS.UNKNOWN || s.definite === false;
  const cUnknown = cClass === ASSET_CLASS.UNKNOWN || c.definite === false;

  if (sUnknown || cUnknown) {
    return {
      ...base,
      verdict: COMPATIBILITY.UNKNOWN_NEEDS_REVIEW,
      detail: sUnknown && cUnknown ? 'both_sides_unknown' : sUnknown ? 'subject_asset_class_unknown' : 'comp_asset_class_unknown',
    };
  }

  if (sClass === cClass) return { ...base, verdict: COMPATIBILITY.EXACT_MATCH, detail: 'same_canonical_class' };

  const sFamily = assetFamilyOf(sClass);
  const cFamily = assetFamilyOf(cClass);
  if (sFamily !== cFamily) return { ...base, verdict: COMPATIBILITY.INCOMPATIBLE, detail: `family_mismatch:${sFamily}_vs_${cFamily}` };

  // Same family, different class. Multifamily lanes substitute for each other
  // (the engine adjusts by unit count) and so do commercial subtypes.
  //
  // Residential is the contested one. assetClassification.js states the hard
  // rule "SFR comps only for SFR (no condo/townhome substitution by default)",
  // but the live comp gate has always allowed it, and every persisted valuation
  // was produced under that allowance. Tightening it here would silently move
  // money numbers on properties that have nothing to do with the taxonomy
  // defect this module exists to fix, so substitution stays ON by default and
  // the caller opts into the stricter rule explicitly.
  if (sFamily === 'residential' && !residentialSubstitution) {
    return { ...base, verdict: COMPATIBILITY.INCOMPATIBLE, detail: `residential_subtype_mismatch:${sClass}_vs_${cClass}` };
  }
  return { ...base, verdict: COMPATIBILITY.COMPATIBLE, detail: `same_family:${sFamily}` };
}

/**
 * Map a canonical class onto the engine's existing lane vocabulary.
 *
 * The engine keys `eligibilityLimits`, `adjustedCompPrice` and the valuation
 * method off its own `asset_type`/`asset_family` strings. Translating here
 * keeps every one of those behaviours identical while the classification itself
 * becomes canonical.
 */
export function engineLaneFor(assetClass) {
  switch (assetClass) {
    case ASSET_CLASS.SINGLE_FAMILY: return 'single_family';
    case ASSET_CLASS.CONDOMINIUM: return 'condominium';
    case ASSET_CLASS.TOWNHOUSE: return 'townhouse';
    case ASSET_CLASS.MOBILE_HOME: return 'mobile_home';
    case ASSET_CLASS.RESIDENTIAL_2_TO_4:
    case ASSET_CLASS.MULTIFAMILY_5_PLUS: return 'multifamily';
    case ASSET_CLASS.STORAGE: return 'storage';
    case ASSET_CLASS.COMMERCIAL: return 'commercial';
    case ASSET_CLASS.LAND: return 'land';
    default: return 'other';
  }
}

export default {
  ASSET_CLASS,
  COMPATIBILITY,
  assetFamilyOf,
  classifyAssetToken,
  resolveAssetClass,
  compareAssetClasses,
  engineLaneFor,
};
