/**
 * s14-callback-trust-gate.test.mjs
 *
 * Slice 2 recorded receipt trust. Slice 3 proved nothing read it. This is the
 * gate that makes it matter.
 *
 * THE PROPERTY
 *   Evidence is ALWAYS recorded. Canonical truth is advanced ONLY by a receipt
 *   that met the trust threshold at the moment it arrived.
 *
 * WHY BOTH HALVES MATTER
 *   Refusing to record would destroy the only trace that someone tried, which
 *   is exactly what an operator investigating a forged callback needs. Refusing
 *   to advance is what keeps a stranger from deciding whether a seller received
 *   a message.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { reconcileProviderCallback } from "@/lib/domain/communications/reconcile-provider-callback.js";
import {
  TRUST_CLASS, mayAdvanceCanonicalTruthWithTrust, mayAdoptOrphanWithTrust,
} from "@/lib/domain/communications/callback-trust-policy.js";
import { PROVIDER_OUTCOME } from "@/lib/domain/communications/provider-outcome-lattice.js";
import { EVIDENCE_PROVENANCE } from "@/lib/domain/communications/callback-evidence-provenance.js";
import { createMemoryCallbackStore } from "../helpers/s12-memory-callback-store.mjs";

const TO = "+13125550100";
const FROM = "+18885551212";
const SID = "SM_TRUST";

const VERIFICATION = {
  authenticated: { verified: true },
  unverified: { ok: true, verified: false, reason: "no_secrets_configured" },
  unauthenticated: { ok: false, verified: false },
  internal_replay: { internal_replay: true },
};

function storeWith({ sid = SID, orphanCount = null } = {}) {
  const store = createMemoryCallbackStore();
  const attempt = {
    id: "att-t", logical_communication_id: "lc-t", to_phone_number: TO,
    outcome_class: null, provider_message_id: sid,
  };
  store.seedAttempt(attempt);
  if (orphanCount !== null) store.setOrphanCandidates(orphanCount, { ...attempt, provider_message_id: null });
  return store;
}

const run = (store, trust, over = {}) => reconcileProviderCallback(
  { message_id: SID, status: "delivered", to: TO, from: FROM, ...over },
  {
    store,
    verification: VERIFICATION[trust],
    evidence_provenance: EVIDENCE_PROVENANCE.LIVE_PROVIDER_RECEIPT,
  },
);

// ── the policy itself ─────────────────────────────────────────────────────

test("policy: only an authenticated receipt may advance canonical truth", () => {
  assert.equal(mayAdvanceCanonicalTruthWithTrust(TRUST_CLASS.AUTHENTICATED), true);
  assert.equal(mayAdvanceCanonicalTruthWithTrust(TRUST_CLASS.INTERNAL_REPLAY), false);
  assert.equal(mayAdvanceCanonicalTruthWithTrust(TRUST_CLASS.UNAUTHENTICATED), false);
  assert.equal(mayAdvanceCanonicalTruthWithTrust(TRUST_CLASS.TEST_FIXTURE), false);
  assert.equal(mayAdvanceCanonicalTruthWithTrust(undefined), false, "unknown trust must fail closed");
});

test("policy: orphan adoption is never easier than canonical advancement", () => {
  for (const t of Object.values(TRUST_CLASS)) {
    if (mayAdoptOrphanWithTrust(t)) {
      assert.ok(mayAdvanceCanonicalTruthWithTrust(t),
        `${t} may adopt but may not advance -- adoption must never be the weaker gate`);
    }
  }
});

// ── PART 7 REGRESSION MATRIX ──────────────────────────────────────────────

const MATRIX = [
  { name: "authenticated known SID delivered", trust: "authenticated", status: "delivered",
    advances: true, expect: PROVIDER_OUTCOME.DELIVERED },
  { name: "authenticated known SID failed", trust: "authenticated", status: "failed",
    advances: true, expect: PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE },
  { name: "unverified known SID delivered", trust: "unverified", status: "delivered",
    advances: false, expect: null },
  { name: "unauthenticated known SID delivered", trust: "unauthenticated", status: "delivered",
    advances: false, expect: null },
  { name: "internal replay known SID delivered", trust: "internal_replay", status: "delivered",
    advances: false, expect: null },
];

for (const c of MATRIX) {
  test(`MATRIX ${c.name} -> ${c.advances ? "advances" : "recorded only"}`, async () => {
    const store = storeWith();
    const r = await run(store, c.trust, { status: c.status });
    const after = store._state.attempts.get("att-t");

    assert.equal(r.applied === true, c.advances, `applied mismatch (reason=${r.reason})`);
    assert.equal(after.outcome_class ?? null, c.expect, "canonical outcome mismatch");

    // Evidence is recorded EITHER WAY. This is the half that is easy to lose.
    assert.equal(store._state.events.size, 1,
      "the receipt must be durably recorded whatever its trust");

    // And nothing may ever send.
    assert.equal(r.provider_send_triggered, false);
  });
}

// ── orphan adoption under trust ───────────────────────────────────────────

const ORPHAN = [
  { name: "authenticated orphan exact-one", trust: "authenticated", count: 1, adopts: true },
  { name: "unverified orphan exact-one", trust: "unverified", count: 1, adopts: false },
  { name: "unauthenticated orphan exact-one", trust: "unauthenticated", count: 1, adopts: false },
  { name: "authenticated orphan multi", trust: "authenticated", count: 3, adopts: false },
  { name: "authenticated orphan zero", trust: "authenticated", count: 0, adopts: false },
];

for (const c of ORPHAN) {
  test(`ORPHAN ${c.name} -> ${c.adopts ? "adopts" : "no adoption"}`, async () => {
    const store = storeWith({ sid: null, orphanCount: c.count });
    const r = await run(store, c.trust, { message_id: "SM_ORPHAN_T" });
    const after = store._state.attempts.get("att-t");

    assert.equal(r.applied === true, c.adopts, `adoption mismatch (reason=${r.reason})`);
    if (!c.adopts) {
      assert.equal(after.provider_message_id ?? null, null,
        "a refused adoption must not bind a SID onto our attempt");
      assert.equal(after.outcome_class ?? null, null,
        "a refused adoption must not advance canonical truth");
    }
    assert.equal(store._state.events.size, 1, "evidence recorded regardless");
    assert.equal(r.provider_send_triggered, false);
  });
}

// ── trust may never be promoted ───────────────────────────────────────────

test("replaying an originally unauthenticated receipt does NOT promote it", async () => {
  const store = storeWith();
  await run(store, "unauthenticated");
  const recorded = [...store._state.events.values()][0];
  assert.equal(recorded.trust_class, TRUST_CLASS.UNAUTHENTICATED);

  // Replay the SAME evidence through the internal replay lane.
  await reconcileProviderCallback(
    { message_id: SID, status: "delivered", to: TO, from: FROM },
    {
      store,
      verification: VERIFICATION.internal_replay,
      evidence_provenance: EVIDENCE_PROVENANCE.RECORDED_CALLBACK_REPLAY,
    },
  );

  assert.equal(store._state.events.size, 1, "replay resolves to the same ledger row");
  assert.equal([...store._state.events.values()][0].trust_class, TRUST_CLASS.UNAUTHENTICATED,
    "an internal worker replaying a claim does not authenticate the claim");
  assert.equal(store._state.attempts.get("att-t").outcome_class ?? null, null,
    "and it still may not advance canonical truth");
});

test("an untrusted receipt creates no retry authority and no attempt", async () => {
  const store = storeWith();
  const r = await run(store, "unauthenticated");
  const after = store._state.attempts.get("att-t");
  assert.ok(!("retry_authority" in after), "callbacks never express retry authority");
  assert.equal(store._state.attempts.size, 1, "no attempt created");
  assert.equal(store._state.logicals.size, 0, "no logical communication created");
  assert.equal(r.stage, "trust");
});
