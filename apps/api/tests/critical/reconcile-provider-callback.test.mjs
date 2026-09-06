/**
 * reconcile-provider-callback.test.mjs
 *
 * The seam where provider evidence meets our belief about a seller message.
 *
 * The property under test throughout: a callback may make us MORE certain about
 * an attempt that already exists, and may do nothing else. It cannot create an
 * attempt, create a communication, mint retry authority, replace a bound SID,
 * or regress delivered.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  reconcileProviderCallback,
  buildCallbackFingerprint,
  classifyReceiptTrust,
  TRUST_CLASS,
  ORPHAN_ADOPTION_WINDOW_MS,
} from "@/lib/domain/communications/reconcile-provider-callback.js";
import { PROVIDER_OUTCOME } from "@/lib/domain/communications/provider-outcome-lattice.js";
import { createMemoryCallbackStore } from "../helpers/s12-memory-callback-store.mjs";

const TO = "+13125550100";
const FROM = "+18885551212";

function cb(over = {}) {
  return { provider: "textgrid", message_id: "SM_1", status: "delivered", to: TO, from: FROM, ...over };
}

function storeWithKnownSid(sid = "SM_1", outcome = null) {
  const store = createMemoryCallbackStore();
  store.seedAttempt({
    id: "att-1", logical_communication_id: "lc-1",
    provider_message_id: sid, to_phone_number: TO, outcome_class: outcome,
  });
  return store;
}

const AUTH = { verified: true };

// ── trust ─────────────────────────────────────────────────────────────────

test("verification that did not verify is NOT authenticated", () => {
  // The real fail-open shape: ok:true, verified:false, required:false.
  // Trust must follow `verified`, never `ok`, or an unchecked callback would be
  // laundered into an authenticated one.
  assert.equal(
    classifyReceiptTrust({ ok: true, verified: false, required: false, reason: "no_secrets_configured" }),
    TRUST_CLASS.UNAUTHENTICATED);
  assert.equal(classifyReceiptTrust({ verified: true }), TRUST_CLASS.AUTHENTICATED);
  assert.equal(classifyReceiptTrust({}), TRUST_CLASS.UNAUTHENTICATED);
});

// ── fingerprint ───────────────────────────────────────────────────────────

test("the fingerprint is stable across redelivery", () => {
  const a = buildCallbackFingerprint({ provider: "textgrid", provider_message_sid: "SM_1", provider_status: "delivered", to_phone_number: TO, from_phone_number: FROM });
  const b = buildCallbackFingerprint({ provider: "textgrid", provider_message_sid: "SM_1", provider_status: "DELIVERED", to_phone_number: TO, from_phone_number: FROM });
  assert.equal(a, b, "case must not split one callback into two events");
});

test("the fingerprint excludes receipt time and trust", () => {
  const base = { provider: "textgrid", provider_message_sid: "SM_1", provider_status: "delivered", to_phone_number: TO, from_phone_number: FROM };
  const a = buildCallbackFingerprint({ ...base, received_at: "2026-01-01T00:00:00Z", trust_class: "authenticated_provider_callback" });
  const b = buildCallbackFingerprint({ ...base, received_at: "2026-09-09T09:09:09Z", trust_class: "network_received_unauthenticated" });
  assert.equal(a, b, "including either would make every redelivery a new event");
});

test("materially different provider evidence yields different fingerprints", () => {
  const base = { provider: "textgrid", provider_message_sid: "SM_1", to_phone_number: TO, from_phone_number: FROM };
  assert.notEqual(
    buildCallbackFingerprint({ ...base, provider_status: "delivered" }),
    buildCallbackFingerprint({ ...base, provider_status: "failed" }));
});

// ── duplicate idempotency ─────────────────────────────────────────────────

test("a duplicate callback is recorded once and applied once", async () => {
  const store = storeWithKnownSid();
  const first = await reconcileProviderCallback(cb(), { store, verification: AUTH });
  assert.equal(first.applied, true);

  const second = await reconcileProviderCallback(cb(), { store, verification: AUTH });
  assert.equal(second.applied, false);
  assert.equal(second.duplicate, true);
  assert.equal(store._state.events.size, 1, "one canonical event");
});

test("ten redeliveries collapse to one event and one application", async () => {
  const store = storeWithKnownSid();
  let applied = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = await reconcileProviderCallback(cb(), { store, verification: AUTH });
    if (r.applied) applied += 1;
  }
  assert.equal(store._state.events.size, 1);
  assert.equal(applied, 1, "the transition must be applied exactly once");
});

test("eight CONCURRENT duplicates still apply once", async () => {
  const store = storeWithKnownSid();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => reconcileProviderCallback(cb(), { store, verification: AUTH })));
  assert.equal(store._state.events.size, 1);
  assert.equal(results.filter((r) => r.applied).length, 1);
});

// ── known SID ─────────────────────────────────────────────────────────────

test("a known SID binds to its attempt and advances the outcome", async () => {
  const store = storeWithKnownSid();
  const r = await reconcileProviderCallback(cb(), { store, verification: AUTH });
  assert.equal(r.adoption_status, "bound_known_sid");
  assert.equal(r.outcome_class, PROVIDER_OUTCOME.DELIVERED);
  assert.equal(store._state.attempts.get("att-1").outcome_class, PROVIDER_OUTCOME.DELIVERED);
});

test("a known SID with a contradictory recipient CANNOT mutate state", async () => {
  // Timing proximity is not identity. A SID match with the wrong recipient is
  // not this communication.
  const store = storeWithKnownSid();
  const r = await reconcileProviderCallback(cb({ to: "+19998887777" }), { store, verification: AUTH });
  assert.equal(r.applied, false);
  assert.equal(r.adoption_status, "identity_mismatch");
  assert.equal(store._state.attempts.get("att-1").outcome_class, null, "state untouched");
});

// ── monotonicity through the seam ─────────────────────────────────────────

test("a late weaker callback does not downgrade delivered", async () => {
  const store = storeWithKnownSid("SM_1", PROVIDER_OUTCOME.DELIVERED);
  const r = await reconcileProviderCallback(cb({ status: "sent" }), { store, verification: AUTH });
  assert.equal(r.applied, false);
  assert.equal(r.lattice_action, "stale");
  assert.equal(store._state.attempts.get("att-1").outcome_class, PROVIDER_OUTCOME.DELIVERED);
});

test("delivered then failed is held as a conflict, not an overwrite", async () => {
  const store = storeWithKnownSid("SM_1", PROVIDER_OUTCOME.DELIVERED);
  const r = await reconcileProviderCallback(cb({ status: "failed" }), { store, verification: AUTH });
  assert.equal(r.applied, false);
  assert.equal(r.lattice_action, "conflict");
  assert.equal(store._state.attempts.get("att-1").outcome_class, PROVIDER_OUTCOME.DELIVERED,
    "a delivery the seller received must not be erased by a later failure callback");
});

test("an unrecognised status is inert", async () => {
  const store = storeWithKnownSid("SM_1", PROVIDER_OUTCOME.PROVIDER_ACCEPTED);
  const r = await reconcileProviderCallback(cb({ status: "delivery" }), { store, verification: AUTH });
  assert.equal(r.applied, false);
  assert.equal(store._state.attempts.get("att-1").outcome_class, PROVIDER_OUTCOME.PROVIDER_ACCEPTED);
});

// ── a callback never grants a resend ──────────────────────────────────────

test("a failed callback never yields definitely_not_sent or retry authority", async () => {
  const store = storeWithKnownSid("SM_1", PROVIDER_OUTCOME.PROVIDER_ACCEPTED);
  const r = await reconcileProviderCallback(cb({ status: "failed" }), { store, verification: AUTH });
  // provider_accepted -> delivery_failed is an advance (higher rank).
  assert.equal(r.applied, true);
  assert.equal(r.delivery_possibility, "provider_accepted");
  assert.notEqual(r.delivery_possibility, "definitely_not_sent");
  assert.equal(r.provider_send_triggered, false);
  assert.ok(!("retry_authority" in r), "the seam must not express retry authority at all");
});

// ── orphan adoption ───────────────────────────────────────────────────────

test("orphan with ZERO candidates is recorded, never adopted", async () => {
  const store = createMemoryCallbackStore();
  store.setOrphanCandidates(0);
  const r = await reconcileProviderCallback(cb({ message_id: "SM_ORPHAN" }), { store, verification: AUTH });
  assert.equal(r.applied, false);
  assert.equal(r.adoption_status, "orphan_unmatched");
  assert.equal(store._state.attempts.size, 0, "no attempt may be invented");
});

test("orphan with TWO candidates is NEVER adopted", async () => {
  // The mandatory collision case. Two possible seller communications, one
  // receipt: choosing either could credit the wrong person.
  const store = createMemoryCallbackStore();
  store.setOrphanCandidates(2);
  const r = await reconcileProviderCallback(cb({ message_id: "SM_ORPHAN" }), { store, verification: AUTH });
  assert.equal(r.applied, false);
  assert.equal(r.adoption_status, "orphan_ambiguous");
  assert.equal(r.candidate_count, 2);
});

test("orphan with EXACTLY ONE candidate is adopted onto the existing attempt", async () => {
  const store = createMemoryCallbackStore();
  const attempt = { id: "att-orphan", logical_communication_id: "lc-orphan", to_phone_number: TO, outcome_class: null };
  store.seedAttempt(attempt);
  store.setOrphanCandidates(1, attempt);

  const r = await reconcileProviderCallback(cb({ message_id: "SM_ORPHAN" }), { store, verification: AUTH });
  assert.equal(r.applied, true);
  assert.equal(r.adoption_status, "orphan_adopted");
  assert.equal(r.attempt_id, "att-orphan");
  assert.equal(store._state.attempts.get("att-orphan").provider_message_id, "SM_ORPHAN",
    "the SID binds onto the EXISTING attempt");
  assert.equal(store._state.attempts.size, 1, "no new attempt was created");
});

test("an orphan without a recipient is not matched on timing alone", async () => {
  const store = createMemoryCallbackStore();
  store.setOrphanCandidates(1, { id: "att-x", logical_communication_id: "lc-x" });
  const r = await reconcileProviderCallback(cb({ message_id: "SM_ORPHAN", to: null }), { store, verification: AUTH });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "orphan_without_recipient");
});

test("the adoption window is bounded and versioned", () => {
  assert.equal(typeof ORPHAN_ADOPTION_WINDOW_MS, "number");
  assert.ok(ORPHAN_ADOPTION_WINDOW_MS > 0 && ORPHAN_ADOPTION_WINDOW_MS <= 60 * 60 * 1000,
    "an unbounded or day-long window would let a callback attach to an unrelated send");
});

// ── SID conflict ──────────────────────────────────────────────────────────

test("a different SID cannot overwrite an already-bound one", async () => {
  const store = storeWithKnownSid("SM_EXISTING", null);
  // Orphan path resolves to that attempt, but it already holds a different SID.
  store.setOrphanCandidates(1, {
    id: "att-1", logical_communication_id: "lc-1", to_phone_number: TO, outcome_class: null,
  });
  const r = await reconcileProviderCallback(cb({ message_id: "SM_DIFFERENT" }), { store, verification: AUTH });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "provider_sid_conflict");
  assert.equal(store._state.attempts.get("att-1").provider_message_id, "SM_EXISTING",
    "the durable SID must survive");
});

// ── store unavailable ─────────────────────────────────────────────────────

test("a store that cannot record evidence refuses rather than mutating", async () => {
  const r = await reconcileProviderCallback(cb(), { store: {}, verification: AUTH });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "callback_store_unavailable");
});
