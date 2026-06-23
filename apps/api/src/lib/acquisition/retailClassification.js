/**
 * Acquisition Engine V3 — Item 5E §1, §2, §3: retail classification.
 *
 * Three questions, kept separate:
 *   (1) Is the subject GENUINELY retail real estate? (vs a gas station / car wash
 *       / auto-service / dealership / restaurant BUSINESS sale / mixed-use /
 *       warehouse-showroom / land). A generic "retail" flag alone is NEVER enough.
 *   (2) What retail SUBTYPE is it? (single-tenant net lease / freestanding /
 *       neighborhood/unanchored/community/grocery-anchored center / big box /
 *       multi-tenant storefront / retail condo / ground lease / mixed-use).
 *   (3) What TENANCY structure and OPERATIONAL status? (single/multi-tenant /
 *       owner-occupied / vacant; stabilized / value-add / lease-up / redevelopment
 *       / dark).
 *
 * Missing occupancy is NEVER treated as zero occupancy. Pure & deterministic.
 */

import { ASSET_LANES, lower, num, clean } from './modelConstants.js';
import { classifyAssetLane } from './assetClassification.js';
import {
  RETAIL_SUBTYPE as ST,
  RETAIL_RECORD_CLASS as RC,
  RETAIL_TENANCY as TEN,
  RETAIL_OPERATIONAL_STATUS as OS,
  PRICING_ELIGIBLE_RECORD_CLASSES,
  GENUINE_RETAIL_MIN_CONFIDENCE,
  MULTI_TENANT_MIN_GLA_SQFT,
  RETAIL_IMPLAUSIBLE_GLA_SQFT,
  RETAIL_OCCUPANCY_BANDS as OB,
  RETAIL_CONCENTRATION,
} from './retailConstants.js';

function blob(row = {}) {
  return lower(
    [
      row.canonical_asset_lane, row.normalized_asset_class, row.normalized_asset_subclass,
      row.asset_class, row.asset_subclass, row.asset_subtype, row.asset_type, row.asset_label,
      row.asset_type_label, row.property_type, row.property_subtype, row.commercial_property_type,
      row.commercial_subtype, row.land_use, row.county_land_use_code, row.zoning,
      row.original_property_type, row.import_asset_signal, row.tenant_name, row.anchor_tenant,
    ].filter(Boolean).join(' '),
  );
}

const RETAIL_RE = /(strip (mall|center|plaza)|shopping center|retail center|neighborhood center|community center|grocery.?anchor|power center|outlet|big.?box|single.?tenant|net.?lease|\bnnn\b|freestanding retail|storefront|retail cond|ground lease|pharmacy|drug ?store|dollar store|bank branch|quick.?service|\bqsr\b|restaurant|\bretail\b|convenience)/;
const SPECIALTY_RE = {
  fuel: /(gas station|fuel|petroleum|service station|truck stop|c.?store with fuel|convenience.{0,8}fuel)/,
  car_wash: /car ?wash|auto ?wash/,
  auto_service: /auto (repair|service|body)|tire (shop|center)|lube|muffler|mechanic|smog/,
  dealership: /dealership|auto (mall|dealer)|car dealer|rv dealer|motorcycle dealer/,
  restaurant_business: /(restaurant|bar|cafe|diner).{0,20}(business|opportunity|for sale|turnkey|ffe|f.f.e)/,
  business_opportunity: /business opportunity|franchise (for sale|opportunity|resale)|goodwill|turnkey business/,
  mixed_use: /mixed.?use|live.?work|residential (over|above)|apartments? above/,
  warehouse_showroom: /warehouse showroom|showroom warehouse|flex retail/,
};

/** Resolve gross leasable / building area from the usual size fields. */
function resolveGla(row = {}) {
  return num(row.gross_leasable_area) ?? num(row.net_rentable_area) ?? num(row.building_square_feet) ?? num(row.sqft) ?? null;
}

/**
 * Decide whether a retail-flagged subject is GENUINELY retail real estate, and
 * separate specialty / business-sale / mixed-use false positives. Returns a
 * graded confidence + the contradictory/missing signals.
 */
