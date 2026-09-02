import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPolicyManifest,
  policyManifestFingerprint,
  validatePolicyManifest,
  POLICY_MANIFEST,
  POLICY_FINGERPRINT,
  POLICY_MANIFEST_VERSION,
  REQUIRED_POLICY_DOMAINS,
} from "@/lib/domain/seller-flow/policy-manifest.js";
import { TRANSITION_RESOLVER_VERSION } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { NEGOTIATION_POLICY_VERSION } from "@/lib/domain/seller-flow/negotiation-policy.js";
import { ASSIGNMENT_MARGIN_POLICY_VERSION } from "@/lib/acquisition/assignmentMarginPolicy.js";
import { SELLER_OFFER_POLICY_V1 } from "@/lib/domain/seller-flow/seller-offer-policy.js";
import { FOLLOWUP_POLICY_REGISTRY_VERSION } from "@/lib/domain/seller-flow/followup-policy-registry.js";
import { CONTACT_WINDOW_POLICY_VERSION } from "@/lib/domain/campaigns/contact-window-timezone.js";
import { CLASSIFY_VERSION } from "@/lib/domain/classification/classify.js";
import {
  deriveDecisionInputFromSnapshot,
  buildDecisionLedgerRow,
} from "@/lib/domain/seller-flow/record-seller-automation-decision.js";

// THE versioned policy layer (§15). The manifest IMPORTS the live version
// constants (never re-declares them) so it cannot drift from the code, and the
// ledger stamps it onto every decision so "why did the system do this on date
// X" is answerable independent of later deployments.

test("the manifest covers every required policy domain", () => {
  const v = validatePolicyManifest(POLICY_MANIFEST);
  assert.equal(v.ok, true, `missing domains: ${v.missing.join(",")}`);
  for (const domain of REQUIRED_POLICY_DOMAINS) assert.ok(POLICY_MANIFEST[domain], domain);
  assert.equal(POLICY_MANIFEST.manifest_version, POLICY_MANIFEST_VERSION);
});

test("manifest values ARE the live constants (no drift possible)", () => {
  assert.equal(POLICY_MANIFEST.lifecycle.transition_resolver, TRANSITION_RESOLVER_VERSION);
  assert.equal(POLICY_MANIFEST.negotiation.policy, NEGOTIATION_POLICY_VERSION);
  assert.equal(POLICY_MANIFEST.margin.assignment_margin_policy, ASSIGNMENT_MARGIN_POLICY_VERSION);
  assert.equal(POLICY_MANIFEST.offer.seller_offer_policy, SELLER_OFFER_POLICY_V1.policy_version);
  assert.equal(POLICY_MANIFEST.followup.policy_registry, FOLLOWUP_POLICY_REGISTRY_VERSION);
  assert.equal(POLICY_MANIFEST.contact_window.policy, CONTACT_WINDOW_POLICY_VERSION);
  assert.equal(POLICY_MANIFEST.classifier.classify, CLASSIFY_VERSION);
});

test("the manifest is deterministic, frozen, and fingerprinted", () => {
  const a = buildPolicyManifest();
  const b = buildPolicyManifest();
  assert.deepEqual(a, b);
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.negotiation));
  assert.equal(policyManifestFingerprint(a), policyManifestFingerprint(b));
  assert.equal(policyManifestFingerprint(POLICY_MANIFEST), POLICY_FINGERPRINT);
  assert.match(POLICY_FINGERPRINT, /^[0-9a-f]{32}$/);
});

test("a changed policy version changes the fingerprint; key order does not", () => {
  const base = buildPolicyManifest();
  const changed = { ...base, negotiation: { ...base.negotiation, policy: "negotiation_policy_v99" } };
  assert.notEqual(policyManifestFingerprint(changed), policyManifestFingerprint(base));
  // same content, different key order -> same fingerprint (order-independent)
  const reordered = Object.fromEntries(Object.entries(base).reverse());
  assert.equal(policyManifestFingerprint(reordered), policyManifestFingerprint(base));
});

test("a manifest missing a domain fails validation", () => {
  const broken = { ...buildPolicyManifest(), retry: {} };
  const v = validatePolicyManifest(broken);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ["retry"]);
});

test("every decision-ledger row derived from a snapshot carries the full manifest + fingerprint", () => {
  const input = deriveDecisionInputFromSnapshot({
    source_event_id: "evt-policy-1",
    source_thread_key: "+15550100123",
    canonical_intent: "seller_interested",
    universal_stage: "offer_interest",
    decision_version: "inbound_intelligence_v4_three_layer",
    canonical_decision: { stage_before: "ownership_confirmation", stage_after: "offer_interest" },
  });
  const row = buildDecisionLedgerRow(input);
  assert.deepEqual(row.policy_versions, POLICY_MANIFEST);
  assert.equal(row.lineage.policy_fingerprint, POLICY_FINGERPRINT);
  assert.equal(validatePolicyManifest(row.policy_versions).ok, true);
  // the ledger's own version is separate from the intelligence decision version
  assert.equal(row.decision_version, "inbound_intelligence_v4_three_layer");
});
