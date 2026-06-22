import test from "node:test";
import assert from "node:assert/strict";

import { executeAutonomousReply } from "@/lib/domain/seller-flow/execute-autonomous-reply.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBaseInput(overrides = {}) {
  return {
    thread_key: "T1",
    to_phone_number: "+15005550001",
    from_phone_number: "+15005550002",
    message_body: "Thank you for confirming ownership. We can discuss an offer.",
    template_id: "tpl-auto-1",
    source_event_id: "evt-abc123",
    stage: "stage_a",
    agent_persona: "default",
    ...overrides,
  };
}

// Supabase mock that handles all chain methods used by execute-autonomous-reply:
//   .from(...).select(...).eq(...).limit(...).maybeSingle()   — idempotency check
//   .from(...).select(...).eq(...).in(...).contains(...).gte(...) — dup body guard
//   .from(...).insert(...).select(...).single()               — row insert
function makeSupabase() {
  const chain = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    eq: () => chain,
    in: () => chain,
    contains: () => chain,
    gte: () => chain,
    limit: () => chain,
    single: () => Promise.resolve({ data: { id: "q-auto-1", status: "queued" }, error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (resolve) => resolve({ data: null, error: null, count: 0 }),
  };
  return {
    from: () => chain,
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

// Gate blocks → writer never called
test("RISK-004: paused thread → gate blocks, writer not called", async () => {
  let writer_called = false;
  const result = await executeAutonomousReply(makeBaseInput(), {
    canSendImpl: async () => ({ ok: false, reason: "thread_paused_review" }),
    insertQueueImpl: async () => { writer_called = true; return { ok: true, id: "q-1" }; },
    getSystemValue: async () => null,
    supabase: makeSupabase(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "thread_paused_review");
  assert.equal(writer_called, false, "canonical writer must NOT be called when gate fails");
});

test("RISK-004: quarantined thread → gate blocks, writer not called", async () => {
  let writer_called = false;
  const result = await executeAutonomousReply(makeBaseInput(), {
    canSendImpl: async () => ({ ok: false, reason: "thread_quarantined" }),
    insertQueueImpl: async () => { writer_called = true; return { ok: true, id: "q-1" }; },
    getSystemValue: async () => null,
    supabase: makeSupabase(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "thread_quarantined");
  assert.equal(writer_called, false);
});

test("RISK-004: suppressed phone → gate blocks, writer not called", async () => {
  let writer_called = false;
  const result = await executeAutonomousReply(makeBaseInput(), {
    canSendImpl: async () => ({ ok: false, reason: "phone_suppressed" }),
    insertQueueImpl: async () => { writer_called = true; return { ok: true, id: "q-1" }; },
    getSystemValue: async () => null,
    supabase: makeSupabase(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "phone_suppressed");
  assert.equal(writer_called, false);
});

// Healthy thread enqueues exactly once
test("RISK-004: healthy thread → gate passes, writer called exactly once", async () => {
  let write_count = 0;
  const result = await executeAutonomousReply(makeBaseInput(), {
    canSendImpl: async () => ({ ok: true, reason: null }),
    insertQueueImpl: async () => {
      write_count++;
      return { queue_row_id: "q-1" };
    },
    getSystemValue: async () => null,
    supabase: makeSupabase(),
  });
  assert.equal(write_count, 1, "writer must be called exactly once on success");
});

// Idempotency — second call with same source_event_id is blocked by DB idempotency_key
test("RISK-004: second call with same source_event_id returns idempotency_blocked", async () => {
  // Simulate existing row found for idempotency_key
  const chain_existing = {
    select: () => chain_existing,
    insert: () => chain_existing,
    eq: () => chain_existing,
    in: () => chain_existing,
    contains: () => chain_existing,
    gte: () => chain_existing,
    limit: () => chain_existing,
    single: () => Promise.resolve({ data: { id: "q-existing", status: "queued" }, error: null }),
    maybeSingle: () => Promise.resolve({ data: { id: "q-existing", queue_status: "queued" }, error: null }),
    then: (resolve) => resolve({ data: null, error: null, count: 0 }),
  };
  const supabase_existing = {
    from: () => chain_existing,
    rpc: () => Promise.resolve({ data: null, error: null }),
  };

  let writer_called = false;
  const result = await executeAutonomousReply(makeBaseInput(), {
    canSendImpl: async () => ({ ok: true, reason: null }),
    insertQueueImpl: async () => { writer_called = true; return { ok: true }; },
    getSystemValue: async () => null,
    supabase: supabase_existing,
  });

  assert.equal(writer_called, false, "writer must not be called for idempotency-blocked send");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "idempotency_blocked");
});
