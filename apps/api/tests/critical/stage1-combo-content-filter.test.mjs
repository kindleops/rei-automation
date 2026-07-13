// ─── stage1-combo-content-filter.test.mjs ────────────────────────────────────
// Contract for the Variant B copy revision after the 2026-07-13 authorized
// internal canary send was terminally rejected by the TextGrid provider
// content filter (SmsStatusDetail "Blocked by Textgrid Content Filter",
// queue row 3f540d6c-83e4-43e9-8eb1-20449e2cdcc6).
//
// What must hold:
//   • the retired _A copy and its immutable version hashes never change —
//     historical attribution stays verifiable;
//   • the live _B copy is a NEW immutable version, keeps ownership + soft
//     selling interest + city/reason-for-contact + agent name, and drops the
//     filter-triggering "reviewing an offer" phrasing;
//   • nothing else about the experiment contract moved: same experiment_id,
//     same deterministic sticky Variant B assignment, same S1 lifecycle
//     entry, followup_intent still null, S1 no-reply cadence still 3 days.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  OWNERSHIP_INTEREST_COMBO_VARIANTS,
  OWNERSHIP_INTEREST_COMBO_RETIRED_VARIANTS,
  OWNERSHIP_INTEREST_COMBO_CANONICAL,
  resolveOwnershipInterestComboDraft,
} from "@/lib/domain/templates/ownership-interest-combo-experiment.js";
import {
  buildOutboundTemplateAttribution,
  templateVersionHash,
} from "@/lib/domain/templates/outbound-attribution.js";
import {
  assignVariantDeterministic,
  OWNERSHIP_EXPERIMENT_ID,
} from "@/lib/domain/templates/template-experiment-assignment.js";
import { buildInternalCanaryFirstTouch } from "@/lib/domain/templates/build-internal-canary-first-touch.js";
import { resolveFollowUpPolicyForStage } from "@/lib/domain/seller-flow/followup-policy-registry.js";

const CANARY_PHONE_B = "+16124515970";

const RETIRED_EN = OWNERSHIP_INTEREST_COMBO_RETIRED_VARIANTS.ownership_interest_combo_v1_en_A;
const RETIRED_ES = OWNERSHIP_INTEREST_COMBO_RETIRED_VARIANTS.ownership_interest_combo_v1_es_A;
const LIVE_EN = OWNERSHIP_INTEREST_COMBO_VARIANTS.English;
const LIVE_ES = OWNERSHIP_INTEREST_COMBO_VARIANTS.Spanish;

function canaryBuildArgs(overrides = {}) {
  return {
    recipientPhone: CANARY_PHONE_B,
    senderNumber: "+16128060495",
    textgridNumberId: "673d34f8-1d3c-47c8-bb1d-c8fda559ec9f",
    masterOwnerId: "mo_52f521c7e28ea3152f5e5f2c",
    prospectId: "pros1_6038996e62edf1f9d20aff95",
    propertyId: "canaryprop_6bb8a46414092cb6318fbc35",
    sellerFirstName: "Ryan",
    agentFirstName: "Scott",
    propertyAddress: "4157 Pillsbury Ave S Unit B",
    city: "Minneapolis",
    market: "Minneapolis, MN",
    activatedOverride: true,
    ...overrides,
  };
}

function templateTokens(body) {
  return [...String(body).matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim()).sort();
}

// ── Retired attribution is immutable ────────────────────────────────────────
test("retired _A bodies and their immutable version hashes never change", () => {
  // The EN hash is the exact template_version_id on the failed prod send
  // (message_event da017084-9c71-4426-916a-bb276b6a9244) — it must stay
  // byte-for-byte verifiable against the preserved body.
  assert.equal(RETIRED_EN.template_version_id, "sha1:047654d2e68020c2b3611e3b937324eb0d0acd8a");
  assert.equal(templateVersionHash(RETIRED_EN.text), RETIRED_EN.template_version_id);
  assert.equal(RETIRED_ES.template_version_id, "sha1:1e1efb5b1a7451dbae29efad2c19a91e1c60878a");
  assert.equal(templateVersionHash(RETIRED_ES.text), RETIRED_ES.template_version_id);
  assert.equal(RETIRED_EN.retired_reason, "blocked_by_textgrid_content_filter");
  assert.equal(Object.isFrozen(RETIRED_EN), true);
});

test("live _B copy is a distinct immutable version in both languages", () => {
  assert.notEqual(LIVE_EN.variant_id, RETIRED_EN.variant_id);
  assert.notEqual(LIVE_ES.variant_id, RETIRED_ES.variant_id);
  assert.notEqual(templateVersionHash(LIVE_EN.text), RETIRED_EN.template_version_id);
  assert.notEqual(templateVersionHash(LIVE_ES.text), RETIRED_ES.template_version_id);
});

// ── Filter-safe copy requirements ────────────────────────────────────────────
test("live copy keeps ownership + selling interest + city + agent, drops filter triggers", () => {
  for (const variant of [LIVE_EN, LIVE_ES]) {
    const body = variant.text;
    // Ownership question and soft selling interest are both present.
    assert.match(body, /still own|dueño/i);
    assert.match(body, /consider selling|consideraría venderla/i);
    // City is the stated reason for contact; property + agent are rendered.
    assert.ok(body.includes("{{city}}"));
    assert.ok(body.includes("{{property_address}}"));
    assert.ok(body.includes("{{agent_first_name}}"));
    // The provider-filter trigger phrasing is gone in every language.
    assert.doesNotMatch(body, /reviewing an offer/i);
    assert.doesNotMatch(body, /oferta/i);
    // No exaggerated urgency, no promises.
    assert.doesNotMatch(body, /urgent|act now|guarantee|promise|cash today|ahora mismo|garantiza/i);
    // No company name in the greeting slot — the agent identifies personally.
    assert.doesNotMatch(body, /LLC|Inc\b|Realty|Properties|Homes\b|Group\b/i);
  }
});

