import test from "node:test";
import assert from "node:assert/strict";

import { countAutomatedFollowUps } from "@/lib/domain/seller-flow/delivery-triggered-followup.js";

// Phase 6 residual (Phase 9 concern): a transport-FAILED follow-up never reached
// the seller, so it must NOT burn an attempt from the lifetime cap. The count
// must include only follow-ups that reached, or are in-flight to, the seller
// (scheduled/queued/sent/delivered) and exclude cancelled + terminal
// never-delivered statuses (failed/failed_transport/undelivered/invalid_number/
// carrier_blocked/blocked).

function mockSupabase(rows) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    limit: async () => ({ data: rows, error: null }),
  };
  return { from: () => chain };
}

test("transport-failed follow-ups do NOT count toward the attempt cap", async () => {
  const rows = [
    { id: "1", queue_status: "delivered" },
    { id: "2", queue_status: "sent" },
    { id: "3", queue_status: "queued" },
    { id: "4", queue_status: "failed" }, // transport failure — must not count
    { id: "5", queue_status: "failed_transport" }, // must not count
    { id: "6", queue_status: "cancelled" }, // must not count
    { id: "7", queue_status: "invalid_number" }, // terminal never-delivered
    { id: "8", queue_status: "carrier_blocked" }, // terminal never-delivered
  ];
  const count = await countAutomatedFollowUps(mockSupabase(rows), "+15551234567");
  // Only delivered + sent + queued reached/are-in-flight to the seller.
  assert.equal(count, 3, "only reached/in-flight follow-ups count as attempts");
});

test("a thread whose only follow-up failed transport has zero counted attempts", async () => {
  const rows = [{ id: "1", queue_status: "failed_transport" }];
  const count = await countAutomatedFollowUps(mockSupabase(rows), "+15551234567");
  assert.equal(count, 0, "a failed send is not a successful follow-up attempt");
});

test("delivered/sent/queued/scheduled all count as attempts", async () => {
  const rows = [
    { id: "1", queue_status: "scheduled" },
    { id: "2", queue_status: "queued" },
    { id: "3", queue_status: "sent" },
    { id: "4", queue_status: "delivered" },
  ];
  const count = await countAutomatedFollowUps(mockSupabase(rows), "+15551234567");
  assert.equal(count, 4);
});
