/**
 * Durable state backend for run locks and the idempotency ledger.
 *
 * WHY THIS EXISTS
 * ---------------
 * Both consumers previously stored their AUTHORITATIVE state in
 * /tmp/real-estate-automation-runtime-state (see runtime-state-store.js).
 * That is per-instance and ephemeral, so:
 *   - a restart lost every held lock and every in-flight claim;
 *   - two instances could not see each other's locks or claims;
 *   - a webhook retry on a second instance re-ran seller automation.
 *
 * The authoritative state now lives in Postgres, and every atomic decision is
 * made by a single SQL function (migration
 * 20260831000000_durable_run_locks_and_idempotency_ledger.sql). No decision is
 * reconstructed from a read-modify-write in JavaScript.
 *
 * BACKEND SELECTION - NO SILENT FALLBACK
 * --------------------------------------
 *   RUNTIME_STATE_BACKEND = "postgres" | "memory"
 *
 *   default: "memory" when NODE_ENV === "test", otherwise "postgres".
 *
 * The "memory" backend is an in-process Map. It is genuinely atomic for a
 * single Node process (the event loop serialises each operation), which makes
 * it correct for unit tests and single-process local development - and
 * catastrophically wrong for more than one instance. It is therefore REFUSED
 * in production: selecting it with NODE_ENV=production throws rather than
 * quietly degrading. There is no filesystem backend any more, and no path by
 * which a missing database silently becomes local state.
 */

import crypto from "node:crypto";

import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";

export const DURABLE_BACKEND_POSTGRES = "postgres";
export const DURABLE_BACKEND_MEMORY = "memory";

function clean(value) {
  return String(value ?? "").trim();
}

function isProduction() {
  return clean(process.env.NODE_ENV).toLowerCase() === "production";
}

function isTest() {
  return clean(process.env.NODE_ENV).toLowerCase() === "test";
}

/**
 * Resolve which backend is in force. Explicit env wins; otherwise tests get
 * memory and everything else gets Postgres.
 */
export function resolveDurableBackendName() {
  const explicit = clean(process.env.RUNTIME_STATE_BACKEND).toLowerCase();
  if (explicit === DURABLE_BACKEND_MEMORY) return DURABLE_BACKEND_MEMORY;
  if (explicit === DURABLE_BACKEND_POSTGRES) return DURABLE_BACKEND_POSTGRES;
  if (explicit) {
    throw new Error(
      `unknown_runtime_state_backend:${explicit} (expected "postgres" or "memory")`
    );
  }
  return isTest() ? DURABLE_BACKEND_MEMORY : DURABLE_BACKEND_POSTGRES;
}

/**
 * Fail closed: production may only ever run on Postgres. Called on every
 * backend resolution so a misconfigured deploy dies loudly at the first lock
 * or claim instead of silently losing cross-instance correctness.
 */
export function assertDurableBackendAllowed(name = resolveDurableBackendName()) {
  if (isProduction() && name !== DURABLE_BACKEND_POSTGRES) {
    throw new Error(
      `durable_state_backend_forbidden_in_production:${name} - run locks and the ` +
        `idempotency ledger require Postgres in production; in-process state is ` +
        `not shared between instances and does not survive restart.`
    );
  }
  return name;
}

/* ===========================================================================
 * MEMORY BACKEND - tests and single-process local development ONLY.
 * Mirrors the SQL semantics exactly so suites behave identically either way.
 * ======================================================================== */

const memoryRunLocks = new Map();
const memoryLedger = new Map();

export function __resetDurableMemoryState() {
  memoryRunLocks.clear();
  memoryLedger.clear();
}

function memoryLockMeta(row) {
  return {
    version: 1,
    scope: row.lock_key,
    status: row.status,
    lease_token: row.lease_token,
    owner: row.owner ?? null,
    lease_ms: row.lease_ms,
    started_at: row.started_at,
    acquired_at: row.acquired_at,
    lease_acquired_at: row.lease_acquired_at,
    last_heartbeat_at: row.last_heartbeat_at,
    expires_at: row.lease_until,
    released_at: row.released_at ?? null,
    reason: row.reason ?? null,
    outcome: row.outcome ?? null,
    last_error: row.last_error ?? null,
    acquisition_count: row.acquisition_count,
    metadata: row.metadata ?? {},
  };
}

function memoryLedgerMeta(row) {
  return {
    ...(row.metadata || {}),
    scope: row.scope,
    key: row.key,
    summary: row.summary ?? null,
    status: row.status,
    payload_hash: row.payload_hash ?? null,
    attempts: row.attempts,
    started_at: row.started_at,
    completed_at: row.completed_at ?? null,
    failed_at: row.failed_at ?? null,
    last_error: row.last_error ?? null,
    claim_token: row.claim_token ?? null,
  };
}

