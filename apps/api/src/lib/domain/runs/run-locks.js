/**
 * Coarse, runner-level run locks.
 *
 * DURABILITY (changed): the authoritative lock state now lives in the
 * `public.run_locks` table, not in /tmp. Acquisition, heartbeat and release are
 * each a single atomic SQL function call; nothing is decided by a
 * read-modify-write in this file. See
 * supabase/migrations/20260831000000_durable_run_locks_and_idempotency_ledger.sql
 *
 * SCOPE (unchanged): this is a coarse guard that keeps two *runners* of the
 * same job from overlapping. It is NOT the per-send concurrency authority -
 * that remains `queue_atomic_claim_send_row` plus FOR UPDATE SKIP LOCKED at the
 * `send_queue` row level, which is untouched by this module.
 *
 * PUBLIC CONTRACT: acquireRunLock / releaseRunLock / withRunLock /
 * forceReleaseStaleLock keep their existing signatures and result shapes, so no
 * caller had to change. `heartbeatRunLock` is new and additive.
 */

import crypto from "node:crypto";

import {
  getDurableBackend,
  __resetDurableMemoryState,
} from "@/lib/domain/runtime/durable-state-backend.js";
import { warn } from "@/lib/logging/logger.js";

const RUN_LOCK_LOGGER_KEY = "domain.runs.run_locks";
const RUN_LOCK_NAMESPACE = "run-locks";

const defaultDeps = {
  getDurableBackend,
  warn,
};

let runtimeDeps = { ...defaultDeps };

function clean(value) {
  return String(value ?? "").trim();
}

function buildRunLockRecordId(scope = "") {
  return `${RUN_LOCK_NAMESPACE}:${clean(scope)}`;
}

function backend() {
  return (runtimeDeps.getDurableBackend || getDurableBackend)();
}

export function __setRunLockTestDeps(overrides = {}) {
  runtimeDeps = { ...runtimeDeps, ...overrides };
}

export function __resetRunLockTestDeps() {
  runtimeDeps = { ...defaultDeps };
  __resetDurableMemoryState();
}

/**
 * Acquire a lock, or report that a live holder already has it.
 *
 * Steals the lock ONLY when the existing lease has expired (reason
 * `stale_lock_reclaimed`). A live lease is never stolen.
 *
 * Backend failures fail SOFT here on purpose: a cron that cannot reach the lock
 * table skips this tick and retries on the next one. Failing hard would turn a
 * transient database blip into a crashed runner, and skipping is always safe
 * because no work has started yet.
 */
export async function acquireRunLock({
  scope,
  lease_ms = 10 * 60_000,
  owner = null,
  metadata = {},
} = {}) {
  const normalized_scope = clean(scope);
  if (!normalized_scope) {
    return {
      ok: false,
      acquired: false,
      reason: "missing_run_lock_scope",
    };
  }

  const record_item_id = buildRunLockRecordId(normalized_scope);
  const lease_token = crypto.randomUUID();

  let result;
  try {
    result = await backend().runLockAcquire({
      lock_key: normalized_scope,
      lease_token,
      owner: clean(owner) || null,
      lease_ms: Math.max(Number(lease_ms) || 0, 1),
      metadata: metadata && typeof metadata === "object" ? metadata : {},
    });
  } catch (error) {
    runtimeDeps.warn("run_lock.backend_unavailable", {
      module: RUN_LOCK_LOGGER_KEY,
      scope: normalized_scope,
      record_item_id,
      error: clean(error?.message) || "unknown_error",
    });
    return {
      ok: false,
      acquired: false,
      reason: "run_lock_backend_unavailable",
      scope: normalized_scope,
      record_item_id,
    };
  }

  if (!result?.acquired) {
    if (result?.reason === "run_lock_active") {
      return {
        ok: true,
        acquired: false,
        reason: "run_lock_active",
        record_item_id,
        scope: normalized_scope,
        meta: result?.meta || null,
      };
    }

    runtimeDeps.warn("run_lock.acquire_race_lost", {
      module: RUN_LOCK_LOGGER_KEY,
      scope: normalized_scope,
      record_item_id,
      existing_lease_token: result?.meta?.lease_token || null,
      reason: result?.reason || null,
    });

    return {
      ok: result?.ok !== false,
      acquired: false,
      reason: result?.reason || "run_lock_race_lost",
      scope: normalized_scope,
      record_item_id,
      meta: result?.meta || null,
    };
  }

  runtimeDeps.warn("run_lock.acquired", {
    module: RUN_LOCK_LOGGER_KEY,
    scope: normalized_scope,
    record_item_id,
    lease_token,
    owner,
    expires_at: result?.meta?.expires_at || null,
  });

  return {
    ok: true,
    acquired: true,
    reason: result?.reason || "lock_acquired",
    scope: normalized_scope,
    record_item_id,
    lease_token,
    meta: result?.meta || null,
  };
}

