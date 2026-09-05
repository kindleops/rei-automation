/**
 * canonical-communication-dispatch.test.mjs
 *
 * The seam where a seller message reaches the wire.
 *
 * The central assertion in almost every test below is a NETWORK SPY COUNT.
 * Reasoning about which branch "should" return early is not proof; counting
 * actual provider invocations is.
 *
 * The ordering guarantee under test:
 *   provider_request_started must be CONFIRMED durable before the network call,
 *   so a crash can never look like a non-send.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { executeSellerCommunicationAttempt } from "@/lib/domain/communications/canonical-communication-dispatch.js";
import { buildLogicalCommunicationKey } from "@/lib/domain/communications/logical-communication-key.js";
import {
  LOGICAL_STATES as S,
  DELIVERY_POSSIBILITY as D,
  RETRY_AUTHORITY as R,
} from "@/lib/domain/communications/communication-transition-authority.js";
import { classifyTextGridProviderError } from "@/lib/domain/messaging/textgrid-provider-error-classifier.js";
import { TextGridError } from "@/lib/providers/textgrid.js";

/** An in-memory store that behaves like the real RPCs, plus fault injection. */
function makeStore(overrides = {}) {
  const state = {
    communications: new Map(),   // logical_key -> row
    attempts: [],
    transitions: [],
    projections: [],
  };

  const store = {
    _state: state,
    async getOrCreateLogicalCommunication({ logical_key, communication_type, lineage }) {
      const existing = state.communications.get(logical_key);
      if (existing) {
        // Lineage conflict refusal, mirroring the SQL WHERE guard.
        if (existing.communication_type !== communication_type
            || (existing.decision_id ?? null) !== (lineage?.decision_id ?? null)) {
          return { ok: false, reason: "logical_communication_identity_conflict",
                   conflicting_fields: ["decision_id"] };
        }
        existing.observation_count += 1;
        return { ok: true, reused: true, communication: existing };
      }
      const row = {
        id: `lc-${state.communications.size + 1}`,
        logical_key,
        communication_type,
        decision_id: lineage?.decision_id ?? null,
        state: S.READY,
        delivery_possibility: D.DEFINITELY_NOT_SENT,
        retry_authority: R.RETRY_ALLOWED,
        retry_after_at: null,
        observation_count: 1,
      };
      state.communications.set(logical_key, row);
      return { ok: true, reused: false, communication: row };
    },
    async allocateAttempt({ logical_communication_id }) {
      const siblings = state.attempts.filter((a) => a.logical_communication_id === logical_communication_id);
      // Mirrors the RPC's in-flight guard. Without it, concurrent workers each
      // pass the parent-state checks and every one of them sends.
      if (siblings.some((a) => !a.completed_at)) {
        return { ok: false, reason: "attempt_already_in_flight" };
      }
      const attempt = { id: `att-${state.attempts.length + 1}`, logical_communication_id,
                        attempt_number: siblings.length + 1,
                        provider_request_started_at: null, completed_at: null };
      state.attempts.push(attempt);
      return { ok: true, attempt_id: attempt.id, attempt_number: attempt.attempt_number };
    },
    async markProviderRequestStarted({ attempt_id, at }) {
      const a = state.attempts.find((x) => x.id === attempt_id);
      a.provider_request_started_at = at;
      return { ok: true };
    },
    async recordAttemptOutcome(patch) {
      const a = state.attempts.find((x) => x.id === patch.attempt_id);
      Object.assign(a, patch, { completed_at: patch.at });
      return { ok: true };
    },
    async applyLogicalTransition({ logical_communication_id, next, cause }) {
      const row = [...state.communications.values()].find((c) => c.id === logical_communication_id);
      Object.assign(row, next);
      state.transitions.push({ logical_communication_id, next, cause });
      return { ok: true };
    },
    async updateQueueProjection(p) { state.projections.push({ kind: "queue", ...p }); return { ok: true }; },
    async writeMessageEventProjection(p) { state.projections.push({ kind: "message_event", ...p }); return { ok: true }; },
    ...overrides,
  };
  return store;
}

