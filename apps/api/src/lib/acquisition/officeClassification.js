/**
 * Acquisition Engine V3 — Item 5F §1, §2, §3: office & medical-office classification.
 *
 * Three questions, kept separate:
 *   (1) Is the subject GENUINELY ordinary office real estate, MEDICAL office, or a
 *       SPECIAL-REVIEW use (laboratory / life-science / data center / hospital /
 *       coworking OPERATING BUSINESS / converted residential / mixed-use)? A
 *       generic "office" flag alone is NEVER enough — and never proves medical,
 *       life-science or data-center use.
 *   (2) What office SUBTYPE is it? (CBD/suburban × Class A/B/C; low/mid/high-rise;
 *       single/multi-tenant; owner-user; office condo; government; corporate
 *       campus; creative; vacant; redevelopment; or a specific medical subtype).
 *   (3) What TENANCY structure and OPERATIONAL status?
 *
 * Medical office is a DISTINCT lane (OFFICE_MEDICAL) from general office
 * (OFFICE_GENERAL). An office condominium UNIT is never a whole-building office
 * asset. Missing occupancy is NEVER treated as zero occupancy. Pure & deterministic.
 */

import { ASSET_LANES, lower, num } from './modelConstants.js';
import { classifyAssetLane } from './assetClassification.js';
import {
  OFFICE_SUBTYPE as ST,
  OFFICE_RECORD_CLASS as RC,
  OFFICE_TENANCY as TEN,
  OFFICE_OPERATIONAL_STATUS as OS,
  OFFICE_CLASS as CL,
  OFFICE_LOCATION as LOC,
  OFFICE_HEIGHT as HT,
  MEDICAL_SUBTYPES,
  PRICING_ELIGIBLE_RECORD_CLASSES,
  OWNER_USER_RECORD_CLASSES,
  GENUINE_OFFICE_MIN_CONFIDENCE,
  MULTI_TENANT_MIN_RSF,
  OFFICE_IMPLAUSIBLE_RSF,
  OFFICE_OCCUPANCY_BANDS as OB,
} from './officeConstants.js';

function blob(row = {}) {
  return lower(
    [
      row.canonical_asset_lane, row.normalized_asset_class, row.normalized_asset_subclass,
      row.asset_class, row.asset_subclass, row.asset_subtype, row.asset_type, row.asset_label,
      row.asset_type_label, row.property_type, row.property_subtype, row.commercial_property_type,
      row.commercial_subtype, row.land_use, row.county_land_use_code, row.zoning,
      row.original_property_type, row.import_asset_signal, row.tenant_name, row.building_class,
    ].filter(Boolean).join(' '),
  );
}

const OFFICE_RE = /(office|professional building|executive suite|corporate (campus|center)|business park|\bcbd\b|class [abc] (office|building)|creative office)/;
const MEDICAL_RE = /(medical (office|building|center)|\bmob\b|healthcare|health ?care|dental|dentist|clinic|ambulatory|surgery center|surgical center|urgent care|imaging center|outpatient|physician|orthopedic|dialysis|oncology|cardiology|pediatric)/;
const SPECIAL_REVIEW_RE = {
  life_science: /(laborator|life ?science|life-science|research (building|facility|lab)|biotech|\bgmp\b|cleanroom|clean room|wet lab|vivarium)/,
  data_center: /(data ?center|data-center|colocation|colo facility|server farm|hyperscale)/,
  hospital: /(hospital|inpatient|skilled nursing|assisted living|emergency department|acute care)/,
  coworking_business: /(coworking (business|operator|operating)|wework|regus|shared office (business|operator)|executive suite business|workspace operator)/,
  converted_residential: /(converted (residential|house|home)|residential conversion|house used as office|converted dwelling)/,
  mixed_use: /(mixed.?use|office (over|above) retail|residential (over|above) office|live.?work)/,
};

/** Resolve rentable / building area from the usual size fields. */
function resolveRsf(row = {}) {
  return (
    num(row.rentable_building_area) ?? num(row.net_rentable_area) ?? num(row.rentable_square_feet) ??
    num(row.gross_building_area) ?? num(row.building_square_feet) ?? num(row.sqft) ?? null
  );
}