const memoryBackend = {
  name: DURABLE_BACKEND_MEMORY,

  async runLockAcquire({ lock_key, lease_token, owner, lease_ms, metadata }) {
    const key = clean(lock_key);
    if (!key) return { ok: false, acquired: false, reason: "missing_run_lock_scope" };

    const now = Date.now();
    const lease = Math.min(Math.max(Number(lease_ms) || 600_000, 1), 86_400_000);
    const token = lease_token || crypto.randomUUID();
    const existing = memoryRunLocks.get(key);

    if (!existing) {
      const row = {
        lock_key: key,
        lease_token: token,
        owner: clean(owner) || null,
        status: "locked",
        lease_ms: lease,
        started_at: new Date(now).toISOString(),
        acquired_at: new Date(now).toISOString(),
        lease_acquired_at: new Date(now).toISOString(),
        last_heartbeat_at: new Date(now).toISOString(),
        lease_until: new Date(now + lease).toISOString(),
        released_at: null,
        reason: "lock_acquired",
        outcome: null,
        last_error: null,
        acquisition_count: 1,
        metadata: metadata || {},
      };
      memoryRunLocks.set(key, row);
      return {
        ok: true,
        acquired: true,
        reason: "lock_acquired",
        scope: key,
        lease_token: token,
        meta: memoryLockMeta(row),
      };
    }

    const active =
      existing.status === "locked" &&
      !existing.released_at &&
      new Date(existing.lease_until).getTime() > now;

    if (active) {
      return {
        ok: true,
        acquired: false,
        reason: "run_lock_active",
        scope: key,
        meta: memoryLockMeta(existing),
      };
    }

    const reason =
      existing.status === "locked" ? "stale_lock_reclaimed" : "lock_acquired";
    const row = {
      ...existing,
      lease_token: token,
      owner: clean(owner) || null,
      status: "locked",
      lease_ms: lease,
      lease_acquired_at: new Date(now).toISOString(),
      last_heartbeat_at: new Date(now).toISOString(),
      lease_until: new Date(now + lease).toISOString(),
      released_at: null,
      reason,
      outcome: null,
      acquisition_count: Number(existing.acquisition_count || 0) + 1,
      metadata: metadata || {},
    };
    memoryRunLocks.set(key, row);
    return {
      ok: true,
      acquired: true,
      reason,
      scope: key,
      lease_token: token,
      meta: memoryLockMeta(row),
    };
  },

  async runLockHeartbeat({ lock_key, lease_token, lease_ms }) {
    const key = clean(lock_key);
    if (!key) return { ok: false, refreshed: false, reason: "missing_run_lock_scope" };
    if (!lease_token) {
      return { ok: false, refreshed: false, reason: "run_lock_lease_token_required" };
    }

    const row = memoryRunLocks.get(key);
    if (!row) {
      return { ok: true, refreshed: false, reason: "run_lock_not_found", scope: key };
    }
    if (row.lease_token !== lease_token) {
      return {
        ok: true,
        refreshed: false,
        reason: "run_lock_lease_token_mismatch",
        scope: key,
        meta: memoryLockMeta(row),
      };
    }
    if (row.status !== "locked" || row.released_at) {
      return {
        ok: true,
        refreshed: false,
        reason: "run_lock_already_released",
        scope: key,
        meta: memoryLockMeta(row),
      };
    }
    const now = Date.now();
    if (new Date(row.lease_until).getTime() <= now) {
      return {
        ok: true,
        refreshed: false,
        reason: "run_lock_lease_expired",
        scope: key,
        meta: memoryLockMeta(row),
      };
    }

    const lease = Math.min(Math.max(Number(lease_ms) || row.lease_ms, 1), 86_400_000);
    row.lease_ms = lease;
    row.last_heartbeat_at = new Date(now).toISOString();
    row.lease_until = new Date(now + lease).toISOString();
    return {
      ok: true,
      refreshed: true,
      reason: "run_lock_heartbeat",
      scope: key,
      meta: memoryLockMeta(row),
    };
  },

  async runLockRelease({ lock_key, lease_token, outcome, metadata, error }) {
    const key = clean(lock_key);
    if (!key) {
      return { ok: false, released: false, reason: "missing_run_lock_record_item_id" };
    }
    if (!lease_token) {
      return {
        ok: false,
        released: false,
        reason: "run_lock_lease_token_required",
        scope: key,
      };
    }

    const row = memoryRunLocks.get(key);
    if (!row) {
      return { ok: true, released: false, reason: "run_lock_not_found", scope: key };
    }

    if (row.status === "released" && row.lease_token === lease_token) {
      return { ok: true, released: true, reason: "already_released", scope: key };
    }
    if (row.lease_token !== lease_token) {
      return {
        ok: true,
        released: false,
        reason: "run_lock_lease_token_mismatch",
        scope: key,
        holder_lease_token: row.lease_token,
        meta: memoryLockMeta(row),
      };
    }

    row.status = "released";
    row.released_at = new Date().toISOString();
    row.outcome = clean(outcome) || null;
    row.last_error = clean(error) || null;
    row.metadata = metadata || {};
    return {
      ok: true,
      released: true,
      reason: "run_lock_released",
      scope: key,
      outcome: row.outcome,
      meta: memoryLockMeta(row),
    };
  },

  async runLockForceRelease({ lock_key, reason }) {
    const key = clean(lock_key);
    if (!key) return { ok: false, released: false, reason: "missing_run_lock_scope" };

    const row = memoryRunLocks.get(key);
    if (!row) {
      return { ok: true, released: false, reason: "no_lock_record_found", scope: key };
    }

    const was_active =
      row.status === "locked" &&
      !row.released_at &&
      new Date(row.lease_until).getTime() > Date.now();
    const previous = { ...row };

    row.status = "released";
    row.released_at = new Date().toISOString();
    row.outcome = reason;
    row.last_error = `Force-released: ${reason}`;

    return {
      ok: true,
      released: true,
      reason,
      scope: key,
      was_active,
      previous_expires_at: previous.lease_until,
      previous_owner: previous.owner ?? null,
      previous_acquired_at: previous.acquired_at,
    };
  },

  async idempotencyBegin({
    scope,
    key,
    claim_token,
    summary,
    metadata,
    lease_ms,
    payload_hash,
  }) {
    const s = clean(scope);
    const k = clean(key);
    if (!s || !k) {
      return { ok: false, duplicate: false, reason: "missing_idempotency_scope_or_key" };
    }

    const now = Date.now();
    const lease = Math.min(Math.max(Number(lease_ms) || 600_000, 1), 86_400_000);
    const token = claim_token || crypto.randomUUID();
    const id = `${s} ${k}`;
    const existing = memoryLedger.get(id);

    if (!existing) {
      const row = {
        scope: s,
        key: k,
        claim_token: token,
        status: "processing",
        summary: clean(summary) || null,
        payload_hash: clean(payload_hash) || null,
        attempts: 1,
        started_at: new Date(now).toISOString(),
        completed_at: null,
        failed_at: null,
        last_error: null,
        skip_content_fields: false,
        metadata: metadata || {},
      };
      memoryLedger.set(id, row);
      return {
        ok: true,
        duplicate: false,
        reason: "event_claimed",
        scope: s,
        key: k,
        claim_token: token,
        meta: memoryLedgerMeta(row),
      };
    }

    if (existing.status === "completed") {
      return {
        ok: true,
        duplicate: true,
        reason: "duplicate_event_ignored",
        scope: s,
        key: k,
        meta: memoryLedgerMeta(existing),
      };
    }

    const started = new Date(existing.started_at).getTime();
    const stale = Number.isNaN(started) || now - started > lease;

    if (existing.status === "processing" && !stale) {
      return {
        ok: true,
        duplicate: true,
        reason: "event_already_processing",
        scope: s,
        key: k,
        meta: memoryLedgerMeta(existing),
      };
    }

    existing.claim_token = token;
    existing.status = "processing";
    existing.summary = clean(summary) || null;
    existing.payload_hash = clean(payload_hash) || existing.payload_hash || null;
    existing.attempts = Number(existing.attempts || 0) + 1;
    existing.started_at = new Date(now).toISOString();
    existing.completed_at = null;
    existing.failed_at = null;
    existing.last_error = null;
    existing.metadata = { ...(existing.metadata || {}), ...(metadata || {}) };

    return {
      ok: true,
      duplicate: false,
      reason: "stale_or_failed_event_reclaimed",
      scope: s,
      key: k,
      claim_token: token,
      meta: memoryLedgerMeta(existing),
    };
  },

  async idempotencyComplete({ scope, key, summary, metadata, skip_content_fields }) {
    const s = clean(scope);
    const k = clean(key);
    if (!s || !k) return { ok: false, reason: "missing_record_item_id" };

    const id = `${s} ${k}`;
    const row = memoryLedger.get(id) || {
      scope: s,
      key: k,
      attempts: 1,
      started_at: new Date().toISOString(),
      metadata: {},
    };
    row.status = "completed";
    row.completed_at = new Date().toISOString();
    row.summary = clean(summary) || null;
    row.claim_token = null;
    row.skip_content_fields = Boolean(skip_content_fields);
    row.metadata = { ...(row.metadata || {}), ...(metadata || {}) };
    memoryLedger.set(id, row);

    return {
      ok: true,
      reason: "idempotency_record_completed",
      scope: s,
      key: k,
      meta: memoryLedgerMeta(row),
    };
  },

  async idempotencyFail({ scope, key, error, metadata, skip_content_fields }) {
    const s = clean(scope);
    const k = clean(key);
    if (!s || !k) return { ok: false, reason: "missing_record_item_id" };

    const error_message = clean(error) || "unknown_error";
    const id = `${s} ${k}`;
    const row = memoryLedger.get(id) || {
      scope: s,
      key: k,
      attempts: 1,
      started_at: new Date().toISOString(),
      metadata: {},
    };
    row.status = "failed";
    row.failed_at = new Date().toISOString();
    row.last_error = error_message;
    row.claim_token = null;
    row.skip_content_fields = Boolean(skip_content_fields);
    row.metadata = { ...(row.metadata || {}), ...(metadata || {}) };
    memoryLedger.set(id, row);

    return {
      ok: true,
      reason: "idempotency_record_failed",
      scope: s,
      key: k,
      error_message,
      meta: memoryLedgerMeta(row),
    };
  },
};

