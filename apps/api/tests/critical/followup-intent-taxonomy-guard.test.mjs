// ─── followup-intent-taxonomy-guard.test.mjs ─────────────────────────────────
// G4: taxonomy consolidation guard.
//
// LAW (spine §4): downstream policy may key ONLY to intents the deterministic
// classifier actually emits (classify.js INTENT_PRIORITY) or to ontology slugs
// explicitly bridged via normalizeToCanonicalIntent. This test FAILS on any
// orphaned policy key, so a new policy entry keyed to a label no detector can
// ever produce is caught at review time, not in production silence.
//
// Coverage decisions locked here (per-slug record):
//   • probate_estate — NO new classify.js primary intent. The classifier
//     already detects probate/estate signals as the `probate` OBJECTION (a
//     17-language phrase list) while deliberately keeping the primary intent
//     in the ownership lane — a fixture-locked design ("probate keeps
//     ownership lane + probate objection"). The relationship lane emits
//     executor_heir_respondent for executor/heir self-claims. Both labels
//     bridge onto probate_estate, whose ontology policy is a human lane.
//     Emitting a probate primary intent would CHANGE those locked outcomes.
//   • partner_co_owner — NO new classify.js primary intent. The live detector
//     is resolve-inbound-relationship (spouse_co_owner → co_owner_respondent),
//     and the deterministic stage map routes co_owner_respondent to the review
//     lane. The label bridges onto partner_co_owner.
//   • positive_interest / conditional_interest / maybe_depends_on_price /
//     timing_complaint — V1 planner vocabulary referenced by follow-up policy
//     maps; bridged onto interested / conditionally_interested / hostile.

import test from "node:test";
import assert from "node:assert/strict";

import { INTENT_PRIORITY, classify } from "@/lib/domain/classification/classify.js";
import {
  INBOUND_INTENT_ONTOLOGY,
  getIntentDefinition,
  listIntentsWithoutClassifierCoverage,
  normalizeToCanonicalIntent,
} from "@/lib/domain/classification/inbound-intent-ontology.js";
import {
  ACTIVE_INTENTS,
  NURTURE_DAYS,
  STAGE_NO_REPLY_FOLLOWUP_INTENT,
  SUPPRESSED_INTENTS,
  UNAPPROVED_FOLLOWUP_INTENTS,
} from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import {
  buildDeterministicStageMap,
  resolveDeterministicStageTransition,
} from "@/lib/domain/seller-flow/deterministic-stage-map.js";
import { NURTURE_TEMPLATE_CANDIDATES } from "@/lib/domain/queue/resolve-deferred-queue-message.js";
import { resolveInboundRelationship } from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";

const EMITTED = new Set(INTENT_PRIORITY);

/**
 * Internal plan markers that are NOT seller-intent vocabulary and therefore
 * exempt: stage_no_reply is an outbound-purpose marker ("the delivered stage
 * question got no reply") — nothing about the seller is asserted.
 */
const NON_SELLER_INTENT_MARKERS = new Set([STAGE_NO_REPLY_FOLLOWUP_INTENT]);

function classifyOrphans(keys) {
  const orphans = [];
  for (const key of keys) {
    if (NON_SELLER_INTENT_MARKERS.has(key)) continue;
    const emitted = EMITTED.has(key);
    const is_slug = Object.prototype.hasOwnProperty.call(INBOUND_INTENT_ONTOLOGY, key);
    const bridged = normalizeToCanonicalIntent(key) !== "unclear" || key === "unclear";
    if (!emitted && !is_slug && !bridged) orphans.push(key);
  }
  return orphans;
}

// ═══ The guard: every policy key must be emitted or bridged ═════════════════

const POLICY_SOURCES = [
  ["seller-followup-scheduler NURTURE_DAYS", Object.keys(NURTURE_DAYS)],
  ["seller-followup-scheduler SUPPRESSED_INTENTS", [...SUPPRESSED_INTENTS]],
  ["seller-followup-scheduler ACTIVE_INTENTS", [...ACTIVE_INTENTS]],
  ["seller-followup-scheduler UNAPPROVED_FOLLOWUP_INTENTS", [...UNAPPROVED_FOLLOWUP_INTENTS]],
  [
    "deterministic-stage-map (explicit + stage policy rows)",
    buildDeterministicStageMap({}).map((row) => row.inbound_intent),
  ],
  [
    "resolve-deferred-queue-message NURTURE_TEMPLATE_CANDIDATES",
    Object.keys(NURTURE_TEMPLATE_CANDIDATES),
  ],
];

for (const [source, keys] of POLICY_SOURCES) {
  test(`taxonomy guard: ${source} keys are all classifier-emittable or bridged`, () => {
    const orphans = classifyOrphans(keys);
    assert.deepEqual(
      orphans,
      [],
      `Orphaned intent keys in ${source}: ${orphans.join(", ")} — ` +
        "no detector can ever produce these labels and no ontology bridge claims them. " +
        "Either add classifier coverage or register them as classifier_aliases on the ontology entry that carries their meaning."
    );
  });
}

test("taxonomy guard: every live classifier label resolves to a canonical slug (never the unclear fallback)", () => {
  for (const label of INTENT_PRIORITY) {
    const slug = normalizeToCanonicalIntent(label);
    const resolved_via_registration =
      slug !== "unclear" || label === "unclear";
    assert.ok(
      resolved_via_registration,
      `live classifier label "${label}" fell through to the unclear fallback`
    );
  }
});

