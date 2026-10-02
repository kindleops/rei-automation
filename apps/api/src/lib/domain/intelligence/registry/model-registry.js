/**
 * IC8 MODEL REGISTRY (architecture §8), over the store.
 *
 *   - registerVersion: always starts in `development`; artifacts inline only
 *     up to 100 KB (sha256 recorded); the feature set must satisfy the
 *     family's fairness policy.
 *   - transition: an explicit allowed-transition matrix; `retired` is
 *     terminal except through rollbackChampion. A gate report (all documented
 *     gates passed) and a model card are required for -> challenger/champion.
 *     Shadow/challenger/champion are DECISION statuses: the feature set must
 *     resolve in the code registry and satisfy the family policy, the
 *     artifact may carry no prohibited column, and a model that uses any
 *     personal_attribute input must present a valid fairness report
 *     (fairness/group-audit.js) -- owner decision 2026-10-01.
 *   - one champion per family: promoting a champion retires the current one
 *     (the DB backs this with a partial unique index); the event records the
 *     previous champion so rollbackChampion restores it in one call.
 *   - every transition writes an append-only model_status_events row.
 *
 * Without database transactions (PostgREST), a multi-row transition is
 * ordered so a failure leaves the family with at most the old champion or no
 * champion -- never two -- and compensates the earlier step when a later one
 * fails. No champion means the policy engine uses the deterministic default.
 */

import { validateFairnessReport } from "../fairness/group-audit.js";
import { classifySource } from "./prohibited.js";
import { hashObject, stableStringify } from "../util/hash.js";
import { toIso } from "../util/time.js";

export const MODEL_STATUSES = Object.freeze(["development", "backtest", "shadow", "challenger", "champion", "retired"]);
export const ALLOWED_TRANSITIONS = Object.freeze({
  development: Object.freeze(["backtest", "retired"]),
  backtest: Object.freeze(["development", "shadow", "retired"]),
  shadow: Object.freeze(["backtest", "challenger", "retired"]),
  challenger: Object.freeze(["shadow", "champion", "retired"]),
  champion: Object.freeze(["challenger", "retired"]),
  retired: Object.freeze([]),
});
export const GATED_STATUSES = Object.freeze(["challenger", "champion"]);
/** Statuses that drive (or shadow) live decisions. */
export const DECISION_STATUSES = Object.freeze(["shadow", "challenger", "champion"]);
/** Promotion gates (architecture §8); each must be present and passed in the gate report. */
export const REQUIRED_GATES = Object.freeze([
  "target_metric",
  "safety_non_inferiority",
  "min_sample",
  "calibration_ece",
  "segment_regression",
  "fairness_checklist",
  "guardrail_tests",
]);
export const MODEL_CARD_FIELDS = Object.freeze(["purpose", "data", "metrics", "limitations", "prohibited_uses", "status"]);
export const INLINE_ARTIFACT_MAX_BYTES = 100 * 1024;

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

export function validateGateReport(report) {
  const problems = [];
  if (!report || typeof report !== "object") return { ok: false, problems: ["gate report required"] };
  if (report.passed !== true) problems.push("gate report not passed");
  if (!report.thresholds || typeof report.thresholds !== "object") problems.push("thresholds object required");
  const gates = report.gates && typeof report.gates === "object" ? report.gates : {};
  for (const gate of REQUIRED_GATES) {
    const entry = gates[gate];
    if (!entry || typeof entry !== "object") problems.push(`gate ${gate} missing`);
    else if (entry.passed !== true) problems.push(`gate ${gate} not passed`);
  }
  return { ok: problems.length === 0, problems };
}

export function validateModelCard(card) {
  if (!card || typeof card !== "object") return { ok: false, problems: ["model card required"] };
  const problems = MODEL_CARD_FIELDS.filter((field) => card[field] === undefined || card[field] === null || card[field] === "").map((f) => `model card missing ${f}`);
  return { ok: problems.length === 0, problems };
}

/**
 * deps: { store, featureRegistry (code feature registry; required for decision
 * statuses), now }
 */
/**
 * Fairness facts about a model version: does its feature set resolve, does it
 * (or its artifact) use personal_attribute inputs, does the artifact carry a
 * prohibited column. Fails closed when the set cannot be resolved.
 */
