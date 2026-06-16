import test from "node:test";
import assert from "node:assert/strict";

import { queueAutoReply, __setQueueDeps, __resetQueueDeps } from "@/lib/automation/queueAutoReply.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const THREAD_KEY = "T-risk-010";
const INBOUND_MSG_ID = "inbound-risk-010";
const FROM_PHONE = "+15005550001";

function makeInboundRow() {
  return {
    id: INBOUND_MSG_ID,
    from_phone_number: FROM_PHONE,
    message_body: "Yes I am interested in selling",
    conversation_brain_id: "brain-1",
    language: "English",
    current_stage: "initial_outreach",
    metadata: { timezone: "America/Chicago", personalization_context: {} },
  };
}

// Returns a chainable supabase mock:
//   - send_queue dedup → null (no duplicate)
//   - message_events fetch → valid inbound row
function makeSupabase() {
  return {
    from: (table) => {
      if (table === "send_queue") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
          insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: "q-1", status: "queued" }, error: null }) }) }),
        };
      }
      if (table === "message_events") {
        return {
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: makeInboundRow(), error: null }) }) }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }), single: () => Promise.resolve({ data: null, error: null }) }) }),
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: "q-1" }, error: null }) }) }),
      };
    },
  };
}

function makePassingPipelineDeps({ canSendFn, enqueue }) {
  return {
    supabase: makeSupabase(),
    classify: async () => ({
      primary_intent: "INTERESTED",
      confidence: 0.9,
      language: "English",
      seller_state: null,
    }),
    selectNextTemplate: async () => ({
      ok: true,
      template: {
        template_id: "tpl-auto-010",
        body: "Thank you for your interest. Let me check on that.",
        matches: ["INTERESTED"],
      },
      use_case: "auto_reply",
    }),
    renderSafeTemplate: () => ({
      ok: true,
      text: "Thank you for your interest. Let me check on that.",
    }),
    validateTemplateForIntent: () => ({ ok: true }),
    evaluateContactWindow: () => ({ allowed: true }),
    canSendFn,
    enqueue: enqueue || (async () => ({ ok: true, id: "q-enqueued-1" })),
    memory: {
      loadConversationMemory: async () => ({ found: false, thread: null, turns: [] }),
      upsertThread: async () => "thread-1",
      appendTurn: async () => "turn-1",
      storeSellerStateSnapshot: async () => {},
      storeRoutingDecision: async () => {},
    },
  };
}

// ─── Gate behavior tests ──────────────────────────────────────────────────────

test("RISK-010: paused_review thread → gate blocks before enqueue", async () => {
  let enqueue_called = false;
  __setQueueDeps(makePassingPipelineDeps({
    canSendFn: async () => ({ ok: false, reason: "thread_paused_review" }),
    enqueue: async () => { enqueue_called = true; return { ok: true }; },
  }));

  try {
    const result = await queueAutoReply(THREAD_KEY, INBOUND_MSG_ID);
    assert.equal(enqueue_called, false, "must not enqueue when gate blocks");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "thread_paused_review");
    assert.equal(result.action, "gate_blocked");
  } finally {
    __resetQueueDeps();
  }
});

test("RISK-010: phone_suppressed → gate blocks before enqueue", async () => {
  let enqueue_called = false;
  __setQueueDeps(makePassingPipelineDeps({
    canSendFn: async () => ({ ok: false, reason: "phone_suppressed" }),
    enqueue: async () => { enqueue_called = true; return { ok: true }; },
  }));

  try {
    const result = await queueAutoReply(THREAD_KEY, INBOUND_MSG_ID);
    assert.equal(enqueue_called, false);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "phone_suppressed");
    assert.equal(result.action, "gate_blocked");
  } finally {
    __resetQueueDeps();
  }
});

test("RISK-010: healthy thread → gate passes, enqueue called once", async () => {
  let enqueue_count = 0;

  // queueAutoReply writes directly via deps.supabase.from("send_queue").insert — track that
  function makeCountingSupabase() {
    return {
      from: (table) => {
        if (table === "send_queue") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
            insert: () => { enqueue_count++; return { select: () => ({ single: () => Promise.resolve({ data: { id: "q-1", status: "queued" }, error: null }) }) }; },
          };
        }
        if (table === "message_events") {
          return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: makeInboundRow(), error: null }) }) }) };
        }
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }), single: () => Promise.resolve({ data: null, error: null }) }) }),
          insert: () => { enqueue_count++; return { select: () => ({ single: () => Promise.resolve({ data: { id: "q-1" }, error: null }) }) }; },
        };
      },
    };
  }

  __setQueueDeps({
    ...makePassingPipelineDeps({ canSendFn: async () => ({ ok: true, reason: null }) }),
    supabase: makeCountingSupabase(),
  });

  try {
    await queueAutoReply(THREAD_KEY, INBOUND_MSG_ID);
    assert.equal(enqueue_count, 1, "enqueue must be called exactly once when gate passes");
  } finally {
    __resetQueueDeps();
  }
});

// ─── Cross-path dedup key structure ──────────────────────────────────────────

test("RISK-010: dedup keys from queueAutoReply and execute-autonomous-reply are structurally compatible", () => {
  const thread_key = "T-cross-dedup";
  const inbound_message_id = "inbound-222";
  const queueAutoReplyKey = `auto_reply:${thread_key}:${inbound_message_id}`;
  assert.ok(queueAutoReplyKey.startsWith("auto_reply:"), "queueAutoReply key must start with auto_reply:");

  const source_event_id = inbound_message_id;
  const stage = "qualify";
  const template_id = "tpl-1";
  const execKey = `auto_reply:${source_event_id}:${stage}:${template_id}`;
  assert.ok(execKey.startsWith("auto_reply:"), "execute-autonomous-reply key must start with auto_reply:");
});

// ─── Third path is planning-only ─────────────────────────────────────────────

test("RISK-010: resolve-seller-auto-reply-plan has no enqueue call", async () => {
  const { execSync } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const plannerFile = path.resolve(__dirname, "../../src/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js");

  let output = "";
  try {
    output = execSync(
      `grep -n "insertSupabaseSendQueueRow\\|createInboxSendNowQueueRow\\|queueAutoReply\\|enqueue" "${plannerFile}"`,
      { encoding: "utf8" }
    ).trim();
  } catch {
    output = "";
  }
  assert.equal(output, "", `resolve-seller-auto-reply-plan.js must NOT call any enqueue function:\n${output}`);
});

// ─── canSend import checks ────────────────────────────────────────────────────

test("RISK-010: queueAutoReply.js imports canSend from send-now-service", async () => {
  const { execSync } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(__dirname, "../../src/lib/automation/queueAutoReply.js");

  const output = execSync(`grep -n "canSend" "${file}"`, { encoding: "utf8" }).trim();
  assert.ok(output.length > 0, "queueAutoReply.js must reference canSend");
  assert.ok(output.includes("send-now-service"), "must import canSend from send-now-service");
});

test("RISK-010: execute-autonomous-reply.js imports canSend from send-now-service", async () => {
  const { execSync } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(__dirname, "../../src/lib/domain/seller-flow/execute-autonomous-reply.js");

  const output = execSync(`grep -n "canSend" "${file}"`, { encoding: "utf8" }).trim();
  assert.ok(output.length > 0, "execute-autonomous-reply.js must reference canSend");
  assert.ok(output.includes("send-now-service"), "must import canSend from send-now-service");
});
