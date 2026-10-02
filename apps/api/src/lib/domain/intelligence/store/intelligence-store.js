/**
 * IC8 STORE -- the only module that talks to Supabase (architecture §1).
 *
 * Reads and writes the `intelligence` schema through an INJECTED service-role
 * supabase-js client (`client.schema("intelligence").from(...)`). Deployment
 * prerequisite: `intelligence` must be in the API's exposed schemas; anon and
 * authenticated hold no privilege on it (see the PROPOSED migration).
 *
 * Contract: no method ever throws. Every method resolves
 *   { ok: true, data } | { ok: false, error: { code, message } }
 * Fail-open callers (journal, corrections) count the error and move on;
 * fail-closed callers (model registry, toggles) stop on ok:false.
 */

import { settleWithin } from "../util/async.js";

export const INTELLIGENCE_SCHEMA = "intelligence";

function normalizeError(error) {
  if (!error) return { code: "UNKNOWN", message: "unknown store error" };
  return {
    code: String(error.code || error.name || "STORE_ERROR"),
    message: String(error.message || error).slice(0, 500),
  };
}

export function createIntelligenceStore({ client, schema = INTELLIGENCE_SCHEMA, timeoutMs = null } = {}) {
  async function run(build) {
    if (!client || typeof client.schema !== "function") {
      return { ok: false, error: { code: "STORE_UNCONFIGURED", message: "no service-role client with schema() support was injected" } };
    }
    const exec = () => build(client.schema(schema));
    let outcome;
    if (timeoutMs) {
      outcome = await settleWithin(exec, timeoutMs);
    } else {
      try {
        outcome = { value: await exec() };
      } catch (error) {
        outcome = { error };
      }
    }
    if (outcome.timedOut) return { ok: false, error: { code: "STORE_TIMEOUT", message: `store call exceeded ${timeoutMs} ms` } };
    if (outcome.error) return { ok: false, error: normalizeError(outcome.error) };
    const result = outcome.value;
    if (result && result.error) return { ok: false, error: normalizeError(result.error) };
    return { ok: true, data: result ? (result.data ?? null) : null };
  }

  const table = (db, name) => db.from(name);

  return Object.freeze({
    schema,

    // ── decision journal (append-only; retries upsert-ignore) ──
    insertDecisions: (rows) =>
      run((db) => table(db, "decision_journal").upsert(rows, { onConflict: "decision_id", ignoreDuplicates: true })),

    // ── features ──
    upsertFeatureDefinitions: (rows) =>
      run((db) => table(db, "feature_definitions").upsert(rows, { onConflict: "feature_key,version", ignoreDuplicates: true })),
    getFeatureDefinitions: () => run((db) => table(db, "feature_definitions").select("*")),
    upsertFeatureSets: (rows) => run((db) => table(db, "feature_sets").upsert(rows, { onConflict: "feature_set_id", ignoreDuplicates: true })),
    insertFeatureSnapshot: (row) => run((db) => table(db, "feature_snapshots").insert(row).select("snapshot_id").maybeSingle()),

    // ── outcomes (the one mutable label table) ──
    upsertOutcomeDefinitions: (rows) =>
      run((db) => table(db, "outcome_definitions").upsert(rows, { onConflict: "outcome_key,version", ignoreDuplicates: true })),
    upsertOutcomes: (rows) =>
      run((db) => table(db, "outcomes").upsert(rows, { onConflict: "outcome_key,outcome_version,subject_type,subject_id" })),

    // ── corrections (append-only; idempotent by idempotency_key) ──
    insertCorrection: (row) => run((db) => table(db, "corrections").upsert(row, { onConflict: "idempotency_key", ignoreDuplicates: true })),
    listCorrections: ({ subjectType, subjectId }) =>
      run((db) =>
        table(db, "corrections").select("*").eq("subject_type", subjectType).eq("subject_id", String(subjectId)).order("corrected_at", { ascending: true }),
      ),

    // ── datasets ──
    insertDatasetSnapshot: (row) => run((db) => table(db, "dataset_snapshots").upsert(row, { onConflict: "dataset_id", ignoreDuplicates: true })),
    getDatasetSnapshot: (datasetId) => run((db) => table(db, "dataset_snapshots").select("*").eq("dataset_id", datasetId).maybeSingle()),

    // ── models ──
    upsertModelFamily: (row) => run((db) => table(db, "models").upsert(row, { onConflict: "model_family" })),
    getModelFamily: (family) => run((db) => table(db, "models").select("*").eq("model_family", family).maybeSingle()),
    insertModelVersion: (row) => run((db) => table(db, "model_versions").insert(row).select("*").maybeSingle()),
    getModelVersion: (modelVersionId) =>
      run((db) => table(db, "model_versions").select("*").eq("model_version_id", modelVersionId).maybeSingle()),
    listModelVersions: (family) =>
      run((db) => table(db, "model_versions").select("*").eq("model_family", family).order("created_at", { ascending: true })),
    getChampion: (family) =>
      run((db) => table(db, "model_versions").select("*").eq("model_family", family).eq("status", "champion").maybeSingle()),
    /** Optimistic status update: only rows still in `fromStatus` change. data = updated rows. */
    updateModelVersionStatus: (modelVersionId, fromStatus, patch) =>
      run((db) =>
        table(db, "model_versions").update(patch).eq("model_version_id", modelVersionId).eq("status", fromStatus).select("*"),
      ),
    insertModelStatusEvent: (row) => run((db) => table(db, "model_status_events").insert(row).select("*").maybeSingle()),
    listModelStatusEvents: (family) =>
      run((db) => table(db, "model_status_events").select("*").eq("model_family", family).order("at", { ascending: false })),

    // ── training runs ──
    insertTrainingRun: (row) => run((db) => table(db, "training_runs").insert(row).select("*").maybeSingle()),
    updateTrainingRun: (runId, patch) => run((db) => table(db, "training_runs").update(patch).eq("run_id", runId).select("*")),
    findTrainingRuns: ({ idempotencyKey, statuses }) =>
      run((db) => table(db, "training_runs").select("*").eq("idempotency_key", idempotencyKey).in("status", statuses)),

    // ── experiments ──
    upsertExperiment: (row) => run((db) => table(db, "experiments").upsert(row, { onConflict: "experiment_id" })),
    getExperiment: (experimentId) => run((db) => table(db, "experiments").select("*").eq("experiment_id", experimentId).maybeSingle()),
    insertAssignment: (row) =>
      run((db) =>
        table(db, "experiment_assignments").upsert(row, { onConflict: "experiment_id,unit_type,unit_id", ignoreDuplicates: true }),
      ),
    getAssignment: ({ experimentId, unitType, unitId }) =>
      run((db) =>
        table(db, "experiment_assignments")
          .select("*")
          .eq("experiment_id", experimentId)
          .eq("unit_type", unitType)
          .eq("unit_id", String(unitId))
          .maybeSingle(),
      ),

    // ── policy versions, monitoring, control audit, envelopes ──
    upsertPolicyVersion: (row) => run((db) => table(db, "policy_versions").upsert(row, { onConflict: "policy_key,version", ignoreDuplicates: true })),
    insertMonitorMetrics: (rows) => run((db) => table(db, "monitor_metrics").insert(rows)),
    insertControlAudit: (row) => run((db) => table(db, "control_audit").insert(row)),
  });
}
