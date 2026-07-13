// ─── build-internal-canary-first-touch.js ────────────────────────────────────
// Pure builder for the ONE authorized internal Stage 1 canary first touch.
// Composes — but NEVER inserts or sends — the canonical send_queue payload for
// an approved internal test phone, so the full contract (template identity,
// immutable version, sticky experiment assignment, linkage, quarantine
// markers, stage-layer follow-up derivation inputs) is provable in tests and
// reviewable before any operator-authorized execution.
//
// Fail-closed on every gate: non-internal recipient, dormant experiment,
// missing language variant, unresolved placeholders, or an attribution block
// that is not dispatchable. The produced row is quarantined by construction:
// source/metadata markers + the recipient being in the internal registry mean
// feeder selection, queue-runner live sends, and KPI aggregation all exclude
// it (see internal-phones.js isInternalCanaryFactRow) while the queue-run
// proof mode / scoped canary path can still execute it explicitly.

import {
  isInternalTestPhone,
  INTERNAL_CANARY_SOURCE,
} from "@/lib/config/internal-phones.js";
import { personalizeTemplate } from "@/lib/sms/personalize_template.js";
import {
  buildOutboundTemplateAttribution,
  isDispatchableAttribution,
} from "@/lib/domain/templates/outbound-attribution.js";
import { resolveExperimentAssignment } from "@/lib/domain/templates/template-experiment-assignment.js";
import {
  resolveOwnershipInterestComboDraft,
  OWNERSHIP_INTEREST_COMBO_VARIANTS,
} from "@/lib/domain/templates/ownership-interest-combo-experiment.js";

const STAGE1_USE_CASE = "ownership_check";
const STAGE1_STAGE_CODE = "S1";
const STAGE1_LIFECYCLE_STAGE = "ownership_confirmation";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Build the internal canary Stage 1 first-touch queue-row payload.
 * Pure — no IO. Returns { ok, reason?, assignment, attribution, queue_row }.
 */
