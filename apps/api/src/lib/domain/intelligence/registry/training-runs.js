/**
 * IC8 TRAINING RUNS (architecture §2.9, §8).
 *
 *   - exclusivity: one training run per family at a time, through
 *     public.run_locks (inject the production withRunLock from
 *     domain/runs/run-locks.js; same signature);
 *   - idempotency: one live or successful run per (family, dataset sha256);
 *     a repeat records a `skipped_duplicate` row and trains nothing;
 *   - a failure writes a `failed` run row and NEVER touches any model status:
 *     the only registry call is registerVersion (status development), and it
 *     happens after training succeeded.
 */

import { toIso } from "../util/time.js";

export const TRAINING_TRIGGERS = Object.freeze(["manual", "schedule"]);
export const TRAINING_STATUSES = Object.freeze(["running", "succeeded", "failed", "skipped_duplicate"]);
const LIVE_STATUSES = Object.freeze(["running", "succeeded"]);

export function trainingIdempotencyKey(family, datasetSha256) {
  return `${family}:${datasetSha256}`;
}

function errorText(error) {
  return String(error?.message || error || "training failed").slice(0, 500);
}

/**
 * Run one training job.
 * @param request { family, trigger, datasetSnapshotId, datasetSha256, train, actor }
 *        train({ runId }) -> { metrics, version? }  (version = registerVersion args, optional)
 * @param deps    { store, withRunLock, modelRegistry, now, leaseMs }
 */
export async function runTraining(
  { family, trigger = "manual", datasetSnapshotId = null, datasetSha256, train, actor = "intelligence_training" } = {},
  { store, withRunLock, modelRegistry = null, now = () => Date.now(), leaseMs = 10 * 60_000 } = {},
) {
  if (!family || !/^[0-9a-f]{64}$/.test(String(datasetSha256 || ""))) {
    return { ok: false, code: "INVALID_REQUEST", message: "family and a sha256 dataset fingerprint are required" };
  }
  if (!TRAINING_TRIGGERS.includes(trigger)) return { ok: false, code: "INVALID_TRIGGER" };
  if (typeof train !== "function") return { ok: false, code: "TRAIN_FN_REQUIRED" };
  if (!store || typeof withRunLock !== "function") return { ok: false, code: "TRAINING_UNCONFIGURED" };
  const idempotencyKey = trainingIdempotencyKey(family, datasetSha256);

  return withRunLock({
    scope: `intelligence_training:${family}`,
    lease_ms: leaseMs,
    owner: actor,
    metadata: { family, dataset_sha256: datasetSha256 },
    onLocked: (lock) => ({ ok: true, skipped: true, reason: "run_locked", lock_reason: lock?.reason || null }),
    fn: async () => {
      const existing = await store.findTrainingRuns({ idempotencyKey, statuses: [...LIVE_STATUSES] });
      if (!existing.ok) return { ok: false, code: "STORE_ERROR", message: existing.error?.message };
      const base = {
        model_family: family,
        trigger,
        dataset_snapshot_id: datasetSnapshotId,
        idempotency_key: idempotencyKey,
        started_at: toIso(now()),
      };
      if ((existing.data || []).length) {
        await store.insertTrainingRun({ ...base, status: "skipped_duplicate", finished_at: toIso(now()) });
        return { ok: true, skipped: true, reason: "duplicate", existing_run_id: existing.data[0].run_id };
      }
      const inserted = await store.insertTrainingRun({ ...base, status: "running" });
      if (!inserted.ok || !inserted.data) {
        if (inserted.error?.code === "23505") {
          await store.insertTrainingRun({ ...base, status: "skipped_duplicate", finished_at: toIso(now()) });
          return { ok: true, skipped: true, reason: "duplicate" };
        }
        return { ok: false, code: "STORE_ERROR", message: inserted.error?.message };
      }
      const runId = inserted.data.run_id;
      let result;
      try {
        result = await train({ runId });
      } catch (error) {
        await store.updateTrainingRun(runId, { status: "failed", error: errorText(error), finished_at: toIso(now()) });
        return { ok: false, code: "TRAINING_FAILED", run_id: runId, error: errorText(error) };
      }
      let modelVersionId = null;
      if (result && result.version) {
        if (!modelRegistry) {
          await store.updateTrainingRun(runId, { status: "failed", error: "model registry unavailable", finished_at: toIso(now()) });
          return { ok: false, code: "REGISTRY_UNAVAILABLE", run_id: runId };
        }
        const registered = await modelRegistry.registerVersion({ family, datasetSnapshotId, ...result.version });
        if (!registered.ok) {
          await store.updateTrainingRun(runId, { status: "failed", error: `registration failed: ${registered.code}`, finished_at: toIso(now()) });
          return { ok: false, code: "REGISTRATION_FAILED", run_id: runId, registration: registered.code };
        }
        modelVersionId = registered.data?.model_version_id ?? null;
      }
      const finished = await store.updateTrainingRun(runId, {
        status: "succeeded",
        metrics: result?.metrics ?? {},
        model_version_id: modelVersionId,
        finished_at: toIso(now()),
      });
      if (!finished.ok) return { ok: false, code: "STORE_ERROR", run_id: runId, message: finished.error?.message };
      return { ok: true, run_id: runId, model_version_id: modelVersionId };
    },
  });
}
