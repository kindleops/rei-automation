// ─── property-communication-class.js ─────────────────────────────────────────
//
// Canonical property communication class (spine §7).
//
// ONE classifier decides how we are allowed to talk about a property:
//
//   single_family | duplex | triplex | fourplex | multifamily_5_plus | unknown
//
// Rules (binding contract — docs/automation/CANONICAL_AUTOMATION_SPINE.md §7):
//   - A numeric units count is AUTHORITATIVE when present:
//       1 → single_family, 2 → duplex, 3 → triplex, 4 → fourplex, ≥5 → multifamily_5_plus.
//   - Type-label parsing (consolidated from lib/sms/property_scope.js and
//     lib/domain/outbound/supabase-candidate-feeder.js getCanonicalPropertyGroup)
//     is the FALLBACK when no units count exists.
//   - Conflicting or absent signals → unknown.
//   - unknown ⇒ property-neutral wording only. single_family must NEVER receive
//     unit-count wording. These are hard guarantees (selection filter + render
//     assert), not score adjustments.
//
// This module is intentionally dependency-free so both the template domain and
// the outbound/campaign domains can consume it without import cycles.

export const PROPERTY_COMMUNICATION_CLASSES = Object.freeze({
  SINGLE_FAMILY: "single_family",
  DUPLEX: "duplex",
  TRIPLEX: "triplex",
  FOURPLEX: "fourplex",
  MULTIFAMILY_5_PLUS: "multifamily_5_plus",
  UNKNOWN: "unknown",
});

export const PROPERTY_COMMUNICATION_CLASS_VALUES = Object.freeze([
  PROPERTY_COMMUNICATION_CLASSES.SINGLE_FAMILY,
  PROPERTY_COMMUNICATION_CLASSES.DUPLEX,
  PROPERTY_COMMUNICATION_CLASSES.TRIPLEX,
  PROPERTY_COMMUNICATION_CLASSES.FOURPLEX,
  PROPERTY_COMMUNICATION_CLASSES.MULTIFAMILY_5_PLUS,
  PROPERTY_COMMUNICATION_CLASSES.UNKNOWN,
]);

function clean(value) {
  return String(value ?? "").trim();
}

// Lowercase + trim + normalize dashes + strip diacritics ("dúplex" → "duplex")
// so Spanish template bodies and label variants match deterministically.
function normalizeText(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Normalize a raw units-count signal into a positive integer or null.
 * Accepts numbers and numeric strings; rejects zero/negative/NaN.
 */
export function normalizeUnitsCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const truncated = Math.trunc(parsed);
  if (truncated < 1) return null;
  return truncated;
}

/**
 * Parse a units count out of a property-type label.
 * Consolidates the patterns previously duplicated in
 * lib/sms/property_scope.js parseUnitCount (:22-33).
 */
export function parseUnitsCountFromLabel(label) {
  const normalized = normalizeText(label);
  if (!normalized) return null;
  if (normalized.includes("duplex") || normalized === "2 units") return 2;
  if (normalized.includes("triplex") || normalized === "3 units") return 3;
  if (
    normalized.includes("fourplex") ||
    normalized.includes("quadplex") ||
    normalized === "4 units"
  ) {
    return 4;
  }
  const matched = normalized.match(/(\d+)\s*\+?\s*units?/);
  if (matched) return normalizeUnitsCount(matched[1]);
  if (normalized.includes("5+") || normalized.includes("5 plus")) return 5;
  return null;
}

/**
 * Map an authoritative units count to a communication class.
 */
export function communicationClassFromUnits(units_count) {
  const units = normalizeUnitsCount(units_count);
  if (units === null) return null;
  if (units === 1) return PROPERTY_COMMUNICATION_CLASSES.SINGLE_FAMILY;
  if (units === 2) return PROPERTY_COMMUNICATION_CLASSES.DUPLEX;
  if (units === 3) return PROPERTY_COMMUNICATION_CLASSES.TRIPLEX;
  if (units === 4) return PROPERTY_COMMUNICATION_CLASSES.FOURPLEX;
  return PROPERTY_COMMUNICATION_CLASSES.MULTIFAMILY_5_PLUS;
}

const SINGLE_FAMILY_LABEL_MARKERS = Object.freeze([
  "single family",
  "single-family",
  "single fam",
  "condo",
  "condominium",
  "townhouse",
  "townhome",
  "town home",
  "mobile home",
  "manufactured home",
]);

