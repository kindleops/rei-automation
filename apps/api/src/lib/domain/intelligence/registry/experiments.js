/**
 * IC8 EXPERIMENT REGISTRY (architecture §2.10).
 *
 *   - stable assignment: arm = f(sha256(salt : unit_type : unit_id)) against
 *     cumulative arm weights. Same experiment + unit -> same arm, every time;
 *     the first recorded assignment wins (upsert-ignore).
 *   - propensity (arm weight / total) is logged with every assignment, so
 *     off-policy evaluation is possible later.
 *   - prohibited targets: nothing that the deterministic rules own can be
 *     experimented on -- DNC/suppression/STOP, wrong number, contact windows,
 *     sender health, provider eligibility, caps, legal/compliance, stage /
 *     offer / closing authority, security, disclosures.
 *   - prohibited fields (identity, demographic composition, legacy scores)
 *     are never a target, arm dimension or stratum;
 *   - personal_attribute fields (gender, marital status, owner language, agent
 *     persona, age, income, education, occupation) may be arms or strata only
 *     for an experiment that declares a targeting_response family (owner
 *     decision 2026-10-01).
 *   - nothing activates an experiment in this phase (exploration share = 0);
 *     the registry exists so assignment is ready and auditable when allowed.
 */

import { createHash } from "node:crypto";

import { DEFAULT_FAMILY_POLICIES, PERSONAL_ATTRIBUTE_FAMILY_TYPES, classifySource } from "./prohibited.js";
import { toIso } from "../util/time.js";

export const ASSIGNMENT_VERSION = "ic8_assignment_sha256@1";
export const EXPERIMENT_STATUSES = Object.freeze(["draft", "running", "stopped", "completed"]);
export const PROHIBITED_EXPERIMENT_TARGETS = Object.freeze([
  "dnc",
  "suppression",
  "opt_out",
  "optout",
  "stop",
  "unsubscribe",
  "wrong_number",
  "wrong_person",
  "contact_window",
  "quiet_hours",
  "sender_health",
  "provider_eligibility",
  "send_authority",
  "daily_cap",
  "cap",
  "caps",
  "legal",
  "compliance",
  "tcpa",
  "consent",
  "stage_authority",
  "offer_authority",
  "offer_authorization",
  "closing_authority",
  "security",
  "auth",
  "disclosure",
  "disclosures",
]);

export class ExperimentPolicyError extends Error {
  constructor(message, code = "EXPERIMENT_POLICY") {
    super(message);
    this.name = "ExperimentPolicyError";
    this.code = code;
  }
}

const snake = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** True when a target names (or contains) a deterministic-authority domain. */
export function isProhibitedTarget(target) {
  const t = snake(target);
  if (!t) return true;
  const tokens = t.split("_");
  // multi-word terms match as a substring ("offer_authority_limits"); single words as a whole token
  return PROHIBITED_EXPERIMENT_TARGETS.some((p) => (p.includes("_") ? t.includes(p) : tokens.includes(p)));
}

/** Sensitive findings for experiment dimension names. */
export function classifyExperimentDimensions(names = []) {
  const out = [];
  for (const name of names) {
    const findings = classifySource(String(name)).findings;
    const prohibited = findings.find((f) => f.effect === "prohibited");
    const personal = findings.find((f) => f.effect === "personal_attribute");
    if (prohibited) out.push({ name, effect: "prohibited", rule: prohibited.rule });
    else if (personal) out.push({ name, effect: "personal_attribute", rule: personal.rule });
  }
  return out;
}

/**
 * Validate and freeze an experiment definition.
 * spec: { experimentId, hypothesis, target, family, unitType, arms: [{arm, weight, treatment}], strata,
 *         population, guardrails, metrics, salt }
 * options: { familyPolicies } (defaults to the code's DEFAULT_FAMILY_POLICIES)
 */
