import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveSellerStageTransition,
  listReviewHoldIntents,
  NEXT_ACTIONS,
} from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { LIFECYCLE_STAGE_CODES } from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { resolveExceptionWorkflow, resolveExceptionWorkflowForDecision } from "@/lib/domain/seller-flow/coverage-net/exception-workflows.js";
import { CANONICAL_INTENTS } from "@/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js";

// GATE 7 — ZERO SILENT DEAD-ENDS for the legal/authority + respondent tiers (§5).
//
// Before this gate, a legal-tier intent ("I'm in bankruptcy", "there's a lien")
// was neither BLOCKING nor ambiguous in the canonical resolver, so it fell to
// the DEFAULT return: ACTIVE_COMMUNICATION, the stage's normal script/template,
// and the pending follow-up cancelled with nothing replacing it. The coverage
// net then had no workflow mapping for the intent and routed it to the generic
// ambiguous_context clarifier (blocks_outreach:false). These tests pin the
// deterministic hold + owned workflow at EVERY stage for EVERY tier intent.

const STAGES = [
  LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
  LIFECYCLE_STAGE_CODES.ASKING_PRICE,
  LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION,
  LIFECYCLE_STAGE_CODES.OFFER,
  LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT,
];

const LEGAL = ["title_issue", "lien_tax_issue", "bankruptcy_disclosed", "trust_ownership", "llc_corporation"];
const RESPONDENT = [
  "tenant_respondent", "property_manager_respondent", "family_member_respondent",
  "agent_representative_respondent", "executor_heir_respondent", "entity_representative_respondent",
  "co_owner_respondent", "non_owner_referral",
];

function resolve(stage, intent, over = {}) {
  return resolveSellerStageTransition({
    stage_before: stage,
    intent,
    known_facts: {},
    new_facts: {},
    classification_confidence: 0.95,
    automation_mode: "live_limited",
    current_temperature: null,
    current_disposition: null,
    ade_result: null,
    ...over,
  });
}

function assertHold(t, { stage, intent, reason, cancel }) {
  assert.equal(t.advanced, false, `${stage}/${intent}: stage must not move`);
  assert.equal(t.stage_after, stage, `${stage}/${intent}: stage_after unchanged`);
  assert.equal(t.review_required, true, `${stage}/${intent}: review required`);
  assert.equal(t.review_reason, reason, `${stage}/${intent}: tier reason`);
  assert.equal(t.next_action, NEXT_ACTIONS.HUMAN_REVIEW, `${stage}/${intent}: next action`);
  assert.equal(t.operational_status, "needs_review", `${stage}/${intent}: operational status`);
  assert.equal(t.required_template_use_case, null, `${stage}/${intent}: NEVER the stage script`);
  assert.equal(t.contactability_patch, null, `${stage}/${intent}: no contactability write`);
  assert.equal(t.ownership_patch, null, `${stage}/${intent}: no ownership write`);
  assert.match(t.reasoning_code, new RegExp(`_HOLD_${intent.toUpperCase()}_REVIEW$`));
  assert.equal(t.follow_up.cancel, cancel, `${stage}/${intent}: follow-up cancellation policy`);
  assert.equal(t.follow_up.create, false);
  assert.deepEqual(t.workflow_event_types, ["AUTOMATION_NEEDS_REVIEW"]);
}

// ── the registry is complete and every tier intent is canonical ─────────────

test("the review-hold registry covers exactly the legal + respondent + correction tiers, all canonical", () => {
  const held = listReviewHoldIntents();
  const names = held.map((h) => h.intent).sort();
  assert.deepEqual(names, [...LEGAL, ...RESPONDENT, "property_correction"].sort());
  for (const h of held) assert.ok(CANONICAL_INTENTS.includes(h.intent), `${h.intent} must be a canonical intent`);
  assert.ok(held.filter((h) => h.tier === "legal_authority").every((h) => h.cancel_followups === true));
  assert.ok(held.filter((h) => h.tier === "respondent_identity").every((h) => h.cancel_followups === false));
});

// ── the resolver holds deterministically at EVERY stage ─────────────────────

test("legal/authority disclosures hold for review at every stage and never get the stage script", () => {
  for (const stage of STAGES) {
    for (const intent of LEGAL) {
      const t = resolve(stage, intent);
      assertHold(t, { stage, intent, reason: "legal_authority_disclosure", cancel: true });
      assert.equal(t.review_hold_tier, "legal_authority");
    }
  }
});

test("respondent classes hold for identity review at every stage, keeping the follow-up", () => {
  for (const stage of STAGES) {
    for (const intent of RESPONDENT) {
      const t = resolve(stage, intent);
      assertHold(t, { stage, intent, reason: "respondent_identity_review", cancel: false });
      assert.equal(t.review_hold_tier, "respondent_identity");
    }
  }
});

test("a property correction holds for review at every stage", () => {
  for (const stage of STAGES) {
    const t = resolve(stage, "property_correction");
    assertHold(t, { stage, intent: "property_correction", reason: "property_correction", cancel: false });
  }
});