export function buildInternalCanaryFirstTouch({
  recipientPhone = null,
  threadKey = null,
  senderNumber = null,
  textgridNumberId = null,
  masterOwnerId = null,
  prospectId = null,
  propertyId = null,
  sellerFirstName = null,
  agentFirstName = null,
  agentName = null,
  propertyAddress = null,
  city = null,
  market = null,
  language = "English",
  controlTemplate = null, // catalog ownership_check row (required for arm A)
  env = process.env,
  activatedOverride = null, // tests inject true; production leaves null
  now = new Date().toISOString(),
} = {}) {
  const recipient = clean(recipientPhone);
  const thread_key = clean(threadKey) || recipient;

  if (!isInternalTestPhone(recipient)) {
    return { ok: false, reason: "non_internal_phone" };
  }
  for (const [field, value] of [
    ["senderNumber", senderNumber],
    ["textgridNumberId", textgridNumberId],
    ["masterOwnerId", masterOwnerId],
    ["prospectId", prospectId],
    ["propertyId", propertyId],
    ["sellerFirstName", sellerFirstName],
    ["agentFirstName", agentFirstName || agentName],
    ["propertyAddress", propertyAddress],
  ]) {
    if (!clean(value)) return { ok: false, reason: `missing_${field}` };
  }

  // Sticky, deterministic experiment assignment — resolved BEFORE the send
  // and stamped onto attribution. Fails closed when dormant or non-internal.
  const assignment = resolveExperimentAssignment({
    threadKey: thread_key,
    recipientPhone: recipient,
    env,
    activatedOverride,
    now,
  });
  if (!assignment) {
    return { ok: false, reason: "experiment_not_activated" };
  }

  const personalization = {
    seller_first_name: clean(sellerFirstName),
    first_name: clean(sellerFirstName),
    agent_first_name: clean(agentFirstName || agentName),
    agent_name: clean(agentName || agentFirstName),
    property_address: clean(propertyAddress),
    city: clean(city) || null,
  };

  let template = null;
  let rendered_message = null;

  if (assignment.variant === "B") {
    const draft = resolveOwnershipInterestComboDraft({
      language,
      context: personalization,
      recipientPhone: recipient,
      env,
      activatedOverride,
    });
    if (!draft || draft.ok !== true) {
      return { ok: false, reason: draft?.reason || "combo_draft_unavailable", draft };
    }
    const variant_source = OWNERSHIP_INTEREST_COMBO_VARIANTS[draft.language];
    template = {
      template_id: draft.variant_id,
      // Immutable version hashes the UNRENDERED variant body so every send of
      // this variant shares one version id regardless of personalization.
      template_body: variant_source?.text || null,
      use_case: STAGE1_USE_CASE,
      stage_code: STAGE1_STAGE_CODE,
      language: draft.language,
    };
    rendered_message = draft.text;
  } else {
    if (!controlTemplate || !clean(controlTemplate.template_body)) {
      return { ok: false, reason: "control_template_required" };
    }
    const rendered = personalizeTemplate(controlTemplate.template_body, personalization);
    if (!rendered?.ok || !clean(rendered.text) || /\{\{[^}]+\}\}/.test(rendered.text)) {
      return { ok: false, reason: rendered?.reason || "control_render_failed" };
    }
    template = {
      template_id: clean(controlTemplate.template_id || controlTemplate.id),
      template_body: controlTemplate.template_body,
      use_case: clean(controlTemplate.use_case) || STAGE1_USE_CASE,
      stage_code: clean(controlTemplate.stage_code) || STAGE1_STAGE_CODE,
      language: clean(controlTemplate.language) || language,
    };
    rendered_message = rendered.text;
  }

  const attribution = buildOutboundTemplateAttribution({
    template,
    templateKey: assignment.template_key,
    stage: STAGE1_STAGE_CODE,
    classifiedOutcome: null, // first touch: the seller has said nothing yet
    language: template.language,
    experiment: {
      experiment_id: assignment.experiment_id,
      variant_id: assignment.variant_id,
    },
    touchNumber: 1,
    parentOutboundEventId: null,
    automationOrigin: "internal_canary_first_touch",
  });
  if (!isDispatchableAttribution(attribution)) {
    return { ok: false, reason: "attribution_not_dispatchable", attribution };
  }

  const canary_key = `internal-canary:first-touch:${thread_key}`;

  const queue_row = {
    queue_key: canary_key,
    queue_id: canary_key,
    dedupe_key: canary_key,
    thread_key,
    to_phone_number: recipient,
    from_phone_number: clean(senderNumber),
    textgrid_number_id: clean(textgridNumberId),
    type: "outbound",
    source: INTERNAL_CANARY_SOURCE,
    // Held, not queued: flipping to "queued" is the explicit act of the
    // authorized canary executor. The queue runner ALSO refuses live sends to
    // internal phones without proof authority (defense at the send boundary).
    queue_status: "held",
    held_at: now,
    scheduled_for: now,
    message_type: STAGE1_USE_CASE,
    use_case_template: STAGE1_USE_CASE,
    template_id: attribution.template_id,
    selected_template_id: attribution.template_id,
    template_key: attribution.template_key,
    stage_before: STAGE1_LIFECYCLE_STAGE,
    touch_number: 1,
    language: template.language,
    seller_first_name: clean(sellerFirstName),
    agent_name: clean(agentName || agentFirstName),
    property_address: clean(propertyAddress),
    market: clean(market) || null,
    master_owner_id: clean(masterOwnerId),
    prospect_id: clean(prospectId),
    property_id: clean(propertyId),
    message_body: rendered_message,
    message_text: rendered_message,
    rendered_message,
    metadata: {
      // Canonical quarantine markers (internal-phones.js contract) plus the
      // queue-runner's recognized proof vocabulary (queue-run-request.js
      // isProofOrInternalQueueRow): internal_test_phone authorizes an
      // EXPLICITLY targeted canary execution; exclude_from_kpis keeps the row
      // out of KPI aggregation.
      internal_canary: true,
      internal_test_phone: true,
      exclude_from_kpis: true,
      proof_run: true,
      no_public_automation: true,
      source: INTERNAL_CANARY_SOURCE,
      origin_surface: "internal_canary",
      canary_purpose: "stage1_transport_chain_proof",
      template_use_case: STAGE1_USE_CASE,
      template_language: template.language,
      template_stage_code: STAGE1_STAGE_CODE,
      agent_first_name: clean(agentFirstName || agentName),
      // No followup_intent: the seller has not spoken. The delivery-triggered
      // scheduler derives the Stage 1 no-reply cadence from the stage policy
      // registry via template_use_case (stage_no_reply plan).
      automation_provenance: {
        ...attribution,
        template_use_case: STAGE1_USE_CASE,
        followup_intent: null,
      },
      candidate_snapshot: { routing_tier: 1, touch_number: 1, internal_canary: true },
    },
  };

  return { ok: true, assignment, attribution, rendered_message, queue_row };
}

export default buildInternalCanaryFirstTouch;
