import test from "node:test";
import assert from "node:assert/strict";

import { createFeatureRegistry, defineFeature } from "../../src/lib/domain/intelligence/registry/feature-registry.js";
import {
  DEFAULT_FAMILY_POLICIES,
  FAIRNESS_CLASSES,
  FairnessLintError,
  classifySource,
  defineFamilyPolicy,
  lintFeatureSources,
  requiredFairnessClass,
} from "../../src/lib/domain/intelligence/registry/prohibited.js";
import { V1_PERSONAL_MEMBERS, createV1Registry } from "../../src/lib/domain/intelligence/features/v1-features.js";

function spec(overrides = {}) {
  return {
    key: "seller.example",
    version: 1,
    scope: "seller",
    domain: "ownership_prospect",
    valueType: "categorical",
    mode: "both",
    pitClass: "static_fact",
    fairnessClass: "permitted",
    lineage: { sources: ["properties.property_type"], calc: "example" },
    owner: "test",
    freshnessSla: null,
    compute: () => null,
    ...overrides,
  };
}

/** Prohibited everywhere: identity, demographic composition, legacy scores (+ protected classes the owner did not address). */
const PROHIBITED_SOURCES = [
  "prospects.full_name",
  "prospects.first_name",
  "master_owners.display_name",
  "send_queue.seller_first_name",
  "properties.owner_1_name",
  "seller.owner.surname",
  "seller.property_sale.buyer_1_name",
  "closing_cases.signer_name",
  "phones.canonical_e164",
  "send_queue.to_phone_number",
  "send_queue.thread_key",
  "phones.area_code",
  "prospects.best_phone",
  "prospects.best_email",
  "master_owners.best_email_1",
  "send_queue.metadata.personalization",
  "send_queue.metadata.candidate_snapshot",
  "seller.property.census_tract",
  "comp_private.census_acs_observations.b11001_household_type",
  "census_geo_metrics.median_household_income",
  "properties.final_acquisition_score",
  "master_owners.priority_score",
  "campaign_target_graph.acquisition_score",
  "properties.ai_score",
  "properties.deal_strength_score",
  "properties.structured_motivation_score",
  "master_owners.financial_pressure_score",
  "property_acquisition_scores.transaction_probability_90",
  "properties.tag_distress_score",
  "seller.owner.veteran_military",
  "seller.owner.household_size",
  "seller.owner.in_owner_family",
  "seller.property_lien.date_of_divorce",
  "seller.property_lien.date_of_death",
  // anything read from the phones table is treated as phone identity (conservative)
  "phones.linked_languages",
];

const PERSONAL_SOURCES = [
  "prospects.gender",
  "campaign_target_graph.gender",
  "prospects.marital_status",
  "master_owners.best_language",
  "prospects.language_preference",
  "campaign_target_graph.language",
  "master_owners.agent_persona",
  "master_owners.agent_family",
  "send_queue.metadata.agent_name",

  "prospects.mob",
  "campaign_target_graph.age_bucket",
  "seller.owner.month_of_birth",
  "prospects.est_household_income",
  "campaign_target_graph.income",
  "prospects.net_asset_value",
  "prospects.education_model",
  "prospects.occupation_group",
];

const CONVERSATION_SOURCES = [
  "message_events.message_body",
  "send_queue.message_body",
  "send_queue.rendered_message",
  "inbox_thread_state.latest_message_body",
  "send_queue.language",
  "message_events.detected_language",
  "send_queue.metadata.template_snapshot.language",
];

test("the fairness class set is exactly the owner's final four", () => {
  assert.deepEqual([...FAIRNESS_CLASSES], ["permitted", "conversation_only", "personal_attribute", "prohibited"]);
});

test("identity, demographic composition and legacy scores are rejected under every declaration", () => {
  for (const source of PROHIBITED_SOURCES) {
    assert.equal(requiredFairnessClass([source]), "prohibited", source);
    for (const fairnessClass of FAIRNESS_CLASSES) {
      assert.throws(
        () => defineFeature(spec({ lineage: { sources: [source], calc: "x" }, fairnessClass })),
        (error) =>
          (error instanceof FairnessLintError && error.violations.some((v) => v.violation === "prohibited_source")) ||
          /prohibited feature can never be defined/.test(error.message),
        `expected rejection for ${source} declared ${fairnessClass}`,
      );
    }
  }
  assert.throws(() => defineFeature(spec({ fairnessClass: "prohibited" })), /prohibited feature can never be defined/);
});