export function classifyRetailAsset(row = {}) {
  const base = classifyAssetLane(row);
  const b = blob(row);
  const reasoning = [];
  const conflicting = [];

  const retailBool =
    row.is_retail === true || row.is_retail_center === true ||
    row.is_strip_center === true || row.is_shopping_center === true ||
    row.is_net_lease === true;
  const retailKeyword = RETAIL_RE.test(b);
  const retailLane = base.lane === ASSET_LANES.RETAIL_STRIP_CENTER || base.lane === ASSET_LANES.RETAIL_SINGLE_TENANT;
  const suites = num(row.number_of_suites) ?? num(row.suite_count) ?? num(row.strip_center_units);

  const retailSignal = retailLane || retailBool || retailKeyword || suites !== null;

  if (!retailSignal) {
    return {
      is_retail: false,
      lane: base.lane,
      subtype: ST.NOT_RETAIL,
      record_class: RC.NOT_RETAIL,
      genuine_retail: false,
      confidence: 0,
      reasoning: ['no_retail_signal'],
      conflicting_signals: [],
      missing_requirements: ['retail_classification'],
      specialized_lane_required: null,
    };
  }

  if (retailLane) reasoning.push('canonical_retail_lane');
  if (retailBool) reasoning.push('retail_boolean_flag');
  if (retailKeyword) reasoning.push('retail_keyword');
  if (suites !== null) reasoning.push('suite_count_present');

  // ---- Specialty / business-sale separation (mission §2) ----
  // These must NOT silently enter generic retail pricing.
  let specialtyLane = null;
  if (SPECIALTY_RE.business_opportunity.test(b) || SPECIALTY_RE.restaurant_business.test(b)) {
    conflicting.push('business_sale_or_franchise_not_real_estate');
    specialtyLane = 'BUSINESS_VALUE_REVIEW';
  } else if (SPECIALTY_RE.fuel.test(b)) { conflicting.push('fuel_station_environmental_specialty'); specialtyLane = 'FUEL_CSTORE_LANE'; }
  else if (SPECIALTY_RE.car_wash.test(b)) { conflicting.push('car_wash_specialty'); specialtyLane = 'CAR_WASH_LANE'; }
  else if (SPECIALTY_RE.auto_service.test(b)) { conflicting.push('auto_service_environmental_specialty'); specialtyLane = 'AUTO_SERVICE_LANE'; }
  else if (SPECIALTY_RE.dealership.test(b)) { conflicting.push('dealership_specialty'); specialtyLane = 'DEALERSHIP_LANE'; }
  else if (SPECIALTY_RE.mixed_use.test(b)) { conflicting.push('mixed_use_retail_residential'); specialtyLane = 'MIXED_USE_LANE'; }
  else if (SPECIALTY_RE.warehouse_showroom.test(b)) { conflicting.push('warehouse_showroom_flex'); specialtyLane = 'INDUSTRIAL_FLEX_LANE'; }

  // ---- Subtype (mission §2) ----
  const gla = resolveGla(row);
  const subtype = resolveSubtype(b, row, gla, suites);

  // ---- Physical-plausibility gate ----
  let genuineRetail = true;
  if (gla === null) {
    genuineRetail = false;
    conflicting.push('no_building_size_to_confirm_retail');
  } else if (gla < RETAIL_IMPLAUSIBLE_GLA_SQFT) {
    genuineRetail = false;
    conflicting.push(`size_${Math.round(gla)}sqft_implausible_as_retail`);
  }
  if (specialtyLane) genuineRetail = false; // specialty routes away from generic retail

  // ---- Confidence ----
  let confidence = retailLane ? base.confidence : 55;
  if (retailBool && retailKeyword) confidence = Math.max(confidence, 78);
  if (suites !== null && suites >= 2) confidence = Math.max(confidence, 72);
  // A generic retail flag alone cannot establish a high-confidence SUBTYPE.
  if (subtype === ST.AMBIGUOUS_RETAIL) confidence = Math.min(confidence, 45);
  if (!genuineRetail) confidence = Math.min(confidence, 40);
  if (conflicting.length) confidence = Math.min(confidence, 45);

  const missing = [];
  if (gla === null) missing.push('gross_leasable_area');
  if (suites === null) missing.push('suite_count');

  return {
    is_retail: true,
    lane: retailLane ? base.lane : (subtype === ST.SINGLE_TENANT_NET_LEASE || subtype === ST.FREESTANDING_RETAIL ? ASSET_LANES.RETAIL_SINGLE_TENANT : ASSET_LANES.RETAIL_STRIP_CENTER),
    subtype,
    genuine_retail: genuineRetail,
    confidence: Math.round(confidence),
    reasoning,
    conflicting_signals: conflicting,
    missing_requirements: missing,
    specialized_lane_required: specialtyLane,
  };
}

