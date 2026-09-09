/**
 * compliance-not-gated-on-reply.test.mjs
 *
 * The second half of the 2026-09-09 opt-out defect. executeInboundAutomationDecision
 * received `dryRun: dryRun || !v2_should_queue_live` from the inbound path. An
 * opt-out by definition never queues a reply, so that expression was ALWAYS true
 * for a STOP, and both compliance actions -- the durable suppression write and
 * the cancellation of anything already queued to that seller -- were skipped
 * while still reporting ok:true.
 *
 * Contract: suppression follows the caller's real write authority
 * (complianceDryRun), never the reply decision. Reply/queue behaviour itself is
 * untouched, and omitting the new argument preserves the old behaviour exactly
 * for every existing caller (inbound-replay-engine passes dryRun:true only).
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

// applyInboundAutomationDecision reads `primary_intent` and `compliance_flag`
// (apply-inbound-automation-decision.js ~376-378); either one alone routes to
// should_suppress_contact. This mirrors a real STOP classification.
const OPT_OUT_CLASSIFICATION = {
  primary_intent: "opt_out",
  compliance_flag: "stop_texting",
  confidence: 0.99,
};

function harness() {
  const seen = { suppression: [], cancellations: [] };
  const supabase = {
    from(table) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        gte: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        range: () => Promise.resolve({ data: [], error: null }),
        upsert: (row, options) => {
          if (table === "sms_suppression_list") seen.suppression.push({ row, options });
          return Promise.resolve({ data: [row], error: null });
        },
        insert: (row) => {
          if (table === "sms_suppression_list") seen.suppression.push({ row, options: null });
          return Promise.resolve({ data: [row], error: null });
        },
        update: () => chain,
        then: undefined,
      };
      return chain;
    },
  };
  return { seen, supabase };
}

async function runOptOut({ dryRun, complianceDryRun }) {
  const { seen, supabase } = harness();
  const args = {
    message: "STOP",
    threadKey: "thread-stop-1",
    inboundFrom: "+13055550199",
    inboundTo: "+17866052999",
    // Context is required: applyInboundAutomationDecision returns
    // human_review_reason 'missing_context' BEFORE the compliance branch when a
    // thread has no identity at all. Real campaign threads always carry it.
    propertyId: "prop-1",
    prospectId: "pros-1",
    ownerId: "mo-1",
    phoneId: "ph-1",
    latestThreadContext: { property_id: "prop-1", master_owner_id: "mo-1" },
    classification: OPT_OUT_CLASSIFICATION,
    supabase,
    supabaseClient: supabase,
    applySuppression: true,
    enableQueueInsert: false,
    dryRun,
    ...(complianceDryRun === undefined ? {} : { complianceDryRun }),
  };
  let result = null;
  try {
    result = await executeInboundAutomationDecision(args);
  } catch {
    // The decision engine needs far more context than a unit harness supplies;
    // what this test asserts is whether the COMPLIANCE branch attempted a write,
    // which is observable on `seen` regardless of how the call finishes.
  }
  return { seen, result };
}

test("a live inbound writes durable suppression even though no reply is queued", async () => {
  // dryRun true is exactly what the inbound path passes for an opt-out
  // (dryRun || !v2_should_queue_live). complianceDryRun false is the caller's
  // real authority on the live webhook.
  const { seen } = await runOptOut({ dryRun: true, complianceDryRun: false });
  assert.equal(
    seen.suppression.length >= 1,
    true,
    "compliance must not be gated on the reply decision"
  );
  const row = seen.suppression[0].row;
  assert.equal(row.phone_e164, "+13055550199");
  assert.equal(row.suppression_type, "opt_out");
  assert.equal(row.is_active, true);
});

test("omitting complianceDryRun preserves the old behaviour for existing callers", async () => {
  // inbound-replay-engine and every existing test double pass dryRun only.
  const { seen } = await runOptOut({ dryRun: true, complianceDryRun: undefined });
  assert.equal(seen.suppression.length, 0, "must still be a no-op without the new argument");
});

test("an explicit compliance dry run writes nothing", async () => {
  const { seen } = await runOptOut({ dryRun: true, complianceDryRun: true });
  assert.equal(seen.suppression.length, 0);
});
