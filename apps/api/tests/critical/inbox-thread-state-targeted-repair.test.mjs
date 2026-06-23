import test from "node:test";
import assert from "node:assert/strict";

import { proposeTargetedBucket } from "../../scripts/repair-inbox-thread-state-targeted.mjs";

test("targeted repair suppresses explicit opt-out evidence", () => {
  const proposal = proposeTargetedBucket({
    inbox_bucket: null,
    is_suppressed: true,
    latest_direction: "inbound",
  });
  assert.equal(proposal.bucket, "suppressed");
  assert.equal(proposal.confidence, "high");
});

test("targeted repair leaves ordinary outbound-only history unresolved", () => {
  const proposal = proposeTargetedBucket({
    inbox_bucket: null,
    latest_direction: "outbound",
    last_outbound_at: "2024-01-01T00:00:00.000Z",
    automation_lane: "cold_reactivation",
  });
  assert.equal(proposal.bucket, null);
  assert.equal(proposal.reason, "unresolved_historical");
});

test("targeted repair idempotency skips explicit bucket rows", () => {
  const proposal = proposeTargetedBucket({
    inbox_bucket: "new_replies",
    latest_direction: "inbound",
  });
  assert.equal(proposal.bucket, null);
  assert.equal(proposal.reason, "already_explicit");
});