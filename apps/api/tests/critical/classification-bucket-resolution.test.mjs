import { describe, it } from "node:test";
import assert from "node:assert";
import {
  resolveThreadFlagsFromClassification,
  resolveUniversalStatusFromClassification,
  resolveInboxBucketFromClassification,
  resolveAutomationLaneFromClassification,
} from "../../src/lib/domain/inbox/resolve-inbox-state-from-classification.js";

describe("Classification Bucket Resolution", () => {
  it("resolves not_interested to disqualified lane with null bucket", () => {
    const classification = { primary_intent: "not_interested" };
    const bucket = resolveInboxBucketFromClassification(classification, { direction: "inbound" });
    const lane = resolveAutomationLaneFromClassification(classification, { direction: "inbound" }, {}, bucket);
    const status = resolveUniversalStatusFromClassification(classification, { direction: "inbound" });
    const flags = resolveThreadFlagsFromClassification(classification);

    assert.strictEqual(bucket, null);
    assert.strictEqual(lane, "disqualified");
    assert.strictEqual(status.universal_status, "dead");
    assert.strictEqual(status.universal_stage, "not_interested");
    assert.strictEqual(flags.not_interested, true);
  });

  it("resolves wrong_number to disqualified lane with null bucket", () => {
    const classification = { primary_intent: "wrong_number" };
    const bucket = resolveInboxBucketFromClassification(classification, { direction: "inbound" });
    const status = resolveUniversalStatusFromClassification(classification, { direction: "inbound" });
    const flags = resolveThreadFlagsFromClassification(classification);

    assert.strictEqual(bucket, null);
    assert.strictEqual(status.universal_status, "dead");
    assert.strictEqual(status.universal_stage, "wrong_number");
    assert.strictEqual(flags.wrong_number, true);
  });

  it("resolves STOP compliance to suppressed bucket", () => {
    const classification = { compliance_flag: "stop_texting" };
    const bucket = resolveInboxBucketFromClassification(classification, { direction: "inbound" });
    const status = resolveUniversalStatusFromClassification(classification, { direction: "inbound" });
    const flags = resolveThreadFlagsFromClassification(classification);

    assert.strictEqual(bucket, "suppressed");
    assert.strictEqual(status.universal_status, "suppressed");
    assert.strictEqual(status.universal_stage, "suppressed");
    assert.strictEqual(flags.opt_out, true);
  });

  it("resolves who is this? to new_replies bucket", () => {
    const classification = { primary_intent: "who_is_this" };
    const bucket = resolveInboxBucketFromClassification(classification, { direction: "inbound" });
    const status = resolveUniversalStatusFromClassification(classification, { direction: "inbound" });

    assert.strictEqual(bucket, "new_replies");
    assert.strictEqual(status.universal_status, "active");
    assert.strictEqual(status.universal_stage, "identity_question");
  });

  it("resolves priority interest (e.g. asking price) to priority bucket", () => {
    const classification = { primary_intent: "asking_price_provided", stage_hint: "Offer" };
    const bucket = resolveInboxBucketFromClassification(classification, { direction: "inbound" });
    const status = resolveUniversalStatusFromClassification(classification, { direction: "inbound" });

    assert.strictEqual(bucket, "priority");
    assert.strictEqual(status.universal_status, "active");
    assert.strictEqual(status.universal_stage, "Offer");
  });

  it("resolves recent outbound message to awaiting_response / waiting bucket", () => {
    const existingState = {
      inbox_bucket: "new_replies",
      primary_intent: "who_is_this",
      last_outbound_at: new Date().toISOString(),
      last_inbound_at: "2026-01-01T00:00:00.000Z",
    };
    const bucket = resolveInboxBucketFromClassification({}, { direction: "outbound", sent_at: existingState.last_outbound_at }, existingState);
    const status = resolveUniversalStatusFromClassification({}, { direction: "outbound" }, existingState);

    assert.strictEqual(bucket, "waiting");
    assert.strictEqual(status.universal_status, "awaiting_response");
    assert.strictEqual(status.universal_stage, "awaiting_response");
  });

  it("resolves stale outbound message to null bucket for cold reactivation", () => {
    const staleOutbound = "2026-01-01T00:00:00.000Z";
    const existingState = {
      last_outbound_at: staleOutbound,
      last_inbound_at: "2025-12-01T00:00:00.000Z",
    };
    const bucket = resolveInboxBucketFromClassification({}, { direction: "outbound", sent_at: staleOutbound }, existingState);
    assert.strictEqual(bucket, null);
  });

  it("resolves property_correction to needs_review bucket and needs_review status", () => {
    const classification = { primary_intent: "property_correction" };
    const bucket = resolveInboxBucketFromClassification(classification, { direction: "inbound" });
    const status = resolveUniversalStatusFromClassification(classification, { direction: "inbound" });
    const flags = resolveThreadFlagsFromClassification(classification);

    assert.strictEqual(bucket, "needs_review");
    assert.strictEqual(status.universal_status, "needs_review");
    assert.strictEqual(status.universal_stage, "property_correction");
    assert.strictEqual(flags.not_interested, false);
  });

  it("resolves unclear low-confidence inbound to new_replies bucket (not operator review)", () => {
    const classification = { primary_intent: "unclear", confidence: 0.55 };
    const bucket = resolveInboxBucketFromClassification(classification, { direction: "inbound" });
    const status = resolveUniversalStatusFromClassification(classification, { direction: "inbound" });
    assert.strictEqual(bucket, "new_replies");
    assert.strictEqual(status.universal_status, "active");
  });

  it("resolves hostile_or_legal inbound to needs_review bucket", () => {
    const classification = { primary_intent: "hostile_or_legal" };
    const bucket = resolveInboxBucketFromClassification(classification, { direction: "inbound" });
    assert.strictEqual(bucket, "needs_review");
  });

  it("resolves retry-exhausted system failure to needs_review bucket", () => {
    const classification = {
      primary_intent: "unclear",
      automation_decision: { system_failure: true, retry_exhausted: true },
    };
    const bucket = resolveInboxBucketFromClassification(classification, { direction: "inbound" });
    assert.strictEqual(bucket, "needs_review");
  });

  it("resolves outbound message on not_interested thread to null bucket", () => {
    const existingState = { universal_status: "dead", inbox_bucket: "dead", not_interested: true };
    const bucket = resolveInboxBucketFromClassification({}, { direction: "outbound" }, existingState);
    const status = resolveUniversalStatusFromClassification({}, { direction: "outbound" }, existingState);

    assert.strictEqual(bucket, null);
    assert.strictEqual(status.universal_status, "dead");
  });

  it("resolves outbound message on suppressed thread to remain suppressed", () => {
    const existingState = { universal_status: "suppressed", inbox_bucket: "suppressed", opt_out: true };
    const bucket = resolveInboxBucketFromClassification({}, { direction: "outbound" }, existingState);
    const status = resolveUniversalStatusFromClassification({}, { direction: "outbound" }, existingState);

    assert.strictEqual(bucket, "suppressed");
    assert.strictEqual(status.universal_status, "suppressed");
  });
});
