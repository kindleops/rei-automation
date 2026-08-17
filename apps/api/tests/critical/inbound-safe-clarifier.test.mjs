// Stage-aware safe-fallback clarifier wiring (activation-hardening item 2).
// Reuses coverage-net/safe-fallback.js — these tests pin the dispatch gate
// (fail-closed), the synthetic-template short-circuit, the language fail-close,
// and the V2 ambiguity-only withhold carve.

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveSafeFallbackClarifierDispatch,
  selectSafeAutoReplyTemplate,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { resolveV2ReplyWithhold } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { buildSafeFallback } from "@/lib/domain/seller-flow/coverage-net/safe-fallback.js";

const reviewDecision = (overrides = {}) => ({
  should_queue_reply: false,
  should_mark_human_review: true,
  should_suppress_contact: false,
  human_review_reason: "unclear_low_confidence",
  audit_reason: "unclear_low_confidence",
  ...overrides,
});

const unclearClassification = (overrides = {}) => ({
  primary_intent: "unclear",
  detected_intent: "unclear",
  compliance_flag: null,
  language: "English",
  automation_decision: { suppression_action: "none" },
  ...overrides,
});

// ── dispatch gate: fires for the safe-ambiguous subset ─────────────────────
test("clarifier fires for an ambiguous unclear review with stage-aware text", () => {
  const d = resolveSafeFallbackClarifierDispatch({
    decision: reviewDecision(),
    classification: unclearClassification(),
    message: "hmm",
    stage: "asking_price",
  });
  assert.ok(d, "must dispatch for ambiguous unclear review");
  assert.equal(d.stage_bucket, "asking_price");
  assert.equal(d.uncertainty_type, "intent");
  assert.equal(
    d.suggested_text,
    buildSafeFallback({ stage: "asking_price", uncertainty_type: "intent" }).suggested_text
  );
});

test("clarifier fires for reaction_only and acknowledgement ambiguity", () => {
  for (const intent of ["reaction_only", "acknowledgement"]) {
    const d = resolveSafeFallbackClarifierDispatch({
      decision: reviewDecision({ human_review_reason: "ambiguous_intent" }),
      classification: unclearClassification({ primary_intent: intent }),
      message: "ok",
      stage: "offer_interest",
    });
    assert.ok(d, `must dispatch for ${intent}`);
  }
});

test("clarifier text is stage-aware (different stages → different questions)", () => {
  const at = (stage) =>
    resolveSafeFallbackClarifierDispatch({
      decision: reviewDecision(),
      classification: unclearClassification(),
      message: "hmm",
      stage,
    }).suggested_text;
  assert.notEqual(at("ownership_confirmation"), at("offer"));
  assert.notEqual(at("offer_interest"), at("asking_price"));
});

// ── dispatch gate: fail-closed exclusions ──────────────────────────────────
test("clarifier never fires on suppression, compliance, or a suppressive decision", () => {
  // suppressed contact
  assert.equal(
    resolveSafeFallbackClarifierDispatch({
      decision: reviewDecision({ should_suppress_contact: true }),
      classification: unclearClassification(),
      message: "hmm",
    }),
    null
  );
  // compliance-flagged message
  assert.equal(
    resolveSafeFallbackClarifierDispatch({
      decision: reviewDecision(),
      classification: unclearClassification({ compliance_flag: "stop_texting" }),
      message: "hmm",
    }),
    null
  );
  // classifier decision carries a suppression action
  assert.equal(
    resolveSafeFallbackClarifierDispatch({
      decision: reviewDecision(),
      classification: unclearClassification({
        automation_decision: { suppression_action: "opt_out" },
      }),
      message: "hmm",
    }),
    null
  );
});

test("clarifier never fires for protected review reasons or non-ambiguous intents", () => {
  // protected review lanes keep review (legal, price-objection, referral, no-template)
  for (const reason of [
    "no_safe_template",
    "property_correction",
    "price_objection_below_negotiation",
    "referral_review_required",
    "co_owner_authority_review_required",
    "template_render_failed",
  ]) {
    assert.equal(
      resolveSafeFallbackClarifierDispatch({
        decision: reviewDecision({ human_review_reason: reason, audit_reason: reason }),
        classification: unclearClassification(),
        message: "hmm",
      }),
      null,
      `protected reason must keep review: ${reason}`
    );
  }
  // a review on a NON-ambiguous intent (e.g. probate-gated ownership) keeps review
  assert.equal(
    resolveSafeFallbackClarifierDispatch({
      decision: reviewDecision({ human_review_reason: "ambiguous_intent" }),
      classification: unclearClassification({ primary_intent: "ownership_confirmed" }),
      message: "hmm",
    }),
    null
  );
  // an already-queueing decision is untouched
  assert.equal(
    resolveSafeFallbackClarifierDispatch({
      decision: reviewDecision({ should_queue_reply: true }),
      classification: unclearClassification(),
      message: "hmm",
    }),
    null
  );
});

