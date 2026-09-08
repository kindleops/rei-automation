/**
 * email-queue-runner.test.mjs
 *
 * The loop that makes the email transport reachable.
 *
 * The runner keeps exactly ONE decision: which row to work on next. Everything
 * about whether a row may be sent belongs to the seam, and a runner that formed
 * its own opinion would be a second authority. Before §11 the SMS runner decided
 * for itself that `queued` plus a retry budget meant "send", and called the
 * provider; these tests exist so the email runner never grows that habit.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { runEmailQueue, MAX_BATCH } from "@/lib/domain/email/run-email-queue.js";

/** A supabase double with a claimable email_queue. */
function makeDb(rows = [], over = {}) {
  const state = { rows: rows.map((r) => ({ ...r })), updates: [], scans: 0 };
  const db = {
    state,
    from(table) {
      if (table !== "email_queue") throw new Error(`unexpected table: ${table}`);
      const filters = {};
      const builder = {
        select() { return builder; },
        eq(column, value) { filters[column] = value; return builder; },
        or() { return builder; },
        order() { return builder; },
        limit() {
          state.scans += 1;
          return Promise.resolve({ data: over.scanError ? null : state.rows.filter((r) => r.queue_status === "queued"), error: over.scanError || null });
        },
        update(patch) {
          // Mirrors the real chain: .update().eq().eq().select().maybeSingle(),
          // and .update().eq() awaited directly. The conditional eq on
          // queue_status is what makes the claim a race-safe compare-and-set.
          const conditions = {};
          const apply = () => {
            const row = state.rows.find((r) => r.id === conditions.id);
            const status_matches =
              conditions.queue_status === undefined || row?.queue_status === conditions.queue_status;
            if (!row || !status_matches) return { data: null, error: null };
            Object.assign(row, patch);
            state.updates.push({ id: row.id, patch });
            return { data: { id: row.id, lock_token: patch.lock_token }, error: null };
          };
          const chain = {
            eq(column, value) { conditions[column] = value; return chain; },
            select() { return chain; },
            maybeSingle() { return Promise.resolve(apply()); },
            then(resolve, reject) { return Promise.resolve(apply()).then(resolve, reject); },
          };
          return chain;
        },
      };
      return builder;
    },
  };
  return db;
}

const row = (over = {}) => ({
  id: `eq-${Math.random().toString(36).slice(2, 8)}`,
  queue_status: "queued",
  to_email: "seller@example.com",
  subject: "About your property",
  email_body: "<p>hello</p>",
  campaign_target_id: "11111111-1111-4111-8111-111111111111",
  touch_number: 1,
  ...over,
});

const SENT = async () => ({
  ok: true, sent: true, provider_invoked: true, stage: "complete",
  provider_message_id: "<m1@brevo>", logical_communication_id: "lc-1",
});

const deps = (over = {}) => ({
  getSystemFlag: async () => true,
  now: () => "2026-09-08T18:00:00.000Z",
  dispatch: SENT,
  ...over,
});

// ── the kill switch stops the whole run ────────────────────────────────────

test("the kill switch aborts before any row is touched", async () => {
  const db = makeDb([row(), row()]);
  let dispatched = 0;
  const result = await runEmailQueue({}, deps({
    supabase: db,
    getSystemFlag: async () => false,
    dispatch: async () => { dispatched += 1; return SENT(); },
  }));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "email_channel_disabled");
  assert.equal(dispatched, 0);
  assert.equal(db.state.scans, 0, "a disabled channel should not even scan");
});

// ── claiming ───────────────────────────────────────────────────────────────

test("a claimed row is marked sending before dispatch", async () => {
  const db = makeDb([row({ id: "eq-1" })]);
  await runEmailQueue({}, deps({ supabase: db }));
  const claim = db.state.updates.find((u) => u.patch.queue_status === "sending");
  assert.ok(claim, "the row was dispatched without being claimed");
  assert.ok(claim.patch.lock_token, "a claim must carry a token");
  assert.equal(claim.patch.is_locked, true);
});

test("a row already taken by another worker is skipped, not double-sent", async () => {
  const db = makeDb([row({ id: "eq-1" })]);
  // Simulate the race: the row is no longer `queued` by the time we claim.
  db.state.rows[0].queue_status = "sending";
  let dispatched = 0;
  const result = await runEmailQueue({}, deps({
    supabase: db, dispatch: async () => { dispatched += 1; return SENT(); },
  }));

  assert.equal(dispatched, 0);
  assert.equal(result.claimed, 0);
});

test("a successful send records the provider id and the communication", async () => {
  const db = makeDb([row({ id: "eq-1" })]);
  const result = await runEmailQueue({}, deps({ supabase: db }));

  assert.equal(result.sent, 1);
  const final = db.state.rows[0];
  assert.equal(final.queue_status, "sent");
  assert.equal(final.provider_message_id, "<m1@brevo>");
  assert.equal(final.logical_communication_id, "lc-1");
  assert.equal(final.is_locked, false, "a settled row must not stay locked");
});

// ── refusals release rather than strand ────────────────────────────────────

