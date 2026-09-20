/**
 * PAUSING A CAMPAIGN STOPS IT SENDING — INCLUDING WORK ALREADY QUEUED.
 *
 * DO NOT DELETE THIS FILE. It encodes a defect that was proven LIVE, against
 * the real provider, during Campaign certification on 2026-09-19:
 *
 *   campaign status at dispatch : paused
 *   queue row                   : c58b606d-f5dc-43ca-b73e-06efad02bbb8
 *   provider result             : ACCEPTED, SID SMOYUkH9NB47FNojpVoAUKGuA==
 *   final queue status          : delivered
 *
 * A real message reached a real handset from a campaign an operator had paused.
 *
 * The cause was layering: pause is a CAMPAIGN lifecycle state, dispatch
 * authority is evaluated per QUEUE ROW, and nothing in that path read
 * `campaigns.status`. Pause stopped future materialization while already-queued
 * work kept its own momentum.
 *
 * If these tests are ever removed or relaxed, that send becomes possible again.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  CAMPAIGN_PAUSED_REASON,
  CAMPAIGN_STATE_UNREADABLE_REASON,
  evaluateCampaignDispatchAuthority,
} from "@/lib/domain/queue/campaign-execution-authority.js";

const campaignRow = (over = {}) => ({
  id: "c58b606d-f5dc-43ca-b73e-06efad02bbb8",
  campaign_id: "b27c6890-ffc9-471f-8a2f-be8afd5ec165",
  to_phone_number: "+13059807795",
  from_phone_number: "+14693131600",
  ...over,
});

const withStatus = (status) => ({ loadCampaignStatus: async () => status });

// ── the historical shape

test("THE 2026-09-19 SHAPE: a paused campaign's queued row is REFUSED", async () => {
  const verdict = await evaluateCampaignDispatchAuthority(campaignRow(), withStatus("paused"));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, CAMPAIGN_PAUSED_REASON);
  assert.equal(verdict.campaign_status, "paused");
});

test("an ACTIVE campaign's row proceeds to the later gates", async () => {
  for (const status of ["active", "scheduled", "running"]) {
    const verdict = await evaluateCampaignDispatchAuthority(campaignRow(), withStatus(status));
    assert.equal(verdict.ok, true, `${status} must not be blocked by the pause rule`);
  }
});

test("RESUME releases the SAME row — pause is reversible, not destructive", async () => {
  const row = campaignRow();
  assert.equal((await evaluateCampaignDispatchAuthority(row, withStatus("paused"))).ok, false);
  // Same row object, same id, nothing re-materialized.
  const resumed = await evaluateCampaignDispatchAuthority(row, withStatus("active"));
  assert.equal(resumed.ok, true);
});

// ── it must not break everything else in the queue

test("NON-CAMPAIGN TRAFFIC IS UNTOUCHED", async () => {
  // Manual Inbox, seller automation, buyer disposition, internal proof tooling —
  // a missing campaign id is the normal case, never an error.
  const verdict = await evaluateCampaignDispatchAuthority(
    { id: "q1", to_phone_number: "+13055551234" },
    { loadCampaignStatus: async () => { throw new Error("must not be consulted") } },
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.scope, "non_campaign_traffic");
});

// ── failure behaviour

test("UNREADABLE CAMPAIGN STATE DEFERS — it does not send, and does not fail the row", async () => {
  // An unreadable control plane is not permission to send. It is equally not
  // evidence the message is bad, so the row must not be burned.
  const verdict = await evaluateCampaignDispatchAuthority(campaignRow(), {
    loadCampaignStatus: async () => { throw new Error("db unreachable") },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, CAMPAIGN_STATE_UNREADABLE_REASON);
  // Deliberately NOT the paused reason — the operator did not pause anything.
  assert.notEqual(verdict.reason, CAMPAIGN_PAUSED_REASON);
});

test("a campaign id that resolves to nothing is not treated as active", async () => {
  const verdict = await evaluateCampaignDispatchAuthority(campaignRow(), {
    supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.scope, "campaign_not_found");
});

// ── scope discipline

test("only `paused` blocks — other lifecycle states are not casually swept in", async () => {
  /**
   * `archived` is applied to COMPLETED campaigns whose history must stay
   * readable. Blocking on it here would change lifecycle policy as a side
   * effect of a pause fix. Widening this set is a decision, not a tidy-up.
   */
  for (const status of ["archived", "completed", "draft", "built"]) {
    const verdict = await evaluateCampaignDispatchAuthority(campaignRow(), withStatus(status));
    assert.equal(verdict.ok, true, `${status} is not the pause rule's business`);
  }
});

// ── wiring: the check must be REACHED, before the provider

test("THE DISPATCHER CONSULTS CAMPAIGN AUTHORITY BEFORE EITHER PROCESSOR", async () => {
  /**
   * The original defect was not a wrong rule — it was NO rule on this path. A
   * module with no caller would reproduce it exactly, so this reads the
   * dispatcher and requires the call site to sit ahead of the delegation that
   * eventually reaches the provider.
   */
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/queue/process-send-queue.js", import.meta.url), "utf8");

  const authorityAt = source.indexOf("await evaluateCampaignDispatchAuthority(");
  const delegateAt = source.indexOf("await processSupabaseQueueItem(resolved_queue_row, deps)");
  assert.ok(authorityAt > 0, "the dispatcher must consult campaign execution authority");
  assert.ok(delegateAt > 0);
  assert.ok(
    authorityAt < delegateAt,
    "campaign authority must be evaluated BEFORE the processor that reaches the provider",
  );
});

test("a pause verdict is skipped/deferred, never a provider failure", async () => {
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/queue/process-send-queue.js", import.meta.url), "utf8");
  const block = source.slice(
    source.indexOf("const campaign_authority = await evaluateCampaignDispatchAuthority("),
    source.indexOf("const result = isSupabaseQueueRow("),
  );
  assert.match(block, /skipped:\s*true/);
  assert.match(block, /sent:\s*false/);
  // A held row must not be reported as something the provider rejected.
  assert.ok(!/failed/.test(block), "pause must not present as a failure");
});
