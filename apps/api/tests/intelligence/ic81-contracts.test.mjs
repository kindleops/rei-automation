import test from "node:test";
import assert from "node:assert/strict";

import { createV1Registry, V1_WEALTH_MEMBERS } from "../../src/lib/domain/intelligence/features/v1-features.js";
import { computeFeatureVector, notApplicable, unknownValue, withQuality } from "../../src/lib/domain/intelligence/features/pit.js";
import { createFeatureRegistry } from "../../src/lib/domain/intelligence/registry/feature-registry.js";
import { DEFAULT_FAMILY_POLICIES, classifySource, featureGroupOf } from "../../src/lib/domain/intelligence/registry/prohibited.js";

const AS_OF = "2026-07-15T14:30:00.000Z";
const entity = { id: "s1", thread_key: "+16125550100", property_id: "p1", master_owner_id: "mo1", sent_at: AS_OF };
const property = { property_id: "p1", property_address_state: "MN", property_address_zip: "55411", school_district_name: "Minneapolis Public School District", latitude: 45.0, longitude: -93.3 };

test("school district is a permitted property fact with source and vintage, usable by valuation and targeting", () => {
  assert.equal(classifySource("properties.school_district_name").findings.length, 0);
  const registry = createV1Registry();
  const def = registry.get("property.school_district", 1);
  assert.equal(def.fairnessClass, "permitted");
  assert.equal(def.domain, "property");
  assert.equal(def.group, "property");
  assert.equal(def.pitClass, "static_fact");
  const vector = computeFeatureVector({ registry, featureSetId: "seller_first_touch@3", entity, asOf: AS_OF, bundle: { property } });
  assert.equal(vector.values["property.school_district"], "minneapolis_public_school_district");
  assert.deepEqual(vector.quality["property.school_district"], { source: "properties.school_district_name", vintage: "2026-08" });
  const valuation = registry.defineSet({ name: "valuation_probe", version: 1, members: ["property.school_district@1", "property.unit_count@1", "property.year_built@1"], family: "comp_valuation" });
  assert.equal(valuation.containsPersonal, false);
});

test("modeled wealth: versioned personal_attribute static facts, in the targeting arm only", () => {
  const registry = createV1Registry();
  for (const id of V1_WEALTH_MEMBERS) {
    const def = registry.get(id);
    assert.equal(def.fairnessClass, "personal_attribute", id);
    assert.equal(def.pitClass, "static_fact", id);
    assert.ok(def.lineage.as_of.includes("2026-04"), id);
  }
  const all = registry.getSet("seller_first_touch_all@3");
  for (const id of V1_WEALTH_MEMBERS) assert.ok(all.personalMembers.includes(id), id);
  assert.equal(registry.getSet("seller_first_touch@3").containsPersonal, false);
  assert.deepEqual(registry.lintSetForFamily("seller_first_touch_all@3", "seller_first_touch_reply"), []);
  for (const family of ["comp_valuation", "buyer_match"]) {
    assert.ok(registry.lintSetForFamily("seller_first_touch_all@3", family).some((v) => v.violation === "fairness_class_not_allowed_for_family"), family);
  }
  const vector = computeFeatureVector({
    registry,
    featureSetId: "seller_first_touch_all@3",
    entity,
    asOf: AS_OF,
    bundle: { property, prospect_person: { prospect_id: "pr1", net_asset_value: "$100,000 - $249,999", buying_power: "Medium" } },
  });
  assert.equal(vector.values["prospect.net_asset_value_band"], "100000_249999");
  assert.equal(vector.values["prospect.buying_power_band"], "medium");
});

