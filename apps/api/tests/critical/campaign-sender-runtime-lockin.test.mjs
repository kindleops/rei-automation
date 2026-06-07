import test from "node:test";
import assert from "node:assert/strict";

import { classifyCampaignRuntimeRouteFailure } from "@/lib/domain/campaigns/campaign-automation-service.js";
import { executeAutonomousReply } from "@/lib/domain/seller-flow/execute-autonomous-reply.js";
import { normalizeSelectedQueueSender } from "@/lib/domain/queue/build-send-queue-item.js";

test("campaign queue planning blocks graph fallback when runtime cannot reproduce the route", () => {
  const failure = classifyCampaignRuntimeRouteFailure(
    {
      metadata: {
        routing_tier: "approved_state_fallback",
        blocker_flags: { fallback_covered: true },
      },
    },
    {
      ok: false,
      routing_block_reason: "NO_APPROVED_ROUTING_PATH",
    }
  );

  assert.deepEqual(failure, {
    blocker: "graph_runtime_sender_route_mismatch",
    reason: "GRAPH_RUNTIME_SENDER_ROUTE_MISMATCH",
  });
});

test("autonomous reply never queues or sends with a health-blocked sender", async () => {
  let insertCalled = false;
  let sendCalled = false;
  const result = await executeAutonomousReply(
    {
      thread_key: "thread-blocked-sender",
      to_phone_number: "+15551234567",
      from_phone_number: "+14693131600",
      message_body: "Reply proof",
      source_event_id: "event-blocked-sender",
      stage: "ownership_check",
    },
    {
      getSystemValue: async (key) =>
        key === "sms_blocked_sender_numbers" ? ["+14693131600"] : null,
      insertQueueImpl: async () => {
        insertCalled = true;
        return { ok: true, queue_row_id: "should-not-exist" };
      },
      sendTextgridImpl: async () => {
        sendCalled = true;
        return { ok: true, sid: "should-not-send" };
      },
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "blocked_sender_number");
  assert.equal(insertCalled, false);
  assert.equal(sendCalled, false);
});

test("master-owner queue hydration preserves the feeder-selected safe sender", () => {
  const sender = normalizeSelectedQueueSender({
    phone_number: "(281) 845-8577",
    routing_tier: "regional_cluster_fallback",
    routing_diagnostics: {
      selected_phone_market: "Houston, TX",
      selection_reason: "regional_cluster_fallback",
    },
  });

  assert.equal(sender.from_phone_number, "+12818458577");
  assert.equal(sender.routing_tier, "regional_cluster_fallback");
  assert.equal(sender.routing_diagnostics.selected_phone_market, "Houston, TX");
});
