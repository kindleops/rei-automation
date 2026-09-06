/**
 * s12-integrated-crash-race.test.mjs
 *
 * Crashes and races against the FULLY WIRED path:
 *
 *   syncDeliveryEvent -> canonical callback seam -> ledger -> attempt/logical
 *                     -> legacy projection
 *
 * The earlier Slice 2 tests exercised the seam in isolation. These drive it
 * through syncDeliveryEvent, which is where the provenance gate, the canonical
 * commit, and the legacy projection actually meet.
 *
 * The single property every case must hold:
 *
 *   NO CRASH AND NO RACE MAY DUPLICATE A CALLBACK EVENT, REBIND A SID,
 *   REGRESS DELIVERED, MINT RETRY AUTHORITY, OR REACH A PROVIDER.
 *
 * Projection is allowed to lag. Canonical truth is not allowed to move backwards.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { syncDeliveryEvent } from "@/lib/supabase/sms-engine.js";
import { EVIDENCE_PROVENANCE } from "@/lib/domain/communications/callback-evidence-provenance.js";
import { PROVIDER_OUTCOME } from "@/lib/domain/communications/provider-outcome-lattice.js";
import { createMemoryCallbackStore } from "../helpers/s12-memory-callback-store.mjs";

const TO = "+13125550100";
const FROM = "+18885551212";
const SID = "SM_INT_1";

/** A projection stub standing in for the legacy RPC. */
function projection() {
  const p = { calls: 0, last: null };
  p.fn = async (sid, patch) => { p.calls += 1; p.last = { sid, ...patch }; return { ok: true }; };
  return p;
}

function boundStore({ outcome = null, sid = SID } = {}) {
  const store = createMemoryCallbackStore();
  store.seedAttempt({
    id: "att-1", logical_communication_id: "lc-1",
    provider_message_id: sid, to_phone_number: TO, outcome_class: outcome,
  });
  return store;
}

const payload = (over = {}) => ({
  message_id: SID, status: "delivered", to: TO, from: FROM, ...over,
});

/** Drive the wired path. Provider is never reachable: projection is stubbed. */
function run(store, proj, over = {}, opts = {}) {
  return syncDeliveryEvent(payload(over), {
    now: "2026-09-06T12:00:00.000Z",
    callbackStore: store,
    verification: { verified: true },
    evidence_provenance: EVIDENCE_PROVENANCE.LIVE_PROVIDER_RECEIPT,
    syncDeliveryEvent: proj.fn,
    ...opts,
  });
}

// ── provenance gating through the wired path ──────────────────────────────

test("a poll observation reaches projection but never the ledger", async () => {
  const store = boundStore();
  const proj = projection();
  await run(store, proj, {}, { evidence_provenance: EVIDENCE_PROVENANCE.PROVIDER_POLL_OBSERVATION });

  assert.equal(store._state.events.size, 0,
    "a poll answer must not be recorded as a provider receipt");
  assert.equal(store._state.attempts.get("att-1").outcome_class, null,
    "a poll must not advance canonical truth");
  assert.equal(proj.calls, 1, "projection still runs: queue/message_events are not canonical");
});

test("an undeclared lane cannot advance canonical truth", async () => {
  const store = boundStore();
  const proj = projection();
  await run(store, proj, {}, { evidence_provenance: undefined });
  assert.equal(store._state.events.size, 0, "undeclared must fail closed");
  assert.equal(store._state.attempts.get("att-1").outcome_class, null);
});

test("a live receipt DOES advance canonical truth", async () => {
  // Positive control: without this the gating tests above could pass by
  // refusing everything.
  const store = boundStore();
  const proj = projection();
  await run(store, proj);
  assert.equal(store._state.events.size, 1);
  assert.equal(store._state.attempts.get("att-1").outcome_class, PROVIDER_OUTCOME.DELIVERED);
});

// ── INTEGRATED CRASH MATRIX ───────────────────────────────────────────────

