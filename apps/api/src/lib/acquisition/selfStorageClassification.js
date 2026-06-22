/**
 * Acquisition Engine V3 — Item 5D §1 & §3: self-storage classification.
 *
 * Two questions, kept separate:
 *   (1) Is the subject GENUINELY a self-storage facility? (vs storage condo,
 *       portable-storage business, garage, or a parcel merely carrying a storage
 *       land-use code). Driven by the canonical lane + storage keywords + a
 *       physical-plausibility gate (audit §1: CA cohort is sub-10k-sqft noise).
 *   (2) What is its OPERATIONAL status? STABILIZED / VALUE_ADD / LEASE_UP /
 *       DISTRESSED / DEVELOPMENT / CONVERSION / EXPANSION / LAND_ONLY / UNKNOWN.
 *
 * Missing occupancy is NEVER treated as zero occupancy. Pure & deterministic.
 */

import { ASSET_LANES, lower, num } from './modelConstants.js';
import { classifyAssetLane } from './assetClassification.js';
import {
  STORAGE_OPERATIONAL_STATUS as OS,
  STORAGE_FACILITY_TYPE as FT,
  STORAGE_FACILITY_CLASS as FC,
  GENUINE_FACILITY_MIN_GBA_SQFT,
  FACILITY_IMPLAUSIBLE_GBA_SQFT,
  STORAGE_OCCUPANCY_BANDS as OB,
} from './selfStorageConstants.js';

function blob(row = {}) {
  return lower(
    [
      row.canonical_asset_lane, row.normalized_asset_class, row.normalized_asset_subclass,
      row.asset_class, row.asset_subclass, row.asset_subtype, row.asset_type, row.asset_label,
      row.asset_type_label, row.property_type, row.property_subtype, row.commercial_property_type,
      row.commercial_subtype, row.land_use, row.county_land_use_code, row.zoning,
      row.original_property_type, row.import_asset_signal,
    ].filter(Boolean).join(' '),
  );
}

const STORAGE_RE = /(self.?storage|mini.?storage|mini.?warehouse|storage facility|storage units?|climate.?controlled storage|vehicle storage|rv storage|boat storage|warehouse storage|storage cond|portable storage)/;

/** Resolve a facility's gross building area from the usual size fields. */
function resolveGba(row = {}) {
  return num(row.gross_building_area) ?? num(row.building_square_feet) ?? num(row.sqft) ?? null;
}

/**
 * Decide whether a storage-flagged subject is GENUINELY an operating facility.
 * Returns a graded confidence + the contradictory/missing signals.
 */
