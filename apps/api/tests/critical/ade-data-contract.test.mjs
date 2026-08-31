import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizePropertyFeatures,
  scoreComparable,
} from "@/lib/acquisition/acquisitionDecisionEngine.js";

// ADE DATA CONTRACT
//
// Proven defect (audit 2026-08-31): buyer_comp_raw_v2 already carried the
// amenity / utility / quality / location feature families at real coverage
// (pool 84.1%, school_district 84.1%, air_conditioning 76.6%, garage 60.2%,
// sewer 36.8%, ...) with real values ('Attached Garage', 'Central',
// 'Composition Shingle', 'Brick veneer'). v_recent_sold_comps selects FROM that
// same table but its explicit projection omitted every one of them, and
// RPC_COMP_DETAIL_SELECT omitted them too. normalizePropertyFeatures had always
// known how to map them, so the data simply never arrived: every selected comp
// scored data_completeness = 37 in every market, costing ~11 points of
// valuation_confidence system-wide.
//
// These tests lock the whole chain: raw row -> projection -> normalizer ->
// feature scoring -> completeness NUMERATOR credit. A column that is merely
// carried but never scored would not pass.

const NOW = new Date("2026-08-31T00:00:00.000Z");

// A fully specified subject, as loadSubjectProperty returns (SUBJECT_SELECT has
// always included every one of these).
const RICH_SUBJECT = Object.freeze({
  property_id: "subject-1",
  property_type: "Single Family",
  property_class: "Residential",
  property_address_zip: "75060",
  latitude: 32.811161,
  longitude: -96.953984,
  building_square_feet: 1350,
  total_bedrooms: 3,
  total_baths: 2,
  year_built: 1960,
  effective_year_built: 1960,
  lot_square_feet: 7200,
  units_count: 1,
  building_condition: "Average",
  construction_type: "Frame",
  estimated_repair_cost: 40000,
  // the families the projection used to drop
  subdivision_name: "LAKE GARDENS 1ST INST",
  school_district_name: "Irving Independent School District",
  zoning: "Z324",
  flood_zone: "AE",
  building_quality: "Average",
  exterior_walls: "Brick veneer",
  interior_walls: "Drywall",
  floor_cover: "Carpet",
  roof_cover: "Composition Shingle",
  roof_type: "Gable",
  basement: "No Basement",
  garage: "Attached Garage",
  pool: "No",
  air_conditioning: "Central",
  heating_type: "Central",
  heating_fuel_type: "Gas",
  sewer: "Yes",
  water: "Municipal",
});

// The SAME comp row, once as the old projection delivered it (advanced columns
// absent) and once as the repaired projection delivers it.
const compBase = (over = {}) => ({
  id: "comp-1",
  property_id: "comp-1",
  property_address_full: "123 Test St, Irving, TX 75060",
  property_address_zip: "75060",
  latitude: 32.8115,
  longitude: -96.9541,
  property_type: "Single Family",
  property_class: "Residential",
  total_bedrooms: 3,
  total_baths: 2,
  building_square_feet: 1330,
  lot_square_feet: 7100,
  units_count: 1,
  year_built: 1961,
  effective_year_built: 1961,
  building_condition: "Average",
  construction_type: "Frame",
  estimated_repair_cost: 41000,
  sale_price: 300000,
  sale_date: "2026-05-01",
  ...over,
});

const ADVANCED_FIELDS = Object.freeze({
  subdivision_name: "SENTER PARK ESTATES",
  school_district_name: "Irving Independent School District",
  zoning: "Z324",
  flood_zone: "AE",
  building_quality: "Average",
  exterior_walls: "Brick veneer",
  interior_walls: "Drywall",
  floor_cover: "Carpet",
  roof_cover: "Composition Shingle",
  roof_type: "Gable",
  basement: "No Basement",
  garage: "Detached Garage",
  pool: "No",
  air_conditioning: "Central",
  heating_type: "Central",
  heating_fuel_type: "Gas",
  sewer: "Yes",
  water: "Municipal",
});

const subject = () => normalizePropertyFeatures({ ...RICH_SUBJECT }, { now: NOW });

// ── the normalizer actually consumes the projected columns ───────────────────

test("PROJECTION: normalizePropertyFeatures maps every advanced column it is given", () => {
  const n = normalizePropertyFeatures(compBase(ADVANCED_FIELDS), { now: NOW });
  assert.equal(n.subdivision, "SENTER PARK ESTATES");
  assert.equal(n.school_district, "Irving Independent School District");
  assert.equal(n.zoning, "Z324");
  assert.equal(n.flood_zone, "AE");
  assert.equal(n.quality, "Average");
  assert.equal(n.exterior_walls, "Brick veneer");
  assert.equal(n.interior_walls, "Drywall");
  assert.equal(n.floor_cover, "Carpet");
  assert.equal(n.roof_cover, "Composition Shingle");
  assert.equal(n.roof_type, "Gable");
  assert.equal(n.air_conditioning, "Central");
  assert.equal(n.heating_type, "Central");
  assert.equal(n.heating_fuel, "Gas");
  assert.equal(n.sewer, "Yes");
  assert.equal(n.water, "Municipal");
  assert.equal(n.garage, "yes");
  assert.equal(n.basement, "no", "'No Basement' normalizes to no, not missing");
  assert.equal(n.pool, "no");
});

