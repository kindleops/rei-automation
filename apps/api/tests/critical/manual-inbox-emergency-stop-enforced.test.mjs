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

/** Control plane that AUTHORIZES a send: no brake, processor live, mode normal. */
function healthySystemValue(key) {
  if (key === "queue_emergency_stop_at") return null;
  if (key === "queue_processor_mode") return "live";
  if (key === "queue_execution_mode") return "normal";
  if (key === "campaign_mode") return "live_limited";
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

// ── THE INVARIANT ────────────────────────────────────────────────────────────
// A manual operator send is NOT an authority to cross the emergency stop. This
// file previously asserted the opposite: the brake was evaluated, recorded as
// `bypassed_queue_emergency_stop` metadata, and the send proceeded to claim the
// row and call the provider. That was a genuine production bypass and these
// tests now pin its closure.

test("emergency stop DENIES a manual inbox send before any row, claim, or provider call", async () => {
  const supabase = makeClaimConflictSupabase();
  let create_called = 0;
  let provider_called = false;

  const result = await executeManualInboxSendNow(VALID_MANUAL_PAYLOAD, {
    getSystemValue: emergencySystemValue,
    supabase,
    createQueueRowImpl: async () => {
      create_called += 1;
      return { ok: true, queue_row_id: "must-not-be-created" };
    },
    sendTextgridImpl: async () => {
      provider_called = true;
      return { ok: true, sid: "must-not-send" };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "queue_emergency_stop_active");
  assert.equal(result.provider_attempted, false);
  // Denial happens BEFORE any durable state: no queue row, no claim, no send.
  assert.equal(create_called, 0, "no queue row may be created under the brake");
  assert.equal(provider_called, false, "the provider must never be invoked");
  assert.equal(supabase.calls.updates, 0, "no claim/update may touch send_queue");
});

test("scoped_canary_only DENIES an unrestricted manual send", async () => {
  const supabase = makeClaimConflictSupabase();
  let provider_called = false;
  const result = await executeManualInboxSendNow(VALID_MANUAL_PAYLOAD, {
    getSystemValue: (key) =>
      key === "queue_execution_mode" ? "scoped_canary_only"
      : key === "queue_processor_mode" ? "live"
      : null,
    supabase,
    createQueueRowImpl: async () => ({ ok: true, queue_row_id: "must-not-be-created" }),
    sendTextgridImpl: async () => { provider_called = true; return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "queue_execution_mode_scoped_canary_only");
  assert.equal(provider_called, false);
  assert.equal(supabase.calls.updates, 0);
});

test("an ABSENT or unreadable control plane DENIES (fail closed, never fail open)", async () => {
  for (const [label, getSystemValue] of [
    ["all values absent", async () => null],
    ["processor mode absent", (k) => (k === "queue_execution_mode" ? "normal" : null)],
    ["execution mode absent", (k) => (k === "queue_processor_mode" ? "live" : null)],
    ["malformed execution mode", (k) => (k === "queue_processor_mode" ? "live" : "nonsense-mode")],
    ["read throws", async () => { throw new Error("control plane down"); }],
  ]) {
    const supabase = makeClaimConflictSupabase();
    let provider_called = false;
    const result = await executeManualInboxSendNow(VALID_MANUAL_PAYLOAD, {
      getSystemValue,
      supabase,
      createQueueRowImpl: async () => ({ ok: true, queue_row_id: "must-not-be-created" }),
      sendTextgridImpl: async () => { provider_called = true; return { ok: true }; },
    });
    assert.equal(result.ok, false, label);
    assert.equal(provider_called, false, label);
    assert.equal(supabase.calls.updates, 0, label);
  }
});

test("no request field can manufacture send authority", async () => {
  // bypassed_queue_emergency_stop / operator_override / force are metadata or
  // operator intent -- never authority. Under the brake they must all deny.
  for (const extra of [
    { bypassed_queue_emergency_stop: true },
    { metadata: { bypassed_queue_emergency_stop: true } },
    { operator_override: true },
    { force: true },
  ]) {
    const supabase = makeClaimConflictSupabase();
    let provider_called = false;
    const result = await executeManualInboxSendNow(
      { ...VALID_MANUAL_PAYLOAD, ...extra },
      {
        getSystemValue: emergencySystemValue,
        supabase,
        createQueueRowImpl: async () => ({ ok: true, queue_row_id: "must-not-be-created" }),
        sendTextgridImpl: async () => { provider_called = true; return { ok: true }; },
      }
    );
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.equal(result.reason, "queue_emergency_stop_active", JSON.stringify(extra));
    assert.equal(provider_called, false, JSON.stringify(extra));
  }
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

test("compliance still blocks even when the runtime authority AUTHORIZES the send", async () => {
  let insert_called = false;

  const result = await executeManualInboxSendNow(VALID_MANUAL_PAYLOAD, {
    getSystemValue: healthySystemValue,
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
