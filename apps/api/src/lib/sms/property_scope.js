// ─── property_scope.js ────────────────────────────────────────────────────
// Resolve template Property Type Scope from property/owner context.
//
// Unit-count parsing is delegated to the canonical property communication
// class module (spine §7) — lib/domain/properties/property-communication-class.js
// — so campaign, feeder, and template paths all agree on what a units signal
// means. This module keeps its exported scope vocabulary stable.

import {
  normalizeUnitsCount,
  parseUnitsCountFromLabel,
} from "@/lib/domain/properties/property-communication-class.js";

const VALID_SCOPES = Object.freeze([
  "Any Residential",
  "Residential",
  "Probate / Trust",
  "Corporate / Institutional",
  "Landlord / Multifamily",
  "Follow-Up",
  "Heavy Negotiation",
  "5+ Units",
  "Duplex",
  "Triplex",
  "Fourplex",
]);

function lc(val) {
  return String(val ?? "").toLowerCase().trim().replace(/[–—]/g, "-");
}

function parseUnitCount(context = {}) {
  // Canonical units signal — `units_count` is the graph/target snapshot column
  // name; `unit_count` is the legacy context key. Both are accepted.
  // Normalize each key independently: a meaningless 0 in the canonical
  // column must not shadow a valid legacy unit_count (?? treats 0 as present).
  const explicit =
    normalizeUnitsCount(context.units_count) ?? normalizeUnitsCount(context.unit_count);
  if (explicit !== null) return explicit;
  return parseUnitsCountFromLabel(context.property_type);
}

function isMultifamily24Label(propertyType = "") {
  const normalized = lc(propertyType);
  return (
    normalized.includes("multifamily 2-4") ||
    normalized.includes("multifamily 2 - 4") ||
    normalized === "multifamily 2-4" ||
    normalized.includes("2-4 unit")
  );
}

function isMultifamily5PlusLabel(propertyType = "") {
  const normalized = lc(propertyType);
  return (
    normalized.includes("multifamily 5+") ||
    normalized.includes("multifamily 5 +") ||
    normalized.includes("5+ unit") ||
    normalized.includes("5 plus")
  );
}

/**
 * Resolve Property Type Scope based on context.
 *
 * @param {object} context
 * @param {string} [context.use_case]
 * @param {boolean} [context.is_follow_up]
 * @param {string} [context.owner_type] - "Corporate", "Trust / Estate", "Individual", etc.
 * @param {string} [context.property_type] - "Single Family", "Multi-Family", etc.
 * @param {number} [context.unit_count] - Number of units (legacy key)
 * @param {number} [context.units_count] - Number of units (canonical snapshot column)
 * @param {boolean} [context.is_probate]
 * @param {boolean} [context.is_trust]
 * @param {boolean} [context.is_corporate]
 * @param {boolean} [context.is_heavy_negotiation]
 * @returns {string} One of the valid property type scope values
 */
export function resolvePropertyTypeScope(context = {}) {
  const uc = lc(context.use_case);
  const owner = lc(context.owner_type);
  const propertyType = lc(context.property_type);
  const units = parseUnitCount(context);

  // 1. Follow-up explicit template rows
  if (context.is_follow_up && isFollowUpUseCase(uc)) {
    return "Follow-Up";
  }

  // 2. Probate / Trust
  if (context.is_probate || context.is_trust || owner === "trust / estate" || owner === "trust" || owner === "estate") {
    return "Probate / Trust";
  }

  // 3. Corporate / Institutional
  if (context.is_corporate || owner === "corporate" || owner === "bank / lender" || owner === "government") {
    return "Corporate / Institutional";
  }

  // Heavy negotiation
  if (context.is_heavy_negotiation) {
    return "Heavy Negotiation";
  }

  // 4. Unit-count based scoping
  if (units !== null) {
    if (units >= 5) return "5+ Units";
    if (units === 4) return "Fourplex";
    if (units === 3) return "Triplex";
    if (units === 2) return "Duplex";
  }

  if (propertyType === "duplex") return "Duplex";
  if (propertyType === "triplex") return "Triplex";
  if (propertyType === "fourplex") return "Fourplex";

  if (isMultifamily5PlusLabel(propertyType)) return "5+ Units";
  if (isMultifamily24Label(propertyType)) {
    if (units === 4) return "Fourplex";
    if (units === 3) return "Triplex";
    if (units === 2) return "Duplex";
    return "Landlord / Multifamily";
  }

  // Multi-family property type without specific unit count
  if (
    propertyType === "multi-family" ||
    propertyType === "multifamily" ||
    propertyType.includes("multi-family") ||
    propertyType.includes("multifamily") ||
    propertyType === "apartment"
  ) {
    return "Landlord / Multifamily";
  }

  // Default residential
  return "Residential";
}

/**
 * Ordered template scopes to try for multifamily / mixed property labels.
 */
export function expandTemplatePropertyScopes(context = {}) {
  const primary = resolvePropertyTypeScope(context);
  const scopes = [primary];
  const propertyType = lc(context.property_type);
  const units = parseUnitCount(context);

  if (isMultifamily24Label(propertyType) || (units != null && units >= 2 && units <= 4)) {
    scopes.push("Duplex", "Triplex", "Fourplex", "Landlord / Multifamily", "Any Residential");
  } else if (isMultifamily5PlusLabel(propertyType) || (units != null && units >= 5)) {
    scopes.push("5+ Units", "Landlord / Multifamily", "Any Residential");
  } else if (["Duplex", "Triplex", "Fourplex", "5+ Units", "Landlord / Multifamily"].includes(primary)) {
    scopes.push("Landlord / Multifamily", "Any Residential");
  } else if (primary === "Residential") {
    scopes.push("Any Residential");
  }

  return [...new Set(scopes.filter(Boolean))];
}

const FOLLOW_UP_USE_CASE_FRAGMENTS = new Set([
  "follow_up", "followup", "follow-up",
  "reengagement", "re_engagement", "re-engagement",
]);

function isFollowUpUseCase(use_case) {
  const uc = lc(use_case);
  for (const frag of FOLLOW_UP_USE_CASE_FRAGMENTS) {
    if (uc.includes(frag)) return true;
  }
  return false;
}

export { VALID_SCOPES };

export default { resolvePropertyTypeScope, expandTemplatePropertyScopes, VALID_SCOPES };
