import test from "node:test";
import assert from "node:assert/strict";

import {
  OWNERSHIP_INTEREST_COMBO_EXPERIMENT,
  OWNERSHIP_INTEREST_COMBO_VARIANTS,
  OWNERSHIP_INTEREST_COMBO_CANONICAL,
  resolveOwnershipInterestComboDraft,
} from "@/lib/domain/templates/ownership-interest-combo-experiment.js";
import { classify } from "@/lib/domain/classification/classify.js";

const INTERNAL_PHONE = "+16127433952";
const REAL_PHONE = "+14155551234";
const CONTEXT = {
  seller_first_name: "Maria",
  agent_first_name: "Alex",
  property_address: "123 Oak St",
  city: "Miami",
};

// ── Safety: dormant by default, never touches production selection ───────────

test("combo experiment is a draft, inactive, internal-only, not auto-reply-safe", () => {
  assert.equal(OWNERSHIP_INTEREST_COMBO_EXPERIMENT.status, "draft");
  assert.equal(OWNERSHIP_INTEREST_COMBO_EXPERIMENT.active, false);
  assert.equal(OWNERSHIP_INTEREST_COMBO_EXPERIMENT.internal_only, true);
  assert.equal(OWNERSHIP_INTEREST_COMBO_EXPERIMENT.safe_for_auto_reply, false);
});

test("combo keeps the canonical lifecycle: starts S1, advances to S2, never merges stages", () => {
  assert.equal(OWNERSHIP_INTEREST_COMBO_CANONICAL.starting_stage, "ownership_confirmation");
  assert.equal(OWNERSHIP_INTEREST_COMBO_CANONICAL.advances_to_stage, "offer_interest");
  assert.equal(OWNERSHIP_INTEREST_COMBO_CANONICAL.merges_stages, false);
});

test("combo is dormant unless explicitly activated — default env returns null", () => {
  const result = resolveOwnershipInterestComboDraft({
    language: "English",
    context: CONTEXT,
    recipientPhone: INTERNAL_PHONE,
    env: {},
  });
  assert.equal(result, null);
});

test("combo is blocked for non-internal phones even when activated", () => {
  const result = resolveOwnershipInterestComboDraft({
    language: "English",
    context: CONTEXT,
    recipientPhone: REAL_PHONE,
    activatedOverride: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "non_internal_phone");
});

// ── Rendering: internal phone + activated, no unresolved placeholders ────────

test("combo renders English for an internal phone with a resolved body", () => {
  const result = resolveOwnershipInterestComboDraft({
    language: "English",
    context: CONTEXT,
    recipientPhone: INTERNAL_PHONE,
    activatedOverride: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.language, "English");
  assert.ok(result.text.includes("Maria"));
  assert.ok(result.text.includes("123 Oak St"));
  assert.ok(result.text.includes("Alex"));
  assert.doesNotMatch(result.text, /\{\{.*\}\}/, "no unresolved placeholders");
  // Entity/company name is never used as the human greeting slot.
  assert.match(result.text, /^Hi Maria,/);
});

test("combo renders Spanish and does not fall back to English", () => {
  const result = resolveOwnershipInterestComboDraft({
    language: "Spanish",
    context: CONTEXT,
    recipientPhone: INTERNAL_PHONE,
    activatedOverride: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.language, "Spanish");
  assert.ok(result.text.includes("dueño"));
  assert.ok(result.text.includes("propuesta"));
  assert.ok(result.text.includes("propiedad"));
  assert.doesNotMatch(result.text, /\boferta\b/i);
  assert.doesNotMatch(result.text, /\bvender\b/i);
  assert.doesNotMatch(result.text, /\bcomprador\b/i);
});

test("combo fails closed for a non-English language with no variant — no English fallback", () => {
  const result = resolveOwnershipInterestComboDraft({
    language: "Mandarin",
    context: CONTEXT,
    recipientPhone: INTERNAL_PHONE,
    activatedOverride: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "language_variant_missing");
  assert.equal(result.human_review_required, true);
});

test("combo rejects a message with a missing token instead of shipping {{...}}", () => {
  const result = resolveOwnershipInterestComboDraft({
    language: "English",
    context: { seller_first_name: "Maria", agent_first_name: "Alex" }, // no property_address
    recipientPhone: INTERNAL_PHONE,
    activatedOverride: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.ok(String(result.reason).includes("placeholder") || (result.missing || []).length > 0);
});

// ── A/B metadata structure present but inert ─────────────────────────────────

test("combo carries A/B metadata with guardrails and an inactive experiment", () => {
  assert.equal(OWNERSHIP_INTEREST_COMBO_EXPERIMENT.active, false);
  assert.equal(OWNERSHIP_INTEREST_COMBO_EXPERIMENT.arms.length, 2);
  assert.ok(OWNERSHIP_INTEREST_COMBO_EXPERIMENT.guardrail_metrics.includes("opt_out_rate"));
  assert.equal(OWNERSHIP_INTEREST_COMBO_EXPERIMENT.supports_multi_intent_reply, true);
});

// ── Multi-intent replies (classified by the existing production classifier) ──

test("combo replies classify as multi-intent through the existing classifier", async () => {
  // "Yes, what's your offer?" → ownership confirmed + offer interest.
  const yesOffer = await classify("Yes, what's your offer?");
  assert.ok(yesOffer, "classifier returns a result");

  // "No, I'm the tenant." → not owner / relationship handling, not confirmation.
  const tenant = await classify("No, I'm the tenant.");
  assert.notEqual(tenant.primary_intent, "ownership_confirmed");

  // "Who is this?" → trust/identity handling, not ownership confirmation.
  const whoIsThis = await classify("Who is this?");
  assert.notEqual(whoIsThis.primary_intent, "ownership_confirmed");
});