/** Resolve the retail subtype from text + structure. */
function resolveSubtype(b, row, gla, suites) {
  if (/ground lease/.test(b)) return ST.GROUND_LEASE;
  if (/retail cond/.test(b)) return ST.RETAIL_CONDOMINIUM;
  if (/mixed.?use/.test(b)) return ST.MIXED_USE_RETAIL;
  if (/grocery.?anchor|supermarket anchor/.test(b)) return ST.GROCERY_ANCHORED_CENTER;
  if (/power center|community (shopping )?center/.test(b)) return ST.COMMUNITY_SHOPPING_CENTER;
  if (/big.?box|\bsuperstore\b/.test(b)) return ST.BIG_BOX_RETAIL;
  if (/(single.?tenant|net.?lease|\bnnn\b|freestanding retail|pad site|outparcel)/.test(b)) return ST.SINGLE_TENANT_NET_LEASE;
  if (/freestanding|stand.?alone/.test(b)) return ST.FREESTANDING_RETAIL;
  const owner = row.owner_occupied === true || /owner.?occupied/.test(b);
  if (owner) return ST.OWNER_OCCUPIED_RETAIL;
  if (/redevelop|teardown|demolition/.test(b)) return ST.REDEVELOPMENT_RETAIL;
  if (/strip (mall|center|plaza)|neighborhood center/.test(b)) {
    // A strip with a grocery/anchor is grocery-anchored; otherwise unanchored.
    if (/anchor/.test(b)) return ST.NEIGHBORHOOD_STRIP_CENTER;
    return ST.UNANCHORED_STRIP_CENTER;
  }
  if (/shopping center|retail center|storefront/.test(b)) {
    if (suites !== null && suites >= 2) return ST.MULTI_TENANT_STOREFRONT;
    return ST.MULTI_TENANT_STOREFRONT;
  }
  // Plain "retail" keyword with multi-suite evidence → strip; else ambiguous.
  if (suites !== null && suites >= 2 && gla !== null && gla >= MULTI_TENANT_MIN_GLA_SQFT) return ST.NEIGHBORHOOD_STRIP_CENTER;
  return ST.AMBIGUOUS_RETAIL;
}

/**
 * Classify WHAT KIND of record this is — hardened against specialty / business-
 * sale / mixed-use false positives. A genuine, priceable retail record needs
 * plausible size AND corroboration (suite/tenant/lease evidence, an explicit
 * retail-center keyword, or operating data). A binary retail flag alone is
 * AMBIGUOUS, not a priced center.
 *
 * @returns {{ classification, confidence, supporting_signals, contradictory_signals,
 *   missing_evidence, pricing_eligible, underwriting_eligible, specialty,
 *   environmental_review_required }}
 */
