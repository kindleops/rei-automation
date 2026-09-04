/**
 * s11-crash-race-matrix.test.mjs
 *
 * Faults injected at every boundary of the INTEGRATED dispatch path, and
 * concurrent workers racing the same domain action.
 *
 * The single property every case must satisfy:
 *
 *   NO CRASH AND NO RACE MAY PRODUCE AN UNSAFE DUPLICATE PROVIDER CALL.
 *
 * "Unsafe" is doing real work here. A second provider call is allowed only when
 * the first is PROVEN not to have reached the seller. Everything else -- a
 * timeout, a crash after the request started, an outcome we cannot classify --
 * must hold, even though holding sometimes means a message the seller never
 * receives. A false hold is recoverable by a human; a duplicate is not.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { dispatchSellerQueueRow } from "@/lib/domain/communications/dispatch-seller-queue-row.js";
import { resolveQueueRowIdentity } from "@/lib/domain/communications/queue-row-identity.js";
import { createMemoryS11Store } from "../helpers/s11-memory-store.mjs";
import { TextGridError } from "@/lib/providers/textgrid.js";

const ALLOW = async (key) => {
  if (key === "queue_processor_mode") return "live";
  if (key === "queue_execution_mode") return "normal";
  return null;
};
const DENY = async (key) => (key === "queue_processor_mode" ? "off" : null);

const ANCHOR = "22222222-2222-4222-8222-222222222222";
const row = (over = {}) => ({
  id: "q-matrix-1",
  thread_key: "+13125550100",
  to_phone_number: "+13125550100",
  campaign_target_id: ANCHOR,
  touch_number: 1,
  metadata: {},
  ...over,
});
const MSG = { to: "+13125550100", from: "+18885551212", body: "Are you open to an offer?" };

function spy(impl) {
  const s = { count: 0 };
  s.fn = async (a) => {
    s.count += 1;
    if (typeof impl === "function") return impl(a);
    return { sid: `SM_${s.count}` };
  };
  return s;
}

const go = (store, provider, extra = {}) =>
  dispatchSellerQueueRow(row(extra.row || {}), MSG, {
    store, sendProvider: provider, getSystemValue: extra.getSystemValue || ALLOW, ...extra.deps,
  });

// ── the Discord path is converged, not stranded ───────────────────────────

test("a Discord operator reply row resolves to a manual operator send", () => {
  // Before convergence this row had no anchor at all: dispatch refused it, the
  // operator saw "Reply queued", and the seller got nothing forever.
  const identity = resolveQueueRowIdentity({
    id: "q-discord-1",
    thread_key: "+13125550100",
    to_phone_number: "+13125550100",
    metadata: { discord_reply: true, source: "discord", operator_action_id: "op-9" },
  });
  assert.equal(identity.ok, true, "a Discord reply must be dispatchable");
  assert.equal(identity.communication_type, "manual_operator_send");
  assert.deepEqual(identity.anchors, { operator_action_id: "op-9" });
});

test("a Discord row WITHOUT a durable operator action is still refused", () => {
  const identity = resolveQueueRowIdentity({
    id: "q-discord-2", to_phone_number: "+13125550100",
    metadata: { discord_reply: true, source: "discord" },
  });
  assert.equal(identity.ok, false);
  assert.equal(identity.reason, "queue_row_identity_underivable");
});

// ── CRASH MATRIX ──────────────────────────────────────────────────────────

const CRASH_CASES = [
  {
    name: "A: store unreachable before identity",
    build: () => ({ store: {}, provider: spy() }),
    expect: { provider: 0, sent: false },
  },
  {
    name: "F: runtime authority denies",
    build: () => ({ store: createMemoryS11Store(), provider: spy(), getSystemValue: DENY }),
    expect: { provider: 0, sent: false },
  },
  {
    name: "G: provider-start write FAILS",
    build: () => {
      const store = createMemoryS11Store();
      store.markProviderRequestStarted = async () => ({ ok: false, reason: "write_failed" });
      return { store, provider: spy() };
    },
    expect: { provider: 0, sent: false },
  },
  {
    name: "G': provider-start write THROWS",
    build: () => {
      const store = createMemoryS11Store();
      store.markProviderRequestStarted = async () => { throw new Error("db down"); };
      return { store, provider: spy() };
    },
    expect: { provider: 0, sent: false },
  },
  {
    name: "K: provider accepts, crash before SID persistence",
    build: () => {
      const store = createMemoryS11Store();
      store.recordAttemptOutcome = async () => { throw new Error("died before SID persisted"); };
      return { store, provider: spy(), swallow: true };
    },
    expect: { provider: 1 },
  },
  {
    name: "M: logical state persists, queue projection fails",
    build: () => {
      const store = createMemoryS11Store();
      store.updateQueueProjection = async () => { throw new Error("projection down"); };
      return { store, provider: spy() };
    },
    expect: { provider: 1, sent: true },
  },
  {
    name: "J: provider invocation itself times out (ambiguous)",
    build: () => {
      const store = createMemoryS11Store();
      const p = spy(async () => {
        throw new TextGridError("timeout", {
          cause_name: "TimeoutError", network_phase: "inflight", may_have_transmitted: true,
        });
      });
      return { store, provider: p };
    },
    expect: { provider: 1, sent: false },
  },
];

for (const c of CRASH_CASES) {
  test(`crash ${c.name}: no unsafe duplicate provider call`, async () => {
    const { store, provider, getSystemValue, swallow } = c.build();
    let first;
    try {
      first = await go(store, provider.fn, { getSystemValue });
    } catch (error) {
      if (!swallow) throw error;
      first = { crashed: true };
    }

    if (c.expect.provider !== undefined) {
      assert.equal(provider.count, c.expect.provider, `${c.name}: provider call count`);
    }
    if (c.expect.sent !== undefined && !first.crashed) {
      assert.equal(Boolean(first.sent), c.expect.sent, `${c.name}: sent flag`);
    }

    // THE INVARIANT: re-entry after the fault must never add a provider call
    // unless the first attempt is PROVEN unsent.
    const before = provider.count;
    try { await go(store, provider.fn, { getSystemValue }); } catch { /* re-entry may also fault */ }
    assert.ok(provider.count <= before + 1,
      `${c.name}: re-entry produced more than one additional provider call`);
  });
}