test("clarifier never fires for content-bearing unclear messages (classifier-gap containment)", () => {
  // Indirect already-sold phrasing that classifies unclear: the corpus demands
  // silence, and the word-bound guard keeps unparsed CONTENT in review.
  assert.equal(
    resolveSafeFallbackClarifierDispatch({
      decision: reviewDecision(),
      classification: unclearClassification(),
      message: "we closed on it in March",
    }),
    null
  );
  // empty / missing message also fail-closed
  assert.equal(
    resolveSafeFallbackClarifierDispatch({
      decision: reviewDecision(),
      classification: unclearClassification(),
      message: "",
    }),
    null
  );
});

test("clarifier never fires for protected-lane objections riding an unclear intent", () => {
  for (const objection of ["probate", "financial_distress", "divorce", "property_correction"]) {
    assert.equal(
      resolveSafeFallbackClarifierDispatch({
        decision: reviewDecision(),
        classification: unclearClassification({ objection }),
        message: "hmm",
      }),
      null,
      `objection must keep review: ${objection}`
    );
  }
});

// ── template short-circuit ─────────────────────────────────────────────────
const throwingSupabase = {
  from() {
    throw new Error("clarifier short-circuit must not touch the DB");
  },
};

test("selector returns the synthetic clarifier template without touching the DB", async () => {
  const dispatch = resolveSafeFallbackClarifierDispatch({
    decision: reviewDecision(),
    classification: unclearClassification(),
    message: "hmm",
    stage: "property_condition",
  });
  const result = await selectSafeAutoReplyTemplate({
    supabaseClient: throwingSupabase,
    classification: unclearClassification(),
    decision: { ...reviewDecision(), clarifier_dispatch: dispatch },
    context: null,
    threadKey: "+16125550100",
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "safe_fallback_clarifier");
  assert.equal(result.template.use_case, "safe_clarifier");
  assert.equal(result.template.safe_for_auto_reply, true);
  assert.equal(result.template.template_body, dispatch.suggested_text);
});

test("selector fail-closes the clarifier for a non-English thread", async () => {
  const dispatch = resolveSafeFallbackClarifierDispatch({
    decision: reviewDecision(),
    classification: unclearClassification(),
    message: "hmm",
    stage: "offer_interest",
  });
  const result = await selectSafeAutoReplyTemplate({
    supabaseClient: throwingSupabase,
    classification: { ...unclearClassification(), language: "Spanish" },
    decision: { ...reviewDecision(), clarifier_dispatch: dispatch },
    context: null,
    threadKey: "+16125550100",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "clarifier_language_unavailable");
});

// ── V2 withhold carve ──────────────────────────────────────────────────────
test("V2 withhold: ambiguity-only review no longer withholds; everything else still does", () => {
  const state = (safety) => ({ safety });
  // ambiguity-only review → live (the clarifier can answer)
  assert.equal(
    resolveV2ReplyWithhold({
      conversation_state: state({
        suppression_required: false,
        no_reply_required: false,
        human_review_required: true,
        ambiguity_only_review: true,
      }),
      response_strategy: { no_reply: true, human_review_required: true, suppression_required: false },
    }),
    false
  );
  // review with a non-ambiguity component → withheld
  assert.equal(
    resolveV2ReplyWithhold({
      conversation_state: state({
        suppression_required: false,
        no_reply_required: false,
        human_review_required: true,
        ambiguity_only_review: false,
      }),
    }),
    true
  );
  // suppression always withholds, even with ambiguity_only set
  assert.equal(
    resolveV2ReplyWithhold({
      conversation_state: state({
        suppression_required: true,
        no_reply_required: true,
        human_review_required: true,
        ambiguity_only_review: true,
      }),
    }),
    true
  );
  // strategy-level suppression always withholds
  assert.equal(
    resolveV2ReplyWithhold({
      conversation_state: state({
        suppression_required: false,
        no_reply_required: false,
        human_review_required: true,
        ambiguity_only_review: true,
      }),
      response_strategy: { suppression_required: true },
    }),
    true
  );
});