// ── THE REGRESSION THAT WOULD HAVE CAUGHT THE REAL DEFECT ────────────────────

test("PROJECTION REGRESSION: advanced features earn completeness NUMERATOR credit", () => {
  const s = subject();
  const withoutAdvanced = scoreComparable(s, compBase(), { now: NOW });
  const withAdvanced = scoreComparable(s, compBase(ADVANCED_FIELDS), { now: NOW });

  assert.equal(withoutAdvanced.eligible, true);
  assert.equal(withAdvanced.eligible, true);

  // The defect: columns present but never credited. Completeness MUST rise.
  assert.ok(
    withAdvanced.data_completeness > withoutAdvanced.data_completeness,
    `advanced features must increase completeness (${withoutAdvanced.data_completeness} -> ${withAdvanced.data_completeness})`
  );

  // And the previously-dead categories must actually score, not stay null.
  const before = withoutAdvanced.feature_match_breakdown;
  const after = withAdvanced.feature_match_breakdown;
  assert.equal(before.utility_mechanical.score, null, "utility was uncomparable before");
  assert.equal(before.amenities_structure.compared_features, 0, "amenities were uncomparable before");
  assert.ok(after.utility_mechanical.score !== null, "utility_mechanical must now score");
  assert.ok(after.amenities_structure.compared_features > 0, "amenities must now compare");
  assert.ok(
    after.location_context.compared_features > before.location_context.compared_features,
    "location_context must gain compared features"
  );
  assert.ok(
    after.quality_condition.compared_features > before.quality_condition.compared_features,
    "quality_condition must gain compared features"
  );
});

test("PROJECTION REGRESSION: each advanced family individually adds credit", () => {
  const s = subject();
  const baseline = scoreComparable(s, compBase(), { now: NOW }).data_completeness;
  const families = {
    location: ["subdivision_name", "school_district_name", "zoning", "flood_zone"],
    quality: ["building_quality", "exterior_walls", "interior_walls", "floor_cover", "roof_cover", "roof_type"],
    amenities: ["basement", "garage", "pool"],
    utility: ["air_conditioning", "heating_type", "heating_fuel_type", "sewer", "water"],
  };
  for (const [name, fields] of Object.entries(families)) {
    const only = Object.fromEntries(fields.map((f) => [f, ADVANCED_FIELDS[f]]));
    const scored = scoreComparable(s, compBase(only), { now: NOW });
    assert.ok(
      scored.data_completeness > baseline,
      `${name} family must raise completeness above ${baseline}`
    );
  }
});

// ── the absolute-evidence contract is PRESERVED ──────────────────────────────

test("CONTRACT PRESERVED: missing fields still reduce completeness", () => {
  // The audit found the absolute-evidence contract is intentional for comp
  // features (featurePriority already has a priority-0 escape for genuinely
  // inapplicable ones). This must NOT become "available fields only".
  const s = subject();
  const full = scoreComparable(s, compBase(ADVANCED_FIELDS), { now: NOW });
  assert.ok(full.data_completeness < 100, "unavailable families still cost completeness");

  const partial = scoreComparable(
    s,
    compBase({ ...ADVANCED_FIELDS, roof_cover: null, sewer: null, garage: null }),
    { now: NOW }
  );
  assert.ok(
    partial.data_completeness < full.data_completeness,
    "dropping fields must still lower completeness, not be excused"
  );
});

test("CONTRACT PRESERVED: empty-string source values gain no false credit", () => {
  // buyer_comp_raw_v2 stores '' for sparse fields (patio 1.7%, porch 2.3%,
  // driveway 2.8%). Passing them through must not inflate completeness.
  const s = subject();
  const blanks = scoreComparable(s, compBase({ patio: "", porch: "", driveway: "", sewer: "" }), { now: NOW });
  const absent = scoreComparable(s, compBase(), { now: NOW });
  assert.equal(
    blanks.data_completeness,
    absent.data_completeness,
    "empty strings must score identically to absent"
  );
});

test("CONTRACT PRESERVED: genuinely sourceless fields stay uncredited", () => {
  // stories is 0% populated, and garage_square_feet / road_boundary have no
  // column at all. Their absence must keep costing completeness.
  const s = subject();
  const scored = scoreComparable(s, compBase(ADVANCED_FIELDS), { now: NOW });
  const amen = scored.feature_match_breakdown.amenities_structure.features;
  const byName = (f) => amen.find((x) => x.feature === f);
  assert.equal(byName("stories")?.status, "missing");
  assert.equal(byName("garage_sqft")?.status, "missing");
});

test("missing fields are a confidence loss, not a mismatch penalty", () => {
  // The original design intent, re-asserted against the repaired path.
  const s = subject();
  const sparse = scoreComparable(
    s,
    compBase({ ...ADVANCED_FIELDS, building_quality: null, interior_walls: null, floor_cover: null }),
    { now: NOW }
  );
  assert.ok(sparse.comp_score >= 70, "known matching features stay strongly scored");
  assert.ok(sparse.data_completeness < 100);
});
