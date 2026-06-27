import test from "node:test";
import assert from "node:assert/strict";

import { buildThreadStatePatchFromClassification } from "../../src/lib/domain/inbox/resolve-inbox-state-from-classification.js";

test("not for sale during ownership check schedules S2 follow-up and leaves new replies", () => {
  const patch = buildThreadStatePatchFromClassification({
    messageEvent: {
      id: "msg-1",
      direction: "inbound",
      message_body: "Not for sale!!!!",
      received_at: "2026-06-20T12:00:00.000Z",
    },
    classification: {
      primary_intent: "not_interested",
      not_interested: true,
    },
    existingState: {
      conversation_stage: "ownership_check",
      seller_stage: "ownership_check",
      inbox_bucket: "new_replies",
    },
  });

  assert.equal(patch.conversation_stage, "consider_selling");
  assert.equal(patch.ownership_status, "inferred");
  assert.equal(patch.disposition, "not_interested");
  assert.equal(patch.lead_temperature, "cold");
  assert.equal(patch.inbox_bucket, "follow_up");
  assert.equal(patch.is_actioned, true);
  assert.ok(patch.follow_up_at);
});