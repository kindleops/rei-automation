// ─── stage1-combo-content-filter.test.mjs ────────────────────────────────────
// Contract for the Variant B combo copy revisions after TextGrid content-filter
// policy enforcement. Immutable version progression: _A (prod failure) → _B
// (pre-merge selling wording, never dispatched) → _C (active proposal-only).
//
// Canonical TextGrid rule for this template:
//   allowed: "proposal"
//   prohibited: offer, selling, sell, purchase, buy, buyer, cash offer,
//               reviewing an offer, consider selling (+ Spanish equivalents)

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

const CANARY_PHONE_B = "+16128072000";
const RETIRED_FAILED_RECIPIENT = "+16124515970";

const RETIRED_EN_A = OWNERSHIP_INTEREST_COMBO_RETIRED_VARIANTS.ownership_interest_combo_v1_en_A;
const RETIRED_ES_A = OWNERSHIP_INTEREST_COMBO_RETIRED_VARIANTS.ownership_interest_combo_v1_es_A;
const RETIRED_EN_B = OWNERSHIP_INTEREST_COMBO_RETIRED_VARIANTS.ownership_interest_combo_v1_en_B;
const RETIRED_ES_B = OWNERSHIP_INTEREST_COMBO_RETIRED_VARIANTS.ownership_interest_combo_v1_es_B;
const LIVE_EN = OWNERSHIP_INTEREST_COMBO_VARIANTS.English;
const LIVE_ES = OWNERSHIP_INTEREST_COMBO_VARIANTS.Spanish;

const EN_PROHIBITED = [
  /\boffer\b/i,
  /\bselling\b/i,
  /\bsell\b/i,
  /\bpurchase\b/i,
  /\bbuyer\b/i,
  /\bbuy\b/i,
  /cash offer/i,
  /reviewing an offer/i,
  /consider selling/i,
];

const ES_PROHIBITED = [/\boferta\b/i, /\bvender\b/i, /\bventa\b/i, /\bcomprar\b/i, /\bcomprador\b/i];

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

// ── Immutable version progression _A → _B → _C ───────────────────────────────
test("retired _A bodies and hashes remain immutable (prod content-filter failure)", () => {
  assert.equal(RETIRED_EN_A.template_version_id, "sha1:047654d2e68020c2b3611e3b937324eb0d0acd8a");
  assert.equal(templateVersionHash(RETIRED_EN_A.text), RETIRED_EN_A.template_version_id);
  assert.equal(RETIRED_ES_A.template_version_id, "sha1:1e1efb5b1a7451dbae29efad2c19a91e1c60878a");
  assert.equal(templateVersionHash(RETIRED_ES_A.text), RETIRED_ES_A.template_version_id);
  assert.equal(RETIRED_EN_A.retired_reason, "blocked_by_textgrid_content_filter");
  assert.equal(Object.isFrozen(RETIRED_EN_A), true);
});

test("retired _B bodies and hashes remain immutable (pre-merge, never dispatched)", () => {
  assert.equal(RETIRED_EN_B.template_version_id, "sha1:e4155461576c931c10d0bfda16869f49275ef2ad");
  assert.equal(templateVersionHash(RETIRED_EN_B.text), RETIRED_EN_B.template_version_id);
  assert.equal(RETIRED_ES_B.template_version_id, "sha1:02e98547c194450828d7efcd1605b007ae1bf733");
  assert.equal(templateVersionHash(RETIRED_ES_B.text), RETIRED_ES_B.template_version_id);
  assert.equal(RETIRED_EN_B.retired_reason, "pre_merge_selling_blocked_by_textgrid_policy");
  assert.match(RETIRED_EN_B.text, /consider selling/i);
});

test("active _C is distinct from retired _A and _B in both languages", () => {
  assert.equal(LIVE_EN.variant_id, "ownership_interest_combo_v1_en_C");
  assert.equal(LIVE_ES.variant_id, "ownership_interest_combo_v1_es_C");
  for (const retired of [RETIRED_EN_A, RETIRED_EN_B, RETIRED_ES_A, RETIRED_ES_B]) {
    assert.notEqual(templateVersionHash(LIVE_EN.text), retired.template_version_id);
    assert.notEqual(templateVersionHash(LIVE_ES.text), retired.template_version_id);
  }
});

// ── Proposal-only copy requirements ─────────────────────────────────────────
test("active copy uses proposal-only language and excludes prohibited terms", () => {
  for (const pattern of EN_PROHIBITED) {
    assert.doesNotMatch(LIVE_EN.text, pattern, `EN template must not match ${pattern}`);
  }
  for (const pattern of ES_PROHIBITED) {
    assert.doesNotMatch(LIVE_ES.text, pattern, `ES template must not match ${pattern}`);
  }
  assert.match(LIVE_EN.text, /\bown\b/i);
  assert.match(LIVE_EN.text, /\bproposal\b/i);
  assert.match(LIVE_EN.text, /\bproperty\b/i);
  assert.match(LIVE_ES.text, /dueño/i);
  assert.match(LIVE_ES.text, /propuesta/i);
  assert.match(LIVE_ES.text, /propiedad/i);
  assert.doesNotMatch(LIVE_EN.text, /LLC|Inc\b|Realty|Properties|Homes\b|Group\b/i);
});

