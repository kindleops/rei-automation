import test from "node:test";
import assert from "node:assert/strict";

import {
  FeatureRegistryError,
  createFeatureRegistry,
  defineFeature,
  featureDefinitionHash,
  toFeatureDefinitionRow,
} from "../../src/lib/domain/intelligence/registry/feature-registry.js";
import { V1_FEATURE_SPECS, createV1Registry } from "../../src/lib/domain/intelligence/features/v1-features.js";

/**
 * Pinned definition hashes. A failure here means a v1 definition changed
 * without a version bump: restore it, or define <key>@2 instead. Never edit a
 * pinned hash to make this pass.
 */
const PINNED = Object.freeze({
  "owner.absentee@1": "88cb2b3727db45ad31d61a37b8bc6fb84e6beb0e9c14fb23e0f7ab4418a62dcb",
  "owner.agent_persona@1": "40df7dfa94b3e34e87d23f70f29f850e5cac9e7f5e7f15b043def3b4b3d1bdd4",
  "owner.entity_class@1": "9515ad03d2a1b5ae147286929e9a1c45eaf29a09ba7ecfd0dc82b672a5f349aa",
  "owner.language@1": "3b83ccef8cad914f5ef9926aa0b6baa201b300a92d60fd2e9e2f028b3b1459df",
  "property.asset_family@1": "bf31e4d5415a6560fc70fa9a4a4dee462cac779f5cab3ccb3f59a380efdc8e64",
  "property.bathrooms@1": "66005279575f37610877b75c1e7c5dc93da64e116413d84ab8da147c390e7c45",
  "property.bedrooms@1": "2ecf42cc7a9c5efd125ff8c48455fb9e750778e1d78139a805d3b33269794bbb",
  "property.living_sqft@1": "71198fc23936847e170ef024628aa3288986c477ab2d3f8b69db31c3d0a832d1",
  "property.market@1": "4c229205f964192103bbd8c7f4ac348a808afe73132912d3819557e457192cdf",
  "property.recorded_lien_count@1": "a66b6d27c9c28f00d453bf776f305ecf26f93d29a14c04e0196bcac79c1b6288",
  "property.recorded_mortgage_count@1": "637a653339f3cb908d8c3e07f7e3a147f53f96b322779ae39f08c3f6f5071b72",
  "property.unit_count@1": "7c9b83d57696e59b4e594be053551dc3d5cd5a8e5a3757889155d2e7ff234617",
  "property.year_built@1": "fa9f01842e8e9cfb690a5872e281de3972a392e15ac71cd16c52d53d99a6e4da",
  "property.years_since_last_recorded_sale@1": "4ea5f46ff60fc89cfd37340eb7958ba19b57773a966a544e84a351f37de357df",
  "prospect.age_band@1": "fa8b75bd977753277915009913afbf20a53d5216fa86ae3998e9ba48c7fa92f1",
  "prospect.education_level@1": "d8b95e45ef6062cd9daeef45e65806902d94ca763f4c94121830490657651910",
  "prospect.gender@1": "dff49f3bf3ca6fb8ea52fd87e90effcc2dbe08d69a974a53ea6489aa67495e0f",
  "prospect.household_income_band@1": "b3988e919371432fcddc971ec4e76872550c275e259c85ca3b5764ecb6102b16",
  "prospect.marital_status@1": "6bad4f54a438becbf10ee01911b14032f8e551a14f5bd33f3bf04e7079c67a5d",
  "prospect.occupation_group@1": "7c30b56464c68417c0b091d8cf293b4a7e2b91e1760dc80c4fd6bf088caa6114",
  "seller.days_since_last_touch@1": "a0426b9769e427b96b77532654e7c7b8d344d297516df87adf6fb43bb6152818",
  "seller.prior_delivered_count@1": "a13c2ace9dedbba630a3a5a1ec618012e9c126aa2f8ffefe486b2a1c6fbada64",
  "seller.prior_touch_count@1": "bb935c9ebc7d06f19426e9e5f9a66c73e4af40023cc97a0e78e76fd5179d0c48",
  "send.recipient_local_hour@1": "d0f687dee54cde3f51a3c432d2086eeef2f9245d253963943c406dffbcd76d90",
  "send.recipient_local_weekday@1": "e12556724d2407014a4e8c3788841db2314dfaa273b6bb11e77848240b358a5c",
  "template.template_id@1": "39b74486bca1b592419754943e273d119162e071b5a1372c1759dfccad287e1c",
  "template.use_case@1": "dff9686727563fcb4ed7b0737b999b2f75e1f665c76899f8536eb38a4d6d68bd",
  "seller_first_touch_protected_research@1": "c0d6cfe6aa362bb6beac153cf5f72ebfc11d70f233e17536fe6f653dd80183ea",
  "seller_first_touch_tier_r@1": "40eae689034d6e5a46308562294e325d1d50cd116d566d5abac536ac9e29a49e",
  "seller_first_touch@1": "3ce39382ab59530b96ea1bf9093005a0cbf31cbeee7cf2655f6167a10df4e280",
});