export function defineExperiment(spec = {}, { familyPolicies = DEFAULT_FAMILY_POLICIES } = {}) {
  const problems = [];
  const experimentId = String(spec.experimentId ?? "").trim();
  if (!/^[a-z][a-z0-9_]{2,80}$/.test(experimentId)) problems.push("experimentId must be snake_case");
  if (!String(spec.hypothesis ?? "").trim()) problems.push("hypothesis is required");
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(String(spec.unitType ?? ""))) problems.push("unitType is required (e.g. thread, property, campaign)");
  if (String(spec.salt ?? "").length < 8) problems.push("salt must be at least 8 characters");
  if (problems.length) throw new ExperimentPolicyError(`invalid experiment: ${problems.join("; ")}`, "INVALID_EXPERIMENT");

  if (isProhibitedTarget(spec.target)) {
    throw new ExperimentPolicyError(`experiment target "${spec.target}" belongs to a deterministic authority and can never be an experiment`, "PROHIBITED_TARGET");
  }
  const arms = Array.isArray(spec.arms) ? spec.arms : [];
  if (arms.length < 2) throw new ExperimentPolicyError("an experiment needs at least two arms", "INVALID_EXPERIMENT");
  const names = new Set();
  const normalizedArms = arms.map((a) => {
    const arm = String(a?.arm ?? "").trim();
    const weight = Number(a?.weight);
    if (!/^[a-z0-9][a-z0-9_]{0,59}$/i.test(arm) || names.has(arm)) throw new ExperimentPolicyError(`arm names must be unique identifiers (${arm})`, "INVALID_EXPERIMENT");
    if (!(weight > 0) || !Number.isFinite(weight)) throw new ExperimentPolicyError(`arm ${arm} needs a positive weight`, "INVALID_EXPERIMENT");
    names.add(arm);
    const treatment = a.treatment && typeof a.treatment === "object" ? JSON.parse(JSON.stringify(a.treatment)) : {};
    return { arm, weight, treatment };
  });
  const strata = Array.isArray(spec.strata) ? spec.strata.map(String) : [];
  const dimensions = [
    String(spec.target),
    ...normalizedArms.flatMap((a) => Object.keys(a.treatment)),
    ...normalizedArms.flatMap((a) => Object.values(a.treatment).filter((v) => typeof v === "string")),
    ...strata,
    ...Object.keys(spec.population && typeof spec.population === "object" ? spec.population : {}),
  ];
  const sensitive = classifyExperimentDimensions(dimensions);
  const prohibited = sensitive.filter((h) => h.effect === "prohibited");
  if (prohibited.length) {
    throw new ExperimentPolicyError(`experiments may never use ${prohibited.map((h) => h.name).join(", ")}`, "PROHIBITED_DIMENSION");
  }
  const personal = sensitive.filter((h) => h.effect === "personal_attribute");
  const policy = spec.family ? familyPolicies[spec.family] : null;
  if (spec.family && !policy) throw new ExperimentPolicyError(`unknown family ${spec.family}`, "UNKNOWN_FAMILY");
  if (personal.length && !(policy && PERSONAL_ATTRIBUTE_FAMILY_TYPES.includes(policy.familyType))) {
    throw new ExperimentPolicyError(
      `personal_attribute dimensions (${personal.map((h) => h.name).join(", ")}) need an experiment declared for a targeting_response family`,
      "PERSONAL_ATTRIBUTE_NOT_ALLOWED_FOR_FAMILY",
    );
  }
  const totalWeight = normalizedArms.reduce((sum, a) => sum + a.weight, 0);
  return Object.freeze({
    experiment_id: experimentId,
    hypothesis: String(spec.hypothesis).trim(),
    target: snake(spec.target),
    family: spec.family || null,
    unit_type: spec.unitType,
    arms: Object.freeze(normalizedArms.map((a) => Object.freeze({ ...a, propensity: a.weight / totalWeight }))),
    allocation: Object.freeze({ method: ASSIGNMENT_VERSION, total_weight: totalWeight }),
    strata: Object.freeze(strata),
    population: spec.population ?? {},
    guardrails: spec.guardrails ?? {},
    metrics: spec.metrics ?? {},
    status: "draft",
    salt: String(spec.salt),
  });
}

/** Uniform [0, 1) bucket from sha256(salt:unitType:unitId) (52-bit precision). */
export function assignmentBucket(salt, unitType, unitId) {
  const hex = createHash("sha256").update(`${salt}:${unitType}:${unitId}`).digest("hex").slice(0, 13);
  return parseInt(hex, 16) / 2 ** 52;
}

/**
 * Stable arm for one unit. `strata` (optional) are recorded for analysis and
 * must be declared on the experiment; they never change the arm.
 */
export function assignUnit(experiment, unitId, { strata = null } = {}) {
  if (!experiment || !Array.isArray(experiment.arms)) throw new ExperimentPolicyError("assignUnit needs a defined experiment", "INVALID_EXPERIMENT");
  const id = String(unitId ?? "").trim();
  if (!id) throw new ExperimentPolicyError("unit id is required", "INVALID_UNIT");
  if (strata) {
    for (const key of Object.keys(strata)) {
      if (!experiment.strata.includes(key)) throw new ExperimentPolicyError(`stratum ${key} is not declared on ${experiment.experiment_id}`, "UNDECLARED_STRATUM");
    }
  }
  const bucket = assignmentBucket(experiment.salt, experiment.unit_type, id);
  let cumulative = 0;
  const total = experiment.allocation.total_weight;
  let chosen = experiment.arms[experiment.arms.length - 1];
  for (const arm of experiment.arms) {
    cumulative += arm.weight / total;
    if (bucket < cumulative) {
      chosen = arm;
      break;
    }
  }
  return {
    experiment_id: experiment.experiment_id,
    unit_type: experiment.unit_type,
    unit_id: id,
    arm: chosen.arm,
    propensity: chosen.weight / total,
    bucket,
    assignment_version: ASSIGNMENT_VERSION,
    strata: strata ? { ...strata } : null,
  };
}

/** Rows for intelligence.experiments / experiment_assignments. */
export function toExperimentRow(experiment) {
  return {
    experiment_id: experiment.experiment_id,
    hypothesis: experiment.hypothesis,
    target: experiment.target,
    family: experiment.family,
    population: experiment.population,
    unit_type: experiment.unit_type,
    arms: experiment.arms,
    allocation: experiment.allocation,
    guardrails: experiment.guardrails,
    metrics: experiment.metrics,
    strata: experiment.strata,
    status: experiment.status,
    salt: experiment.salt,
  };
}

export function toAssignmentRow(assignment, { now = () => Date.now() } = {}) {
  return {
    experiment_id: assignment.experiment_id,
    unit_type: assignment.unit_type,
    unit_id: assignment.unit_id,
    arm: assignment.arm,
    propensity: assignment.propensity,
    assigned_at: toIso(now()),
  };
}

/** Record (first assignment wins) and return the stored arm. */
export async function recordAssignment(store, assignment, { now } = {}) {
  const inserted = await store.insertAssignment(toAssignmentRow(assignment, { now }));
  if (!inserted.ok) return { ok: false, code: "STORE_ERROR", message: inserted.error?.message };
  const stored = await store.getAssignment({ experimentId: assignment.experiment_id, unitType: assignment.unit_type, unitId: assignment.unit_id });
  if (!stored.ok || !stored.data) return { ok: false, code: "STORE_ERROR", message: stored.error?.message || "assignment not readable" };
  return { ok: true, arm: stored.data.arm, propensity: Number(stored.data.propensity), assigned_at: stored.data.assigned_at };
}