export function classifySelfStorageFacility(row = {}) {
  const base = classifyAssetLane(row);
  const b = blob(row);
  const reasoning = [];
  const conflicting = [];

  const storageBool =
    row.is_self_storage === true || row.is_self_storage_facility === true ||
    row.is_mini_storage === true || row.is_mini_storage_facility === true ||
    row.is_storage === true || row.is_storage_facility === true;
  const storageKeyword = STORAGE_RE.test(b);
  const storageUnits = num(row.storage_units);

  const isStorageLane = base.lane === ASSET_LANES.SELF_STORAGE;
  const storageSignal = isStorageLane || storageBool || storageKeyword || storageUnits !== null;

  if (!storageSignal) {
    return {
      is_self_storage: false,
      lane: base.lane,
      facility_type: FT.UNKNOWN,
      genuine_facility: false,
      confidence: 0,
      reasoning: ['no_storage_signal'],
      conflicting_signals: [],
      missing_requirements: ['storage_classification'],
    };
  }

  if (isStorageLane) reasoning.push('canonical_self_storage_lane');
  if (storageBool) reasoning.push('storage_boolean_flag');
  if (storageKeyword) reasoning.push('storage_keyword');
  if (storageUnits !== null) reasoning.push('storage_unit_count');

  // ---- Facility type (physical configuration) ----
  let facilityType = FT.UNKNOWN;
  if (/storage cond/.test(b)) { facilityType = FT.STORAGE_CONDO; conflicting.push('storage_condominium_not_operating_facility'); }
  else if (/portable storage|mobile storage|container (rental|business)/.test(b)) { facilityType = FT.PORTABLE_STORAGE_BUSINESS; conflicting.push('portable_storage_business_not_real_estate'); }
  else if (/rv|boat|vehicle/.test(b)) facilityType = FT.VEHICLE_RV_BOAT;
  else if (/climate.?control/.test(b)) facilityType = FT.CLIMATE_CONTROLLED;
  else if (/drive.?up/.test(b)) facilityType = FT.DRIVE_UP;
  else if (num(row.climate_controlled_units) && num(row.drive_up_units)) facilityType = FT.MIXED;

  // ---- Physical-plausibility gate (audit §1) ----
  const gba = resolveGba(row);
  const nrsf = num(row.net_rentable_square_feet);
  const size = nrsf ?? gba;
  let genuineFacility = true;
  if (size === null) {
    genuineFacility = false;
    conflicting.push('no_building_size_to_confirm_facility');
  } else if (size < FACILITY_IMPLAUSIBLE_GBA_SQFT) {
    genuineFacility = false;
    conflicting.push(`size_${Math.round(size)}sqft_implausible_as_facility`);
  } else if (size < GENUINE_FACILITY_MIN_GBA_SQFT) {
    genuineFacility = false; // suspect: likely garage / condo / land-use-coded
    conflicting.push(`size_${Math.round(size)}sqft_below_facility_floor`);
  }
  if (facilityType === FT.STORAGE_CONDO || facilityType === FT.PORTABLE_STORAGE_BUSINESS) {
    genuineFacility = false;
  }

  // ---- Confidence ----
  let confidence = base.lane === ASSET_LANES.SELF_STORAGE ? base.confidence : 55;
  if (storageBool && storageKeyword) confidence = Math.max(confidence, 80);
  if (!genuineFacility) confidence = Math.min(confidence, 40);
  if (conflicting.length) confidence = Math.min(confidence, 45);

  const missing = [];
  if (size === null) missing.push('net_rentable_square_feet');
  if (num(row.total_units) === null && storageUnits === null) missing.push('total_units');

  return {
    is_self_storage: true,
    lane: ASSET_LANES.SELF_STORAGE,
    facility_type: facilityType,
    genuine_facility: genuineFacility,
    confidence: Math.round(confidence),
    reasoning,
    conflicting_signals: conflicting,
    missing_requirements: missing,
  };
}

/** Normalize a 0..1 or 0..100 occupancy into a fraction, or null. */
function asFraction(occ) {
  const o = num(occ);
  if (o === null) return null;
  return o > 1 ? o / 100 : o;
}

/**
 * Operational-status classification (mission §3). Uses occupancy, economic
 * occupancy, rent gap, construction/availability signals, age, deferred
 * maintenance, expansion capacity, revenue/expense trend, delinquency and
 * operating history. Missing occupancy stays UNKNOWN — never 0.
 */