test("taxonomy guard: the audited detector-gap list routes to human review, never silent no-op", () => {
  const uncovered = listIntentsWithoutClassifierCoverage();
  // The debt list may shrink but these coverage decisions are pinned:
  // probate_estate and partner_co_owner are NOT uncovered (bridged detectors).
  assert.ok(!uncovered.includes("probate_estate"), "probate_estate lost its detector bridge");
  assert.ok(!uncovered.includes("partner_co_owner"), "partner_co_owner lost its detector bridge");
  for (const slug of uncovered) {
    const def = getIntentDefinition(slug);
    const safe =
      def.terminal_hint === "human_review_required" ||
      def.reply_policy.escalate_to_human === true ||
      def.state_hints.automation !== "continue" ||
      // No-reply meta signals (emoji-class) are an explicit no-op by design,
      // not a silent one: their ontology entry says no reply is required.
      def.terminal_hint === "no_reply_required" ||
      def.terminal_hint === "duplicate_ignored" ||
      def.terminal_hint === "reply_sent";
    assert.ok(safe, `uncovered slug ${slug} has no safe routing`);
  }
});

// ═══ V1-planner vocabulary bridges (the four previously-orphaned keys) ══════

test("bridges: V1 planner labels resolve onto their canonical ontology slugs", () => {
  assert.equal(normalizeToCanonicalIntent("positive_interest"), "interested");
  assert.equal(normalizeToCanonicalIntent("conditional_interest"), "conditionally_interested");
  assert.equal(normalizeToCanonicalIntent("maybe_depends_on_price"), "conditionally_interested");
  assert.equal(normalizeToCanonicalIntent("timing_complaint"), "hostile");
  // timing_complaint's bridge target must stay a no-automated-reply lane —
  // the follow-up scheduler permanently suppresses it.
  const hostile = getIntentDefinition("timing_complaint");
  assert.equal(hostile.intent, "hostile");
  assert.equal(hostile.reply_policy.reply_permitted, false);
  assert.equal(hostile.state_hints.automation, "stop");
});

// ═══ probate/estate coverage lock (per-slug decision record) ════════════════

test("probate/estate: classifier detects the objection and the bridge routes to the human lane", async () => {
  // The fixture-locked live design: probate keeps the ownership lane as
  // primary while the probate OBJECTION carries the estate signal.
  const result = await classify("The owner passed away, its in probate now", null, {
    heuristicOnly: true,
  });
  assert.equal(result.objection, "probate");
  assert.equal(result.primary_intent, "ownership_confirmed");

  const spanish = await classify("El dueño falleció, la casa está en sucesión", null, {
    heuristicOnly: true,
  });
  assert.equal(spanish.objection, "probate");

  // Bridge: every probate-family label folds onto probate_estate.
  for (const label of ["probate", "inherited", "grieving", "executor_heir_respondent"]) {
    assert.equal(normalizeToCanonicalIntent(label), "probate_estate", label);
  }
  const def = getIntentDefinition("probate");
  assert.equal(def.intent, "probate_estate");
  assert.equal(def.terminal_hint, "human_review_required");
  assert.equal(def.reply_policy.escalate_to_human, true);
  assert.equal(def.state_hints.automation, "pause");
});

test("probate/estate: executor self-claims are detected by the relationship lane and require review", () => {
  const relationship = resolveInboundRelationship({
    message: "I'm the executor of the estate, my mother passed away",
  });
  assert.equal(relationship.relationship_claim, "executor_heir");
  assert.equal(relationship.canonical_intent, "executor_heir_respondent");
  // And that intent routes deterministically to the review lane, never auto-send.
  const transition = resolveDeterministicStageTransition({
    current_stage: "ownership_check",
    inbound_intent: "executor_heir_respondent",
  });
  assert.equal(transition.auto_send_eligible, false);
  assert.equal(transition.should_queue_reply, false);
  assert.equal(transition.next_stage, "executor_or_heir");
});

// ═══ co-owner coverage lock (per-slug decision record) ══════════════════════

test("co-owner: relationship lane detects the claim; stage map routes to review; bridge holds", () => {
  const relationship = resolveInboundRelationship({
    message: "My wife owns the property with me, we are co-owners",
  });
  assert.equal(relationship.relationship_claim, "spouse_co_owner");
  assert.equal(relationship.canonical_intent, "co_owner_respondent");
  assert.equal(relationship.human_review_required, true);

  const transition = resolveDeterministicStageTransition({
    current_stage: "ownership_check",
    inbound_intent: "co_owner_respondent",
  });
  assert.equal(transition.auto_send_eligible, false);
  assert.equal(transition.should_queue_reply, false);
  assert.equal(transition.next_stage, "authorized_spouse");

  assert.equal(normalizeToCanonicalIntent("co_owner_respondent"), "partner_co_owner");
  const def = getIntentDefinition("co_owner_respondent");
  assert.equal(def.intent, "partner_co_owner");
  // Co-owner is an owner-side party: engagement continues, binding terms need
  // all owners — never a suppression lane.
  assert.equal(def.compliance.blocks_all_future_contact, false);
});
