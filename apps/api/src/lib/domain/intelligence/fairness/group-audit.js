/**
 * IC8 FAIRNESS REPORTING (owner decision 2026-10-01, final policy).
 *
 * Every model that uses a personal_attribute input ships a fairness report:
 * performance and score distribution by each personal-attribute group
 * (gender, marital status, owner language, agent persona, age band, income
 * band, education, occupation). The model registry requires a valid report to
 * promote such a model to shadow / challenger / champion.
 *
 * Group values are read from snapshot records built with
 * seller_first_touch_all@1 (or any caller-supplied lookup). The report holds
 * aggregates only: no subject ids, no per-row group values. Groups smaller
 * than minGroupSize are suppressed.
 */

import { auc, calibrationTable } from "../models/metrics.js";

export const FAIRNESS_REPORT_VERSION = "ic8_fairness_report@1";
export const GROUP_AUDIT_FIELDS = Object.freeze([
  "gender",
  "marital_status",
  "owner_language",
  "agent_persona",
  "age_band",
  "income_band",
  "education",
  "occupation",
]);

/** Where each audit group lives in a record built with seller_first_touch_all@1. */
export const GROUP_FEATURE_KEYS = Object.freeze({
  gender: "prospect.gender",
  marital_status: "prospect.marital_status",
  owner_language: "owner.language",
  agent_persona: "owner.agent_persona",
  age_band: "prospect.age_band",
  income_band: "prospect.household_income_band",
  education: "prospect.education_level",
  occupation: "prospect.occupation_group",
});

export const DEFAULT_MIN_GROUP_SIZE = 30;

/** Default group lookup: the research features on a snapshot record. */
export function groupOfFromRecord(record, field) {
  const key = GROUP_FEATURE_KEYS[field];
  return key && record && record.features ? (record.features[key] ?? null) : null;
}

const normalizeGroup = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  return text ? text.slice(0, 60) : null;
};

/**
 * Score/label disparities by group.
 * @param records  model evaluation rows
 * @param options  { labelOf(record), scoreOf(record), groupOf(record, field) = groupOfFromRecord,
 *                   fields (default: every audit group), minGroupSize }
 */
export function auditByGroups(
  records,
  {
    groupOf = groupOfFromRecord,
    labelOf,
    scoreOf,
    fields = GROUP_AUDIT_FIELDS,
    minGroupSize = DEFAULT_MIN_GROUP_SIZE,
  } = {},
) {
  if (typeof groupOf !== "function" || typeof labelOf !== "function" || typeof scoreOf !== "function") {
    throw new TypeError("auditByGroups needs groupOf, labelOf and scoreOf");
  }
  const scores = records.map((r) => Number(scoreOf(r)));
  const labels = records.map((r) => (labelOf(r) === true || labelOf(r) === 1 ? 1 : 0));
  const n = records.length;
  const sorted = [...scores].sort((a, b) => b - a);
  const topThreshold = n ? sorted[Math.max(0, Math.ceil(n / 10) - 1)] : null;
  const overall = {
    n,
    base_rate: n ? labels.reduce((a, b) => a + b, 0) / n : null,
    mean_score: n ? scores.reduce((a, b) => a + b, 0) / n : null,
    top_decile_threshold: topThreshold,
  };
  const out = {};
  for (const field of fields) {
    const buckets = new Map();
    let missing = 0;
    records.forEach((record, i) => {
      const group = normalizeGroup(groupOf(record, field));
      if (group === null) {
        missing += 1;
        return;
      }
      if (!buckets.has(group)) buckets.set(group, []);
      buckets.get(group).push(i);
    });
    const groups = {};
    let suppressed = 0;
    let suppressedRows = 0;
    const meanScores = [];
    for (const group of [...buckets.keys()].sort()) {
      const idx = buckets.get(group);
      if (idx.length < minGroupSize) {
        suppressed += 1;
        suppressedRows += idx.length;
        continue;
      }
      const groupScores = idx.map((i) => scores[i]);
      const groupLabels = idx.map((i) => labels[i]);
      const positives = groupLabels.reduce((a, b) => a + b, 0);
      const meanScore = groupScores.reduce((a, b) => a + b, 0) / idx.length;
      meanScores.push(meanScore);
      groups[group] = {
        n: idx.length,
        positives,
        base_rate: positives / idx.length,
        mean_score: meanScore,
        calibration_ece: calibrationTable(groupLabels, groupScores, { bins: 5 }).ece,
        auc: auc(groupLabels, groupScores),
        top_decile_share: topThreshold === null ? null : groupScores.filter((s) => s >= topThreshold).length / idx.length,
      };
    }
    out[field] = {
      fairness_class: "personal_attribute",
      groups,
      reported_groups: Object.keys(groups).length,
      suppressed_groups: suppressed,
      suppressed_rows: suppressedRows,
      missing_rows: missing,
      mean_score_ratio_min_max: meanScores.length > 1 && Math.max(...meanScores) > 0 ? Math.min(...meanScores) / Math.max(...meanScores) : null,
    };
  }
  return { measurement_only: true, min_group_size: minGroupSize, overall, fields: out };
}

/** A promotion-ready fairness report for one model version. */
export function buildFairnessReport(records, { modelVersionId, featureSetId, datasetId = null, generatedAt, labelOf, scoreOf, groupOf, fields, minGroupSize } = {}) {
  if (!modelVersionId || !featureSetId) throw new TypeError("buildFairnessReport needs modelVersionId and featureSetId");
  return {
    report_version: FAIRNESS_REPORT_VERSION,
    model_version_id: String(modelVersionId),
    feature_set_id: featureSetId,
    dataset_id: datasetId,
    generated_at: generatedAt || new Date().toISOString(),
    ...auditByGroups(records, { labelOf, scoreOf, groupOf, fields, minGroupSize }),
  };
}

/** Structural validation used by the model registry before promotion. */
export function validateFairnessReport(report, { modelVersionId } = {}) {
  const problems = [];
  if (!report || typeof report !== "object") return { ok: false, problems: ["fairness report required"] };
  if (report.report_version !== FAIRNESS_REPORT_VERSION) problems.push(`report_version must be ${FAIRNESS_REPORT_VERSION}`);
  if (modelVersionId && String(report.model_version_id) !== String(modelVersionId)) problems.push("report is for another model version");
  if (report.measurement_only !== true) problems.push("not a group-audit report");
  if (!report.overall || !(report.overall.n > 0)) problems.push("report covers no rows");
  const fields = report.fields && typeof report.fields === "object" ? Object.keys(report.fields) : [];
  if (!fields.length) problems.push("report has no groups");
  if (!Number.isFinite(Date.parse(report.generated_at))) problems.push("generated_at required");
  return { ok: problems.length === 0, problems };
}
