// ─── preserved-burst-acceptance.test.mjs ─────────────────────────────────────
// THE ACCEPTANCE CRITERION for burst flush activation authority.
//
// A single burst row survives the 2026-08-03 inbound incident and is preserved
// as evidence: thread `+16128072000`, generation 1, status open, attempt_count
// 0, never claimed. It is the only burst row in production.
//
// That thread key is also INTERNAL_PROOF_PINNED.recipient — the one thread the
// internal proof must send to. So the preserved row sits directly in the path
// of the proof that is meant to exercise the burst leg, and the store's unique
// partial index allows exactly ONE open generation per thread, which means the
// preserved row IS the open generation for the proof thread.
//
// The hazard this file pins is NOT the flush endpoint. It is the WEBHOOK:
//
//   inbound on the pinned thread during an active proof session
//     → coordinator.onPersistedInbound
//     → store.appendMessage → fetchOpen('+16128072000') = THE PRESERVED BURST
//     → 36h past hard_close_at → projectAppendToOpenBurst → `rollover: true`
//     → the Supabase store force-marks the old generation eligible
//        (eligible_at = now, version + 1, updated_at = now) BEFORE returning
//     → coordinator flushes the rollover
//     → claim_seller_inbound_burst( p_thread_key, p_burst_id => NULL )
//     → `ORDER BY b.eligible_at ASC … LIMIT 1` selects it
//     → a 36-hour-old "Yeah" runs a full orchestration turn.
//
// Every step of that chain is reachable with the flush cron disabled and the
// flush endpoint never invoked. The rollover write lands inside appendMessage,
// before the coordinator can observe `rollover`, so it cannot be gated from
// above — the guard has to live adjacent to the write.
//
// These tests seed a row SHAPED like the preserved one. They never read, write
// or otherwise touch the real production row.

import assert from "node:assert/strict";
import test from "node:test";

import { INTERNAL_PROOF_PINNED } from "@/lib/domain/queue/internal-proof-session.js";
import {
  activationScopeFromDescriptor,
  createSellerInboundBurstCoordinator,
} from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import { createMemorySellerInboundBurstStore } from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";
import { toBurstFlushScopeDescriptor } from "@/lib/domain/seller-flow/burst-flush-activation-policy.js";

// The real row's shape, from the read-only production fingerprint taken during
// the PR #66 containment audits.
const PRESERVED = Object.freeze({
  thread_key: INTERNAL_PROOF_PINNED.recipient,
  generation: 1,
  burst_id: "sib:+16128072000:g1:ba199924-5f13-4b2e-9f2e-471658cc8d2c",
  status: "open",
  first_received_at: "2026-08-03T22:40:31.039Z",
  last_received_at: "2026-08-03T22:40:31.039Z",
  eligible_at: "2026-08-03T22:40:51.039Z",
  hard_close_at: "2026-08-03T22:42:01.039Z",
  created_at: "2026-08-03T22:40:31.039Z",
  updated_at: "2026-08-03T22:42:16.901Z",
  claimed_at: null,
  claimed_by: null,
  claim_token: null,
  attempt_count: 0,
  completed_at: null,
  result_summary: null,
  version: 1,
  safety_latched: false,
  safety_reason: null,
  safety_kind: null,
  policy_version: 1,
  decision_idempotency_key: "seller_inbound_burst_decision:+16128072000:g1",
  latest_event_id: "evt-preserved-1",
  constituents: [
    {
      event_id: "evt-preserved-1",
      provider_message_id: "SMpreserved1",
      body: "Yeah",
      received_at: "2026-08-03T22:40:31.000Z",
    },
  ],
});

// Every field whose mutation would destroy or degrade the evidence.
const EVIDENCE_FIELDS = [
  "status",
  "version",
  "attempt_count",
  "claimed_at",
  "claimed_by",
  "claim_token",
  "eligible_at",
  "updated_at",
  "completed_at",
  "result_summary",
  "first_received_at",
  "last_received_at",
];

