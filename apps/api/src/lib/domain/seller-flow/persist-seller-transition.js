// ─── persist-seller-transition.js ───────────────────────────────────────────
// Persists resolver transitions into the canonical deal record
// (acquisition_opportunities): first-class asking-price facts, per-deal
// negotiation state, next action, monotonic acquisition-stage advancement, and
// canonical ADE execution + snapshot.
//
// Every write here is failure-isolated: seller inbound orchestration must
// never fail because deal-record persistence failed. All monetary authority
// comes from the persisted ADE snapshot (recommended/minimum/ceiling) — the
// language model never sets or exceeds the authorized offer band.

import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import {
  promoteThreadToOpportunity,
  transitionOpportunityStage,
  updateOpportunity,
} from "@/lib/domain/opportunity/opportunity-service.js";
import { buildOpportunityDedupeKey } from "@/lib/domain/opportunity/universal-pipeline-registry.js";
import {
  lifecycleStageNumber,
  normalizeLifecycleStage,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { ADE_ACTIONS } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { applyNegotiationTurn } from "@/lib/domain/seller-flow/negotiation-state.js";
import { emitAutomationEvent } from "@/lib/domain/automation/automation-events.js";
import { info, warn } from "@/lib/logging/logger.js";

const TABLE = "acquisition_opportunities";
const SOURCE = "seller_autopilot";

function clean(value) {
  return String(value ?? "").trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Deals become trackable once real engagement exists past bare S1 contact. */
export function transitionQualifiesForOpportunity(transition = {}) {
  if (!transition) return false;
  if (transition.facts_patch?.asking_price?.value > 0) return true;
  if (transition.facts_patch?.wants_offer === true) return true;
  return Number(transition.stage_after_number || 1) >= 2 && transition.advanced === true;
}

async function findExistingOpportunity(supabase, { ownerId, propertyId, threadKey }) {
  const keys = [
    buildOpportunityDedupeKey({ master_owner_id: ownerId, primary_property_id: propertyId }),
    buildOpportunityDedupeKey({ primary_thread_key: threadKey }),
  ].filter(Boolean);

  if (keys.length) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("*")
      .in("dedupe_key", keys)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (data?.[0]) return data[0];
  }

  if (clean(threadKey)) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("*")
      .eq("primary_thread_key", threadKey)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (data?.[0]) return data[0];
  }
  return null;
}

