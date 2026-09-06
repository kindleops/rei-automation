/**
 * s13-model-implementation-differential.test.mjs
 *
 * THE GATE THAT STOPS THE MODEL FROM PROVING ITSELF.
 *
 * A model check is only evidence about the code if the model's transitions mean
 * the same thing the code's do. Otherwise it is an elaborate proof about a
 * fiction. So every semantic function the model relies on is run side by side
 * with the real implementation over its ENTIRE input domain, and the callback
 * seam is run end to end against the real reconciler.
 *
 * Any divergence fails. Not "is investigated" -- fails.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import * as MODEL from "../model/s13-combined-model.mjs";
import {
  advanceProviderOutcome, deliveryPossibilityFor, normalizeProviderStatus,
  PROVIDER_OUTCOME,
} from "@/lib/domain/communications/provider-outcome-lattice.js";
import {
  mayAdvanceCanonicalTruth, EVIDENCE_PROVENANCE,
} from "@/lib/domain/communications/callback-evidence-provenance.js";
import { reconcileProviderCallback } from "@/lib/domain/communications/reconcile-provider-callback.js";
import { createMemoryCallbackStore } from "../helpers/s12-memory-callback-store.mjs";

const ALL_OUTCOMES = Object.values(PROVIDER_OUTCOME);

test("D1 lattice: model and implementation agree on EVERY outcome pair", () => {
  let pairs = 0;
  for (const from of [...ALL_OUTCOMES, null]) {
    for (const to of [...ALL_OUTCOMES, null]) {
      const real = advanceProviderOutcome(from, to).action;
      const model = MODEL.latticeAction(from, to);
      assert.equal(model, real,
        `lattice divergence at (${from} -> ${to}): model=${model} impl=${real}`);
      pairs += 1;
    }
  }
  assert.equal(pairs, 49, "the full 7x7 domain must be covered");
});

test("D2 delivery possibility: model and implementation agree on every outcome", () => {
  for (const o of [...ALL_OUTCOMES, null, undefined]) {
    const real = deliveryPossibilityFor(o) ?? null;
    const model = MODEL.possibilityFor(o) ?? null;
    assert.equal(model, real, `possibility divergence at ${o}`);
  }
});

test("D3 provenance gate: model and implementation agree on every provenance", () => {
  const all = [...Object.values(EVIDENCE_PROVENANCE), undefined, null, "nonsense"];
  for (const p of all) {
    assert.equal(MODEL.mayAdvance(p), mayAdvanceCanonicalTruth(p),
      `provenance divergence at ${p}`);
  }
});

test("D4 NOTHING in the implementation maps to definitely_not_sent", () => {
  // The load-bearing production finding, restated as a differential: no provider
  // status the implementation recognises may conclude the seller saw nothing.
  for (const raw of ["delivered", "failed", "undelivered", "sent", "accepted", "queued", "banana", ""]) {
    const outcome = normalizeProviderStatus(raw).outcome;
    assert.notEqual(deliveryPossibilityFor(outcome), "definitely_not_sent",
      `implementation mapped '${raw}' to definitely_not_sent`);
    assert.notEqual(MODEL.possibilityFor(outcome), "definitely_not_sent",
      `model mapped '${raw}' to definitely_not_sent`);
  }
});

/**
 * D5 is the real differential: the model's abstract callback transition versus
 * the actual reconciler, over the scenarios the state search relies on.
 */
const SCENARIOS = [
  { name: "known SID, delivered", stored: null, status: "delivered", sid: "SID_A", bind: true, expectApplied: true },
  { name: "known SID, failed", stored: null, status: "failed", sid: "SID_A", bind: true, expectApplied: true },
  { name: "delivered then sent (stale)", stored: PROVIDER_OUTCOME.DELIVERED, status: "sent", sid: "SID_A", bind: true, expectApplied: false },
  { name: "delivered then failed (conflict)", stored: PROVIDER_OUTCOME.DELIVERED, status: "failed", sid: "SID_A", bind: true, expectApplied: false },
  { name: "failed then delivered (conflict)", stored: PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE, status: "delivered", sid: "SID_A", bind: true, expectApplied: false },
  { name: "sent then delivered (advance)", stored: PROVIDER_OUTCOME.SENT_BY_PROVIDER, status: "delivered", sid: "SID_A", bind: true, expectApplied: true },
  { name: "same status twice (idempotent)", stored: PROVIDER_OUTCOME.DELIVERED, status: "delivered", sid: "SID_A", bind: true, expectApplied: false },
  { name: "unrecognised status (inert)", stored: null, status: "banana", sid: "SID_A", bind: true, expectApplied: false },
  { name: "orphan, zero candidates", stored: null, status: "delivered", sid: "SID_X", bind: false, expectApplied: false },
];