function seedPreserved(store) {
  const row = { ...PRESERVED, id: "row-preserved-1", constituents: [...PRESERVED.constituents] };
  store._debug.byId.set(row.id, row);
  store._debug.openByThread.set(row.thread_key, row.id);
  return row;
}

function fingerprint(store) {
  const row = store._debug.byId.get("row-preserved-1");
  assert.ok(row, "the preserved row must still exist");
  return Object.fromEntries(EVIDENCE_FIELDS.map((f) => [f, row[f] ?? null]));
}

// An ACTIVE proof session, opened now — i.e. long after the preserved burst.
function activeProofPolicy({ minutes_ago = 5, minutes_ahead = 30 } = {}) {
  const now = Date.now();
  const created_at = new Date(now - minutes_ago * 60_000).toISOString();
  const expires_at = new Date(now + minutes_ahead * 60_000).toISOString();
  return {
    mode: "internal_proof",
    may_scan: true,
    may_claim: true,
    scope: "thread",
    allowed_thread_key: INTERNAL_PROOF_PINNED.recipient,
    proof_session_id: "proof-acceptance-1",
    received_not_before: created_at,
    received_not_after: expires_at,
    created_not_before: created_at,
    reason: "internal_proof_session_active",
    alertable: false,
  };
}

function proofScope(overrides = {}) {
  return activationScopeFromDescriptor(
    toBurstFlushScopeDescriptor({ ...activeProofPolicy(), ...overrides })
  );
}

// ── The structural argument the whole design rests on ────────────────────────

test("an ACTIVE proof session can never have a window containing the preserved burst", () => {
  // parseInternalProofSession requires expires_at > now AND
  // expires_at - created_at <= 240 minutes. So an active session's created_at
  // is at most 240 minutes old, and the preserved burst is ~36 hours old.
  const scope = proofScope();
  assert.equal(scope.authorized, true);
  const floor = Date.parse(scope.min_first_received_at);
  const preserved = Date.parse(PRESERVED.first_received_at);
  assert.ok(
    preserved < floor,
    "the preserved burst must fall below any active session's floor"
  );
  assert.ok(
    Date.now() - floor <= 240 * 60_000,
    "an active session's floor can never be more than the 240-minute cap in the past"
  );
});

test("the preserved burst sits on the pinned proof thread — a thread_keys-only scope would ADMIT it", () => {
  // This is why the scope carries a time floor and not just a thread list.
  assert.equal(PRESERVED.thread_key, INTERNAL_PROOF_PINNED.recipient);
  const scope = proofScope();
  assert.deepEqual(scope.thread_keys, [INTERNAL_PROOF_PINNED.recipient]);
  assert.ok(scope.min_first_received_at, "a thread list alone cannot exclude it");
  assert.ok(scope.min_created_at, "row-creation floor required too");
});

// ── The acceptance criterion ─────────────────────────────────────────────────

test("ACCEPTANCE: an inbound during an active proof session does not mutate the preserved burst", async () => {
  const store = createMemorySellerInboundBurstStore();
  seedPreserved(store);
  const before = fingerprint(store);

  const processCalls = [];
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    activation_scope: proofScope(),
    processSellerInboundMessage: async (args) => {
      processCalls.push(args);
      return { ok: true, queued: true, execution: { queued: true } };
    },
  });

  const result = await coordinator.onPersistedInbound({
    thread_key: INTERNAL_PROOF_PINNED.recipient,
    event_id: "evt-proof-1",
    provider_message_id: "SMproof1",
    body: "starting the internal proof",
    received_at: new Date().toISOString(),
  });

  assert.deepEqual(
    fingerprint(store),
    before,
    "every evidence-bearing field on the preserved row must be byte-identical"
  );
  assert.equal(processCalls.length, 0, "the preserved burst must never reach an orchestration turn");
  // The burst layer DECLINES: it neither rolls the preserved row over nor
  // claims custody of the message. `deferred: false` is the load-bearing half —
  // saying `true` here would abandon the message with no burst to finalize it,
  // and `ok: false` would throw the webhook into endless provider redelivery
  // against a refusal that can never succeed.
  assert.equal(result.declined, true, "the burst layer must declare the decline");
  assert.equal(result.deferred, false, "a declined message must NOT be reported as deferred");
  assert.equal(result.ok, true, "a decline is not an infrastructure failure — it must not redeliver");
  assert.equal(result.reason, "open_generation_out_of_scope");
  assert.equal(
    result.blocking_burst_id,
    PRESERVED.burst_id,
    "the refusal must name the blocking generation so an operator can act on it"
  );
});

