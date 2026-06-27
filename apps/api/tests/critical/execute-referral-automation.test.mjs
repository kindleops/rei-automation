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