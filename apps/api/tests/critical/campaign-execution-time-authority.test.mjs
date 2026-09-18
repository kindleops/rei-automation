/**
 * EXECUTION-TIME AUTHORITY BEATS CAMPAIGN-TIME READINESS (§12-§15, §23).
 *
 * A campaign decides who is reachable when it is built. Dispatch happens later —
 * minutes or days later — and in between the sender can be paused, the number
 * can start cooling, its daily cap can fill, the destination can opt out, and
 * the operator can hit emergency stop. Campaign readiness is a PREFLIGHT; it is
 * not permission to send, and a stale "ready" must never outrank the state at
 * the moment of dispatch.
 *
 * These assert the guards the dispatcher actually consults, so a campaign row
 * cannot inherit an eligibility decision that has since expired. They are
 * deliberately fixture-driven rather than run against the live control plane:
 * flipping the production emergency stop or pausing a real sender to observe a
 * refusal would halt genuine seller traffic to prove a point the code already
 * answers, which is not a safe test context in any reading of the word.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOutboundNumberEligibility } from "@/lib/supabase/sms-engine.js";
import { evaluateCanonicalSendAuthority } from "@/lib/domain/queue/canonical-send-authority.js";

const campaignRow = (over = {}) => ({
  id: "q-campaign-1",
  campaign_id: "b299ddde-43ea-48b6-ac7b-c7e53688d49e",
  campaign_target_id: "618dc4d9-08e3-42b5-8c21-4d2aa9d586d9",
  to_phone_number: "+13059807795",
  from_phone_number: "+14693131600",
  queue_status: "queued",
  touch_number: 1,
  ...over,
});

// ── §12 the sender that was eligible at build time may not be at dispatch

test("§12 a PAUSED sender blocks dispatch", () => {
  const verdict = evaluateOutboundNumberEligibility({ status: "paused" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /status_paused/);
  // Not terminal: the number can come back, so the row must not be failed off.
  assert.equal(verdict.terminal, false);
});

test("§12 a COOLING sender blocks dispatch until its cooldown expires", () => {
  const cooling = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  assert.equal(evaluateOutboundNumberEligibility({ cooling_until: cooling }).reason,
    "outbound_number_cooling_until");

  // And the SAME row is eligible once the cooldown has passed — the guard is a
  // clock, not a latch.
  const expired = new Date(Date.now() - 60 * 1000).toISOString();
  assert.equal(evaluateOutboundNumberEligibility({ cooling_until: expired }).ok, true);
});

test("§12 a sender AT ITS DAILY CAP blocks dispatch", () => {
  assert.equal(evaluateOutboundNumberEligibility({ daily_limit: 150, messages_sent_today: 150 }).reason,
    "outbound_number_daily_limit_reached");
  assert.equal(evaluateOutboundNumberEligibility({ daily_limit: 150, messages_sent_today: 149 }).ok, true);
});

test("§12 an unhealthy sender blocks dispatch", () => {
  const verdict = evaluateOutboundNumberEligibility({ health_state: "quarantined" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /health_quarantined/);
});

test("§12 a sender that is not in the fleet at all is TERMINAL", () => {
  // Nothing will make it eligible later, so retrying forever would be a lie.
  const verdict = evaluateOutboundNumberEligibility(null);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.terminal, true);
});

test("§12 NONE of these produce a send — they are refusals, not failures", () => {
  // The distinction matters: a transport failure consumes a retry and reports a
  // provider fault for a message the provider never saw.
  for (const row of [
    { status: "paused" },
    { health_state: "quarantined" },
    { cooling_until: new Date(Date.now() + 3600_000).toISOString() },
    { daily_limit: 1, messages_sent_today: 5 },
  ]) {
    const verdict = evaluateOutboundNumberEligibility(row);
    assert.equal(verdict.ok, false);
    assert.equal(typeof verdict.reason, "string");
  }
});

// ── §15 the operator stop outranks everything, including a scheduled campaign

test("§15 EMERGENCY STOP refuses a campaign row that is otherwise perfect", async () => {
  const verdict = await evaluateCanonicalSendAuthority(campaignRow(), {
    getSystemValue: async (key) => {
      if (key === "queue_emergency_stop_at") return new Date().toISOString();
      if (key === "queue_execution_mode") return "live";
      if (key === "queue_processor_mode") return "live";
      if (key === "campaign_mode") return "live_limited";
      return null;
    },
  });
  assert.equal(verdict.ok, false, JSON.stringify(verdict));
});

test("§15 a campaign schedule is not a licence to cross the stop", async () => {
  // The whole hazard: work scheduled while the system was open, dispatching
  // after the operator closed it.
  const verdict = await evaluateCanonicalSendAuthority(
    campaignRow({ queue_status: "scheduled", scheduled_for: new Date(Date.now() - 1000).toISOString() }),
    {
      getSystemValue: async (key) =>
        key === "queue_emergency_stop_at" ? new Date().toISOString() : "live",
    },
  );
  assert.equal(verdict.ok, false);
});


// ── §13/§14 the gates must be WIRED, not merely written

test("§13 THE DISPATCHER ACTUALLY CONSULTS SEND-TIME COMPLIANCE", async () => {
  /**
   * A compliance module with no caller passes every unit test it has while
   * every message sails past it. This reads the dispatcher itself.
   *
   * `block-send-at-compliance.js` exports two things: `blockSendAtCompliance`
   * (the writer) and `evaluateAndBlockSendAtCompliance` (the gate that reads
   * live suppression first and only then blocks). The DISPATCHER must import
   * the gate — importing only the writer would mean nothing ever evaluates.
   */
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/queue/process-send-queue.js", import.meta.url), "utf8");

  assert.match(source, /evaluateAndBlockSendAtCompliance/,
    "the dispatcher must consult send-time compliance");

  // And it must be CALLED, not just imported.
  const calls = source.match(/await evaluateAndBlockSendAtCompliance\(/g) || [];
  assert.ok(calls.length >= 1, `expected at least one call site, found ${calls.length}`);

  const mod = await import("@/lib/domain/queue/block-send-at-compliance.js");
  assert.equal(typeof mod.evaluateAndBlockSendAtCompliance, "function");
});

test("§13 send-time compliance fails CLOSED for automated sends", async () => {
  // A campaign send is not a human pressing send. If contactability cannot be
  // established, the safe answer is to refuse, not to proceed.
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/queue/block-send-at-compliance.js", import.meta.url), "utf8");
  assert.match(source, /fail_closed_for_automated:\s*!manual_operator_send/);
});

test("§14 the dispatcher evaluates the contact window before sending", async () => {
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/queue/process-send-queue.js", import.meta.url), "utf8");
  assert.match(source, /evaluate_contact_window\(/);
  // A campaign row is NOT manual_inbox, so it cannot inherit the quiet-hours
  // exemption that path carries.
  assert.match(source, /fresh_manual_inbox_send/);
});