export function classifyRetailRecord(row = {}, { hasOperatingData = false, hasLeaseData = false } = {}) {
  const b = blob(row);
  const support = [];
  const contra = [];
  const missing = [];

  const asset = classifyRetailAsset(row);
  if (!asset.is_retail) {
    return result(RC.NOT_RETAIL, 0, ['no_retail_signal'], [], ['retail_classification']);
  }

  const gla = resolveGla(row);
  const lot = num(row.lot_square_feet) ?? num(row.land_sqft) ?? num(row.lot_size_sqft);
  const suites = num(row.number_of_suites) ?? num(row.suite_count) ?? num(row.strip_center_units);
  const tenants = num(row.tenant_count) ?? (Array.isArray(row.tenants) ? row.tenants.length : null);
  const underConstruction = row.under_construction === true || /under construction|proposed|pre.?leasing/.test(b);
  const explicitCenter = /(strip (mall|center|plaza)|shopping center|retail center|neighborhood center|community center|grocery.?anchor|power center)/.test(b);

  // ---- Specialty / business-sale buckets first (route away from generic retail) ----
  if (SPECIALTY_RE.business_opportunity.test(b)) {
    contra.push('business_opportunity_keyword');
    return result(RC.BUSINESS_OPPORTUNITY, 55, ['business_opportunity'], contra, [], { specialty: true });
  }
  if (SPECIALTY_RE.restaurant_business.test(b)) {
    contra.push('restaurant_business_sale_keyword');
    return result(RC.RESTAURANT_BUSINESS_SALE, 55, ['restaurant_business_sale'], contra, ['real_estate_only_consideration'], { specialty: true });
  }
  if (SPECIALTY_RE.fuel.test(b)) {
    contra.push('fuel_station_keyword');
    return result(RC.GAS_STATION_FUEL, 58, ['fuel_keyword'], contra, ['environmental_phase_I'], { specialty: true, environmental: true });
  }
  if (SPECIALTY_RE.car_wash.test(b)) {
    contra.push('car_wash_keyword');
    return result(RC.CAR_WASH, 55, ['car_wash_keyword'], contra, ['environmental_phase_I'], { specialty: true, environmental: true });
  }
  if (SPECIALTY_RE.auto_service.test(b)) {
    contra.push('auto_service_keyword');
    return result(RC.AUTO_SERVICE_REPAIR, 55, ['auto_service_keyword'], contra, ['environmental_phase_I'], { specialty: true, environmental: true });
  }
  if (SPECIALTY_RE.dealership.test(b)) {
    contra.push('dealership_keyword');
    return result(RC.AUTO_DEALERSHIP, 52, ['dealership_keyword'], contra, [], { specialty: true, environmental: true });
  }
  if (SPECIALTY_RE.mixed_use.test(b)) {
    contra.push('mixed_use_retail_residential');
    return result(RC.MIXED_USE_RETAIL_RESIDENTIAL, 50, ['mixed_use_keyword'], contra, ['retail_component_allocation']);
  }
  if (SPECIALTY_RE.warehouse_showroom.test(b)) {
    contra.push('warehouse_showroom_flex');
    return result(RC.WAREHOUSE_SHOWROOM, 45, ['warehouse_showroom'], contra, ['retail_use_confirmation']);
  }
  if (underConstruction || /redevelop|teardown/.test(b)) {
    support.push('redevelopment_or_construction');
    return result(RC.REDEVELOPMENT_RETAIL, 50, support, contra, ['entitlement_status']);
  }
  if (/ground lease/.test(b)) {
    support.push('ground_lease_keyword');
    return result(RC.GROUND_LEASE_RETAIL, 60, support, contra, ['ground_rent_terms']);
  }

  // ---- Size / plausibility gate ----
  if (gla === null || gla < RETAIL_IMPLAUSIBLE_GLA_SQFT) {
    if (lot && lot > 0 && (gla === null || gla < 400)) {
      return result(RC.LAND_OR_DEVELOPMENT_SITE, 50, ['lot_present_no_building'], ['no_improvements'], ['building_evidence']);
    }
    contra.push(gla === null ? 'no_building_size' : `size_${Math.round(gla)}sqft_implausible`);
    return result(RC.AMBIGUOUS_RETAIL, 40, ['sub_retail_size'], contra, ['gross_leasable_area']);
  }

  // ---- Vacancy ----
  const occ = num(row.physical_occupancy) ?? num(row.occupancy);
  if ((occ !== null && (occ > 1 ? occ / 100 : occ) <= 0.02) || row.is_vacant === true) {
    support.push('vacant_retail');
    return result(RC.VACANT_RETAIL, 55, support, contra, ['re_tenanting_plan']);
  }

  const corroboration = (suites !== null && suites >= 2) || (tenants !== null && tenants >= 1) || explicitCenter || hasLeaseData || hasOperatingData;

  // ---- Multi-tenant center vs single-tenant / freestanding ----
  if (gla !== null) support.push(`size_${Math.round(gla)}sqft`);
  if (suites !== null) support.push(`suites=${suites}`);
  if (tenants !== null) support.push(`tenants=${tenants}`);
  if (explicitCenter) support.push('explicit_retail_center_keyword');
  if (hasLeaseData) support.push('lease_data_present');
  if (hasOperatingData) support.push('operating_data_present');

  // A binary retail flag alone (no corroboration) is AMBIGUOUS, not a priced center.
  if (!corroboration) {
    if (!explicitCenter) missing.push('retail_center_confirmation');
    missing.push('suites_or_tenants_or_lease_data');
    return result(RC.AMBIGUOUS_RETAIL, 42, support, ['binary_retail_flag_only'], missing);
  }

  const isMultiTenant = (suites !== null && suites >= 2) || (tenants !== null && tenants >= 2) || explicitCenter;
  let cls;
  let confidence;
  if (isMultiTenant && gla >= MULTI_TENANT_MIN_GLA_SQFT) {
    cls = RC.MULTI_TENANT_RETAIL_CENTER; confidence = 62;
  } else if (/(single.?tenant|net.?lease|\bnnn\b)/.test(b)) {
    cls = RC.SINGLE_TENANT_RETAIL; confidence = 64;
  } else {
    cls = RC.FREESTANDING_RETAIL; confidence = 58;
  }

  if (explicitCenter) confidence += 8;
  if (suites !== null && suites >= 3) confidence += 8;
  if (hasLeaseData) confidence += 10;
  if (hasOperatingData) confidence += 8;
  if (contra.length) confidence = Math.min(confidence, 55);
  confidence = Math.max(0, Math.min(95, confidence));

  if (suites === null) missing.push('suite_count');
  if (!hasLeaseData) missing.push('lease_data');

  return result(cls, confidence, support, contra, missing);
}

