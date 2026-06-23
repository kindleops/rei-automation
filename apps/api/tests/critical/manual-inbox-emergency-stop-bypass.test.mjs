import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { executeManualInboxSendNow } from "../../src/lib/domain/inbox/send-now-service.js";
import {
  evaluateQueueCreationRuntimeBrakes,
  evaluateQueueSendRuntimeBrakes,
} from "../../src/lib/domain/queue/queue-control-safety.js";

const EMERGENCY_AT = "2026-05-31T12:00:00.000Z";

const VALID_MANUAL_PAYLOAD = {
  thread_key: "+12146072916",
  to_phone_number: "+12146072916",
  from_phone_number: "+18885551212",
  message_body: "Manual operator reply",
  queue_key: "inbox:send_now:proof",
};

function emergencySystemValue(key) {
  if (key === "queue_emergency_stop_at") return EMERGENCY_AT;
  if (key === "campaign_mode") return "paused";
  return null;
}

function makeClaimConflictSupabase() {
  const calls = {
    updates: 0,
    last_update: null,
  };

  return {
    calls,
    from(table) {
      assert.equal(table, "send_queue");
      const chain = {
        update(payload) {
          calls.updates += 1;
          calls.last_update = payload;
          return chain;
        },
        eq() { return chain; },
        in() { return chain; },
        select() { return chain; },
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return chain;
    },
  };
}

test("manual inbox send bypasses only queue_emergency_stop_active and records metadata", async () => {
  const supabase = makeClaimConflictSupabase();
  let create_called = 0;
  let create_input = null;
  let provider_called = false;

  const result = await executeManualInboxSendNow(VALID_MANUAL_PAYLOAD, {
    getSystemValue: emergencySystemValue,
    supabase,
    createQueueRowImpl: async (input) => {
      create_called += 1;
      create_input = input;
      return {
        ok: true,
        queue_row_id: "manual-proof-row",
        queue_id: "manual-proof-row",
        queue_key: input.queue_key,
        result: { raw: { metadata: input.metadata } },
      };
    },
    sendTextgridImpl: async () => {
      provider_called = true;
      return { ok: true, sid: "should-not-send-without-claim" };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "queue_item_claim_conflict");
  assert.notEqual(result.reason, "queue_emergency_stop_active");
  assert.equal(create_called, 1);
  assert.equal(provider_called, false);
  assert.equal(create_input.source, "manual_inbox");
  assert.equal(create_input.bypassed_queue_emergency_stop, true);
  assert.equal(create_input.metadata.source, "manual_inbox");
  assert.equal(create_input.metadata.bypassed_queue_emergency_stop, true);
  assert.equal(supabase.calls.updates, 1);
  assert.equal(supabase.calls.last_update.metadata.source, "manual_inbox");
  assert.equal(supabase.calls.last_update.metadata.bypassed_queue_emergency_stop, true);
});

test("queue and campaign runtime paths still block while emergency stop is active", () => {
  const settings = {
    campaign_mode: "live_limited",
    queue_processor_mode: "live",
    queue_auto_enqueue_enabled: "true",
    queue_emergency_stop_at: EMERGENCY_AT,
  };

  const queue_send = evaluateQueueSendRuntimeBrakes(settings, { action: "queue_send" });
  assert.equal(queue_send.ok, false);
  assert.equal(queue_send.reason, "queue_emergency_stop_active");

  const campaign_create = evaluateQueueCreationRuntimeBrakes(settings, {
    action: "campaign_queue_create",
  });
  assert.equal(campaign_create.ok, false);
  assert.equal(campaign_create.reason, "queue_emergency_stop_active");
});

test("manual inbox emergency bypass does not bypass hard compliance blocks", async () => {
  let insert_called = false;

  const result = await executeManualInboxSendNow(VALID_MANUAL_PAYLOAD, {
    getSystemValue: emergencySystemValue,
    supabase: {
      from() {
        throw new Error("send_queue should not be touched after compliance block");
      },
    },
    insertImpl: async () => {
      insert_called = true;
      return { ok: true, queue_row_id: "should-not-insert" };
    },
    hardComplianceCheckImpl: async () => ({
      blocked: true,
      reason: "opt_out",
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "compliance_blocked");
  assert.equal(result.detail_reason, "opt_out");
  assert.equal(result.queue_inserted, false);
  assert.equal(insert_called, false);
});

test("manual inbox send service does not dispatch through the global queue runner", async () => {
  const source = await readFile(
    new URL("../../src/lib/domain/inbox/send-now-service.js", import.meta.url),
    "utf8"
  );

  assert.equal(/\brunSendQueue\s*\(/.test(source), false);
  assert.equal(/\bprocessSendQueueItem\s*\(/.test(source), false);
});