test("ACCEPTANCE: a targeted flush of the pinned thread cannot claim the preserved burst", async () => {
  const store = createMemorySellerInboundBurstStore();
  seedPreserved(store);
  const before = fingerprint(store);

  const processCalls = [];
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    activation_scope: proofScope(),
    processSellerInboundMessage: async (args) => {
      processCalls.push(args);
      return { ok: true, queued: true, execution: { queued: true } };
    },
  });

  // The exact bypass: name the pinned thread and ask for a flush.
  const flush = await coordinator.flushEligible({
    thread_key: INTERNAL_PROOF_PINNED.recipient,
    limit: 20,
  });

  assert.deepEqual(fingerprint(store), before);
  assert.equal(processCalls.length, 0);
  assert.equal(flush.results.length, 0, "an out-of-scope row must not be listed as eligible");
});

test("ACCEPTANCE: naming the preserved burst_id explicitly still cannot claim it", async () => {
  const store = createMemorySellerInboundBurstStore();
  seedPreserved(store);
  const before = fingerprint(store);

  const coordinator = createSellerInboundBurstCoordinator({
    store,
    activation_scope: proofScope(),
    processSellerInboundMessage: async () => {
      throw new Error("must never be reached");
    },
  });

  const result = await coordinator.finalizeBurst({
    thread_key: INTERNAL_PROOF_PINNED.recipient,
    burst_id: PRESERVED.burst_id,
  });

  assert.equal(result.ok, false, "an explicit id is not an authorization");
  assert.deepEqual(fingerprint(store), before);
});

// ── The scope must still be a licence for legitimate work ────────────────────

// The guard must deny the artifact WITHOUT making internal_proof inert. If the
// only thing this change achieved were a mode that can never do anything, the
// proof would be no closer to running than it was before.
test("internal_proof is NOT inert: an in-window burst on the pinned thread finalizes", async () => {
  // No preserved generation on the thread — the state after an operator has
  // resolved the blocking row. Controlled clock so the trailing-edge quiet
  // window can actually close.
  let clock = Date.now();
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const processCalls = [];
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    activation_scope: proofScope(),
    processSellerInboundMessage: async (args) => {
      processCalls.push(args);
      return { ok: true, queued: true, execution: { queued: true } };
    },
  });

  const appended = await coordinator.onPersistedInbound({
    thread_key: INTERNAL_PROOF_PINNED.recipient,
    event_id: "evt-live-1",
    provider_message_id: "SMlive1",
    body: "in-window fragment",
    received_at: now(),
  });
  assert.equal(appended.deferred, true, "an in-window burst must still open and defer");
  assert.equal(appended.append.burst.generation, 1);

  // Past the 20s trailing edge.
  clock += 25_000;

  const burst_id = appended.append.burst.burst_id;
  const flush = await coordinator.finalizeBurst({
    thread_key: INTERNAL_PROOF_PINNED.recipient,
    burst_id,
  });
  assert.equal(flush.ok, true, "an in-scope burst must finalize — the mode is a licence, not a wall");
  assert.equal(processCalls.length, 1, "exactly one aggregate orchestration turn");
});