export function classifyStorageOperationalStatus({
  facility = {},
  contract = null,
} = {}) {
  const evidence = [];
  const missing = [];
  const contradictory = [];

  const c = contract ?? {};
  const physOcc = asFraction(c.physical_occupancy?.value ?? facility.physical_occupancy);
  const econOcc = asFraction(c.economic_occupancy?.value ?? facility.economic_occupancy);
  const nrsf = num(c.net_rentable_square_feet?.value ?? facility.net_rentable_square_feet);
  const gba = num(c.gross_building_square_feet?.value ?? facility.gross_building_square_feet);
  const yearBuilt = num(c.year_built?.value ?? facility.year_built);
  const underConstruction =
    facility.under_construction === true || c.under_construction?.value === true;
  const certificateOfOccupancy = facility.certificate_of_occupancy ?? c.certificate_of_occupancy?.value;
  const expansionUnits = num(c.expansion_capacity_units?.value ?? facility.expansion_capacity_units);
  const expansionNrsf = num(c.expansion_capacity_nrsf?.value ?? facility.expansion_capacity_nrsf);
  const deferred = num(facility.deferred_maintenance ?? c.deferred_maintenance?.value);
  const delinquency = asFraction(facility.delinquency ?? c.delinquency?.value);
  const landOnly = facility.land_only === true || (nrsf === null && gba === null && num(facility.land_area) !== null);
  const marketRent = num(c.average_market_rent?.value ?? facility.average_market_rent);
  const inPlaceRent = num(c.average_in_place_rent?.value ?? facility.average_in_place_rent);

  let status = OS.UNKNOWN;
  let confidence = 20;

  if (landOnly) {
    status = OS.LAND_ONLY; confidence = 70; evidence.push('no_improvements_land_only');
  } else if (underConstruction || certificateOfOccupancy === false) {
    status = OS.DEVELOPMENT; confidence = 65; evidence.push('under_construction_or_pre_co');
  } else if (physOcc === null) {
    // No occupancy => cannot assert stabilized/value-add. UNKNOWN, NOT zero.
    status = OS.UNKNOWN; confidence = 20; missing.push('physical_occupancy');
  } else {
    evidence.push(`physical_occupancy=${(physOcc * 100).toFixed(0)}%`);
    if (physOcc <= OB.distressed_max && (delinquency ?? 0) >= 0.15) {
      status = OS.DISTRESSED; confidence = 60; evidence.push('low_occupancy_high_delinquency');
    } else if (physOcc <= OB.lease_up_max && yearBuilt !== null && (2026 - yearBuilt) <= 4) {
      status = OS.LEASE_UP; confidence = 62; evidence.push('low_occupancy_recent_construction');
    } else if (physOcc <= OB.value_add_max) {
      status = OS.VALUE_ADD; confidence = 58; evidence.push('below_stabilized_occupancy');
    } else {
      status = OS.STABILIZED; confidence = 65; evidence.push('at_or_above_stabilized_occupancy');
      // A stabilized facility with a large rent gap is still value-add upside.
      if (marketRent !== null && inPlaceRent !== null && inPlaceRent > 0 && (marketRent - inPlaceRent) / inPlaceRent >= 0.12) {
        status = OS.VALUE_ADD; evidence.push('material_loss_to_lease');
      }
    }
    // Economic vs physical divergence is a value-add / distress signal.
    if (econOcc !== null && physOcc !== null && physOcc - econOcc >= 0.12) {
      contradictory.push('economic_occupancy_materially_below_physical');
      if (status === OS.STABILIZED) status = OS.VALUE_ADD;
    }
  }

  // Expansion capacity is an ADDITIVE overlay, not the primary status, unless the
  // facility is otherwise stabilized — then EXPANSION is the actionable lane.
  const hasExpansion = (expansionUnits ?? 0) > 0 || (expansionNrsf ?? 0) > 0;
  if (hasExpansion && status === OS.STABILIZED) {
    status = OS.EXPANSION; evidence.push('stabilized_with_expansion_capacity');
  }

  if (deferred !== null && deferred > 0) evidence.push('deferred_maintenance_present');
  if (physOcc === null) missing.push('occupancy_for_status');
  if (econOcc === null) missing.push('economic_occupancy');

  return {
    operational_status: status,
    confidence: Math.round(confidence),
    supporting_evidence: evidence,
    missing_requirements: [...new Set(missing)],
    contradictory_signals: contradictory,
  };
}

/** Coarse facility class from age / construction / class hints. */
export function classifyStorageFacilityClass(row = {}) {
  const b = blob(row);
  const explicit = lower(row.property_class ?? row.building_class ?? row.asset_class_grade);
  if (explicit === 'a' || explicit === 'b' || explicit === 'c') return explicit.toUpperCase();
  const year = num(row.year_built);
  const climate = /climate.?control/.test(b);
  if (year !== null) {
    if (year >= 2010 && climate) return FC.A;
    if (year >= 2000) return FC.B;
    if (year < 1995) return FC.C;
    return FC.B;
  }
  return FC.UNKNOWN;
}
