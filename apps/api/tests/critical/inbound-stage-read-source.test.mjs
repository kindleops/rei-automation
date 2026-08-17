// Candidate A — seller-stage read-source defect.
//
// The reconstructed outbound-pair context carries no stage, so the inbound
// orchestrator's supplied stage defaults to the S1 `ownership_check`, even for
// threads the canonical deal record has already advanced. resolveEffectiveStageBefore
// uses the already-loaded persisted lifecycle stage (deal_state.acquisition_stage)
// as a MONOTONIC FLOOR. These tests pin the 7 required properties.
//
// All inbound entry paths (webhook, burst, recovery) converge on
// processSellerInboundMessage (module contract, top-of-file), which computes
// effective_stage_before ONCE via this single pure helper — so path-independence
// reduces to the helper being pure (proven in test 5).

import test from "node:test";
import assert from "node:assert/strict";

import { resolveEffectiveStageBefore } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import {
  normalizeLifecycleStage,
  lifecycleStageNumber,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";

const num = (v) => lifecycleStageNumber(normalizeLifecycleStage(v));

// 1) Persisted offer_interest + missing reconstructed stage → reads offer_interest, never ownership_check.
test("persisted offer_interest with no supplied stage anchors at offer_interest (not S1)", () => {
  const r = resolveEffectiveStageBefore({
    deal_state: { acquisition_stage: "offer_interest" },
    stageBefore: null,
    suppliedConversationStage: null,
  });
  assert.equal(normalizeLifecycleStage(r), "offer_interest");
  assert.equal(lifecycleStageNumber(r), 2);
  assert.notEqual(normalizeLifecycleStage(r), "ownership_confirmation");
});

// 2) Persisted later stage wins over an older supplied stage.
test("persisted later stage wins over an older supplied stage", () => {
  const r1 = resolveEffectiveStageBefore({
    deal_state: { acquisition_stage: "offer_interest" },
    stageBefore: "ownership_check",
  });
  assert.equal(normalizeLifecycleStage(r1), "offer_interest");

  const r2 = resolveEffectiveStageBefore({
    deal_state: { acquisition_stage: "asking_price" },
    stageBefore: null,
    suppliedConversationStage: "offer_interest",
  });
  assert.equal(normalizeLifecycleStage(r2), "asking_price");
  assert.equal(lifecycleStageNumber(r2), 3);
});

// 3) Supplied later stage is NEVER regressed by an older persisted stage.
test("a genuinely later supplied stage is never regressed by an older persisted stage", () => {
  const r1 = resolveEffectiveStageBefore({
    deal_state: { acquisition_stage: "ownership_check" },
    stageBefore: "offer_interest",
  });
  assert.equal(r1, "offer_interest"); // raw supplied preserved
  assert.equal(lifecycleStageNumber(r1), 2);

  const r2 = resolveEffectiveStageBefore({
    deal_state: { acquisition_stage: "offer_interest" },
    stageBefore: null,
    suppliedConversationStage: "asking_price",
  });
  assert.equal(r2, "asking_price");
});

// 4) Genuine new / S1 thread with no persisted stage behaves EXACTLY as before.
test("no persisted stage returns the exact original supplied value (incl. null)", () => {
  assert.equal(
    resolveEffectiveStageBefore({ deal_state: null, stageBefore: null, suppliedConversationStage: null }),
    null
  );
  assert.equal(
    resolveEffectiveStageBefore({ deal_state: {}, stageBefore: "ownership_check" }),
    "ownership_check"
  );
  assert.equal(
    resolveEffectiveStageBefore({ deal_state: { acquisition_stage: null }, suppliedConversationStage: "ownership_check" }),
    "ownership_check"
  );
  // stageBefore precedence over summary, unchanged
  assert.equal(
    resolveEffectiveStageBefore({ deal_state: {}, stageBefore: "offer_interest", suppliedConversationStage: "ownership_check" }),
    "offer_interest"
  );
});

// 5) Path-independence: the helper is pure — identical (persisted, supplied) → identical result,
//    so webhook / burst / recovery (which all pass the same persisted+supplied into the same
//    orchestrator) receive the same effective stage.
test("resolveEffectiveStageBefore is pure — same inputs yield same effective stage across entry paths", () => {
  const inputs = { deal_state: { acquisition_stage: "offer_interest" }, stageBefore: null, suppliedConversationStage: null };
  const asWebhook = resolveEffectiveStageBefore({ ...inputs });
  const asBurst = resolveEffectiveStageBefore({ ...inputs });
  const asRecovery = resolveEffectiveStageBefore({ ...inputs });
  assert.equal(asWebhook, asBurst);
  assert.equal(asBurst, asRecovery);
  assert.equal(normalizeLifecycleStage(asWebhook), "offer_interest");
});

// 6) The read floor is monotonic: it never returns a stage lower than the supplied stage.
test("effective stage is never lower than the supplied stage (monotonic read floor)", () => {
  const stages = [null, "ownership_check", "offer_interest", "asking_price", "property_condition", "offer"];
  for (const persisted of stages) {
    for (const supplied of stages) {
      const r = resolveEffectiveStageBefore({
        deal_state: persisted ? { acquisition_stage: persisted } : null,
        stageBefore: supplied,
      });
      assert.ok(
        num(r) >= num(supplied),
        `regression: persisted=${persisted} supplied=${supplied} -> ${r} (${num(r)} < ${num(supplied)})`
      );
      // and never lower than the persisted stage either (true floor)
      if (persisted) {
        assert.ok(num(r) >= num(persisted), `below persisted floor: ${persisted}/${supplied} -> ${r}`);
      }
    }
  }
});