function result(classification, confidence, supporting_signals, contradictory_signals, missing_evidence, opts = {}) {
  const pricingEligible = PRICING_ELIGIBLE_RECORD_CLASSES.includes(classification) && confidence >= GENUINE_RETAIL_MIN_CONFIDENCE;
  return {
    classification,
    confidence: Math.round(confidence),
    supporting_signals,
    contradictory_signals,
    missing_evidence,
    pricing_eligible: pricingEligible,
    underwriting_eligible: pricingEligible,
    specialty: Boolean(opts.specialty),
    environmental_review_required: Boolean(opts.environmental),
  };
}

/** Normalize a 0..1 or 0..100 occupancy into a fraction, or null. */
function asFraction(occ) {
  const o = num(occ);
  if (o === null) return null;
  return o > 1 ? o / 100 : o;
}

/**
 * Tenancy-structure classification (mission §3). single / multi-tenant / owner-
 * occupied / vacant — distinct from the operational lifecycle. Driven by suite /
 * tenant / lease evidence; never assumed.
 */
export function classifyRetailTenancy({ contract = null, rentRoll = null, row = {} } = {}) {
  const c = contract ?? {};
  const occupiedSuites = num(rentRoll?.occupied_suites ?? c.unit_inventory?.occupied_suites?.value);
  const totalSuites = num(rentRoll?.total_suites ?? c.unit_inventory?.number_of_suites?.value ?? row.number_of_suites);
  const leaseCount = Array.isArray(rentRoll?.leases) ? rentRoll.leases.length : null;
  const ownerOccupied = row.owner_occupied === true || c.identity?.owner_occupied?.value === true;
  const occ = asFraction(rentRoll?.physical_occupancy ?? c.operations?.physical_occupancy?.value ?? row.physical_occupancy);

  const evidence = [];
  const missing = [];

  if (ownerOccupied) { evidence.push('owner_occupied_flag'); return { tenancy: TEN.OWNER_OCCUPIED, confidence: 60, evidence, missing }; }
  if (occ !== null && occ <= 0.02) { evidence.push('zero_occupancy'); return { tenancy: TEN.VACANT, confidence: 55, evidence, missing }; }

  if (totalSuites !== null) {
    if (totalSuites <= 1 && (leaseCount === null || leaseCount <= 1)) { evidence.push('single_suite'); return { tenancy: TEN.SINGLE_TENANT, confidence: 55, evidence, missing }; }
    if (totalSuites >= 2) { evidence.push(`multi_suite=${totalSuites}`); return { tenancy: TEN.MULTI_TENANT, confidence: 60, evidence, missing }; }
  }
  if (leaseCount !== null) {
    if (leaseCount >= 2) { evidence.push(`multi_lease=${leaseCount}`); return { tenancy: TEN.MULTI_TENANT, confidence: 58, evidence, missing }; }
    if (leaseCount === 1) { evidence.push('single_lease'); return { tenancy: TEN.SINGLE_TENANT, confidence: 50, evidence, missing }; }
  }
  missing.push('suite_or_lease_count');
  return { tenancy: TEN.UNKNOWN, confidence: 20, evidence, missing };
}