function makeSpy(impl) {
  const spy = { count: 0, calls: [] };
  spy.fn = async (args) => {
    spy.count += 1;
    spy.calls.push(args);
    if (typeof impl === "function") return impl(args);
    return { sid: `SM_${spy.count}` };
  };
  return spy;
}

const ALLOW = async () => ({ ok: true });
const CONTENT_OK = async () => ({ ok: true });

const REPLY = {
  communication_type: "autonomous_reply",
  anchors: { decision_id: "decision:evt-1" },
  lineage: { thread_key: "+13125550100", decision_id: "decision:evt-1" },
  message: { to: "+13125550100", from: "+18885551212", body: "Are you open to an offer?" },
};

const run = (deps, input = REPLY) =>
  executeSellerCommunicationAttempt(input, {
    evaluateRuntimeAuthority: ALLOW,
    assertOutboundContent: CONTENT_OK,
    classifyProviderError: classifyTextGridProviderError,
    now: "2026-09-04T12:00:00.000Z",
    ...deps,
  });

// ── the happy path exists, so the denials below are not vacuous ────────────

test("a fully authorised send reaches the provider exactly once", async () => {
  const spy = makeSpy();
  const r = await run({ store: makeStore(), sendProvider: spy.fn });
  assert.equal(spy.count, 1);
  assert.equal(r.ok, true);
  assert.equal(r.provider_message_id, "SM_1");
  assert.equal(r.delivery_possibility, D.PROVIDER_ACCEPTED);
  assert.equal(r.retry_authority, R.TERMINAL, "acceptance must deny further retries");
});

// ── every denial path: provider count MUST be zero ─────────────────────────

test("NO denial path ever reaches the network", async () => {
  const cases = [
    ["missing identity anchor", { store: makeStore() },
      { ...REPLY, anchors: {} }],
    ["store unavailable", { store: {} }, REPLY],
    ["identity conflict", {
      store: (() => {
        const s = makeStore();
        s.getOrCreateLogicalCommunication = async () =>
          ({ ok: false, reason: "logical_communication_identity_conflict", conflicting_fields: ["decision_id"] });
        return s;
      })(),
    }, REPLY],
    ["runtime authority denied (STOP/DNC/brake)", {
      store: makeStore(),
      evaluateRuntimeAuthority: async () => ({ ok: false, reason: "queue_emergency_stop_active" }),
    }, REPLY],
    ["runtime authority unavailable", {
      store: makeStore(), evaluateRuntimeAuthority: undefined,
    }, REPLY],
    ["content rejected (em dash guard)", {
      store: makeStore(),
      assertOutboundContent: async () => ({ ok: false, reason: "em_dash_forbidden" }),
    }, REPLY],
    ["attempt allocation denied", {
      store: (() => {
        const s = makeStore();
        s.allocateAttempt = async () => ({ ok: false, reason: "ambiguous_outcome_absorbing" });
        return s;
      })(),
    }, REPLY],
    ["provider-start persistence FAILS", {
      store: (() => {
        const s = makeStore();
        s.markProviderRequestStarted = async () => ({ ok: false, reason: "write_failed" });
        return s;
      })(),
    }, REPLY],
    ["provider-start persistence THROWS", {
      store: (() => {
        const s = makeStore();
        s.markProviderRequestStarted = async () => { throw new Error("db down"); };
        return s;
      })(),
    }, REPLY],
  ];

  for (const [label, deps, input] of cases) {
    const spy = makeSpy();
    const r = await run({ ...deps, sendProvider: spy.fn }, input);
    assert.equal(spy.count, 0, `${label}: provider must NOT be invoked`);
    assert.equal(r.provider_invoked, false, `${label}: must report no invocation`);
    assert.equal(r.ok, false, label);
  }
});

