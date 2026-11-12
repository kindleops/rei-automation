import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { executeManualInboxSendNow } from "../../src/lib/domain/inbox/send-now-service.js";
import {

  evaluateQueueCreationRuntimeBrakes,
  evaluateQueueSendRuntimeBrakes,
} from "../../src/lib/domain/queue/queue-control-safety.js";


// Canonical sender eligibility (2026-10-02): a manual send needs a fleet
// sender the canonical function accepts. These tests are about other
// authorities, so the sender is an ordinary active, unblocked fleet number.
const ACTIVE_FLEET_SENDER = async (phone) => ({ id: "fleet-test-sender", phone_number: phone, status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0 });
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
// A manual-send REQUEST is NOT an authority to cross the emergency stop. This
// file previously asserted the opposite: the brake was evaluated, recorded as
// `bypassed_queue_emergency_stop` metadata, and the send proceeded to claim the
// row and call the provider. That was a genuine production bypass and these
// tests now pin its closure.
//
// 2026-11-02 refinement (manual-send-authority hotfix): without a SERVER-SIDE
// operator principal (deps.operator, minted by the route's auth layer) every
// call below is automation and queue_emergency_stop_at denies it, exactly as
// before. An authenticated operator runs under a separate authority
// (manual_send_mode + global_send_shutdown_at); see
// manual-send-authority-hotfix.test.mjs for that half. The last test here pins
// the separation from this side.

test("emergency stop DENIES a manual inbox send before any row, claim, or provider call", async () => {
  const supabase = makeClaimConflictSupabase();
  let create_called = 0;
  let provider_called = false;

  const result = await executeManualInboxSendNow(VALID_MANUAL_PAYLOAD, { loadOutboundNumberByPhone: ACTIVE_FLEET_SENDER, 
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
  const result = await executeManualInboxSendNow(VALID_MANUAL_PAYLOAD, { loadOutboundNumberByPhone: ACTIVE_FLEET_SENDER, 
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
    const result = await executeManualInboxSendNow(VALID_MANUAL_PAYLOAD, { loadOutboundNumberByPhone: ACTIVE_FLEET_SENDER, 
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
      { loadOutboundNumberByPhone: ACTIVE_FLEET_SENDER, 
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

  const result = await executeManualInboxSendNow(VALID_MANUAL_PAYLOAD, { loadOutboundNumberByPhone: ACTIVE_FLEET_SENDER, 
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

test("the SEPARATION: a server-side operator principal is judged by the manual authority, not the automation brake", async () => {
  // Same request, same active emergency stop. The only difference is that the
  // server established an authenticated operator (deps.operator), and the
  // control plane says manual_send_mode=enabled. Then the stop does not deny.
  const operator = { authenticated: true, auth_source: "ops_dashboard_session", via: "header:x-ops-dashboard-secret", id: "op-1", email: null };
  const withManual = (key) => (key === "manual_send_mode" ? "enabled" : emergencySystemValue(key));

  const supabase = makeClaimConflictSupabase();
  const result = await executeManualInboxSendNow(VALID_MANUAL_PAYLOAD, {
    loadOutboundNumberByPhone: ACTIVE_FLEET_SENDER,
    getSystemValue: withManual,
    supabase,
    operator,
    createQueueRowImpl: async () => ({ ok: true, queue_row_id: "manual-authority-row" }),
    sendTextgridImpl: async () => ({ ok: true, sid: "must-not-reach-here-claim-conflicts" }),
  });
  // The brake did NOT deny. (This fixture's send_queue refuses the claim, which
  // is the next gate and proves the authority verdict was AUTHORIZE.)
  assert.notEqual(result.reason, "queue_emergency_stop_active");
  assert.equal(result.reason, "queue_item_claim_conflict");
  assert.equal(supabase.calls.updates, 1, "the claim was attempted: authority was granted");

  // And with manual_send_mode absent, the same principal is denied by ITS switch,
  // still before any row or claim.
  const supabase2 = makeClaimConflictSupabase();
  const denied = await executeManualInboxSendNow(VALID_MANUAL_PAYLOAD, {
    loadOutboundNumberByPhone: ACTIVE_FLEET_SENDER,
    getSystemValue: emergencySystemValue,
    supabase: supabase2,
    operator,
    createQueueRowImpl: async () => ({ ok: true, queue_row_id: "must-not-be-created" }),
    sendTextgridImpl: async () => ({ ok: true }),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "manual_send_disabled");
  assert.equal(denied.status, 423);
  assert.equal(supabase2.calls.updates, 0);
});

test("manual inbox send service does not dispatch through the global queue runner", async () => {
  const source = await readFile(
    new URL("../../src/lib/domain/inbox/send-now-service.js", import.meta.url),
    "utf8"
  );

  assert.equal(/\brunSendQueue\s*\(/.test(source), false);
  assert.equal(/\bprocessSendQueueItem\s*\(/.test(source), false);
});
