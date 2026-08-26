// ─── handle-textgrid-inbound.js ──────────────────────────────────────────
import crypto from "node:crypto";
import { buildConversationContext } from "@/lib/domain/classification/build-conversation-context.js";
import { markInboundAwaitingBurst as markInboundAwaitingBurstImpl } from "@/lib/domain/inbound/inbound-processing-ledger.js";
import { loadContext } from "@/lib/domain/context/load-context.js";
import { loadContextWithFallback } from "@/lib/domain/context/load-context-with-fallback.js";
import { createBrain } from "@/lib/domain/context/resolve-brain.js";
import { classify } from "@/lib/domain/classification/classify.js";
import { syncClassifiedInboxThreadState } from "@/lib/supabase/sms-engine.js";
import { resolveRoute } from "@/lib/domain/routing/resolve-route.js";
import { normalizeInboundTextgridPhone } from "@/lib/providers/textgrid.js";
import { resolveCanonicalInboundThreadKey } from "@/lib/domain/inbox/resolve-canonical-inbound-thread.js";
import { getPodioRetryAfterSeconds, isPodioRateLimitError } from "@/lib/providers/podio.js";
import { logInboundMessageEvent } from "@/lib/domain/events/log-inbound-message-event.js";
import { updateBrainAfterInbound } from "@/lib/domain/brain/update-brain-after-inbound.js";
import { updateBrainStage } from "@/lib/domain/brain/update-brain-stage.js";
import { maybeCreateOfferFromContext } from "@/lib/domain/offers/maybe-create-offer-from-context.js";
import { maybeProgressOfferStatus } from "@/lib/domain/offers/maybe-progress-offer-status.js";
import { routeInboundOffer } from "@/lib/domain/offers/route-inbound-offer.js";
import { maybeUpsertUnderwritingFromInbound } from "@/lib/domain/underwriting/maybe-upsert-underwriting-from-inbound.js";
import { maybeQueueUnderwritingFollowUp } from "@/lib/domain/underwriting/maybe-queue-underwriting-follow-up.js";
import { transferDealToUnderwriting } from "@/lib/domain/underwriting/transfer-to-underwriting.js";
import { maybeCreateContractFromAcceptedOffer } from "@/lib/domain/contracts/maybe-create-contract-from-accepted-offer.js";
import { isOfferStageTrigger, runOfferStageAI, buildOfferStageMetadata, shouldSkipOfferStageAI } from "@/lib/domain/offers/offer-stage-ai-integration.js";
import { syncPipelineState } from "@/lib/domain/pipelines/sync-pipeline-state.js";
import { processAutonomousSellerReply } from "@/lib/domain/seller-flow/autonomous-seller-reply.js";
import { processSellerInboundMessage } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import {
  activationScopeFromDescriptor,
  createSellerInboundBurstCoordinator,
  isSellerInboundBurstEnabled,
  resolveSellerInboundBurstMode,
} from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import { isInternalTestPhone } from "@/lib/config/internal-phones.js";
import { detectImmediateSafetySignal } from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";
import { cancelPendingFollowUpsForThread } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { buildIntelligenceMessageEventPatch } from "@/lib/domain/seller-flow/persist-inbound-intelligence.js";
import {
  autoReplyModeAllowsDiagnostics,
  autoReplyModeAllowsQueue,
  resolveAutoReplyScopeConfig,
  resolveGuardedAutoReplyMode,
} from "@/lib/domain/seller-flow/auto-reply-mode.js";
import {
  normalizeSellerFlowUseCase,
  SELLER_FLOW_STAGES,
} from "@/lib/domain/seller-flow/canonical-seller-flow.js";
import { updateMasterOwnerAfterInbound } from "@/lib/domain/master-owners/update-master-owner-after-inbound.js";
import { isNegativeReply } from "@/lib/domain/classification/is-negative-reply.js";
import { cancelPendingQueueItemsForOwner } from "@/lib/domain/queue/cancel-pending-queue-items.js";
import {
  cancelSupabasePendingOutbound,
  CANCELLATION_POLICIES,
} from "@/lib/domain/queue/cancel-supabase-pending-outbound.js";
import { isEmergencyStopActive } from "@/lib/domain/queue/queue-control-safety.js";
import { extractUnderwritingSignals } from "@/lib/domain/underwriting/extract-underwriting-signals.js";
import { buildInboundConversationState } from "@/lib/domain/communications-engine/state-machine.js";
import {
  beginIdempotentProcessing,
  completeIdempotentProcessing,
  failIdempotentProcessing,
  hashIdempotencyPayload,
} from "@/lib/domain/events/idempotency-ledger.js";
import { findLatestOpenOffer } from "@/lib/podio/apps/offers.js";
import { handleUnknownInboundRouter } from "@/lib/domain/inbound/unknown-inbound-router.js";
import { emitAutomationEvent } from "@/lib/domain/automation/automation-events.js";
import {
  AUTOMATION_LOG_TAGS,
  logAutomationConsole,
} from "@/lib/domain/automation/automation-audit.js";
import { notifyDiscordOps } from "@/lib/discord/notify-discord-ops.js";
import { postInboundSmsDiscordCard } from "@/lib/discord/inbound-sms-card.js";
import {
  buildInboundAutopilotSchedule,
  findInboundAutopilotQueue,
  updateInboundAutopilotQueue,
} from "@/lib/discord/inbound-autopilot-queue.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { patchUniversalLeadState } from "@/lib/domain/lead-state/patch-universal-lead-state.js";
import { STATE_SOURCE_CODES } from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { logInboundMessageEvent as logSupabaseInboundMessageEvent } from "@/lib/supabase/sms-engine.js";
import { info, warn } from "@/lib/logging/logger.js";
import { getSystemFlags, getSystemValue } from "@/lib/system-control.js";

const defaultDeps = {
  loadContext,
  loadContextWithFallback,
  createBrain,
  classify,
  buildConversationContext,
  markInboundAwaitingBurst: markInboundAwaitingBurstImpl,
  resolveRoute,
  normalizeInboundTextgridPhone,
  logInboundMessageEvent,
  updateBrainAfterInbound,
  updateBrainStage,
  maybeCreateOfferFromContext,
  maybeProgressOfferStatus,
  routeInboundOffer,
  maybeUpsertUnderwritingFromInbound,
  maybeQueueUnderwritingFollowUp,
  transferDealToUnderwriting,
  maybeCreateContractFromAcceptedOffer,
  syncPipelineState,
  processAutonomousSellerReply,
  processSellerInboundMessage,
  createSellerInboundBurstCoordinator,
  isSellerInboundBurstEnabled,
  cancelPendingFollowUpsForThread,
  updateMasterOwnerAfterInbound,
  isNegativeReply,
  cancelPendingQueueItemsForOwner,
  cancelSupabasePendingOutbound,
  extractUnderwritingSignals,
  buildInboundConversationState,
  beginIdempotentProcessing,
  completeIdempotentProcessing,
  failIdempotentProcessing,
  hashIdempotencyPayload,
  findLatestOpenOffer,
  handleUnknownInboundRouter,
  emitAutomationEvent,
  notifyDiscordOps,
  postInboundSmsDiscordCard,
  buildInboundAutopilotSchedule,
  findInboundAutopilotQueue,
  updateInboundAutopilotQueue,
  getSupabaseClient: getDefaultSupabaseClient,
  logInboundMessageEventSupabase: logSupabaseInboundMessageEvent,
  getSystemFlags,
  getSystemValue,
  info,
  warn,
  isOfferStageTrigger,
  runOfferStageAI,
  buildOfferStageMetadata,
  shouldSkipOfferStageAI,
};

let runtimeDeps = { ...defaultDeps };

export function __setTextgridInboundTestDeps(overrides = {}) {
  runtimeDeps = { ...runtimeDeps, ...overrides };
}

export function __resetTextgridInboundTestDeps() {
  runtimeDeps = { ...defaultDeps };
}