// Labels that clearly indicate a multifamily property WITHOUT pinning the unit
// count to one of the specific classes. These are multifamily-indicated but
// resolve to `unknown` (property-neutral wording only) — a bare "Multifamily"
// label could be a duplex or a 40-unit building; guessing either way produces
// wrong wording.
const GENERIC_MULTIFAMILY_LABEL_MARKERS = Object.freeze([
  "multifamily 2-4",
  "multifamily 2 - 4",
  "2-4 unit",
  "multi-family",
  "multi family",
  "multifamily",
  "apartment",
]);

function isSfrToken(normalized) {
  return normalized === "sfr" || /\bsfr\b/.test(normalized);
}

/**
 * Map a property-type label to a communication class, or null when the label
 * carries no class-determining signal. Generic multifamily labels return null
 * here (see resolvePropertyCommunicationClass / describePropertyCommunicationClass:
 * they surface `multifamily_indicated` instead of guessing a class).
 */
export function communicationClassFromLabel(label) {
  const normalized = normalizeText(label);
  if (!normalized) return null;

  // Normalized-asset-class vocabulary (feeder canonical property groups).
  if (normalized === "small_multifamily" || normalized.includes("small multifamily")) {
    // Feeder-defined: 5–10 units.
    return PROPERTY_COMMUNICATION_CLASSES.MULTIFAMILY_5_PLUS;
  }
  if (normalized === "multifamily_5_plus") {
    return PROPERTY_COMMUNICATION_CLASSES.MULTIFAMILY_5_PLUS;
  }

  // "Mobile Home Park" / "RV Park" are multi-unit commercial parks, not a
  // single mobile home — never single_family.
  if (normalized.includes("mobile home park") || normalized.includes("rv park")) {
    return null;
  }

  if (isSfrToken(normalized)) return PROPERTY_COMMUNICATION_CLASSES.SINGLE_FAMILY;
  for (const marker of SINGLE_FAMILY_LABEL_MARKERS) {
    if (normalized.includes(marker)) return PROPERTY_COMMUNICATION_CLASSES.SINGLE_FAMILY;
  }

  const units = parseUnitsCountFromLabel(normalized);
  if (units !== null) return communicationClassFromUnits(units);

  return null;
}

/**
 * True when the label indicates SOME multifamily property (specific or generic).
 */