test("per-model feature contracts: each family accepts only its declared groups", () => {
  assert.deepEqual([...DEFAULT_FAMILY_POLICIES.comp_valuation.allowedGroups].sort(), ["comp", "market", "property", "public_record", "seller_provided", "transaction"]);
  assert.deepEqual([...DEFAULT_FAMILY_POLICIES.buyer_match.allowedGroups].sort(), ["buyer", "company", "market", "property_relationship", "purchase"]);
  const registry = createV1Registry();
  for (const id of ["template.template_id@1", "seller.prior_touch_count@1", "market.investor_share_zip_12m@1", "owner.entity_class@1"]) {
    assert.throws(
      () => registry.defineSet({ name: `v_${id.replace(/[^a-z]/g, "_")}`, version: 1, members: [id], family: "comp_valuation" }),
      (e) => e.violations.some((v) => v.violation === "feature_group_not_in_family_contract"),
      id,
    );
  }
  const own = createFeatureRegistry();
  own.register({
    key: "buyer.purchases_12m",
    version: 1,
    scope: "buyer",
    domain: "company_relationship",
    group: "purchase",
    valueType: "integer",
    mode: "both",
    pitClass: "event_time",
    fairnessClass: "permitted",
    lineage: { sources: ["buyer_purchase_events_v2.purchase_date"], calc: "buyer purchases in 12 months" },
    owner: "test",
    freshnessSla: null,
    compute: () => null,
  });
  assert.ok(own.defineSet({ name: "buyer_probe", version: 1, members: ["buyer.purchases_12m@1"], family: "buyer_match" }));
  // group derivation is pinned (a change here changes contracts without a hash change)
  const counts = {};
  for (const def of registry.list()) counts[featureGroupOf(def)] = (counts[featureGroupOf(def)] || 0) + 1;
  assert.deepEqual(counts, { investor: 40, prospect: 12, property: 7, public_record: 4, market: 1, contact: 3, campaign: 4 });
});

function probe(compute, extra = {}) {
  const registry = createFeatureRegistry();
  registry.register({
    key: "property.probe",
    version: 1,
    scope: "property",
    domain: "property",
    valueType: "number",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "permitted",
    lineage: { sources: ["properties.units_count"], calc: "probe" },
    owner: "test",
    freshnessSla: null,
    compute,
    ...extra,
  });
  registry.defineSet({ name: "probe", version: 1, members: ["property.probe@1"] });
  return computeFeatureVector({ registry, featureSetId: "probe@1", entity, asOf: AS_OF, bundle: { property } });
}

test("missingness is tri-state and never zero-filled; undeclared quality fields are refused", () => {
  assert.deepEqual(probe(() => null).missingness, { "property.probe": "missing" });
  assert.deepEqual(probe(() => unknownValue("conflicting sources")).missingness, { "property.probe": "unknown" });
  const na = probe(() => notApplicable("vacant land has no units"));
  assert.deepEqual(na.missingness, { "property.probe": "not_applicable" });
  assert.equal("property.probe" in na.values, false, "no zero-fill");
  const ok = probe(() => withQuality(3, { geocode_precision: "rooftop" }), { qualityFields: ["geocode_precision"] });
  assert.equal(ok.values["property.probe"], 3);
  assert.deepEqual(ok.quality, { "property.probe": { geocode_precision: "rooftop" } });
  const undeclared = probe(() => withQuality(3, { dedupe_confidence: "high" }));
  assert.deepEqual(undeclared.quality, {});
  assert.equal(undeclared.errors[0].code, "undeclared_quality_field");
  assert.throws(() => probe(() => 1, { qualityFields: ["made_up"] }), /qualityFields must be a subset/);
});

test("derived equity is an estimate carrying the provenance of value, mortgage and lien inputs", () => {
  const registry = createV1Registry();
  registry.defineSet({ name: "online_equity", version: 1, purpose: "online", members: ["property.equity_estimate_ratio@1"] });
  const capture = (extra) => ({
    decision_state: [{ captured_at: "2026-07-15T14:29:00Z", estimated_value: 200000, value_source: "vendor_avm", value_as_of: "2026-08-31", mortgage_source: "seller.property", mortgage_as_of: "2024-01-01", lien_source: "seller.property.lien_count", ...extra }],
  });
  const full = computeFeatureVector({ registry, featureSetId: "online_equity@1", entity, asOf: AS_OF, bundle: capture({ open_mortgage_balance: 150000 }) });
  assert.equal(full.values["property.equity_estimate_ratio"], 0.25);
  assert.deepEqual(full.quality["property.equity_estimate_ratio"], {
    value_source: "vendor_avm",
    value_as_of: "2026-08-31",
    mortgage_source: "seller.property",
    mortgage_as_of: "2024-01-01",
    mortgage_freshness: "stale",
    lien_source: "seller.property.lien_count",
    is_estimate: true,
  });
  const noBalance = computeFeatureVector({ registry, featureSetId: "online_equity@1", entity, asOf: AS_OF, bundle: capture({}) });
  assert.equal(noBalance.missingness["property.equity_estimate_ratio"], "unknown", "an unknown balance is never treated as zero debt");
  assert.equal(noBalance.quality["property.equity_estimate_ratio"].is_estimate, true);
});
