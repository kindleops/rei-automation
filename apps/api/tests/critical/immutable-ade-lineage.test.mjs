import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { applyNegotiationTurn } from "@/lib/domain/seller-flow/negotiation-state.js";

// IMMUTABLE MONETARY PROVENANCE
//
// Proven defect (2026-08-31): persistAcquisitionScore() upserts
// property_acquisition_scores with onConflict:'property_id', so there is exactly
// ONE mutable row per property. Row 51f6cd21-0b94-4925-a3a1-e51665a6b5c4 held
// recommended_cash_offer $10,969,000 on 2026-08-03 and $5,479,900 on
// 2026-08-31 -- same id, different money. negotiation-state bound
// seller_offers.ade_snapshot_id to that id, so a sent or accepted offer could
// have its own evidence rewritten by the next scoring run.

const snapshotWith = (over = {}) => ({
  id: "51f6cd21-0b94-4925-a3a1-e51665a6b5c4", // the MUTABLE projection row id
  recommended_cash_offer: 250000,
  minimum_acceptable_offer: 240000,
  investor_ceiling_mid: 21284800,
  investor_ceiling_high: 21284800,
  valuation_mid: 468200,
  valuation_confidence: 74,
  evidence: {
    immutable_snapshot_id: "11111111-1111-4111-8111-111111111111",
    offer_calculation: {
      valuation_based_ceiling: 295940,
      effective_authorized_ceiling: 295940,
      behavior_based_ceiling: 21284800,
    },
  },
  ...over,
});

test("offer lineage binds to the IMMUTABLE snapshot, not the mutable projection row", () => {
  const next = applyNegotiationTurn(null, { ade_snapshot: snapshotWith() });
  assert.equal(
    next.ade_snapshot_id,
    "11111111-1111-4111-8111-111111111111",
    "must bind to the append-only lineage id"
  );
  assert.notEqual(
    next.ade_snapshot_id,
    "51f6cd21-0b94-4925-a3a1-e51665a6b5c4",
    "must NOT bind to the row the next ADE run rewrites"
  );
});

test("a run with no immutable lineage yields no snapshot binding at all", () => {
  const noLineage = snapshotWith({ evidence: { offer_calculation: { effective_authorized_ceiling: 295940 } } });
  const next = applyNegotiationTurn(null, { ade_snapshot: noLineage });
  assert.ok(
    !next.ade_snapshot_id || next.ade_snapshot_id !== "51f6cd21-0b94-4925-a3a1-e51665a6b5c4",
    "absence of lineage must not silently fall back to the mutable id"
  );
});

test("the authorized ceiling is independent of the buyer-behavior leg", () => {
  const next = applyNegotiationTurn(null, { ade_snapshot: snapshotWith() });
  assert.equal(next.authorized_offer_ceiling, 295940, "uses the effective authorized ceiling");
  assert.notEqual(next.authorized_offer_ceiling, 21284800, "never the contaminated investor ceiling");
});

test("the ceiling falls back to the valuation-based ceiling, never investor_ceiling_*", () => {
  const noEffective = snapshotWith({
    evidence: {
      immutable_snapshot_id: "22222222-2222-4222-8222-222222222222",
      offer_calculation: { valuation_based_ceiling: 295940, behavior_based_ceiling: 21284800 },
    },
  });
  const next = applyNegotiationTurn(null, { ade_snapshot: noEffective });
  assert.equal(next.authorized_offer_ceiling, 295940);
});

test("repeated ADE runs mint distinct immutable snapshot identities", () => {
  const runA = applyNegotiationTurn(null, { ade_snapshot: snapshotWith() });
  const runB = applyNegotiationTurn(null, {
    ade_snapshot: snapshotWith({
      recommended_cash_offer: 199000,
      evidence: {
        immutable_snapshot_id: "33333333-3333-4333-8333-333333333333",
        offer_calculation: { valuation_based_ceiling: 280000, effective_authorized_ceiling: 280000 },
      },
    }),
  });
  assert.notEqual(runA.ade_snapshot_id, runB.ade_snapshot_id, "each run has its own identity");
  // The prior binding is a plain value: a later run cannot reach back and alter it.
  assert.equal(runA.ade_snapshot_id, "11111111-1111-4111-8111-111111111111");
});

test("the mutable projection changing its money does NOT change a prior offer's lineage", () => {
  // Offer written against run A.
  const runA = applyNegotiationTurn(null, { ade_snapshot: snapshotWith() });
  const boundSnapshotId = runA.ade_snapshot_id;
  const boundCeiling = runA.authorized_offer_ceiling;

  // The SAME projection row id is later rewritten with completely different money.
  const rewritten = snapshotWith({
    recommended_cash_offer: 5479900,
    investor_ceiling_mid: 21284800,
    evidence: {
      immutable_snapshot_id: "44444444-4444-4444-8444-444444444444",
      offer_calculation: { valuation_based_ceiling: 295940, effective_authorized_ceiling: 295940 },
    },
  });
  const runB = applyNegotiationTurn(null, { ade_snapshot: rewritten });

  assert.equal(boundSnapshotId, "11111111-1111-4111-8111-111111111111", "prior lineage unchanged");
  assert.equal(boundCeiling, 295940, "prior authorized ceiling unchanged");
  assert.notEqual(runB.ade_snapshot_id, boundSnapshotId, "the rewrite is a NEW identity, not a mutation");
});
