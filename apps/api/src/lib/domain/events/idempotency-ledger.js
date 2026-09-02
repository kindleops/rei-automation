/**
 * Idempotency ledger: mark-before-work claims for webhook events.
 *
 * DURABILITY (changed): the authoritative claim now lives in the
 * `public.idempotency_ledger` table, not in /tmp. The claim itself is a single
 * atomic `INSERT ... ON CONFLICT DO NOTHING ... RETURNING` inside
 * `idempotency_begin()`. There is no SELECT-then-INSERT in this file, so two
 * concurrent deliveries of the same event can never both receive a claim -
 * including when they land on different instances, which the filesystem
 * implementation could not detect at all. See
 * supabase/migrations/20260831000000_durable_run_locks_and_idempotency_ledger.sql
 *
 * PUBLIC CONTRACT PRESERVED: beginIdempotentProcessing /
 * completeIdempotentProcessing / failIdempotentProcessing /
 * hashIdempotencyPayload keep their signatures, their `reason` strings
 * (`event_claimed`, `duplicate_event_ignored`, `event_already_processing`,
 * `stale_or_failed_event_reclaimed`), their statuses (`processing` /
 * `completed` / `failed`) and the 10-minute default lease.
 *
 * NOT FENCED (unchanged, deliberate): complete/fail are still unconditional
 * writes. The JS functions never received a claim token, so fencing them would
 * change public behaviour. Double execution is prevented at the claim, not at
 * the completion.
 */

import crypto from "node:crypto";

import {
  getDurableBackend,
  __resetDurableMemoryState,
} from "@/lib/domain/runtime/durable-state-backend.js";

const IDEMPOTENCY_NAMESPACE = "idempotency";

const defaultDeps = {
  getDurableBackend,
};

let runtimeDeps = { ...defaultDeps };

function clean(value) {
  return String(value ?? "").trim();
}

function buildLedgerStateKey(scope, key) {
  return `${clean(scope)}:${clean(key)}`;
}

function buildLedgerRecordId(scope, key) {
  return `${IDEMPOTENCY_NAMESPACE}:${buildLedgerStateKey(scope, key)}`;
}

function parseLedgerRecordId(record_item_id = "") {
  const normalized = clean(record_item_id);
  const namespace_separator = normalized.indexOf(":");
  const composite_key =
    namespace_separator === -1
      ? ""
      : clean(normalized.slice(namespace_separator + 1));
  const separator_index = composite_key.indexOf(":");

  if (separator_index === -1) {
    return {
      scope: null,
      key: composite_key || null,
    };
  }

  return {
    scope: composite_key.slice(0, separator_index) || null,
    key: composite_key.slice(separator_index + 1) || null,
  };
}

function backend() {
  return (runtimeDeps.getDurableBackend || getDurableBackend)();
}

export function __setIdempotencyLedgerTestDeps(overrides = {}) {
  runtimeDeps = { ...runtimeDeps, ...overrides };
}

export function __resetIdempotencyLedgerTestDeps() {
  runtimeDeps = { ...defaultDeps };
  __resetDurableMemoryState();
}

export function hashIdempotencyPayload(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value), "utf8")
    .digest("hex");
}

/**
 * Claim an event for processing.
 *
 * Returns `duplicate: true` when the caller MUST NOT process (a prior attempt
 * completed, or another worker holds an unexpired claim), and `duplicate:
 * false` when the caller MUST process.
 *
 * Backend failures fail HARD here on purpose - the opposite of run locks.
 * Returning `duplicate: true` on a database outage would silently DROP inbound
 * seller messages; returning `duplicate: false` would process without any
 * duplicate protection. Throwing lets the webhook return non-2xx so the
 * provider retries the delivery, which is the only safe option.
 */
export async function beginIdempotentProcessing({
  scope,
  key,
  summary = "",
  metadata = {},
  lease_ms = 10 * 60_000,
  payload_hash = null,
} = {}) {
  const normalized_scope = clean(scope);
  const normalized_key = clean(key);

  if (!normalized_scope || !normalized_key) {
    return {
      ok: false,
      duplicate: false,
      reason: "missing_idempotency_scope_or_key",
      record_item_id: null,
      key: normalized_key || null,
    };
  }

  const record_item_id = buildLedgerRecordId(normalized_scope, normalized_key);
  const claim_token = crypto.randomUUID();

  const result = await backend().idempotencyBegin({
    scope: normalized_scope,
    key: normalized_key,
    claim_token,
    summary: clean(summary) || null,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    lease_ms: Math.max(Number(lease_ms) || 0, 1),
    payload_hash: clean(payload_hash) || null,
  });

  return {
    ok: result?.ok !== false,
    duplicate: Boolean(result?.duplicate),
    reason: result?.reason || "event_claimed",
    record_item_id,
    key: normalized_key,
    scope: normalized_scope,
    meta: result?.meta || null,
  };
}

export async function completeIdempotentProcessing({
  record_item_id = null,
  scope = null,
  key = null,
  summary = "",
  metadata = {},
  skip_content_fields = false,
} = {}) {
  if (!record_item_id) {
    return {
      ok: false,
      reason: "missing_record_item_id",
    };
  }

  const parsed_record = parseLedgerRecordId(record_item_id);
  const resolved_scope = clean(scope) || clean(parsed_record.scope);
  const resolved_key = clean(key) || clean(parsed_record.key);

  const result = await backend().idempotencyComplete({
    scope: resolved_scope,
    key: resolved_key,
    summary: clean(summary) || null,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    skip_content_fields: Boolean(skip_content_fields),
  });

  return {
    ok: result?.ok !== false,
    reason: result?.reason || "idempotency_record_completed",
    record_item_id,
  };
}

export async function failIdempotentProcessing({
  record_item_id = null,
  scope = null,
  key = null,
  error = null,
  metadata = {},
  skip_content_fields = false,
} = {}) {
  if (!record_item_id) {
    return {
      ok: false,
      reason: "missing_record_item_id",
    };
  }

  const parsed_record = parseLedgerRecordId(record_item_id);
  const resolved_scope = clean(scope) || clean(parsed_record.scope);
  const resolved_key = clean(key) || clean(parsed_record.key);
  const error_message =
    clean(error?.message) ||
    clean(error) ||
    "unknown_error";

  const result = await backend().idempotencyFail({
    scope: resolved_scope,
    key: resolved_key,
    error: error_message,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    skip_content_fields: Boolean(skip_content_fields),
  });

  return {
    ok: result?.ok !== false,
    reason: result?.reason || "idempotency_record_failed",
    record_item_id,
    error_message,
  };
}

export default {
  __setIdempotencyLedgerTestDeps,
  __resetIdempotencyLedgerTestDeps,
  beginIdempotentProcessing,
  completeIdempotentProcessing,
  failIdempotentProcessing,
  hashIdempotencyPayload,
};
