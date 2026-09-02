// ─── policy-manifest.js ─────────────────────────────────────────────────────
// THE versioned policy layer (supersprint §15).
//
// ~53 exported *_VERSION constants lived in their own modules with nothing
// collecting them, so a persisted decision could not say which policies were in
// force when it was made. This manifest imports the DECISION-RELEVANT versions
// (never re-declares them, so it cannot drift from the code) into one frozen,
// fingerprinted object that is stamped onto every decision-ledger row.
//
// "WHY DID THE SYSTEM DO THIS ON SEPTEMBER 1?" is answered by the ledger row's
// policy_versions + policy_fingerprint, independent of whatever code is
// deployed later.
//
// Pure module: no I/O. Every import below is a version constant from a module
// already on the live inbound path, so this adds no new load and (verified) no
// import cycle with the ledger writer that consumes it.

import crypto from "node:crypto";

import { CLASSIFY_VERSION } from "@/lib/domain/classification/classify.js";
import { ONTOLOGY_VERSION } from "@/lib/domain/classification/inbound-intent-ontology.js";
import { CONTEXT_VERSION } from "@/lib/domain/classification/conversation-context.js";
import { TRANSITION_RESOLVER_VERSION } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { STAGE_REGISTRY_VERSION } from "@/lib/domain/lead-state/seller-lifecycle-stage-registry.js";
import { LATEST_INTENT_PRECEDENCE_VERSION } from "@/lib/domain/seller-flow/latest-intent-precedence.js";
import { NEGOTIATION_STATE_VERSION } from "@/lib/domain/seller-flow/negotiation-state.js";
import { NEGOTIATION_POLICY_VERSION } from "@/lib/domain/seller-flow/negotiation-policy.js";
import { ASSIGNMENT_MARGIN_POLICY_VERSION } from "@/lib/acquisition/assignmentMarginPolicy.js";
import { SELLER_OFFER_POLICY_V1 } from "@/lib/domain/seller-flow/seller-offer-policy.js";
import { FOLLOWUP_POLICY_REGISTRY_VERSION } from "@/lib/domain/seller-flow/followup-policy-registry.js";
import { RETRY_CONTRACT_VERSION } from "@/lib/domain/acquisition/outbound-retry-contract.js";
import { FINALIZE_ACCEPTANCE_VERSION } from "@/lib/domain/seller-flow/finalize-seller-acceptance.js";
import { CONTACT_WINDOW_POLICY_VERSION } from "@/lib/domain/campaigns/contact-window-timezone.js";
import { SELLER_INBOUND_BURST_POLICY_VERSION } from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";
import {
  INBOUND_SUPPRESSION_RULE_VERSION,
  OPERATOR_SUPPRESSION_RULE_VERSION,
} from "@/lib/domain/lead-state/suppression-evidence.js";
import { RESPONSE_STRATEGY_VERSION } from "@/lib/domain/seller-flow/resolve-seller-response-strategy.js";
import { NEXT_BEST_ACTION_VERSION } from "@/lib/domain/seller-flow/resolve-seller-next-best-action.js";
import { TEMPERATURE_MODEL_VERSION } from "@/lib/domain/seller-flow/temperature-signal-model.js";
import { AUTONOMY_INVARIANTS_VERSION } from "@/lib/domain/seller-flow/autonomy-invariants.js";

export const POLICY_MANIFEST_VERSION = "seller_policy_manifest_v1";

/** The domains every manifest MUST cover (the §15 list). */
export const REQUIRED_POLICY_DOMAINS = Object.freeze([
  "classifier",
  "lifecycle",
  "negotiation",
  "offer",
  "margin",
  "followup",
  "contact_window",
  "retry",
  "acceptance",
  "suppression",
  "burst",
  "response",
  "invariants",
]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Build the manifest from the live version constants. Pure and deterministic:
 * the same code always yields the same manifest and the same fingerprint.
 */
export function buildPolicyManifest() {
  return deepFreeze({
    manifest_version: POLICY_MANIFEST_VERSION,
    classifier: {
      classify: CLASSIFY_VERSION,
      ontology: ONTOLOGY_VERSION,
      conversation_context: CONTEXT_VERSION,
    },
    lifecycle: {
      transition_resolver: TRANSITION_RESOLVER_VERSION,
      stage_registry: STAGE_REGISTRY_VERSION,
      latest_intent_precedence: LATEST_INTENT_PRECEDENCE_VERSION,
      // seller_flow_decision_v1 is an inline literal in buildSellerFlowDecision;
      // mirrored here so the manifest names the decision contract too.
      decision_contract: "seller_flow_decision_v1",
    },
    negotiation: {
      policy: NEGOTIATION_POLICY_VERSION,
      state: NEGOTIATION_STATE_VERSION,
    },
    offer: {
      seller_offer_policy: SELLER_OFFER_POLICY_V1.policy_version,
    },
    margin: {
      assignment_margin_policy: ASSIGNMENT_MARGIN_POLICY_VERSION,
    },
    followup: {
      policy_registry: FOLLOWUP_POLICY_REGISTRY_VERSION,
    },
    contact_window: {
      policy: CONTACT_WINDOW_POLICY_VERSION,
    },
    retry: {
      outbound_retry_contract: RETRY_CONTRACT_VERSION,
    },
    acceptance: {
      finalize_acceptance: FINALIZE_ACCEPTANCE_VERSION,
    },
    suppression: {
      inbound_rule: INBOUND_SUPPRESSION_RULE_VERSION,
      operator_rule: OPERATOR_SUPPRESSION_RULE_VERSION,
    },
    burst: {
      inbound_burst_policy: SELLER_INBOUND_BURST_POLICY_VERSION,
    },
    response: {
      strategy: RESPONSE_STRATEGY_VERSION,
      next_best_action: NEXT_BEST_ACTION_VERSION,
      temperature_model: TEMPERATURE_MODEL_VERSION,
    },
    invariants: {
      autonomy_invariants: AUTONOMY_INVARIANTS_VERSION,
    },
  });
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Compact, order-independent fingerprint of a manifest. */
export function policyManifestFingerprint(manifest = POLICY_MANIFEST) {
  return crypto.createHash("sha256").update(stableStringify(manifest)).digest("hex").slice(0, 32);
}

/** Every required domain present with at least one non-empty version. */
export function validatePolicyManifest(manifest = POLICY_MANIFEST) {
  const missing = REQUIRED_POLICY_DOMAINS.filter((domain) => {
    const block = manifest?.[domain];
    if (!block || typeof block !== "object") return true;
    return !Object.values(block).some((v) => typeof v === "string" && v.trim().length > 0);
  });
  return { ok: missing.length === 0, missing };
}

/** The manifest of record for this process (frozen at module load). */
export const POLICY_MANIFEST = buildPolicyManifest();
export const POLICY_FINGERPRINT = policyManifestFingerprint(POLICY_MANIFEST);

export default POLICY_MANIFEST;