test("an ambiguous communication cannot dispatch at all", async () => {
  const store = makeStore();
  // Pre-seed the exact posture a timeout leaves behind, under the REAL key the
  // dispatcher will derive. A hand-written key would simply miss, the dispatcher
  // would mint a fresh READY row, and the test would pass while proving nothing.
  const key = buildLogicalCommunicationKey({
    communication_type: REPLY.communication_type, ...REPLY.anchors,
  });
  assert.equal(key.ok, true, "fixture key must be derivable");
  await store.getOrCreateLogicalCommunication({
    logical_key: key.key,
    communication_type: "autonomous_reply",
    lineage: { decision_id: "decision:evt-1" },
  });
  const row = [...store._state.communications.values()][0];
  row.state = S.AMBIGUOUS;
  row.delivery_possibility = D.MAY_HAVE_BEEN_SENT;
  row.retry_authority = R.RETRY_DENIED;

  const spy = makeSpy();
  const r = await run({ store, sendProvider: spy.fn });
  assert.equal(spy.count, 0, "an ambiguous parent must never reach the wire");
  assert.equal(r.stage, "transport_authority");
  assert.equal(r.reason, "ambiguous_outcome_absorbing");
});

// ── ordering: the marker is durable BEFORE the wire ────────────────────────

test("provider_request_started is persisted BEFORE the provider is called", async () => {
  const order = [];
  const store = makeStore();
  const inner = store.markProviderRequestStarted.bind(store);
  store.markProviderRequestStarted = async (args) => { order.push("marker"); return inner(args); };
  const spy = makeSpy(async () => { order.push("network"); return { sid: "SM_1" }; });

  await run({ store, sendProvider: spy.fn });
  assert.deepEqual(order, ["marker", "network"], "the marker must commit first");
});

test("FALSE HOLD: a crash after the marker but before the wire leaves durable evidence", async () => {
  // The deliberate trade. The marker is committed, the process dies before
  // fetch(), so nothing was sent -- but the attempt records that a request MAY
  // have started. Recovery must therefore treat it as possibly-sent.
  const store = makeStore();
  const spy = makeSpy();
  const crash = new Error("process died before fetch");

  await run({
    store,
    sendProvider: async () => { throw crash; },
  }).catch(() => {});

  const attempt = store._state.attempts[0];
  assert.ok(attempt.provider_request_started_at,
    "the marker must survive so recovery cannot mistake this for a non-send");
  assert.equal(spy.count, 0, "the real network was never reached in this fixture");
});

// ── outcomes ───────────────────────────────────────────────────────────────

test("a TIMEOUT produces exactly one attempt and denies further retry", async () => {
  const store = makeStore();
  const timeout = new TextGridError("The operation was aborted due to timeout", {
    cause_name: "TimeoutError", network_phase: "inflight", may_have_transmitted: true,
  });
  const spy = makeSpy(async () => { throw timeout; });

  const r = await run({ store, sendProvider: spy.fn });

  assert.equal(spy.count, 1, "the provider was invoked exactly once");
  assert.equal(store._state.attempts.length, 1, "exactly one attempt");
  assert.equal(store._state.communications.size, 1, "exactly one logical communication");
  assert.equal(r.delivery_possibility, D.MAY_HAVE_BEEN_SENT);
  assert.equal(r.retry_authority, R.RETRY_DENIED);
  assert.equal(r.logical_state, S.AMBIGUOUS);
});