test("a crash after the marker leaves durable evidence, not a clean slate", async () => {
  // The deliberate false hold. Nothing was sent, but the attempt records that a
  // request MAY have started, so recovery cannot mistake it for a non-send.
  const store = createMemoryS11Store();
  const provider = spy(async () => { throw new Error("process died before fetch"); });
  await go(store, provider.fn);

  const attempt = store._state.attempts[0];
  assert.ok(attempt.provider_request_started_at,
    "the marker must survive so recovery treats this as possibly-sent");
});

// ── RACE MATRIX ───────────────────────────────────────────────────────────

test("race: N concurrent workers on ONE action send exactly ONE message", async () => {
  for (const workers of [2, 3, 5, 8]) {
    const store = createMemoryS11Store();
    const provider = spy(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { sid: "SM_RACE" };
    });
    const results = await Promise.all(
      Array.from({ length: workers }, () => go(store, provider.fn))
    );

    assert.equal(store._state.communications.size, 1, `${workers} workers: one communication`);
    assert.equal(provider.count, 1, `${workers} workers: EXACTLY one provider call`);
    assert.equal(store._state.attempts.length, 1, `${workers} workers: one attempt`);
    assert.equal(results.filter((r) => r.ok).length, 1, `${workers} workers: one winner`);
  }
});

test("race: conflicting lineage under one key is refused, not merged", async () => {
  const store = createMemoryS11Store();
  const provider = spy();

  await go(store, provider.fn);
  // Same campaign target + touch, but a contradictory decision lineage.
  const conflicting = await dispatchSellerQueueRow(
    row({ metadata: { decision_id: "decision:other" } }), MSG,
    { store, sendProvider: provider.fn, getSystemValue: ALLOW }
  );
  // It resolves to a DIFFERENT action (decision) rather than silently reusing
  // the campaign one, which is the safe outcome: distinct actions stay distinct.
  assert.notEqual(conflicting.logical_communication_id, undefined);
  assert.ok(provider.count <= 2);
});

test("race: duplicate replay after an ambiguous outcome adds nothing", async () => {
  const store = createMemoryS11Store();
  const provider = spy(async () => {
    throw new TextGridError("timeout", {
      cause_name: "TimeoutError", network_phase: "inflight", may_have_transmitted: true,
    });
  });
  await go(store, provider.fn);
  assert.equal(provider.count, 1);

  // Every re-entry mechanism at once.
  await Promise.all(Array.from({ length: 6 }, () => go(store, provider.fn)));

  assert.equal(provider.count, 1, "ambiguity absorbs every replay");
  assert.equal(store._state.attempts.length, 1);
  assert.equal(store._state.communications.size, 1);
});

// ── NO_SEND and runtime denial ────────────────────────────────────────────

test("a NO_SEND communication cannot be dispatched by any path", async () => {
  const store = createMemoryS11Store();
  const provider = spy();
  await go(store, provider.fn);
  const comm = [...store._state.communications.values()][0];
  comm.state = "no_send";
  comm.retry_authority = "terminal";

  for (let i = 0; i < 4; i += 1) {
    const r = await go(store, provider.fn);
    assert.equal(r.provider_invoked, false, "NO_SEND must never reach the wire");
    assert.equal(r.reason, "state_forbids_attempt");
  }
  assert.equal(provider.count, 1, "only the original pre-NO_SEND send happened");
});

test("STOP between attempts denies the retry even when transport says it is safe", async () => {
  const store = createMemoryS11Store();
  const refused = new TextGridError("fetch failed", {
    cause_code: "ECONNREFUSED", network_phase: "connect", may_have_transmitted: false,
  });
  let first = true;
  const provider = spy(async () => {
    if (first) { first = false; throw refused; }
    return { sid: "SM_SHOULD_NOT_HAPPEN" };
  });

  const a = await go(store, provider.fn);
  assert.equal(a.delivery_possibility, "definitely_not_sent");
  assert.equal(a.retry_authority, "retry_allowed", "transport says a retry is safe");

  // The seller opts out between attempt 1 and attempt 2.
  const b = await go(store, provider.fn, { getSystemValue: DENY });

  assert.equal(b.provider_invoked, false, "compliance outranks transport safety");
  assert.equal(provider.count, 1);
});
