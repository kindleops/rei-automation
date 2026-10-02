import test from "node:test";
import assert from "node:assert/strict";

import {
  PROTECTED_DECISION_ALLOWLIST,
  PROTECTED_FEATURE_DECISION_BLOCK,
  ProtectedFeatureDecisionError,
  assertDecisionEligible,
  evaluateDecisionEligibility,
  protectedExperimentDimensions,
  validateAllowlistEntry,
} from "../../src/lib/domain/intelligence/fairness/decision-eligibility.js";
import { GROUP_AUDIT_FIELDS, auditByGroups } from "../../src/lib/domain/intelligence/fairness/group-audit.js";
import { V1_PROTECTED_MEMBERS, createV1Registry } from "../../src/lib/domain/intelligence/features/v1-features.js";

const FAMILY = "seller_first_touch_reply";
const signoff = { document_id: "LEGAL-2026-001", date: "2026-10-01", approver: "counsel@example.test" };

test("the protected-decision allowlist ships empty and frozen", () => {
  assert.deepEqual([...PROTECTED_DECISION_ALLOWLIST], []);
  assert.ok(Object.isFrozen(PROTECTED_DECISION_ALLOWLIST));
});

test("an empty allowlist blocks every protected_analysis_only member from live decisions", () => {
  const featureRegistry = createV1Registry();
  assert.equal(evaluateDecisionEligibility({ featureSetId: "seller_first_touch@1", family: FAMILY, featureRegistry }).eligible, true);
  assert.equal(evaluateDecisionEligibility({ featureSetId: "seller_first_touch_tier_r@1", family: FAMILY, featureRegistry }).eligible, true);
  const verdict = evaluateDecisionEligibility({ featureSetId: "seller_first_touch_protected_research@1", family: FAMILY, featureRegistry });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, PROTECTED_FEATURE_DECISION_BLOCK);
  assert.deepEqual(verdict.blocked.map((b) => b.feature).sort(), [...V1_PROTECTED_MEMBERS].sort());
  assert.throws(
    () => assertDecisionEligible({ featureSetId: "seller_first_touch_protected_research@1", family: FAMILY, featureRegistry }),
    (error) => error instanceof ProtectedFeatureDecisionError && error.code === "PROTECTED_FEATURE_DECISION_BLOCK",
  );
});

test("an override needs a complete legal sign-off for that exact feature AND family", () => {
  const featureRegistry = createV1Registry();
  const entry = { feature: "prospect.gender@1", family: FAMILY, legal_signoff: signoff };
  assert.equal(validateAllowlistEntry(entry).ok, true);
  const withOne = evaluateDecisionEligibility({ featureSetId: "seller_first_touch_protected_research@1", family: FAMILY, featureRegistry, allowlist: [entry] });
  assert.equal(withOne.eligible, false, "three other protected members still block");
  assert.ok(!withOne.blocked.some((b) => b.feature === "prospect.gender@1"));
  for (const bad of [
    { ...entry, legal_signoff: { ...signoff, approver: "" } },
    { ...entry, legal_signoff: { ...signoff, date: "October 1" } },
    { ...entry, legal_signoff: undefined },
    { ...entry, family: "comp_micromarket" },
  ]) {
    const verdict = evaluateDecisionEligibility({ featureSetId: "seller_first_touch_protected_research@1", family: FAMILY, featureRegistry, allowlist: [bad] });
    assert.ok(verdict.blocked.some((b) => b.feature === "prospect.gender@1"), JSON.stringify(bad));
  }
  const all = V1_PROTECTED_MEMBERS.map((feature) => ({ feature, family: FAMILY, legal_signoff: signoff }));
  assert.equal(evaluateDecisionEligibility({ featureSetId: "seller_first_touch_protected_research@1", family: FAMILY, featureRegistry, allowlist: all }).eligible, true);
});

test("fails closed on an unresolvable feature set and on protected artifact columns", () => {
  const featureRegistry = createV1Registry();
  assert.equal(evaluateDecisionEligibility({ featureSetId: "nope@1", family: FAMILY, featureRegistry }).reason, "feature_set_unresolved");
  assert.equal(evaluateDecisionEligibility({ featureSetId: "seller_first_touch@1", family: FAMILY }).reason, "feature_registry_unavailable");
  const smuggled = evaluateDecisionEligibility({
    featureSetId: "seller_first_touch@1",
    family: FAMILY,
    featureRegistry,
    artifactFeatureNames: ["property.market=phoenix", "owner.language=spanish", "agent_persona=carlos_mendez"],
  });
  assert.equal(smuggled.eligible, false);
  assert.deepEqual(smuggled.blocked.map((b) => b.reason), ["protected_artifact_column", "protected_artifact_column"]);
});

test("experiment dimensions may not be protected or prohibited fields", () => {
  const hits = protectedExperimentDimensions(["template_variant", "agent_persona", "best_language", "gender", "seller_first_name", "send_hour", "market"]);
  assert.deepEqual(hits.map((h) => h.name), ["agent_persona", "best_language", "gender", "seller_first_name"]);
});

test("fairness report: aggregates by protected and restricted groups, small groups suppressed, no ids", () => {
  const records = [];
  for (let i = 0; i < 200; i += 1) {
    records.push({
      subject_id: `send-${i}`,
      features: {
        "prospect.gender": i % 2 ? "f" : "m",
        "owner.language": i % 50 === 0 ? "vietnamese" : "english",
        "prospect.age_band": i % 3 ? "45_54" : "65_74",
      },
      label: i % 7 === 0 ? 1 : 0,
      score: (i % 10) / 10,
    });
  }
  const report = auditByGroups(records, { labelOf: (r) => r.label, scoreOf: (r) => r.score, minGroupSize: 30 });
  assert.equal(report.measurement_only, true);
  assert.deepEqual(Object.keys(report.fields).sort(), [...GROUP_AUDIT_FIELDS.protected_analysis_only, ...GROUP_AUDIT_FIELDS.restricted_targeting].sort());
  assert.deepEqual(Object.keys(report.fields.gender.groups), ["f", "m"]);
  assert.equal(report.fields.gender.fairness_class, "protected_analysis_only");
  assert.equal(report.fields.owner_language.suppressed_groups, 1, "4 vietnamese rows < 30 are suppressed");
  assert.equal(report.fields.age_band.fairness_class, "restricted_targeting");
  assert.equal(report.fields.marital_status.missing_rows, 200);
  const text = JSON.stringify(report);
  assert.ok(!text.includes("send-"), "no subject ids in the report");
});