function resolveClass(b, row) {
  const explicit = lower(row.building_class);
  if (/class a|\bclass-a\b|\b a-class\b/.test(b) || explicit === 'a') return CL.CLASS_A;
  if (/class b|\bclass-b\b/.test(b) || explicit === 'b') return CL.CLASS_B;
  if (/class c|\bclass-c\b/.test(b) || explicit === 'c') return CL.CLASS_C;
  return CL.UNKNOWN;
}

function resolveLocation(b, row) {
  if (/\bcbd\b|central business district|downtown|urban core/.test(b)) return LOC.CBD;
  if (/suburban|suburb|business park|office park/.test(b)) return LOC.SUBURBAN;
  return LOC.UNKNOWN;
}

function resolveHeight(b, row) {
  const floors = num(row.floor_count) ?? num(row.number_of_floors) ?? num(row.stories);
  if (/high.?rise/.test(b) || (floors !== null && floors >= 12)) return HT.HIGH_RISE;
  if (/mid.?rise/.test(b) || (floors !== null && floors >= 5)) return HT.MID_RISE;
  if (/low.?rise|single.?story|one.?story/.test(b) || (floors !== null && floors <= 4)) return HT.LOW_RISE;
  return HT.UNKNOWN;
}

/**
 * Decide whether an office-flagged subject is GENUINELY ordinary office real
 * estate, MEDICAL office, or a special-review use; resolve subtype/class/location/
 * height. Returns a graded confidence + the contradictory/missing signals.
 */