test("a legal disclosure AFTER accepted terms still holds (a title issue post-acceptance needs a human)", () => {
  const t = resolve(LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT, "title_issue", {
    negotiation_state: { terms_accepted: true, accepted_price: 250000 },
  });
  assert.equal(t.review_required, true);
  assert.equal(t.review_reason, "legal_authority_disclosure");
  assert.equal(t.required_template_use_case, null);
});

// ── the hold is NOT applied to everything else (regression guards) ──────────

test("blocking intents still block (the hold never pre-empts suppression)", () => {
  const stop = resolve(LIFECYCLE_STAGE_CODES.OFFER_INTEREST, "opt_out");
  assert.equal(stop.next_action, NEXT_ACTIONS.NO_ACTION_CONTACT_BLOCKED);
  assert.equal(stop.contactability_patch?.contactability_status, "opted_out");
  const wrong = resolve(LIFECYCLE_STAGE_CODES.OFFER_INTEREST, "wrong_number");
  assert.equal(wrong.next_action, NEXT_ACTIONS.NO_ACTION_CONTACT_BLOCKED);
});

test("a neutral engaged intent is NOT held (seller_interested still proceeds)", () => {
  const t = resolve(LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION, "seller_interested");
  assert.notEqual(t.review_reason, "legal_authority_disclosure");
  assert.notEqual(t.review_reason, "respondent_identity_review");
  assert.notEqual(t.next_action, NEXT_ACTIONS.HUMAN_REVIEW);
});

// ── the coverage net routes every tier to an OWNED workflow, never the generic clarifier ──

test("every legal-tier reason resolves to legal_compliance_hold (outreach blocked)", () => {
  for (const reason of [...LEGAL, "legal_authority_disclosure"]) {
    const wf = resolveExceptionWorkflow(reason);
    assert.equal(wf.key, "legal_compliance_hold", reason);
    assert.equal(wf.blocks_outreach, true, `${reason} must block outreach`);
    assert.notEqual(wf.fallback_action, "send_safe_clarifier", `${reason} must never fall to a clarifier`);
  }
});

test("every respondent-tier reason resolves to identity_clarification, never ambiguous_context", () => {
  for (const reason of [...RESPONDENT, "respondent_identity_review"]) {
    const wf = resolveExceptionWorkflow(reason);
    assert.equal(wf.key, "identity_clarification", reason);
    assert.notEqual(wf.key, "ambiguous_context", reason);
  }
  assert.equal(resolveExceptionWorkflow("property_correction").key, "conflicting_property_identity");
});

test("no canonical intent in the held tiers can reach the generic ambiguous_context workflow", () => {
  for (const intent of [...LEGAL, ...RESPONDENT, "property_correction"]) {
    assert.notEqual(resolveExceptionWorkflow(intent).key, "ambiguous_context", intent);
  }
});

// ── PRECEDENCE: a specific per-intent workflow beats the generic reason bucket ──
// The executor labels respondent turns with the generic reason
// "unhandled_classification". That reason must not mask the intent's own owned
// workflow -- and a specific reason must never be downgraded.

test("a generic 'unhandled_classification' reason does not mask a respondent intent's identity workflow", () => {
  for (const intent of RESPONDENT) {
    const wf = resolveExceptionWorkflowForDecision({ reason: "unhandled_classification", canonical_intent: intent });
    assert.equal(wf.key, "identity_clarification", intent);
  }
});

test("a generic reason does not mask a legal intent's compliance hold", () => {
  for (const intent of LEGAL) {
    for (const reason of ["unhandled_classification", "automation_review_required", "confidence_or_policy_block"]) {
      const wf = resolveExceptionWorkflowForDecision({ reason, canonical_intent: intent });
      assert.equal(wf.key, "legal_compliance_hold", `${intent}/${reason}`);
      assert.equal(wf.blocks_outreach, true);
    }
  }
});

test("a genuinely ambiguous intent still resolves to ambiguous_context (behaviour unchanged)", () => {
  for (const intent of ["unclear", "reaction_only", "acknowledgement"]) {
    const wf = resolveExceptionWorkflowForDecision({ reason: "unhandled_classification", canonical_intent: intent });
    assert.equal(wf.key, "ambiguous_context", intent);
  }
  assert.equal(resolveExceptionWorkflowForDecision({}).key, "ambiguous_context");
});

test("a SPECIFIC reason is never downgraded by the intent (suppression + safety stay put)", () => {
  assert.equal(resolveExceptionWorkflowForDecision({ reason: "opt_out", canonical_intent: "tenant_respondent" }).key, "suppression_confirmed");
  assert.equal(resolveExceptionWorkflowForDecision({ reason: "hostile_or_legal", canonical_intent: "agent_representative_respondent" }).key, "safety_hold");
  assert.equal(resolveExceptionWorkflowForDecision({ reason: "missing_context", canonical_intent: "title_issue" }).key, "identity_clarification");
});
