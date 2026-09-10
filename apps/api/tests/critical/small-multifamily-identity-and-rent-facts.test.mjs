/**
 * small-multifamily-identity-and-rent-facts.test.mjs
 *
 * Makes 2-4 unit multifamily REAL in the live seller path, without touching a
 * single monetary calculation.
 *
 * Four production defects this pins shut:
 *  1. "Multi-Family" -- the literal on 32,164 property rows -- normalized to
 *     `multi_family`, matched no alias, and fell through to SFR. Every
 *     multifamily seller was underwritten as a house.
 *  2. bare "Multifamily" matched the 5-plus alias, so a duplex was classed as a
 *     commercial-style apartment building and had a rent roll demanded of it.
 *  3. A 1-unit row typed "Multifamily" fell through to the label and resolved
 *     to 5-plus.
 *  4. Seller rent answers parsed but never reached the flat fact store that
 *     evaluateUnderwritingSufficiency reads, so they had no durable
 *     consequence.
 *
 * Unit count is more specific than a broad text label for the only question
 * that separates SFR / 2-4 / 5-plus, so it wins that decision. A label still
 * decides land / commercial / mobile home, which a unit count says nothing
 * about.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  ASSET_CLASSES,
  normalizeAssetClass,
  resolveAssetClassification,
  evaluateUnderwritingSufficiency,
} from "@/lib/domain/seller-flow/negotiation-policy.js";
import {
  extractSellerFacts,
  extractionToResolverFacts,
} from "@/lib/domain/seller-flow/extract-seller-facts.js";
import { mergeSellerFacts } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { loadCanonicalPropertyMetadata } from "@/lib/domain/property/load-canonical-property-metadata.js";

const flat = (message) => extractionToResolverFacts(extractSellerFacts({ message }));

// ── A-F: production-shaped asset classification ─────────────────────────────

test("A-C: 'Multi-Family' with 2, 3 or 4 units is small multifamily", () => {
  for (const units of [2, 3, 4]) {
    assert.equal(
      normalizeAssetClass("Multi-Family", { unitCount: units }),
      ASSET_CLASSES.SMALL_MULTIFAMILY,
      `units=${units}`
    );
  }
});

test("D: bare 'Multifamily' with 3 units is 2-4, NOT 5-plus", () => {
  assert.equal(
    normalizeAssetClass("Multifamily", { unitCount: 3 }),
    ASSET_CLASSES.SMALL_MULTIFAMILY
  );
});

test("E: 'Multifamily' with 8 units is still 5-plus", () => {
  // Part 16: legitimate 5-plus behaviour must not be weakened.
  assert.equal(
    normalizeAssetClass("Multifamily", { unitCount: 8 }),
    ASSET_CLASSES.LARGE_MULTIFAMILY
  );
});

test("F: multifamily with UNKNOWN units does not become 5-plus", () => {
  const cls = normalizeAssetClass("Multi-Family", { unitCount: null });
  assert.notEqual(cls, ASSET_CLASSES.LARGE_MULTIFAMILY);
  assert.equal(cls, ASSET_CLASSES.SMALL_MULTIFAMILY);
  // and the resulting requirement is a unit count, never a rent roll
  const sufficiency = evaluateUnderwritingSufficiency({
    property_type: "Multi-Family",
    unit_count: null,
    facts: { asking_price: 300000, occupancy_status: "tenant_occupied", condition_level: "average" },
  });
  assert.ok(sufficiency.missing_facts.includes("unit_count"));
  assert.equal(sufficiency.missing_facts.includes("rents_summary"), false);
});

test("every spelling of the multifamily label normalizes", () => {
  for (const label of ["Multi-Family", "Multi Family", "Multifamily", "multi-family", "multi family", "Multifamily 2-4"]) {
    assert.equal(
      normalizeAssetClass(label, { unitCount: 3 }),
      ASSET_CLASSES.SMALL_MULTIFAMILY,
      label
    );
  }
});

test("a single unit is a single residence regardless of the label", () => {
  assert.equal(normalizeAssetClass("Multifamily", { unitCount: 1 }), ASSET_CLASSES.SFR);
  assert.equal(normalizeAssetClass("Multi-Family", { unitCount: 1 }), ASSET_CLASSES.SFR);
});

test("non-residential labels are decided by the label, not the unit count", () => {
  assert.equal(normalizeAssetClass("Land", { unitCount: 3 }), ASSET_CLASSES.LAND);
  assert.equal(normalizeAssetClass("Commercial", { unitCount: 3 }), ASSET_CLASSES.COMMERCIAL);
  assert.equal(normalizeAssetClass("Mobile Home", { unitCount: 1 }), ASSET_CLASSES.MOBILE_HOME);
});

// ── conflict rules ──────────────────────────────────────────────────────────

test("contradictory metadata is resolved deterministically AND recorded", () => {
  const multiWithOne = resolveAssetClassification({ property_type: "Multifamily", units_count: 1 });
  assert.equal(multiWithOne.asset_class, ASSET_CLASSES.SFR);
  assert.equal(multiWithOne.conflict, "multifamily_label_with_single_unit");

  const sfrWithThree = resolveAssetClassification({ property_type: "Single Family", units_count: 3 });
  assert.equal(sfrWithThree.asset_class, ASSET_CLASSES.SMALL_MULTIFAMILY);
  assert.equal(sfrWithThree.conflict, "single_family_label_with_multiple_units");

  const agreeing = resolveAssetClassification({ property_type: "Multi-Family", units_count: 3 });
  assert.equal(agreeing.conflict, null);
  assert.equal(agreeing.unit_source, "property_record");
});

test("a seller unit count that contradicts the property record is flagged, not applied", () => {
  const r = resolveAssetClassification({
    property_type: "Multi-Family",
    units_count: 3,
    reported_units_count: 4,
  });
  // The canonical record still decides the class.
  assert.equal(r.unit_count, 3);
  assert.equal(r.unit_source, "property_record");
  assert.equal(r.conflict, "seller_reported_units_differ_from_property_record");
});

// ── J / PART 6: known fact -> confirmation, unknown fact -> discovery ───────

test("J: a KNOWN unit count is not asked for again", () => {
  // The property record says 3 units, so the flow must not spend a turn asking
  // "how many units are there?" -- unit_count is simply not missing.
  const sufficiency = evaluateUnderwritingSufficiency({
    property_type: "Multi-Family",
    unit_count: 3,
    facts: { asking_price: 400000, occupancy_status: "tenant_occupied", unit_count: 3 },
  });
  assert.equal(sufficiency.missing_facts.includes("unit_count"), false);
});

test("an UNKNOWN unit count IS asked for, and a rent roll is not demanded", () => {
  const sufficiency = evaluateUnderwritingSufficiency({
    property_type: "Multi-Family",
    unit_count: null,
    facts: { asking_price: 400000, occupancy_status: "tenant_occupied" },
  });
  assert.ok(sufficiency.missing_facts.includes("unit_count"), "must discover the count");
  assert.equal(sufficiency.missing_facts.includes("rents_summary"), false);
});

// ── G-I: rent facts persist with correct semantics ──────────────────────────

test("G: 'each' is per-unit and is never silently turned into a total", () => {
  const facts = flat("each unit is at 1500");
  assert.equal(facts.average_monthly_unit_rent, 1500);
  assert.equal(facts.monthly_gross_rent, undefined, "per-unit must not become a total");
  assert.equal(facts.rent_basis, "per_unit");
  assert.equal(facts.rents_source, "seller_reported");
});

test("H: 'total' is a total and is never divided into a per-unit figure", () => {
  const facts = flat("they collect 3200 total");
  assert.equal(facts.monthly_gross_rent, 3200);
  assert.equal(facts.average_monthly_unit_rent, undefined);
  assert.equal(facts.rent_basis, "total");
});

test("I: partial rents persist and the unpriced unit is NOT fabricated", () => {
  const facts = flat("unit 1 is 1200, unit 2 is 1350, third one is vacant");
  assert.equal(facts.reported_unit_rents, "1200,1350");
  assert.equal(facts.reported_unit_rent_count, 2, "only the two priced units");
  assert.equal(facts.monthly_gross_rent, undefined, "no total invented from partial data");
  assert.equal(facts.average_monthly_unit_rent, undefined);
});

test("seller-stated unit counts are captured as REPORTED, never as canonical", () => {
  assert.equal(flat("its a triplex").reported_units_count, 3);
  assert.equal(flat("3 units total").reported_units_count, 3);
  // The canonical key is untouched by seller text.
  assert.equal(flat("its a triplex").unit_count, undefined);
  assert.equal(flat("its a triplex").reported_units_count_source, "seller_reported");
});

test("ordinary sale language produces no rent facts", () => {
  const facts = flat("I want 400k for it");
  assert.equal(facts.monthly_gross_rent, undefined);
  assert.equal(facts.average_monthly_unit_rent, undefined);
  assert.equal(facts.rents_summary, undefined);
});

// ── K: landlords stay in the flow ───────────────────────────────────────────

test("K: a tenant-occupied answer is occupancy, and the flow continues", () => {
  const facts = flat("fully occupied with an active lease");
  assert.equal(facts.occupancy_status, "tenant_occupied");
  // Occupancy satisfies the 2-4 occupancy requirement rather than ending the
  // conversation: a landlord is a valid seller.
  const sufficiency = evaluateUnderwritingSufficiency({
    property_type: "Multi-Family",
    unit_count: 3,
    facts: { ...facts, asking_price: 400000, unit_count: 3, condition_level: "average" },
  });
  assert.equal(sufficiency.missing_facts.includes("occupancy_status"), false);
});

// ── L: facts survive to the next turn ───────────────────────────────────────

test("L: a rent fact persists across a subsequent inbound turn", () => {
  // Turn 1: seller states rent.
  const turn1 = flat("they collect 3200 total");
  const persisted = mergeSellerFacts({}, turn1, {});
  assert.equal(persisted.monthly_gross_rent, 3200);

  // Turn 2: an unrelated message must not erase it (mergeSellerFacts skips
  // null/undefined, so absent keys never clobber a stored fact).
  const turn2 = flat("sounds good");
  const merged = mergeSellerFacts(persisted, turn2, {});
  assert.equal(merged.monthly_gross_rent, 3200, "rent fact lost on the next turn");
  assert.equal(merged.rents_summary, persisted.rents_summary);
});

// ── PART 17: underwriting can SEE the facts ─────────────────────────────────

test("underwriting sufficiency reads the persisted rent facts", () => {
  const facts = mergeSellerFacts({}, flat("they collect 3200 total"), {});
  // A 5-plus property is the case where rents_summary is a requirement; prove
  // the seller-provided summary satisfies it rather than being invisible.
  const before = evaluateUnderwritingSufficiency({
    property_type: "Multifamily",
    unit_count: 12,
    facts: { asking_price: 900000, occupancy_status: "tenant_occupied", unit_count: 12 },
  });
  assert.ok(before.missing_facts.includes("rents_summary"), "precondition: rents required");

  const after = evaluateUnderwritingSufficiency({
    property_type: "Multifamily",
    unit_count: 12,
    facts: {
      asking_price: 900000,
      occupancy_status: "tenant_occupied",
      unit_count: 12,
      condition_level: "average",
      ...facts,
    },
  });
  assert.equal(
    after.missing_facts.includes("rents_summary"),
    false,
    "seller-reported rent must be visible to underwriting"
  );
});

// ── canonical property metadata loader ──────────────────────────────────────

test("the property loader returns canonical values with provenance", async () => {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { property_type: "Multi-Family", units_count: 3 },
            error: null,
          }),
        }),
      }),
    }),
  };
  const meta = await loadCanonicalPropertyMetadata(supabase, "prop-1");
  assert.equal(meta.property_type, "Multi-Family");
  assert.equal(meta.units_count, 3);
  assert.equal(meta.property_metadata_source, "property_record");
  assert.equal(meta.property_metadata_found, true);
});

test("the property loader degrades quietly and never throws", async () => {
  const exploding = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            throw new Error("network");
          },
        }),
      }),
    }),
  };
  const meta = await loadCanonicalPropertyMetadata(exploding, "prop-1");
  assert.equal(meta.units_count, null);
  assert.equal(meta.property_metadata_found, false);

  // Missing client or id is simply unknown, not an error.
  assert.equal((await loadCanonicalPropertyMetadata(null, "prop-1")).property_metadata_found, false);
  assert.equal((await loadCanonicalPropertyMetadata(exploding, "")).property_metadata_found, false);
});

test("a zero unit count is treated as unknown, not as a classification", () => {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { property_type: "Multi-Family", units_count: 0 }, error: null }),
        }),
      }),
    }),
  };
  return loadCanonicalPropertyMetadata(supabase, "p").then((meta) => {
    assert.equal(meta.units_count, null);
  });
});