export function classifyOfficeAsset(row = {}) {
  const base = classifyAssetLane(row);
  const b = blob(row);
  const reasoning = [];
  const conflicting = [];

  const officeBool = row.is_office === true || row.is_medical_office === true || row.is_mob === true;
  const officeKeyword = OFFICE_RE.test(b);
  const medicalKeyword = MEDICAL_RE.test(b) || row.is_medical_office === true || row.is_mob === true;
  const officeLane = base.lane === ASSET_LANES.OFFICE_GENERAL || base.lane === ASSET_LANES.OFFICE_MEDICAL;
  const suites = num(row.number_of_suites) ?? num(row.suite_count);

  // Special-review uses (life science / data center / hospital / coworking
  // business / converted residential / mixed-use) are office-adjacent: they must
  // be RECOGNIZED so the record/comp classifiers can route them to review rather
  // than silently dropping them as "not office".
  const specialReviewSignal = Object.values(SPECIAL_REVIEW_RE).some((re) => re.test(b));

  const officeSignal = officeLane || officeBool || officeKeyword || medicalKeyword || specialReviewSignal;

  if (!officeSignal) {
    return {
      is_office: false,
      lane: base.lane,
      subtype: ST.NOT_OFFICE,
      is_medical: false,
      genuine_office: false,
      confidence: 0,
      class: CL.UNKNOWN,
      location: LOC.UNKNOWN,
      height: HT.UNKNOWN,
      reasoning: ['no_office_signal'],
      conflicting_signals: [],
      missing_requirements: ['office_classification'],
      specialized_lane_required: null,
    };
  }

  if (officeLane) reasoning.push('canonical_office_lane');
  if (officeBool) reasoning.push('office_boolean_flag');
  if (officeKeyword) reasoning.push('office_keyword');
  if (medicalKeyword) reasoning.push('medical_office_keyword');

  // ---- Special-review separation (mission §2). These must NOT silently enter
  // ordinary-office pricing without specialized review. ----
  let specializedLane = null;
  if (SPECIAL_REVIEW_RE.life_science.test(b)) { conflicting.push('life_science_specialty_review'); specializedLane = 'LIFE_SCIENCE_LANE'; }
  else if (SPECIAL_REVIEW_RE.data_center.test(b)) { conflicting.push('data_center_specialty_review'); specializedLane = 'DATA_CENTER_LANE'; }
  else if (SPECIAL_REVIEW_RE.hospital.test(b)) { conflicting.push('hospital_facility_specialty_review'); specializedLane = 'HOSPITAL_LANE'; }
  else if (SPECIAL_REVIEW_RE.coworking_business.test(b)) { conflicting.push('coworking_operating_business_not_real_estate'); specializedLane = 'COWORKING_BUSINESS_REVIEW'; }
  else if (SPECIAL_REVIEW_RE.converted_residential.test(b)) { conflicting.push('converted_residential_office'); specializedLane = 'CONVERTED_RESIDENTIAL_REVIEW'; }
  else if (SPECIAL_REVIEW_RE.mixed_use.test(b)) { conflicting.push('mixed_use_office'); specializedLane = 'MIXED_USE_LANE'; }

  // ---- Subtype + dimensions ----
  const rsf = resolveRsf(row);
  const cls = resolveClass(b, row);
  const location = resolveLocation(b, row);
  const height = resolveHeight(b, row);
  const isMedical = (medicalKeyword || base.lane === ASSET_LANES.OFFICE_MEDICAL) && !specializedLane;
  const subtype = resolveSubtype(b, row, { rsf, cls, location, height, suites, isMedical });

  // ---- Physical-plausibility gate ----
  let genuineOffice = true;
  if (rsf === null) {
    genuineOffice = false;
    conflicting.push('no_building_size_to_confirm_office');
  } else if (rsf < OFFICE_IMPLAUSIBLE_RSF) {
    genuineOffice = false;
    conflicting.push(`size_${Math.round(rsf)}sqft_implausible_as_office`);
  }
  if (specializedLane) genuineOffice = false; // special review routes away from ordinary office

  // ---- Confidence ----
  let confidence = officeLane ? base.confidence : 55;
  if (medicalKeyword && (officeKeyword || officeBool)) confidence = Math.max(confidence, 74);
  if (officeBool && officeKeyword) confidence = Math.max(confidence, 76);
  if (cls !== CL.UNKNOWN) confidence = Math.max(confidence, 70);
  // A generic office flag alone cannot establish a high-confidence SUBTYPE, medical
  // use, life-science use, or data-center use.
  if (subtype === ST.AMBIGUOUS_OFFICE) confidence = Math.min(confidence, 45);
  if (!genuineOffice) confidence = Math.min(confidence, 40);
  if (conflicting.length) confidence = Math.min(confidence, 45);

  const missing = [];
  if (rsf === null) missing.push('rentable_building_area');
  if (cls === CL.UNKNOWN) missing.push('building_class');
  if (location === LOC.UNKNOWN) missing.push('cbd_or_suburban');

  const lane = specializedLane ? base.lane
    : isMedical ? ASSET_LANES.OFFICE_MEDICAL : ASSET_LANES.OFFICE_GENERAL;

  return {
    is_office: true,
    lane,
    subtype,
    is_medical: isMedical,
    genuine_office: genuineOffice,
    confidence: Math.round(confidence),
    class: cls,
    location,
    height,
    reasoning,
    conflicting_signals: conflicting,
    missing_requirements: missing,
    specialized_lane_required: specializedLane,
  };
}

