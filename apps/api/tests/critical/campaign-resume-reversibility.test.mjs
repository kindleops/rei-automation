/**
 * RESUMING IS NOT LAUNCHING (§1-§11).
 *
 * Resume reused the ACTIVATION validator, which requires a target at
 * `target_status = 'ready'`. Materializing a target into the queue moves it to
 * `planned` — so a campaign whose recipients had ALL been queued had zero
 * "ready" targets by construction and could never resume:
 *
 *     Resume blocked — No ready recipients in target snapshot
 *
 * Pause held the work correctly and then nothing could release it. Pause was
 * one-way for exactly the campaigns most likely to be paused: the running ones.
 *
 * Launch asks "is there new work to start?". Resume asks "is there work to
 * continue?". These tests hold that distinction, and hold the line that ONLY
 * the missing-recipients blocker is answerable by pending queue work.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCampaignResumeReadiness,
  isResumableQueueRow,
} from "@/lib/domain/campaigns/campaign-resume-readiness.js";

const CAMPAIGN = "07bb5862-eb32-40e0-b8dc-7b23397b18ba";

/** The readiness verdict a fully-drained campaign produces. */
const drained = {
  launch_readiness: "blocked",
  blockers: ["No ready recipients in target snapshot"],
  blocker_codes: ["no_ready_recipients"],
};

const rows = (...list) => ({ loadCampaignQueueRows: async () => list });
const row = (over = {}) => ({ id: "q1", campaign_id: CAMPAIGN, queue_status: "scheduled", ...over });

// ── Case 1

test("fresh recipients remain — Resume succeeds, unchanged behaviour", async () => {
  const verdict = await evaluateCampaignResumeReadiness(CAMPAIGN, { launch_readiness: "ready" }, {});
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, "launch_readiness_not_blocked");
});

// ── Cases 2, 3, 8 — the defect

test("NO FRESH RECIPIENTS BUT ONE PENDING ROW — Resume succeeds", async () => {
  const verdict = await evaluateCampaignResumeReadiness(CAMPAIGN, drained, rows(row()));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, "resumable_queue_work_exists");
  assert.equal(verdict.resumable_queue_rows, 1);
});

test("a fully-drained campaign with several pending rows resumes", async () => {
  const verdict = await evaluateCampaignResumeReadiness(
    CAMPAIGN, drained, rows(row({ id: "a" }), row({ id: "b" }), row({ id: "c", queue_status: "queued" })));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.resumable_queue_rows, 3);
});

test("THE PAUSED ROW SHAPE QUALIFIES — the exact row pause leaves behind", async () => {
  // Live-proven shape: scheduled, no SID, retry_count 0, never sent.
  const paused = row({ queue_status: "scheduled", provider_message_id: null, sent_at: null, retry_count: 0 });
  assert.equal(isResumableQueueRow(paused), true);
  const verdict = await evaluateCampaignResumeReadiness(CAMPAIGN, drained, rows(paused));
  assert.equal(verdict.ok, true);
});

// ── Cases 4, 5, 6, 7 — history must not justify Resume

test("delivered history alone does NOT justify Resume", async () => {
  const verdict = await evaluateCampaignResumeReadiness(
    CAMPAIGN, drained, rows(row({ queue_status: "delivered", provider_message_id: "SM1", sent_at: "2026-09-19T22:58:54Z" })));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "no_fresh_recipients_and_no_pending_work");
});

test("cancelled history alone does NOT justify Resume", async () => {
  const verdict = await evaluateCampaignResumeReadiness(CAMPAIGN, drained, rows(row({ queue_status: "cancelled" })));
  assert.equal(verdict.ok, false);
});

test("terminal failures alone do NOT justify Resume", async () => {
  const verdict = await evaluateCampaignResumeReadiness(CAMPAIGN, drained, rows(row({ queue_status: "failed" })));
  assert.equal(verdict.ok, false);
});

test("mixed terminal history plus ONE pending row resumes", async () => {
  const verdict = await evaluateCampaignResumeReadiness(CAMPAIGN, drained, rows(
    row({ id: "a", queue_status: "delivered", provider_message_id: "SM1", sent_at: "2026-09-19T22:58:54Z" }),
    row({ id: "b", queue_status: "cancelled" }),
    row({ id: "c", queue_status: "scheduled" }),
  ));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.resumable_queue_rows, 1);
});

test("a row carrying a provider id is NOT pending, whatever its status says", async () => {
  // It already reached the provider; counting it would resume finished work.
  assert.equal(isResumableQueueRow(row({ queue_status: "scheduled", provider_message_id: "SM9" })), false);
  assert.equal(isResumableQueueRow(row({ queue_status: "scheduled", sent_at: "2026-09-19T22:58:54Z" })), false);
});

// ── the narrowness of the relaxation

test("OTHER BLOCKERS STILL BLOCK — pending work does not answer them", async () => {
  /**
   * Routing, send windows, templates and operator gates are real problems that
   * pending rows do not solve. Relaxing the whole verdict because one blocker
   * had an alternative answer would turn a narrow fix into a bypass.
   */
  const verdict = await evaluateCampaignResumeReadiness(CAMPAIGN, {
    launch_readiness: "blocked",
    blockers: ["No ready recipients in target snapshot", "No routable recipients"],
    blocker_codes: ["no_ready_recipients", "routing_zero"],
  }, rows(row()));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "blocked_for_other_reasons");
});

test("unreadable queue state is not evidence of resumable work", async () => {
  const verdict = await evaluateCampaignResumeReadiness(CAMPAIGN, drained, {
    loadCampaignQueueRows: async () => { throw new Error("db down") },
    supabase: { from: () => { throw new Error("db down") } },
  });
  assert.equal(verdict.ok, false);
});

// ── Cases 9, 10

test("RESUME ITSELF SENDS NOTHING", async () => {
  // It is a lifecycle authority decision. No provider, no dispatch, no queue
  // mutation — the evaluator only reads.
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/campaigns/campaign-resume-readiness.js", import.meta.url), "utf8");
  assert.ok(!/sendTextgridSMS|processSendQueue|\.update\(|\.insert\(/.test(source),
    "resume readiness must neither dispatch nor mutate");
});

test("activation semantics are untouched", async () => {
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/campaigns/campaign-launch-readiness.js", import.meta.url), "utf8");
  // The activation validator still demands a genuinely ready target.
  assert.match(source, /clean\(row\.target_status\) === 'ready'/);
  assert.match(source, /no_ready_recipients/);
});
