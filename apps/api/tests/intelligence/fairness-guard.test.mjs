import test from "node:test";
import assert from "node:assert/strict";

import {
  FAIRNESS_REPORT_VERSION,
  GROUP_AUDIT_FIELDS,
  auditByGroups,
  buildFairnessReport,
  validateFairnessReport,
} from "../../src/lib/domain/intelligence/fairness/group-audit.js";

function records() {
  const out = [];
  for (let i = 0; i < 200; i += 1) {
    out.push({
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
  return out;
}

test("fairness report: aggregates by every personal-attribute group, small groups suppressed, no ids", () => {
  const report = auditByGroups(records(), { labelOf: (r) => r.label, scoreOf: (r) => r.score, minGroupSize: 30 });
  assert.equal(report.measurement_only, true);
  assert.deepEqual(Object.keys(report.fields).sort(), [...GROUP_AUDIT_FIELDS].sort());
  assert.equal(GROUP_AUDIT_FIELDS.length, 8);
  assert.deepEqual(Object.keys(report.fields.gender.groups), ["f", "m"]);
  assert.equal(report.fields.gender.fairness_class, "personal_attribute");
  assert.equal(report.fields.owner_language.suppressed_groups, 1, "4 vietnamese rows < 30 are suppressed");
  assert.equal(report.fields.marital_status.missing_rows, 200);
  assert.ok(!JSON.stringify(report).includes("send-"), "no subject ids in the report");
});

test("a promotion-ready report names its model version and validates structurally", () => {
  const report = buildFairnessReport(records(), {
    modelVersionId: "11111111-1111-5111-8111-111111111111",
    featureSetId: "seller_first_touch_all@1",
    generatedAt: "2026-10-02T00:00:00.000Z",
    labelOf: (r) => r.label,
    scoreOf: (r) => r.score,
  });
  assert.equal(report.report_version, FAIRNESS_REPORT_VERSION);
  assert.equal(validateFairnessReport(report, { modelVersionId: "11111111-1111-5111-8111-111111111111" }).ok, true);
  assert.equal(validateFairnessReport(report, { modelVersionId: "22222222-2222-5222-8222-222222222222" }).ok, false);
  assert.equal(validateFairnessReport({ ...report, measurement_only: false }).ok, false);
  assert.equal(validateFairnessReport(null).ok, false);
});