test("after an ambiguous outcome, EVERY re-entry attempt is refused", async () => {
  const store = makeStore();
  const timeout = new TextGridError("timeout", {
    cause_name: "TimeoutError", network_phase: "inflight", may_have_transmitted: true,
  });
  const spy = makeSpy(async () => { throw timeout; });

  await run({ store, sendProvider: spy.fn });
  assert.equal(spy.count, 1);

  // Every path a worker, campaign, rotation or duplicate invocation might take
  // resolves to the SAME logical communication and is refused.
  for (let i = 0; i < 5; i += 1) {
    const again = await run({ store, sendProvider: spy.fn });
    assert.equal(again.ok, false, `re-entry ${i} must be refused`);
    assert.equal(again.reason, "ambiguous_outcome_absorbing");
  }
  assert.equal(spy.count, 1, "provider invocation count must remain 1");
  assert.equal(store._state.attempts.length, 1, "no second attempt may be allocated");
  assert.equal(store._state.communications.size, 1, "no second logical communication");
});

test("a PROVABLY UNSENT failure allows attempt 2 on the SAME communication", async () => {
  const store = makeStore();
  const refused = new TextGridError("fetch failed", {
    cause_code: "ECONNREFUSED", network_phase: "connect", may_have_transmitted: false,
  });
  let first = true;
  const spy = makeSpy(async () => {
    if (first) { first = false; throw refused; }
    return { sid: "SM_2" };
  });

  const a = await run({ store, sendProvider: spy.fn });
  assert.equal(a.delivery_possibility, D.DEFINITELY_NOT_SENT);
  assert.equal(a.retry_authority, R.RETRY_ALLOWED);

  const b = await run({ store, sendProvider: spy.fn });
  assert.equal(b.ok, true, `retry should proceed: ${b.reason}`);
  assert.equal(store._state.communications.size, 1, "a retry is the SAME domain action");
  assert.equal(store._state.attempts.length, 2, "a retry is a NEW attempt");
  assert.equal(spy.count, 2);
});

test("provider acceptance survives a projection failure without resending", async () => {
  const store = makeStore();
  store.updateQueueProjection = async () => { throw new Error("projection db down"); };
  const spy = makeSpy();

  const r = await run({ store, sendProvider: spy.fn });
  assert.equal(spy.count, 1);
  assert.equal(r.provider_message_id, "SM_1");
  assert.equal(r.retry_authority, R.TERMINAL, "acceptance denies retry even if projections fail");

  // A follow-up execution must not resend.
  const again = await run({ store, sendProvider: spy.fn });
  assert.equal(again.ok, false);
  assert.equal(spy.count, 1, "a projection failure must never cause a second send");
});

// ── duplicate work resolves to one action ──────────────────────────────────

test("duplicate concurrent workers send the seller EXACTLY ONE message", async () => {
  // The defect this whole slice exists to prevent. Three workers pick up the
  // same domain action at the same instant: a queue runner, a retry sweep and a
  // duplicate webhook. All three must resolve to one communication, and only
  // one may reach the wire.
  const store = makeStore();
  const spy = makeSpy(async () => {
    await new Promise((r) => setTimeout(r, 5)); // hold the flight open
    return { sid: "SM_1" };
  });
  const results = await Promise.all([
    run({ store, sendProvider: spy.fn }),
    run({ store, sendProvider: spy.fn }),
    run({ store, sendProvider: spy.fn }),
  ]);

  assert.equal(store._state.communications.size, 1, "one domain action, one communication");
  assert.equal(spy.count, 1, "EXACTLY ONE provider invocation");
  assert.equal(store._state.attempts.length, 1, "the losers must not allocate sibling attempts");
  assert.equal(results.filter((r) => r.ok).length, 1, "exactly one winner");
  for (const loser of results.filter((r) => !r.ok)) {
    assert.equal(loser.provider_invoked, false);
    assert.equal(loser.reason, "attempt_already_in_flight");
  }
});

test("a template change does not create a second communication", async () => {
  const store = makeStore();
  const spy = makeSpy();
  await run({ store, sendProvider: spy.fn },
    { ...REPLY, message: { ...REPLY.message, body: "Wording A" } });
  await run({ store, sendProvider: spy.fn },
    { ...REPLY, message: { ...REPLY.message, body: "Completely different wording B" } });
  assert.equal(store._state.communications.size, 1,
    "rotating the body must not mint a new domain action");
});