function clean(value) {
  return String(value ?? "").trim();
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = clean(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function asPositiveInt(value, fallback = 0) {
  const numeric = Number.parseInt(clean(value), 10);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function previewText(value = "", max = 180) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function emitInboundTrace(event, meta = {}) {
  try {
    console.log(event, JSON.stringify(meta));
  } catch {
    console.log(event);
  }
}

function buildInboundContextMatchMetadata(context = {}) {
  const match =
    context?.fallback_match_data ||
    context?.recent?.outbound_pair_match ||
    context?.match ||
    null;

  if (!match || typeof match !== "object") return {};

  return {
    fallback_pair_match: Boolean(context?.fallback_pair_match),
    fallback_match_source: context?.fallback_match_source || null,
    fallback_match_id: context?.fallback_match_id || null,
    matched_queue_id:
      match.matched_queue_id ||
      match.queue_row_id ||
      context?.fallback_match_id ||
      null,
    matched_queue_status: match.matched_queue_status || null,
    matched_sent_at: match.matched_sent_at || null,
    matched_source: match.matched_source || null,
    skipped_newer_orphan_count: Number(match.skipped_newer_orphan_count || 0),
    match_strategy: match.match_strategy || null,
    context_verified: Boolean(match.context_verified),
    conversation_brain_id: context?.ids?.conversation_brain_id || null,
    textgrid_number_id: context?.ids?.textgrid_number_id || null,
  };
}

function buildAutopilotStatusText({
  autopilot_enabled = false,
  autopilot_delay_seconds = 60,
  outbound_queue_id = null,
  suggested_reply_ready = false,
} = {}) {
  if (autopilot_enabled && outbound_queue_id) {
    return `Autopilot reply scheduled in ${autopilot_delay_seconds}s`;
  }

  if (!suggested_reply_ready) {
    return "Manual review required — no safe reply generated";
  }

  return autopilot_enabled
    ? `Autopilot enabled — scheduling unavailable`
    : "Manual review required";
}

export function deriveInboundAutopilotQueueOverrides({
  autopilot_schedule = null,
  context = null,
  env = process.env,
} = {}) {
  const summary = context?.summary || {};
  const timezone_label =
    clean(autopilot_schedule?.timezone_label) ||
    clean(summary.timezone) ||
    clean(summary.market_timezone) ||
    clean(summary.timezone_label) ||
    clean(env.DEFAULT_CONTACT_TIMEZONE) ||
    "America/Chicago";
  const contact_window =
    clean(summary.contact_window) ||
    clean(summary.market_contact_window) ||
    null;

  return {
    timezone_label,
    contact_window,
  };
}

function buildDiscordReviewMetadata({
  autopilot_enabled = false,
  autopilot_delay_seconds = 0,
  suggested_reply_preview = "",
  selected_template_id = null,
  selected_template_source = null,
  outbound_queue_id = null,
  discord_review_status = null,
  discord_card_error = null,
  post_result = {},
  existing_metadata = {},
  context_incomplete = false,
} = {}) {
  const available_actions = context_incomplete
    ? ["sr:m", "sr:wn", "sr:oo"]
    : ["sr:a", "sr:m", "sr:c", "sr:ni", "sr:wn", "sr:oo", "context:open_record"];

  return {
    ...existing_metadata,
    inbound_discord_review_required: !autopilot_enabled,
    inbound_autopilot_enabled: Boolean(autopilot_enabled),
    inbound_autopilot_post_discord_card: existing_metadata?.inbound_autopilot_post_discord_card ?? true,
    autopilot_reply: Boolean(autopilot_enabled && clean(outbound_queue_id)),
    autopilot_override_window_seconds: Number(autopilot_delay_seconds || 0),
    suggested_reply_ready: Boolean(clean(suggested_reply_preview)),
    suggested_reply_preview: clean(suggested_reply_preview) || null,
    selected_template_id: clean(selected_template_id) || null,
    selected_template_source: clean(selected_template_source) || null,
    outbound_queue_id: clean(outbound_queue_id) || existing_metadata?.outbound_queue_id || null,
    discord_card_posted_at: post_result?.ok && !post_result?.skipped ? new Date().toISOString() : existing_metadata?.discord_card_posted_at || null,
    discord_channel_id: post_result?.channel_id || existing_metadata?.discord_channel_id || null,
    discord_message_id: post_result?.discord_message_id || existing_metadata?.discord_message_id || null,
    discord_card_error: clean(discord_card_error) || existing_metadata?.discord_card_error || null,
    discord_review_status:
      clean(discord_review_status) ||
      existing_metadata?.discord_review_status ||
      (autopilot_enabled && clean(outbound_queue_id) ? "autopilot_pending" : "manual_review_required"),
    discord_available_actions: available_actions,
  };
}

function extractAutomationDecisionFromSellerStageReply(seller_stage_reply = null) {
  return (
    seller_stage_reply?.plan?.automation_decision ||
    seller_stage_reply?.automation_decision ||
    seller_stage_reply?.queue_result?.raw?.metadata?.automation_decision_snapshot ||
    null
  );
}

function deriveHumanReviewRequired(seller_stage_reply = null) {
  const decision = extractAutomationDecisionFromSellerStageReply(seller_stage_reply);
  if (decision?.should_mark_human_review === true) return true;
  if (decision?.human_review_reason) return true;
  return clean(seller_stage_reply?.plan?.safety_tier) === "review";
}

function deriveAutoReplyStatus({
  seller_stage_reply = null,
  auto_reply_mode = "disabled",
  enabled = false,
} = {}) {
  const decision = extractAutomationDecisionFromSellerStageReply(seller_stage_reply);
  if (!enabled || auto_reply_mode === "disabled") return "disabled";
  if (seller_stage_reply?.queued || seller_stage_reply?.queue_row_id) return "queued";
  if (decision?.should_suppress_contact || seller_stage_reply?.plan?.safety_tier === "suppress") {
    return "suppressed";
  }
  if (deriveHumanReviewRequired(seller_stage_reply)) return "human_review_required";
  if (seller_stage_reply?.preview_result || clean(seller_stage_reply?.rendered_text)) return "dry_run";
  return seller_stage_reply?.reason || "no_reply";
}

async function postInboundDiscordReviewCard({
  runtimeDeps,
  message_event_id = null,
  inbound_from = "",
  message_body = "",
  context = null,
  classification = null,
  route = null,
  seller_stage_reply = null,
  inbound_autopilot_enabled = false,
  inbound_autopilot_delay_seconds = 60,
  outbound_queue_id = null,
  context_incomplete = false,
  existing_metadata = {},
} = {}) {
  if (typeof runtimeDeps.postInboundSmsDiscordCard !== "function") {
    return { ok: false, skipped: true, reason: "discord_card_poster_unavailable" };
  }

  const preview_source =
    seller_stage_reply?.preview_result?.rendered_message_text ||
    seller_stage_reply?.queue_result?.rendered_message_text ||
    seller_stage_reply?.queue_result?.rendered_message_preview ||
    "";
  const selected_template_id =
    seller_stage_reply?.preview_result?.template_id ||
    seller_stage_reply?.queue_result?.template_id ||
    seller_stage_reply?.queue_result?.selected_template_id ||
    null;
  const selected_template_source =
    seller_stage_reply?.preview_result?.selected_template_source ||
    seller_stage_reply?.queue_result?.selected_template_source ||
    seller_stage_reply?.queue_result?.selected_template_resolution_source ||
    null;

  return runtimeDeps.postInboundSmsDiscordCard({
    message_event_id,
    inbound_from,
    seller_name: context?.summary?.seller_first_name || context?.summary?.owner_name || null,
    property_address: context?.summary?.property_address || null,
    market: context?.summary?.market || context?.summary?.market_name || null,
    current_stage: seller_stage_reply?.brain_stage || route?.stage || context?.summary?.conversation_stage || null,
    classification_intent:
      seller_stage_reply?.plan?.selected_use_case ||
      route?.use_case ||
      classification?.objection ||
      classification?.source ||
      null,
    language:
      seller_stage_reply?.plan?.detected_language ||
      classification?.language ||
      context?.summary?.language_preference ||
      null,
    inbound_message_body: message_body,
    suggested_reply_preview: previewText(preview_source, 300),
    selected_template_id,
    selected_template_source,
    confidence: classification?.confidence ?? null,
    classification_result:
      clean(classification?.source) ||
      clean(classification?.objection) ||
      clean(seller_stage_reply?.plan?.detected_intent) ||
      "unknown",
    safety_state:
      context_incomplete
        ? "Manual review required — context incomplete"
        : buildAutopilotStatusText({
            autopilot_enabled: inbound_autopilot_enabled,
            autopilot_delay_seconds: inbound_autopilot_delay_seconds,
            outbound_queue_id,
            suggested_reply_ready: Boolean(clean(preview_source)),
          }),
    autopilot_enabled: Boolean(inbound_autopilot_enabled),
    autopilot_status: buildAutopilotStatusText({
      autopilot_enabled: inbound_autopilot_enabled,
      autopilot_delay_seconds: inbound_autopilot_delay_seconds,
      outbound_queue_id,
      suggested_reply_ready: Boolean(clean(preview_source)),
    }),
    outbound_queue_id,
    context_incomplete,
    existing_metadata,
  });
}

function formatOfferCurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function buildInboundStepFailure(error, err) {
  const podio_rate_limit = isPodioRateLimitError(err);
  return {
    ok: false,
    error,
    error_message: err?.message || "unknown",
    retryable: podio_rate_limit,
    podio_rate_limit,
    retry_after_seconds: podio_rate_limit ? getPodioRetryAfterSeconds(err, null) : null,
    retry_after_at: podio_rate_limit
      ? clean(
          err?.retry_after_at ||
            err?.cooldown_until ||
            err?.response?.data?.retry_after_at ||
            err?.response?.data?.cooldown_until
        ) || null
      : null,
  };
}

function normalizeDetectedIntentValue(value = null) {
  const raw = clean(value);
  if (!raw) return null;

  const aliases = {
    "Ownership Confirmed": "ownership_confirmed",
    "Ownership Confirmation": "ownership_confirmed",
    ownership_confirmed: "ownership_confirmed",
    seller_interested: "seller_interested",
    asks_offer: "asks_offer",
    asking_price_provided: "asking_price_provided",
    opt_out: "opt_out",
    wrong_number: "wrong_number",
    "Property Interest": "property_interest",
    interested: "interested",
    "not_interested": "not_interested",
    "wrong_person": "wrong_person",
    tenant_occupied: "tenant_occupied",
    condition_disclosed: "condition_disclosed",
    needs_call: "needs_call",
    needs_email: "needs_email",
    who_is_this: "who_is_this",
    unclear: "unclear",
  };

  return aliases[raw] || raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function deriveSecondPassPriority(plan = null) {
  const priority = Number(plan?.priority);
  if (!Number.isFinite(priority)) return "normal";
  if (priority <= 4) return "high";
  if (priority >= 10) return "low";
  return "normal";
}

function deriveSecondPassRisk(plan = null) {
  switch (clean(plan?.safety_tier)) {
    case "suppress":
      return "high";
    case "review":
      return "medium";
    default:
      return "low";
  }
}

function deriveSecondPassSafetyStatus(plan = null) {
  switch (clean(plan?.safety_tier)) {
    case "auto_send":
      return "allowed";
    case "suppress":
      return "suppressed";
    default:
      return "review";
  }
}

function buildSecondPassSupabasePayload({
  extracted = {},
  inbound_from = null,
  inbound_to = null,
  message_body = "",
  payload = {},
  classification = null,
  route = null,
  context = null,
  auto_reply_plan = null,
} = {}) {
  const detected_intent = normalizeDetectedIntentValue(
    auto_reply_plan?.inbound_intent ||
      auto_reply_plan?.detected_intent ||
      classification?.detected_intent ||
      classification?.inbound_intent ||
      classification?.objection ||
      "unclear"
  );
  const language =
    clean(auto_reply_plan?.selected_language) ||
    clean(classification?.language) ||
    clean(context?.summary?.language_preference) ||
    "English";
  const classification_confidence =
    typeof classification?.confidence === "number" ? classification.confidence : null;
  const safety_status = deriveSecondPassSafetyStatus(auto_reply_plan);
  const priority = deriveSecondPassPriority(auto_reply_plan);
  const risk = deriveSecondPassRisk(auto_reply_plan);
  const routing_allowed = clean(auto_reply_plan?.safety_tier) !== "suppress";
  const automation_decision = auto_reply_plan?.automation_decision || null;
  const human_review_required = Boolean(
    automation_decision?.should_mark_human_review ||
      auto_reply_plan?.safety_tier === "review" ||
      (classification_confidence !== null && classification_confidence < 0.90)
  );
  const auto_reply_status = auto_reply_plan
    ? deriveAutoReplyStatus({
        seller_stage_reply: { plan: auto_reply_plan },
        auto_reply_mode: auto_reply_plan?.auto_reply_mode || "dry_run",
        enabled: true,
      })
    : null;
  const auto_reply_queue_id = auto_reply_plan?.queue_row_id || auto_reply_plan?.queue_item_id || null;

  return {
    message_id: extracted.message_id || null,
    provider_message_sid: extracted.message_id || null,
    from: inbound_from,
    to: inbound_to,
    message: message_body,
    message_body,
    received_at:
      extracted.received_at ||
      payload?.http_received_at ||
      new Date().toISOString(),
    detected_intent,
    language,
    classification_confidence,
    safety_status,
    auto_reply_status,
    auto_reply_queue_id,
    human_review_required,
    needs_human_review: human_review_required,
    priority,
    risk,
    routing_allowed,
    metadata: {
      detected_intent,
      language,
      classification_confidence,
      safety_status,
      priority,
      risk,
      routing_allowed,
      auto_reply_status,
      auto_reply_queue_id,
      automation_decision,
      human_review_required,
      sentiment: classification?.emotion || null,
      seller_stage: route?.stage || null,
      conversation_stage: route?.stage || context?.summary?.conversation_stage || null,
      needs_human_review: human_review_required,
      next_action: route?.use_case || auto_reply_plan?.selected_use_case || null,
    },
  };
}

function extractWebhookPayload(payload = {}) {
  const message_id =
    payload.id ||
    payload.message_id ||
    payload.messageId ||
    payload.SmsMessageSid ||
    payload.SmsSid ||
    payload.MessageSid ||
    null;

  const from =
    payload.from ||
    payload.sender ||
    payload.msisdn ||
    payload.contact?.phone ||
    payload.From ||
    null;

  const to =
    payload.to ||
    payload.recipient ||
    payload.phone_number ||
    payload.To ||
    null;

  const body =
    payload.body ||
    payload.message ||
    payload.text ||
    payload.content ||
    payload.Body ||
    "";

  const status =
    payload.status ||
    payload.SmsStatus ||
    payload.event_type ||
    payload.event ||
    "received";

  const received_at =
    payload.received_at ||
    payload.http_received_at ||
    payload.timestamp ||
    payload.created_at ||
    null;

  return {
    raw: payload,
    message_id,
    from,
    to,
    body: String(body || "").trim(),
    status,
    received_at,
  };
}

function buildInboundIdempotencyKey(extracted = {}) {
  return (
    clean(extracted.message_id) ||
    runtimeDeps.hashIdempotencyPayload({
      provider: "textgrid",
      from: clean(extracted.from),
      to: clean(extracted.to),
      body: clean(extracted.body),
      status: clean(extracted.status),
    })
  );
}

async function resolveSupabaseInboundMessageEventId(provider_message_sid) {
  const sid = clean(provider_message_sid);
  if (!sid) return null;

  const supabase = runtimeDeps.getSupabaseClient?.();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("message_events")
    .select("id")
    .eq("provider_message_sid", sid)
    .maybeSingle();

  if (error) {
    safeWarn("textgrid.inbound_supabase_event_lookup_failed", {
      provider_message_sid: sid,
      error: error?.message || "unknown",
    });
    return null;
  }

  return data?.id || null;
}

// Logger guards — prevent any logger throw from escaping handler segments.
function safeInfo(event, meta = {}) {
  try { runtimeDeps.info(event, meta); } catch {}
}
function safeWarn(event, meta = {}) {
  try { runtimeDeps.warn(event, meta); } catch {}
}

const PRE_PIPELINE_USE_CASES = new Set([
  SELLER_FLOW_STAGES.OWNERSHIP_CHECK,
  SELLER_FLOW_STAGES.OWNERSHIP_CHECK_FOLLOW_UP,
  SELLER_FLOW_STAGES.CONSIDER_SELLING,
  SELLER_FLOW_STAGES.CONSIDER_SELLING_FOLLOW_UP,
  SELLER_FLOW_STAGES.WRONG_PERSON,
  SELLER_FLOW_STAGES.WHO_IS_THIS,
  SELLER_FLOW_STAGES.HOW_GOT_NUMBER,
  SELLER_FLOW_STAGES.NOT_INTERESTED,
  SELLER_FLOW_STAGES.STOP_OR_OPT_OUT,
  SELLER_FLOW_STAGES.REENGAGEMENT,
]);

function shouldCreateBrainForInbound({
  brain_id = null,
  seller_stage_reply = null,
  context = null,
  route = null,
} = {}) {
  if (brain_id) return false;

  const plan = seller_stage_reply?.plan || null;
  const selected_use_case = normalizeSellerFlowUseCase(
    plan?.selected_use_case,
    plan?.selected_variant_group
  );

  // 1. Check if we have enough context to warrant a brain
  const has_sufficient_context = Boolean(
    context?.ids?.master_owner_id ||
    context?.ids?.property_id ||
    context?.recent?.outbound_pair_match
  );

  if (!has_sufficient_context) return false;

  // 2. Check if the selected use case is one we want to track with a brain
  const ALLOWED_BRAIN_STAGES = new Set([
    SELLER_FLOW_STAGES.OWNERSHIP_CHECK,
    SELLER_FLOW_STAGES.OWNERSHIP_CHECK_FOLLOW_UP,
    SELLER_FLOW_STAGES.CONSIDER_SELLING,
    SELLER_FLOW_STAGES.CONSIDER_SELLING_FOLLOW_UP,
    SELLER_FLOW_STAGES.ASKING_PRICE,
    SELLER_FLOW_STAGES.ASKING_PRICE_FOLLOW_UP,
    SELLER_FLOW_STAGES.PRICE_WORKS_CONFIRM_BASICS,
    SELLER_FLOW_STAGES.PRICE_HIGH_CONDITION_PROBE,
    SELLER_FLOW_STAGES.CREATIVE_PROBE,
    SELLER_FLOW_STAGES.WHO_IS_THIS,
    SELLER_FLOW_STAGES.WRONG_PERSON,
    SELLER_FLOW_STAGES.NOT_INTERESTED,
    SELLER_FLOW_STAGES.STOP_OR_OPT_OUT,
  ]);

  if (ALLOWED_BRAIN_STAGES.has(selected_use_case)) return true;

  // 3. Fallback to route-based check
  const routed_use_case = normalizeSellerFlowUseCase(route?.use_case, route?.variant_group);
  if (ALLOWED_BRAIN_STAGES.has(routed_use_case)) return true;

  // 4. Specific intent match
  return (
    plan?.detected_intent === "Ownership Confirmed" ||
    plan?.detected_intent === "Property Interest" ||
    plan?.detected_intent === "Ownership Confirmation"
  );
}

function shouldCreatePipelineForInbound({
  seller_stage_reply = null,
  route = null,
  active_offer_item_id = null,
  contract_item_id = null,
} = {}) {
  if (active_offer_item_id || contract_item_id) return true;

  const seller_stage_use_case = normalizeSellerFlowUseCase(
    seller_stage_reply?.plan?.selected_use_case,
    seller_stage_reply?.plan?.selected_variant_group
  );

  if (
    seller_stage_use_case === SELLER_FLOW_STAGES.ASKING_PRICE ||
    seller_stage_use_case === "seller_asking_price"
  ) {
    return true;
  }

  const routed_use_case = normalizeSellerFlowUseCase(
    route?.use_case,
    route?.variant_group
  );

  if (!routed_use_case) return false;

  return !PRE_PIPELINE_USE_CASES.has(routed_use_case);
}

function shouldBypassInboundOfferRouting({ classification = null, route = null } = {}) {
  if (classification?.compliance_flag === "stop_texting") return true;

  const routed_use_case = normalizeSellerFlowUseCase(
    route?.use_case,
    route?.variant_group
  );

  return [
    SELLER_FLOW_STAGES.WRONG_PERSON,
    SELLER_FLOW_STAGES.STOP_OR_OPT_OUT,
  ].includes(routed_use_case);
}

// Terminal-disposition choke point. Every caller (webhook route, live
// webhook-event processor, recovery crons, ops replays) enters through this
// wrapper, so every inbound processing attempt — including thrown exceptions
// and every early return in the core — lands one canonical terminal
// disposition in the durable inbound_processing_ledger. Recording failures
// never block inbound processing; the SLA scan surfaces the residual gap.
export async function handleTextgridInboundWebhook(payload = {}, opts = {}) {
  const started_at_ms = Date.now();
  const [ledger_module, { resolveInboundTerminalDisposition, TERMINAL_DISPOSITIONS }] =
    await Promise.all([
      import("@/lib/domain/inbound/inbound-processing-ledger.js"),
      import("@/lib/domain/inbound/terminal-disposition.js"),
    ]);
  // Injectable for tests (via __setTextgridInboundTestDeps): the durable
  // ledger writes are otherwise unobservable without live Supabase config.
  const beginLedgerEntry =
    runtimeDeps.beginInboundLedgerEntry || ledger_module.beginInboundLedgerEntry;
  const recordTerminalDisposition =
    runtimeDeps.recordInboundTerminalDisposition ||
    ledger_module.recordInboundTerminalDisposition;
  const claimInbound =
    runtimeDeps.claimInboundProcessing || ledger_module.claimInboundProcessing;
  const completeClaim =
    runtimeDeps.completeInboundProcessingClaim ||
    ledger_module.completeInboundProcessingClaim;

  const sid = clean(
    payload?.message_id ||
      payload?.MessageSid ||
      payload?.SmsMessageSid ||
      payload?.sid
  );
  const from_phone = clean(payload?.from || payload?.From);
  const to_phone = clean(payload?.to || payload?.To);
  const message_body_raw = clean(payload?.message_body ?? payload?.Body ?? payload?.body);
  // Stable receipt instant for the no-SID key, derived ONLY from
  // provider/route-supplied payload fields — never new Date(), which would
  // hand every internal retry of the same request a fresh key and defeat
  // idempotency. The webhook route stamps http_received_at exactly once at
  // HTTP receipt and persists it with the payload (webhook_log), so a replay
  // or retry of the same request re-derives the same key, while the same text
  // arriving again later (a new HTTP receipt) gets a distinct one. When no
  // receipt field is present at all (direct invocations), the hint is empty
  // and the key degrades to the stable from|to|body hash.
  const received_at_hint = clean(
    payload?.received_at ||
      payload?.http_received_at ||
      payload?.timestamp ||
      payload?.created_at
  );
  const received_at_ms = Date.parse(received_at_hint);
  const idempotency_key = sid
    ? `textgrid_inbound:${sid}`
    : `textgrid_inbound:nosid:${crypto
        .createHash("sha256")
        .update(`${from_phone}|${to_phone}|${message_body_raw}|${received_at_hint}`, "utf8")
        .digest("hex")
        .slice(0, 32)}`;

  // ── ENFORCEMENT: atomic database claim ─────────────────────────────────
  // The durable ledger is the idempotency AUTHORITY: exactly one delivery of
  // a given idempotency key may hold a processing claim at a time. The
  // per-instance /tmp runtime-state record inside the core is diagnostic
  // caching only once a DB claim is active (see authoritative_claim below).
  const claim = await claimInbound({
    idempotency_key,
    provider_message_sid: sid || null,
    thread_key: from_phone || null,
    from_phone: from_phone || null,
    to_phone: to_phone || null,
    // PII minimization: the claim digests this (SHA-256 + length) and never
    // persists the raw seller text.
    message_body: message_body_raw,
    received_at: Number.isFinite(received_at_ms)
      ? new Date(received_at_ms).toISOString()
      : null,
  });

  let db_claim_active = false;
  if (claim?.authority === "db" && claim.outcome) {
    if (
      claim.outcome === "duplicate_completed" ||
      claim.outcome === "terminally_failed"
    ) {
      // Duplicate delivery of a settled key. Never a silent drop: the claim
      // RPC already bumped duplicate_delivery_count on the ledger row, and we
      // return an explicit duplicate_ignored disposition carrying the prior
      // disposition reference for the caller's audit trail.
      safeInfo("textgrid.inbound_duplicate_delivery_ignored", {
        idempotency_key,
        provider_message_sid: sid || null,
        claim_outcome: claim.outcome,
        prior_disposition: claim.prior_disposition || null,
        duplicate_delivery_count: claim.duplicate_delivery_count || null,
      });
      return {
        ok: true,
        duplicate: true,
        updated: false,
        reason:
          claim.outcome === "duplicate_completed"
            ? "duplicate_completed_delivery"
            : "terminally_failed_delivery",
        terminal_disposition: "duplicate_ignored",
        prior_disposition: claim.prior_disposition || null,
        ledger_id: claim.ledger_id || null,
        duplicate_delivery_count: claim.duplicate_delivery_count || null,
        idempotency_key,
      };
    }
    if (claim.outcome === "already_processing") {
      safeInfo("textgrid.inbound_already_processing", {
        idempotency_key,
        provider_message_sid: sid || null,
        lease_expires_at: claim.lease_expires_at || null,
      });
      return {
        ok: true,
        duplicate: true,
        updated: false,
        reason: "event_already_processing",
        ledger_id: claim.ledger_id || null,
        lease_expires_at: claim.lease_expires_at || null,
        idempotency_key,
      };
    }
    if (claim.outcome === "invalid_claim") {
      return {
        ok: false,
        reason: claim.reason || "invalid_claim",
        idempotency_key,
      };
    }
    // claimed_new | retry_claimed → we hold the claim; process.
    db_claim_active = true;
  } else if (claim?.fail_closed) {
    // Supabase IS configured but the claim could not be established (RPC
    // missing pre-migration, transient DB failure). Processing without a
    // claim is exactly the double-execution the contract forbids — fail
    // closed and let the provider retry.
    safeWarn("textgrid.inbound_claim_unavailable_fail_closed", {
      idempotency_key,
      provider_message_sid: sid || null,
      reason: claim.reason || "unknown",
    });
    return {
      ok: false,
      reason: claim.reason || "inbound_claim_unavailable",
      fail_closed: true,
      // The route maps retryable → HTTP 503 + Retry-After, so the provider
      // redelivers once the claim path is back (migration applied / DB up).
      retryable: true,
      retry_after_seconds: 30,
      idempotency_key,
    };
  }
  // authority === "unavailable" (Supabase unconfigured: hermetic tests, local
  // dev) → fall through to the legacy observability begin + /tmp enforcement.

  const ledger = db_claim_active
    ? { ok: true, ledger_id: claim.ledger_id || null }
    : await beginLedgerEntry({
        idempotency_key,
        provider_message_sid: sid || null,
        thread_key: from_phone || null,
        from_phone: from_phone || null,
        to_phone: to_phone || null,
        // PII minimization: the ledger digests this (SHA-256 + length) and
        // never persists the raw seller text.
        message_body: message_body_raw,
        received_at: Number.isFinite(received_at_ms)
          ? new Date(received_at_ms).toISOString()
          : null,
      });

  // Durable-write truthfulness: a failed disposition write is exactly the
  // silent drop the ledger exists to make loud — surface it in the wrapper
  // and raise the P0 inbound_no_disposition alert. supabase_unconfigured is
  // exempt (no ledger AND no alert sink exist; local/test environments).
  async function writeTerminalDisposition(record_args) {
    if (db_claim_active) {
      // Run-id-fenced write: only the current claim holder may record. A
      // zombie (lease expired, row reclaimed) gets claim_fenced, never a
      // silent overwrite of the reclaiming worker's disposition.
      return completeClaim({
        idempotency_key,
        processing_run_id: claim.processing_run_id,
        disposition: record_args.disposition,
        detail: record_args.detail || {},
        detected_intent: record_args.detected_intent || null,
        classifier_version: record_args.classifier_version || null,
        confidence: record_args.confidence ?? null,
        latency_ms: record_args.latency_ms ?? null,
        error_message: record_args.error_message || null,
      });
    }
    return recordTerminalDisposition(record_args);
  }

  async function recordDispositionOrAlert(record_args) {
    const record_result = await writeTerminalDisposition(record_args);
    if (record_result?.ok || record_result?.reason === "supabase_unconfigured") {
      return record_result;
    }
    safeWarn("textgrid.inbound_terminal_disposition_record_failed", {
      idempotency_key,
      ledger_id: record_args.ledger_id || null,
      disposition: record_args.disposition,
      reason: record_result?.reason || "unknown",
    });
    try {
      const record_alert =
        runtimeDeps.recordInboundNoDispositionAlert ||
        (await import("@/lib/domain/alerts/launch-critical-alerts.js")).launchAlerts
          .inboundNoDisposition;
      await record_alert({
        record_failure: true,
        record_failure_reason: record_result?.reason || "unknown",
        idempotency_key,
        provider_message_sid: sid || null,
        disposition: record_args.disposition,
      });
    } catch (alert_error) {
      safeWarn("textgrid.inbound_disposition_record_alert_failed", {
        idempotency_key,
        error: alert_error?.message || "unknown",
      });
    }
    return record_result;
  }

  try {
    const result = await handleTextgridInboundWebhookCore(payload, {
      ...opts,
      authoritative_claim: db_claim_active
        ? {
            processing_run_id: claim.processing_run_id,
            outcome: claim.outcome,
            attempt_count: claim.attempt_count,
          }
        : null,
    });
    if (!ledger.duplicate_completed) {
      const resolved = resolveInboundTerminalDisposition(result);
      if (resolved.pending) {
        // The decision was handed to the burst layer — the inbound is NOT
        // finished, so it must not be terminalized. `reply_deferred_burst` is
        // rejected by both the ledger CHECK and complete_inbound_processing's
        // allowlist; passing it through would fail the write and then raise a
        // false inbound_no_disposition P0.
        //
        // The row stays status='processing' (already set by the claim) and
        // carries its pendency in disposition_detail, which the SLO scanner
        // recognises as intentionally awaiting burst finalization. Genuine
        // burst failure is alarmed independently by the burst liveness scan, so
        // nothing is unwatched. Constituent rows are finalized for real when
        // the burst completes.
        // A marker without a burst id is worse than no marker: it parks the row
        // at status='processing' where findInboundLedgerSlaBreaches deliberately
        // excludes it from the stuck scan, while finalizeBurstConstituentLedger
        // adopts constituents by EXACT burst_id match and so can never settle
        // it. The row becomes permanently unsettleable and invisible to both
        // watchdogs. Fail loudly and RETRIABLY instead — the provider redelivers
        // and the next attempt can associate it properly.
        const pending_burst_id = clean(resolved.detail?.burst_id);
        if (!pending_burst_id) {
          await recordDispositionOrAlert({
            ledger_id: ledger.ledger_id || null,
            idempotency_key,
            disposition: TERMINAL_DISPOSITIONS.FAILED_RETRIABLE,
            detail: {
              awaiting_burst_missing_burst_id: true,
              pending_disposition: resolved.disposition,
            },
            latency_ms: Date.now() - started_at_ms,
          });
          if (result && typeof result === "object") {
            result.terminal_disposition = TERMINAL_DISPOSITIONS.FAILED_RETRIABLE;
          }
          return result;
        }
        const marked = await runtimeDeps.markInboundAwaitingBurst({
          idempotency_key,
          burst_id: pending_burst_id,
          detail: { ...resolved.detail, burst_id: pending_burst_id },
          processing_run_id: claim?.processing_run_id || null,
        });
        if (marked?.ok === false) {
          // The row would sit at status='processing' with no marker: invisible
          // to burst finalization AND indistinguishable from a silent drop.
          // Record the failure loudly rather than returning success.
          await recordDispositionOrAlert({
            ledger_id: ledger.ledger_id || null,
            idempotency_key,
            disposition: TERMINAL_DISPOSITIONS.FAILED_RETRIABLE,
            detail: { awaiting_burst_marker_failed: true, reason: marked.reason || null },
            latency_ms: Date.now() - started_at_ms,
          });
          if (result && typeof result === "object") {
            result.terminal_disposition = TERMINAL_DISPOSITIONS.FAILED_RETRIABLE;
          }
          return result;
        }
        if (result && typeof result === "object") {
          result.terminal_disposition = null;
          result.pending_disposition = resolved.disposition;
        }
        return result;
      }
      await recordDispositionOrAlert({
        ledger_id: ledger.ledger_id || null,
        idempotency_key,
        disposition: resolved.disposition,
        detail: resolved.detail,
        detected_intent:
          result?.classification?.primary_intent ||
          result?.classification?.detected_intent ||
          null,
        classifier_version: result?.classification?.version || null,
        confidence: result?.classification?.confidence ?? null,
        latency_ms: Date.now() - started_at_ms,
      });
      if (result && typeof result === "object") {
        result.terminal_disposition = resolved.disposition;
      }
    }
    return result;
  } catch (error) {
    if (!ledger.duplicate_completed) {
      await recordDispositionOrAlert({
        ledger_id: ledger.ledger_id || null,
        idempotency_key,
        disposition: TERMINAL_DISPOSITIONS.FAILED_RETRIABLE,
        detail: { thrown: true },
        error_message: error?.message || "unknown_inbound_processing_error",
        latency_ms: Date.now() - started_at_ms,
      });
    }
    throw error;
  }
}

async function handleTextgridInboundWebhookCore(payload = {}, opts = {}) {
  const {
    inbound_debug_stage = null,
    dry_run = false,
    auto_reply_enabled = null,
    auto_reply_live_enabled = null,
    auto_reply_dry_run = null,
    auto_reply_mode = null,
    auto_post_discord_card = null,
    auto_reply_delay_seconds = null,
    inbound_user_initiated = true,
    // Set by the wrapper when the durable DB claim contract authorized this
    // execution. When present, the per-instance /tmp runtime-state record is
    // NON-AUTHORITATIVE diagnostic caching: its duplicate verdicts are logged
    // as divergence but never skip processing, and its write failures never
    // block a DB-claimed execution.
    authoritative_claim = null,
  } = opts;

  // Feature flags: env -> system_control -> default
  const auto_reply_enabled_final = asBoolean(
    auto_reply_enabled,
    asBoolean(process.env.AUTO_REPLY_ENABLED, null)
  );
  const auto_reply_live_enabled_final = asBoolean(
    auto_reply_live_enabled,
    asBoolean(process.env.AUTO_REPLY_LIVE_ENABLED, null)
  );
  const auto_reply_dry_run_final = asBoolean(
    auto_reply_dry_run,
    asBoolean(process.env.AUTO_REPLY_DRY_RUN, null)
  );

  // system_control gates — fail-closed: missing flag = disabled.
  // auto_reply_enabled must be true in system_control before any auto-reply is queued.
  // followup_enabled must be true in system_control before any follow-up is queued.
  const { auto_reply_enabled: system_auto_reply_enabled, followup_enabled: system_followup_enabled } =
    await runtimeDeps.getSystemFlags(["auto_reply_enabled", "followup_enabled"]);
  const system_auto_reply_mode = await runtimeDeps.getSystemValue("auto_reply_mode");
  const podio_sync_enabled = asBoolean(
    await runtimeDeps.getSystemValue("podio_sync_enabled"),
    false
  );
  // Durable burst mode (BLOCKER-3 gate): while enabled, an individual inbound
  // fragment may only (a) persist the raw message, (b) apply immediate
  // safety/contact projections (suppression, pending-outbound cancellation,
  // inbox thread presentation/triage), and (c) enter durable burst storage.
  // Acquisition/business advancement — brains, offers, underwriting,
  // contracts, pipeline, follow-up queueing, reply queueing — happens exactly
  // once per finalized burst via the aggregate V2 turn, never per fragment.
  const seller_burst_mode = runtimeDeps.resolveSellerInboundBurstMode
    ? runtimeDeps.resolveSellerInboundBurstMode()
    : resolveSellerInboundBurstMode();
  // Global part of the gate. internal_proof mode starts DISABLED here and is
  // upgraded per-thread below (internal phone + active proof session), after
  // inbound_from is final — a real seller thread can never engage burst in
  // internal_proof mode.
  let seller_burst_enabled = runtimeDeps.isSellerInboundBurstEnabled
    ? runtimeDeps.isSellerInboundBurstEnabled()
    : seller_burst_mode === "enabled";
  // Scope handed to the burst coordinator. Global activation asserts it via
  // `enabled: true` (unchanged); internal_proof MUST carry the session's own
  // bounds, because a bare global assertion in that mode would admit any open
  // generation on the pinned thread — including one predating the session.
  let seller_burst_activation_scope = null;
  let podio_business_writes_enabled = podio_sync_enabled && !seller_burst_enabled;
  const system_emergency_stop_at = await runtimeDeps.getSystemValue("queue_emergency_stop_at");
  const auto_reply_mode_resolution = isEmergencyStopActive(system_emergency_stop_at)
    ? { mode: "disabled", source: "queue_emergency_stop" }
    : resolveGuardedAutoReplyMode({
        requestedMode: auto_reply_mode,
        systemMode: system_auto_reply_mode,
        legacyEnabled: Boolean(auto_reply_enabled_final && system_auto_reply_enabled),
        legacyDryRun: Boolean(auto_reply_dry_run_final),
        legacyLiveEnabled: Boolean(auto_reply_live_enabled_final),
      });
  const auto_reply_mode_final = auto_reply_mode_resolution.mode;
  const inbound_autopilot_enabled = autoReplyModeAllowsDiagnostics(auto_reply_mode_final);
  const inbound_auto_reply_queue_enabled = Boolean(
    system_auto_reply_enabled &&
      ["internal_only", "live_limited"].includes(auto_reply_mode_final)
  );
  const inbound_autopilot_post_discord_card = asBoolean(
    auto_post_discord_card,
    asBoolean(process.env.INBOUND_AUTOPILOT_POST_DISCORD_CARD, true)
  );
  const inbound_autopilot_delay_seconds = asPositiveInt(
    auto_reply_delay_seconds,
    asPositiveInt(process.env.INBOUND_AUTOPILOT_DELAY_SECONDS, 60)
  );

  if (inbound_debug_stage === "handler_entry") {
    return { ok: true, stage: "handler_entry" };
  }

  let extracted, inbound_from, inbound_to, message_body, offer_stage_ai_result = null;
  try {
    extracted = extractWebhookPayload(payload);
    if (inbound_debug_stage === "after_extract") {
      return { ok: true, stage: "after_extract" };
    }

    inbound_from = runtimeDeps.normalizeInboundTextgridPhone(extracted.from);
    // Force E.164: never leave bare 10-digit forms that collide with archived aliases.
    if (inbound_from && !String(inbound_from).startsWith("+") && /^\d{10}$/.test(String(inbound_from))) {
      inbound_from = `+1${inbound_from}`;
    }
    // Resolve active E.164 thread; archived non-E.164 aliases redirect only.
    try {
      const supabase_for_thread = runtimeDeps.getSupabaseClient?.();
      if (supabase_for_thread && inbound_from) {
        const digits = String(inbound_from).replace(/\D/g, "");
        const bare10 =
          digits.length === 11 && digits.startsWith("1")
            ? digits.slice(1)
            : digits.length === 10
              ? digits
              : null;
        const keys = [...new Set([inbound_from, bare10, extracted.from].filter(Boolean))];
        const { data: thread_rows } = await supabase_for_thread
          .from("inbox_thread_state")
          .select("id,thread_key,is_archived,metadata")
          .in("thread_key", keys)
          .limit(10);
        const resolved = resolveCanonicalInboundThreadKey({
          inbound_from,
          threads: thread_rows || [],
        });
        if (resolved?.thread_key) {
          if (resolved.thread_key !== inbound_from) {
            safeInfo("textgrid.inbound_thread_alias_redirect", {
              message_id: extracted.message_id,
              from_raw: extracted.from,
              from_normalized: inbound_from,
              canonical_thread_key: resolved.thread_key,
              resolved_from: resolved.resolved_from,
              retired_alias: resolved.retired_alias || null,
            });
          }
          inbound_from = resolved.thread_key;
        }
      }
    } catch (thread_resolve_error) {
      safeWarn("textgrid.inbound_canonical_thread_resolve_failed", {
        message_id: extracted.message_id,
        inbound_from,
        error: thread_resolve_error?.message || "thread_resolve_failed",
      });
    }
    if (inbound_debug_stage === "after_normalize_from") {
      return { ok: true, stage: "after_normalize_from", inbound_from };
    }

    inbound_to = runtimeDeps.normalizeInboundTextgridPhone(extracted.to);
    if (inbound_to && !String(inbound_to).startsWith("+") && /^\d{10}$/.test(String(inbound_to))) {
      inbound_to = `+1${inbound_to}`;
    }
    if (inbound_debug_stage === "after_normalize_to") {
      return { ok: true, stage: "after_normalize_to" };
    }

    message_body = extracted.body;

    try {
      runtimeDeps.info("textgrid.inbound_received", {
        message_id: extracted.message_id,
        inbound_from,
        inbound_to,
        body_preview: String(message_body || "").slice(0, 120),
      });
    } catch {}

    if (inbound_debug_stage === "after_inbound_received_log") {
      return { ok: true, stage: "after_inbound_received_log" };
    }
  } catch (error) {
    return {
      ok: false,
      error: "textgrid_inbound_failed_handler_entry",
      detail: error?.message || "unknown_handler_entry_error",
    };
  }

  if (!inbound_from) {
    safeWarn("textgrid.inbound_missing_from", { message_id: extracted.message_id });
    return { ok: false, reason: "missing_inbound_from" };
  }

  if (!message_body) {
    safeWarn("textgrid.inbound_empty_body", { message_id: extracted.message_id, inbound_from });
    return { ok: false, reason: "empty_inbound_body" };
  }

  // internal_proof burst mode: upgrade the per-thread gate ONLY for an
  // internal test phone AND an active bounded internal-proof session. Every
  // failure mode (non-internal thread, no session, session expired, session
  // lookup error) leaves burst DISABLED for this message — real sellers can
  // never engage the burst leg in this mode.
  if (seller_burst_mode === "internal_proof" && !seller_burst_enabled) {
    const isInternalPhoneImpl =
      runtimeDeps.isInternalTestPhone || isInternalTestPhone;
    if (isInternalPhoneImpl(inbound_from)) {
      try {
        // Resolved through the shared activation authority rather than a local
        // session load. That authority additionally honors `closed_at`, which
        // parseInternalProofSession does not read — a closed session must not
        // engage burst here any more than it may on the flush path.
        const policy_module = await import(
          "@/lib/domain/seller-flow/burst-flush-activation-policy.js"
        );
        const loadPolicy =
          runtimeDeps.loadBurstFlushActivationPolicy ||
          policy_module.loadBurstFlushActivationPolicy;
        const policy = await loadPolicy({
          supabase: runtimeDeps.getSupabaseClient?.() || null,
          getSystemValue: runtimeDeps.getSystemValue || null,
          // Reuse the mode this request already resolved. Resolving twice would
          // let an injected/overridden mode and the raw env disagree, and the
          // gate would then be deciding on a different mode than the one logged.
          resolveMode: () => seller_burst_mode,
        });
        const scope = activationScopeFromDescriptor(
          policy_module.toBurstFlushScopeDescriptor(policy)
        );
        if (scope.authorized) {
          seller_burst_enabled = true;
          seller_burst_activation_scope = scope;
          podio_business_writes_enabled = false;
          safeInfo("textgrid.inbound_burst_internal_proof_engaged", {
            message_id: extracted.message_id,
            inbound_from,
            session_id: scope.session_id || null,
          });
        } else {
          safeInfo("textgrid.inbound_burst_internal_proof_denied", {
            message_id: extracted.message_id,
            inbound_from,
            reason: scope.reason || policy?.reason || "no_active_session",
          });
        }
      } catch (session_error) {
        safeWarn("textgrid.inbound_burst_internal_proof_session_error", {
          message_id: extracted.message_id,
          inbound_from,
          error: session_error?.message || "session_lookup_failed",
        });
      }
    }
  }

  // ── SEGMENT: message_event_lookup ────────────────────────────────────────
  // beginIdempotentProcessing checks the per-instance runtime-state record for
  // prior processing of this message ID. When the wrapper holds a durable DB
  // claim (authoritative_claim), this store is DIAGNOSTIC ONLY: the database
  // claim contract has already guaranteed exactly-one execution across
  // instances, so a local duplicate/failure verdict is logged as divergence
  // and processing continues. Without a DB claim (Supabase unconfigured:
  // hermetic tests, local dev) it remains the enforcement fallback.
  let idempotency_key, idempotency;
  try {
    idempotency_key = buildInboundIdempotencyKey(extracted);
    idempotency = await runtimeDeps.beginIdempotentProcessing({
      scope: "textgrid_inbound",
      key: idempotency_key,
      summary: `Processed inbound SMS ${idempotency_key}`,
      metadata: {
        provider: "textgrid",
        provider_message_id: clean(extracted.message_id) || null,
        inbound_from,
        inbound_to,
        ...(authoritative_claim
          ? {
              diagnostic_only: true,
              authoritative_claim_run_id:
                authoritative_claim.processing_run_id || null,
            }
          : {}),
      },
    });
  } catch (err) {
    if (authoritative_claim) {
      safeWarn("textgrid.inbound_runtime_state_begin_failed_nonblocking", {
        message_id: extracted.message_id,
        idempotency_key,
        error: err?.message || "runtime_state_begin_failed",
      });
      idempotency = { ok: true, duplicate: false, record_item_id: null, degraded: true };
    } else {
      return buildInboundStepFailure("textgrid_inbound_failed_message_event_lookup", err);
    }
  }

  if (!idempotency.ok) {
    if (authoritative_claim) {
      safeWarn("textgrid.inbound_runtime_state_unavailable_nonblocking", {
        message_id: extracted.message_id,
        idempotency_key,
        reason: idempotency.reason || "unknown",
      });
      idempotency = { ok: true, duplicate: false, record_item_id: null, degraded: true };
    } else {
      return {
        ok: false,
        reason: idempotency.reason,
        message_id: extracted.message_id,
        idempotency_key,
      };
    }
  }

  if (idempotency.duplicate) {
    if (authoritative_claim) {
      // The DB claim authorized this execution; the warm-instance /tmp record
      // disagrees (e.g. a prior attempt on this instance crashed after its
      // lease expired and the key was reclaimed). The database is the
      // authority — record the divergence and continue processing.
      safeInfo("textgrid.inbound_runtime_state_divergence_ignored", {
        message_id: extracted.message_id,
        inbound_from,
        runtime_state_reason: idempotency.reason,
        claim_outcome: authoritative_claim.outcome,
        idempotency_key,
      });
      idempotency = { ...idempotency, duplicate: false };
    } else {
      safeInfo("textgrid.inbound_duplicate_ignored", {
        message_id: extracted.message_id,
        inbound_from,
        reason: idempotency.reason,
        idempotency_key,
      });
      return {
        ok: true,
        duplicate: true,
        updated: false,
        reason: idempotency.reason,
        message_id: extracted.message_id,
        inbound_from,
        inbound_to,
        idempotency_key,
      };
    }
  }

  if (inbound_debug_stage === "after_message_event_lookup") {
    return {
      ok: true,
      stage: "after_message_event_lookup",
      idempotency_key,
      seller_burst_enabled,
      seller_burst_mode,
      seller_burst_activation_scope,
    };
  }

  // From here the idempotency record exists; the outer catch calls
  // failIdempotentProcessing if anything escapes all inner catches.
  let message_event_enriched = false;

  async function failStepAndReturn(stepError, err) {
    try {
      await runtimeDeps.failIdempotentProcessing({
        record_item_id: idempotency.record_item_id,
        scope: "textgrid_inbound",
        key: idempotency_key,
        error: err,
        skip_content_fields: message_event_enriched,
        metadata: {
          provider_message_id: clean(extracted.message_id) || null,
          inbound_from,
          inbound_to,
        },
      });
    } catch (_) { /* best-effort */ }
    return buildInboundStepFailure(stepError, err);
  }

  try {
    // ── SEGMENT: brain_lookup ───────────────────────────────────────────────
    let context;
    try {
      context = await runtimeDeps.loadContextWithFallback({
        inbound_from,
        inbound_to,
        // Bounds outbound-pair selection to messages the seller had actually
        // received by the time they replied, so the orchestrator binds to the
        // same outbound buildConversationContext hands the classifier.
        inbound_received_at: extracted.received_at || payload?.http_received_at || null,
        create_brain_if_missing: podio_business_writes_enabled,
        loadContextImpl: runtimeDeps.loadContext,
      });
    } catch (err) {
      return failStepAndReturn("textgrid_inbound_failed_brain_lookup", err);
    }

    if (!context?.found) {
      safeWarn("textgrid.inbound_context_not_found", {
        message_id: extracted.message_id,
        inbound_from,
        reason: context?.reason || "unknown",
      });

      let unknown_result;
      try {
        unknown_result = await runtimeDeps.handleUnknownInboundRouter({
          message_id: extracted.message_id,
          inbound_from,
          inbound_to,
          message_body,
          dry_run: Boolean(dry_run),
          auto_reply_enabled: false,
          inbound_autopilot_enabled,
          inbound_user_initiated: Boolean(inbound_user_initiated),
        });
      } catch (err) {
        return failStepAndReturn("textgrid_inbound_failed_unknown_router", err);
      }

      let fallback_message_event_id = null;
      try {
        const fallback_event = await runtimeDeps.logInboundMessageEvent({
          brain_item: null,
          conversation_item_id: null,
          master_owner_id: null,
          prospect_id: null,
          property_id: null,
          market_id: null,
          phone_item_id: null,
          inbound_number_item_id: null,
          sms_agent_id: null,
          property_address: null,
          message_body,
          provider_message_id: extracted.message_id,
          raw_carrier_status: extracted.status || "received",
          received_at: extracted.received_at || payload?.http_received_at || new Date().toISOString(),
          processed_by: "Manual Sender",
          source_app: "External API",
          trigger_name: "textgrid-inbound",
          inbound_from,
          inbound_to,
          metadata: {
            inbound_discord_review_required: true,
            inbound_autopilot_enabled,
            suggested_reply_ready: false,
            discord_review_status: "pending",
          },
        });
        fallback_message_event_id = fallback_event?.item_id || null;
      } catch (fallback_event_error) {
        // Without this warn, a failed Podio fallback write left zero trace of
        // the message beyond the unknown-router Supabase attempts.
        safeWarn("textgrid.inbound_unknown_fallback_event_failed", {
          message_id: extracted.message_id,
          error: fallback_event_error?.message || "fallback_event_write_failed",
        });
      }

      // Consolidate Discord review card posting or rely on router alert. 
      // Removed redundant card call to ensure exactly one notification per event.

      await runtimeDeps.completeIdempotentProcessing({
        record_item_id: idempotency.record_item_id,
        scope: "textgrid_inbound",
        key: idempotency_key,
        summary: `Inbound SMS handled by unknown router: ${unknown_result?.unknown_router?.bucket || "unknown"}`,
        metadata: {
          provider_message_id: clean(extracted.message_id) || null,
          inbound_from,
          inbound_to,
          result_reason: context?.reason || "context_not_found",
          unknown_inbound: true,
          unknown_bucket: unknown_result?.unknown_router?.bucket || null,
          auto_reply_queued: Boolean(unknown_result?.unknown_router?.auto_reply_queued),
          suppression_applied: Boolean(unknown_result?.unknown_router?.suppression_applied),
          dry_run: Boolean(dry_run),
        },
      });

      unknown_result.matched = true;
      return unknown_result;
    }

    let brain_item = context.items?.brain_item || null;
    const fallback_conversation_brain_id = asPositiveInt(context.ids?.conversation_brain_id, null) || null;
    let brain_id = context.ids?.brain_item_id || fallback_conversation_brain_id;
    const master_owner_id = context.ids?.master_owner_id || null;
    const prospect_id = context.ids?.prospect_id || null;
    const property_id = context.ids?.property_id || null;
    const phone_item_id = context.ids?.phone_item_id || null;
    const market_id = context.ids?.market_id || null;
    const sms_agent_id = context.ids?.assigned_agent_id || null;
    const property_address = context.summary?.property_address || null;
    const latest_outbound_event =
      context.recent?.recent_events?.find(
        (event) => clean(event?.direction).toLowerCase() === "outbound"
      ) || null;
    const inbound_number_item_id =
      latest_outbound_event?.textgrid_number_item_id ||
      context.ids?.textgrid_number_id ||
      null;
    const prior_message_id = latest_outbound_event?.message_id || null;
    const response_to_message_id = prior_message_id;
    const stage_before = context.summary?.conversation_stage || null;
    const inbound_context_match_metadata = buildInboundContextMatchMetadata(context);

    if (inbound_debug_stage === "after_brain_lookup") {
      return { ok: true, stage: "after_brain_lookup", brain_id, master_owner_id };
    }

    try {
      const supabase = runtimeDeps.getSupabaseClient?.();
      if (supabase && inbound_from) {
        const { data: thread_state } = await supabase
          .from("inbox_thread_state")
          .select("is_archived,archive_scope")
          .eq("thread_key", inbound_from)
          .maybeSingle();

        if (
          thread_state?.is_archived === true
          && clean(thread_state.archive_scope).toLowerCase() === "conversation"
        ) {
          await patchUniversalLeadState({
            threadKey: inbound_from,
            patch: {
              is_archived: false,
              archive_scope: null,
            },
            supabase,
            meta: {
              change_source: STATE_SOURCE_CODES.SYSTEM,
              source_view: "inbound_auto_unarchive",
              reason: "inbound_message_received",
            },
          });
        }
      }
    } catch (unarchive_error) {
      safeWarn("textgrid.inbound_conversation_unarchive_failed", {
        message_id: extracted.message_id,
        inbound_from,
        error: unarchive_error?.message || "conversation_unarchive_failed",
      });
    }

    // ── SEGMENT: phone_resolution ────────────────────────────────────────
    // Phone identity is resolved from context — gate here confirms phone_item_id
    // is available before downstream steps that depend on it.
    if (inbound_debug_stage === "after_phone_resolution") {
      return { ok: true, stage: "after_phone_resolution", phone_item_id, inbound_from };
    }

    // ── SEGMENT: message_event_create ─────────────────────────────────────
    // Create the canonical seller Message Events row early, then rehydrate
    // that same row later if the Brain / stage context becomes richer during
    // the rest of the inbound pipeline.
    let inbound_message_event_id = null;
    try {
      const offer_ai_metadata = runtimeDeps.buildOfferStageMetadata
        ? runtimeDeps.buildOfferStageMetadata(offer_stage_ai_result)
        : {};

      if (podio_sync_enabled) {
        const inbound_event = await runtimeDeps.logInboundMessageEvent({
          brain_item,
          conversation_item_id: brain_id,
          master_owner_id,
          prospect_id,
          property_id,
          market_id,
          phone_item_id,
          inbound_number_item_id,
          sms_agent_id,
          property_address,
          message_body,
          provider_message_id: extracted.message_id,
          raw_carrier_status: extracted.status || "received",
          received_at: extracted.received_at || payload?.http_received_at || new Date().toISOString(),
          processed_by: "Manual Sender",
          source_app: "External API",
          trigger_name: "textgrid-inbound",
          inbound_from,
          inbound_to,
          prior_message_id,
          response_to_message_id,
          stage_before,
          metadata: { ...inbound_context_match_metadata, ...offer_ai_metadata },
        });
        inbound_message_event_id = inbound_event?.item_id || null;
      } else {
        inbound_message_event_id =
          (await resolveSupabaseInboundMessageEventId(extracted.message_id)) ||
          extracted.message_id ||
          null;
      }
      message_event_enriched = true;
    } catch (err) {
      emitInboundTrace("TEXTGRID_INBOUND_MESSAGE_EVENT_CREATE_ERROR", {
        message_id: extracted.message_id,
        inbound_from,
        inbound_to,
        error_message: err?.message || "unknown_message_event_create_error",
        error_stack: err?.stack || null,
      });
      return failStepAndReturn("textgrid_inbound_failed_message_event_create", err);
    }

    if (inbound_debug_stage === "after_message_event_create") {
      return { ok: true, stage: "after_message_event_create" };
    }

    // ── SEGMENT: conversation_resolution ─────────────────────────────────
    // Classify the message body, handle negative-reply cancellations, and
    // resolve the routing decision.
    let classification, inbound_is_negative, queue_cancellation, route, signals,
      deterministic_state, offer_routing;
    try {
      // Deterministic Auto Reply Intelligence V2 prerequisite: seller inbound
      // classification must never depend on live model inference. classify()
      // already exposes a heuristicOnly bypass (regex/keyword rules only,
      // zero I/O) — force it here so aiAssistClassification() is unreachable
      // from real seller traffic. Low-confidence heuristic output still flows
      // through unchanged; the deterministic downstream resolver already
      // routes low-confidence/unclear intents to human review.
      // Bind a short reply to the question it answers BEFORE the first
      // authoritative classification. Production incident 2026-08-03: the
      // ownership question was delivered and persisted, the seller replied
      // "Yeah", but no caller ever constructed conversation_context_v1 — so
      // classify() saw context_status:'unavailable', capped confidence at 0.72
      // via short_reply_without_validated_context, failed the 0.82 automation
      // gate and routed an unambiguous answer to human review. The context was
      // in the database the whole time.
      //
      // This is the live webhook's own construction, not a fallback inside
      // processSellerInboundMessage: that fallback is skipped precisely because
      // this handler already supplies a classification.
      let conversation_context = null;
      try {
        const context_supabase = runtimeDeps.getSupabaseClient?.();
        if (context_supabase && inbound_from) {
          // Deliberately NOT defaulting to now(): the scope-authorization
          // semantics elsewhere in this handler treat a missing received_at as
          // unknown, and buildConversationContext fails closed on a falsy value
          // rather than binding a reply to a fabricated timestamp.
          conversation_context = await runtimeDeps.buildConversationContext({
            thread_key: inbound_from,
            inbound_received_at: extracted?.received_at || payload?.http_received_at || null,
            supabase: context_supabase,
            canonical_stage: stage_before,
            // Exclude THIS inbound from the "has the question already been
            // answered?" scan. The builder's created_at window uses an
            // exclusive upper bound, which usually excludes the current
            // message on its own — but created_at is an insert timestamp, not
            // the carrier receipt time, so "usually" is not a guarantee. A
            // message that counted itself as its own prior answer would mark
            // the question answered and discard the context that binds it.
            current_inbound_event_id: inbound_message_event_id || null,
          });
        }
      } catch {
        // Context resolution is best-effort: classify() keeps its existing
        // `unavailable` behaviour rather than failing the webhook.
        conversation_context = null;
      }

      classification = await runtimeDeps.classify(message_body, brain_item, {
        heuristicOnly: true,
        conversation_context,
      });

      try {
        // Burst-fragment write restriction: while burst mode defers the
        // business decision, a non-safety fragment may only project
        // presentation/triage thread state — business-authoritative columns
        // (status/next_action/disposition/automation_state) wait for the
        // finalized aggregate. Safety-latched fragments keep the full
        // projection so immediate suppression state lands instantly.
        // Safety latch is evaluated for EVERY classified seller inbound: a
        // latched message (STOP / wrong number / hostile) keeps the full
        // immediate projection; everything else defers the decision-owned
        // columns to the seller decision spine, which is guaranteed to run
        // on this path (the unknown-inbound branch returned earlier) or the
        // webhook fails and the recovery cron re-runs it.
        const fragment_safety = detectImmediateSafetySignal({
          message: message_body,
          classification,
        });
        await syncClassifiedInboxThreadState({
          thread_key: inbound_from,
          seller_phone: inbound_from,
          our_number: inbound_to,
          master_owner_id,
          prospect_id,
          property_id,
          market: market_id,
          conversationStage: stage_before,
          classification,
          fragment_safe: seller_burst_enabled && !fragment_safety.latch,
          decision_fields_deferred: !fragment_safety.latch,
          messageEvent: {
            id: inbound_message_event_id,
            provider_message_sid: extracted.message_id,
            direction: "inbound",
            message_body,
            received_at: extracted.received_at || payload?.http_received_at || new Date().toISOString(),
            delivery_status: extracted.status || "received",
          },
          is_read: false,
          increment_direction: "inbound",
        }, {
          supabase: runtimeDeps.getSupabaseClient?.(),
        });
      } catch (patchErr) {
        safeWarn("inbox_thread_state_upsert_failed", { error: patchErr?.message || "unknown" });
      }

      signals = runtimeDeps.extractUnderwritingSignals({
        message: message_body,
        classification,
        route: null,
        context,
      });

      inbound_is_negative = runtimeDeps.isNegativeReply(message_body);
      queue_cancellation = null;

      if (inbound_is_negative && (master_owner_id || phone_item_id || inbound_from)) {
        const supabase_client = runtimeDeps.getSupabaseClient?.() || null;
        const supabase_queue_cancellation = supabase_client
          ? await runtimeDeps.cancelSupabasePendingOutbound(
              {
                thread_key: inbound_from,
                to_phone_number: inbound_from,
                phone_id: phone_item_id,
                master_owner_id,
                property_id,
                prospect_id,
                policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
                reason: "inbound_negative_reply",
                suppression_reason: "inbound_negative_reply",
                inbound_event_id: inbound_message_event_id || extracted.message_id,
                cancelled_by: "textgrid_inbound_negative_fast_path",
              },
              { supabase: supabase_client }
            )
          : { ok: false, cancelled: 0, reason: "missing_supabase_client" };

        queue_cancellation = await runtimeDeps.cancelPendingQueueItemsForOwner({
          master_owner_id,
          phone_item_id,
          reason: "inbound_negative_reply",
        });

        safeInfo("textgrid.inbound_negative_reply_queue_canceled", {
          message_id: extracted.message_id,
          inbound_from,
          master_owner_id,
          phone_item_id,
          supabase_cancelled_count: supabase_queue_cancellation?.cancelled ?? 0,
          podio_canceled_count: queue_cancellation?.canceled_count ?? 0,
          items_checked: queue_cancellation?.items_checked ?? 0,
        });
      }

      try {
        route = await runtimeDeps.resolveRoute({
          message_body,
          brain_item,
          classification,
        });
      } catch (routeErr) {
        throw routeErr;
      }

      signals = runtimeDeps.extractUnderwritingSignals({
        message: message_body,
        classification,
        route,
        context,
      });
      deterministic_state = runtimeDeps.buildInboundConversationState({
        context,
        classification,
        route,
        message: message_body,
        signals,
      });

      offer_routing = shouldBypassInboundOfferRouting({ classification, route })
        ? {
            ok: true,
            offer_route: "bypassed_existing_suppression",
            reason: "existing_compliance_or_wrong_number_route",
            meta: { bypassed: true },
          }
        : await runtimeDeps.routeInboundOffer({
            seller_message: message_body,
            message: message_body,
            classification,
            context,
            route,
            property: context.items?.property_item || null,
            owner: context.items?.master_owner_item || null,
            deal_strategy: route?.deal_strategy || context.summary?.deal_strategy || null,
          });
    } catch (err) {
      classification = {
        language: context?.summary?.language_preference || "English",
        source: "inbound_review_fallback",
        confidence: 0,
        notes: err?.message || "conversation_resolution_failed",
      };
      route = {
        stage: context?.summary?.conversation_stage || "unknown",
        use_case: null,
      };
      signals = {};
      deterministic_state = null;
      offer_routing = {
        ok: true,
        offer_route: "manual_review",
        reason: err?.message || "conversation_resolution_failed",
      };
      safeWarn("textgrid.inbound_conversation_resolution_degraded", {
        message_id: extracted.message_id,
        inbound_from,
        error: err?.message || "unknown",
      });
    }

    if (inbound_debug_stage === "after_conversation_resolution") {
      return { ok: true, stage: "after_conversation_resolution", route_stage: route?.stage || null, classification_source: classification?.source || null };
    }

    // ── SEGMENT: offer_stage_ai ──────────────────────────────────────
    // Wire in Offer Stage AI in dry-run mode for price/offer intent.
    try {
      const offerTrigger = runtimeDeps.isOfferStageTrigger
        ? runtimeDeps.isOfferStageTrigger({ message: message_body, classification, sellerStage: route?.stage || context?.summary?.conversation_stage || null, route })
        : { triggered: false, reason: "function_not_available" };

      if (offerTrigger.triggered) {
        const skipCheck = runtimeDeps.shouldSkipOfferStageAI
          ? runtimeDeps.shouldSkipOfferStageAI({ suppressionStatus: inbound_is_negative ? "opt_out" : "allowed", contactWindowStatus: "allowed" })
          : { skip: false, reason: null };

        if (!skipCheck.skip) {
          offer_stage_ai_result = await runtimeDeps.runOfferStageAI({
            message: message_body,
            property: context?.items?.property_item || null,
            conversationHistory: (context?.recent?.recent_events || []).slice(0, 10),
            sellerName: context?.summary?.owner_name || null,
            phone: inbound_from,
            sellerStage: route?.stage || context?.summary?.conversation_stage || null,
            suppressionStatus: inbound_is_negative ? "opt_out" : "allowed",
            contactWindowStatus: "allowed",
          });

          safeInfo("textgrid.inbound_offer_stage_ai", {
            message_id: extracted.message_id,
            inbound_from,
            triggered: offerTrigger.triggered,
            trigger_reason: offerTrigger.reason,
            dry_run: offer_stage_ai_result?.dry_run,
            blocked: offer_stage_ai_result?.blocked,
            blocked_reasons: offer_stage_ai_result?.blocked_reasons?.join(",") || null,
          });
        } else {
          offer_stage_ai_result = { ok: true, dry_run: true, skipped: true, skip_reason: skipCheck.reason };
        }
      }
    } catch (err) {
      safeWarn("textgrid.inbound_offer_stage_ai_failed", {
        message_id: extracted.message_id,
        inbound_from,
        error: err?.message || "unknown",
      });
      offer_stage_ai_result = { ok: false, dry_run: true, error: err?.message || "unknown" };
    }

    if (inbound_debug_stage === "after_offer_stage_ai") {
      return { ok: true, stage: "after_offer_stage_ai", offer_stage_ai_result };
    }

    // ── SEGMENT: prospect_resolution ──────────────────────────────────────
    // Write brain activity, master-owner timestamps, and stage/language/profile
    // updates in parallel.
    try {
      if (podio_business_writes_enabled) {
        await runtimeDeps.updateMasterOwnerAfterInbound({
          master_owner_id,
          received_at: new Date().toISOString(),
        });

        if (brain_id) {
          await runtimeDeps.updateBrainAfterInbound({
            brain_id,
            message_body,
            follow_up_trigger_state:
              deterministic_state?.follow_up_trigger_state || "AI Running",
            deterministic_state,
            extra_fields: {
              "master-owner": master_owner_id || undefined,
              prospect: prospect_id || undefined,
              ...(property_id ? { properties: [property_id] } : {}),
              ...(sms_agent_id ? { "sms-agent": sms_agent_id } : {}),
            },
          });
        }
      }
    } catch (err) {
      return failStepAndReturn("textgrid_inbound_failed_prospect_resolution", err);
    }

    if (inbound_debug_stage === "after_prospect_resolution") {
      return { ok: true, stage: "after_prospect_resolution", brain_id, master_owner_id };
    }

    // ── SEGMENT: market_resolution ────────────────────────────────────────
    // Fetch the latest open offer to determine offer-progression vs. creation.
    let existing_offer = null;
    try {
      if (podio_business_writes_enabled) {
        existing_offer = await runtimeDeps.findLatestOpenOffer({
          prospect_id,
          master_owner_id,
          property_id,
        });
      }
    } catch (err) {
      return failStepAndReturn("textgrid_inbound_failed_market_resolution", err);
    }

    if (inbound_debug_stage === "after_market_resolution") {
      return { ok: true, stage: "after_market_resolution", existing_offer_item_id: existing_offer?.item_id || null };
    }

    // ── SEGMENT: podio_write ──────────────────────────────────────────────
    // All offer, underwriting, contract, and pipeline writes happen here.
    let maybe_offer_progress, initial_offer, underwriting, seller_stage_reply,
      underwriting_follow_up, maybe_offer, active_offer_item_id,
      contract, pipeline, underwriting_transfer, autopilot_queue_row = null,
      seller_followup_result = { ok: false, skipped: true, reason: "not_attempted" },
      intelligence_snapshot = null,
      // Burst handoff provenance. Declared at THIS scope on purpose: the
      // deferred branch builds `seller_orchestration` inside a deeper block, so
      // its burst_id is unreachable from the result assembly below. Without
      // these the ledger marker is written with burst_id=null, which no burst
      // can ever adopt (finalizeBurstConstituentLedger matches the id exactly)
      // and which findInboundLedgerSlaBreaches excludes from the stuck scan —
      // a row parked forever, invisible to both watchdogs.
      deferred_burst = false,
      deferred_burst_id = null;

    try {
      const offer_route = offer_routing?.offer_route || null;
      const defer_immediate_offer_create = [
        "underwriting",
        "sfh_cash_preview",
        "condition_clarifier",
        "manual_review",
      ].includes(offer_route);

      if (podio_business_writes_enabled) {
        maybe_offer_progress = existing_offer
          ? await runtimeDeps.maybeProgressOfferStatus({
              offer_item_id: existing_offer.item_id,
              message: message_body,
              classification,
              notes: message_body,
            })
          : { ok: true, updated: false, reason: "no_existing_open_offer" };

        initial_offer = maybe_offer_progress?.updated
          ? {
              ok: true,
              created: false,
              reason: "existing_offer_progressed",
              existing_offer_item_id: existing_offer?.item_id || null,
              progress: maybe_offer_progress,
            }
          : defer_immediate_offer_create
            ? {
                ok: true,
                created: false,
                reason: `offer_route_${offer_route}_deferred`,
              }
          : await runtimeDeps.maybeCreateOfferFromContext({
              context,
              classification,
              route,
              message: message_body,
              notes: message_body,
              created_by: "Inbound Offer Engine",
            });

        underwriting_transfer = offer_route === "underwriting"
          ? await runtimeDeps.transferDealToUnderwriting({
              owner: context.items?.master_owner_item || null,
              property: context.items?.property_item || null,
              prospect: context.items?.prospect_item || null,
              phone: context.items?.phone_item || null,
              sellerMessage: message_body,
              routeReason: offer_routing?.reason || offer_routing?.meta?.underwriting_reason || "offer_route_underwriting",
              dealStrategy: route?.deal_strategy || context.summary?.deal_strategy || null,
              sourceMessageEventId: inbound_message_event_id,
            })
          : null;
      } else {
        maybe_offer_progress = { ok: true, updated: false, reason: "podio_sync_disabled" };
        initial_offer = { ok: true, created: false, reason: "podio_sync_disabled" };
        underwriting_transfer = null;
      }

      underwriting = podio_business_writes_enabled
        ? await runtimeDeps.maybeUpsertUnderwritingFromInbound({
            context,
            classification,
            route,
            message: message_body,
            offer_item_id:
              initial_offer?.offer?.offer_item_id ||
              initial_offer?.existing_offer_item_id ||
              existing_offer?.item_id ||
              null,
            source_channel: "SMS",
            notes: message_body,
          })
        : { ok: true, skipped: true, reason: "podio_sync_disabled" };

      // Authorization timestamp: the message's ACTUAL receipt time, never a
      // synthesized one. Stamping new Date() here would let a message with no
      // provider/ingress timestamp — a diagnostics replay of an old inbound,
      // for instance — clear a cutoff configured in the past. Null is the
      // honest answer and the scope gate denies it.
      const scope_received_at = extracted.received_at || payload?.http_received_at || null;

      const auto_reply_scope_config =
        auto_reply_mode_final === "live_limited"
          ? await resolveAutoReplyScopeConfig({ getSystemValue: runtimeDeps.getSystemValue })
          : { cutoffAt: null, threadAllowlist: null };

      const queue_permission = autoReplyModeAllowsQueue({
        mode: auto_reply_mode_final,
        inboundFrom: inbound_from,
        threadKey: inbound_from,
        inboundReceivedAt: scope_received_at,
        cutoffAt: auto_reply_scope_config.cutoffAt,
        threadAllowlist: auto_reply_scope_config.threadAllowlist,
      });
      const execution_allowed = Boolean(
        inbound_auto_reply_queue_enabled && queue_permission.allowed
      );

      // ── SEGMENT: auto-reply live cap ─────────────────────────────────────
      // Cap live auto-replies at AUTO_REPLY_LIVE_CAP (default 5) for Phase 8 validation.
      let cap_reached = false;
      const auto_reply_live_cap = asPositiveInt(process.env.AUTO_REPLY_LIVE_CAP, 5);
      if (auto_reply_live_cap > 0 && inbound_autopilot_enabled) {
        try {
          const supabase = runtimeDeps.getSupabaseClient?.();
          if (supabase) {
            const todayStart = new Date();
            todayStart.setUTCHours(0, 0, 0, 0);
            const { count } = await supabase
              .from("send_queue")
              .select("id", { count: "exact", head: true })
              .eq("metadata->>action_type", "autopilot_inbound_reply")
              .gte("created_at", todayStart.toISOString());
            cap_reached = (count || 0) >= auto_reply_live_cap;
            if (cap_reached) {
              safeWarn("textgrid.inbound_auto_reply_cap_reached", {
                message_id: extracted.message_id,
                inbound_from,
                cap: auto_reply_live_cap,
                count: count || 0,
              });
            }
          }
        } catch (capErr) {
          safeWarn("textgrid.inbound_auto_reply_cap_check_failed", {
            message_id: extracted.message_id,
            error: capErr?.message || "unknown",
          });
        }
      }

      const autopilot_schedule = runtimeDeps.buildInboundAutopilotSchedule(
        inbound_autopilot_delay_seconds,
        new Date().toISOString()
      );
      const autopilot_queue_overrides = deriveInboundAutopilotQueueOverrides({
        autopilot_schedule,
        context,
      });

      const seller_flow_execution_allowed =
        execution_allowed && !cap_reached && offer_route !== "manual_review";

      // Presentation/timing value — safe to synthesize, because burst debounce
      // windows and persisted rows need a concrete instant. It must never be
      // used as a scope-authorization input; scope_received_at is that value.
      const inbound_received_at = scope_received_at || new Date().toISOString();
      const inbound_to_resolved =
        extracted.to ||
        context?.summary?.inbound_to ||
        context?.summary?.textgrid_number ||
        inbound_to;

      // Durable burst/debounce: every raw message is already persisted above.
      // When enabled, defer processSellerInboundMessage until the quiet window
      // closes (or immediate safety forces a suppressed finalize).
      let seller_orchestration = null;
      let burst_deferral = null;

      if (seller_burst_enabled) {
        // Fail closed: burst enabled + burst infrastructure unavailable must
        // error the webhook so the provider redelivers. The coordinator
        // dependency missing can never fall through to the per-message V2
        // path below.
        if (typeof runtimeDeps.createSellerInboundBurstCoordinator !== "function") {
          throw new Error("seller_inbound_burst_coordinator_unavailable");
        }
        const supabase_for_burst = runtimeDeps.getSupabaseClient?.() || null;
        const burst_coordinator = runtimeDeps.createSellerInboundBurstCoordinator({
          supabase: supabase_for_burst,
          processSellerInboundMessage: runtimeDeps.processSellerInboundMessage,
          cancelPendingOutbound: async (args) => {
            if (!supabase_for_burst) return { ok: false, cancelled: 0, reason: "no_supabase" };
            return runtimeDeps.cancelSupabasePendingOutbound(
              {
                thread_key: args.thread_key,
                to_phone_number: args.thread_key,
                phone_id: phone_item_id,
                master_owner_id,
                property_id,
                prospect_id,
                reason: args.reason,
                inbound_event_id: args.inbound_event_id,
                cancelled_by: "seller_inbound_burst",
                // Scope-correct policy mapping: safety latches cancel every
                // outbound type (compliance_terminal); a benign new inbound
                // cancels only automated reply/follow-up rows
                // (inbound_takeover). The old `undefined` fall-through landed
                // on the compliance default and cancelled unrelated campaign
                // touches on every inbound fragment.
                policy:
                  args.policy === "compliance_terminal"
                    ? CANCELLATION_POLICIES.COMPLIANCE_TERMINAL
                    : CANCELLATION_POLICIES.INBOUND_TAKEOVER,
                // Arms the supersession guard: never cancel a reply that was
                // queued for a NEWER inbound than the one cancelling.
                inbound_received_at: args.inbound_received_at || null,
              },
              { supabase: supabase_for_burst }
            );
          },
          cancelPendingFollowUps: async (args) =>
            runtimeDeps.cancelPendingFollowUpsForThread({
              thread_key: args.thread_key,
              reason: args.reason,
              inbound_event_id: args.inbound_event_id,
              supabase: supabase_for_burst,
            }),
          worker_id: "textgrid_inbound",
          // internal_proof carries the session's bounds; global activation
          // keeps asserting `enabled: true`. Never both, and never a bare
          // global assertion while a scope exists.
          ...(seller_burst_activation_scope
            ? { activation_scope: seller_burst_activation_scope }
            : { enabled: true }),
        });

        const orchestration_context = {
          propertyId: property_id,
          prospectId: prospect_id,
          ownerId: master_owner_id,
          phoneId: phone_item_id,
          conversationBrain: brain_item,
          context,
          route,
          inboundTo: inbound_to_resolved,
          stageBefore: stage_before,
          autoReplyMode: auto_reply_mode_final,
          executionAllowed: seller_flow_execution_allowed,
          systemFollowupEnabled: system_followup_enabled,
          inboundAutopilotDelaySeconds: inbound_autopilot_delay_seconds,
          timezoneOverride: autopilot_queue_overrides.timezone_label,
          contactWindowOverride: autopilot_queue_overrides.contact_window,
          dryRun: Boolean(dry_run),
          underwritingSignals: signals,
          recentOutbound: latest_outbound_event,
          supabaseClient: supabase_for_burst,
          getSystemValue: runtimeDeps.getSystemValue,
        };

        // Durable thread suppression (e.g. prior STOP) must latch every later
        // fragment so a benign message cannot open a reply-capable generation.
        let prior_thread_suppressed = false;
        try {
          if (supabase_for_burst) {
            const { data: suppress_row } = await supabase_for_burst
              .from("inbox_thread_state")
              .select("is_suppressed")
              .eq("thread_key", inbound_from)
              .limit(1)
              .maybeSingle();
            prior_thread_suppressed = suppress_row?.is_suppressed === true;
          }
        } catch {
          prior_thread_suppressed = false;
        }

        burst_deferral = await burst_coordinator.onPersistedInbound({
          thread_key: inbound_from,
          event_id: inbound_message_event_id || extracted.message_id,
          provider_message_id: extracted.message_id,
          body: message_body,
          // Nullable on purpose: the coordinator synthesizes its own instant for
          // debounce timing, but must not inherit a synthesized authorization time.
          received_at: scope_received_at,
          classification,
          orchestration_context,
          prior_thread_suppressed,
        });

        // Fail closed: if durable burst ingestion could not accept the message
        // (store unavailable, rollover append exhausted), error the webhook so
        // the provider redelivers. Never silently swallow the message and
        // never fall back to a per-message auto-reply while burst mode is on.
        if (burst_deferral && burst_deferral.ok === false) {
          throw new Error(
            burst_deferral.reason || "seller_inbound_burst_ingestion_failed"
          );
        }

        if (burst_deferral?.flush?.orchestration) {
          seller_orchestration = burst_deferral.flush.orchestration;
        } else if (burst_deferral?.deferred) {
          // Decision deferred to burst flush — no per-message auto-reply.
          // Lift the association out to result scope: the ledger marker is
          // worthless without the exact burst id that will later settle it.
          deferred_burst = true;
          deferred_burst_id = burst_deferral?.append?.burst?.burst_id || null;
          seller_orchestration = {
            ok: true,
            deferred_burst: true,
            burst_id: burst_deferral?.append?.burst?.burst_id || null,
            generation: burst_deferral?.append?.burst?.generation || null,
            queued: false,
            followup_scheduled: false,
            follow_up: { ok: true, skipped: true, reason: "deferred_to_burst_flush" },
            seller_stage_reply: {
              queued: false,
              reason: "deferred_to_burst_flush",
              plan: { should_queue_reply: false, selected_use_case: null },
            },
            intelligence_snapshot: {
              canonical_intent: classification?.primary_intent || null,
              canonical_decision: {
                should_queue_reply: false,
                audit_reason: burst_deferral?.safety?.latch
                  ? `burst_safety_${burst_deferral.safety.kind || "terminal"}`
                  : "deferred_to_burst_flush",
              },
              execution_blocked_reason: burst_deferral?.safety?.latch
                ? `burst_safety_${burst_deferral.safety.kind || "terminal"}`
                : "deferred_to_burst_flush",
            },
            effective_action: burst_deferral?.safety?.latch
              ? "suppressed"
              : "burst_deferred",
          };
          safeInfo("seller_inbound_burst.deferred", {
            message_id: extracted.message_id,
            inbound_from,
            burst_id: burst_deferral?.append?.burst?.burst_id || null,
            generation: burst_deferral?.append?.burst?.generation || null,
            safety_latched: Boolean(burst_deferral?.safety?.latch),
            eligible_at: burst_deferral?.append?.burst?.eligible_at || null,
          });
        }
      }

      // Burst invariant: while burst mode is enabled the deferral above must
      // have produced an orchestration result — the legacy per-message V2
      // fallback below is only reachable when burst mode is disabled.
      //
      // EXCEPTION: the burst layer may explicitly DECLINE a message whose
      // thread the activation scope does not authorize, or whose open
      // generation is out of scope (internal_proof mode). A decline is not a
      // failure and must not redeliver — the burst layer never took custody, so
      // the per-message path below owns the message exactly as it does when
      // burst mode is off. Without this, a declined message either throws into
      // an endless provider-redelivery loop or is silently swallowed.
      if (seller_burst_enabled && !seller_orchestration && !burst_deferral?.declined) {
        throw new Error("seller_inbound_burst_orchestration_missing");
      }
      if (burst_deferral?.declined) {
        safeInfo("textgrid.inbound_burst_declined_falling_back", {
          message_id: extracted.message_id,
          inbound_from,
          reason: burst_deferral.reason || "burst_append_refused",
          blocking_burst_id: burst_deferral.blocking_burst_id || null,
        });
      }

      if (!seller_orchestration) {
        seller_orchestration = await runtimeDeps.processSellerInboundMessage({
          message: message_body,
          threadKey: inbound_from,
          propertyId: property_id,
          prospectId: prospect_id,
          ownerId: master_owner_id,
          phoneId: phone_item_id,
          classification,
          conversationBrain: brain_item,
          context,
          route,
          inboundFrom: inbound_from,
          inboundTo: inbound_to_resolved,
          inboundEventId: inbound_message_event_id || extracted.message_id,
          // Scope authorization input — the un-synthesized receipt time.
          inboundReceivedAt: scope_received_at,
          providerMessageId: extracted.message_id,
          stageBefore: stage_before,
          autoReplyMode: auto_reply_mode_final,
          executionAllowed: seller_flow_execution_allowed,
          systemFollowupEnabled: system_followup_enabled,
          inboundAutopilotDelaySeconds: inbound_autopilot_delay_seconds,
          timezoneOverride: autopilot_queue_overrides.timezone_label,
          contactWindowOverride: autopilot_queue_overrides.contact_window,
          dryRun: Boolean(dry_run),
          applySuppression: true,
          underwritingSignals: signals,
          recentOutbound: latest_outbound_event,
          supabaseClient: runtimeDeps.getSupabaseClient?.(),
          getSystemValue: runtimeDeps.getSystemValue,
        });
      }

      const auto_reply_plan = seller_orchestration?.seller_stage_reply?.plan || {};
      seller_stage_reply = seller_orchestration?.seller_stage_reply || null;
      intelligence_snapshot = seller_orchestration?.intelligence_snapshot || null;
      seller_followup_result = seller_orchestration?.follow_up || {
        ok: true,
        skipped: true,
        reason: "not_attempted",
      };

      // ── SEGMENT: auto-reply decision log ────────────────────────────────────
      // Structured log for every auto-reply decision — sent, blocked, and followup.
      safeInfo("auto_reply_decision", {
        inbound_id: extracted.message_id,
        inbound_from,
        intent: intelligence_snapshot?.canonical_intent || auto_reply_plan.inbound_intent,
        language: auto_reply_plan.selected_language || classification?.language || null,
        confidence: classification?.confidence ?? null,
        selected_template_id:
          intelligence_snapshot?.selected_template?.template_id ||
          auto_reply_plan.selected_template_id ||
          null,
        should_queue_reply: intelligence_snapshot?.canonical_decision?.should_queue_reply,
        blocked_reason:
          intelligence_snapshot?.execution_blocked_reason ||
          auto_reply_plan.suppression_reason ||
          null,
        cap_reached,
        auto_reply_mode: auto_reply_mode_final,
        auto_reply_mode_source: auto_reply_mode_resolution.source,
        auto_reply_queue_enabled: inbound_auto_reply_queue_enabled,
        execution_allowed,
        intelligence_only: !execution_allowed,
        followup_scheduled: Boolean(seller_followup_result?.followup_created),
        followup_scheduled_for: seller_followup_result?.scheduled_for || null,
        followup_reason: seller_followup_result?.reason || null,
        shadow_followup_recommendation: intelligence_snapshot?.follow_up_recommendation || null,
        system_followup_enabled,
      });

      let explicit_use_case = auto_reply_plan.selected_use_case;
      let explicit_template_lookup_use_case = auto_reply_plan.selected_use_case;
      let extra_template_render_overrides = {};
      let extra_queue_context = {
        auto_reply_plan,
        inbound_message_event_id,
        autopilot_reply: true,
        autopilot_override_window_seconds: inbound_autopilot_delay_seconds,
        discord_review_status: auto_reply_plan.should_queue_reply ? "autopilot_pending" : "manual_review_required",
        action_type: "autopilot_inbound_reply",
      };

      const is_preview = !auto_reply_plan.should_queue_reply;
      let cash_offer_snapshot_id = null;
      if (offer_route === "sfh_cash_preview") {
        explicit_use_case = "offer_reveal_cash";
        explicit_template_lookup_use_case = "offer_reveal_cash";
        const cash_offer = offer_routing?.meta?.cash_offer ?? null;
        cash_offer_snapshot_id = offer_routing?.meta?.snapshot_id ?? null;
        extra_template_render_overrides = {
          offer_price: formatOfferCurrency(cash_offer),
          smart_cash_offer_display: formatOfferCurrency(cash_offer),
        };
        extra_queue_context.offer_route = offer_route;
        extra_queue_context.cash_offer_amount = cash_offer;
        extra_queue_context.cash_offer_snapshot_id = cash_offer_snapshot_id;
      } else if (offer_route === "condition_clarifier") {
        explicit_use_case = "ask_condition_clarifier";
        explicit_template_lookup_use_case = "ask_condition_clarifier";
        extra_queue_context.offer_route = offer_route;
        extra_queue_context.condition_clarifier_reason = offer_routing?.reason || null;
      } else if (offer_route === "manual_review") {
        seller_stage_reply = {
          ...(seller_stage_reply || {}),
          queued: false,
          reason: "offer_manual_review_no_auto_send",
        };
        extra_queue_context.offer_route = offer_route;
        extra_queue_context.offer_manual_review = true;

        runtimeDeps.warn("textgrid.inbound_offer_manual_review", {
          message_id: extracted.message_id,
          inbound_from,
          master_owner_id,
          property_id,
          offer_route_reason: offer_routing?.reason || null,
        });
      }

      if (seller_orchestration?.execution?.queued) {
        const auto_reply_execution = seller_orchestration.execution;
        extra_queue_context = {
          ...extra_queue_context,
          auto_reply_mode: auto_reply_mode_final,
          auto_reply_mode_source: auto_reply_mode_resolution.source,
          automation_decision:
            auto_reply_execution?.automation_decision ||
            intelligence_snapshot?.canonical_decision ||
            seller_orchestration?.decision?.automation_decision ||
            null,
          human_review_required: Boolean(
            auto_reply_execution?.automation_decision?.should_mark_human_review ||
              intelligence_snapshot?.canonical_decision?.should_mark_human_review
          ),
          intelligence_snapshot,
          seller_flow_decision: seller_orchestration?.decision || null,
        };

        autopilot_queue_row = {
          id: auto_reply_execution.queue_row_id,
          queue_status: "queued",
          scheduled_for: auto_reply_execution.queue_result?.raw?.scheduled_for || null,
          scheduled_for_utc: auto_reply_execution.queue_result?.raw?.scheduled_for_utc || null,
          scheduled_for_local: auto_reply_execution.queue_result?.raw?.scheduled_for_local || null,
          metadata: { ...extra_queue_context, action_type: "autopilot_inbound_reply" },
        };
      }

      if (podio_business_writes_enabled && shouldCreateBrainForInbound({ brain_id, seller_stage_reply, context, route })) {
        brain_item = await runtimeDeps.createBrain({
          master_owner_id,
          prospect_id,
          property_id,
          phone_item_id,
        });
        brain_id = brain_item?.item_id || null;

        if (brain_id) {
          context.items = {
            ...(context.items || {}),
            brain_item,
          };
          context.ids = {
            ...(context.ids || {}),
            brain_item_id: brain_id,
          };
          context.summary = {
            ...(context.summary || {}),
            brain_item_id: brain_id,
          };

          await runtimeDeps.updateBrainAfterInbound({
            brain_id,
            message_body,
            follow_up_trigger_state:
              deterministic_state?.follow_up_trigger_state || "AI Running",
            deterministic_state,
            extra_fields: {
              "master-owner": master_owner_id || undefined,
              prospect: prospect_id || undefined,
              ...(property_id ? { properties: [property_id] } : {}),
              ...(sms_agent_id ? { "sms-agent": sms_agent_id } : {}),
            },
          });
        }
      }

      if (podio_business_writes_enabled && seller_stage_reply?.brain_stage && brain_id) {
        await runtimeDeps.updateBrainStage({ brain_id, stage: seller_stage_reply.brain_stage });
      }

      underwriting_follow_up = !inbound_autopilot_enabled
        ? { ok: true, queued: false, reason: "manual_review_required" }
        : !system_followup_enabled
        ? { ok: true, queued: false, reason: "system_control_disabled" }
        : auto_reply_plan?.should_queue_reply
        ? { ok: true, queued: false, reason: "suppressed_by_auto_reply_plan" }
        : podio_business_writes_enabled
          ? await runtimeDeps.maybeQueueUnderwritingFollowUp({
              inbound_from,
              underwriting,
              classification,
              route,
              context,
              message: message_body,
            })
          : { ok: true, queued: false, reason: "podio_sync_disabled" };

      const underwriting_offer_ready =
        underwriting?.strategy?.auto_offer_ready === true ||
        underwriting?.signals?.underwriting_auto_offer_ready === true ||
        underwriting_follow_up?.offer_ready === true;

      maybe_offer =
        !podio_business_writes_enabled ||
        defer_immediate_offer_create ||
        initial_offer?.created ||
        initial_offer?.existing_offer_item_id ||
        !underwriting_offer_ready
          ? initial_offer
          : await runtimeDeps.maybeCreateOfferFromContext({
              context,
              classification,
              route,
              message: message_body,
              notes: message_body,
              created_by: "Underwriting Offer Engine",
              respect_underwriting_gate: false,
            });

      const suggested_reply_preview = seller_stage_reply?.rendered_text || "";
      // Replaced by auto_reply_plan + seller_stage_reply single pass

      active_offer_item_id =
        maybe_offer?.offer?.offer_item_id ||
        maybe_offer?.existing_offer_item_id ||
        initial_offer?.offer?.offer_item_id ||
        initial_offer?.existing_offer_item_id ||
        existing_offer?.item_id ||
        null;

      contract = podio_business_writes_enabled
        ? await runtimeDeps.maybeCreateContractFromAcceptedOffer({
            offer_item: existing_offer || null,
            offer_item_id: active_offer_item_id,
            offer_progress: maybe_offer_progress,
            context,
            route,
            underwriting,
            notes: message_body,
            source_message: message_body,
            auto_send: false,
            dry_run: false,
          })
        : null;

      pipeline = podio_business_writes_enabled
        ? await runtimeDeps.syncPipelineState({
            create_if_missing: shouldCreatePipelineForInbound({
              seller_stage_reply,
              route,
              active_offer_item_id,
              contract_item_id: contract?.contract_item_id || null,
            }),
            property_id,
            master_owner_id,
            prospect_id,
            conversation_item_id: brain_id,
            offer_item_id: active_offer_item_id,
            contract_item_id: contract?.contract_item_id || null,
            notes: `Inbound SMS processed${route?.stage ? ` at stage ${route.stage}` : ""}.`,
          })
        : null;

      if (inbound_message_event_id) {
        const suggested_reply_preview = seller_stage_reply?.rendered_text || "";
        const selected_template_id = seller_stage_reply?.template_id || null;
        const selected_template_source =
          seller_stage_reply?.preview_result?.selected_template_source ||
          seller_stage_reply?.queue_result?.raw?.template_source ||
          "sms_templates";
        const outbound_queue_id = autopilot_queue_row?.id || seller_stage_reply?.queue_row_id || null;
        const automation_decision = extractAutomationDecisionFromSellerStageReply(seller_stage_reply);
        const human_review_required = deriveHumanReviewRequired(seller_stage_reply);
        const auto_reply_status = deriveAutoReplyStatus({
          seller_stage_reply,
          auto_reply_mode: auto_reply_mode_final,
          enabled: inbound_autopilot_enabled,
        });
        const context_incomplete = Boolean(
          !context?.summary?.property_address || !context?.ids?.master_owner_id || !context?.ids?.property_id
        );
        const discord_review_status = outbound_queue_id && inbound_autopilot_enabled
          ? "autopilot_pending"
          : clean(suggested_reply_preview)
            ? "manual_review_required"
            : "manual_review_required";

        let discord_card = {
          ok: true,
          skipped: !inbound_autopilot_post_discord_card,
          reason: inbound_autopilot_post_discord_card ? null : "discord_card_disabled",
        };

        if (inbound_autopilot_post_discord_card) {
          discord_card = await postInboundDiscordReviewCard({
            runtimeDeps,
            message_event_id: inbound_message_event_id,
            inbound_from,
            message_body,
            context,
            classification,
            route,
            seller_stage_reply,
            inbound_autopilot_enabled: Boolean(inbound_autopilot_enabled && outbound_queue_id),
            inbound_autopilot_delay_seconds,
            outbound_queue_id,
            context_incomplete,
            existing_metadata: {},
          }).catch((error) => ({
            ok: false,
            reason: "discord_card_post_failed",
            error: error?.message || "discord_card_post_failed",
          }));
        }

        const discord_card_error = !discord_card?.ok
          ? clean(discord_card?.error || discord_card?.reason || "discord_card_post_failed")
          : null;

        if (discord_card_error) {
          safeWarn("textgrid.inbound_discord_card_failed", {
            message_id: extracted.message_id,
            inbound_from,
            message_event_id: inbound_message_event_id,
            discord_card_error,
          });
        }
        const intelligence_patch = buildIntelligenceMessageEventPatch(
          seller_stage_reply?.intelligence_snapshot || intelligence_snapshot
        );
        const authoritative_intent =
          intelligence_patch.detected_intent ||
          seller_stage_reply?.plan?.inbound_intent ||
          seller_stage_reply?.plan?.detected_intent ||
          classification?.primary_intent ||
          classification?.detected_intent ||
          "unclear";

        if (podio_business_writes_enabled) {
          await runtimeDeps.logInboundMessageEvent({
            record_item_id: inbound_message_event_id,
            brain_item,
            conversation_item_id: brain_id,
            master_owner_id,
            prospect_id,
            property_id,
            market_id,
            phone_item_id,
            inbound_number_item_id,
            sms_agent_id,
            property_address,
            message_body,
            provider_message_id: extracted.message_id,
            raw_carrier_status: extracted.status || "received",
            received_at:
              extracted.received_at ||
              payload?.http_received_at ||
              new Date().toISOString(),
            processed_by: "Manual Sender",
            source_app: "External API",
            trigger_name: "textgrid-inbound",
            inbound_from,
            inbound_to,
            prior_message_id,
          response_to_message_id,
          stage_before,
          current_stage: intelligence_patch.current_stage || route?.stage || null,
          stage_after:
            intelligence_patch.stage_after ||
            seller_stage_reply?.brain_stage ||
            deterministic_state?.conversation_stage ||
            route?.stage ||
            null,
          is_opt_out:
            authoritative_intent === "opt_out" ||
            seller_stage_reply?.plan?.selected_use_case === SELLER_FLOW_STAGES.STOP_OR_OPT_OUT ||
            inbound_is_negative,
          detected_intent: authoritative_intent,
          priority: classification?.priority || "normal",
          risk: classification?.risk || "low",
          safety_status: intelligence_patch.safety_status || classification?.safety_status || "review",
          auto_reply_status: outbound_queue_id ? auto_reply_status : intelligence_patch.auto_reply_status || auto_reply_status,
          auto_reply_queue_id: outbound_queue_id,
          human_review_required: intelligence_patch.human_review_required ?? human_review_required,
          needs_human_review: intelligence_patch.needs_human_review ?? human_review_required,
          automation_decision: intelligence_patch.automation_decision || automation_decision,
          routing_allowed: intelligence_patch.routing_allowed ?? seller_stage_reply?.plan?.routing_allowed ?? true,
          language: classification?.language || null,
          classification_confidence:
            intelligence_patch.classification_confidence ??
            classification?.confidence ??
            0,
          metadata: {
             ...inbound_context_match_metadata,
             ...intelligence_patch.metadata,
             detected_intent: authoritative_intent,
             sentiment: classification?.emotion || null,
             seller_stage:
               intelligence_patch.current_stage ||
               route?.stage ||
               deterministic_state?.conversation_stage ||
               null,
             conversation_stage:
               intelligence_patch.current_stage ||
               deterministic_state?.conversation_stage ||
               route?.stage ||
               null,
             classification_confidence:
               intelligence_patch.classification_confidence ??
               classification?.confidence ??
               null,
             needs_human_review:
               intelligence_patch.needs_human_review ??
               human_review_required,
             is_hot_lead: ['interested', 'offer_request', 'price_inquiry', 'maybe_interested'].includes(classification?.objection),
             is_dnc: ['stop_texting', 'opt_out', 'wrong_person'].includes(classification?.compliance_flag) || classification?.objection === 'not_interested',
             is_wrong_number:
               authoritative_intent === "wrong_number" &&
               intelligence_snapshot?.suppression_scope !== "property" &&
               intelligence_snapshot?.invalidate_phone_globally !== false,
             is_property_scoped_non_owner:
               intelligence_snapshot?.suppression_scope === "property" ||
               ["non_owner_referral", "property_specific_non_owner"].includes(authoritative_intent),
             is_not_interested: classification?.objection === 'not_interested',
             language: classification?.language || "English",
             next_action:
               intelligence_snapshot?.recommended_use_case ||
               route?.use_case ||
               seller_stage_reply?.plan?.selected_use_case ||
               null,
             priority: classification?.priority || "normal",
             risk: classification?.risk || "low",
             routing_allowed: intelligence_patch.routing_allowed ?? true,
             safety_status: intelligence_patch.safety_status || "review",
             auto_reply_status: outbound_queue_id ? auto_reply_status : intelligence_patch.auto_reply_status || "shadow_only",
             auto_reply_queue_id: outbound_queue_id,
             automation_decision: intelligence_patch.automation_decision || automation_decision,
             human_review_required: intelligence_patch.human_review_required ?? human_review_required,
             classification,
             classification_source: classification?.source || null,
             classification_result: authoritative_intent,
             route_stage: route?.stage || null,
             route_use_case: route?.use_case || null,
             seller_stage_use_case:
               intelligence_snapshot?.recommended_use_case ||
               seller_stage_reply?.plan?.selected_use_case ||
               null,
            ...buildDiscordReviewMetadata({
              autopilot_enabled: Boolean(inbound_autopilot_enabled && outbound_queue_id),
              autopilot_delay_seconds: inbound_autopilot_delay_seconds,
              suggested_reply_preview,
              selected_template_id,
              selected_template_source,
              outbound_queue_id,
              discord_review_status,
              discord_card_error,
              post_result: discord_card,
              existing_metadata: {},
              context_incomplete,
            }),
            offer_route: offer_routing?.offer_route || null,
            offer_route_reason: offer_routing?.reason || null,
            underwriting_route_reason:
              offer_routing?.offer_route === "underwriting"
                ? offer_routing?.reason || null
                : null,
            second_pass_authoritative: true,
          },
        });
        }
        try {
          const supabase_payload = {
            message_id: extracted.message_id,
            provider_message_sid: extracted.message_id,
            from: inbound_from,
            to: inbound_to,
            message_body,
            detected_intent: authoritative_intent,
            priority: classification?.priority || "normal",
            risk: classification?.risk || "low",
            safety_status: intelligence_patch.safety_status || "review",
            routing_allowed: intelligence_patch.routing_allowed ?? true,
            auto_reply_status: outbound_queue_id ? auto_reply_status : intelligence_patch.auto_reply_status || "shadow_only",
            auto_reply_queue_id: outbound_queue_id,
            human_review_required: intelligence_patch.human_review_required ?? human_review_required,
            needs_human_review: intelligence_patch.needs_human_review ?? human_review_required,
            automation_decision: intelligence_patch.automation_decision || automation_decision,
            language: classification?.language || null,
            classification_confidence:
              intelligence_patch.classification_confidence ??
              classification?.confidence ??
              0,
            stage_before,
            stage_after:
              intelligence_patch.stage_after ||
              seller_stage_reply?.brain_stage ||
              deterministic_state?.conversation_stage ||
              route?.stage ||
              null,
            master_owner_id,
            prospect_id,
            property_id,
            market: payload?.market || null,
            metadata: {
              ...(classification || {}),
              ...(intelligence_patch.metadata || {}),
              route_stage: route?.stage || null,
              use_case: route?.use_case || null,
              seller_stage_reply_reason: seller_stage_reply?.reason || null,
              second_pass_authoritative: true,
            },
          };

          await runtimeDeps.logInboundMessageEventSupabase(supabase_payload);
        } catch (supaErr) {
          safeWarn("textgrid.inbound_supabase_update_failed", {
            message_id: extracted.message_id,
            error: supaErr?.message || "unknown",
          });
        }
      }
    } catch (err) {
      return failStepAndReturn("textgrid_inbound_failed_podio_write", err);
    }

    if (inbound_debug_stage === "after_podio_write") {
      return { ok: true, stage: "after_podio_write", pipeline_item_id: pipeline?.pipeline_item_id || null };
    }

    safeInfo("textgrid.inbound_processed", {
      message_id: extracted.message_id,
      inbound_from,
      brain_id,
      master_owner_id,
      prospect_id,
      property_id,
      inbound_is_negative,
      queue_canceled_count: queue_cancellation?.canceled_count ?? null,
      classification_source: classification?.source || null,
      route_stage: route?.stage || null,
      route_use_case: route?.use_case || null,
      existing_offer_item_id: existing_offer?.item_id || null,
      offer_progressed: Boolean(maybe_offer_progress?.updated),
      offer_created: Boolean(maybe_offer?.created),
      offer_item_id: active_offer_item_id,
      underwriting_extracted: Boolean(underwriting?.extracted),
      underwriting_created: Boolean(underwriting?.created),
      underwriting_updated: Boolean(underwriting?.updated),
      underwriting_item_id: underwriting?.underwriting_item_id || null,
      seller_stage_reply_queued: Boolean(seller_stage_reply?.queued),
      seller_stage_reply_reason: seller_stage_reply?.reason || null,
      seller_stage_use_case: seller_stage_reply?.plan?.selected_use_case || null,
      offer_route: offer_routing?.offer_route || null,
      offer_route_reason: offer_routing?.reason || null,
      underwriting_route_reason:
        offer_routing?.offer_route === "underwriting"
          ? offer_routing?.reason || null
          : null,
    });

    await runtimeDeps.notifyDiscordOps({
      event_type: inbound_is_negative ? "inbound_not_lead" : "inbound_known_reply",
      severity: inbound_is_negative ? "warning" : "info",
      domain: "inbound",
      title: inbound_is_negative ? "Inbound Reply (Not Lead)" : "Inbound Reply (Known Contact)",
      summary: `from=${inbound_from} stage=${route?.stage || "unknown"}`,
      fields: [
        { name: "Route Stage", value: route?.stage || "unknown", inline: true },
        { name: "Use Case", value: route?.use_case || "unknown", inline: true },
        { name: "Offer Created", value: String(Boolean(maybe_offer?.created)), inline: true },
      ],
      metadata: {
        message_id: extracted.message_id,
        master_owner_id,
        prospect_id,
        property_id,
      },
    });

    if (Boolean(maybe_offer?.created) || Boolean(maybe_offer_progress?.updated) || Boolean(contract?.created)) {
      await runtimeDeps.notifyDiscordOps({
        event_type: "inbound_hot_lead",
        severity: "hot",
        domain: "deal_flow",
        title: "Inbound Hot Lead Signal",
        summary: `Inbound advanced deal flow (offer=${Boolean(maybe_offer?.created)}, progress=${Boolean(maybe_offer_progress?.updated)}, contract=${Boolean(contract?.created)})`,
        fields: [
          { name: "From", value: inbound_from, inline: true },
          { name: "Stage", value: route?.stage || "unknown", inline: true },
          { name: "Property", value: property_address || "n/a", inline: false },
        ],
        metadata: {
          master_owner_id,
          prospect_id,
          property_id,
        },
      });
    }

    if (seller_stage_reply?.plan?.selected_use_case === SELLER_FLOW_STAGES.WRONG_PERSON) {
      await runtimeDeps.notifyDiscordOps({
        event_type: "wrong_number",
        severity: "warning",
        domain: "inbound",
        title: "Wrong Number Reply",
        summary: `Known contact indicated wrong person: ${inbound_from}`,
        metadata: {
          message_id: extracted.message_id,
          route_use_case: seller_stage_reply?.plan?.selected_use_case,
        },
      });
    }

    if (seller_stage_reply?.plan?.selected_use_case === SELLER_FLOW_STAGES.STOP_OR_OPT_OUT) {
      await runtimeDeps.notifyDiscordOps({
        event_type: "opt_out",
        severity: "warning",
        domain: "inbound",
        title: "Inbound Opt-Out",
        summary: `Opt-out detected from ${inbound_from}`,
        metadata: {
          message_id: extracted.message_id,
          route_use_case: seller_stage_reply?.plan?.selected_use_case,
        },
      });
    }

    safeInfo("textgrid.inbound_ops_notified", {
      message_id: extracted.message_id,
      inbound_from,
      route_stage: route?.stage || null,
      inbound_is_negative,
      offer_created: Boolean(maybe_offer?.created),
      offer_progressed: Boolean(maybe_offer_progress?.updated),
      contract_created: Boolean(contract?.created),
    });

    const result = {
      ok: true,
      message_id: extracted.message_id,
      inbound_from,
      inbound_to,
      body: message_body,
      inbound_is_negative,
      queue_cancellation,
      context,
      classification,
      route,
      existing_offer,
      offer_progress: maybe_offer_progress,
      offer: maybe_offer,
      offer_routing,
      diagnostics: {
        offer_route: offer_routing?.offer_route || null,
        offer_route_reason: offer_routing?.reason || null,
        underwriting_route_reason:
          offer_routing?.offer_route === "underwriting"
            ? offer_routing?.reason || null
            : null,
      },
      underwriting,
      underwriting_transfer,
      seller_stage_reply,
      seller_followup_result,
      underwriting_follow_up,
      contract,
      pipeline,
      idempotency_key,
      // Burst handoff provenance, read by resolveInboundTerminalDisposition to
      // associate the pending ledger row with the burst that will settle it.
      deferred_burst,
      burst_id: deferred_burst_id,
      matched: true,
    };

    try {
      const automation_supabase_client =
        runtimeDeps.getSupabaseClient !== defaultDeps.getSupabaseClient
          ? runtimeDeps.getSupabaseClient?.()
          : null;

      await runtimeDeps.emitAutomationEvent({
        event_type: "inbound_message_received",
        source: "textgrid_inbound",
        dedupe_key: `textgrid-inbound:${idempotency_key}`,
        conversation_thread_id:
          intelligence_snapshot?.source_thread_key ||
          context?.thread_key ||
          inbound_from ||
          null,
        property_id: property_id || null,
        prospect_id: prospect_id || null,
        master_owner_id: master_owner_id || null,
        phone_number_id: phone_item_id || null,
        payload: {
          provider: "textgrid",
          provider_message_sid: extracted.message_id || null,
          message_id: extracted.message_id || null,
          message_body,
          inbound_from,
          inbound_to,
          from_phone_number: inbound_from,
          to_phone_number: inbound_to,
          thread_key:
            intelligence_snapshot?.source_thread_key ||
            context?.thread_key ||
            inbound_from ||
            null,
          classification,
          route,
          detected_intent:
            intelligence_snapshot?.canonical_intent ||
            classification?.primary_intent ||
            classification?.detected_intent ||
            classification?.inbound_intent ||
            classification?.objection ||
            seller_stage_reply?.plan?.detected_intent ||
            null,
          compliance_flag: classification?.compliance_flag || null,
          stage_before,
          stage_after:
            seller_stage_reply?.brain_stage ||
            deterministic_state?.conversation_stage ||
            route?.stage ||
            null,
          lead_temperature:
            classification?.lead_temperature ||
            intelligence_snapshot?.metadata?.lead_temperature ||
            null,
          property_address: property_address || null,
          queue_cancellation,
          seller_followup_result,
          seller_stage_use_case: seller_stage_reply?.plan?.selected_use_case || null,
          auto_reply_status:
            seller_stage_reply?.queue_status ||
            intelligence_snapshot?.automation_execution_status ||
            "shadow_only",
        },
      }, automation_supabase_client ? { supabaseClient: automation_supabase_client } : {});
    } catch (automation_error) {
      logAutomationConsole(AUTOMATION_LOG_TAGS.emit_failed_non_blocking, {
        source: "textgrid_inbound",
        message_id: extracted.message_id,
        error: automation_error?.message || "automation_emit_failed",
      });
      safeWarn("textgrid.inbound_automation_emit_failed", {
        message_id: extracted.message_id,
        error: automation_error?.message || "automation_emit_failed",
      });
    }

    try {
      const { emitNotificationFromBusinessEvent } = await import(
        "@/lib/domain/notifications/notification-emitter.js"
      );
      const thread_key =
        intelligence_snapshot?.source_thread_key ||
        context?.thread_key ||
        inbound_from ||
        null;
      const detected_intent =
        intelligence_snapshot?.canonical_intent ||
        classification?.primary_intent ||
        classification?.detected_intent ||
        classification?.inbound_intent ||
        null;
      const compliance_flag = clean(classification?.compliance_flag).toLowerCase();
      const lead_temperature = clean(
        classification?.lead_temperature ||
          intelligence_snapshot?.metadata?.lead_temperature
      ).toLowerCase();

      let inbox_event_type = "inbox_message_received";
      if (compliance_flag.includes("opt_out") || compliance_flag.includes("stop")) {
        inbox_event_type = "inbox_opt_out_received";
      } else if (compliance_flag.includes("wrong_number")) {
        inbox_event_type = "inbox_wrong_number";
      } else if (lead_temperature === "hot" || detected_intent === "hot_lead") {
        inbox_event_type = "inbox_hot_lead";
      } else if (detected_intent === "asking_price" || detected_intent === "price_captured") {
        inbox_event_type = "inbox_price_captured";
      } else if (detected_intent === "ownership_confirmed") {
        inbox_event_type = "inbox_ownership_confirmed";
      } else if (detected_intent === "needs_call" || detected_intent === "call_request") {
        inbox_event_type = "inbox_needs_call";
      } else if (
        runtimeDeps.isNegativeReply?.(message_body) ||
        detected_intent === "negative" ||
        classification?.sentiment === "negative"
      ) {
        inbox_event_type = "inbox_negative_sentiment";
      }

      await emitNotificationFromBusinessEvent({
        eventType: inbox_event_type,
        propertyId: property_id || null,
        participantId: thread_key,
        sourceEntityType: "thread",
        sourceEntityId: thread_key,
        titleVars: { thread_key: thread_key || "thread" },
        description: clean(message_body).slice(0, 240) || null,
        metrics: {
          intent: detected_intent,
          lead_temperature,
          compliance_flag: compliance_flag || null,
          provider_message_sid: clean(extracted.message_id) || null,
        },
        group: inbox_event_type === "inbox_message_received",
      });
    } catch (notification_error) {
      safeWarn("textgrid.inbound_notification_emit_failed", {
        message_id: extracted.message_id,
        error: notification_error?.message || "notification_emit_failed",
      });
    }

    await runtimeDeps.completeIdempotentProcessing({
      record_item_id: idempotency.record_item_id,
      scope: "textgrid_inbound",
      key: idempotency_key,
      summary: `Inbound SMS completed ${idempotency_key}`,
      skip_content_fields: message_event_enriched,
      metadata: {
        provider_message_id: clean(extracted.message_id) || null,
        inbound_from,
        inbound_to,
        brain_id,
        offer_item_id: active_offer_item_id,
        contract_item_id: contract?.contract_item_id || null,
        pipeline_item_id: pipeline?.pipeline_item_id || null,
        result_reason: "textgrid_inbound_processed",
      },
    });

    if (inbound_debug_stage === "handler_exit") {
      return { ok: true, stage: "handler_exit", message_id: extracted.message_id };
    }

    return result;
  } catch (error) {
    await runtimeDeps.failIdempotentProcessing({
      record_item_id: idempotency.record_item_id,
      scope: "textgrid_inbound",
      key: idempotency_key,
      error,
      skip_content_fields: message_event_enriched,
      metadata: {
        provider_message_id: clean(extracted.message_id) || null,
        inbound_from,
        inbound_to,
      },
    });

    throw error;
  }
}

export const handleTextgridInbound = handleTextgridInboundWebhook;

export default handleTextgridInboundWebhook;
