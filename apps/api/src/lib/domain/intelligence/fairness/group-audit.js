/**
 * IC8 FAIRNESS GROUP AUDIT (architecture §3.3; owner decisions of 2026-10-01).
 *
 * Every model ships a fairness report: performance and score distribution by
 * the protected_analysis_only groups (gender, marital status, owner language,
 * agent persona) and the restricted_targeting groups (age band, income band,
 * education, occupation). Group values are read from a dataset record's
 * research features (seller_first_touch_protected_research@1 carries them) or
 * from any caller-supplied lookup -- this is measurement, not a model input.
 *
 * The report holds aggregates only: no subject ids, no per-row group values.
 * Groups smaller than minGroupSize are suppressed.
 */

import { auc, calibrationTable } from "../models/metrics.js";

export const GROUP_AUDIT_FIELDS = Object.freeze({
  protected_analysis_only: Object.freeze(["gender", "marital_status", "owner_language", "agent_persona"]),
  restricted_targeting: Object.freeze(["age_band", "income_band", "education", "occupation"]),
});

/** Where each audit group lives in a dataset record built with the research feature set. */
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
    fields = [...GROUP_AUDIT_FIELDS.protected_analysis_only, ...GROUP_AUDIT_FIELDS.restricted_targeting],
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
      fairness_class: GROUP_AUDIT_FIELDS.protected_analysis_only.includes(field) ? "protected_analysis_only" : "restricted_targeting",
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