for (const sc of SCENARIOS) {
  test(`D5 differential: ${sc.name}`, async () => {
    // ── real implementation ────────────────────────────────────────────────
    const store = createMemoryCallbackStore();
    store.seedAttempt({
      id: "att-d", logical_communication_id: "lc-d", to_phone_number: "+13125550100",
      outcome_class: sc.stored, provider_message_id: sc.bind ? sc.sid : null,
    });
    const real = await reconcileProviderCallback(
      { message_id: sc.sid, status: sc.status, to: "+13125550100", from: "+18885551212" },
      { store, verification: { verified: true },
        evidence_provenance: EVIDENCE_PROVENANCE.LIVE_PROVIDER_RECEIPT },
    );
    const realApplied = real.applied === true;
    const realOutcome = store._state.attempts.get("att-d").outcome_class ?? null;

    // ── model ──────────────────────────────────────────────────────────────
    const incoming = normalizeProviderStatus(sc.status).outcome;
    const modelAction = MODEL.latticeAction(sc.stored, incoming);
    const modelApplied = sc.bind && modelAction === "advance";
    const modelOutcome = modelApplied ? incoming : (sc.stored ?? null);

    assert.equal(realApplied, modelApplied,
      `${sc.name}: applied differs (impl=${realApplied} model=${modelApplied}) reason=${real.reason}`);
    assert.equal(realOutcome, modelOutcome,
      `${sc.name}: resulting canonical outcome differs`);
    assert.equal(realApplied, sc.expectApplied,
      `${sc.name}: implementation disagreed with the stated expectation`);

    // and the property the whole slice exists for
    assert.equal(real.provider_send_triggered, false, "a callback must never send");
  });
}

test("D0 vocabularies are VALUE-identical, and no scenario references a missing key", () => {
  // The model and the implementation may name their constants differently, but
  // the VALUES must coincide -- otherwise a differential compares two different
  // languages and agrees for the wrong reason.
  const implValues = new Set(Object.values(PROVIDER_OUTCOME));
  const modelValues = new Set(Object.values(MODEL.OUTCOME));
  assert.deepEqual([...modelValues].sort(), [...implValues].sort(),
    "model and implementation outcome vocabularies diverged");

  // A scenario referencing a non-existent enum key silently seeds `undefined`,
  // which reads as "no prior outcome" and makes a conflict case look like an
  // advance. That exact slip happened here, so it is now a hard check.
  for (const sc of SCENARIOS) {
    assert.ok(sc.stored === null || implValues.has(sc.stored),
      `scenario "${sc.name}" references a non-existent outcome constant`);
  }
});

test("D6 the model's allocation guard matches the documented §11 predicate", () => {
  // Each clause is checked in isolation so a guard that silently stops being
  // load-bearing is caught here rather than by a mutation weeks later.
  const base = MODEL.initialState();
  const B = { maxAttempts: 2 };
  assert.equal(MODEL.mayAllocateAttempt(base, B), true, "clean state may allocate");

  const cases = [
    ["terminal", { terminal: true }],
    ["ambiguous", { possibility: "may_have_been_sent" }],
    ["provider accepted", { possibility: "provider_accepted" }],
    ["delivered", { possibility: "delivered" }],
    ["retry denied", { retry: "retry_denied" }],
    ["runtime withdrawn", { runtime: false }],
    ["compliance withdrawn", { compliance: false }],
    ["active sibling", { attempts: [{ n: 1, completed: false }] }],
  ];
  for (const [label, patch] of cases) {
    assert.equal(MODEL.mayAllocateAttempt({ ...base, ...patch }, B), false,
      `${label} must block allocation`);
  }
});
