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
import {
  V1_PROTECTED_MEMBERS,
  V1_RESTRICTED_MEMBERS,
  createV1Registry,
} from "../../src/lib/domain/intelligence/features/v1-features.js";

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

/** Still prohibited everywhere: identity, demographic composition, legacy scores (+ unreversed protected classes). */
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
  "properties.school_district",
  // anything read from the phones table is treated as phone identity (conservative)
  "phones.linked_languages",
];

const PROTECTED_SOURCES = [
  "prospects.gender",
  "campaign_target_graph.gender",
  "prospects.marital_status",
  "master_owners.best_language",
  "prospects.language_preference",
  "campaign_target_graph.language",
  "master_owners.agent_persona",
  "master_owners.agent_family",
  "send_queue.metadata.agent_name",
];

const RESTRICTED_SOURCES = [
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

test("the fairness class set is exactly the four owner-approved classes", () => {
  assert.deepEqual([...FAIRNESS_CLASSES], ["permitted", "conversation_only", "restricted_targeting", "protected_analysis_only"]);
});

test("identity, demographic composition and legacy scores are rejected under every fairness class", () => {
  for (const source of PROHIBITED_SOURCES) {
    assert.equal(requiredFairnessClass([source]), null, source);
    for (const fairnessClass of FAIRNESS_CLASSES) {
      assert.throws(
        () => defineFeature(spec({ lineage: { sources: [source], calc: "x" }, fairnessClass })),
        (error) => error instanceof FairnessLintError && error.violations.some((v) => v.violation === "prohibited_source"),
        `expected rejection for ${source} declared ${fairnessClass}`,
      );
    }
  }
});

test("each sensitive source requires its exact class: no class can be forgotten or overstated", () => {
  const groups = [
    ["protected_analysis_only", PROTECTED_SOURCES],
    ["restricted_targeting", RESTRICTED_SOURCES],
    ["conversation_only", CONVERSATION_SOURCES],
  ];
  for (const [required, sources] of groups) {
    for (const source of sources) {
      assert.equal(requiredFairnessClass([source]), required, source);
      for (const declared of FAIRNESS_CLASSES) {
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
  // overstating is refused too: a permitted lineage cannot be declared protected
  assert.throws(
    () => defineFeature(spec({ fairnessClass: "protected_analysis_only" })),
    (error) => error.violations.some((v) => v.violation === "fairness_class_mismatch" && v.required === "permitted"),
  );
  // mixed lineage: the strictest class wins
  assert.equal(requiredFairnessClass(["prospects.mob", "prospects.gender"]), "protected_analysis_only");
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
    if (policy.familyType === "conversation_understanding") {
      assert.ok(define().featureSetId);
    } else {
      assert.throws(
        define,
        (error) => error instanceof FairnessLintError && error.violations.some((v) => ["fairness_class_not_allowed_for_family", "price_rule_violation"].includes(v.violation)),
        family,
      );
    }
  }
  assert.throws(
    () => defineFamilyPolicy({ family: "bad_targeting", familyType: "targeting_response", allowedFairnessClasses: ["permitted", "conversation_only"] }),
    /conversation_only features are allowed ONLY in conversation_understanding families/,
  );
});

test("restricted_targeting only in targeting_response families that declare a fairness report", () => {
  const registry = createFeatureRegistry();
  registry.register(spec({ key: "prospect.age_test", lineage: { sources: ["prospects.mob"], calc: "x" }, fairnessClass: "restricted_targeting" }));
  for (const familyType of ["valuation", "offer", "negotiation", "buyer_selection", "campaign_allocation", "delivery_risk"]) {
    registry.registerFamilyPolicy(defineFamilyPolicy({ family: `f_${familyType}`, familyType }));
    assert.throws(
      () => registry.defineSet({ name: `r_${familyType}`, version: 1, members: ["prospect.age_test@1"], family: `f_${familyType}` }),
      (error) => error.violations.some((v) => ["restricted_targeting_prohibited_for_family_type", "price_rule_violation"].includes(v.violation)),
      familyType,
    );
    assert.throws(
      () => defineFamilyPolicy({ family: `g_${familyType}`, familyType, allowedFairnessClasses: ["permitted", "restricted_targeting"], requiresFairnessReport: true }),
      /restricted_targeting is allowed ONLY in targeting_response families|price families/,
    );
  }
  // a targeting family that has not declared restricted_targeting (and so no report) is refused
  registry.registerFamilyPolicy(defineFamilyPolicy({ family: "targeting_plain", familyType: "targeting_response" }));
  assert.throws(
    () => registry.defineSet({ name: "r_plain", version: 1, members: ["prospect.age_test@1"], family: "targeting_plain" }),
    (error) => error.violations.some((v) => v.violation === "restricted_targeting_requires_fairness_report"),
  );
  // declaring restricted_targeting requires requiresFairnessReport
  assert.throws(
    () => defineFamilyPolicy({ family: "targeting_no_report", familyType: "targeting_response", allowedFairnessClasses: ["permitted", "restricted_targeting"] }),
    /must declare requiresFairnessReport/,
  );
  registry.registerFamilyPolicy(
    defineFamilyPolicy({ family: "targeting_ok", familyType: "targeting_response", allowedFairnessClasses: ["permitted", "restricted_targeting"], requiresFairnessReport: true }),
  );
  assert.equal(registry.defineSet({ name: "r_ok", version: 1, members: ["prospect.age_test@1"], family: "targeting_ok" }).containsRestricted, true);
});

test("protected_analysis_only: allowed in research sets of non-price families, never a family-allowed class", () => {
  const registry = createV1Registry();
  const research = registry.getSet("seller_first_touch_protected_research@1");
  assert.equal(research.containsProtected, true);
  assert.deepEqual([...research.protectedMembers].sort(), [...V1_PROTECTED_MEMBERS].sort());
  assert.throws(
    () => defineFamilyPolicy({ family: "sneaky", familyType: "targeting_response", allowedFairnessClasses: ["permitted", "protected_analysis_only"] }),
    /research-only and can never be a family-allowed class/,
  );
});

test("price rule: valuation/offer/negotiation take property, financial_title and seller-STATED facts only -- no personal attribute of any class", () => {
  const registry = createV1Registry();
  registry.register(spec({ key: "seller.stated_ask", domain: "ownership_prospect", statedFact: true, lineage: { sources: ["acquisition_opportunities.asking_price"], calc: "x" } }));
  for (const familyType of ["valuation", "offer", "negotiation"]) {
    const family = `price_${familyType}`;
    registry.registerFamilyPolicy(defineFamilyPolicy({ family, familyType }));
    const ok = registry.defineSet({
      name: `${family}_ok`,
      version: 1,
      members: ["property.unit_count@1", "property.recorded_mortgage_count@1", "seller.stated_ask@1"],
      family,
    });
    assert.ok(ok.featureSetId);
    for (const bad of ["owner.entity_class@1", "send.recipient_local_hour@1", "prospect.age_band@1", "prospect.gender@1", "owner.language@1"]) {
      assert.throws(
        () => registry.defineSet({ name: `${family}_bad_${bad.replace(/[^a-z]/g, "_")}`, version: 1, members: [bad], family }),
        (error) => error.violations.some((v) => ["price_rule_violation", "restricted_targeting_prohibited_for_family_type"].includes(v.violation)),
        `${familyType} must reject ${bad}`,
      );
    }
  }
  assert.throws(() => defineFeature(spec({ statedFact: true, domain: "property", scope: "property" })), /statedFact applies only to ownership_prospect/);
});

test("v1 sets: identity never present; restricted only in the ablation arm; protected only in the research set", () => {
  const registry = createV1Registry();
  const base = registry.getSet("seller_first_touch@1");
  const withR = registry.getSet("seller_first_touch_tier_r@1");
  assert.equal(base.containsRestricted || base.containsProtected, false);
  assert.equal(withR.containsProtected, false);
  assert.deepEqual([...withR.restrictedMembers].sort(), [...V1_RESTRICTED_MEMBERS].sort());
  const policy = registry.familyPolicy("seller_first_touch_reply");
  assert.equal(policy.familyType, "targeting_response");
  assert.equal(policy.requiresFairnessReport, true);
  for (const setId of ["seller_first_touch@1", "seller_first_touch_tier_r@1", "seller_first_touch_protected_research@1"]) {
    assert.deepEqual(registry.lintSetForFamily(setId, "seller_first_touch_reply"), [], setId);
  }
  for (const family of ["comp_micromarket", "seller_strategy_policy"]) {
    assert.ok(registry.lintSetForFamily("seller_first_touch_tier_r@1", family).length > 0, family);
  }
  for (const def of registry.list()) {
    for (const source of def.lineage.sources) {
      assert.ok(!classifySource(source).findings.some((f) => f.effect === "prohibited"), `${def.id} reads prohibited ${source}`);
    }
  }
});
