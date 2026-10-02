/**
 * IC8 DECISION ELIGIBILITY -- the hard guarantee behind protected_analysis_only
 * (owner decision 2026-10-01).
 *
 * protected_analysis_only fields (gender/sex, marital status, owner language /
 * best_language, agent_persona) may be defined, snapshotted, written into
 * datasets and used in development/backtest runs. They may NEVER drive a live
 * decision:
 *   - the model registry refuses shadow / challenger / champion for any model
 *     version whose feature set (or artifact) contains one;
 *   - the policy engine and any scorer refuse to load such a model;
 *   - an experiment may not use one as an arm or an assignment stratum.
 * Every refusal is PROTECTED_FEATURE_DECISION_BLOCK.
 *
 * The only override is an explicit allowlist entry per feature AND per family,
 * carrying a legal sign-off reference { document_id, date, approver }. The
 * allowlist ships EMPTY.
 */

import { classifySource } from "../registry/prohibited.js";

export const PROTECTED_FEATURE_DECISION_BLOCK = "PROTECTED_FEATURE_DECISION_BLOCK";
/** Model statuses that drive (or shadow) live decisions. */
export const DECISION_STATUSES = Object.freeze(["shadow", "challenger", "champion"]);

/**
 * Per-feature, per-family overrides. Each entry:
 *   { feature: "prospect.gender@1", family: "<model_family>",
 *     legal_signoff: { document_id, date: "YYYY-MM-DD", approver } }
 * Ships EMPTY. Adding an entry is a reviewed code change, never runtime data.
 */
export const PROTECTED_DECISION_ALLOWLIST = Object.freeze([]);

export class ProtectedFeatureDecisionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProtectedFeatureDecisionError";
    this.code = PROTECTED_FEATURE_DECISION_BLOCK;
    this.details = details;
  }
}

/** An allowlist entry is valid only with a complete legal sign-off reference. */
export function validateAllowlistEntry(entry) {
  const problems = [];
  if (!entry || typeof entry !== "object") return { ok: false, problems: ["entry must be an object"] };
  if (!/^[a-z][a-z0-9_.]*@[1-9][0-9]*$/.test(String(entry.feature || ""))) problems.push("feature must be key@version");
  if (!/^[a-z][a-z0-9_]*$/.test(String(entry.family || ""))) problems.push("family is required");
  const signoff = entry.legal_signoff;
  if (!signoff || typeof signoff !== "object") {
    problems.push("legal_signoff is required");
  } else {
    if (!String(signoff.document_id || "").trim()) problems.push("legal_signoff.document_id is required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(signoff.date || "")) || !Number.isFinite(Date.parse(signoff.date))) {
      problems.push("legal_signoff.date must be YYYY-MM-DD");
    }
    if (!String(signoff.approver || "").trim()) problems.push("legal_signoff.approver is required");
  }
  return { ok: problems.length === 0, problems };
}

function allowlisted(allowlist, feature, family) {
  return allowlist.some((entry) => entry.feature === feature && entry.family === family && validateAllowlistEntry(entry).ok);
}

/** Artifact column names that read protected_analysis_only material (e.g. "owner.language=spanish"). */
export function protectedArtifactNames(names = [], protectedKeys = []) {
  const keys = new Set(protectedKeys);
  const hits = [];
  for (const name of names) {
    const base = String(name).split("=")[0].split("@")[0].replace(/__missing__$/, "");
    if (keys.has(base)) {
      hits.push(name);
      continue;
    }
    if (classifySource(base).findings.some((f) => f.effect === "protected_analysis_only")) hits.push(name);
  }
  return hits;
}

/**
 * Evaluate whether a model built on `featureSetId` may drive live decisions in
 * `family`. Fails closed: an unresolvable feature set is not eligible.
 */
export function evaluateDecisionEligibility({
  featureSetId,
  family,
  featureRegistry,
  allowlist = PROTECTED_DECISION_ALLOWLIST,
  artifactFeatureNames = [],
} = {}) {
  if (!featureRegistry || typeof featureRegistry.getSet !== "function") {
    return { eligible: false, reason: "feature_registry_unavailable", blocked: [] };
  }
  let set;
  try {
    set = featureRegistry.getSet(featureSetId);
  } catch {
    return { eligible: false, reason: "feature_set_unresolved", blocked: [] };
  }
  const blocked = [];
  const protectedKeys = [];
  for (const member of set.members) {
    const id = `${member.key}@${member.version}`;
    const def = featureRegistry.get(member.key, member.version);
    if (def.fairnessClass !== "protected_analysis_only") continue;
    protectedKeys.push(member.key);
    if (!allowlisted(allowlist, id, family)) blocked.push({ feature: id, reason: "protected_analysis_only" });
  }
  for (const name of protectedArtifactNames(artifactFeatureNames, protectedKeys)) {
    const base = String(name).split("=")[0];
    if (!blocked.some((b) => b.feature.startsWith(`${base}@`))) blocked.push({ feature: name, reason: "protected_artifact_column" });
  }
  return {
    eligible: blocked.length === 0,
    reason: blocked.length ? PROTECTED_FEATURE_DECISION_BLOCK : null,
    blocked,
    featureSetId: set.featureSetId,
  };
}

export function assertDecisionEligible(args) {
  const verdict = evaluateDecisionEligibility(args);
  if (!verdict.eligible) {
    const detail = verdict.blocked.length ? verdict.blocked.map((b) => b.feature).join(", ") : verdict.reason;
    throw new ProtectedFeatureDecisionError(
      `${PROTECTED_FEATURE_DECISION_BLOCK}: feature set ${args?.featureSetId} cannot drive live decisions for ${args?.family} (${detail})`,
      verdict,
    );
  }
  return verdict;
}

/**
 * Experiment dimensions (target, arm treatment keys, assignment strata) may
 * not be protected_analysis_only material or any prohibited field.
 */
export function protectedExperimentDimensions(names = []) {
  const hits = [];
  for (const name of names) {
    const findings = classifySource(String(name)).findings;
    const finding = findings.find((f) => f.effect === "protected_analysis_only" || f.effect === "prohibited");
    if (finding) hits.push({ name, rule: finding.rule, effect: finding.effect });
  }
  return hits;
}
