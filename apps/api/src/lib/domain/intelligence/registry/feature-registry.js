/**
 * IC8 FEATURE REGISTRY (architecture §3.1, §3.2b, §3.3).
 *
 * The CODE is the source of truth; intelligence.feature_definitions /
 * feature_sets only mirror it. A feature is identified by key@version and its
 * definition_hash covers everything that changes what the value means:
 *   {key, version, scope, domain, valueType, pitClass, fairnessClass,
 *    statedFact, lineage, compute.toString()}
 * The arch §3.1 list plus `domain` (owner decision 2026-10-01) and
 * `statedFact`, which changes what a price family may read.
 * A changed hash under the same version is a hard failure: a redefinition
 * needs a new version.
 *
 * Every definition is fairness-linted at definition time; every feature set is
 * linted against its model family's policy (registry/prohibited.js).
 */

import { hashObject } from "../util/hash.js";
import { parseDurationMs } from "../util/time.js";
import {
  DEFAULT_FAMILY_POLICIES,
  FAIRNESS_CLASSES,
  FEATURE_DOMAINS,
  FairnessLintError,
  formatViolations,
  lintFeatureDefinition,
  lintFeatureSetForFamily,
} from "./prohibited.js";

export const FEATURE_SCOPES = Object.freeze([
  "seller",
  "property",
  "conversation",
  "message",
  "market",
  "campaign",
  "sender",
  "template",
  "buyer",
  "comp",
  "deal",
  "time",
]);
export const FEATURE_VALUE_TYPES = Object.freeze(["integer", "number", "boolean", "categorical"]);
export const FEATURE_MODES = Object.freeze(["online", "offline", "both"]);
export const PIT_CLASSES = Object.freeze(["event_time", "history_reconstructed", "static_fact", "decision_snapshot_only"]);
/** Feature-set purposes. Historical training sets may not contain decision_snapshot_only features. */
export const FEATURE_SET_PURPOSES = Object.freeze(["historical_training", "online"]);

const FEATURE_KEY_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const SET_NAME_RE = /^[a-z][a-z0-9_]*$/;

export class FeatureRegistryError extends Error {
  constructor(message, code = "FEATURE_REGISTRY") {
    super(message);
    this.name = "FeatureRegistryError";
    this.code = code;
  }
}

export function featureId(key, version) {
  return `${key}@${version}`;
}

/** "send.recipient_local_hour@1" -> { key, version } */
export function parseFeatureRef(ref) {
  if (ref && typeof ref === "object") return { key: String(ref.key), version: Number(ref.version) };
  const match = /^([a-z][a-z0-9_.]*)@([1-9][0-9]*)$/.exec(String(ref ?? ""));
  if (!match) throw new FeatureRegistryError(`invalid feature reference "${ref}"`, "INVALID_REFERENCE");
  return { key: match[1], version: Number(match[2]) };
}

export function featureDefinitionHash(spec) {
  return hashObject({
    key: spec.key,
    version: spec.version,
    scope: spec.scope,
    domain: spec.domain,
    valueType: spec.valueType,
    pitClass: spec.pitClass,
    fairnessClass: spec.fairnessClass,
    statedFact: spec.statedFact === true,
    lineage: spec.lineage,
    compute: String(spec.compute),
  });
}

function requireOneOf(problems, field, value, allowed) {
  if (!allowed.includes(value)) problems.push(`${field} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`);
}

/**
 * Validate, lint and freeze one feature definition. Throws on any problem:
 * an invalid feature can never be registered, so it can never be computed.
 */
