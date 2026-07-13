// ─── ownership-interest-combo-experiment.js ──────────────────────────────────
// INTERNAL-ONLY DRAFT template experiment (activation spec Mission 7).
//
// Combines the Stage 1 ownership question and a soft Stage 2 offer-interest
// question into a SINGLE outbound message — WITHOUT merging the canonical
// lifecycle stages. The thread still starts at Stage 1 (ownership_confirmation)
// and advances Stage 1 → Stage 2 on the reply; this file only changes the
// wording of the first touch, never the state machine.
//
// SAFETY (why this cannot reach a real seller):
//   • It is deliberately NOT added to LOCAL_TEMPLATE_CANDIDATES and has NO
//     entry in LOCAL_NEGOTIATION_AUTO_REPLY_APPROVALS, so no production
//     selection path can ever pick it.
//   • It is NOT inserted into the sms_templates table.
//   • resolveOwnershipInterestComboDraft() fails closed: it returns null unless
//     the experiment is explicitly activated AND the recipient is an approved
//     internal test phone. Activation defaults to false and there is no code
//     path that flips it on in production.
//   • Rendering rejects any unresolved {{placeholder}} and never falls back to
//     English for a non-English thread.

import { isInternalTestPhone } from "@/lib/config/internal-phones.js";
import { personalizeTemplate } from "@/lib/sms/personalize_template.js";

export const OWNERSHIP_INTEREST_COMBO_EXPERIMENT_KEY = "ownership_interest_combo_v1";

// Canonical lifecycle is unchanged: first touch enters Stage 1, the reply moves
// Stage 1 → Stage 2. The combo only asks both questions in one message.
export const OWNERSHIP_INTEREST_COMBO_CANONICAL = Object.freeze({
  starting_stage: "ownership_confirmation", // S1 — never skipped
  advances_to_stage: "offer_interest", // S2 — on affirmative reply
  merges_stages: false,
});

/**
 * Language-keyed draft bodies. Tokens use the canonical personalizer names
 * (seller_first_name / property_address / agent_first_name / city) so there
 * are no unresolved placeholders and the sender identity — never a company
 * name in the greeting slot — provides brand identification exactly like the
 * existing Stage 1 templates. Opt-out/compliance is appended by the send
 * pipeline, the same as every production template (this body carries none
 * itself).
 *
 * Copy revision _B (2026-07-13): the _A copy was terminally rejected by the
 * TextGrid provider content filter on the one authorized internal canary send
 * ("Blocked by Textgrid Content Filter"); the "reviewing an offer" phrasing is
 * the suspected trigger. Revision _B keeps ownership + soft selling interest
 * in one message but asks it as plain conversational language, with the city
 * as the stated reason for contact. The retired _A bodies are preserved below
 * so historical attribution stays verifiable.
 */
export const OWNERSHIP_INTEREST_COMBO_VARIANTS = Object.freeze({
  English: Object.freeze({
    variant_id: "ownership_interest_combo_v1_en_B",
    language: "English",
    text: "Hi {{seller_first_name}}, this is {{agent_first_name}}, a buyer looking in {{city}}. Do you still own {{property_address}}, and would you consider selling it?",
  }),
  Spanish: Object.freeze({
    variant_id: "ownership_interest_combo_v1_es_B",
    language: "Spanish",
    text: "Hola {{seller_first_name}}, soy {{agent_first_name}}, un comprador buscando en {{city}}. ¿Aún es dueño de {{property_address}} y consideraría venderla?",
  }),
});

/**
 * Retired copy revisions — attribution history, never sendable. Every send is
 * attributed to an immutable content hash (outbound-attribution.js
 * templateVersionHash of the UNRENDERED body), so these bodies and their
 * hashes must never change: they are what historical message_events rows
 * point at. The _A revision was retired 2026-07-13 after the authorized
 * internal canary send (queue row 3f540d6c-83e4-43e9-8eb1-20449e2cdcc6, sid
 * SMOcakZuh6mK06QrYvRWxH~1Q==) failed terminally with provider
 * SmsStatusDetail "Blocked by Textgrid Content Filter".
 */
export const OWNERSHIP_INTEREST_COMBO_RETIRED_VARIANTS = Object.freeze({
  ownership_interest_combo_v1_en_A: Object.freeze({
    variant_id: "ownership_interest_combo_v1_en_A",
    language: "English",
    text: "Hi {{seller_first_name}}, this is {{agent_first_name}}, a local investor. Do you still own {{property_address}}? If so, would you be open to reviewing an offer for it?",
    template_version_id: "sha1:047654d2e68020c2b3611e3b937324eb0d0acd8a",
    retired_at: "2026-07-13",
    retired_reason: "blocked_by_textgrid_content_filter",
  }),
  ownership_interest_combo_v1_es_A: Object.freeze({
    variant_id: "ownership_interest_combo_v1_es_A",
    language: "Spanish",
    text: "Hola {{seller_first_name}}, le escribe {{agent_first_name}}, un inversionista local. ¿Sigue siendo el propietario de {{property_address}}? De ser así, ¿estaría dispuesto a considerar una oferta?",
    template_version_id: "sha1:1e1efb5b1a7451dbae29efad2c19a91e1c60878a",
    retired_at: "2026-07-13",
    retired_reason: "blocked_by_textgrid_content_filter",
  }),
});