/** Resolve the office subtype from text + structure. */
function resolveSubtype(b, row, { rsf, cls, location, height, suites, isMedical }) {
  // ---- Medical subtypes first (a specific medical use beats generic medical) ----
  if (isMedical) {
    if (/ambulatory surgery|surgical center|surgery center|\basc\b/.test(b)) return ST.AMBULATORY_SURGERY_CENTER;
    if (/imaging center|radiolog|\bmri\b|diagnostic imaging/.test(b)) return ST.IMAGING_CENTER;
    if (/urgent care/.test(b)) return ST.URGENT_CARE;
    if (/dental|dentist|orthodont|endodont/.test(b)) return ST.DENTAL_OFFICE;
    if (/outpatient|clinic/.test(b)) return ST.OUTPATIENT_CLINIC;
    if (/hospital.?affiliat|on.?campus|health system/.test(b)) return ST.HOSPITAL_AFFILIATED_MOB;
    if (row.owner_occupied === true || /owner.?occupied/.test(b)) return ST.OWNER_USER_MEDICAL;
    if (/vacant/.test(b)) return ST.VACANT_MEDICAL_OFFICE;
    if (/orthopedic|cardiolog|oncolog|specialty/.test(b)) return ST.SPECIALTY_MEDICAL_OFFICE;
    return ST.MEDICAL_OFFICE_BUILDING;
  }

  // ---- General office ----
  if (/office cond/.test(b)) return ST.OFFICE_CONDOMINIUM;
  if (/redevelop|teardown|conversion candidate|obsolete office/.test(b)) return ST.OFFICE_REDEVELOPMENT;
  if (/vacant/.test(b)) return ST.VACANT_OFFICE;
  if (/government|\bgsa\b|municipal|federal|county office|state office/.test(b)) return ST.GOVERNMENT_OFFICE;
  if (/corporate campus|headquarters campus|\bhq\b campus/.test(b)) return ST.CORPORATE_CAMPUS;
  if (/creative office|loft office|brick.?and.?timber|adaptive reuse office/.test(b)) return ST.CREATIVE_OFFICE;
  const owner = row.owner_occupied === true || /owner.?occupied|owner.?user/.test(b);
  if (owner) return ST.OWNER_USER_OFFICE;

  // CBD/suburban × class when both are known.
  if (location === LOC.CBD && cls === CL.CLASS_A) return ST.CBD_CLASS_A_OFFICE;
  if (location === LOC.CBD && cls === CL.CLASS_B) return ST.CBD_CLASS_B_OFFICE;
  if (location === LOC.CBD && cls === CL.CLASS_C) return ST.CBD_CLASS_C_OFFICE;
  if (location === LOC.SUBURBAN && cls === CL.CLASS_A) return ST.SUBURBAN_CLASS_A_OFFICE;
  if (location === LOC.SUBURBAN && cls === CL.CLASS_B) return ST.SUBURBAN_CLASS_B_OFFICE;
  if (location === LOC.SUBURBAN && cls === CL.CLASS_C) return ST.SUBURBAN_CLASS_C_OFFICE;

  // Height tier when class/location not known.
  if (height === HT.HIGH_RISE) return ST.HIGH_RISE_OFFICE;
  if (height === HT.MID_RISE) return ST.MID_RISE_OFFICE;
  if (height === HT.LOW_RISE) return ST.LOW_RISE_OFFICE;

  // Tenancy when nothing else resolves.
  if (suites !== null && suites >= 2 && rsf !== null && rsf >= MULTI_TENANT_MIN_RSF) return ST.MULTI_TENANT_OFFICE;
  if (/single.?tenant|net.?lease|\bnnn\b/.test(b)) return ST.SINGLE_TENANT_OFFICE;

  return ST.AMBIGUOUS_OFFICE;
}

/**
 * Classify WHAT KIND of record this is — hardened against special-review / business-
 * sale / mixed-use / converted-residential false positives. A genuine, priceable
 * office record needs plausible size AND corroboration (class/suite/tenant/lease
 * evidence, an explicit office keyword, or operating data). A binary office flag
 * alone is AMBIGUOUS, not a priced building. An office CONDOMINIUM is never priced
 * as a whole building.
 */