test("a not-yet-sendable row is RELEASED, not left locked", async () => {
  // Otherwise a suppressed recipient strands its row as permanently in-flight,
  // and the queue fills with work nobody can see is stuck.
  const db = makeDb([row({ id: "eq-1" })]);
  const result = await runEmailQueue({}, deps({
    supabase: db,
    dispatch: async () => ({
      ok: false, sent: false, provider_invoked: false, stage: "eligibility",
      reason: "cross_channel_cooldown_active", next_eligible_at: "2026-09-09T18:00:00.000Z",
    }),
  }));

  assert.equal(result.released, 1);
  const final = db.state.rows[0];
  assert.equal(final.queue_status, "queued", "it must be visibly waiting, not locked");
  assert.equal(final.is_locked, false);
  assert.equal(final.scheduled_for, "2026-09-09T18:00:00.000Z",
    "a known next-eligible instant should defer the row rather than busy-loop it");
});

test("a sender refusal releases too", async () => {
  const db = makeDb([row({ id: "eq-1" })]);
  const result = await runEmailQueue({}, deps({
    supabase: db,
    dispatch: async () => ({ ok: false, sent: false, stage: "sender", reason: "sender_daily_cap_reached" }),
  }));
  assert.equal(result.released, 1);
  assert.equal(db.state.rows[0].queue_status, "queued");
});

test("a transport refusal FAILS the row rather than releasing it", async () => {
  // The seam has already recorded a durable outcome. Releasing would invite a
  // second attempt the attempt ledger has not authorised.
  const db = makeDb([row({ id: "eq-1" })]);
  await runEmailQueue({}, deps({
    supabase: db,
    dispatch: async () => ({
      ok: false, sent: false, provider_invoked: true, stage: "complete",
      reason: "invalid_to_address", logical_communication_id: "lc-1",
    }),
  }));
  assert.equal(db.state.rows[0].queue_status, "failed");
  assert.equal(db.state.rows[0].failed_reason, "invalid_to_address");
});

test("a dispatch that THROWS fails the row rather than releasing it", async () => {
  // A throw is ambiguous by definition: we cannot tell whether a request left
  // this process, so the row must not become available for another worker.
  const db = makeDb([row({ id: "eq-1" })]);
  const result = await runEmailQueue({}, deps({
    supabase: db, dispatch: async () => { throw new Error("boom"); },
  }));

  assert.equal(result.refused, 1);
  assert.equal(db.state.rows[0].queue_status, "failed");
  assert.equal(db.state.rows[0].failed_reason, "dispatch_threw_outcome_unknown");
});

// ── abort conditions ───────────────────────────────────────────────────────

test("a runtime brake aborts the run instead of repeating the refusal", async () => {
  const db = makeDb([row(), row(), row()]);
  let dispatched = 0;
  const result = await runEmailQueue({}, deps({
    supabase: db,
    dispatch: async () => {
      dispatched += 1;
      return { ok: false, sent: false, stage: "kill_switch", reason: "email_channel_disabled" };
    },
  }));

  assert.equal(dispatched, 1, "grinding through the batch produces the same refusal N times");
  assert.equal(result.aborted, "email_channel_disabled");
});

test("an unavailable ledger aborts the run", async () => {
  const db = makeDb([row(), row()]);
  const result = await runEmailQueue({}, deps({
    supabase: db,
    dispatch: async () => ({ ok: false, sent: false, stage: "store", reason: "logical_communication_store_unavailable" }),
  }));
  assert.equal(result.aborted, "logical_communication_store_unavailable");
});

// ── dry run ────────────────────────────────────────────────────────────────

test("a dry run claims nothing and changes nothing", async () => {
  // A dry run that claimed rows would block the real runner behind work it never
  // intended to do.
  const db = makeDb([row({ id: "eq-1" }), row({ id: "eq-2" })]);
  const result = await runEmailQueue({ dry_run: true }, deps({
    supabase: db,
    dispatch: async () => ({ ok: true, sent: false, dry_run: true, stage: "dry_run" }),
  }));

  assert.equal(result.dry_run, true);
  assert.equal(result.claimed, 0);
  assert.equal(db.state.updates.length, 0, "a dry run wrote to the queue");
  assert.equal(db.state.rows.every((r) => r.queue_status === "queued"), true);
});

// ── bounds and failure modes ───────────────────────────────────────────────

test("the batch size is clamped", async () => {
  const db = makeDb([]);
  for (const requested of [9999, -1, 0, "lots", null]) {
    const result = await runEmailQueue({ limit: requested }, deps({ supabase: db }));
    assert.equal(result.ok, true, `limit ${requested} broke the run`);
  }
  assert.ok(MAX_BATCH <= 50, "this is a transport loop, not a campaign sender");
});

test("a queue we cannot READ is not an empty queue", async () => {
  const db = makeDb([], { scanError: { message: "relation does not exist" } });
  const result = await runEmailQueue({}, deps({ supabase: db }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "email_queue_scan_failed");
});

test("an empty queue is a clean, successful no-op", async () => {
  const result = await runEmailQueue({}, deps({ supabase: makeDb([]) }));
  assert.equal(result.ok, true);
  assert.equal(result.scanned, 0);
  assert.equal(result.sent, 0);
});

test("the runner reports what it did, per row", async () => {
  const db = makeDb([row({ id: "eq-1" })]);
  const result = await runEmailQueue({}, deps({ supabase: db }));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].queue_id, "eq-1");
  assert.equal(result.results[0].sent, true);
  assert.equal(result.results[0].logical_communication_id, "lc-1");
});
