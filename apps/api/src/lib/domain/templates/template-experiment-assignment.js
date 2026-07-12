// ─── template-experiment-assignment.js ───────────────────────────────────────
// Deterministic, sticky A/B assignment for the internal-only ownership
// experiment (activation spec Mission 6). Assignment is a pure hash of
// (experiment_id, thread_key) so the same conversation ALWAYS resolves to the
// same variant — no mid-conversation switching, and no state required to be
// sticky. The result is recorded on the outbound attribution BEFORE the send,
// tying the variant to an immutable template version.
//
// Dormant + internal-only: resolveExperimentAssignment returns null unless the
// experiment is explicitly active AND the recipient is an approved internal
// canary phone. Nothing here activates in production or sends.

import { createHash } from "node:crypto";

import { isInternalTestPhone } from "@/lib/config/internal-phones.js";
import {
  OWNERSHIP_INTEREST_COMBO_EXPERIMENT,
  OWNERSHIP_INTEREST_COMBO_EXPERIMENT_KEY,
} from "@/lib/domain/templates/ownership-interest-combo-experiment.js";

export const OWNERSHIP_EXPERIMENT_ID = "ownership_first_touch_ab_v1";

// Variant A = ownership-only (existing Stage 1 ownership_check).
// Variant B = ownership + soft offer interest (ownership_interest_combo_v1).
export const OWNERSHIP_EXPERIMENT_VARIANTS = Object.freeze({
  A: Object.freeze({ variant_id: "ownership_only_A", template_key: "ownership_check", arm: "control" }),
  B: Object.freeze({
    variant_id: "ownership_interest_combo_B",
    template_key: OWNERSHIP_INTEREST_COMBO_EXPERIMENT_KEY,
    arm: "combo",
  }),
});

function clean(value) {
  return String(value ?? "").trim();
}

function isExperimentActivated(env = process.env) {
  const raw = clean(env?.OWNERSHIP_INTEREST_COMBO_EXPERIMENT).toLowerCase();
  return raw === "1" || raw === "true" || raw === "internal_only";
}

/**
 * Deterministic sticky bucket: sha256(experiment_id | thread_key) → A|B by the
 * first byte's parity. Pure — identical inputs always yield the same variant,
 * so an assignment never changes across the life of a conversation.
 */
export function assignVariantDeterministic(experimentId, threadKey) {
  const seed = `${clean(experimentId)}|${clean(threadKey)}`;
  const digest = createHash("sha256").update(seed).digest();
  return digest[0] % 2 === 0 ? "A" : "B";
}

/**
 * Resolve the sticky experiment assignment for a thread. Fails closed:
 *   - experiment not activated → null (dormant; production never activates it)
 *   - non-internal phone       → null (internal canary only)
 * Returns a record suitable to stamp onto outbound attribution BEFORE the send.
 *
 * @returns {null | { experiment_id, variant, variant_id, template_key, arm, assignment_source, is_internal_only, assigned_at }}
 */
export function resolveExperimentAssignment({
  threadKey = null,
  recipientPhone = null,
  now = new Date().toISOString(),
  env = process.env,
  activatedOverride = null, // tests inject true; production leaves null
} = {}) {
  const activated =
    activatedOverride === true ? true : activatedOverride === false ? false : isExperimentActivated(env);
  if (!activated) return null;

  const phone = clean(recipientPhone) || clean(threadKey);
  if (!isInternalTestPhone(phone)) return null;

  const key = clean(threadKey) || phone;
  const variant = assignVariantDeterministic(OWNERSHIP_EXPERIMENT_ID, key);
  const meta = OWNERSHIP_EXPERIMENT_VARIANTS[variant];

  return {
    experiment_id: OWNERSHIP_EXPERIMENT_ID,
    variant,
    variant_id: meta.variant_id,
    template_key: meta.template_key,
    arm: meta.arm,
    assignment_source: "deterministic_hash",
    is_internal_only: true,
    experiment_status: OWNERSHIP_INTEREST_COMBO_EXPERIMENT.status, // "draft"
    assigned_at: now,
  };
}

export default resolveExperimentAssignment;
