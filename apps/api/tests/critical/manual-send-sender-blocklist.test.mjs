/**
 * MANUAL SEND NOW — the canonical sender eligibility is unconditional (2026-10-02):
 * operator blocklist + fleet + status/health/cooling/daily limit.
 *
 * Manual sends call the provider directly, so the runner's SMS health guard
 * never saw them: 11 manual sends left from operator-blocked Miami •••5670 on
 * 09-30..10-01. Now a blocked sender — however it was resolved, the thread's
 * own number included — is refused with a 423 BEFORE any queue row exists,
 * and an unreadable blocklist refuses too (fail closed). A refusal is never
 * ok:true. Sender SELECTION is unchanged (send-now-sender-continuity.test.mjs).
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createInboxSendNowQueueRow, executeManualInboxSendNow } from "@/lib/domain/inbox/send-now-service.js";

const SELLER = "+16125550142";
const BLOCKED = "+13058975670";
const CLEAN = "+16128060495";

const input = (from) => ({
  thread_key: SELLER,
  to_phone_number: SELLER,
  from_phone_number: from,
  message_body: "Thanks, I will call you shortly.",
  action: "send_now",
});

function spyDeps(getSystemValue) {
  const calls = { insert: 0 };
  return {
    calls,
    deps: {
      getSystemValue,
      env: {},
      loadOutboundNumberByPhone: async (phone) => ({ id: "n1", phone_number: phone, status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 3 }),
      loadThreadSender: async () => null,
      routeThreadFallback: async () => null,
      insertImpl: async () => { calls.insert += 1; return { ok: true, queue_row_id: "row-1", queue_item_id: "row-1" }; },
      hardComplianceCheckImpl: async () => ({ blocked: false }),
      checkBlacklistPriorFailureImpl: async () => ({ blocked: false }),
      recentDeliveryFailuresImpl: async () => ({ suppress: false }),
    },
  };
}

const blocklist = (value) => async (key) => (key === "sms_blocked_sender_numbers" ? value : null);

test("a blocked sender is refused with 423 and no queue row is created", async () => {
  const { calls, deps } = spyDeps(blocklist(`+12818458577,${BLOCKED}`));
  const out = await createInboxSendNowQueueRow(input(BLOCKED), deps);
  assert.equal(out.ok, false);
  assert.equal(out.status, 423);
  assert.equal(out.reason, "blocked_sender_number");
  assert.equal(out.queue_created, false);
  assert.equal(out.provider_attempted, false);
  assert.equal(calls.insert, 0);
});

test("the blocklist is matched on normalized numbers (10-digit list entry)", async () => {
  const { calls, deps } = spyDeps(blocklist("3058975670"));
  const out = await createInboxSendNowQueueRow(input(BLOCKED), deps);
  assert.equal(out.reason, "blocked_sender_number");
  assert.equal(calls.insert, 0);
});

test("the env list applies too", async () => {
  const { calls, deps } = spyDeps(blocklist(null));
  deps.env = { SMS_BLOCKED_SENDER_NUMBERS: BLOCKED };
  const out = await createInboxSendNowQueueRow(input(BLOCKED), deps);
  assert.equal(out.reason, "blocked_sender_number");
  assert.equal(calls.insert, 0);
});

test("an unreadable blocklist refuses (fail closed), never sends", async () => {
  const { calls, deps } = spyDeps(async () => { throw new Error("system_control down"); });
  const out = await createInboxSendNowQueueRow(input(CLEAN), deps);
  assert.equal(out.ok, false);
  assert.equal(out.status, 423);
  assert.equal(out.reason, "sender_blocklist_unreadable");
  assert.equal(calls.insert, 0);
});

const stubSupabase = {
  from() {
    const q = { select: () => q, eq: () => q, in: () => q, not: () => q, order: () => q, gte: () => q, limit: () => q, insert: () => q, update: () => q, upsert: () => q,
      maybeSingle: async () => ({ data: null, error: null }), single: async () => ({ data: null, error: null }),
      then: (res) => Promise.resolve({ data: [], error: null }).then(res) };
    return q;
  },
};

test("a sender that is not blocked is not refused by the blocklist", async () => {
  const { calls, deps } = spyDeps(blocklist(BLOCKED));
  deps.supabase = stubSupabase;
  const out = await createInboxSendNowQueueRow(input(CLEAN), deps);
  assert.notEqual(out.reason, "blocked_sender_number");
  assert.notEqual(out.reason, "sender_blocklist_unreadable");
  assert.equal(calls.insert, 1, "proceeds to the normal queue-row creation");
});

test("executeManualInboxSendNow surfaces the refusal as ok:false (no 423 -> ok:true), provider never called", async () => {
  let provider = 0;
  const out = await executeManualInboxSendNow(input(BLOCKED), {
    getSystemValue: async (key) => {
      if (key === "sms_blocked_sender_numbers") return BLOCKED;
      if (key === "queue_processor_mode") return "live";
      if (key === "queue_execution_mode") return "normal";
      return null;
    },
    env: {},
    loadOutboundNumberByPhone: async (phone) => ({ id: "n1", phone_number: phone, status: "active", daily_limit: 800, messages_sent_today: 0 }),
    loadThreadSender: async () => null,
    routeThreadFallback: async () => null,
    sendTextgridImpl: async () => { provider += 1; return { ok: true }; },
    createQueueRowImpl: (i, d) => createInboxSendNowQueueRow(i, { ...d, insertImpl: async () => { throw new Error("must not insert"); } }),
  });
  assert.equal(out.ok, false);
  assert.equal(provider, 0);
  assert.equal(out.reason, "blocked_sender_number", "past the runtime authority, refused by the blocklist");
  assert.equal(out.status, 423);
  assert.equal(out.hard_block, true);
});

for (const [label, row, reason] of [
  ["a paused number", { status: "paused" }, "outbound_number_status_paused"],
  ["a cooling number", { health_state: "cooling" }, "outbound_number_health_cooling"],
  ["a number at its daily limit", { daily_limit: 3, messages_sent_today: 3 }, "outbound_number_daily_limit_reached"],
]) {
  test(`${label} is refused with 423 before any row`, async () => {
    const { calls, deps } = spyDeps(blocklist(null));
    deps.loadOutboundNumberByPhone = async (phone) => ({ id: "n1", phone_number: phone, status: "active", daily_limit: 800, messages_sent_today: 0, ...row });
    const out = await createInboxSendNowQueueRow(input(CLEAN), deps);
    assert.equal(out.status, 423);
    assert.equal(out.reason, reason);
    assert.equal(out.hard_block ?? true, true);
    assert.equal(calls.insert, 0);
  });
}

test("a number that is not in the fleet is refused", async () => {
  const { calls, deps } = spyDeps(blocklist(null));
  deps.loadOutboundNumberByPhone = async () => null;
  const out = await createInboxSendNowQueueRow(input(CLEAN), deps);
  assert.equal(out.reason, "outbound_number_not_in_fleet");
  assert.equal(calls.insert, 0);
});

test("a fleet lookup failure refuses (fail closed)", async () => {
  const { calls, deps } = spyDeps(blocklist(null));
  deps.loadOutboundNumberByPhone = async () => { throw new Error("db down"); };
  const out = await createInboxSendNowQueueRow(input(CLEAN), deps);
  assert.equal(out.reason, "outbound_number_eligibility_unavailable");
  assert.equal(calls.insert, 0);
});

test("sticky sender: a rejected proposal with an eligible routing fallback re-routes instead of failing (never the blocked number)", async () => {
  const { calls, deps } = spyDeps(blocklist(BLOCKED));
  let inserted = null;
  deps.routeThreadFallback = async () => ({ phone: CLEAN, via: "campaign_router" });
  deps.insertImpl = async (row) => { inserted = row; calls.insert += 1; return { ok: true, queue_row_id: "row-2", queue_item_id: "row-2" }; };
  deps.supabase = stubSupabase;
  await createInboxSendNowQueueRow(input(BLOCKED), deps);
  assert.equal(calls.insert, 1);
  assert.equal(inserted.from_phone_number, CLEAN);
});

test("sticky sender: an established thread keeps its own eligible sender over a per-message proposal", async () => {
  const { calls, deps } = spyDeps(blocklist(null));
  let inserted = null;
  deps.loadThreadSender = async () => "+16125092623";
  deps.insertImpl = async (row) => { inserted = row; calls.insert += 1; return { ok: true, queue_row_id: "row-3", queue_item_id: "row-3" }; };
  deps.supabase = stubSupabase;
  await createInboxSendNowQueueRow(input(CLEAN), deps);
  assert.equal(inserted.from_phone_number, "+16125092623", "the composer's per-message pick never rotates the thread");
});
