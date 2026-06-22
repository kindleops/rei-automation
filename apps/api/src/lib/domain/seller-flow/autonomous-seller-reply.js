import { child } from "@/lib/logging/logger.js";
import { personalizeTemplate } from "@/lib/sms/personalize_template.js";
import { executeAutonomousReply } from "./execute-autonomous-reply.js";
import { prepareInboundForWorkflowV2 } from "@/lib/domain/acquisition/legacy-seller-flow-adapter.js";
import { evaluateAutoReplyEligibility } from "@/lib/domain/acquisition/auto-reply-policy.js";
import { normalizeCanonicalUseCase } from "@/lib/domain/templates/template-metadata-normalization.js";
import { selectApprovedTemplateForAutoReply } from "@/lib/domain/templates/template-auto-reply-selector.js";

const logger = child({ module: "domain.seller_flow.autonomous_seller_reply" });

export async function processAutonomousSellerReply({
  inbound_from,
  inbound_to,
  context,
  auto_reply_plan,
  inbound_event_id,
  extra_template_render_overrides = {},
} = {}) {
  logger.info("autonomous_reply.started", {
    inbound_from,
    use_case: auto_reply_plan.selected_use_case,
    stage_code: auto_reply_plan.selected_stage_code,
  });

  const v2Envelope = prepareInboundForWorkflowV2({
    source_event_id: inbound_event_id,
    thread_key: context?.ids?.thread_key || inbound_from,
    phone_e164: inbound_from,
    classify_result: auto_reply_plan.classification,
    use_case: auto_reply_plan.selected_use_case,
    stage: auto_reply_plan.selected_stage_code,
    master_owner_id: context?.ids?.master_owner_id,
    property_id: context?.ids?.property_id,
  });

  if (!v2Envelope.ok) {
    return { ok: false, reason: v2Envelope.reason };
  }

  const use_case = normalizeCanonicalUseCase(auto_reply_plan.selected_use_case);
  const language = auto_reply_plan.detected_language || v2Envelope.canonical_event.language || null;

  const templateResult = await selectApprovedTemplateForAutoReply({
    use_case,
    language,
    stage_code: auto_reply_plan.selected_stage_code,
    touch_number: 1,
    supabase: context?.supabase,
  });

  const eligibility = evaluateAutoReplyEligibility({
    classification: auto_reply_plan.classification || {},
    template: templateResult.template,
    use_case,
    context: {
      language,
      missing_template: !templateResult.ok,
      merge_variables: {
        seller_first_name: context?.summary?.seller_first_name,
        agent_first_name: context?.summary?.agent_name,
        property_address: context?.summary?.property_address,
      },
    },
  });

  if (!eligibility.ok) {
    logger.warn("autonomous_reply.human_review_required", {
      reason: eligibility.reason,
      use_case,
      language,
    });
    return { ok: false, reason: eligibility.reason, action: "human_review" };
  }

  const resolution = {
    resolved: true,
    template_text: templateResult.template?.template_body,
    template_id: templateResult.template?.template_id || templateResult.template?.id,
  };

  if (!resolution.template_text) {
    return { ok: false, reason: "template_not_found", action: "human_review" };
  }

  // 2. Personalize Template
  const personalization_context = {
    seller_first_name: context?.summary?.seller_first_name || "",
    agent_name: context?.summary?.agent_name || "",
    property_address: context?.summary?.property_address || "",
    property_city: context?.summary?.property_city || "",
    city: context?.summary?.property_city || "",
    ...extra_template_render_overrides,
  };

  const render = personalizeTemplate(resolution.template_text, personalization_context);
  
  if (!render.ok) {
    logger.warn("autonomous_reply.personalization_failed", {
      template_id: resolution.template_id,
      missing: render.missing,
      reason: render.reason,
    });
    return { ok: false, reason: "personalization_failed", missing: render.missing };
  }

  // Determine message type from use case / stage
  let message_type = "auto_reply";
  const use_case = auto_reply_plan.selected_use_case;
  if (use_case === "selling_interest") message_type = "stage_1_auto_reply";
  else if (use_case === "price_or_offer") message_type = "stage_2_auto_reply";
  else if (use_case === "seller_price_received") message_type = "stage_3_auto_reply";

  // 3. Dispatch Immediately
  const dispatch_result = await executeAutonomousReply({
    thread_key: context?.ids?.thread_key || inbound_from,
    to_phone_number: inbound_from,
    from_phone_number: inbound_to,
    message_body: render.text,
    template_id: resolution.template_id,
    source_event_id: inbound_event_id,
    stage: auto_reply_plan.selected_stage_code || use_case,
    message_type,
    use_case,
    master_owner_id: context?.ids?.master_owner_id,
    property_id: context?.ids?.property_id,
  });

  return {
    ...dispatch_result,
    rendered_text: render.text,
    template_id: resolution.template_id,
  };
}
