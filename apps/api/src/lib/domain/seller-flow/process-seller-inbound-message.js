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
import {
  scheduleFollowUp,
  cancelPendingFollowUpsForThread,
} from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { normalizeClassificationContract } from "@/lib/domain/seller-flow/normalize-classification-contract.js";
import {
  buildSellerFlowDecision,
  decisionToUniversalLeadStatePatch,
} from "@/lib/domain/seller-flow/seller-flow-decision-contract.js";
import { resolveSellerStageTransition, NEXT_ACTIONS } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import {
  persistSellerTransitionArtifacts,
  loadSellerDealState,
} from "@/lib/domain/seller-flow/persist-seller-transition.js";
import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";
import {
  NEGOTIATION_ZONES,
  resolveNegotiationPolicy,
  classifyNegotiationZone,
  evaluateUnderwritingSufficiency,
} from "@/lib/domain/seller-flow/negotiation-policy.js";
import { applyNegotiationTurn } from "@/lib/domain/seller-flow/negotiation-state.js";
import { routeNegotiationStrategy } from "@/lib/domain/seller-flow/negotiation-strategy-router.js";
import { selectCredibleCompAnchor } from "@/lib/domain/seller-flow/comp-anchor-policy.js";
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
import { hasSupabaseConfig } from "@/lib/supabase/client.js";
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
  cancelPendingFollowUpsForThread,
  patchUniversalLeadState,
  emitAutomationEvent,
  // Canonical ADE runner — injectable for tests/proofs; defaults to the lazy
  // import inside the pre-reply underwriting step.
  scoreProperty: null,
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

/** Map router next-action vocabulary onto the resolver's canonical set. */
function mapStrategyNextAction(action) {
  switch (String(action ?? "")) {
    case "send_message_now":
    case "collect_contract_facts":
      return NEXT_ACTIONS.SEND_MESSAGE_NOW;
    case "generate_offer":
      return NEXT_ACTIONS.GENERATE_OFFER;
    case "generate_contract":
      return NEXT_ACTIONS.GENERATE_CONTRACT;
    case "schedule_follow_up":
      return NEXT_ACTIONS.SCHEDULE_FOLLOW_UP;
    case "human_review":
      return NEXT_ACTIONS.HUMAN_REVIEW;
    default:
      return null;
  }
}

const BLOCKING_NEGOTIATION_INTENTS = new Set([
  "opt_out",
  "wrong_number",
  "wrong_person",
  "hostile_or_legal",
]);

/**
 * One deterministic negotiation turn: preview state → policy → sufficiency →
 * zone → comp anchor → strategy. Runs only when the deal is negotiation-
 * relevant (S5+, an in-authority ask, or already-locked terms) and the message
 * is not a blocking intent. Pure — persistence re-applies the same reducer
 * with execution results included. Exported so shadow evaluation replays the
 * EXACT production decision path.
 */