/**
 * Extend the lease. Only the current holder can: once another instance has
 * reclaimed an expired lease, the previous holder's token no longer matches and
 * this returns `run_lock_lease_token_mismatch`.
 *
 * An already-expired lease is NOT extendable, because another instance may
 * claim it at any moment.
 */
export async function heartbeatRunLock({
  scope,
  record_item_id = null,
  lease_token = null,
  lease_ms = null,
} = {}) {
  const normalized_scope =
    clean(scope) || clean(record_item_id).replace(/^run-locks:/, "");

  if (!normalized_scope) {
    return { ok: false, refreshed: false, reason: "missing_run_lock_scope" };
  }
  if (!clean(lease_token)) {
    return {
      ok: false,
      refreshed: false,
      reason: "run_lock_lease_token_required",
      scope: normalized_scope,
    };
  }

  try {
    const result = await backend().runLockHeartbeat({
      lock_key: normalized_scope,
      lease_token: clean(lease_token),
      lease_ms: lease_ms == null ? null : Math.max(Number(lease_ms) || 0, 1),
    });

    return {
      ok: result?.ok !== false,
      refreshed: Boolean(result?.refreshed),
      reason: result?.reason || "run_lock_heartbeat",
      scope: normalized_scope,
      record_item_id: buildRunLockRecordId(normalized_scope),
      meta: result?.meta || null,
    };
  } catch (error) {
    return {
      ok: false,
      refreshed: false,
      reason: "run_lock_backend_unavailable",
      scope: normalized_scope,
      error: clean(error?.message) || "unknown_error",
    };
  }
}

/**
 * Release a lock held by this caller.
 *
 * TIGHTENED (deliberate): the release is now fenced on `lease_token`. The
 * previous filesystem implementation wrote `status: "released"` unconditionally,
 * so an instance whose lease had already expired and been reclaimed could
 * release the NEW holder's lock and let a third runner in. That is exactly the
 * failure this migration exists to remove.
 *
 * Operator/manual release is unaffected - it goes through
 * `forceReleaseStaleLock`, which is what /api/internal/runs/release-lock (and
 * its /api/internal/run-locks/release alias) already call.
 */
export async function releaseRunLock({
  scope,
  record_item_id = null,
  lease_token = null,
  outcome = "completed",
  metadata = {},
  error = null,
} = {}) {
  const normalized_scope =
    clean(scope) || clean(record_item_id).replace(/^run-locks:/, "");

  if (!normalized_scope) {
    return {
      ok: false,
      released: false,
      reason: "missing_run_lock_record_item_id",
    };
  }

  if (!clean(lease_token)) {
    runtimeDeps.warn("run_lock.release_missing_lease_token", {
      module: RUN_LOCK_LOGGER_KEY,
      scope: normalized_scope,
    });
    return {
      ok: false,
      released: false,
      reason: "run_lock_lease_token_required",
      scope: normalized_scope,
      record_item_id: buildRunLockRecordId(normalized_scope),
    };
  }

  let result;
  try {
    result = await backend().runLockRelease({
      lock_key: normalized_scope,
      lease_token: clean(lease_token),
      outcome: clean(outcome) || null,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      error: clean(error?.message || error) || null,
    });
  } catch (backend_error) {
    runtimeDeps.warn("run_lock.release_backend_unavailable", {
      module: RUN_LOCK_LOGGER_KEY,
      scope: normalized_scope,
      error: clean(backend_error?.message) || "unknown_error",
    });
    return {
      ok: false,
      released: false,
      reason: "run_lock_backend_unavailable",
      scope: normalized_scope,
      record_item_id: buildRunLockRecordId(normalized_scope),
    };
  }

  if (!result?.released) {
    runtimeDeps.warn("run_lock.release_rejected", {
      module: RUN_LOCK_LOGGER_KEY,
      scope: normalized_scope,
      reason: result?.reason || null,
    });
    return {
      ok: result?.ok !== false,
      released: false,
      reason: result?.reason || "run_lock_release_rejected",
      scope: normalized_scope,
      record_item_id: buildRunLockRecordId(normalized_scope),
      meta: result?.meta || null,
    };
  }

  runtimeDeps.warn("run_lock.released", {
    module: RUN_LOCK_LOGGER_KEY,
    scope: normalized_scope,
    outcome,
  });

  return {
    ok: true,
    released: true,
    reason: result?.reason || "run_lock_released",
    record_item_id: buildRunLockRecordId(normalized_scope),
    scope: normalized_scope,
    outcome: clean(outcome) || null,
  };
}

