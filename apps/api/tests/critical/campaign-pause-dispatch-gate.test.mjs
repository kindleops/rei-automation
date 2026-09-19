/**
 * CAMPAIGN PAUSE DOES NOT STOP ALREADY-MATERIALIZED QUEUE WORK (§9).
 *
 * Found during live canary certification, not by reading: the campaign was
 * PAUSED, the scoped-canary runner was invoked against its one materialized
 * row, and the message was sent anyway — provider accepted, SID issued,
 * delivered.
 *
 *   campaign status at send time : paused
 *   provider_message_id          : SMOYUkH9NB47FNojpVoAUKGuA==
 *   final queue status           : delivered
 *
 * WHY IT HAPPENS. Pause is a CAMPAIGN-lifecycle state. Dispatch authority is
 * evaluated per QUEUE ROW, and nothing in that path reads `campaigns.status` —
 * `queue_atomic_claim_send_row` references pause only in its own comments and
 * never joins the campaigns table. So a row that was materialized while the
 * campaign was live keeps its own momentum after the campaign is paused.
 *
 * WHAT AN OPERATOR REASONABLY EXPECTS. Pausing a campaign stops it sending.
 * That is the entire point of the control, and it is what the Campaign UI
 * implies. Today it stops FUTURE materialization, not pending work.
 *
 * This test documents the gap at the seam where it would be closed, so the
 * behaviour cannot be mistaken for intended. It asserts the CURRENT contract
 * (dispatch authority is row-scoped) rather than asserting a fix that does not
 * exist — a test that failed here would be reporting a defect it cannot cause
 * anyone to fix.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

test("DISPATCH AUTHORITY NEVER CONSULTS CAMPAIGN STATUS — the pause gap", async () => {
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/queue/process-send-queue.js", import.meta.url), "utf8");

  // If this ever becomes false, campaign pause has been wired into dispatch
  // and the gap below is closed — update this test deliberately, with a live
  // re-proof, rather than deleting it.
  assert.ok(
    !/campaigns?\.status|campaign_status\s*===\s*['"]paused/.test(source),
    "process-send-queue does not read campaign status; if it now does, re-prove the pause gate live",
  );
});

test("the claim RPC does not join the campaigns table either", async () => {
  /**
   * Recorded so the gap is attributed to the right layer. Closing it means
   * either the claim RPC reading `campaigns.status`, or the runner refusing a
   * row whose campaign is paused — a decision with real consequences for
   * in-flight work, not a one-line patch.
   */
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/queue/run-scoped-campaign-canary.js", import.meta.url), "utf8");
  assert.ok(
    !/\.from\(['"]campaigns['"]\)/.test(source),
    "the scoped canary runner does not load the campaign; pause is not enforced here",
  );
});

test("pausing a campaign DOES stop further materialization", async () => {
  // The half that works, stated so the gap is not over-read: the planner
  // refuses to build new queue work for a non-queueable campaign status.
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/campaigns/campaign-activation-orchestrator.js", import.meta.url), "utf8");
  assert.match(source, /isQueueableStatus/);
});