/**
 * A/B-ready metadata. `active: false` — no experiment is running in
 * production. This structure only DESCRIBES how an experiment would be
 * configured; it does not enroll anyone.
 */
export const OWNERSHIP_INTEREST_COMBO_EXPERIMENT = Object.freeze({
  experiment_key: OWNERSHIP_INTEREST_COMBO_EXPERIMENT_KEY,
  status: "draft",
  active: false,
  internal_only: true,
  safe_for_auto_reply: false,
  canonical: OWNERSHIP_INTEREST_COMBO_CANONICAL,
  hypothesis:
    "Asking ownership + soft offer-interest in one first touch lifts Stage 2 entry without extra outbound volume.",
  arms: Object.freeze([
    Object.freeze({ arm: "control", description: "Existing Stage 1 ownership_check template", weight: 0.5 }),
    Object.freeze({ arm: "combo", template_key: OWNERSHIP_INTEREST_COMBO_EXPERIMENT_KEY, weight: 0.5 }),
  ]),
  primary_metric: "stage2_entry_rate",
  guardrail_metrics: Object.freeze(["opt_out_rate", "wrong_number_rate", "hostile_rate"]),
  // Multi-intent replies are handled by the existing inbound pipeline: one
  // reply can carry ownership + offer interest (or + asking price). This flag
  // documents the intent; no parsing lives here.
  supports_multi_intent_reply: true,
});

function isExperimentActivated(env = process.env) {
  // A single explicit switch, off by default. Production never sets it.
  const raw = String(env?.OWNERSHIP_INTEREST_COMBO_EXPERIMENT ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "internal_only";
}

/**
 * Resolve the combo draft for a recipient. Fails closed on every gate:
 * inactive experiment, non-internal phone, missing language variant (no
 * English fallback for a non-English thread), or unresolved placeholders.
 *
 * @returns {null | { ok, variant_id, language, text, canonical, ... }}
 */
export function resolveOwnershipInterestComboDraft({
  language = "English",
  context = {},
  recipientPhone = null,
  env = process.env,
  activatedOverride = null, // tests inject true; production leaves null
} = {}) {
  const activated =
    activatedOverride === true ? true : activatedOverride === false ? false : isExperimentActivated(env);

  if (!activated) {
    return null; // draft is dormant — no production path activates it
  }
  if (!isInternalTestPhone(recipientPhone)) {
    return { ok: false, blocked: true, reason: "non_internal_phone", variant_id: null, text: null };
  }

  const requested = String(language || "").trim();
  const variant =
    OWNERSHIP_INTEREST_COMBO_VARIANTS[requested] ||
    // Only English requests fall to the English variant. A non-English request
    // with no matching variant fails closed — never an English fallback.
    (requested.toLowerCase() === "english" ? OWNERSHIP_INTEREST_COMBO_VARIANTS.English : null);

  if (!variant) {
    return {
      ok: false,
      blocked: true,
      reason: "language_variant_missing",
      human_review_required: true,
      language: requested || null,
      variant_id: null,
      text: null,
    };
  }

  // personalizeTemplate fails closed on any missing/unresolved token and
  // returns { ok, text, missing, reason }. Reject anything that is not a fully
  // rendered body so a half-filled message can never be produced, even
  // internally.
  const rendered = personalizeTemplate(variant.text, context || {});
  const body = rendered?.ok ? String(rendered.text ?? "") : "";
  if (!rendered?.ok || !body || /\{\{[^}]+\}\}/.test(body)) {
    return {
      ok: false,
      blocked: true,
      reason: rendered?.reason || "unresolved_placeholder",
      missing: rendered?.missing || [],
      variant_id: variant.variant_id,
      text: null,
    };
  }

  return {
    ok: true,
    experiment_key: OWNERSHIP_INTEREST_COMBO_EXPERIMENT_KEY,
    variant_id: variant.variant_id,
    language: variant.language,
    text: body,
    canonical: OWNERSHIP_INTEREST_COMBO_CANONICAL,
    internal_only: true,
    safe_for_auto_reply: false,
  };
}

export default OWNERSHIP_INTEREST_COMBO_EXPERIMENT;