export function classifyOfficeRecord(row = {}, { hasOperatingData = false, hasLeaseData = false } = {}) {
  const b = blob(row);
  const support = [];
  const contra = [];
  const missing = [];

  const asset = classifyOfficeAsset(row);
  if (!asset.is_office) {
    return result(RC.NOT_OFFICE, 0, ['no_office_signal'], [], ['office_classification']);
  }

  const rsf = resolveRsf(row);
  const lot = num(row.lot_square_feet) ?? num(row.land_sqft) ?? num(row.lot_size_sqft);
  const suites = num(row.number_of_suites) ?? num(row.suite_count);
  const tenants = num(row.tenant_count) ?? (Array.isArray(row.tenants) ? row.tenants.length : null);
  const underConstruction = row.under_construction === true || /under construction|proposed|pre.?leasing/.test(b);
  const explicitOffice = OFFICE_RE.test(b);

  // ---- Special-review buckets first (route away from ordinary office) ----
  if (SPECIAL_REVIEW_RE.life_science.test(b)) {
    contra.push('life_science_keyword');
    return result(RC.LABORATORY_LIFE_SCIENCE, 55, ['life_science'], contra, ['specialized_lab_review'], { special: true });
  }
  if (SPECIAL_REVIEW_RE.data_center.test(b)) {
    contra.push('data_center_keyword');
    return result(RC.DATA_CENTER, 55, ['data_center'], contra, ['specialized_data_center_review'], { special: true });
  }
  if (SPECIAL_REVIEW_RE.hospital.test(b)) {
    contra.push('hospital_facility_keyword');
    return result(RC.HOSPITAL_FACILITY, 52, ['hospital_facility'], contra, ['specialized_hospital_review'], { special: true });
  }
  if (SPECIAL_REVIEW_RE.coworking_business.test(b)) {
    contra.push('coworking_operating_business');
    return result(RC.COWORKING_BUSINESS, 52, ['coworking_business'], contra, ['real_estate_only_consideration'], { special: true });
  }
  if (SPECIAL_REVIEW_RE.converted_residential.test(b)) {
    contra.push('converted_residential_office');
    return result(RC.CONVERTED_RESIDENTIAL_OFFICE, 48, ['converted_residential'], contra, ['use_confirmation']);
  }
  if (SPECIAL_REVIEW_RE.mixed_use.test(b)) {
    contra.push('mixed_use_office_residential');
    return result(RC.MIXED_USE_OFFICE_RESIDENTIAL, 50, ['mixed_use_keyword'], contra, ['office_component_allocation']);
  }
  // Office condominium UNIT is never a whole-building office asset.
  if (/office cond/.test(b)) {
    support.push('office_condominium_keyword');
    return result(RC.OFFICE_CONDOMINIUM, 58, support, ['condominium_unit_not_whole_building'], ['condo_unit_scope'], { owner_user: true });
  }
  if (underConstruction || /redevelop|teardown|obsolete office/.test(b)) {
    support.push('redevelopment_or_construction');
    return result(RC.OFFICE_REDEVELOPMENT, 50, support, contra, ['entitlement_status']);
  }

  // ---- Size / plausibility gate ----
  if (rsf === null || rsf < OFFICE_IMPLAUSIBLE_RSF) {
    if (lot && lot > 0 && (rsf === null || rsf < 400)) {
      return result(RC.AMBIGUOUS_OFFICE, 40, ['lot_present_low_building'], ['no_improvements'], ['building_evidence']);
    }
    contra.push(rsf === null ? 'no_building_size' : `size_${Math.round(rsf)}sqft_implausible`);
    return result(RC.AMBIGUOUS_OFFICE, 40, ['sub_office_size'], contra, ['rentable_building_area']);
  }

  // ---- Vacancy ----
  const occ = num(row.physical_occupancy) ?? num(row.occupancy);
  const occFraction = occ === null ? null : (occ > 1 ? occ / 100 : occ);
  if ((occFraction !== null && occFraction <= 0.02) || row.is_vacant === true) {
    support.push('vacant_office');
    const vacantClass = asset.is_medical ? RC.VACANT_MEDICAL_OFFICE : RC.VACANT_OFFICE;
    return result(vacantClass, 55, support, contra, ['re_tenanting_plan']);
  }

  const corroboration = (suites !== null && suites >= 1) || (tenants !== null && tenants >= 1) ||
    explicitOffice || hasLeaseData || hasOperatingData || asset.class !== CL.UNKNOWN;

  if (rsf !== null) support.push(`size_${Math.round(rsf)}sqft`);
  if (suites !== null) support.push(`suites=${suites}`);
  if (tenants !== null) support.push(`tenants=${tenants}`);
  if (explicitOffice) support.push('explicit_office_keyword');
  if (asset.class !== CL.UNKNOWN) support.push(`class=${asset.class}`);
  if (hasLeaseData) support.push('lease_data_present');
  if (hasOperatingData) support.push('operating_data_present');

  // A binary office flag alone (no corroboration) is AMBIGUOUS, not a priced building.
  if (!corroboration) {
    if (!explicitOffice) missing.push('office_use_confirmation');
    missing.push('class_or_suites_or_tenants_or_lease_data');
    return result(RC.AMBIGUOUS_OFFICE, 42, support, ['binary_office_flag_only'], missing);
  }

  const ownerOccupied = row.owner_occupied === true || /owner.?occupied|owner.?user/.test(b);
  const government = /government|\bgsa\b|municipal|federal|county office|state office/.test(b);

  let cls;
  let confidence;
  if (asset.is_medical) {
    cls = ownerOccupied ? RC.OWNER_USER_MEDICAL : RC.MEDICAL_OFFICE_BUILDING;
    confidence = 60;
  } else if (ownerOccupied) {
    cls = RC.OWNER_USER_OFFICE; confidence = 58;
  } else if (government) {
    cls = RC.GOVERNMENT_OFFICE; confidence = 62;
  } else {
    const isMultiTenant = (suites !== null && suites >= 2) || (tenants !== null && tenants >= 2);
    if (isMultiTenant && rsf >= MULTI_TENANT_MIN_RSF) { cls = RC.MULTI_TENANT_OFFICE; confidence = 62; }
    else { cls = RC.SINGLE_TENANT_OFFICE; confidence = 58; }
  }

  if (explicitOffice) confidence += 6;
  if (asset.class !== CL.UNKNOWN) confidence += 6;
  if (suites !== null && suites >= 3) confidence += 6;
  if (hasLeaseData) confidence += 10;
  if (hasOperatingData) confidence += 8;
  if (contra.length) confidence = Math.min(confidence, 55);
  confidence = Math.max(0, Math.min(95, confidence));

  if (suites === null) missing.push('suite_count');
  if (!hasLeaseData) missing.push('lease_data');

  return result(cls, confidence, support, contra, missing, { owner_user: ownerOccupied });
}