/**
 * Operational-status classification (mission §3). Uses physical occupancy,
 * near-term rollover, dark-tenant signal, redevelopment intent and recency.
 * Missing occupancy stays UNKNOWN — never 0.
 */
export function classifyRetailOperationalStatus({ contract = null, rentRoll = null, row = {} } = {}) {
  const c = contract ?? {};
  const evidence = [];
  const missing = [];
  const contradictory = [];

  const physOcc = asFraction(rentRoll?.physical_occupancy ?? c.operations?.physical_occupancy?.value ?? row.physical_occupancy);
  const econOcc = asFraction(rentRoll?.economic_occupancy ?? c.operations?.economic_occupancy?.value);
  const darkExposure = num(rentRoll?.dark_gla ?? c.operations?.dark_gla?.value);
  const redevelopment = row.redevelopment_intent === true || /redevelop|teardown/.test(lower(row.property_type ?? ''));
  const recentBuild = num(c.identity?.year_built?.value ?? row.year_built);

  let status = OS.UNKNOWN;
  let confidence = 20;

  if (redevelopment) {
    status = OS.REDEVELOPMENT; confidence = 55; evidence.push('redevelopment_intent');
  } else if (physOcc === null) {
    status = OS.UNKNOWN; confidence = 20; missing.push('physical_occupancy');
  } else if (physOcc <= 0.02) {
    status = OS.VACANT; confidence = 60; evidence.push('no_occupancy_vacant');
  } else {
    evidence.push(`physical_occupancy=${(physOcc * 100).toFixed(0)}%`);
    if (physOcc <= OB.lease_up_max && recentBuild !== null && (2026 - recentBuild) <= 4) {
      status = OS.LEASE_UP; confidence = 60; evidence.push('low_occupancy_recent_construction');
    } else if (physOcc <= OB.value_add_max) {
      status = OS.VALUE_ADD; confidence = 58; evidence.push('below_stabilized_occupancy');
    } else {
      status = OS.STABILIZED; confidence = 64; evidence.push('at_or_above_stabilized_occupancy');
    }
    // Economic-occupancy gap (gone-dark tenants still paying) → value-add/dark.
    if (darkExposure !== null && darkExposure > 0) {
      contradictory.push('dark_space_present');
      status = OS.DARK;
    } else if (econOcc !== null && physOcc - econOcc >= 0.1) {
      contradictory.push('economic_occupancy_materially_below_physical');
      if (status === OS.STABILIZED) status = OS.VALUE_ADD;
    }
  }

  if (econOcc === null) missing.push('economic_occupancy');

  return {
    operational_status: status,
    confidence: Math.round(confidence),
    supporting_evidence: evidence,
    missing_requirements: [...new Set(missing)],
    contradictory_signals: contradictory,
  };
}