/** Maintain per-deal negotiation state from the transition (spec §7). */
export function buildNegotiationStatePatch(previous = {}, { transition = {}, intent = null, adeSnapshot = null, now = new Date().toISOString() } = {}) {
  const state = { ...(previous || {}) };
  const price = num(transition.facts_patch?.asking_price?.value);
  const atOffer = Number(transition.stage_after_number || 0) >= 5;

  if (price) {
    if (state.initial_ask == null) state.initial_ask = price;
    if (atOffer && state.current_ask != null && price !== state.current_ask) {
      state.seller_counters = [
        ...(Array.isArray(state.seller_counters) ? state.seller_counters : []),
        { amount: price, at: now, source_message_id: transition.facts_patch?.asking_price?.source_message_id || null },
      ];
      state.negotiation_turn = (state.negotiation_turn || 0) + 1;
    }
    state.current_ask = price;
  }

  if (adeSnapshot) {
    state.recommended_offer = num(adeSnapshot.recommended_cash_offer) ?? state.recommended_offer ?? null;
    state.authorized_offer_floor = num(adeSnapshot.minimum_acceptable_offer) ?? state.authorized_offer_floor ?? null;
    state.authorized_offer_ceiling =
      num(adeSnapshot.investor_ceiling_mid) ?? num(adeSnapshot.investor_ceiling_high) ?? state.authorized_offer_ceiling ?? null;
  }

  if ((transition.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER")) {
    state.terms_accepted = true;
    state.accepted_price = state.accepted_price ?? state.recommended_offer ?? state.current_ask ?? null;
    state.accepted_at = state.accepted_at ?? now;
  }

  state.last_seller_sentiment = clean(intent) || state.last_seller_sentiment || null;
  state.next_move = transition.next_action || state.next_move || null;
  state.strategy = transition.required_template_use_case || state.strategy || null;
  state.updated_at = now;
  return state;
}

async function runCanonicalAde(propertyId, deps = {}) {
  const { scoreProperty } = await import("@/lib/acquisition/acquisitionDecisionEngine.js");
  const runner = deps.scoreProperty || scoreProperty;
  const result = await runner(propertyId, deps);
  if (!result?.ok) {
    return { ok: false, error: result?.error || "ade_failed" };
  }
  return { ok: true, score: result.score || null, evidence: result.evidence || null };
}

/**
 * Read-only deal-state loader for resolver inputs on the next inbound:
 * persisted negotiation state, latest ADE snapshot, and contract evidence.
 * Never throws — returns null when nothing is tracked yet.
 */
export async function loadSellerDealState({ threadKey = null, propertyId = null, ownerId = null, supabaseClient = null } = {}) {
  try {
    const supabase = supabaseClient || getDefaultSupabaseClient();
    if (!supabase || !clean(threadKey)) return null;
    const opportunity = await findExistingOpportunity(supabase, { ownerId, propertyId, threadKey });
    if (!opportunity) return null;
    const metadata = opportunity.metadata && typeof opportunity.metadata === "object" ? opportunity.metadata : {};
    const ade = metadata.ade_snapshot || null;
    return {
      opportunity_id: opportunity.id,
      property_id: opportunity.primary_property_id || null,
      acquisition_stage: opportunity.acquisition_stage || null,
      negotiation_state: {
        ...(metadata.negotiation_state || {}),
        offers_made:
          metadata.negotiation_state?.offers_made ?? (opportunity.current_offer != null ? 1 : 0),
      },
      ade_result: ade
        ? {
            sufficient_facts: true,
            underwriting_ready: true,
            recommended_offer: num(ade.recommended_cash_offer),
            minimum_acceptable_offer: num(ade.minimum_acceptable_offer),
            investor_ceiling_mid: num(ade.investor_ceiling_mid),
          }
        : null,
      // Full persisted snapshot for zone/strategy/comp-anchor resolution.
      ade_snapshot: ade,
      ade_snapshot_at: metadata.ade_snapshot_at || null,
      contract_state: metadata.contract_state || null,
      known_facts: metadata.seller_facts || {},
    };
  } catch (load_error) {
    warn("[SELLER_DEAL_STATE_LOAD_FAILED]", {
      thread_key: threadKey,
      error: load_error?.message || "deal_state_load_failed",
    });
    return null;
  }
}

/** Derive the spec §16 negotiation event list for one persisted turn. */
export function deriveNegotiationWorkflowEvents({
  transition = null,
  negotiationState = null,
  previousState = null,
  strategyDecision = null,
  offerExecution = null,
  compAnchor = null,
  adeSnapshot = null,
} = {}) {
  const events = [];
  const state = negotiationState || {};
  const prev = previousState || {};
  const history = Array.isArray(state.asking_price_history) ? state.asking_price_history : [];
  const prevHistory = Array.isArray(prev.asking_price_history) ? prev.asking_price_history : [];

  if (history.length > prevHistory.length) {
    const latest = history[history.length - 1];
    events.push(latest.kind === "initial" ? "asking_price_captured" : "asking_price_changed");
    if (latest.kind === "counter") events.push("seller_counter_received");
  }
  const concessions = Array.isArray(state.seller_concessions) ? state.seller_concessions.length : 0;
  const prevConcessions = Array.isArray(prev.seller_concessions) ? prev.seller_concessions.length : 0;
  if (concessions > prevConcessions) events.push("seller_concession_detected");

  if (adeSnapshot) {
    events.push(prev.recommended_offer != null ? "underwriting_recalculated" : "underwriting_completed");
  }
  if (strategyDecision?.strategy) {
    events.push("strategy_selected");
    if (strategyDecision.strategy === "final_authorized_offer") events.push("final_offer_reached");
    if (["novation_probe", "seller_finance_probe"].includes(strategyDecision.strategy)) {
      events.push("alternate_strategy_selected");
    }
    if (String(strategyDecision.reason_code || "").includes("CONCESSION_AUTHORIZED")) {
      events.push("concession_authorized");
    }
    if (strategyDecision.review_required) events.push("review_required");
  }
  if (transition?.facts_patch?.condition_disclosed === true) events.push("condition_fact_captured");
  if (compAnchor?.eligible) events.push("comp_anchor_selected");
  const monetaryAmount = Number(strategyDecision?.monetary?.amount);
  if (Number.isFinite(monetaryAmount) && monetaryAmount > 0) events.push("offer_authorized");
  if (offerExecution?.queued) events.push("offer_queued");
  if (state.terms_accepted === true && prev.terms_accepted !== true) events.push("terms_accepted");
  if (state.terms_accepted === true && state.contract_readiness === "ready") events.push("contract_ready");
  else if (state.terms_accepted === true && (state.unresolved_contract_fields || []).length > 0) {
    events.push("contract_information_requested");
  }
  if (transition?.review_required) events.push("review_required");

  return [...new Set(events)];
}

async function emitNegotiationWorkflowEvents({
  supabase,
  opportunity,
  transition,
  negotiationState,
  previousState,
  strategyDecision,
  offerExecution,
  compAnchor,
  adeSnapshot,
  inboundEventId,
  threadKey,
  propertyId,
  ownerId,
}) {
  const events = deriveNegotiationWorkflowEvents({
    transition,
    negotiationState,
    previousState,
    strategyDecision,
    offerExecution,
    compAnchor,
    adeSnapshot,
  });

  let emitted = 0;
  for (const eventType of events) {
    try {
      await emitAutomationEvent(
        {
          event_type: eventType,
          source: "seller_negotiation_engine",
          dedupe_key: `negotiation:${opportunity.id}:${eventType}:${inboundEventId || transition?.resolved_at || ""}`,
          conversation_thread_id: threadKey,
          property_id: propertyId || null,
          master_owner_id: ownerId || null,
          payload: {
            stage_before: transition?.stage_before || null,
            stage_after: transition?.stage_after || null,
            asking_price_history: negotiationState?.asking_price_history || [],
            ade_snapshot_id: negotiationState?.ade_snapshot_id || null,
            authority_floor: negotiationState?.authorized_offer_floor ?? null,
            authority_ceiling: negotiationState?.authorized_offer_ceiling ?? null,
            recommended_offer: negotiationState?.recommended_offer ?? null,
            strategy: strategyDecision?.strategy || negotiationState?.current_strategy || null,
            reason_code: strategyDecision?.reason_code || transition?.reasoning_code || null,
            selected_comp: compAnchor?.anchor || null,
            template_use_case:
              offerExecution?.template_use_case || strategyDecision?.template_use_case || null,
            next_action: negotiationState?.next_action || transition?.next_action || null,
            confidence: negotiationState?.automation_confidence ?? null,
            negotiation_zone: negotiationState?.negotiation_zone || null,
            queue_row_id: offerExecution?.queue_row_id || null,
          },
        },
        supabase ? { supabaseClient: supabase } : {}
      );
      emitted += 1;
    } catch {
      // Event emission is observability — never a persistence blocker.
    }
  }
  return emitted;
}

/**
 * Persist all deal-record artifacts for one resolved transition.
 * Never throws — returns a summary with per-step outcomes.
 */
export async function persistSellerTransitionArtifacts({
  transition = null,
  threadKey = null,
  propertyId = null,
  ownerId = null,
  intent = null,
  inboundEventId = null,
  dryRun = false,
  supabaseClient = null,
  deps = {},
  // Negotiation-loop inputs (spec §2/§7/§16) — all optional for legacy callers.
  priceSignal = null,
  strategyDecision = null,
  zone = null,
  engineDecision = null,
  offerExecution = null,
  contractFacts = null,
  compAnchor = null,
  classificationConfidence = null,
  adeSnapshotPrecomputed = null,
} = {}) {
  const summary = {
    ok: true,
    skipped: false,
    opportunity_id: null,
    opportunity_created: false,
    stage_advanced: false,
    facts_persisted: false,
    negotiation_state_updated: false,
    workflow_events_emitted: 0,
    ade: { requested: transition?.ade_action || ADE_ACTIONS.NONE, ran: false, error: null },
  };

  if (!transition) return { ...summary, skipped: true, reason: "no_transition" };
  if (dryRun) return { ...summary, skipped: true, reason: "writes_suppressed" };

  const supabase = supabaseClient || getDefaultSupabaseClient();
  if (!supabase || !clean(threadKey)) {
    return { ...summary, skipped: true, reason: "missing_supabase_or_thread" };
  }

  try {
    let opportunity = await findExistingOpportunity(supabase, { ownerId, propertyId, threadKey });

    if (!opportunity && transitionQualifiesForOpportunity(transition)) {
      const promotion = await promoteThreadToOpportunity(
        {
          thread_key: threadKey,
          master_owner_id: ownerId || null,
          property_id: propertyId || null,
          universal_stage: transition.stage_after,
          last_inbound_at: transition.resolved_at || new Date().toISOString(),
          reply_intent: intent || null,
          next_action: transition.next_action || null,
          follow_up_due_at: transition.next_action_due_at || null,
        },
        { source: SOURCE, reason: transition.reasoning_code || "seller_transition", stage: transition.stage_after },
        { supabase }
      );
      if (promotion?.ok) {
        opportunity = { ...promotion.opportunity, metadata: promotion.opportunity?.metadata || {} };
        summary.opportunity_created = true;
      }
    }

    if (!opportunity) {
      return { ...summary, skipped: true, reason: "no_opportunity_to_track" };
    }
    summary.opportunity_id = opportunity.id;

    // ── Canonical ADE execution (spec §5/§6/§7) ─────────────────────────
    // A snapshot precomputed by the orchestrator (pre-reply, so the strategy
    // router saw fresh authority) is reused — ADE never runs twice per turn.
    let adeSnapshot = adeSnapshotPrecomputed || null;
    if (adeSnapshot) {
      summary.ade.ran = true;
      summary.ade.precomputed = true;
    } else if (
      transition.ade_action &&
      transition.ade_action !== ADE_ACTIONS.NONE &&
      clean(propertyId || opportunity.primary_property_id)
    ) {
      try {
        const ade = await runCanonicalAde(propertyId || opportunity.primary_property_id, {
          ...deps,
          supabase,
        });
        if (ade.ok) {
          adeSnapshot = ade.score || null;
          summary.ade.ran = true;
        } else {
          summary.ade.error = ade.error;
        }
      } catch (ade_error) {
        summary.ade.error = ade_error?.message || "ade_failed";
      }
    }

    // ── Canonical negotiation state (spec §2) ───────────────────────────
    const previousMetadata =
      opportunity.metadata && typeof opportunity.metadata === "object" ? opportunity.metadata : {};
    const previousState = previousMetadata.negotiation_state || null;
    const nowIso = transition.resolved_at || new Date().toISOString();

    // Legacy callers pass no price signal — derive one from resolver facts so
    // history/counter bookkeeping still runs through the single reducer.
    const priceFact = transition.facts_patch?.asking_price || null;
    const previousAsk = num(previousState?.current_asking_price ?? previousState?.current_ask);
    const effectivePriceSignal =
      priceSignal ||
      (num(priceFact?.value) > 0
        ? {
            asking_price: {
              value: num(priceFact.value),
              currency: priceFact.currency || "USD",
              price_type: priceFact.price_type || "exact",
              confidence: priceFact.confidence ?? null,
              extracted_text: priceFact.extracted_text || null,
              source_message_id: priceFact.source_message_id || null,
              captured_at: priceFact.captured_at || nowIso,
            },
            is_counter:
              Number(transition.stage_after_number || 0) >= 5 &&
              previousAsk !== null &&
              num(priceFact.value) !== previousAsk,
          }
        : null);

    const negotiationState = applyNegotiationTurn(previousState, {
      price_signal: effectivePriceSignal,
      ade_snapshot: adeSnapshot || previousMetadata.ade_snapshot || null,
      strategy_decision: strategyDecision,
      zone,
      transition,
      engine_decision: engineDecision,
      facts: transition.facts_patch || null,
      intent,
      classification_confidence: classificationConfidence,
      offer_execution: offerExecution,
      contract_facts: contractFacts,
      comp_anchor: compAnchor,
      source_message_id:
        priceFact?.source_message_id || transition.source_message_id || inboundEventId || null,
      now: nowIso,
    });
    negotiationState.deal_id = negotiationState.deal_id || opportunity.id;
    negotiationState.property_id =
      negotiationState.property_id || propertyId || opportunity.primary_property_id || null;
    negotiationState.owner_id = negotiationState.owner_id || ownerId || null;
    negotiationState.thread_key = negotiationState.thread_key || threadKey;

    // ── Column-level facts + next action ────────────────────────────────
    const columnPatch = {
      next_action: transition.next_action || null,
      next_action_due: transition.next_action_due_at || null,
      latest_intent: clean(intent) || null,
      source: SOURCE,
      actor: "seller_inbound_orchestrator",
      reason: transition.reasoning_code || null,
    };
    const askingPrice = num(transition.facts_patch?.asking_price?.value);
    if (askingPrice) {
      const atOffer = Number(transition.stage_after_number || 0) >= 5;
      if (atOffer && num(opportunity.asking_price) && askingPrice !== num(opportunity.asking_price)) {
        columnPatch.seller_counter = askingPrice;
      } else {
        columnPatch.asking_price = askingPrice;
      }
    }
    if (transition.lead_temperature) columnPatch.temperature = transition.lead_temperature;
    if (adeSnapshot?.recommended_cash_offer != null) {
      columnPatch.recommended_offer = num(adeSnapshot.recommended_cash_offer);
      if (columnPatch.asking_price || num(opportunity.asking_price)) {
        const ask = columnPatch.asking_price || num(opportunity.asking_price);
        if (ask > 0 && columnPatch.recommended_offer != null) {
          columnPatch.offer_to_ask_gap = ask - columnPatch.recommended_offer;
        }
      }
    }
    if (num(adeSnapshot?.valuation_mid) != null) columnPatch.arv = num(adeSnapshot.valuation_mid);
    if (num(negotiationState.latest_offer) != null) {
      columnPatch.current_offer = num(negotiationState.latest_offer);
    }

    try {
      const update = await updateOpportunity(opportunity.id, columnPatch, { supabase });
      summary.facts_persisted = Boolean(update?.ok);
    } catch (update_error) {
      warn("[SELLER_TRANSITION_OPPORTUNITY_UPDATE_FAILED]", {
        opportunity_id: opportunity.id,
        error: update_error?.message || "update_failed",
      });
    }

    // ── Monotonic acquisition-stage advancement ─────────────────────────
    const currentNumber = lifecycleStageNumber(opportunity.acquisition_stage) || 1;
    const targetNumber = Number(transition.stage_after_number || 1);
    if (targetNumber > currentNumber) {
      try {
        const advanced = await transitionOpportunityStage(
          opportunity.id,
          {
            to_stage: normalizeLifecycleStage(transition.stage_after),
            reason: transition.reasoning_code || "seller_transition",
            source: SOURCE,
            actor: "seller_inbound_orchestrator",
            next_action: transition.next_action || null,
            next_action_due: transition.next_action_due_at || null,
          },
          { supabase }
        );
        summary.stage_advanced = Boolean(advanced?.ok);
        if (!advanced?.ok) summary.stage_advance_block = advanced?.error || null;
      } catch (stage_error) {
        warn("[SELLER_TRANSITION_STAGE_ADVANCE_FAILED]", {
          opportunity_id: opportunity.id,
          to_stage: transition.stage_after,
          error: stage_error?.message || "stage_advance_failed",
        });
      }
    }

    // ── Metadata: seller facts, negotiation state, ADE snapshot ─────────
    try {
      const metadata = {
        ...previousMetadata,
        seller_facts: { ...(previousMetadata.seller_facts || {}), ...(transition.facts_patch || {}) },
        negotiation_state: negotiationState,
        last_reasoning_code: transition.reasoning_code || null,
        last_inbound_event_id: inboundEventId || previousMetadata.last_inbound_event_id || null,
        ...(adeSnapshot
          ? {
              ade_snapshot: adeSnapshot,
              ade_snapshot_at: new Date().toISOString(),
              ade_inputs: {
                asking_price: askingPrice ?? num(opportunity.asking_price) ?? null,
                seller_facts: transition.facts_patch || {},
                trigger: transition.ade_action,
              },
            }
          : {}),
      };
      const { error: metadataError } = await supabase
        .from(TABLE)
        .update({ metadata, updated_at: new Date().toISOString() })
        .eq("id", opportunity.id);
      if (metadataError) throw metadataError;
      summary.negotiation_state_updated = true;
    } catch (metadata_error) {
      warn("[SELLER_TRANSITION_METADATA_FAILED]", {
        opportunity_id: opportunity.id,
        error: metadata_error?.message || "metadata_update_failed",
      });
    }

    // ── Workflow Studio negotiation events (spec §16) ───────────────────
    try {
      summary.workflow_events_emitted = await emitNegotiationWorkflowEvents({
        supabase,
        opportunity,
        transition,
        negotiationState,
        previousState,
        strategyDecision,
        offerExecution,
        compAnchor,
        adeSnapshot,
        inboundEventId,
        threadKey,
        propertyId: propertyId || opportunity.primary_property_id || null,
        ownerId,
      });
    } catch (event_error) {
      warn("[SELLER_TRANSITION_EVENT_EMIT_FAILED]", {
        opportunity_id: opportunity.id,
        error: event_error?.message || "event_emit_failed",
      });
    }

    info("[SELLER_TRANSITION_PERSISTED]", {
      thread_key: threadKey,
      opportunity_id: opportunity.id,
      stage_after: transition.stage_after,
      stage_advanced: summary.stage_advanced,
      ade_ran: summary.ade.ran,
      reasoning_code: transition.reasoning_code,
    });

    return summary;
  } catch (error) {
    warn("[SELLER_TRANSITION_PERSIST_FAILED]", {
      thread_key: threadKey,
      error: error?.message || "persist_failed",
    });
    return { ...summary, ok: false, error: error?.message || "persist_failed" };
  }
}

export default persistSellerTransitionArtifacts;