function result(classification, confidence, supporting_signals, contradictory_signals, missing_evidence, opts = {}) {
  const pricingEligible = PRICING_ELIGIBLE_RECORD_CLASSES.includes(classification) && confidence >= GENUINE_OFFICE_MIN_CONFIDENCE;
  const ownerUserEligible = OWNER_USER_RECORD_CLASSES.includes(classification) || Boolean(opts.owner_user);
  return {
    classification,
    confidence: Math.round(confidence),
    supporting_signals,
    contradictory_signals,
    missing_evidence,
    pricing_eligible: pricingEligible,
    underwriting_eligible: pricingEligible,
    investment_pricing_eligible: pricingEligible,
    owner_user_pricing_eligible: ownerUserEligible,
    special_review: Boolean(opts.special),
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
export function classifyOfficeTenancy({ contract = null, rentRoll = null, row = {} } = {}) {
  const c = contract ?? {};
  const totalSuites = num(rentRoll?.total_suites ?? c.physical?.suite_count?.value ?? row.number_of_suites);
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
 * near-term rollover, redevelopment intent and recency. Sublease/shadow vacancy
 * pull a nominally-occupied building toward value-add. Missing occupancy stays
 * UNKNOWN — never 0.
 */
export function classifyOfficeOperationalStatus({ contract = null, rentRoll = null, row = {} } = {}) {
  const c = contract ?? {};
  const evidence = [];
  const missing = [];
  const contradictory = [];

  const physOcc = asFraction(rentRoll?.physical_occupancy ?? c.operations?.physical_occupancy?.value ?? row.physical_occupancy);
  const econOcc = asFraction(rentRoll?.economic_occupancy ?? c.operations?.economic_occupancy?.value);
  const subleaseVacancy = num(c.operations?.sublease_vacancy?.value ?? rentRoll?.sublease_vacancy_rsf);
  const shadowVacancy = num(c.operations?.shadow_vacancy?.value);
  const redevelopment = row.redevelopment_intent === true || /redevelop|teardown|conversion/.test(lower(row.property_type ?? ''));
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
    // Sublease / shadow vacancy + economic-occupancy gap pull toward value-add.
    if (subleaseVacancy !== null && subleaseVacancy > 0) {
      contradictory.push('sublease_vacancy_present');
      if (status === OS.STABILIZED) status = OS.VALUE_ADD;
    }
    if (shadowVacancy !== null && shadowVacancy > 0) contradictory.push('shadow_vacancy_present');
    if (econOcc !== null && physOcc - econOcc >= 0.1) {
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