/* ===========================================================================
 * POSTGRES BACKEND - production authority.
 * Every method is one RPC. Atomicity is entirely the database's.
 * ======================================================================== */

function rpcClient(deps = {}) {
  return deps.supabase || getDefaultSupabaseClient();
}

async function rpc(name, params, deps = {}) {
  const client = rpcClient(deps);
  if (!client || typeof client.rpc !== "function") {
    throw new Error(`durable_state_supabase_client_unavailable:${name}`);
  }
  const { data, error } = await client.rpc(name, params);
  if (error) {
    const message = clean(error.message) || clean(error.details) || "rpc_error";
    const wrapped = new Error(`durable_state_rpc_failed:${name}:${message}`);
    wrapped.cause = error;
    wrapped.rpc_name = name;
    throw wrapped;
  }
  return data || {};
}

const postgresBackend = {
  name: DURABLE_BACKEND_POSTGRES,

  runLockAcquire: ({ lock_key, lease_token, owner, lease_ms, metadata }, deps) =>
    rpc(
      "run_lock_acquire",
      {
        p_lock_key: lock_key,
        p_lease_token: lease_token,
        p_owner: owner ?? null,
        p_lease_ms: lease_ms,
        p_metadata: metadata || {},
      },
      deps
    ),

  runLockHeartbeat: ({ lock_key, lease_token, lease_ms }, deps) =>
    rpc(
      "run_lock_heartbeat",
      {
        p_lock_key: lock_key,
        p_lease_token: lease_token,
        p_lease_ms: lease_ms ?? null,
      },
      deps
    ),

  runLockRelease: ({ lock_key, lease_token, outcome, metadata, error }, deps) =>
    rpc(
      "run_lock_release",
      {
        p_lock_key: lock_key,
        p_lease_token: lease_token,
        p_outcome: outcome ?? null,
        p_metadata: metadata || {},
        p_error: error ?? null,
      },
      deps
    ),

  runLockForceRelease: ({ lock_key, reason }, deps) =>
    rpc(
      "run_lock_force_release",
      {
        p_lock_key: lock_key,
        p_reason: reason,
      },
      deps
    ),

  idempotencyBegin: (
    { scope, key, claim_token, summary, metadata, lease_ms, payload_hash },
    deps
  ) =>
    rpc(
      "idempotency_begin",
      {
        p_scope: scope,
        p_key: key,
        p_claim_token: claim_token,
        p_summary: summary ?? null,
        p_metadata: metadata || {},
        p_lease_ms: lease_ms,
        p_payload_hash: payload_hash ?? null,
      },
      deps
    ),

  idempotencyComplete: ({ scope, key, summary, metadata, skip_content_fields }, deps) =>
    rpc(
      "idempotency_complete",
      {
        p_scope: scope,
        p_key: key,
        p_summary: summary ?? null,
        p_metadata: metadata || {},
        p_skip_content_fields: Boolean(skip_content_fields),
      },
      deps
    ),

  idempotencyFail: ({ scope, key, error, metadata, skip_content_fields }, deps) =>
    rpc(
      "idempotency_fail",
      {
        p_scope: scope,
        p_key: key,
        p_error: error ?? null,
        p_metadata: metadata || {},
        p_skip_content_fields: Boolean(skip_content_fields),
      },
      deps
    ),
};

/**
 * Resolve the active backend, enforcing the production guard on every call so
 * a late environment change cannot slip past a one-time check.
 */
export function getDurableBackend() {
  const name = assertDurableBackendAllowed(resolveDurableBackendName());
  return name === DURABLE_BACKEND_MEMORY ? memoryBackend : postgresBackend;
}

export default {
  DURABLE_BACKEND_MEMORY,
  DURABLE_BACKEND_POSTGRES,
  resolveDurableBackendName,
  assertDurableBackendAllowed,
  getDurableBackend,
  __resetDurableMemoryState,
};