const CRASH_BOUNDARIES = [
  {
    name: "A: ledger get/create throws",
    break: (s) => { s.getOrCreateCallbackEvent = async () => { throw new Error("ledger down"); }; },
  },
  {
    name: "B: ledger returns a refusal",
    break: (s) => { s.getOrCreateCallbackEvent = async () => ({ ok: false, reason: "ledger_refused" }); },
  },
  {
    name: "D: candidate resolution throws",
    break: (s) => { s.findAttemptByProviderSid = async () => { throw new Error("lookup down"); }; },
  },
  {
    name: "E: SID binding refuses",
    break: (s) => { s.bindProviderSid = async () => ({ ok: false, reason: "provider_sid_conflict" }); },
  },
  {
    name: "F: attempt outcome write throws",
    break: (s) => { s.applyCallbackOutcome = async () => { throw new Error("outcome write down"); }; },
  },
  {
    name: "H: post-commit bookkeeping throws",
    break: (s) => { s.markCallbackEvent = async () => { throw new Error("mark down"); }; },
  },
];

for (const boundary of CRASH_BOUNDARIES) {
  test(`crash ${boundary.name}: replay converges, provider never reached`, async () => {
    const store = boundStore();
    const proj = projection();
    boundary.break(store);

    // First pass crashes somewhere inside the canonical seam.
    await run(store, proj).catch(() => {});

    const eventsAfterCrash = store._state.events.size;
    const sidAfterCrash = store._state.attempts.get("att-1").provider_message_id;

    // Replay the SAME evidence.
    await run(store, proj).catch(() => {});

    assert.ok(store._state.events.size <= 1,
      `${boundary.name}: replay must not create a second callback event`);
    assert.equal(store._state.attempts.get("att-1").provider_message_id, sidAfterCrash,
      `${boundary.name}: the bound SID must not change across replay`);
    assert.equal(store._state.attempts.size, 1, `${boundary.name}: no attempt was created`);
    assert.equal(store._state.logicals.size, 0, `${boundary.name}: no logical communication created`);
    assert.ok(eventsAfterCrash <= 1);

    // The provider is unreachable from this path by construction: projection is
    // a stub and the seam has no send primitive.
    assert.ok(!("retry_authority" in (store._state.attempts.get("att-1") || {})),
      `${boundary.name}: callback reconciliation must not express retry authority`);
  });
}

test("I: canonical truth survives a projection failure and does not resend", async () => {
  const store = boundStore();
  const proj = { calls: 0, fn: async () => { proj.calls += 1; throw new Error("projection down"); } };

  await run(store, proj).catch(() => {});

  // Canonical committed before projection ran.
  assert.equal(store._state.events.size, 1, "the callback event is durable");
  assert.equal(store._state.attempts.get("att-1").outcome_class, PROVIDER_OUTCOME.DELIVERED,
    "canonical provider truth survives a failed projection");

  // Replay: projection may retry, canonical must not re-apply.
  await run(store, proj).catch(() => {});
  assert.equal(store._state.events.size, 1, "no duplicate event from replay");
});

// ── INTEGRATED RACE MATRIX ────────────────────────────────────────────────

test("race: the same live callback 8x yields one event and one application", async () => {
  const store = boundStore();
  const proj = projection();
  await Promise.all(Array.from({ length: 8 }, () => run(store, proj)));

  assert.equal(store._state.events.size, 1, "one canonical callback identity");
  assert.equal(store._state.attempts.size, 1);
  assert.equal(store._state.attempts.get("att-1").outcome_class, PROVIDER_OUTCOME.DELIVERED);
});

test("race: a live receipt and a recovery replay of the SAME evidence converge", async () => {
  const store = boundStore();
  const proj = projection();
  await Promise.all([
    run(store, proj, {}, { evidence_provenance: EVIDENCE_PROVENANCE.LIVE_PROVIDER_RECEIPT }),
    run(store, proj, {}, { evidence_provenance: EVIDENCE_PROVENANCE.RECORDED_CALLBACK_REPLAY }),
  ]);
  assert.equal(store._state.events.size, 1,
    "a replay must resolve to the same ledger row, never mint a second receipt");
});

test("race: a poll observation cannot win against a live receipt", async () => {
  const store = boundStore();
  const proj = projection();
  await Promise.all([
    run(store, proj, {}, { evidence_provenance: EVIDENCE_PROVENANCE.PROVIDER_POLL_OBSERVATION }),
    run(store, proj, {}, { evidence_provenance: EVIDENCE_PROVENANCE.LIVE_PROVIDER_RECEIPT }),
  ]);
  assert.equal(store._state.events.size, 1, "only the live receipt is a receipt");
  assert.equal(store._state.attempts.get("att-1").outcome_class, PROVIDER_OUTCOME.DELIVERED);
});

