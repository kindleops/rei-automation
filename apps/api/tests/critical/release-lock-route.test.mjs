/**
 * release-lock-route.test.mjs
 *
 * Focused tests for the /api/internal/runs/release-lock route logic
 * and the underlying forceReleaseStaleLock utility.
 *
 * These now drive the REAL durable backend (the in-process backend selected by
 * NODE_ENV=test) instead of hand-written readRuntimeState/writeRuntimeState
 * stubs, because run locks no longer live on the filesystem. State is seeded by
 * genuinely acquiring a lock, so the assertions describe observable behaviour
 * rather than a storage shape.
 *
 * Covered:
 * 1. forceReleaseStaleLock releases an active lock and returns was_active=true.
 * 2. An already-expired lock reports was_active=false.
 * 3. A force-released lock is genuinely free afterwards.
 * 4. released=false/no_lock_record_found when no record exists.
 * 5. released=false/missing_run_lock_scope when scope is empty.
 * 6. Route auth contract: correct secret accepted, wrong/missing rejected.
 * 7. Route logic: missing scope -> 400.
 * 8. Route logic: active lock released -> released=true + was_active=true.
 * 9. Route logic: no lock record -> released=false (ok response).
 * 10. The production feeder lock scope formats correctly via the release path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  acquireRunLock,
  forceReleaseStaleLock,
  __resetRunLockTestDeps,
} from "@/lib/domain/runs/run-locks.js";

const FEEDER_SCOPE = "feeder:view:SMS / TIER #1 / ALL";

// Every test starts from a clean durable store.
function freshStore() {
  __resetRunLockTestDeps();
}

// ─── Auth helpers (inline, same as in podio-message-event-sync.test.mjs) ────

function checkInternalAuth(headers, secret) {
  const provided = String(headers["x-internal-api-secret"] ?? "").trim();
  if (!provided || !secret) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── 1. forceReleaseStaleLock releases an ACTIVE lock ────────────────────────

test("forceReleaseStaleLock: releases an active lock and reports was_active=true", async () => {
  freshStore();

  const held = await acquireRunLock({
    scope: FEEDER_SCOPE,
    owner: "feeder_route",
    lease_ms: 10 * 60_000,
  });
  assert.equal(held.acquired, true);

  const result = await forceReleaseStaleLock({
    scope: FEEDER_SCOPE,
    reason: "manual_release_via_api",
  });

  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.equal(result.reason, "manual_release_via_api");
  assert.equal(result.scope, FEEDER_SCOPE);
  assert.equal(result.record_item_id, `run-locks:${FEEDER_SCOPE}`);
  assert.equal(result.was_active, true, "a live lease must report was_active=true");
  assert.equal(result.previous_owner, "feeder_route");
  assert.equal(
    result.previous_expires_at,
    held.meta.expires_at,
    "previous_expires_at must report the lease it tore down"
  );
});

// ─── 2. An already-expired lock reports was_active=false ─────────────────────

test("forceReleaseStaleLock: an expired lease reports was_active=false", async () => {
  freshStore();

  await acquireRunLock({ scope: FEEDER_SCOPE, owner: "feeder_route", lease_ms: 1 });
  await sleep(5);

  const result = await forceReleaseStaleLock({
    scope: FEEDER_SCOPE,
    reason: "manual_release_via_api",
  });

  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.equal(result.was_active, false, "an expired lease is not active");
  assert.equal(result.previous_owner, "feeder_route");
});

// ─── 3. A force-released lock is genuinely free afterwards ───────────────────

test("forceReleaseStaleLock: the lock is free afterwards, not merely marked", async () => {
  freshStore();

  await acquireRunLock({ scope: "queue-run", owner: "runner-a", lease_ms: 10 * 60_000 });
  const forced = await forceReleaseStaleLock({ scope: "queue-run", reason: "test_reason" });
  assert.equal(forced.released, true);
  assert.equal(forced.reason, "test_reason");

  // The observable meaning of "force released": the next acquirer gets a clean
  // acquisition, NOT a stale reclaim, and certainly not run_lock_active.
  const next = await acquireRunLock({
    scope: "queue-run",
    owner: "runner-b",
    lease_ms: 10 * 60_000,
  });
  assert.equal(next.acquired, true);
  assert.equal(next.reason, "lock_acquired");
});

// ─── 4. No lock record → released=false ──────────────────────────────────────

test("forceReleaseStaleLock: returns ok=true released=false when no lock record exists", async () => {
  freshStore();

  const result = await forceReleaseStaleLock({ scope: FEEDER_SCOPE });

  assert.equal(result.ok, true);
  assert.equal(result.released, false);
  assert.equal(result.reason, "no_lock_record_found");
});

// ─── 5. Empty scope → ok=false ───────────────────────────────────────────────

test("forceReleaseStaleLock: returns ok=false when scope is empty", async () => {
  freshStore();

  const result = await forceReleaseStaleLock({ scope: "" });

  assert.equal(result.ok, false);
  assert.equal(result.released, false);
  assert.equal(result.reason, "missing_run_lock_scope");
});

// ─── 6. Route auth contract ───────────────────────────────────────────────────

test("release-lock route auth: accepts correct x-internal-api-secret", () => {
  const secret = "test-internal-secret-xyz";
  assert.ok(
    checkInternalAuth({ "x-internal-api-secret": secret }, secret),
    "correct secret must pass"
  );
});

test("release-lock route auth: rejects wrong x-internal-api-secret", () => {
  assert.ok(
    !checkInternalAuth({ "x-internal-api-secret": "wrong" }, "correct"),
    "wrong secret must be rejected"
  );
});

test("release-lock route auth: rejects missing header", () => {
  assert.ok(
    !checkInternalAuth({}, "some-secret"),
    "missing header must be rejected"
  );
});

// ─── Route simulation shared by the logic tests ──────────────────────────────

async function simulateHandle({ scope }) {
  if (!scope) {
    return { status: 400, body: { ok: false, error: "missing_scope", released: false } };
  }

  const result = await forceReleaseStaleLock({
    scope,
    reason: "manual_release_via_api",
  });

  return {
    status: result.ok ? 200 : 500,
    body: {
      ok: result.ok,
      released: result.released,
      reason: result.reason,
      scope: result.scope,
      was_active: result.was_active ?? null,
    },
  };
}

// ─── 7. Route logic: missing scope → 400 ─────────────────────────────────────

test("release-lock route logic: missing scope returns ok=false error=missing_scope", async () => {
  freshStore();

  const response = await simulateHandle({ scope: "" });

  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "missing_scope");
  assert.equal(response.body.released, false);
});

// ─── 8. Route logic: active lock released ────────────────────────────────────

test("release-lock route logic: active lock returns released=true was_active=true", async () => {
  freshStore();

  await acquireRunLock({
    scope: FEEDER_SCOPE,
    owner: "feeder_route",
    lease_ms: 10 * 60_000,
  });

  const response = await simulateHandle({ scope: FEEDER_SCOPE });

  assert.equal(response.status, 200);
  assert.equal(response.body.released, true);
  assert.equal(response.body.was_active, true);
  assert.equal(response.body.reason, "manual_release_via_api");
});

// ─── 9. Route logic: no record → released=false ok=true ──────────────────────

test("release-lock route logic: no lock record returns released=false ok=true", async () => {
  freshStore();

  const response = await simulateHandle({ scope: FEEDER_SCOPE });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.released, false);
  assert.equal(response.body.reason, "no_lock_record_found");
});

// ─── 10. Feeder lock scope formats correctly ─────────────────────────────────

test("feeder lock scope: 'feeder:view:SMS / TIER #1 / ALL' maps to correct record_item_id", async () => {
  freshStore();

  await acquireRunLock({ scope: FEEDER_SCOPE, owner: "feeder_route" });

  const result = await forceReleaseStaleLock({ scope: FEEDER_SCOPE });

  assert.equal(result.scope, FEEDER_SCOPE);
  assert.equal(result.record_item_id, `run-locks:${FEEDER_SCOPE}`);
  assert.equal(result.released, true);
});
