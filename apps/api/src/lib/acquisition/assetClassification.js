/**
 * Acquisition Engine V3 — canonical asset classification (mission §1).
 *
 * Assigns every subject AND every comparable a single canonical asset lane,
 * using all available evidence. Pure & deterministic.
 *
 * Hard rules enforced here / downstream:
 *  - SFR comps only for SFR (no condo/townhome substitution by default).
 *  - DUPLEX/TRIPLEX/FOURPLEX are distinct from MULTIFAMILY_5+.
 *  - storage / strip / office / medical / industrial / land are distinct lanes.
 *  - UNKNOWN or materially conflicted classification is non-executable.
 */

import {
  ASSET_LANES,
  LANE_FAMILY,
  LANE_FALLBACKS,
  LANE_METHOD,
  ASSET_FAMILIES,
  lower,
  num,
} from './modelConstants.js';

function textBlob(row = {}) {
  return lower(
    [
      row.canonical_asset_lane,
      row.normalized_asset_class,
      row.normalized_asset_subclass,
      row.asset_class,
      row.asset_subclass,
      row.asset_subtype,
      row.asset_type,
      row.asset_label,
      row.asset_type_label,
      row.property_type,
      row.property_class,
      row.property_subtype,
      row.commercial_property_type,
      row.land_use,
      row.county_land_use_code,
      row.zoning,
      row.property_style,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

/** Best-effort unit count from the many unit-ish fields. */
export function resolveUnitCount(row = {}) {
  return (
    num(row.units_count) ??
    num(row.multifamily_units) ??
    num(row.number_of_units) ??
    num(row.num_units) ??
    null
  );
}

function has(blob, re) {
  return re.test(blob);
}

function mfLaneForUnits(units) {
  if (units === null) return null;
  if (units <= 1) return ASSET_LANES.SFR;
  if (units === 2) return ASSET_LANES.DUPLEX;
  if (units === 3) return ASSET_LANES.TRIPLEX;
  if (units === 4) return ASSET_LANES.FOURPLEX;
  if (units <= 20) return ASSET_LANES.MULTIFAMILY_5_20;
  if (units <= 99) return ASSET_LANES.MULTIFAMILY_21_99;
  return ASSET_LANES.MULTIFAMILY_100_PLUS;
}

/**
 * @returns {{
 *  lane: string, family: string, method: string, confidence: number,
 *  reasoning: string[], conflicting_signals: string[], source_fields: string[]
 * }}
 */
export function classifyAssetLane(row = {}) {
  const blob = textBlob(row);
  const units = resolveUnitCount(row);
  const sqft = num(row.building_square_feet) ?? num(row.sqft) ?? null;
  const reasoning = [];
  const conflicting = [];
  const sourceFields = [];

  for (const f of ['property_type', 'normalized_asset_class', 'asset_class', 'asset_subtype', 'land_use', 'zoning', 'units_count']) {
    if (row[f] !== undefined && row[f] !== null && row[f] !== '') sourceFields.push(f);
  }

  let lane = ASSET_LANES.UNKNOWN;
  let confidence = 25;

  const vacantLand =
    row.is_vacant_land === true ||
    has(blob, /vacant land|raw land|land only|unimproved|acreage|vacant lot/);
  const hasBuilding = (sqft ?? 0) > 200;

  // 1) Land
  if (vacantLand && !hasBuilding) {
    if (has(blob, /agricultur|farm|ranch|timber|crop|pasture/)) lane = ASSET_LANES.LAND_AGRICULTURAL;
    else if (has(blob, /commercial|retail|office|industrial|mixed/)) lane = ASSET_LANES.LAND_COMMERCIAL;
    else lane = ASSET_LANES.LAND_RESIDENTIAL;
    confidence = 70;
    reasoning.push('vacant_land_signal');
  }
  // 2) Self storage
  else if (has(blob, /self.?storage|mini.?storage|storage facility/) || num(row.storage_units)) {
    lane = ASSET_LANES.SELF_STORAGE;
    confidence = 80;
    reasoning.push('storage_keyword');
  }
  // 3) Hospitality
  else if (has(blob, /hotel|motel|hospitality|\binn\b|resort|lodging/)) {
    lane = ASSET_LANES.HOSPITALITY;
    confidence = 80;
    reasoning.push('hospitality_keyword');
  }
  // 4) Mobile home park
  else if (has(blob, /mobile home park|manufactured home (community|park)|\bmhp\b|rv park/)) {
    lane = ASSET_LANES.MOBILE_HOME_PARK;
    confidence = 80;
    reasoning.push('mhp_keyword');
  }
  // 5) Retail
  else if (has(blob, /strip (mall|center)|shopping center|retail center/) || num(row.strip_center_units)) {
    lane = ASSET_LANES.RETAIL_STRIP_CENTER;
    confidence = 75;
    reasoning.push('strip_retail_keyword');
  } else if (has(blob, /single.?tenant|net lease|\bnnn\b|freestanding retail/)) {
    lane = ASSET_LANES.RETAIL_SINGLE_TENANT;
    confidence = 70;
    reasoning.push('single_tenant_retail_keyword');
  }
  // 6) Office
  else if (has(blob, /medical (office|building)|\bmob\b|healthcare|dental|clinic/)) {
    lane = ASSET_LANES.OFFICE_MEDICAL;
    confidence = 72;
    reasoning.push('medical_office_keyword');
  } else if (has(blob, /office/)) {
    lane = ASSET_LANES.OFFICE_GENERAL;
    confidence = 68;
    reasoning.push('office_keyword');
  }
  // 7) Industrial
  else if (has(blob, /warehouse|distribution|logistics/)) {
    lane = ASSET_LANES.INDUSTRIAL_WAREHOUSE;
    confidence = 72;
    reasoning.push('warehouse_keyword');
  } else if (has(blob, /\bflex\b|industrial/)) {
    lane = ASSET_LANES.INDUSTRIAL_FLEX;
    confidence = 68;
    reasoning.push('industrial_keyword');
  }
  // 8) Mixed use
  else if (has(blob, /mixed.?use/)) {
    lane = ASSET_LANES.MIXED_USE;
    confidence = 65;
    reasoning.push('mixed_use_keyword');
  }
  // 9) Residential / small-multi / MF
  else if (has(blob, /condo/)) {
    lane = ASSET_LANES.CONDO;
    confidence = 78;
    reasoning.push('condo_keyword');
  } else if (has(blob, /town(house|home)/)) {
    lane = ASSET_LANES.TOWNHOME;
    confidence = 76;
    reasoning.push('townhome_keyword');
  } else if (has(blob, /duplex/)) {
    lane = ASSET_LANES.DUPLEX;
    confidence = 80;
    reasoning.push('duplex_keyword');
  } else if (has(blob, /triplex|tri-plex|3.?plex/)) {
    lane = ASSET_LANES.TRIPLEX;
    confidence = 80;
    reasoning.push('triplex_keyword');
  } else if (has(blob, /fourplex|four-plex|quadplex|quad-plex|4.?plex/)) {
    lane = ASSET_LANES.FOURPLEX;
    confidence = 80;
    reasoning.push('fourplex_keyword');
  } else if (has(blob, /multi.?family|multifamily|apartment|\bmulti-family\b/)) {
    const byUnits = mfLaneForUnits(units);
    if (byUnits && LANE_FAMILY[byUnits] !== ASSET_FAMILIES.RESIDENTIAL_SINGLE) {
      lane = byUnits;
      confidence = units !== null ? 82 : 55;
      reasoning.push(units !== null ? `multifamily_by_units(${units})` : 'multifamily_keyword_no_unit_count');
    } else {
      // "multi-family 2-4" style label with units 0/1/unknown — common in source data
      lane = units && units >= 2 ? mfLaneForUnits(units) : ASSET_LANES.DUPLEX;
      confidence = 45;
      reasoning.push('multifamily_keyword_low_unit_count');
      if (units !== null && units <= 1) conflicting.push('multifamily_label_but_unit_count<=1');
    }
  } else if (has(blob, /single.?family|\bsfr\b|\bsfd\b|detached|single-family/)) {
    lane = ASSET_LANES.SFR;
    confidence = units !== null && units > 1 ? 50 : 80;
    reasoning.push('sfr_keyword');
    if (units !== null && units > 1) conflicting.push(`sfr_label_but_units=${units}`);
  }
  // 10) Fall back to unit count alone
  else if (units !== null) {
    lane = mfLaneForUnits(units);
    confidence = 55;
    reasoning.push(`inferred_from_unit_count(${units})`);
  }

  // Cross-check: explicit unit count conflicting with a keyword-derived lane.
  const family = LANE_FAMILY[lane] ?? ASSET_FAMILIES.UNKNOWN;
  if (
    units !== null &&
    family === ASSET_FAMILIES.RESIDENTIAL_SINGLE &&
    units >= 2 &&
    !conflicting.length
  ) {
    conflicting.push(`single_lane_${lane}_but_units=${units}`);
    confidence = Math.min(confidence, 45);
  }

  if (conflicting.length) confidence = Math.min(confidence, 45);
  if (lane === ASSET_LANES.UNKNOWN) confidence = Math.min(confidence, 25);

  return {
    lane,
    family,
    method: LANE_METHOD[lane] ?? LANE_METHOD.UNKNOWN,
    confidence,
    reasoning,
    conflicting_signals: conflicting,
    source_fields: sourceFields,
  };
}

/**
 * Comp eligibility by lane (mission §1, §7).
 * @param {string} subjectLane
 * @param {string} compLane
 * @param {{ allowFallback?: boolean }} [opts]
 * @returns {{ compatible: boolean, exact: boolean, fallback: boolean, reason: string }}
 */
export function laneCompatible(subjectLane, compLane, opts = {}) {
  const allowFallback = opts.allowFallback ?? false;
  if (!subjectLane || !compLane || subjectLane === ASSET_LANES.UNKNOWN) {
    return { compatible: false, exact: false, fallback: false, reason: 'unknown_subject_lane' };
  }
  if (subjectLane === compLane) {
    return { compatible: true, exact: true, fallback: false, reason: 'exact_lane_match' };
  }
  if (allowFallback) {
    const fallbacks = LANE_FALLBACKS[subjectLane] ?? [];
    if (fallbacks.includes(compLane)) {
      return { compatible: true, exact: false, fallback: true, reason: 'permitted_fallback_lane' };
    }
  }
  return { compatible: false, exact: false, fallback: false, reason: 'asset_lane_mismatch' };
}

export function valuationMethodForLane(lane) {
  return LANE_METHOD[lane] ?? LANE_METHOD.UNKNOWN;
}
