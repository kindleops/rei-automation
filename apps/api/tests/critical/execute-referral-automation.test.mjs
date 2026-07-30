import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateReferralAutomationEligibility,
  executeReferralAutomation,
} from "@/lib/domain/seller-flow/execute-referral-automation.js";
import { resolveInboundRelationship } from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";

test("unambiguous referral with phone is automation-eligible", () => {
  const message = "Never been the owner / His name is Sharon Schwartz / Tel (561)706-4622";
  const relationship = resolveInboundRelationship({
    message,
    classification: { primary_intent: "wrong_number", objection: "wrong_number" },
    source_event_id: "evt-1",
    source_thread_key: "+16318047551",
    source_contact_phone: "+16318047551",
    property_id: "234334277",
  });

  assert.equal(relationship.referred_automatic_send_allowed, true);
  const eligibility = evaluateReferralAutomationEligibility({ relationship });
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.review_required, false);
});

test("ambiguous multi-name referral routes to review", () => {
  const message = "Not the owner. His name is Tom Wilson or His name is Jerry Lee";
  const relationship = resolveInboundRelationship({
    message,
    classification: { primary_intent: "wrong_number" },
    property_id: "1017",
  });
  const eligibility = evaluateReferralAutomationEligibility({ relationship });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.review_required, true);
  assert.match(eligibility.reason, /ambiguous|multiple/);
});

test("name-only referral routes to review", () => {
  const relationship = resolveInboundRelationship({
    message: "I do not own it. His name is Maria Garcia",
    classification: { primary_intent: "wrong_number" },
    property_id: "1016",
  });
  const eligibility = evaluateReferralAutomationEligibility({ relationship });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.review_required, true);
});

test("executeReferralAutomation stays shadow-only when execution is gated", async () => {
  const message = "Never been the owner / His name is Sharon Schwartz / Tel (561)706-4622";
  const relationship = resolveInboundRelationship({
    message,
    classification: { primary_intent: "wrong_number" },
    source_event_id: "evt-2",
    source_thread_key: "+16318047551",
    source_contact_phone: "+16318047551",
    property_id: "234334277",
  });

  const result = await executeReferralAutomation({
    relationship,
    execution_allowed: false,
    auto_reply_mode: "disabled",
    context: { summary: { property_address: "123 Main St", language_preference: "English" } },
    inboundTo: "+15551234567",
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "shadow_only");
  assert.equal(result.queued, false);
});

// ── Source-inbound scope binding ────────────────────────────────────────────
// A referral outbound goes to a brand-new number that no thread allowlist will
// ever contain, so the guard is the SOURCE inbound's scope decision. On the
// webhook path execution_allowed is `seller_flow_execution_allowed` and on the
// recovery cron it is `recent && !dryRun` — neither carries the cutoff /
// allowlist verdict, so an out-of-scope inbound must not escape via a referral.

function referralFixture(sourceEventId) {
  return resolveInboundRelationship({
    message: "Never been the owner / His name is Sharon Schwartz / Tel (561)706-4622",
    classification: { primary_intent: "wrong_number", objection: "wrong_number" },
    source_event_id: sourceEventId,
    source_thread_key: "+15550002000",
    source_contact_phone: "+15550002000",
    property_id: "234334277",
  });
}

const REFERRAL_CONTEXT = {
  summary: { property_address: "123 Main St", language_preference: "English" },
};

test("a referral from an out-of-scope source inbound never executes for real", async () => {
  const result = await executeReferralAutomation({
    relationship: referralFixture("evt-scope-denied"),
    // The caller said "execute" and the mode permits sending, but the source
    // inbound failed the cutoff/allowlist gate.
    execution_allowed: true,
    source_scope_allowed: false,
    auto_reply_mode: "live_limited",
    context: REFERRAL_CONTEXT,
    inboundTo: "+15551234567",
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "shadow_only");
  assert.equal(result.queued, false);
  assert.equal(result.reason, "source_inbound_out_of_scope");
  assert.equal(result.source_scope_allowed, false);
});

test("source scope defaults to denied when a caller forgets to propagate it", async () => {
  const result = await executeReferralAutomation({
    relationship: referralFixture("evt-scope-default"),
    execution_allowed: true,
    auto_reply_mode: "live_limited",
    context: REFERRAL_CONTEXT,
    inboundTo: "+15551234567",
  });

  assert.equal(result.action, "shadow_only");
  assert.equal(result.queued, false);
  assert.equal(result.source_scope_allowed, false);
});

test("an in-scope source inbound clears the scope gate and reaches execution", async () => {
  // No Supabase client is injected, so the call stops at the persistence
  // boundary — which is exactly the proof that the scope gate let it through
  // rather than short-circuiting to shadow_only.
  const result = await executeReferralAutomation({
    relationship: referralFixture("evt-scope-allowed"),
    execution_allowed: true,
    source_scope_allowed: true,
    auto_reply_mode: "live_limited",
    context: REFERRAL_CONTEXT,
    inboundTo: "+15551234567",
  });

  assert.notEqual(result.action, "shadow_only");
});