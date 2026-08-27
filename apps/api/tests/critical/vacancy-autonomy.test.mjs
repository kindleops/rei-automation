import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";

// Classifier-coverage seam fix: a disclosed VACANCY (vacant / empty / abandoned
// / nobody lives there / absentee) is a strong buy-signal and a property fact
// that advances underwriting, exactly like tenant_occupied covers the OCCUPIED
// case. It now routes to condition_disclosed (autonomous, 0.85) instead of
// falling to unclear -> human review. Signal-anchored; only wins as primary when
// no stronger intent is present, so it does not weaken the ambiguity gate.

const c = (text) => classify(text, null, { heuristicOnly: true });

test("vacancy disclosure advances autonomously (condition_disclosed >= 0.82)", async () => {
  for (const text of [
    "its vacant",
    "the house is empty",
    "sitting vacant",
    "nobody lives there",
    "its unoccupied",
    "no one lives there",
  ]) {
    const r = await c(text);
    assert.equal(
      r.primary_intent,
      "condition_disclosed",
      `"${text}" expected condition_disclosed, got ${r.primary_intent}`
    );
    assert.ok(r.confidence >= 0.82, `"${text}" confidence ${r.confidence} must clear 0.82`);
  }
});

test("occupied case unchanged; no false vacancy routing on unrelated messages", async () => {
  assert.equal((await c("its rented out")).primary_intent, "tenant_occupied");
  assert.equal((await c("tenant lives there")).primary_intent, "tenant_occupied");
  assert.equal((await c("285k is my bottom line")).primary_intent, "asking_price_provided");
  assert.equal((await c("not interested")).primary_intent, "not_interested");
});