test("English and Spanish revisions are parity twins (same token set)", () => {
  assert.deepEqual(templateTokens(LIVE_EN.text), templateTokens(LIVE_ES.text));
  assert.deepEqual(templateTokens(LIVE_EN.text), ["agent_first_name", "city", "property_address", "seller_first_name"]);
});

test("rendered English canary copy is fully resolved and fits one SMS segment", () => {
  const draft = resolveOwnershipInterestComboDraft({
    language: "English",
    context: {
      seller_first_name: "Ryan",
      agent_first_name: "Scott",
      property_address: "4157 Pillsbury Ave S Unit B",
      city: "Minneapolis",
    },
    recipientPhone: CANARY_PHONE_B,
    activatedOverride: true,
  });
  assert.equal(draft.ok, true, draft?.reason);
  assert.equal(
    draft.text,
    "Hi Ryan, this is Scott, a buyer looking in Minneapolis. Do you still own 4157 Pillsbury Ave S Unit B, and would you consider selling it?"
  );
  assert.doesNotMatch(draft.text, /\{\{[^}]+\}\}/);
  assert.ok(draft.text.length <= 160, `one GSM segment, got ${draft.text.length}`);
});

test("missing city fails closed instead of shipping an unresolved placeholder", () => {
  const draft = resolveOwnershipInterestComboDraft({
    language: "English",
    context: { seller_first_name: "Ryan", agent_first_name: "Scott", property_address: "123 Oak St" },
    recipientPhone: CANARY_PHONE_B,
    activatedOverride: true,
  });
  assert.equal(draft.ok, false);
  assert.equal(draft.blocked, true);
});

// ── Experiment contract is unchanged by the wording update ──────────────────
test("attribution changes only because the copy changed", () => {
  const shared = {
    templateKey: "ownership_interest_combo_v1",
    stage: "S1",
    classifiedOutcome: null,
    language: "English",
    experiment: { experiment_id: OWNERSHIP_EXPERIMENT_ID, variant_id: "ownership_interest_combo_B" },
    touchNumber: 1,
    parentOutboundEventId: null,
    automationOrigin: "internal_canary_first_touch",
  };
  const old_attribution = buildOutboundTemplateAttribution({
    ...shared,
    template: { template_id: RETIRED_EN.variant_id, template_body: RETIRED_EN.text, use_case: "ownership_check", stage_code: "S1", language: "English" },
  });
  const new_attribution = buildOutboundTemplateAttribution({
    ...shared,
    template: { template_id: LIVE_EN.variant_id, template_body: LIVE_EN.text, use_case: "ownership_check", stage_code: "S1", language: "English" },
  });

  // The only deltas are the copy identity and its content hash.
  assert.notEqual(new_attribution.template_id, old_attribution.template_id);
  assert.notEqual(new_attribution.template_version_id, old_attribution.template_version_id);
  const invariant_keys = Object.keys(old_attribution).filter(
    (k) => !["template_id", "template_version_id"].includes(k)
  );
  for (const key of invariant_keys) {
    assert.deepEqual(new_attribution[key], old_attribution[key], `attribution.${key} must not move`);
  }
});

test("canary contract invariants: sticky B, S1 entry, null followup_intent, 3-day no-reply cadence", () => {
  // Deterministic assignment for the canary phone remains sticky Variant B.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(assignVariantDeterministic(OWNERSHIP_EXPERIMENT_ID, CANARY_PHONE_B), "B");
  }

  const built = buildInternalCanaryFirstTouch(canaryBuildArgs());
  assert.equal(built.ok, true, built.reason);
  assert.equal(built.attribution.experiment_id, "ownership_first_touch_ab_v1");
  assert.equal(built.attribution.experiment_variant_id, "ownership_interest_combo_B");
  assert.equal(built.attribution.template_id, "ownership_interest_combo_v1_en_B");
  assert.equal(built.attribution.template_version_id, templateVersionHash(LIVE_EN.text));
  assert.equal(built.queue_row.stage_before, "ownership_confirmation");
  assert.equal(built.queue_row.metadata.automation_provenance.followup_intent, null);

  // Lifecycle still starts at Stage 1 and the reply may satisfy S1 and S2.
  assert.equal(OWNERSHIP_INTEREST_COMBO_CANONICAL.starting_stage, "ownership_confirmation");
  assert.equal(OWNERSHIP_INTEREST_COMBO_CANONICAL.advances_to_stage, "offer_interest");
  assert.equal(OWNERSHIP_INTEREST_COMBO_CANONICAL.merges_stages, false);

  // Stage 1 no-reply policy is untouched: stage_no_reply plan, 3-day cadence.
  const { policy } = resolveFollowUpPolicyForStage("ownership_confirmation");
  assert.equal(policy.enabled, true);
  assert.equal(policy.no_reply_delay_days, 3);
});