export function labelIndicatesMultifamily(label) {
  const normalized = normalizeText(label);
  if (!normalized) return false;
  const specific = communicationClassFromLabel(normalized);
  if (
    specific &&
    specific !== PROPERTY_COMMUNICATION_CLASSES.SINGLE_FAMILY &&
    specific !== PROPERTY_COMMUNICATION_CLASSES.UNKNOWN
  ) {
    return true;
  }
  return GENERIC_MULTIFAMILY_LABEL_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Full classification detail. `resolvePropertyCommunicationClass` is the
 * common entry point; this variant additionally reports how the class was
 * derived so vocabulary-stable wrappers (property_scope.js scope resolution,
 * the feeder's canonical property group) can preserve their existing outputs.
 *
 * @param {object} input
 * @param {number|string} [input.units_count]           authoritative when present
 * @param {string}        [input.property_type]         label fallback (highest priority)
 * @param {string}        [input.property_class]        label fallback
 * @param {string}        [input.asset_type_label]      label fallback
 * @param {string}        [input.normalized_asset_class] label fallback (feeder group vocab)
 */
export function describePropertyCommunicationClass(input = {}) {
  const explicit_units = normalizeUnitsCount(input.units_count);
  const labels = [
    input.property_type,
    input.property_class,
    input.asset_type_label,
    input.normalized_asset_class,
  ]
    .map((label) => clean(label))
    .filter(Boolean);

  const multifamily_indicated =
    (explicit_units !== null && explicit_units >= 2) ||
    labels.some((label) => labelIndicatesMultifamily(label));

  if (explicit_units !== null) {
    return {
      communication_class: communicationClassFromUnits(explicit_units),
      units_count: explicit_units,
      source: "units_count",
      multifamily_indicated,
      conflicting_labels: false,
    };
  }

  const label_classes = [];
  let label_units = null;
  for (const label of labels) {
    const label_class = communicationClassFromLabel(label);
    if (label_class && !label_classes.includes(label_class)) label_classes.push(label_class);
    if (label_units === null) label_units = parseUnitsCountFromLabel(label);
  }

  if (label_classes.length === 1) {
    return {
      communication_class: label_classes[0],
      units_count: label_units,
      source: "label",
      multifamily_indicated,
      conflicting_labels: false,
    };
  }

  return {
    communication_class: PROPERTY_COMMUNICATION_CLASSES.UNKNOWN,
    units_count: null,
    source: "none",
    multifamily_indicated,
    conflicting_labels: label_classes.length > 1,
  };
}

/**
 * Canonical classifier (spine §7). Returns one of
 * PROPERTY_COMMUNICATION_CLASS_VALUES — never null.
 */
export function resolvePropertyCommunicationClass(input = {}) {
  return describePropertyCommunicationClass(input).communication_class;
}

// ─── Template-side scope mapping ─────────────────────────────────────────────
//
// Maps the communication class onto the template property_type_scope vocabulary
// used by lib/sms/property_scope.js resolvePropertyTypeScope and
// lib/domain/templates/template-selector.js (VALID_SCOPES).

const CLASS_TO_PROPERTY_TYPE_SCOPE = Object.freeze({
  [PROPERTY_COMMUNICATION_CLASSES.SINGLE_FAMILY]: "Residential",
  [PROPERTY_COMMUNICATION_CLASSES.DUPLEX]: "Duplex",
  [PROPERTY_COMMUNICATION_CLASSES.TRIPLEX]: "Triplex",
  [PROPERTY_COMMUNICATION_CLASSES.FOURPLEX]: "Fourplex",
  [PROPERTY_COMMUNICATION_CLASSES.MULTIFAMILY_5_PLUS]: "5+ Units",
  [PROPERTY_COMMUNICATION_CLASSES.UNKNOWN]: "Any Residential",
});

export function communicationClassToPropertyTypeScope(communication_class) {
  return CLASS_TO_PROPERTY_TYPE_SCOPE[clean(communication_class)] || "Any Residential";
}

/**
 * Inverse mapping used by the template selector to derive a class claim from
 * an explicitly requested property_type_scope. Returns null when the scope
 * carries no property-class claim (owner-type scopes, generic multifamily) —
 * null means "no class claim", NOT unknown.
 */
export function communicationClassFromPropertyTypeScope(scope) {
  const normalized = normalizeText(scope);
  if (!normalized) return null;
  if (normalized === "residential" || normalized.includes("single family") || isSfrToken(normalized)) {
    return PROPERTY_COMMUNICATION_CLASSES.SINGLE_FAMILY;
  }
  if (normalized === "any residential") return PROPERTY_COMMUNICATION_CLASSES.UNKNOWN;
  if (normalized.includes("duplex")) return PROPERTY_COMMUNICATION_CLASSES.DUPLEX;
  if (normalized.includes("triplex")) return PROPERTY_COMMUNICATION_CLASSES.TRIPLEX;
  if (normalized.includes("fourplex") || normalized.includes("quadplex")) {
    return PROPERTY_COMMUNICATION_CLASSES.FOURPLEX;
  }
  if (normalized.includes("5+") || normalized.includes("5 plus") || normalized.includes("five plus")) {
    return PROPERTY_COMMUNICATION_CLASSES.MULTIFAMILY_5_PLUS;
  }
  // "Landlord / Multifamily", "Probate / Trust", "Corporate / Institutional",
  // "Follow-Up", "Heavy Negotiation" — no unit-count class claim.
  return null;
}

// ─── Feeder canonical-property-group mapping (vocabulary-stable) ─────────────
//
// The outbound feeder's getCanonicalPropertyGroup vocabulary is preserved for
// its existing callers: 5–10 units are "small_multifamily", >10 are
// "multifamily_5_plus".

export function communicationClassToCanonicalPropertyGroup(communication_class, units_count = null) {
  const cls = clean(communication_class);
  const units = normalizeUnitsCount(units_count);
  switch (cls) {
    case PROPERTY_COMMUNICATION_CLASSES.SINGLE_FAMILY:
      return "sfr";
    case PROPERTY_COMMUNICATION_CLASSES.DUPLEX:
      return "duplex";
    case PROPERTY_COMMUNICATION_CLASSES.TRIPLEX:
      return "triplex";
    case PROPERTY_COMMUNICATION_CLASSES.FOURPLEX:
      return "fourplex";
    case PROPERTY_COMMUNICATION_CLASSES.MULTIFAMILY_5_PLUS:
      return units !== null && units <= 10 ? "small_multifamily" : "multifamily_5_plus";
    default:
      return null;
  }
}

// ─── Hard wording / placeholder guarantees ───────────────────────────────────
//
// Placeholder fields that only make sense for a property with countable units.
// Mirrors ALLOWED_TEMPLATE_PLACEHOLDERS + LEGACY_PLACEHOLDER_ALIASES in
// lib/domain/templates/render-template.js (kept local to stay dependency-free).

export const UNIT_SCOPED_TEMPLATE_FIELDS = Object.freeze([
  "unit_count",
  "occupied_units",
  "monthly_rents",
  "monthly_expenses",
]);

export const UNIT_SCOPED_FIELD_ALIASES = Object.freeze({
  units: "unit_count",
  occupancy: "occupied_units",
  avg_rent: "monthly_rents",
  estimated_expenses: "monthly_expenses",
});

const UNIT_SCOPED_FIELD_SET = new Set([
  ...UNIT_SCOPED_TEMPLATE_FIELDS,
  ...Object.keys(UNIT_SCOPED_FIELD_ALIASES),
]);

/**
 * Extract {{placeholder}} / {placeholder} names from a template body.
 * Same token grammar as render-template.js extractPlaceholders.
 */
export function extractTemplatePlaceholderNames(template_text) {
  const text = String(template_text || "");
  const matches = [
    ...text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g),
    ...text.matchAll(/\{(?!\{)\s*([a-zA-Z0-9_]+)\s*\}(?!\})/g),
  ];
  return [...new Set(matches.map((match) => match[1]))];
}

function templateBodies(template = {}) {
  return [template?.template_body, template?.text, template?.english_translation]
    .map((body) => clean(body))
    .filter(Boolean);
}

function templateVariableNames(template = {}) {
  const declared = Array.isArray(template?.variables) ? template.variables : [];
  const names = declared
    .map((variable) =>
      typeof variable === "string" ? variable : clean(variable?.name || variable?.key)
    )
    .map((name) => clean(name).replace(/^\{\{?\s*/, "").replace(/\s*\}?\}$/, ""))
    .filter(Boolean);
  for (const body of templateBodies(template)) {
    names.push(...extractTemplatePlaceholderNames(body));
  }
  return [...new Set(names.map((name) => name.toLowerCase()))];
}

/**
 * Unit-scoped placeholder fields (canonical names) used by a template — from
 * its declared variables AND the placeholders in its body.
 */
export function templateUnitScopedFieldNames(template = {}) {
  const used = new Set();
  for (const name of templateVariableNames(template)) {
    if (UNIT_SCOPED_FIELD_SET.has(name)) {
      used.add(UNIT_SCOPED_FIELD_ALIASES[name] || name);
    }
  }
  return [...used];
}

// Wording markers, checked against normalized (lowercased, diacritic-stripped)
// body text. Placeholder tokens like {{unit_count}} do NOT trip the \bunits?\b
// regex because the underscore continues the word.
const PLEX_WORDING = Object.freeze({
  [PROPERTY_COMMUNICATION_CLASSES.DUPLEX]: Object.freeze(["duplex"]),
  [PROPERTY_COMMUNICATION_CLASSES.TRIPLEX]: Object.freeze(["triplex"]),
  [PROPERTY_COMMUNICATION_CLASSES.FOURPLEX]: Object.freeze(["fourplex", "quadplex", "four-plex"]),
});

const FIVE_PLUS_WORDING = Object.freeze(["5+ units", "5 plus units", "five plus units"]);

// "units"/"unit" as standalone words (English), "unidad(es)" (Spanish).
const UNITS_WORD_PATTERN = /\bunits?\b|\bunidad(?:es)?\b/;

function bodyWordingHits(normalized_body, markers) {
  return markers.filter((marker) => normalized_body.includes(marker));
}

/**
 * Violations of the hard class wording rules for a raw or rendered body.
 * Returns [] when the class permits the wording (or when class is null/empty,
 * i.e. no class claim exists — callers must not treat that as "safe unknown").
 */
export function renderedBodyViolationsForClass(body, communication_class) {
  const cls = clean(communication_class);
  const normalized = normalizeText(body);
  if (!cls || !normalized) return [];

  const violations = [];
  const pushWordHits = (markers) => {
    for (const hit of bodyWordingHits(normalized, markers)) {
      violations.push(`unit_wording_forbidden:${hit}`);
    }
  };

  if (
    cls === PROPERTY_COMMUNICATION_CLASSES.SINGLE_FAMILY ||
    cls === PROPERTY_COMMUNICATION_CLASSES.UNKNOWN
  ) {
    pushWordHits(PLEX_WORDING[PROPERTY_COMMUNICATION_CLASSES.DUPLEX]);
    pushWordHits(PLEX_WORDING[PROPERTY_COMMUNICATION_CLASSES.TRIPLEX]);
    pushWordHits(PLEX_WORDING[PROPERTY_COMMUNICATION_CLASSES.FOURPLEX]);
    pushWordHits(FIVE_PLUS_WORDING);
    if (UNITS_WORD_PATTERN.test(normalized)) {
      violations.push("unit_wording_forbidden:units");
    }
    return [...new Set(violations)];
  }

  if (cls === PROPERTY_COMMUNICATION_CLASSES.MULTIFAMILY_5_PLUS) {
    pushWordHits(PLEX_WORDING[PROPERTY_COMMUNICATION_CLASSES.DUPLEX]);
    pushWordHits(PLEX_WORDING[PROPERTY_COMMUNICATION_CLASSES.TRIPLEX]);
    pushWordHits(PLEX_WORDING[PROPERTY_COMMUNICATION_CLASSES.FOURPLEX]);
    return [...new Set(violations)];
  }

  if (PLEX_WORDING[cls]) {
    for (const [other_class, markers] of Object.entries(PLEX_WORDING)) {
      if (other_class === cls) continue;
      pushWordHits(markers);
    }
    pushWordHits(FIVE_PLUS_WORDING);
    return [...new Set(violations)];
  }

  return [];
}

/**
 * Full template-level violations for a communication class:
 *   - forbidden unit-scoped placeholders (single_family / unknown)
 *   - forbidden wording in body / english_translation
 *
 * `communication_class` null/empty means "no class claim" → no violations.
 */
export function templateWordingViolationsForClass(template = {}, communication_class) {
  const cls = clean(communication_class);
  if (!cls) return [];

  const violations = [];

  if (
    cls === PROPERTY_COMMUNICATION_CLASSES.SINGLE_FAMILY ||
    cls === PROPERTY_COMMUNICATION_CLASSES.UNKNOWN
  ) {
    for (const field of templateUnitScopedFieldNames(template)) {
      violations.push(`unit_placeholder_forbidden:${field}`);
    }
  }

  for (const body of templateBodies(template)) {
    violations.push(...renderedBodyViolationsForClass(body, cls));
  }

  return [...new Set(violations)];
}

/**
 * Hard selection guard: {allowed, violations}. A template with violations is
 * UNSELECTABLE for that class — this is a filter, not a score.
 */
export function isTemplateAllowedForCommunicationClass(template = {}, communication_class) {
  const violations = templateWordingViolationsForClass(template, communication_class);
  return { allowed: violations.length === 0, violations };
}

/**
 * Forbidden placeholder fields for a class (matrix `forbidden_fields`).
 */
export function forbiddenTemplateFieldsForClass(communication_class) {
  const cls = clean(communication_class);
  if (
    cls === PROPERTY_COMMUNICATION_CLASSES.SINGLE_FAMILY ||
    cls === PROPERTY_COMMUNICATION_CLASSES.UNKNOWN
  ) {
    return [...UNIT_SCOPED_TEMPLATE_FIELDS];
  }
  return [];
}

export default {
  PROPERTY_COMMUNICATION_CLASSES,
  PROPERTY_COMMUNICATION_CLASS_VALUES,
  normalizeUnitsCount,
  parseUnitsCountFromLabel,
  communicationClassFromUnits,
  communicationClassFromLabel,
  labelIndicatesMultifamily,
  describePropertyCommunicationClass,
  resolvePropertyCommunicationClass,
  communicationClassToPropertyTypeScope,
  communicationClassFromPropertyTypeScope,
  communicationClassToCanonicalPropertyGroup,
  UNIT_SCOPED_TEMPLATE_FIELDS,
  UNIT_SCOPED_FIELD_ALIASES,
  extractTemplatePlaceholderNames,
  templateUnitScopedFieldNames,
  renderedBodyViolationsForClass,
  templateWordingViolationsForClass,
  isTemplateAllowedForCommunicationClass,
  forbiddenTemplateFieldsForClass,
};
