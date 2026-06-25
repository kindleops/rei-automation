import crypto from "node:crypto";

import { classify as defaultClassify } from "@/lib/domain/classification/classify.js";
import {
  getOrCreateAcquisitionContact,
  markOwnershipConfirmed,
  recordInbound,
  recordSellerAskingPrice,
  updateAcquisitionContact,
  updateStage,
  updateTemperature,
} from "@/lib/domain/acquisition/acquisition-contact-service.js";
import { applyComplianceAction } from "@/lib/domain/acquisition/compliance-handler.js";
import { emitAcquisitionEvent } from "@/lib/domain/acquisition/acquisition-event-service.js";
import {
  acquisitionRuntimeDisabled,
  getAcquisitionRuntimeControl,
} from "@/lib/domain/acquisition/acquisition-runtime-control.js";
import {
  ACQUISITION_STAGES,
  normalizeAcquisitionStage,
} from "@/lib/domain/acquisition/acquisition-stage-registry.js";
import {
  cancelPendingNoReplyFollowups,
  scheduleNoReplyFollowup,
} from "@/lib/domain/acquisition/no-reply-followup-scheduler.js";
import { selectAcquisitionTemplate } from "@/lib/domain/acquisition/acquisition-template-service.js";
import { buildThreadStatePatchFromClassification } from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import {
  lookupSafetyPolicy,
  SELLER_FLOW_SAFETY_TIERS,
} from "@/lib/domain/seller-flow/seller-flow-safety-policy.js";
import { extractUnderwritingSignals } from "@/lib/domain/underwriting/extract-underwriting-signals.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { normalizePhone } from "@/lib/utils/phones.js";

