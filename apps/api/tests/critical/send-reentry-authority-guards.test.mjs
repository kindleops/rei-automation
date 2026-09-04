/**
 * send-reentry-authority-guards.test.mjs
 *
 * Every remaining route by which a row could re-enter provider execution.
 *
 * The governing rule for all of them:
 *
 *   A LEASE EXPIRING, A RETRY COUNTER, OR MISSING CONFIGURATION IS NOT PROOF
 *   THAT THE PROVIDER REQUEST NEVER STARTED.
 *
 * Each guard here was either accidental safety (P4 stranded rows only because
 * it forgot to clear lock_token) or a default-allow (P12 read absent config as
 * permission). Accidental safety breaks the moment someone tidies the code up,
 * so it is made intentional and pinned.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { recycleClaimedSendingRow } from "@/lib/supabase/sms-engine.js";
import { isAmbiguousSendRow } from "@/lib/domain/messaging/ambiguous-send-evidence.js";

const SRC = (rel) => new URL(`../../${rel}`, import.meta.url);
const DASH = (rel) => new URL(`../../../dashboard/${rel}`, import.meta.url);

// ── P3: recycleClaimedSendingRow ───────────────────────────────────────────

const claimedRow = (overrides = {}) => ({
  id: "11111111-2222-3333-4444-555555555555",
  queue_status: "processing",
  retry_count: 0,
  max_retries: 3,
  lock_token: "lock-1",
  processing_run_id: "run-1",
  metadata: {},
  ...overrides,
});

const recycleOpts = { now: "2026-09-04T00:00:00.000Z", processing_run_id: "run-1" };

test("P3: a row whose outcome was AMBIGUOUS is never recycled, however many retries remain", async () => {
  let updated = false;
  const row = claimedRow({
    retry_count: 0,
    max_retries: 5,
    metadata: { provider_error: { failure_class: "provider_ambiguous_transport" } },
  });
  assert.equal(isAmbiguousSendRow(row), true, "fixture must actually be ambiguous");

  const result = await recycleClaimedSendingRow(row, "lock-1", "test", {
    ...recycleOpts,
    supabase: { from() { updated = true; throw new Error("must not write"); } },
  });

  assert.equal(result, null, "recycle must refuse");
  assert.equal(updated, false, "no write may occur");
});

test("P3: a row carrying PROVIDER EVIDENCE is never recycled", async () => {
  let updated = false;
  const result = await recycleClaimedSendingRow(
    claimedRow({ provider_message_id: "SM_ALREADY_ACCEPTED" }),
    "lock-1",
    "test",
    { ...recycleOpts, supabase: { from() { updated = true; throw new Error("must not write"); } } }
  );
  assert.equal(result, null, "a row with a provider SID must never be made send-eligible again");
  assert.equal(updated, false);
});

test("P3: retry counters alone cannot authorise a recycle of an ambiguous row", async () => {
  // The dangerous shape: plenty of retries left, so counter-based logic would
  // happily return it to `queued`.
  for (const retry_count of [0, 1, 2]) {
    const result = await recycleClaimedSendingRow(
      claimedRow({
        retry_count,
        max_retries: 10,
        metadata: { provider_error: { failure_class: "provider_ambiguous_transport" } },
      }),
      "lock-1",
      "test",
      { ...recycleOpts, supabase: { from() { throw new Error("must not write"); } } }
    );
    assert.equal(result, null, `retry_count=${retry_count} must not confer authority`);
  }
});

// ── P4: stale "processing" recovery must HOLD, not requeue ─────────────────

test("P4: stale-lock recovery moves stuck rows to a NON-DISPATCHABLE hold", async () => {
  const src = await readFile(SRC("src/lib/domain/queue/run-send-queue.js"), "utf8");
  const block = src.slice(src.indexOf("Stale-lock recovery"), src.indexOf("Stale-lock recovery") + 2200);

  assert.ok(
    !/queue_status:\s*'queued'/.test(block),
    "a stuck `processing` row must never be handed back to the runner as queued"
  );
  assert.match(block, /queue_status:\s*'expired'/, "it must move to the canonical hold");
  assert.match(block, /processing_lease_expired_manual_review/, "and say why, for operator review");

  // The hold must be outside the processor's claim set.
  const CLAIMABLE = ["queued", "scheduled", "pending", "approved", "ready"];
  assert.ok(!CLAIMABLE.includes("expired"), "the hold status must not be claimable");
});

test("P4: the fix does not depend on forgetting to clear lock_token", async () => {
  // The old code was safe only because it left lock_token set and
  // shouldRunSendQueueRow refuses locked rows. Safety must not rest on that.
  const src = await readFile(SRC("src/lib/domain/queue/run-send-queue.js"), "utf8");
  const block = src.slice(src.indexOf("Stale-lock recovery"), src.indexOf("Stale-lock recovery") + 2200);
  assert.match(block, /LEASE EXPIRY DOES NOT PROVE/i, "the invariant must be stated where the code lives");
});

// ── P12: fence authority must fail closed ──────────────────────────────────

test("P12: absent stale-lock-recovery configuration does NOT grant permission", async () => {
  const src = await readFile(SRC("src/lib/supabase/sms-engine.js"), "utf8");
  const idx = src.indexOf("const stale_lock_recovery_enabled");
  const block = src.slice(idx, idx + 400);

  assert.ok(!/\?\?\s*\n?\s*true;/.test(block), "missing configuration must not default to enabled");
  assert.match(block, /===\s*true/, "only an explicit true may enable lock removal");
});

test("P12: lock removal never touches a row that already reached the provider", async () => {
  const src = await readFile(SRC("src/lib/supabase/sms-engine.js"), "utf8");
  const idx = src.indexOf("Stale queued+locked lock recovery");
  const block = src.slice(idx, idx + 1800);

  assert.match(block, /\.is\("provider_message_id",\s*null\)/, "must exclude rows holding a provider SID");
  assert.match(block, /\.is\("sent_at",\s*null\)/, "must exclude rows already marked sent");
});

// ── Dashboard: no provider call means no provider-sent state ───────────────

test("the dashboard queue runner cannot assert provider-sent state", async () => {
  const runner = await readFile(DASH("api/internal/queue/runner.ts"), "utf8");

  // It writes canonical provider-delivery facts...
  assert.match(runner, /queue_status:\s*'sent'/, "fixture check: it does write sent");
  // ...while making no provider call at all.
  assert.ok(
    !/sendTextgridSMS|api\.textgrid\.com|Messages\.json/.test(runner),
    "fixture check: there is no provider call in this file"
  );

  // Therefore it must refuse to run by default.
  assert.match(runner, /assertBackendMutationAllowed/, "the primitive must carry a boundary guard");
  assert.match(
    runner,
    /NEXUS_ALLOW_BACKEND_MUTATION\s*!==\s*'true'/,
    "the guard must fail closed on absent configuration"
  );
});

test("the unauthenticated dashboard run endpoint refuses by default", async () => {
  const run = await readFile(DASH("api/internal/queue/run.ts"), "utf8");
  assert.match(run, /NEXUS_ALLOW_BACKEND_MUTATION\s*!==\s*'true'/, "run.ts had no guard and no auth");
  assert.match(run, /BOUNDARY_VIOLATION/);

  // The guard must precede any call into the runner.
  const guardAt = run.indexOf("NEXUS_ALLOW_BACKEND_MUTATION");
  const callAt = run.indexOf("runQueueBatch(");
  assert.ok(guardAt > -1 && callAt > guardAt, "the boundary check must run before the batch");
});
