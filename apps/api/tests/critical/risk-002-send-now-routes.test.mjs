import test from "node:test";
import assert from "node:assert/strict";

import { canSend } from "@/lib/domain/inbox/send-now-service.js";
import { createInboxSendNowQueueRow } from "@/lib/domain/inbox/send-now-service.js";
import { buildAndSendNow } from "@/lib/domain/outbound/send-now-request.js";

// ─── canSend unit tests ───────────────────────────────────────────────────────

function makeSuppressedSupabase() {
  return {
    from: (table) => ({
      select: () => ({
        eq: () => ({ eq: () => ({ or: () => ({ eq: () => Promise.resolve({ count: 1 }) }) }) }),
        maybeSingle: () => Promise.resolve({ data: null }),
        or: () => ({ eq: () => Promise.resolve({ count: 1 }) }),
      }),
    }),
  };
}

function makePausedSupabase() {
  return {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({
            data: { status: "paused_review", metadata: {} },
          }),
          or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
        }),
        or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
      }),
    }),
  };
}

function makeQuarantinedSupabase() {
  return {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({
            data: { status: "active", metadata: { incident_quarantine: true } },
          }),
          or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
        }),
        or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
      }),
    }),
  };
}

function makeCleanSupabase() {
  return {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { status: "active", metadata: {} } }),
          or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
        }),
        or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
      }),
    }),
  };
}

test("RISK-002/canSend: paused_review thread → thread_paused_review", async () => {
  const r = await canSend(
    { to_phone_number: "+15005550001", thread_key: "+15005550001", message_body: "Hello there!" },
    { supabase: makePausedSupabase() }
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "thread_paused_review");
});

test("RISK-002/canSend: quarantined thread → thread_quarantined", async () => {
  const r = await canSend(
    { to_phone_number: "+15005550001", thread_key: "+15005550001", message_body: "Hello there!" },
    { supabase: makeQuarantinedSupabase() }
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "thread_quarantined");
});

test("RISK-002/canSend: suppressed phone → phone_suppressed", async () => {
  const supabase = {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { status: "active", metadata: {} } }),
          or: () => ({ eq: () => Promise.resolve({ count: 1 }) }),
        }),
        or: () => ({ eq: () => Promise.resolve({ count: 1 }) }),
      }),
    }),
  };
  const r = await canSend(
    { to_phone_number: "+15005550001", thread_key: "+15005550001", message_body: "Hello there!" },
    { supabase }
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "phone_suppressed");
});

test("RISK-002/canSend: blank greeting fails validation → blank_greeting_message_body", async () => {
  const r = await canSend(
    { to_phone_number: "+15005550001", thread_key: "+15005550001", message_body: "Hi , how are you?" },
    { supabase: makeCleanSupabase() }
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "blank_greeting_message_body");
});

test("RISK-002/canSend: healthy thread + valid message → ok:true", async () => {
  const r = await canSend(
    { to_phone_number: "+15005550001", thread_key: "+15005550001", message_body: "Hi John, are you interested in selling?" },
    { supabase: makeCleanSupabase() }
  );
  assert.equal(r.ok, true);
});

// ─── RISK-002: identical payload → identical verdict across routes ─────────────

test("RISK-002: createInboxSendNowQueueRow blocked by gate (paused_review)", async () => {
  const result = await createInboxSendNowQueueRow(
    {
      thread_key: "+15005550001",
      to_phone_number: "+15005550001",
      from_phone_number: "+15005550002",
      message_body: "Hi John, are you interested in selling?",
    },
    {
      canSendImpl: async () => ({ ok: false, reason: "thread_paused_review" }),
      supabase: makeCleanSupabase(),
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "thread_paused_review");
  assert.equal(result.queue_created, false);
});

test("RISK-002: createInboxSendNowQueueRow blocked by gate (phone_suppressed)", async () => {
  const result = await createInboxSendNowQueueRow(
    {
      thread_key: "+15005550001",
      to_phone_number: "+15005550001",
      from_phone_number: "+15005550002",
      message_body: "Hi John, are you interested in selling?",
    },
    {
      canSendImpl: async () => ({ ok: false, reason: "phone_suppressed" }),
      supabase: makeCleanSupabase(),
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "phone_suppressed");
  assert.equal(result.queue_created, false);
  assert.equal(result.status, 423);
});

test("RISK-002: buildAndSendNow blocked by gate (phone_suppressed) — outbound route", async () => {
  let writer_called = false;
  const result = await buildAndSendNow(
    { phone: "+15005550001", rendered_message_text: "Hi John, are you interested in selling?" },
    {
      canSend: async () => ({ ok: false, reason: "phone_suppressed" }),
      queueOutboundMessageImpl: async () => { writer_called = true; return { ok: true }; },
      processSendQueueImpl: async () => ({ ok: true }),
      getSystemValue: async () => null,
    }
  );
  assert.equal(writer_called, false, "writer must not be called when gate fails");
  assert.equal(result.queued.ok, false);
  assert.equal(result.queued.reason, "phone_suppressed");
  assert.equal(result.queued.stage, "can_send_gate");
});

test("RISK-002: identical payload → same gate verdict across createInboxSendNowQueueRow and buildAndSendNow", async () => {
  const gateReason = "thread_quarantined";
  const mockGate = async () => ({ ok: false, reason: gateReason });

  const inboxResult = await createInboxSendNowQueueRow(
    { thread_key: "+15005550001", to_phone_number: "+15005550001", from_phone_number: "+15005550002", message_body: "Test" },
    { canSendImpl: mockGate, supabase: makeCleanSupabase() }
  );
  const outboundResult = await buildAndSendNow(
    { phone: "+15005550001" },
    { canSend: mockGate, getSystemValue: async () => null, queueOutboundMessageImpl: async () => ({ ok: true }), processSendQueueImpl: async () => ({ ok: true }) }
  );

  assert.equal(inboxResult.reason, gateReason);
  assert.equal(outboundResult.queued.reason, gateReason);
});

// ─── RISK-006 fail-closed: suppression DB error → send BLOCKED ────────────────

test("RISK-002/canSend: suppression lookup throws → send is BLOCKED (suppression_check_unavailable)", async () => {
  // Thread state query succeeds (active, not paused), but suppression throws.
  const supabase = {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          // Thread state returns active (no block)
          maybeSingle: () => Promise.resolve({ data: { status: "active", metadata: {} } }),
          // Suppression query throws to simulate DB error
          or: () => ({ eq: () => Promise.reject(new Error("connection_refused")) }),
        }),
        or: () => ({ eq: () => Promise.reject(new Error("connection_refused")) }),
      }),
    }),
  };

  const r = await canSend(
    { to_phone_number: "+15005550001", thread_key: "+15005550001", message_body: "Hi John, are you interested in selling?" },
    { supabase }
  );

  assert.equal(r.ok, false, "send must be BLOCKED when suppression check throws");
  assert.equal(r.reason, "suppression_check_unavailable");
});