test("a REAL SELLER thread is denied in internal_proof mode", async () => {
  const store = createMemorySellerInboundBurstStore();
  const processCalls = [];
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    activation_scope: proofScope(),
    processSellerInboundMessage: async (args) => {
      processCalls.push(args);
      return { ok: true, queued: true, execution: { queued: true } };
    },
  });

  const appended = await coordinator.onPersistedInbound({
    thread_key: "+15551110123",
    event_id: "evt-seller-1",
    provider_message_id: "SMseller1",
    body: "yeah I might sell",
    received_at: new Date().toISOString(),
  });
  assert.notEqual(appended.deferred, true, "a real seller thread must never engage burst here");
  assert.equal(processCalls.length, 0);
  assert.equal(store._debug.listAll().length, 0, "and must not create a burst row at all");
});

test("global (enabled-mode) activation is unchanged: the coordinator still flushes normally", async () => {
  const store = createMemorySellerInboundBurstStore();
  const processCalls = [];
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    enabled: true,
    processSellerInboundMessage: async (args) => {
      processCalls.push(args);
      return { ok: true, queued: true, execution: { queued: true } };
    },
  });

  const appended = await coordinator.onPersistedInbound({
    thread_key: "+15551110099",
    event_id: "evt-global-1",
    provider_message_id: "SMglobal1",
    body: "ordinary seller message",
    received_at: new Date().toISOString(),
  });
  assert.equal(appended.deferred, true, "global activation must keep deferring as it does today");
  assert.equal(appended.append.burst.generation, 1);
});

test("an unauthorized coordinator refuses every door", async () => {
  const store = createMemorySellerInboundBurstStore();
  seedPreserved(store);
  const before = fingerprint(store);

  // No scope, no `enabled` — deny by default.
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    activation_scope: { authorized: false, global: false, kind: "none", reason: "session_expired" },
    processSellerInboundMessage: async () => {
      throw new Error("must never be reached");
    },
  });

  const ingest = await coordinator.onPersistedInbound({
    thread_key: INTERNAL_PROOF_PINNED.recipient,
    event_id: "evt-x",
    provider_message_id: "SMx",
    body: "anything",
    received_at: new Date().toISOString(),
  });
  assert.equal(ingest.deferred, false);
  assert.equal(ingest.reason, "burst_disabled");

  const flush = await coordinator.flushEligible({});
  assert.equal(flush.ok, false);
  assert.equal(flush.reason, "burst_scope_unauthorized");

  const finalize = await coordinator.finalizeBurst({
    thread_key: INTERNAL_PROOF_PINNED.recipient,
    burst_id: PRESERVED.burst_id,
  });
  assert.equal(finalize.ok, false);
  assert.equal(finalize.reason, "burst_scope_unauthorized");

  assert.deepEqual(fingerprint(store), before);
});

test("finalizeBurst refuses an unpinned thread-scoped claim — the unpinned path is unreachable", async () => {
  const store = createMemorySellerInboundBurstStore();
  seedPreserved(store);
  const before = fingerprint(store);
  const alerts = [];

  const coordinator = createSellerInboundBurstCoordinator({
    store,
    enabled: true, // even a GLOBAL licence may not claim without naming a target
    alertBurstFailure: async (a) => alerts.push(a),
    processSellerInboundMessage: async () => {
      throw new Error("must never be reached");
    },
  });

  for (const burst_id of [undefined, null, "", "   "]) {
    const result = await coordinator.finalizeBurst({
      thread_key: INTERNAL_PROOF_PINNED.recipient,
      burst_id,
    });
    assert.equal(result.ok, false, `blank burst_id (${JSON.stringify(burst_id)}) must refuse`);
    assert.equal(result.reason, "finalize_requires_burst_id");
  }

  assert.equal(alerts.length, 4, "every refusal is alerted, never silent");
  assert.deepEqual(
    fingerprint(store),
    before,
    "a global licence with no named target must still not claim the oldest row"
  );
});