const HIGH_CONFIDENCE = 0.82;

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function hardComplianceIntent(message) {
  const text = lower(message);
  if (
    /^(stop|unsubscribe|cancel|end|quit)\b/.test(text) ||
    /\b(do not contact|don't contact|dont contact|stop texting|remove me)\b/.test(text)
  ) {
    return "opt_out";
  }
  if (
    /\b(wrong number|wrong person|not the owner|not my property|never owned|sold it)\b/.test(text)
  ) {
    return "wrong_number";
  }
  if (
    /\b(attorney|lawyer|lawsuit|sue|harassment|fcc|police|legal action|stop harassing)\b/.test(text)
  ) {
    return "hostile";
  }
  return null;
}

function classifierIntent(classification = {}) {
  return lower(
    classification.primary_intent ||
      classification.detected_intent ||
      classification.inbound_intent ||
      classification.objection ||
      "unclear"
  );
}

function stageDecision(stage, rawIntent, signals = {}) {
  const intent = lower(rawIntent);
  if (stage === ACQUISITION_STAGES.OWNERSHIP_CHECK && intent === "ownership_confirmed") {
    return {
      next_stage: ACQUISITION_STAGES.CONSIDER_SELLING,
      policy_stage: "ownership_check",
      policy_intent: "ownership_confirmed",
      use_case: "consider_selling",
      reason: "ownership_confirmed",
    };
  }
  if (
    stage === ACQUISITION_STAGES.CONSIDER_SELLING &&
    ["seller_interested", "latent_interest", "positive_interest", "ownership_confirmed"].includes(intent)
  ) {
    return {
      next_stage: ACQUISITION_STAGES.ASKING_PRICE,
      policy_stage: "consider_selling",
      policy_intent: "ownership_confirmed",
      use_case: "asking_price",
      reason: "seller_open_to_selling",
    };
  }
  if (stage === ACQUISITION_STAGES.CONSIDER_SELLING && intent === "asks_offer") {
    return {
      next_stage: ACQUISITION_STAGES.ASKING_PRICE,
      policy_stage: "consider_selling",
      policy_intent: "asks_offer",
      use_case: "asking_price",
      reason: "seller_requested_offer_before_price",
    };
  }
  if (
    stage === ACQUISITION_STAGES.ASKING_PRICE &&
    (intent === "asking_price_provided" || Number.isFinite(Number(signals.asking_price)))
  ) {
    return {
      next_stage: ACQUISITION_STAGES.CONDITION,
      policy_stage: "asking_price",
      policy_intent: "asking_price_value",
      use_case: "price_high_condition_probe",
      reason: "asking_price_recorded_condition_needed",
    };
  }
  if (stage === ACQUISITION_STAGES.ASKING_PRICE && intent === "asks_offer") {
    return {
      next_stage: ACQUISITION_STAGES.OFFER_NEGOTIATION,
      policy_stage: "asking_price",
      policy_intent: "asks_offer",
      use_case: null,
      reason: "offer_pricing_placeholder",
      placeholder: true,
    };
  }
  if (
    stage === ACQUISITION_STAGES.CONDITION &&
    (intent === "condition_disclosed" || signals.condition_level)
  ) {
    return {
      next_stage: ACQUISITION_STAGES.OFFER_NEGOTIATION,
      policy_stage: "price_high_condition_probe",
      policy_intent: "condition_signal",
      use_case: null,
      reason: "condition_recorded_offer_pricing_placeholder",
      placeholder: true,
    };
  }
  return {
    next_stage: stage,
    policy_stage:
      stage === ACQUISITION_STAGES.CONSIDER_SELLING
        ? ACQUISITION_STAGES.CONSIDER_SELLING
        : stage,
    policy_intent: intent,
    use_case: null,
    reason: "no_stage_transition",
  };
}

function resolvePolicy(decision) {
  // Canonical-aware lookup: policy_intent may carry legacy labels; normalized internally.
  return (
    lookupSafetyPolicy(decision.policy_stage, decision.policy_intent) || {
      next_stage: decision.next_stage,
      template: decision.use_case,
      safety: SELLER_FLOW_SAFETY_TIERS.REVIEW,
    }
  );
}

async function defaultInboxUpdate(context, classification, nextStage, temperature, deps = {}) {
  const threadKey = normalizePhone(
    context.thread_id || context.canonical_e164 || context.phone
  );
  if (!threadKey) return { ok: false, reason: "missing_thread_key" };

  const patch = buildThreadStatePatchFromClassification({
    messageEvent: {
      id: context.message_id,
      provider_message_sid: context.message_id,
      direction: "inbound",
      message_body: context.message_body,
      received_at: context.received_at || deps.now || new Date().toISOString(),
    },
    classification,
  });
  const { error } = await db(deps)
    .from("deal_thread_state")
    .upsert(
      {
        thread_key: threadKey,
        ...patch,
        universal_stage: nextStage,
        lead_temperature: temperature,
      },
      { onConflict: "thread_key" }
    );
  if (error) throw error;
  return { ok: true };
}

export async function dispatchInboundAcquisitionSms(context = {}, metadata = {}, deps = {}) {
  const runtime = await getAcquisitionRuntimeControl("inbound", deps);
  if (!runtime.enabled) return acquisitionRuntimeDisabled(runtime);

  const messageBody = clean(context.message_body ?? context.body ?? metadata.message_body);
  const phone = normalizePhone(
    context.canonical_e164 ?? context.phone ?? context.from ?? context.inbound_from
  );
  if (!phone) return { ok: false, status: 400, error: "inbound_phone_required" };
  if (!messageBody) return { ok: false, status: 400, error: "inbound_message_required" };

  const identity = {
    ...context,
    phone,
    canonical_e164: phone,
    thread_id: clean(context.thread_id) || phone,
    current_stage: normalizeAcquisitionStage(context.current_stage),
  };
  const contactResult = await getOrCreateAcquisitionContact(identity, deps);
  if (!contactResult.ok) return contactResult;
  let contact = contactResult.contact;

  await cancelPendingNoReplyFollowups(
    identity,
    { reason: "seller_replied" },
    deps
  );
  await recordInbound(
    contact.id,
    {
      received_at: metadata.received_at || context.received_at,
      message_id: context.message_id,
    },
    deps
  );

  const hardIntent = hardComplianceIntent(messageBody);
  if (hardIntent) {
    const complianceAction = hardIntent === "hostile" ? "hostile" : hardIntent;
    return applyComplianceAction(
      complianceAction,
      { ...identity, contact_id: contact.id },
      {
        reason: `hard_keyword_${hardIntent}`,
        confidence: 1,
        classifier_output: { primary_intent: hardIntent, source: "hard_keyword_guard" },
        dedupe_key: context.message_id
          ? `acq-compliance:${context.message_id}:${hardIntent}`
          : undefined,
      },
      deps
    );
  }

  const classify = deps.classify || defaultClassify;
  const classification =
    metadata.classification ||
    (await classify(messageBody, metadata.brain_item || null));
  const intent = classifierIntent(classification);
  const confidence = Number(classification.confidence) || 0;

  if (intent === "opt_out") {
    return applyComplianceAction(
      "opt_out",
      { ...identity, contact_id: contact.id },
      { reason: "classifier_opt_out", confidence, classifier_output: classification },
      deps
    );
  }
  if (["wrong_number", "wrong_person"].includes(intent)) {
    return applyComplianceAction(
      "wrong_number",
      { ...identity, contact_id: contact.id },
      { reason: "classifier_wrong_number", confidence, classifier_output: classification },
      deps
    );
  }
  if (intent === "hostile_or_legal") {
    return applyComplianceAction(
      "hostile",
      { ...identity, contact_id: contact.id },
      { reason: "classifier_hostile", confidence, classifier_output: classification },
      deps
    );
  }

  const signalExtractor = deps.extractSignals || extractUnderwritingSignals;
  const extracted = signalExtractor({
    message: messageBody,
    classification,
    route: metadata.route || null,
    context: metadata.conversation_context || context,
  });
  const signals = extracted?.signals || extracted || {};
  const currentStage = normalizeAcquisitionStage(contact.current_stage);
  const decision = stageDecision(currentStage, intent, signals);
  const policy = resolvePolicy(decision);
  const requestedSafetyTier = clean(metadata.safety_tier);
  const policySafetyTier =
    policy.safety === SELLER_FLOW_SAFETY_TIERS.SUPPRESS ||
    requestedSafetyTier === SELLER_FLOW_SAFETY_TIERS.SUPPRESS
      ? SELLER_FLOW_SAFETY_TIERS.SUPPRESS
      : policy.safety === SELLER_FLOW_SAFETY_TIERS.REVIEW ||
          requestedSafetyTier === SELLER_FLOW_SAFETY_TIERS.REVIEW
        ? SELLER_FLOW_SAFETY_TIERS.REVIEW
        : policy.safety;
  const explicitReview =
    metadata.needs_review === true ||
    context.needs_review === true ||
    classification.needs_review === true ||
    metadata.manual_review === true ||
    context.manual_review === true ||
    classification.manual_review === true;
  const safetyTier =
    explicitReview && policySafetyTier === SELLER_FLOW_SAFETY_TIERS.AUTO_SEND
      ? SELLER_FLOW_SAFETY_TIERS.REVIEW
      : policySafetyTier;

  if (intent === "ownership_confirmed") {
    const result = await markOwnershipConfirmed(
      contact.id,
      { confidence, temperature: confidence >= 0.9 ? "hot" : "warm" },
      deps
    );
    contact = result.contact;
  } else if (
    ["seller_interested", "latent_interest", "asking_price_provided", "asks_offer"].includes(intent)
  ) {
    const result = await updateTemperature(
      contact.id,
      confidence >= 0.9 ? "hot" : "warm",
      { reason: intent },
      deps
    );
    contact = result.contact;
  }

  if (Number.isFinite(Number(signals.asking_price)) && Number(signals.asking_price) > 0) {
    const priceResult = await recordSellerAskingPrice(
      contact.id,
      Number(signals.asking_price),
      { source: "inbound_classifier", confidence },
      deps
    );
    contact = priceResult.contact;
  }
  if (signals.condition_level) {
    const conditionResult = await updateAcquisitionContact(
      contact.id,
      {
        condition_summary: clean(
          signals.condition_summary || signals.condition_level
        ),
      },
      deps
    );
    contact = conditionResult.contact;
  }
  if (decision.next_stage !== currentStage) {
    const stageResult = await updateStage(
      contact.id,
      decision.next_stage,
      { reason: decision.reason, classifier_intent: intent },
      deps
    );
    contact = stageResult.contact;
  }

  const shouldReview =
    explicitReview ||
    decision.placeholder ||
    safetyTier !== SELLER_FLOW_SAFETY_TIERS.AUTO_SEND ||
    confidence < HIGH_CONFIDENCE;
  if (shouldReview) {
    const reviewResult = await updateAcquisitionContact(
      contact.id,
      { automation_status: "needs_review" },
      deps
    );
    contact = reviewResult.contact;
  }

  const temperature = contact.contact_temperature || "warm";
  const updateInbox = deps.updateInboxState || defaultInboxUpdate;
  await updateInbox(
    { ...identity, message_body: messageBody },
    classification,
    decision.next_stage,
    temperature,
    deps
  );

  let queueResult = null;
  const allowAutoSend =
    metadata.allow_auto_send !== false &&
    context.auto_reply_enabled !== false &&
    !metadata.response_managed_externally;
  if (!shouldReview && allowAutoSend && decision.use_case) {
    const template = await selectAcquisitionTemplate(
      decision.use_case,
      { ...context, ...contact },
      {},
      deps
    );
    if (template.ok) {
      const insertQueue =
        deps.insertQueueRow ||
        (await import("@/lib/supabase/sms-engine.js")).insertSupabaseSendQueueRow;
      const queueKey = `acq-inbound:${context.message_id || crypto.randomUUID()}:${decision.next_stage}`;
      queueResult = await insertQueue(
        {
          queue_key: queueKey,
          queue_id: queueKey,
          dedupe_key: queueKey,
          queue_status: "queued",
          scheduled_for: deps.now || new Date().toISOString(),
          message_body: template.message_body,
          message_text: template.message_body,
          to_phone_number: phone,
          from_phone_number:
            clean(context.inbound_to || context.to || context.from_phone_number) || null,
          thread_key: contact.thread_id || phone,
          master_owner_id: contact.master_owner_id,
          property_id: contact.property_id,
          campaign_id: contact.campaign_id,
          current_stage: decision.next_stage,
          stage_before: currentStage,
          stage_after: decision.next_stage,
          use_case_template: decision.use_case,
          template_id: template.template_id,
          selected_template_id: template.template_id,
          template_source: template.source,
          message_type: "auto_reply",
          type: "auto_reply",
          detected_intent: intent,
          safety_status: safetyTier,
          routing_allowed: true,
          metadata: {
            source: "default_acquisition_inbound_dispatcher",
            acquisition_managed: true,
            default_acquisition_engine: true,
            acquisition_contact_id: contact.id,
            classifier_confidence: confidence,
            classifier_intent: intent,
          },
        },
        deps
      );
    }
  }

  let followup = null;
  if (
    metadata.schedule_followup !== false &&
    !shouldReview &&
    !metadata.response_managed_externally &&
    !decision.placeholder &&
    queueResult?.ok
  ) {
    followup = await scheduleNoReplyFollowup(
      { ...identity, contact, from_phone_number: context.inbound_to || context.to },
      {
        stage: decision.next_stage,
        timezone: context.timezone,
        from_phone_number: context.inbound_to || context.to,
        source: "inbound_dispatcher",
        reason: "seller_silent_after_stage_response",
      },
      deps
    );
  }

  const actionTaken = decision.placeholder
    ? "routed_to_offer_pricing_placeholder"
    : queueResult?.ok
      ? "queued_default_stage_response"
      : metadata.response_managed_externally
        ? "delegated_response_to_existing_inbound_pipeline"
        : "marked_manual_review";
  await emitAcquisitionEvent(
    "sms.inbound_dispatched",
    { ...identity, acquisition_contact_id: contact.id },
    {
      action_taken: actionTaken,
      selected_stage: decision.next_stage,
      selected_template: queueResult?.raw?.template_id || null,
      selected_use_case: decision.use_case,
      classifier_output: classification,
      reason: decision.reason,
      confidence,
      next_scheduled_action: followup?.scheduled_for || null,
      queue_row_id: queueResult?.queue_row_id || null,
      dedupe_key: context.message_id
        ? `acq-inbound-dispatch:${context.message_id}`
        : undefined,
    },
    deps
  );

  return {
    ok: true,
    contact,
    classification,
    intent,
    confidence,
    stage_before: currentStage,
    stage_after: decision.next_stage,
    use_case: decision.use_case,
    safety_tier: safetyTier,
    needs_review: shouldReview,
    queue_result: queueResult,
    followup,
  };
}

export { ACQUISITION_STAGES };