export function defineFeature(spec = {}) {
  const problems = [];
  if (!FEATURE_KEY_RE.test(String(spec.key || ""))) problems.push("key must look like <scope>.<name> in snake_case");
  if (!Number.isInteger(spec.version) || spec.version < 1) problems.push("version must be a positive integer");
  requireOneOf(problems, "scope", spec.scope, FEATURE_SCOPES);
  requireOneOf(problems, "domain", spec.domain, FEATURE_DOMAINS);
  requireOneOf(problems, "valueType", spec.valueType, FEATURE_VALUE_TYPES);
  requireOneOf(problems, "mode", spec.mode, FEATURE_MODES);
  requireOneOf(problems, "pitClass", spec.pitClass, PIT_CLASSES);
  requireOneOf(problems, "fairnessClass", spec.fairnessClass, FAIRNESS_CLASSES);
  if (spec.fairnessTier !== undefined) problems.push("fairnessTier is retired: declare fairnessClass restricted_targeting / protected_analysis_only");
  if (spec.statedFact !== undefined && typeof spec.statedFact !== "boolean") problems.push("statedFact must be boolean");
  if (spec.statedFact === true && spec.domain !== "ownership_prospect") {
    problems.push("statedFact applies only to ownership_prospect features (seller-STATED facts)");
  }
  if (spec.pitClass === "decision_snapshot_only" && spec.mode !== "online") {
    problems.push("decision_snapshot_only features are online-only (never reconstructed for history)");
  }
  const lineage = spec.lineage;
  if (!lineage || typeof lineage !== "object") {
    problems.push("lineage is required");
  } else {
    if (!Array.isArray(lineage.sources) || lineage.sources.length === 0 || lineage.sources.some((s) => typeof s !== "string" || !s.trim())) {
      problems.push("lineage.sources must be a non-empty array of column references");
    }
    if (lineage.keys !== undefined && (!Array.isArray(lineage.keys) || lineage.keys.some((s) => typeof s !== "string"))) {
      problems.push("lineage.keys must be an array of column references");
    }
    if (typeof lineage.calc !== "string" || !lineage.calc.trim()) problems.push("lineage.calc must describe the calculation");
  }
  if (typeof spec.owner !== "string" || !spec.owner.trim()) problems.push("owner is required");
  if (spec.freshnessSla !== null && spec.freshnessSla !== undefined) {
    try {
      parseDurationMs(spec.freshnessSla);
    } catch {
      problems.push('freshnessSla must be null or a duration like "5m" / "24h"');
    }
  }
  if (typeof spec.compute !== "function") problems.push("compute must be a function");
  if (problems.length) {
    throw new FeatureRegistryError(`invalid feature ${spec.key}@${spec.version}: ${problems.join("; ")}`, "INVALID_FEATURE");
  }

  const normalized = {
    key: spec.key,
    version: spec.version,
    scope: spec.scope,
    domain: spec.domain,
    valueType: spec.valueType,
    mode: spec.mode,
    pitClass: spec.pitClass,
    fairnessClass: spec.fairnessClass,
    statedFact: spec.statedFact === true,
    lineage: deepFreeze(JSON.parse(JSON.stringify(lineage))),
    owner: spec.owner,
    freshnessSla: spec.freshnessSla ?? null,
    description: typeof spec.description === "string" ? spec.description : null,
    compute: spec.compute,
  };
  const violations = lintFeatureDefinition(normalized);
  if (violations.length) {
    throw new FairnessLintError(`fairness lint rejected ${featureId(spec.key, spec.version)}: ${formatViolations(violations)}`, violations);
  }
  return Object.freeze({
    ...normalized,
    id: featureId(normalized.key, normalized.version),
    definitionHash: featureDefinitionHash(normalized),
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Mirror row for intelligence.feature_definitions. */
export function toFeatureDefinitionRow(def, { status = "active" } = {}) {
  return {
    feature_key: def.key,
    version: def.version,
    scope: def.scope,
    domain: def.domain,
    value_type: def.valueType,
    mode: def.mode,
    pit_class: def.pitClass,
    fairness_class: def.fairnessClass,
    stated_fact: def.statedFact,
    source_lineage: def.lineage,
    owner: def.owner,
    freshness_sla: def.freshnessSla ? `${Math.round(parseDurationMs(def.freshnessSla) / 1000)} seconds` : null,
    definition_hash: def.definitionHash,
    status,
  };
}

export function featureSetHash({ featureSetId, purpose, members }) {
  return hashObject({
    feature_set_id: featureSetId,
    purpose,
    members: [...members]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((m) => ({ key: m.key, version: m.version, definition_hash: m.definitionHash })),
  });
}

/** Mirror row for intelligence.feature_sets. */
export function toFeatureSetRow(set) {
  return {
    feature_set_id: set.featureSetId,
    members: set.members.map((m) => ({ feature_key: m.key, version: m.version })),
    definition_hash: set.definitionHash,
    purpose: set.purpose,
    status: "active",
  };
}

/**
 * A registry instance. Tests build fresh ones; production code builds one
 * from the versioned definition modules (features/v1-features.js).
 */
export function createFeatureRegistry({ familyPolicies = DEFAULT_FAMILY_POLICIES } = {}) {
  const features = new Map();
  const sets = new Map();
  const policies = new Map(Object.entries(familyPolicies));

  function register(specOrDef) {
    const def = specOrDef && typeof specOrDef.definitionHash === "string" && Object.isFrozen(specOrDef) ? specOrDef : defineFeature(specOrDef);
    const existing = features.get(def.id);
    if (existing) {
      if (existing.definitionHash !== def.definitionHash) {
        throw new FeatureRegistryError(
          `${def.id} is already registered with a different definition_hash; a redefinition needs a new version`,
          "REDEFINITION",
        );
      }
      return existing;
    }
    features.set(def.id, def);
    return def;
  }

  function get(key, version) {
    const ref = version === undefined ? parseFeatureRef(key) : { key, version };
    const def = features.get(featureId(ref.key, ref.version));
    if (!def) throw new FeatureRegistryError(`unknown feature ${featureId(ref.key, ref.version)}`, "UNKNOWN_FEATURE");
    return def;
  }

  function lintMembersForFamily(memberDefs, family) {
    const policy = policies.get(family);
    if (!policy) return [{ violation: "family_policy_missing", family }];
    return lintFeatureSetForFamily(memberDefs, policy);
  }

  function defineSet({ name, version, members, purpose = "historical_training", family = null, description = null } = {}) {
    if (!SET_NAME_RE.test(String(name || ""))) throw new FeatureRegistryError("feature set name must be snake_case", "INVALID_SET");
    if (!Number.isInteger(version) || version < 1) throw new FeatureRegistryError("feature set version must be a positive integer", "INVALID_SET");
    if (!FEATURE_SET_PURPOSES.includes(purpose)) throw new FeatureRegistryError(`purpose must be one of ${FEATURE_SET_PURPOSES.join(", ")}`, "INVALID_SET");
    if (!Array.isArray(members) || members.length === 0) throw new FeatureRegistryError("a feature set needs members", "INVALID_SET");
    const featureSetId = `${name}@${version}`;
    const memberDefs = members.map((ref) => {
      const parsed = parseFeatureRef(ref);
      return get(parsed.key, parsed.version);
    });
    const keys = new Set();
    for (const def of memberDefs) {
      if (keys.has(def.key)) throw new FeatureRegistryError(`${featureSetId} lists ${def.key} twice`, "INVALID_SET");
      keys.add(def.key);
      if (purpose === "historical_training" && def.pitClass === "decision_snapshot_only") {
        throw new FeatureRegistryError(
          `${featureSetId}: ${def.id} is decision_snapshot_only and cannot be reconstructed for historical training`,
          "PIT_CLASS_NOT_HISTORICAL",
        );
      }
      if (purpose === "historical_training" && def.mode === "online") {
        throw new FeatureRegistryError(`${featureSetId}: ${def.id} is online-only`, "MODE_NOT_OFFLINE");
      }
    }
    if (family) {
      const violations = lintMembersForFamily(memberDefs, family);
      if (violations.length) {
        throw new FairnessLintError(`${featureSetId} violates the ${family} family policy: ${formatViolationsForSet(violations)}`, violations);
      }
    }
    const membersOut = memberDefs
      .map((def) => Object.freeze({ key: def.key, version: def.version, definitionHash: def.definitionHash, fairnessClass: def.fairnessClass }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const membersOfClass = (cls) =>
      Object.freeze(membersOut.filter((m) => m.fairnessClass === cls).map((m) => featureId(m.key, m.version)));
    const set = Object.freeze({
      featureSetId,
      name,
      version,
      purpose,
      family,
      description,
      members: Object.freeze(membersOut),
      restrictedMembers: membersOfClass("restricted_targeting"),
      protectedMembers: membersOfClass("protected_analysis_only"),
      conversationMembers: membersOfClass("conversation_only"),
      containsRestricted: membersOut.some((m) => m.fairnessClass === "restricted_targeting"),
      /** true = research/backtest only: the model registry refuses to promote models built on it. */
      containsProtected: membersOut.some((m) => m.fairnessClass === "protected_analysis_only"),
      definitionHash: featureSetHash({ featureSetId, purpose, members: membersOut }),
    });
    const existing = sets.get(featureSetId);
    if (existing && existing.definitionHash !== set.definitionHash) {
      throw new FeatureRegistryError(`${featureSetId} already exists with a different definition_hash`, "REDEFINITION");
    }
    sets.set(featureSetId, existing || set);
    return existing || set;
  }

  function getSet(featureSetId) {
    const set = sets.get(featureSetId);
    if (!set) throw new FeatureRegistryError(`unknown feature set ${featureSetId}`, "UNKNOWN_SET");
    return set;
  }

  function lintSetForFamily(featureSetId, family) {
    const set = getSet(featureSetId);
    return lintMembersForFamily(
      set.members.map((m) => get(m.key, m.version)),
      family,
    );
  }

  return Object.freeze({
    register,
    get,
    has: (key, version) => features.has(featureId(key, version)),
    list: () => [...features.values()].sort((a, b) => a.id.localeCompare(b.id)),
    defineSet,
    getSet,
    hasSet: (featureSetId) => sets.has(featureSetId),
    listSets: () => [...sets.values()].sort((a, b) => a.featureSetId.localeCompare(b.featureSetId)),
    familyPolicy: (family) => policies.get(family) || null,
    registerFamilyPolicy(policy) {
      if (!policy || !policy.family || !Object.isFrozen(policy)) {
        throw new FeatureRegistryError("registerFamilyPolicy expects a defineFamilyPolicy() result", "INVALID_POLICY");
      }
      policies.set(policy.family, policy);
      return policy;
    },
    lintSetForFamily,
    assertSetForFamily(featureSetId, family) {
      const violations = lintSetForFamily(featureSetId, family);
      if (violations.length) {
        throw new FairnessLintError(`${featureSetId} violates the ${family} family policy: ${formatViolationsForSet(violations)}`, violations);
      }
      return true;
    },
    toFeatureDefinitionRows: () => [...features.values()].sort((a, b) => a.id.localeCompare(b.id)).map((def) => toFeatureDefinitionRow(def)),
    toFeatureSetRows: () => [...sets.values()].map((set) => toFeatureSetRow(set)),
  });
}

function formatViolationsForSet(violations) {
  return violations.map((v) => `${v.feature ? `${v.feature}: ` : ""}${v.violation}${v.token ? ` (${v.token})` : ""}`).join("; ");
}