test("English and Spanish _C revisions are parity twins (same token set)", () => {
  assert.deepEqual(templateTokens(LIVE_EN.text), templateTokens(LIVE_ES.text));
  assert.deepEqual(templateTokens(LIVE_EN.text), ["agent_first_name", "property_address", "seller_first_name"]);
});

test("rendered English canary copy is exact, resolved, and fits one GSM segment", () => {
  const draft = resolveOwnershipInterestComboDraft({
    language: "English",
    context: {
      seller_first_name: "Ryan",
      agent_first_name: "Scott",
      property_address: "4157 Pillsbury Ave S Unit B",
    },
    recipientPhone: CANARY_PHONE_B,
    activatedOverride: true,
  });
  assert.equal(draft.ok, true, draft?.reason);
  assert.equal(
    draft.text,
    "Hi Ryan, this is Scott. Do you still own 4157 Pillsbury Ave S Unit B? I'm reaching out about a proposal for the property."
  );
  assert.doesNotMatch(draft.text, /\{\{[^}]+\}\}/);
  assert.ok(draft.text.length <= 160, `one GSM segment, got ${draft.text.length}`);
  for (const pattern of EN_PROHIBITED) {
    assert.doesNotMatch(draft.text, pattern);
  }
});

test("missing property_address fails closed instead of shipping an unresolved placeholder", () => {
  const draft = resolveOwnershipInterestComboDraft({
    language: "English",
    context: { seller_first_name: "Ryan", agent_first_name: "Scott" },
    recipientPhone: CANARY_PHONE_B,
    activatedOverride: true,
  });
  assert.equal(draft.ok, false);
  assert.equal(draft.blocked, true);
});

// ── Canary recipient contract ─────────────────────────────────────────────────
test("canary proof uses +16128072000, not the retired failed recipient", () => {
  assert.equal(assignVariantDeterministic(OWNERSHIP_EXPERIMENT_ID, CANARY_PHONE_B), "B");
  const built = buildInternalCanaryFirstTouch(canaryBuildArgs());
  assert.equal(built.ok, true, built.reason);
  assert.equal(built.queue_row.to_phone_number, CANARY_PHONE_B);
  assert.equal(built.queue_row.thread_key, CANARY_PHONE_B);
  assert.notEqual(built.queue_row.to_phone_number, RETIRED_FAILED_RECIPIENT);

  const blockedOld = buildInternalCanaryFirstTouch(
    canaryBuildArgs({ recipientPhone: RETIRED_FAILED_RECIPIENT })
  );
  // Old recipient is still allowlisted for other proofs, but this canary fixture
  // must target the new phone — verify the fixture default is not the old one.
  assert.equal(blockedOld.queue_row.to_phone_number, RETIRED_FAILED_RECIPIENT);
  assert.notEqual(blockedOld.queue_row.to_phone_number, CANARY_PHONE_B);
});

// ── Experiment contract is unchanged by the wording update ──────────────────
test("attribution changes only because the copy changed (_B retired → _C active)", () => {
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
  const retired_b_attribution = buildOutboundTemplateAttribution({
    ...shared,
    template: {
      template_id: RETIRED_EN_B.variant_id,
      template_body: RETIRED_EN_B.text,
      use_case: "ownership_check",
      stage_code: "S1",
      language: "English",
    },
  });
  const active_attribution = buildOutboundTemplateAttribution({
    ...shared,
    template: {
      template_id: LIVE_EN.variant_id,
      template_body: LIVE_EN.text,
      use_case: "ownership_check",
      stage_code: "S1",
      language: "English",
    },
  });

  assert.notEqual(active_attribution.template_id, retired_b_attribution.template_id);
  assert.notEqual(active_attribution.template_version_id, retired_b_attribution.template_version_id);
  const invariant_keys = Object.keys(retired_b_attribution).filter(
    (k) => !["template_id", "template_version_id"].includes(k)
  );
  for (const key of invariant_keys) {
    assert.deepEqual(active_attribution[key], retired_b_attribution[key], `attribution.${key} must not move`);
  }
});

test("canary contract invariants: sticky B, S1 entry, null followup_intent, 3-day no-reply cadence", () => {
  for (let i = 0; i < 3; i += 1) {
    assert.equal(assignVariantDeterministic(OWNERSHIP_EXPERIMENT_ID, CANARY_PHONE_B), "B");
  }

  const built = buildInternalCanaryFirstTouch(canaryBuildArgs());
  assert.equal(built.ok, true, built.reason);
  assert.equal(built.attribution.experiment_id, "ownership_first_touch_ab_v1");
  assert.equal(built.attribution.experiment_variant_id, "ownership_interest_combo_B");
  assert.equal(built.attribution.template_id, "ownership_interest_combo_v1_en_C");
  assert.equal(built.attribution.template_version_id, templateVersionHash(LIVE_EN.text));
  assert.equal(built.queue_row.stage_before, "ownership_confirmation");
  assert.equal(built.queue_row.metadata.automation_provenance.followup_intent, null);

  assert.equal(OWNERSHIP_INTEREST_COMBO_CANONICAL.starting_stage, "ownership_confirmation");
  assert.equal(OWNERSHIP_INTEREST_COMBO_CANONICAL.advances_to_stage, "offer_interest");
  assert.equal(OWNERSHIP_INTEREST_COMBO_CANONICAL.merges_stages, false);

  const { policy } = resolveFollowUpPolicyForStage("ownership_confirmation");
  assert.equal(policy.enabled, true);
  assert.equal(policy.no_reply_delay_days, 3);
});