test("race: delivered and failed concurrently cannot erase delivered", async () => {
  const store = boundStore();
  const proj = projection();
  await Promise.all([
    run(store, proj, { status: "delivered" }),
    run(store, proj, { status: "failed" }),
  ]);

  // Two DIFFERENT provider claims: two events, one canonical outcome.
  assert.equal(store._state.events.size, 2, "both claims are retained as evidence");
  const outcome = store._state.attempts.get("att-1").outcome_class;
  assert.ok(
    outcome === PROVIDER_OUTCOME.DELIVERED
    || outcome === PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE,
    "the outcome must be one of the two terminal verdicts, deterministically applied");
  // Whichever landed first, the second is a conflict and must not overwrite it.
  const statuses = [...store._state.events.values()].map((e) => e.adoption_status);
  assert.ok(statuses.includes("conflict") || statuses.includes("stale"),
    "the losing claim must be recorded as conflict/stale, not silently applied");
});

test("race: sent then delivered converges on delivered", async () => {
  const store = boundStore();
  const proj = projection();
  await run(store, proj, { status: "sent" });
  await run(store, proj, { status: "delivered" });
  assert.equal(store._state.attempts.get("att-1").outcome_class, PROVIDER_OUTCOME.DELIVERED);
});

test("race: delivered then sent does NOT downgrade", async () => {
  const store = boundStore();
  const proj = projection();
  await run(store, proj, { status: "delivered" });
  await run(store, proj, { status: "sent" });
  assert.equal(store._state.attempts.get("att-1").outcome_class, PROVIDER_OUTCOME.DELIVERED,
    "arrival order must not outrank semantic certainty");
});

// ── the provider is structurally unreachable from this path ───────────────

test("no callback path can reach a provider send primitive", async () => {
  const store = boundStore();
  const proj = projection();
  await run(store, proj);
  // The seam has no send primitive and the projection stub is not one. This is
  // asserted structurally elsewhere (DIRECT_CALLBACK_STATE_BYPASS); here we pin
  // that a full wired pass produced no provider-shaped call.
  assert.equal(proj.calls, 1, "exactly one projection call, and it is not a send");
  assert.equal(typeof proj.last?.delivery_status, "string");
});

// ── CRASH C: recorded but never applied ───────────────────────────────────

test("C: a crash between recording and applying must not strand the event", async () => {
  // The gap this pins: getOrCreateCallbackEvent succeeds, then the process dies
  // before the outcome is applied. On redelivery the fingerprint already exists,
  // so a ledger that dedupes on RECORDED (rather than APPLIED) would short-circuit
  // and canonical truth would never advance -- silently, forever.
  const store = boundStore();
  const proj = projection();

  // Crash immediately after the event row is created.
  const realApply = store.applyCallbackOutcome.bind(store);
  store.applyCallbackOutcome = async () => { throw new Error("crashed after record"); };
  await run(store, proj).catch(() => {});

  assert.equal(store._state.events.size, 1, "the evidence was recorded");
  assert.equal(store._state.attempts.get("att-1").outcome_class, null,
    "and the outcome was NOT applied");

  // Provider redelivers the identical callback.
  store.applyCallbackOutcome = realApply;
  await run(store, proj);

  assert.equal(store._state.events.size, 1, "still exactly one event");
  assert.equal(store._state.attempts.get("att-1").outcome_class, PROVIDER_OUTCOME.DELIVERED,
    "redelivery must COMPLETE the unapplied event, not skip it");
});

test("a redelivery of an already-APPLIED event stays inert", async () => {
  // The other half of the contract: resuming unapplied work must not become an
  // excuse to re-apply finished work.
  const store = boundStore();
  const proj = projection();
  await run(store, proj);
  const applied = store._state.events.values().next().value.processing_status;

  let applyCalls = 0;
  const real = store.applyCallbackOutcome.bind(store);
  store.applyCallbackOutcome = async (a) => { applyCalls += 1; return real(a); };
  await run(store, proj);

  assert.equal(applied, "applied");
  assert.equal(applyCalls, 0, "an already-applied event must not be re-applied");
  assert.equal(store._state.events.size, 1);
});
