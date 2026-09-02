import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { runInboundIntelligencePhase } from "@/lib/domain/seller-flow/run-inbound-intelligence-phase.js";
import { COVERAGE_STATES } from "@/lib/domain/seller-flow/coverage-net/coverage-contract.js";
import { createPodioItem } from "../helpers/test-helpers.js";

// §5: the persisted intelligence snapshot (audit row + decision ledger) must
// carry the coverage verdict of the FINAL post-override decision. Before this
// the coverage net ran only in the executor, so the durable record never said
// whether the turn was covered or which owned workflow held it. The coverage
// is ADDITIVE: it is read for its fields only and never written back into
// canonical_decision, so no send flag can be flipped by it.

function classification(intent, overrides = {}) {
  return {
    primary_intent: intent,
    detected_intent: intent,
    confidence: 0.94,
    language: "English",
    automation_decision: { auto_reply_allowed: true },
    ...overrides,
  };
}

function context() {
  return {
    found: true,
    ids: { brain_item_id: 201, master_owner_id: 21, prospect_id: 31, property_id: "234334277", phone_item_id: 51 },
    items: {
      brain_item: createPodioItem(201),
      phone_item: createPodioItem(51),
      master_owner_item: createPodioItem(21),
      property_item: createPodioItem(41),
    },
    summary: { conversation_stage: "Ownership Confirmation", language_preference: "English", property_address: "123 Main St" },
  };
}

async function phase(intent, message) {
  return runInboundIntelligencePhase({
    message,
    threadKey: "+16318047551",
    propertyId: "234334277",
    prospectId: "31",
    ownerId: "21",
    phoneId: "51",
    classification: classification(intent),
    latestThreadContext: context(),
    context: context(),
    route: { stage: "Ownership Confirmation", use_case: "ownership_check" },
    inboundFrom: "+16318047551",
    inboundEventId: `evt-coverage-${intent}`,
    auto_reply_mode: "disabled",
    execution_allowed: false,
  });
}

test("the snapshot carries a non-missing coverage verdict for an ordinary turn", async () => {
  const r = await phase("ownership_confirmed", "Yes I own it");
  const c = r.intelligence_snapshot.coverage;
  assert.ok(c, "coverage block must be present on the snapshot");
  assert.ok(c.coverage_state, "coverage_state must be set");
  assert.notEqual(c.coverage_state, COVERAGE_STATES.MISSING);
  assert.equal(c.error, undefined);
});

test("a legal disclosure is held by legal_compliance_hold on the snapshot (outreach blocked, no clarifier)", async () => {
  const r = await phase("bankruptcy_disclosed", "I filed for bankruptcy last month");
  const c = r.intelligence_snapshot.coverage;
  assert.ok(c);
  assert.notEqual(c.coverage_state, COVERAGE_STATES.MISSING);
  assert.equal(c.exception_workflow?.key, "legal_compliance_hold");
  assert.equal(c.exception_workflow?.blocks_outreach, true);
  assert.notEqual(c.exception_workflow?.fallback_action, "send_safe_clarifier");
  assert.equal(c.safe_fallback_prepared, false, "no clarifier is prepared for a legal hold");
  assert.ok(c.exception_sla_deadline, "an owned workflow carries an SLA deadline");
});

test("a respondent class is routed to identity_clarification on the snapshot", async () => {
  const r = await phase("agent_representative_respondent", "I'm the listing agent for the owner");
  const c = r.intelligence_snapshot.coverage;
  assert.ok(c);
  assert.notEqual(c.coverage_state, COVERAGE_STATES.MISSING);
  assert.equal(c.exception_workflow?.key, "identity_clarification");
});

test("coverage is ADDITIVE: it never changes the canonical decision's send authority", async () => {
  const r = await phase("bankruptcy_disclosed", "I filed for bankruptcy last month");
  const cd = r.canonical_decision;
  // The executor's decision builder already ran the coverage net when it built
  // the decision; the phase-level coverage is a SEPARATE annotation computed
  // after every override. It must not be the same object, and the send flags
  // on the canonical decision must be exactly what the executor decided.
  assert.notEqual(r.intelligence_snapshot.coverage, cd, "coverage must be a separate object, not the decision");
  assert.equal(cd.should_queue_reply === true, false, "a legal disclosure never queues a reply");
  assert.equal(r.seller_stage_reply.queued, false);
  // the snapshot's canonical_decision is the executor's decision, unmodified by the coverage step
  assert.equal(r.intelligence_snapshot.canonical_decision, cd);
  assert.equal(r.intelligence_snapshot.coverage.exception_workflow?.key, "legal_compliance_hold");
});