export function resolveNegotiationTurn({
  transition = null,
  priceSignal = null,
  priorState = null,
  adeSnapshot = null,
  engineDecision = null,
  intent = null,
  classificationConfidence = null,
  contextSummary = {},
  sourceMessageId = null,
} = {}) {
  if (!transition) return null;
  if (BLOCKING_NEGOTIATION_INTENTS.has(String(intent ?? ""))) return null;
  if (transition.contactability_patch) return null;

  const now = transition.resolved_at || new Date().toISOString();
  const state_preview = applyNegotiationTurn(priorState, {
    price_signal: priceSignal,
    ade_snapshot: adeSnapshot,
    transition,
    engine_decision: engineDecision,
    facts: transition.facts_patch || null,
    intent,
    classification_confidence: classificationConfidence,
    source_message_id: sourceMessageId,
    now,
  });

  const policy = resolveNegotiationPolicy({
    property_type: contextSummary.property_type_scope || contextSummary.property_type || null,
    unit_count: contextSummary.unit_count || null,
    market: contextSummary.market_name || contextSummary.market || null,
    reference_value: state_preview.arv ?? state_preview.current_asking_price ?? null,
    liquidity_score: adeSnapshot?.liquidity_score ?? null,
  });

  const sufficiency = evaluateUnderwritingSufficiency({
    property_type: contextSummary.property_type_scope || contextSummary.property_type || null,
    unit_count: contextSummary.unit_count || null,
    facts: transition.facts_patch || {},
    ade_snapshot: adeSnapshot,
    policy,
  });

  const zone = classifyNegotiationZone({
    current_ask: state_preview.current_asking_price,
    recommended_offer: state_preview.recommended_offer,
    authorized_offer_ceiling: state_preview.authorized_offer_ceiling,
    valuation_confidence: state_preview.comp_confidence,
    asking_price_confidence: state_preview.asking_price_confidence,
    policy,
  });

  const stage_after_number = Number(transition.stage_after_number || 0);
  const negotiation_relevant =
    stage_after_number >= 5 ||
    state_preview.terms_accepted === true ||
    (zone.zone === NEGOTIATION_ZONES.WITHIN_AUTHORITY && sufficiency.sufficient === true);

  if (!negotiation_relevant) {
    return { state_preview, policy, sufficiency, zone, comp_anchor: null, strategy_decision: null };
  }

  const comp_anchor = selectCredibleCompAnchor({
    comps: adeSnapshot?.evidence?.selected_comps || [],
    subject: {
      asset_type:
        adeSnapshot?.evidence?.subject?.asset_type ||
        contextSummary.property_type_scope ||
        contextSummary.property_type ||
        null,
      sqft: adeSnapshot?.evidence?.subject?.normalized_features?.sqft ?? null,
    },
    valuation_mid: adeSnapshot?.valuation_mid ?? null,
    previously_disclosed: state_preview.comp_anchors_used,
  });

  const strategy_decision = routeNegotiationStrategy({
    zone,
    state: state_preview,
    sufficiency,
    flags: {
      firm: Boolean(engineDecision?.negotiation_posture === "anchored"),
      accept: engineDecision?.outcome === "seller_accepts_offer",
      counter_verb: engineDecision?.counter_offer != null,
      subject_to: engineDecision?.outcome === "subject_to_candidate",
      seller_finance: engineDecision?.outcome === "seller_finance_candidate",
      novation: engineDecision?.outcome === "novation_candidate",
      creative_generic: engineDecision?.outcome === "creative_finance_candidate",
      refuses_condition: engineDecision?.outcome === "refuses_condition_info",
      challenge_repair: engineDecision?.outcome === "challenges_repair_estimate",
    },
    facts: transition.facts_patch || {},
    policy,
    comp_anchor,
    engine_decision: engineDecision,
    property_value: state_preview.arv ?? null,
  });

  // Apply the strategy back through the reducer so acceptance locks/round
  // bookkeeping are visible to the caller before anything is queued.
  const state_with_strategy = applyNegotiationTurn(priorState, {
    price_signal: priceSignal,
    ade_snapshot: adeSnapshot,
    strategy_decision,
    zone,
    transition,
    engine_decision: engineDecision,
    facts: transition.facts_patch || null,
    intent,
    classification_confidence: classificationConfidence,
    comp_anchor,
    source_message_id: sourceMessageId,
    now,
  });

  return {
    state_preview: state_with_strategy,
    policy,
    sufficiency,
    zone,
    comp_anchor,
    strategy_decision,
  };
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

  // ── Inbound takeover: a seller reply cancels pending no-reply follow-ups
  // BEFORE classification, so a stale nurture can never race the live reply.
  // Runs only with an injected client or real Supabase config — never against
  // the placeholder default client.
  let followup_cancellation = { ok: true, cancelled: 0, reason: "not_attempted" };
  const cancellation_client_available = Boolean(supabaseClient) || hasSupabaseConfig();
  if (!writes_suppressed && cancellation_client_available && (threadKey || inboundFrom)) {
    try {
      followup_cancellation = await runtimeDeps.cancelPendingFollowUpsForThread({
        thread_key: threadKey || inboundFrom,
        inbound_event_id: inboundEventId,
        supabase,
      });
    } catch (cancel_error) {
      followup_cancellation = {
        ok: false,
        cancelled: 0,
        reason: cancel_error?.message || "cancel_failed",
      };
    }
  }

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

  // Persisted deal state (negotiation authority, ADE snapshot, contract
  // evidence) — loaded BEFORE the intelligence phase so the stage engines and
  // strategy router see real underwriting instead of "unknown" bands.
  const deal_state = await loadSellerDealState({
    threadKey: threadKey || inboundFrom,
    propertyId,
    ownerId,
    supabaseClient: supabase,
  });
  const persisted_ade = deal_state?.ade_snapshot || null;
  const underwriting = {
    recommended_cash_offer:
      underwritingSignals?.ade_result?.recommended_offer ??
      deal_state?.ade_result?.recommended_offer ??
      null,
    max_allowable_offer:
      underwritingSignals?.ade_result?.investor_ceiling_mid ??
      deal_state?.ade_result?.investor_ceiling_mid ??
      null,
    minimum_acceptable_offer:
      underwritingSignals?.ade_result?.minimum_acceptable_offer ??
      deal_state?.ade_result?.minimum_acceptable_offer ??
      null,
    repair_estimate: persisted_ade?.estimated_repairs ?? null,
    valuation_mid: persisted_ade?.valuation_mid ?? null,
    valuation_confidence: persisted_ade?.valuation_confidence ?? null,
  };

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
    underwriting,
    deal_state,
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

  // ── Monetary understanding (spec §3): classify every number BEFORE any
  // negotiation decision. Low-confidence money asks for clarification and
  // never drives an offer.
  const stage_engine_decision =
    intelligence?.stage_domain?.engine_result?.stage_decision || null;
  const prior_negotiation_state = deal_state?.negotiation_state || null;
  const negotiation_active = Boolean(
    (Array.isArray(prior_negotiation_state?.offers_made)
      ? prior_negotiation_state.offers_made.length > 0
      : Number(prior_negotiation_state?.offers_made) > 0) ||
      prior_negotiation_state?.latest_offer != null
  );
  const price_signal = resolveAskingPriceSignal(message, {
    reference:
      prior_negotiation_state?.current_asking_price ??
      prior_negotiation_state?.current_ask ??
      underwriting.recommended_cash_offer ??
      underwriting.valuation_mid ??
      null,
    negotiationActive: negotiation_active,
    sourceMessageId: providerMessageId || inboundEventId,
  });

  // ── Deterministic lifecycle transition (resolved BEFORE the reply is
  // queued so ADE + strategy shape the outbound instead of trailing it).
  let transition = null;
  try {
    const extracted = contract.extracted_facts || {};
    const summary = context?.summary || {};
    transition = resolveSellerStageTransition({
      stage_before: stageBefore || summary.conversation_stage || null,
      known_facts: {
        ...(deal_state?.known_facts || {}),
        ownership_status:
          summary.ownership_status || deal_state?.known_facts?.ownership_status || null,
        asking_price: deal_state?.known_facts?.asking_price || summary.asking_price || null,
        occupancy_status:
          summary.occupancy_status || deal_state?.known_facts?.occupancy_status || null,
      },
      new_facts: {
        asking_price:
          price_signal.asking_price ??
          stage_engine_decision?.seller_asking_price ??
          extracted.asking_price ??
          null,
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
      negotiation_state: underwritingSignals?.negotiation_state || prior_negotiation_state || null,
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

  // ── Pre-reply canonical ADE: when the resolver requests underwriting and no
  // usable persisted authority exists, run it NOW so the strategy router and
  // the outbound template see fresh authority (spec §4 — preliminary ADE runs
  // as soon as price is captured; example 2 — one message can carry price +
  // condition and advance straight to S5).
  let fresh_ade_snapshot = null;
  const ade_requested = transition && transition.ade_action && transition.ade_action !== "none";
  const authority_missing =
    underwriting.recommended_cash_offer == null || transition?.ade_action === "rerun_material_facts";
  if (ade_requested && authority_missing && !writes_suppressed && clean(propertyId)) {
    try {
      const runner =
        runtimeDeps.scoreProperty ||
        (await import("@/lib/acquisition/acquisitionDecisionEngine.js")).scoreProperty;
      // Bounded inline scoring (same pattern as persistence): a hung ADE must
      // degrade to the no-authority path, never stall the webhook.
      let timeoutHandle = null;
      const timeout = new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ ok: false, error: "ade_timeout" }), 8000);
        if (typeof timeoutHandle?.unref === "function") timeoutHandle.unref();
      });
      const ade = await Promise.race([runner(propertyId, { supabase }), timeout]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (ade?.ok && ade.score) fresh_ade_snapshot = ade.score;
      else if (ade?.error) {
        runtimeDeps.warn("[SELLER_INBOUND_PRE_ADE_FAILED]", {
          thread_key: threadKey || inboundFrom,
          error: ade.error,
        });
      }
    } catch (ade_error) {
      runtimeDeps.warn("[SELLER_INBOUND_PRE_ADE_FAILED]", {
        thread_key: threadKey || inboundFrom,
        error: ade_error?.message || "ade_failed",
      });
    }
  }
  const effective_ade_snapshot = fresh_ade_snapshot || persisted_ade || null;

  // ── Negotiation strategy (spec §6/§7): deterministic zone + single strategy.
  const negotiation = resolveNegotiationTurn({
    transition,
    priceSignal: price_signal,
    priorState: prior_negotiation_state,
    adeSnapshot: effective_ade_snapshot,
    engineDecision: stage_engine_decision,
    intent: contract.normalized_intent,
    classificationConfidence: classification?.confidence ?? null,
    contextSummary: context?.summary || {},
    sourceMessageId: providerMessageId || inboundEventId,
  });

  // Accepted terms resolve the S5 milestone — re-resolve the lifecycle so the
  // same message advances toward S6 (spec example 3, stage monotonicity kept).
  if (negotiation?.state_preview?.terms_accepted && !prior_negotiation_state?.terms_accepted && transition) {
    try {
      transition = resolveSellerStageTransition({
        stage_before: transition.stage_before,
        known_facts: transition.facts_patch,
        new_facts: {},
        intent: contract.normalized_intent,
        classification_confidence: classification?.confidence ?? null,
        current_temperature: transition.lead_temperature,
        current_disposition: transition.disposition,
        automation_mode: effective_auto_reply_mode,
        negotiation_state: negotiation.state_preview,
        ade_result:
          underwritingSignals?.ade_result || deal_state?.ade_result || {
            sufficient_facts: true,
            underwriting_ready: true,
          },
        contract_state: underwritingSignals?.contract_state || deal_state?.contract_state || null,
        engine_decision: stage_engine_decision,
        source_message_id: providerMessageId || inboundEventId,
      });
    } catch {
      // keep the original transition on re-resolution failure
    }
  }

  // Strategy refines the transition's outbound plan — resolver stays the only
  // stage authority; the router only shapes template/next action at S5+.
  if (negotiation?.strategy_decision && transition) {
    const mapped_next_action = mapStrategyNextAction(negotiation.strategy_decision.next_action);
    transition = {
      ...transition,
      required_template_use_case:
        negotiation.strategy_decision.template_use_case || transition.required_template_use_case,
      next_action: mapped_next_action || transition.next_action,
      review_required: transition.review_required || Boolean(negotiation.strategy_decision.review_required),
      review_reason: transition.review_reason || negotiation.strategy_decision.review_reason || null,
      negotiation_strategy: negotiation.strategy_decision.strategy,
      negotiation_zone: negotiation.zone?.zone || null,
    };
  }

  // ── Monetary authority for template rendering (spec §12): fail closed.
  // Offer tokens render ONLY from this persisted/derived ADE authority — never
  // from the seller's own price and never above the ceiling.
  const authorized_ceiling =
    negotiation?.state_preview?.authorized_offer_ceiling ??
    underwriting.max_allowable_offer ??
    null;
  let authorized_amount = negotiation?.strategy_decision?.monetary?.amount ?? null;
  if (
    authorized_amount != null &&
    authorized_ceiling != null &&
    Number(authorized_amount) > Number(authorized_ceiling)
  ) {
    runtimeDeps.warn("[NEGOTIATION_AUTHORITY_CLAMP]", {
      thread_key: threadKey || inboundFrom,
      attempted_amount: authorized_amount,
      ceiling: authorized_ceiling,
    });
    authorized_amount = null; // fail closed → renderer blocks monetary sends
  }
  const deal_authority = {
    recommended_offer:
      underwritingSignals?.ade_result?.recommended_offer ??
      (effective_ade_snapshot?.recommended_cash_offer != null
        ? Number(effective_ade_snapshot.recommended_cash_offer)
        : null) ??
      deal_state?.ade_result?.recommended_offer ??
      deal_state?.negotiation_state?.recommended_offer ??
      null,
    authorized_offer_amount: authorized_amount,
    authorized_offer_ceiling: authorized_ceiling,
    comp_anchor_statement: negotiation?.comp_anchor?.authorized_statement || null,
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
    strategyDirective: negotiation?.strategy_decision
      ? {
          strategy: negotiation.strategy_decision.strategy,
          reason_code: negotiation.strategy_decision.reason_code,
          template_use_case: negotiation.strategy_decision.template_use_case,
          allowed_template_use_cases: negotiation.strategy_decision.allowed_template_use_cases,
          review_required: negotiation.strategy_decision.review_required,
          review_reason: negotiation.strategy_decision.review_reason,
          monetary_amount: authorized_amount,
        }
      : null,
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

  // Deal-record persistence: asking-price facts, full negotiation state (§2),
  // canonical ADE snapshot, monotonic stage advancement, §16 workflow events.
  let deal_persistence = null;
  if (transition && supabase) {
    const offer_use_cases = new Set([
      "initial_offer",
      "conditional_offer",
      "counter_offer",
      "final_offer",
      "offer_reveal_cash",
    ]);
    const queued_use_case = clean(execution?.selected_template?.use_case) || null;
    const offer_execution = execution?.queued
      ? {
          queued: true,
          amount:
            authorized_amount != null && queued_use_case && offer_use_cases.has(queued_use_case)
              ? authorized_amount
              : null,
          template_use_case: queued_use_case,
          queue_row_id: execution?.queue_row_id || null,
        }
      : null;

    deal_persistence = await persistSellerTransitionArtifacts({
      transition,
      threadKey: threadKey || inboundFrom,
      propertyId,
      ownerId,
      intent: contract.normalized_intent,
      inboundEventId,
      dryRun: writes_suppressed,
      supabaseClient: supabase,
      priceSignal: price_signal,
      strategyDecision: negotiation?.strategy_decision || null,
      zone: negotiation?.zone || null,
      engineDecision: stage_engine_decision,
      offerExecution: offer_execution,
      compAnchor: negotiation?.comp_anchor || null,
      classificationConfidence: classification?.confidence ?? null,
      adeSnapshotPrecomputed: fresh_ade_snapshot,
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
    followup_cancellation,
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