export async function withRunLock({
  scope,
  enabled = true,
  lease_ms = 10 * 60_000,
  owner = null,
  metadata = {},
  onLocked = null,
  fn,
} = {}) {
  if (typeof fn !== "function") {
    throw new Error("withRunLock requires fn");
  }

  if (!enabled) {
    return fn({
      lock: null,
      refresh: async () => ({ ok: true, skipped: true, reason: "run_lock_disabled" }),
    });
  }

  const lock = await acquireRunLock({
    scope,
    lease_ms,
    owner,
    metadata,
  });

  if (!lock.ok || !lock.acquired) {
    if (typeof onLocked === "function") {
      return onLocked(lock);
    }

    return {
      ok: true,
      skipped: true,
      reason: lock?.reason || "run_lock_not_acquired",
      lock,
    };
  }

  try {
    const result = await fn({
      lock,
      // Now a real, fenced lease extension instead of a stub.
      refresh: async (refresh_lease_ms = null) =>
        heartbeatRunLock({
          scope,
          record_item_id: lock.record_item_id,
          lease_token: lock.lease_token,
          lease_ms: refresh_lease_ms,
        }),
    });

    await releaseRunLock({
      scope,
      record_item_id: lock.record_item_id,
      lease_token: lock.lease_token,
      outcome: result?.ok === false ? "completed_with_errors" : "completed",
      metadata: {
        result_reason: clean(result?.reason) || null,
        processed_count: Number(result?.processed_count || 0) || 0,
      },
    });

    return result;
  } catch (error) {
    await releaseRunLock({
      scope,
      record_item_id: lock.record_item_id,
      lease_token: lock.lease_token,
      outcome: "failed",
      metadata,
      error,
    });
    throw error;
  }
}

/**
 * Operator escape hatch: release without knowing the lease token.
 * Unconditional by design.
 */
export async function forceReleaseStaleLock({
  scope,
  reason = "force_released_stale",
} = {}, _deps = {}) {
  const normalized_scope = clean(scope);
  if (!normalized_scope) {
    return {
      ok: false,
      released: false,
      reason: "missing_run_lock_scope",
    };
  }

  const active_backend = _deps.getDurableBackend
    ? _deps.getDurableBackend()
    : backend();

  const result = await active_backend.runLockForceRelease({
    lock_key: normalized_scope,
    reason,
  });

  if (!result?.released) {
    return {
      ok: result?.ok !== false,
      released: false,
      reason: result?.reason || "no_lock_record_found",
      scope: normalized_scope,
    };
  }

  return {
    ok: true,
    released: true,
    reason,
    scope: normalized_scope,
    record_item_id: buildRunLockRecordId(normalized_scope),
    was_active: Boolean(result?.was_active),
    previous_expires_at: result?.previous_expires_at || null,
    previous_owner: result?.previous_owner || null,
    previous_acquired_at: result?.previous_acquired_at || null,
  };
}

export default {
  __setRunLockTestDeps,
  __resetRunLockTestDeps,
  acquireRunLock,
  heartbeatRunLock,
  releaseRunLock,
  withRunLock,
  forceReleaseStaleLock,
};
