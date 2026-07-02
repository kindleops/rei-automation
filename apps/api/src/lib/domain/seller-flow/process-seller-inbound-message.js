import { classify } from "@/lib/domain/classification/classify.js";
import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { runInboundIntelligencePhase } from "@/lib/domain/seller-flow/run-inbound-intelligence-phase.js";
import {
  buildIntelligenceMessageEventPatch,
  persistInboundIntelligenceSnapshot,
  persistSellerContactReferral,
} from "@/lib/domain/seller-flow/persist-inbound-intelligence.js";
import { executeReferralAutomation } from "@/lib/domain/seller-flow/execute-referral-automation.js";
import { resolveSellerAutoReplyPlan } from "@/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js";
import { scheduleFollowUp } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { normalizeClassificationContract } from "@/lib/domain/seller-flow/normalize-classification-contract.js";
import {
  buildSellerFlowDecision,
  decisionToUniversalLeadStatePatch,
} from "@/lib/domain/seller-flow/seller-flow-decision-contract.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import {
  persistSellerTransitionArtifacts,
  loadSellerDealState,
} from "@/lib/domain/seller-flow/persist-seller-transition.js";
import {
  autoReplyModeAllowsQueue,
  normalizeAutoReplyMode,
  resolveGuardedAutoReplyMode,
} from "@/lib/domain/seller-flow/auto-reply-mode.js";
import { patchUniversalLeadState } from "@/lib/domain/lead-state/patch-universal-lead-state.js";
import { STATE_SOURCE_CODES } from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { emitAutomationEvent } from "@/lib/domain/automation/automation-events.js";
import { summarizeSellerInboundSideEffects } from "@/lib/domain/seller-flow/seller-inbound-orchestration-summary.js";
import {
  normalizeSellerInboundExecutionView,
  alignIntelligenceSnapshotExecutionView,
  alignSellerStageReply,
} from "@/lib/domain/seller-flow/seller-inbound-execution-view.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { info, warn } from "@/lib/logging/logger.js";

const defaultDeps = {
  classify,
  runInboundIntelligencePhase,
  executeInboundAutomationDecision,
  persistInboundIntelligenceSnapshot,
  persistSellerContactReferral,
  executeReferralAutomation,
  resolveSellerAutoReplyPlan,
  scheduleFollowUp,
  patchUniversalLeadState,
  emitAutomationEvent,
  getSupabaseClient: getDefaultSupabaseClient,
  info,
  warn,
};

let runtimeDeps = { ...defaultDeps };

export function __setSellerInboundOrchestratorDeps(overrides = {}) {
  runtimeDeps = { ...runtimeDeps, ...overrides };
}

export function __resetSellerInboundOrchestratorDeps() {
  runtimeDeps = { ...defaultDeps };
}

function clean(value) {
  return String(value ?? "").trim();
}

async function emitSellerNotifications({
  decision = null,
  contract = null,
  propertyId = null,
  threadKey = null,
  messageBody = "",
  providerMessageId = null,
} = {}) {
  try {
    const { emitNotificationFromBusinessEvent } = await import(
      "@/lib/domain/notifications/notification-emitter.js"
    );

    for (const event of decision?.notification_events || []) {
      const eventTypeMap = {
        seller_reply: "inbox_message_received",
        ownership_confirmed: "inbox_ownership_confirmed",
        seller_interested: "inbox_hot_lead",
        asking_price_received: "inbox_price_captured",
        automation_blocked: "automation_blocked",
        automation_needs_review: "automation_needs_review",
        referral_detected: "referral_detected",
        automatic_reply_sent: "automatic_reply_sent",
        automatic_reply_failed: "automatic_reply_failed",
      };
      const eventType = eventTypeMap[event.type] || "inbox_message_received";
      await emitNotificationFromBusinessEvent({
        eventType,
        propertyId: propertyId || null,
        participantId: threadKey,
        sourceEntityType: "thread",
        sourceEntityId: threadKey,
        titleVars: { thread_key: threadKey || "thread" },
        description: clean(messageBody).slice(0, 240) || null,
        metrics: {
          intent: contract?.normalized_intent || null,
          provider_message_sid: providerMessageId || null,
          execution_mode: decision?.execution_mode || null,
        },
        group: eventType === "inbox_message_received",
      });
    }
  } catch (error) {
    runtimeDeps.warn("[SELLER_INBOUND_NOTIFICATION_EMIT_FAILED]", {
      thread_key: threadKey,
      error: error?.message || "notification_emit_failed",
    });
  }
}