export function modelFairnessProfile(version, featureRegistry) {
  const names = Array.isArray(version?.artifact?.feature_names) ? version.artifact.feature_names : [];
  const findings = names.flatMap((name) => classifySource(String(name).split("=")[0].replace(/__missing__$/, "")).findings);
  const prohibitedColumns = [...new Set(findings.filter((f) => f.effect === "prohibited").map((f) => f.source))];
  if (!featureRegistry || typeof featureRegistry.hasSet !== "function" || !featureRegistry.hasSet(version?.feature_set_id)) {
    return { resolved: false, usesPersonal: null, prohibitedColumns };
  }
  const set = featureRegistry.getSet(version.feature_set_id);
  const usesPersonal = set.containsPersonal || findings.some((f) => f.effect === "personal_attribute");
  return { resolved: true, usesPersonal, prohibitedColumns, set };
}

export function createModelRegistry({ store, featureRegistry = null, now = () => Date.now() } = {}) {
  if (!store) throw new TypeError("createModelRegistry needs a store");

  async function writeEvent({ version, from, to, actor, reason, gateReport = null, metadata = {} }) {
    return store.insertModelStatusEvent({
      model_version_id: version.model_version_id,
      model_family: version.model_family,
      from_status: from,
      to_status: to,
      actor,
      reason,
      gate_report: gateReport,
      metadata,
      at: toIso(now()),
    });
  }

  function decisionGuard(version, fairnessReport) {
    const profile = modelFairnessProfile(version, featureRegistry);
    if (profile.prohibitedColumns.length) {
      return fail("PROHIBITED_FEATURE", `artifact of ${version.model_version_id} carries prohibited columns`, { columns: profile.prohibitedColumns });
    }
    if (!profile.resolved) return fail("FEATURE_SET_UNVERIFIED", `feature set ${version.feature_set_id} does not resolve in the code registry`);
    if (featureRegistry.familyPolicy(version.model_family)) {
      const violations = featureRegistry.lintSetForFamily(version.feature_set_id, version.model_family);
      if (violations.length) return fail("FAIRNESS_POLICY_VIOLATION", `${version.feature_set_id} violates the ${version.model_family} policy`, { violations });
    } else {
      return fail("FAMILY_POLICY_MISSING", `no fairness policy is defined for ${version.model_family}`);
    }
    if (profile.usesPersonal) {
      if (!fairnessReport) return fail("FAIRNESS_REPORT_REQUIRED", "models with personal_attribute inputs ship a fairness report to be promoted");
      const checked = validateFairnessReport(fairnessReport, { modelVersionId: version.model_version_id });
      if (!checked.ok) return fail("FAIRNESS_REPORT_INVALID", checked.problems.join("; "), { problems: checked.problems });
    }
    return null;
  }

  async function registerFamily({ family, purpose, target, prohibitedUses = [], owner } = {}) {
    if (!/^[a-z][a-z0-9_]*$/.test(String(family || ""))) return fail("INVALID_FAMILY", "family must be snake_case");
    if (!purpose || !target || !owner) return fail("INVALID_FAMILY", "purpose, target and owner are required");
    return store.upsertModelFamily({ model_family: family, purpose, target, prohibited_uses: prohibitedUses, owner });
  }

  async function registerVersion({
    family,
    version,
    datasetSnapshotId = null,
    featureSetId,
    trainingWindow = null,
    codeCommit,
    params = {},
    metrics = {},
    baselineMetrics = {},
    artifact = null,
    artifactUri = null,
    artifactSha256 = null,
    modelCard = null,
  } = {}) {
    if (!family || !version || !featureSetId || !codeCommit) return fail("INVALID_VERSION", "family, version, featureSetId and codeCommit are required");
    if (featureRegistry) {
      if (!featureRegistry.hasSet(featureSetId)) return fail("UNKNOWN_FEATURE_SET", `feature set ${featureSetId} is not registered in code`);
      if (featureRegistry.familyPolicy(family)) {
        const violations = featureRegistry.lintSetForFamily(featureSetId, family);
        if (violations.length) return fail("FAIRNESS_POLICY_VIOLATION", `${featureSetId} violates the ${family} policy`, { violations });
      }
    }
    let sha = artifactSha256;
    if (artifact !== null) {
      const bytes = Buffer.byteLength(stableStringify(artifact) ?? "null");
      if (bytes > INLINE_ARTIFACT_MAX_BYTES) return fail("ARTIFACT_TOO_LARGE", `inline artifact is ${bytes} bytes; store it privately and pass artifactUri`);
      const computed = hashObject(artifact);
      if (sha && sha !== computed) return fail("ARTIFACT_SHA_MISMATCH", "artifactSha256 does not match the inline artifact");
      sha = computed;
    } else if (!artifactUri) {
      return fail("ARTIFACT_REQUIRED", "an inline artifact or an artifactUri is required");
    }
    return store.insertModelVersion({
      model_family: family,
      version: String(version),
      status: "development",
      dataset_snapshot_id: datasetSnapshotId,
      feature_set_id: featureSetId,
      training_window: trainingWindow,
      code_commit: codeCommit,
      params,
      metrics,
      baseline_metrics: baselineMetrics,
      artifact,
      artifact_uri: artifactUri,
      artifact_sha256: sha || null,
      model_card: modelCard,
    });
  }

  async function transition({ modelVersionId, toStatus, actor, reason, gateReport = null, fairnessReport = null } = {}) {
    if (!MODEL_STATUSES.includes(toStatus)) return fail("UNKNOWN_STATUS", `unknown status ${toStatus}`);
    if (!String(actor ?? "").trim()) return fail("ACTOR_REQUIRED", "every transition needs an actor");
    if (!String(reason ?? "").trim()) return fail("REASON_REQUIRED", "every transition needs a reason");
    const loaded = await store.getModelVersion(modelVersionId);
    if (!loaded.ok) return fail("STORE_ERROR", loaded.error?.message);
    const version = loaded.data;
    if (!version) return fail("NOT_FOUND", `model version ${modelVersionId} not found`);
    const from = version.status;
    if (from === toStatus) return fail("NO_OP", `already ${from}`);
    if (!ALLOWED_TRANSITIONS[from]?.includes(toStatus)) return fail("TRANSITION_NOT_ALLOWED", `${from} -> ${toStatus} is not allowed`);
    if (DECISION_STATUSES.includes(toStatus)) {
      const blocked = decisionGuard(version, fairnessReport);
      if (blocked) return blocked;
    }
    if (GATED_STATUSES.includes(toStatus)) {
      if (!gateReport) return fail("GATE_REPORT_REQUIRED", `-> ${toStatus} requires a gate report`);
      const gates = validateGateReport(gateReport);
      if (!gates.ok) return fail("GATE_REPORT_FAILED", gates.problems.join("; "), { problems: gates.problems });
      const card = validateModelCard(version.model_card);
      if (!card.ok) return fail("MODEL_CARD_REQUIRED", card.problems.join("; "));
    }

    const at = toIso(now());
    if (toStatus === "champion") {
      const current = await store.getChampion(version.model_family);
      if (!current.ok) return fail("STORE_ERROR", current.error?.message);
      const previous = current.data && current.data.model_version_id !== version.model_version_id ? current.data : null;
      if (previous) {
        const demoted = await store.updateModelVersionStatus(previous.model_version_id, "champion", { status: "retired", retired_at: at });
        if (!demoted.ok || !demoted.data?.length) return fail("CONCURRENT_CHANGE", "the current champion changed while promoting");
      }
      const promoted = await store.updateModelVersionStatus(version.model_version_id, from, { status: "champion", promoted_at: at });
      if (!promoted.ok || !promoted.data?.length) {
        if (previous) await store.updateModelVersionStatus(previous.model_version_id, "retired", { status: "champion", retired_at: null });
        return fail("CONCURRENT_CHANGE", `${version.model_version_id} changed while promoting; previous champion restored`);
      }
      const events = [];
      if (previous) {
        events.push(
          await writeEvent({
            version: previous,
            from: "champion",
            to: "retired",
            actor,
            reason: `superseded: ${reason}`,
            metadata: { superseded_by: version.model_version_id },
          }),
        );
      }
      events.push(
        await writeEvent({
          version,
          from,
          to: "champion",
          actor,
          reason,
          gateReport,
          metadata: { previous_champion_id: previous ? previous.model_version_id : null, fairness_report: fairnessReport },
        }),
      );
      if (events.some((e) => !e.ok)) return fail("AUDIT_WRITE_FAILED", "champion changed but a status event could not be written", { state_changed: true });
      return { ok: true, model_version_id: version.model_version_id, from, to: "champion", previous_champion_id: previous ? previous.model_version_id : null };
    }

    const patch = { status: toStatus };
    if (toStatus === "retired") patch.retired_at = at;
    if (toStatus === "challenger" || toStatus === "shadow") patch.promoted_at = at;
    const updated = await store.updateModelVersionStatus(version.model_version_id, from, patch);
    if (!updated.ok || !updated.data?.length) return fail("CONCURRENT_CHANGE", `${version.model_version_id} changed during the transition`);
    const event = await writeEvent({ version, from, to: toStatus, actor, reason, gateReport, metadata: fairnessReport ? { fairness_report: fairnessReport } : {} });
    if (!event.ok) return fail("AUDIT_WRITE_FAILED", "status changed but its event could not be written", { state_changed: true });
    return { ok: true, model_version_id: version.model_version_id, from, to: toStatus };
  }

  /** Restore the previous champion of a family in one call (audited). */
  async function rollbackChampion(family, actor, reason) {
    if (!String(actor ?? "").trim()) return fail("ACTOR_REQUIRED", "rollback needs an actor");
    if (!String(reason ?? "").trim()) return fail("REASON_REQUIRED", "rollback needs a reason");
    const current = await store.getChampion(family);
    if (!current.ok) return fail("STORE_ERROR", current.error?.message);
    if (!current.data) return fail("NO_CHAMPION", `${family} has no champion to roll back`);
    const champion = current.data;
    const events = await store.listModelStatusEvents(family);
    if (!events.ok) return fail("STORE_ERROR", events.error?.message);
    const promotions = (events.data || []).filter((e) => e.to_status === "champion");
    // A version that was itself rolled back is never restored automatically.
    const rolledBack = new Set((events.data || []).filter((e) => e.to_status === "retired" && e.metadata?.rollback === true).map((e) => e.model_version_id));
    const latestForCurrent = promotions.find((e) => e.model_version_id === champion.model_version_id);
    let previousId = latestForCurrent ? latestForCurrent.metadata?.previous_champion_id || null : null;
    if (!latestForCurrent) previousId = promotions.find((e) => e.model_version_id !== champion.model_version_id)?.model_version_id || null;
    if (previousId && rolledBack.has(previousId)) previousId = null;

    let previous = null;
    if (previousId) {
      const loaded = await store.getModelVersion(previousId);
      if (!loaded.ok) return fail("STORE_ERROR", loaded.error?.message);
      previous = loaded.data && loaded.data.status === "retired" ? loaded.data : null;
    }
    if (previous) {
      const profile = modelFairnessProfile(previous, featureRegistry);
      if (!profile.resolved || profile.prohibitedColumns.length) {
        return fail("FEATURE_SET_UNVERIFIED", `previous champion ${previous.model_version_id} cannot be verified; nothing changed`);
      }
    }
    const at = toIso(now());
    const retired = await store.updateModelVersionStatus(champion.model_version_id, "champion", { status: "retired", retired_at: at });
    if (!retired.ok || !retired.data?.length) return fail("CONCURRENT_CHANGE", "the champion changed during rollback");
    if (previous) {
      const restored = await store.updateModelVersionStatus(previous.model_version_id, "retired", { status: "champion", promoted_at: at, retired_at: null });
      if (!restored.ok || !restored.data?.length) {
        await store.updateModelVersionStatus(champion.model_version_id, "retired", { status: "champion", retired_at: null });
        return fail("CONCURRENT_CHANGE", "could not restore the previous champion; the current champion was kept");
      }
    }
    const written = [
      await writeEvent({
        version: champion,
        from: "champion",
        to: "retired",
        actor,
        reason: `rollback: ${reason}`,
        metadata: { rollback: true, restored: previous ? previous.model_version_id : null },
      }),
    ];
    if (previous) {
      written.push(
        await writeEvent({
          version: previous,
          from: "retired",
          to: "champion",
          actor,
          reason: `rollback: ${reason}`,
          gateReport: { rollback: true, restores_promotion_event: promotions.find((e) => e.model_version_id === previous.model_version_id)?.event_id || null },
          metadata: {
            rollback: true,
            replaced: champion.model_version_id,
            // the chain continues from the restored version's own predecessor
            previous_champion_id: promotions.find((e) => e.model_version_id === previous.model_version_id)?.metadata?.previous_champion_id || null,
          },
        }),
      );
    }
    if (written.some((e) => !e.ok)) return fail("AUDIT_WRITE_FAILED", "rollback applied but a status event could not be written", { state_changed: true });
    return {
      ok: true,
      family,
      retired: champion.model_version_id,
      restored: previous ? previous.model_version_id : null,
      code: previous ? "ROLLED_BACK" : "NO_PREVIOUS_CHAMPION_DETERMINISTIC_DEFAULT",
    };
  }

  return Object.freeze({
    registerFamily,
    registerVersion,
    transition,
    rollbackChampion,
    getChampion: (family) => store.getChampion(family),
  });
}
