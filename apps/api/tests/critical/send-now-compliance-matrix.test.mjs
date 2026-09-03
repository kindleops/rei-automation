import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { executeManualInboxSendNow } from "@/lib/domain/inbox/send-now-service.js";

// Send-now compliance matrix (Part A).
//
// The canonical runtime authority is the FIRST gate. Compliance is the SECOND,
// and it must hold on its own. Every case here runs under an AUTHORIZING
// control plane on purpose: if the brake denied first, these would prove
// nothing about STOP / DNC / suppression / wrong number.

const THREAD = "+15005550006";
const FROM = "+15005550001";

// Authorizing control plane. The brake is deliberately NOT the subject here.
const AUTHORIZING = async (key) => {
  if (key === "queue_processor_mode") return "live";
  if (key === "queue_execution_mode") return "normal";
  return null;
};

/**
 * @param {object} state
 * @param {object|null} state.thread_state   deal_thread_state row
 * @param {Array}       state.message_events message_events rows
 * @param {boolean}     state.suppressed     sms_suppression_list hit
 */
function makeSupabase({ thread_state = null, message_events = [], suppressed = false } = {}) {
  const queue_rows = new Map([
    ["cm-1", {
      id: "cm-1",
      thread_key: THREAD,
      to_phone_number: THREAD,
      from_phone_number: FROM,
      queue_status: "queued",
      message_body: "compliance matrix probe",
      metadata: { source: "manual_inbox", manual_operator_send: true },
    }],
  ]);

  return {
    from(table) {
      if (table === "deal_thread_state") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: thread_state, error: null }) }),
          }),
        };
      }

      if (table === "message_events") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: message_events, error: null }),
              }),
            }),
          }),
        };
      }

      if (table === "sms_suppression_list") {
        const hit = suppressed ? [{ id: "sup-1", is_active: true, suppression_reason: "opt_out" }] : [];
        const tail = { eq: () => ({ limit: async () => ({ data: hit, error: null }) }) };
        return { select: () => ({ or: () => tail, eq: () => ({ or: () => tail }) }) };
      }

      if (table === "send_queue") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: queue_rows.get("cm-1") ?? null, error: null }),
            }),
          }),
          update(patch) {
            const apply = async () => {
              const row = queue_rows.get("cm-1");
              if (row) Object.assign(row, patch);
              return { data: row ?? null, error: null };
            };
            return {
              eq: () => ({
                in: () => ({ select: () => ({ maybeSingle: apply }) }),
                then: (res, rej) => apply().then(res, rej),
              }),
            };
          },
        };
      }

      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    },
  };
}

async function attemptSend(state) {
  let provider_calls = 0;
  const result = await executeManualInboxSendNow(
    {
      thread_key: THREAD,
      to_phone_number: THREAD,
      from_phone_number: FROM,
      message_body: "compliance matrix probe",
      source: "manual_inbox",
      action: "send_now",
    },
    {
      supabase: makeSupabase(state),
      getSystemValue: AUTHORIZING,
      createQueueRowImpl: async (input) => ({
        ok: true,
        queue_row_id: "cm-1",
        queue_id: "cm-1",
        result: { raw: { metadata: input.metadata } },
      }),
      sendTextgridImpl: async () => {
        provider_calls += 1;
        return { ok: true, sid: "SMshouldnothappen" };
      },
    }
  );
  return { result, provider_calls };
}

const RUNTIME_DENIALS = new Set([
  "queue_processor_paused",
  "queue_emergency_stop_active",
  "queue_execution_mode_stopped",
  "queue_execution_mode_scoped_canary_only",
  "control_plane_unreadable",
]);

// Each row is a distinct compliance ground the mission requires proving.
const CASES = [
  ["STOP language in the thread history", { message_events: [{ id: "1", message_body: "STOP" }] }],
  ["an explicit opt-out keyword", { message_events: [{ id: "1", opt_out_keyword: "STOP" }] }],
  ["a recorded opt-out event", { message_events: [{ id: "1", is_opt_out: true }] }],
  ["DNC detected intent", { message_events: [{ id: "1", detected_intent: "dnc" }] }],
  ["do-not-contact detected intent", { message_events: [{ id: "1", detected_intent: "do_not_contact" }] }],
  ["WRONG NUMBER detected intent", { message_events: [{ id: "1", detected_intent: "wrong_number" }] }],
  ["a legal threat", { message_events: [{ id: "1", detected_intent: "legal_threat" }] }],
  ["a suppressed thread status", { thread_state: { thread_key: THREAD, universal_status: "suppressed" } }],
  ["a suppressed inbox bucket", { thread_state: { thread_key: THREAD, inbox_bucket: "suppressed" } }],
  ["a thread-level opt_out flag", { thread_state: { thread_key: THREAD, opt_out: true } }],
  ["a terminal wrong_number stage", { thread_state: { thread_key: THREAD, universal_stage: "wrong_number" } }],
  ["an active suppression-list entry", { suppressed: true }],
];

for (const [label, state] of CASES) {
  test(`send-now REFUSES to reach the provider given ${label}`, async () => {
    const { result, provider_calls } = await attemptSend(state);

    assert.equal(provider_calls, 0, "the provider must never be called");
    assert.equal(result.ok, false, "the send must not report success");
    assert.notEqual(result.sent, true, "the send must not be marked sent");
    // Prove COMPLIANCE did the blocking, not a runtime brake short-circuit.
    assert.ok(
      !RUNTIME_DENIALS.has(result.reason),
      `blocked by a runtime brake, so ${label} was never exercised: ${result.reason}`
    );
  });
}

// Schema truth. `deal_thread_state.primary_intent` does NOT exist in production.
// Compliance code that SELECTs it makes PostgREST fail the whole query (42703);
// because every such read is wrapped in a swallowing catch, the entire
// thread-state suppression branch silently goes dead. Terminal intent is derived
// from universal_stage / message_events.detected_intent / inbox reply_intent
// instead (see resolve-terminal-thread-intent.js and commit ebbf7b83).
test("no send-path compliance query may SELECT the nonexistent primary_intent column", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = [
    "../../src/lib/domain/inbox/send-now-service.js",
    "../../src/lib/domain/compliance/evaluate-canonical-contactability.js",
    "../../src/lib/domain/queue/block-send-at-compliance.js",
  ];
  for (const rel of files) {
    const src = await readFile(new URL(rel, import.meta.url), "utf8");
    for (const line of src.split("\n")) {
      if (line.includes(".select(") && line.includes("primary_intent")) {
        assert.fail(`${rel} selects primary_intent, which does not exist: ${line.trim()}`);
      }
    }
  }
});

test("the matrix is not vacuous: a clean thread is NOT blocked by compliance", async () => {
  // If a clean thread also failed compliance, every case above would pass for
  // the wrong reason. This is the control.
  const { result } = await attemptSend({});
  assert.ok(
    !String(result.reason ?? "").startsWith("compliance_"),
    `a clean thread must not be compliance-blocked, got: ${result.reason}`
  );
  assert.ok(!RUNTIME_DENIALS.has(result.reason), `control plane should authorize, got: ${result.reason}`);
});