test("v1 definition hashes are pinned: a changed hash under the same version fails", () => {
  const registry = createV1Registry();
  const actual = {};
  for (const def of registry.list()) actual[def.id] = def.definitionHash;
  for (const set of registry.listSets()) actual[set.featureSetId] = set.definitionHash;
  assert.deepEqual(actual, PINNED);
});

test("definition_hash covers domain, pit class, fairness declarations, lineage and compute source", () => {
  const base = V1_FEATURE_SPECS.find((s) => s.key === "property.unit_count");
  const hash = featureDefinitionHash(base);
  const variants = [
    { domain: "financial_title" },
    { fairnessClass: "restricted_targeting" },
    { statedFact: true },
    { pitClass: "event_time" },
    { scope: "deal" },
    { valueType: "number" },
    { lineage: { ...base.lineage, calc: "different calculation" } },
    { compute: ({ read }) => read("property").length },
  ];
  for (const change of variants) {
    assert.notEqual(featureDefinitionHash({ ...base, ...change }), hash, JSON.stringify(Object.keys(change)));
  }
  // mode/owner/freshness are operational metadata, not meaning (arch §3.1 hash fields)
  assert.equal(featureDefinitionHash({ ...base, owner: "someone-else" }), hash);
});

test("a redefinition under the same key@version is rejected; the same definition is idempotent", () => {
  const registry = createFeatureRegistry();
  const spec = V1_FEATURE_SPECS.find((s) => s.key === "property.year_built");
  registry.register(spec);
  assert.equal(registry.register(spec).id, "property.year_built@1");
  assert.throws(
    () => registry.register({ ...spec, compute: ({ read }) => read("property").length }),
    (error) => error instanceof FeatureRegistryError && error.code === "REDEFINITION",
  );
  registry.register({ ...spec, version: 2, compute: ({ read }) => read("property").length });
  assert.ok(registry.has("property.year_built", 2));
});

test("domain is required and must be one of the owner's five domains", () => {
  const spec = V1_FEATURE_SPECS.find((s) => s.key === "property.year_built");
  const withoutDomain = { ...spec };
  delete withoutDomain.domain;
  assert.throws(() => defineFeature(withoutDomain), /domain must be one of property, ownership_prospect, financial_title, company_relationship, operational/);
  assert.throws(() => defineFeature({ ...spec, domain: "market" }), /domain must be one of/);
});

test("historical training sets refuse decision_snapshot_only features", () => {
  const registry = createV1Registry();
  for (const member of ["owner.absentee@1", "property.recorded_lien_count@1"]) {
    assert.throws(
      () => registry.defineSet({ name: "with_snapshot_only", version: 1, members: ["property.year_built@1", member] }),
      (error) => error.code === "PIT_CLASS_NOT_HISTORICAL",
      member,
    );
  }
  const online = registry.defineSet({
    name: "seller_first_touch_online",
    version: 1,
    purpose: "online",
    members: ["property.year_built@1", "owner.absentee@1"],
  });
  assert.equal(online.purpose, "online");
  assert.throws(
    () => defineFeature({ ...V1_FEATURE_SPECS.find((s) => s.key === "owner.absentee"), mode: "both" }),
    /decision_snapshot_only features are online-only/,
  );
});

test("mirror rows carry domain and fairness class for intelligence.feature_definitions", () => {
  const registry = createV1Registry();
  const row = toFeatureDefinitionRow(registry.get("prospect.age_band", 1));
  assert.equal(row.domain, "ownership_prospect");
  assert.equal(row.fairness_class, "restricted_targeting");
  assert.equal(row.pit_class, "static_fact");
  assert.equal(row.definition_hash.length, 64);
  assert.equal(toFeatureDefinitionRow(registry.get("prospect.gender", 1)).fairness_class, "protected_analysis_only");
  const absentee = toFeatureDefinitionRow(registry.get("owner.absentee", 1));
  assert.equal(absentee.freshness_sla, "300 seconds");
  assert.equal(registry.toFeatureSetRows().length, 3);
});