async function emitWorkflowStudioEvents({
  decision = null,
  propertyId = null,
  prospectId = null,
  ownerId = null,
  threadKey = null,
  inboundEventId = null,
  supabaseClient = null,
} = {}) {
  for (const event of decision?.workflow_events || []) {
    try {
      await runtimeDeps.emitAutomationEvent(
        {
          event_type: event.type,
          source: "seller_inbound_orchestrator",
          dedupe_key: `seller-inbound:${inboundEventId}:${event.type}`,
          conversation_thread_id: threadKey,
          property_id: propertyId || null,
          prospect_id: prospectId || null,
          master_owner_id: ownerId || null,
          payload: {
            stage_before: decision.stage_before,
            stage_after: decision.stage_after,
            execution_mode: decision.execution_mode,
            ...event,
          },
        },
        supabaseClient ? { supabaseClient } : {}
      );
    } catch (error) {
      runtimeDeps.warn("[SELLER_INBOUND_WORKFLOW_EMIT_FAILED]", {
        event_type: event.type,
        thread_key: threadKey,
        error: error?.message || "workflow_emit_failed",
      });
    }
  }
}

/**
 * Canonical seller inbound orchestration entry point.
 * Every inbound webhook, retry, and recovery job must call this path.
 */
export async function processSellerInboundMessage({
  message,
  threadKey,
  propertyId,
  prospectId,
  ownerId,
  phoneId,
  classification: providedClassification = null,
  conversationBrain = null,
  context = null,
  route = null,
  inboundFrom = "",
  inboundTo = "",
  inboundEventId = null,
  providerMessageId = null,
  stageBefore = null,
  autoReplyMode = null,
  executionAllowed: explicitExecutionAllowed = null,
  systemFollowupEnabled = true,
  inboundAutopilotDelaySeconds = 0,
  timezoneOverride = null,
  contactWindowOverride = null,
  dryRun = false,
  proofRun = false,
  applySuppression = true,
  skipUniversalStatePatch = false,
  skipNotifications = false,
  underwritingSignals = null,
  recentOutbound = null,
  supabaseClient = null,
  getSystemValue = null,
} = {}) {
  const supabase = supabaseClient || runtimeDeps.getSupabaseClient?.();
  const effective_auto_reply_mode = normalizeAutoReplyMode(
    autoReplyMode ||
      resolveGuardedAutoReplyMode({
        requestedMode: autoReplyMode,
        legacyEnabled: true,
        legacyLiveEnabled: explicitExecutionAllowed === true,
      }).mode,
    "disabled"
  );

  const queue_permission = autoReplyModeAllowsQueue({
    mode: effective_auto_reply_mode,
    inboundFrom: inboundFrom || threadKey,
    threadKey,
  });

  const execution_allowed =
    explicitExecutionAllowed != null
      ? Boolean(explicitExecutionAllowed)
      : Boolean(queue_permission.allowed);
  const writes_suppressed = Boolean(dryRun || proofRun);

  let classification = providedClassification;
  if (!classification) {
    classification = await runtimeDeps.classify(message, conversationBrain);
  }

  const contractResult = normalizeClassificationContract({
    classification,
    message,
    messageId: providerMessageId || inboundEventId,
    threadId: threadKey || inboundFrom,
    propertyId,
    participantId: prospectId,
    prospectId,
    phone: inboundFrom || threadKey,
    context,
    inboundEventId,
  });

  if (!contractResult.ok) {
    return {
      ok: false,
      reason: contractResult.reason,
      classification,
      contract: null,
      decision: null,
    };
  }

  const contract = contractResult.contract;
  const legacy_plan = await runtimeDeps.resolveSellerAutoReplyPlan({
    inbound_event: {
      item_id: inboundEventId,
      provider_message_id: providerMessageId,
      from: inboundFrom,
      to: inboundTo,
    },
    message_body: message,
    classification,
    route,
    conversation_context: context,
    current_stage: stageBefore || context?.summary?.conversation_stage || null,
    prior_use_case: route?.use_case || null,
    recent_outbound: recentOutbound,
    underwriting_signals: underwritingSignals,
    auto_reply_enabled: execution_allowed,
    force_queue_reply: false,
    now: new Date().toISOString(),
  });

  const intelligence = await runtimeDeps.runInboundIntelligencePhase({
    message,
    threadKey: threadKey || inboundFrom,
    propertyId,
    prospectId,
    ownerId,
    phoneId,
    classification,
    conversationBrain,
    latestThreadContext: context,
    context,
    route,
    inboundFrom,
    inboundTo,
    inboundEventId,
    legacy_plan,
    auto_reply_mode: effective_auto_reply_mode,
    execution_allowed,
    supabaseClient: supabase,
  });

  let intelligence_snapshot = intelligence?.intelligence_snapshot || null;

  try {
    await runtimeDeps.persistInboundIntelligenceSnapshot({
      supabaseClient: supabase,
      intelligence_snapshot,
      provider_message_sid: providerMessageId,
      message_event_id: inboundEventId,
      dry_run: writes_suppressed,
    });

    if (intelligence_snapshot?.referral_detected) {
      const referral_persist = await runtimeDeps.persistSellerContactReferral({
        supabaseClient: supabase,
        referral: intelligence_snapshot.referral,
        dry_run: writes_suppressed,
      });

      if (
        intelligence_snapshot?.referral?.referred_automatic_send_allowed ||
        intelligence_snapshot?.referred_automatic_send_allowed
      ) {
        await runtimeDeps.executeReferralAutomation({
          supabaseClient: supabase,
          relationship: intelligence_snapshot.referral,
          context,
          inboundTo,
          inboundEventId,
          referralId: referral_persist?.referral_id || null,
          execution_allowed,
          auto_reply_mode: effective_auto_reply_mode,
          dryRun: writes_suppressed,
        });
      }
    }
  } catch (persist_error) {
    runtimeDeps.warn("[SELLER_INBOUND_INTELLIGENCE_PERSIST_FAILED]", {
      inbound_event_id: inboundEventId,
      error: persist_error?.message || "persist_failed",
    });
  }

  const canonical_decision =
    intelligence?.canonical_decision || intelligence_snapshot?.canonical_decision || null;
  const should_queue_live = Boolean(
    execution_allowed &&
      (canonical_decision?.should_queue_reply ?? legacy_plan?.should_queue_reply)
  );

  // Persisted deal state (negotiation authority, ADE snapshot, contract
  // evidence) — loaded once; feeds template personalization (monetary values
  // are ADE-bound only) and the transition resolver.
  const deal_state = await loadSellerDealState({
    threadKey: threadKey || inboundFrom,
    propertyId,
    ownerId,
    supabaseClient: supabase,
  });
  const deal_authority = {
    recommended_offer:
      underwritingSignals?.ade_result?.recommended_offer ??
      deal_state?.ade_result?.recommended_offer ??
      deal_state?.negotiation_state?.recommended_offer ??
      null,
  };

  const execution = await runtimeDeps.executeInboundAutomationDecision({
    message,
    threadKey: threadKey || inboundFrom,
    propertyId,
    prospectId,
    ownerId,
    phoneId,
    classification,
    conversationBrain,
    latestThreadContext: context,
    context,
    inboundFrom,
    inboundTo,
    inboundEventId,
    enableQueueInsert: should_queue_live,
    applySuppression,
    dryRun: dryRun || !should_queue_live,
    autoReplyMode: effective_auto_reply_mode,
    proofRun,
    scheduleDelaySeconds: inboundAutopilotDelaySeconds,
    timezoneOverride,
    contactWindowOverride,
    dealAuthority: deal_authority,
    supabaseClient: supabase,
    getSystemValue,
  });

  let follow_up_result = {
    ok: true,
    skipped: true,
    reason: "not_attempted",
  };

  if (systemFollowupEnabled) {
    const follow_up_intent =
      contract.ownership_probe_transition
        ? "not_interested"
        : intelligence_snapshot?.canonical_intent || contract.normalized_intent;

    const should_schedule_followup = Boolean(
      contract.ownership_probe_transition ||
        (!execution?.queued &&
          (canonical_decision?.next_action === "schedule_later_followup" ||
            canonical_decision?.next_action === "do_not_reply"))
    );

    if (should_schedule_followup && execution_allowed && !writes_suppressed) {
      try {
        follow_up_result = await runtimeDeps.scheduleFollowUp(follow_up_intent, threadKey || inboundFrom, {
          is_suppressed: Boolean(canonical_decision?.should_suppress_contact),
          source: "seller_inbound_orchestrator",
          inbound_message_event_id: inboundEventId,
          master_owner_id: ownerId,
          property_id: propertyId,
          classification_confidence: classification?.confidence ?? null,
        }, supabase);
      } catch (followup_error) {
        runtimeDeps.warn("[SELLER_INBOUND_FOLLOWUP_FAILED]", {
          thread_key: threadKey,
          intent: follow_up_intent,
          error: followup_error?.message || "followup_failed",
        });
        follow_up_result = {
          ok: false,
          skipped: true,
          reason: followup_error?.message || "followup_failed",
        };
      }
    } else if (contract.ownership_probe_transition) {
      follow_up_result = {
        ok: true,
        skipped: writes_suppressed || !execution_allowed,
        shadow_only: writes_suppressed || !execution_allowed,
        followup_created: false,
        scheduled_for: contract.ownership_probe_transition.follow_up_at,
        reason: "s1_ownership_probe_followup_scheduled",
      };
    } else if (should_schedule_followup && writes_suppressed) {
      follow_up_result = {
        ok: true,
        skipped: false,
        shadow_only: true,
        followup_created: false,
        scheduled_for: canonical_decision?.follow_up_at || null,
        reason: "followup_preview_writes_suppressed",
      };
    }
  }

  // Deterministic lifecycle transition — the classifier/engines only feed
  // facts and intents; this resolver alone decides stage/status/next action.
  let transition = null;
  try {
    const stage_engine_decision =
      intelligence?.stage_domain?.engine_result?.stage_decision || null;
    const extracted = contract.extracted_facts || {};
    const summary = context?.summary || {};
    transition = resolveSellerStageTransition({
      stage_before: stageBefore || summary.conversation_stage || null,
      known_facts: {
        ...(deal_state?.known_facts || {}),
        ownership_status: summary.ownership_status || deal_state?.known_facts?.ownership_status || null,
        asking_price: deal_state?.known_facts?.asking_price || summary.asking_price || null,
        occupancy_status: summary.occupancy_status || deal_state?.known_facts?.occupancy_status || null,
      },
      new_facts: {
        asking_price:
          stage_engine_decision?.seller_asking_price ?? extracted.asking_price ?? null,
        condition_summary:
          typeof extracted.condition === "string" ? extracted.condition : null,
        condition_disclosed:
          contract.normalized_intent === "condition_disclosed" ||
          Boolean(extracted.condition) ||
          undefined,
        occupancy_status: extracted.tenant_occupied
          ? "tenant_occupied"
          : stage_engine_decision?.occupancy_status || null,
        timeline: extracted.timeline || null,
      },
      intent:
        intelligence_snapshot?.canonical_intent || contract.normalized_intent || "unclear",
      classification_confidence: classification?.confidence ?? null,
      current_temperature: summary.lead_temperature || summary.temperature || null,
      current_disposition: summary.disposition || null,
      automation_mode: effective_auto_reply_mode,
      negotiation_state:
        underwritingSignals?.negotiation_state || deal_state?.negotiation_state || null,
      ade_result: underwritingSignals?.ade_result || deal_state?.ade_result || null,
      contract_state: underwritingSignals?.contract_state || deal_state?.contract_state || null,
      engine_decision: stage_engine_decision,
      source_message_id: providerMessageId || inboundEventId,
    });
  } catch (transition_error) {
    runtimeDeps.warn("[SELLER_INBOUND_TRANSITION_RESOLVER_FAILED]", {
      thread_key: threadKey || inboundFrom,
      error: transition_error?.message || "transition_resolver_failed",
    });
  }

  const decision = buildSellerFlowDecision({
    contract,
    intelligence,
    automation_decision: execution?.automation_decision || canonical_decision,
    execution,
    follow_up: follow_up_result,
    stage_before: stageBefore || context?.summary?.conversation_stage || null,
    auto_reply_mode: effective_auto_reply_mode,
    execution_allowed,
    selected_participant_id: prospectId,
    selected_sender_number: inboundTo,
    transition,
  });

  let universal_state_patch = null;
  if (!skipUniversalStatePatch && supabase && (threadKey || inboundFrom)) {
    const patch = decisionToUniversalLeadStatePatch(decision);
    if (contract.ownership_probe_transition) {
      patch.lifecycle_stage = "offer_interest";
      patch.operational_status = contract.ownership_probe_transition.operational_status || "scheduled";
      patch.lead_temperature = contract.ownership_probe_transition.lead_temperature || "cold";
      patch.disposition = contract.ownership_probe_transition.disposition || "not_interested";
      patch.follow_up_at = contract.ownership_probe_transition.follow_up_at || null;
    }

    if (Object.keys(patch).length > 0) {
      try {
        universal_state_patch = await runtimeDeps.patchUniversalLeadState({
          threadKey: threadKey || inboundFrom,
          patch,
          supabase,
          dryRun: writes_suppressed,
          meta: {
            change_source: STATE_SOURCE_CODES.AUTOPILOT,
            source_view: "seller_inbound_orchestrator",
            reason: decision.reasoning_code || decision.immediate_next_action,
            executed_next_action: Boolean(execution?.queued),
            metadata: decision.reasoning_code
              ? { reasoning_code: decision.reasoning_code, next_action: decision.next_action }
              : {},
          },
        });
      } catch (state_error) {
        runtimeDeps.warn("[SELLER_INBOUND_UNIVERSAL_STATE_FAILED]", {
          thread_key: threadKey,
          error: state_error?.message || "universal_state_failed",
        });
      }
    }
  }

  // Deal-record persistence: asking-price facts, negotiation state, canonical
  // ADE execution + snapshot, monotonic acquisition-stage advancement.
  let deal_persistence = null;
  if (transition && supabase) {
    deal_persistence = await persistSellerTransitionArtifacts({
      transition,
      threadKey: threadKey || inboundFrom,
      propertyId,
      ownerId,
      intent: contract.normalized_intent,
      inboundEventId,
      dryRun: writes_suppressed,
      supabaseClient: supabase,
    });
  }

  const dispatch_side_effects = !skipNotifications && !writes_suppressed;
  if (dispatch_side_effects) {
    await emitSellerNotifications({
      decision,
      contract,
      propertyId,
      threadKey: threadKey || inboundFrom,
      messageBody: message,
      providerMessageId,
    });
    await emitWorkflowStudioEvents({
      decision,
      propertyId,
      prospectId,
      ownerId,
      threadKey: threadKey || inboundFrom,
      inboundEventId,
      supabaseClient: supabase,
    });
  }

  const execution_view = normalizeSellerInboundExecutionView({
    execution,
    follow_up: follow_up_result,
    canonical_decision,
    decision,
    contract,
    writes_suppressed,
  });

  const aligned_intelligence_snapshot = alignIntelligenceSnapshotExecutionView(
    intelligence_snapshot,
    execution_view
  );

  const seller_stage_reply = alignSellerStageReply(
    {
      ...(intelligence?.seller_stage_reply || {}),
      ...(execution_view.execution?.seller_stage_reply || {}),
      intelligence_snapshot: aligned_intelligence_snapshot,
      automation_decision:
        execution_view.execution?.automation_decision || canonical_decision,
      seller_flow_decision: decision,
    },
    execution_view
  );

  runtimeDeps.info("[SELLER_INBOUND_ORCHESTRATED]", {
    thread_key: threadKey || inboundFrom,
    inbound_event_id: inboundEventId,
    normalized_intent: contract.normalized_intent,
    stage_before: decision.stage_before,
    stage_after: decision.stage_after,
    execution_mode: decision.execution_mode,
    queued: Boolean(execution_view.queued),
    queue_row_created: Boolean(execution_view.queue_row_created),
    followup_scheduled: Boolean(execution_view.followup_scheduled),
    followup_created: Boolean(execution_view.followup_created),
    effective_action: execution_view.effective_action,
    block_reason: decision.block_reason,
  });

  const intelligence_message_event_patch =
    buildIntelligenceMessageEventPatch(intelligence_snapshot);

  const side_effects = summarizeSellerInboundSideEffects(
    {
      decision,
      intelligence_message_event_patch,
      universal_state_patch,
    },
    {
      writes_suppressed,
      notifications_dispatched: dispatch_side_effects,
      universal_state_dispatched:
        !skipUniversalStatePatch && Boolean(universal_state_patch) && !writes_suppressed,
    }
  );

  let seller_automation_execution = null;
  if (supabase && clean(threadKey || inboundFrom)) {
    try {
      const { recordSellerInboundExecutionTimeline } = await import(
        "@/lib/domain/seller-automation/seller-automation-execution-service.js"
      );
      seller_automation_execution = await recordSellerInboundExecutionTimeline({
        supabaseClient: supabase,
        threadKey: threadKey || inboundFrom,
        propertyId,
        participantId: prospectId || ownerId,
        inboundEventId,
        decision,
        contract,
        execution: execution_view.execution,
        followUp: execution_view.follow_up,
      });
    } catch (timeline_error) {
      runtimeDeps.warn("[SELLER_AUTOMATION_TIMELINE_FAILED]", {
        thread_key: threadKey,
        inbound_event_id: inboundEventId,
        error: timeline_error?.message || "timeline_failed",
      });
    }
  }

  return {
    ok: true,
    classification,
    contract,
    intelligence,
    intelligence_snapshot: aligned_intelligence_snapshot,
    execution: execution_view.execution,
    follow_up: execution_view.follow_up,
    decision,
    seller_stage_reply,
    universal_state_patch,
    side_effects,
    auto_reply_mode: effective_auto_reply_mode,
    execution_allowed,
    queue_permission,
    intelligence_message_event_patch,
    proof_run: Boolean(proofRun),
    writes_suppressed,
    queued: execution_view.queued,
    followup_scheduled: execution_view.followup_scheduled,
    queue_row_created: execution_view.queue_row_created,
    followup_created: execution_view.followup_created,
    effective_action: execution_view.effective_action,
    idempotent: {
      duplicate_suppressed: Boolean(execution?.duplicate_suppressed),
      queue_row_id: execution?.queue_row_id || null,
    },
    seller_automation_execution,
    transition,
    deal_persistence,
  };
}

export default processSellerInboundMessage;