test("each sensitive source requires its exact class: no class can be forgotten or overstated", () => {
  const groups = [
    ["personal_attribute", PERSONAL_SOURCES],
    ["conversation_only", CONVERSATION_SOURCES],
  ];
  for (const [required, sources] of groups) {
    for (const source of sources) {
      assert.equal(requiredFairnessClass([source]), required, source);
      for (const declared of ["permitted", "conversation_only", "personal_attribute"]) {
        const define = () =>
          defineFeature(spec({ key: "conversation.example", scope: "conversation", domain: "operational", lineage: { sources: [source], calc: "x" }, fairnessClass: declared }));
        if (declared === required) {
          assert.equal(define().fairnessClass, required, source);
        } else {
          assert.throws(
            define,
            (error) => error.violations.some((v) => v.violation === "fairness_class_mismatch" && v.required === required && v.declared === declared),
            `${source} declared ${declared}`,
          );
        }
      }
    }
  }
  assert.throws(
    () => defineFeature(spec({ fairnessClass: "personal_attribute" })),
    (error) => error.violations.some((v) => v.violation === "fairness_class_mismatch" && v.required === "permitted"),
  );
  assert.throws(() => defineFeature(spec({ fairnessTier: "R" })), /fairnessTier is retired/);
});

test("allowed sources and non-person names pass; join keys may be thread keys but never other sensitive fields", () => {
  for (const source of [
    "properties.property_type",
    "properties.units_count",
    "properties.canonical_market_id",
    "properties.property_address_county_name",
    "properties.gross_annual_income",
    "properties.owner_address_state",
    "seller.property_sale.event_date",
    "seller.property_mortgage.recording_date",
    "master_owners.owner_type_guess",
    "send_queue.sent_at|created_at",
    "properties.state→tz",
  ]) {
    assert.deepEqual(lintFeatureSources({ sources: [source] }), [], source);
  }
  assert.deepEqual(lintFeatureSources({ sources: ["send_queue.sent_at"], keys: ["send_queue.thread_key", "phones.canonical_e164"] }), []);
  for (const key of ["prospects.full_name", "prospects.gender"]) {
    assert.equal(lintFeatureSources({ sources: ["send_queue.sent_at"], keys: [key] })[0].violation, "sensitive_join_key", key);
  }
  assert.equal(classifySource("seller.property_sale.event_date").table, "seller.property_sale");
});

test("conversation_only features are rejected in every non-conversation family", () => {
  const registry = createFeatureRegistry();
  registry.register(
    spec({
      key: "conversation.reply_text_length",
      scope: "conversation",
      domain: "operational",
      fairnessClass: "conversation_only",
      lineage: { sources: ["message_events.message_body"], calc: "length" },
    }),
  );
  for (const [family, policy] of Object.entries(DEFAULT_FAMILY_POLICIES)) {
    const define = () => registry.defineSet({ name: `conv_${family}`, version: 1, members: ["conversation.reply_text_length@1"], family });
    if (policy.familyType === "conversation_understanding") assert.ok(define().featureSetId);
    else assert.throws(define, (error) => error.violations.some((v) => v.violation === "fairness_class_not_allowed_for_family"), family);
  }
  assert.throws(
    () => defineFamilyPolicy({ family: "bad_targeting", familyType: "targeting_response", allowedFairnessClasses: ["permitted", "conversation_only"] }),
    /conversation_only features are allowed ONLY in conversation_understanding families/,
  );
});

test("personal_attribute is granted to targeting_response families; other defined families must not declare it", () => {
  const registry = createV1Registry();
  assert.deepEqual(registry.lintSetForFamily("seller_first_touch_all@1", "seller_first_touch_reply"), []);
  for (const family of ["send_carrier_filtering", "send_opt_out_risk", "campaign_controller", "conversation_understanding", "comp_valuation", "buyer_match"]) {
    assert.ok(registry.lintSetForFamily("seller_first_touch_all@1", family).some((v) => v.violation === "fairness_class_not_allowed_for_family"), family);
  }
  for (const familyType of ["delivery_risk", "campaign_allocation", "conversation_understanding", "valuation", "buyer_selection"]) {
    assert.throws(
      () => defineFamilyPolicy({ family: `x_${familyType}`, familyType, allowedFairnessClasses: ["permitted", "personal_attribute"] }),
      /granted to targeting_response families/,
    );
  }
  // offer / negotiation are not defined in this phase
  for (const familyType of ["offer", "negotiation"]) {
    assert.throws(() => defineFamilyPolicy({ family: `x_${familyType}`, familyType }), /not defined in this phase/);
  }
});

test("v1 sets: identity never present; the eight personal attributes only in seller_first_touch_all", () => {
  const registry = createV1Registry();
  const base = registry.getSet("seller_first_touch@1");
  const all = registry.getSet("seller_first_touch_all@1");
  assert.equal(base.containsPersonal, false);
  assert.equal(all.containsPersonal, true);
  assert.deepEqual([...all.personalMembers].sort(), [...V1_PERSONAL_MEMBERS].sort());
  assert.equal(V1_PERSONAL_MEMBERS.length, 8);
  assert.deepEqual(registry.listSets().map((s) => s.featureSetId).sort(), ["seller_first_touch@1", "seller_first_touch@2", "seller_first_touch@3", "seller_first_touch_all@1", "seller_first_touch_all@2", "seller_first_touch_all@3"]);
  assert.equal(registry.getSet("seller_first_touch@2").containsPersonal, false);
  for (const def of registry.list()) {
    for (const source of def.lineage.sources) {
      assert.ok(!classifySource(source).findings.some((f) => f.effect === "prohibited"), `${def.id} reads prohibited ${source}`);
    }
  }
});
