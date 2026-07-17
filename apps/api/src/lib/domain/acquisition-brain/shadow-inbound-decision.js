// ─── acquisition-brain/shadow-inbound-decision.js ──────────────────────────
// Read-only Acquisition Brain evaluation for live inbound. Never enqueues,
// never sends, never mutates seller stages. Legacy seller-flow remains
// transport-authoritative.

import {
  ACQUISITION_BRAIN_VERSION,
  ACQUISITION_LIFECYCLE_STAGES as S,
  canAdvanceLifecycleStage,
  evaluateStage5Readiness,
  evaluateStage6Readiness,
  normalizeLifecycleStage,
  recommendStageFromFacts,
} from "./lifecycle-registry.js";
import {
  resolveNextBestAction,
  NBA_ACTION_TYPES,
} from "./next-best-action-registry.js";
import {
  COMPARISON_CATEGORY,
  compareNormalizedDecisions,
  NORMALIZED_ACTIONS,
  NORMALIZED_STAGES,
} from "./shadow-comparison.js";

export const SHADOW_EVENT_TYPE = "acquisition_brain_shadow_decision";
/** @deprecated Prefer COMPARISON_CATEGORY — kept for test/back-compat aliases */
export const SHADOW_COMPARISON = Object.freeze({
  EXACT_MATCH: COMPARISON_CATEGORY.EXACT_MATCH,
  COMPATIBLE_MATCH: COMPARISON_CATEGORY.COMPATIBLE_MATCH,
  BRAIN_IMPROVEMENT: COMPARISON_CATEGORY.BRAIN_IMPROVEMENT,
  LEGACY_IMPROVEMENT: COMPARISON_CATEGORY.LEGACY_IMPROVEMENT,
  BEHAVIORAL_DIVERGENCE: COMPARISON_CATEGORY.BEHAVIORAL_DIVERGENCE,
  SAFETY_DIVERGENCE: COMPARISON_CATEGORY.SAFETY_DIVERGENCE,
  // Legacy labels mapped into behavioral for older callers
  STAGE_DIVERGENCE: COMPARISON_CATEGORY.BEHAVIORAL_DIVERGENCE,
  ACTION_DIVERGENCE: COMPARISON_CATEGORY.BEHAVIORAL_DIVERGENCE,
  TEMPLATE_DIVERGENCE: COMPARISON_CATEGORY.BEHAVIORAL_DIVERGENCE,
  LEGACY_ONLY: COMPARISON_CATEGORY.COMPATIBLE_MATCH,
  BRAIN_ONLY: COMPARISON_CATEGORY.COMPATIBLE_MATCH,
});

export {
  COMPARISON_CATEGORY,
  NORMALIZED_ACTIONS,
  NORMALIZED_STAGES,
  compareNormalizedDecisions,
} from "./shadow-comparison.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/**
 * Map classification + optional fact extraction into Acquisition Brain facts.
 */
export function extractBrainFactsFromInbound({
  classification = null,
  fact_extraction = null,
  message = "",
} = {}) {
  const c = classification && typeof classification === "object" ? classification : {};
  const fe = fact_extraction && typeof fact_extraction === "object" ? fact_extraction : {};
  const seller = c.seller_state && typeof c.seller_state === "object" ? c.seller_state : {};
  const primary = lower(c.primary_intent || c.detected_intent || "");
  const text = lower(message);

  const ownership =
    seller.ownership_confirmed === true ||
    primary === "ownership_confirmed" ||
    c.secondary_intent === "ownership_confirmed";

  const asks_offer = primary === "asks_offer";
  const proposal_request =
    asks_offer ||
    /what'?s the proposal|what is the proposal|send (me )?(a |the )?proposal/.test(text);

  const facts = {
    ownership_confirmed: ownership || proposal_request,
    proposal_interest_confirmed: proposal_request || primary === "seller_interested",
    seller_requests_proposal: proposal_request,
    opt_out: primary === "opt_out" || c.compliance_flag === "stop_texting",
    wrong_person: primary === "wrong_number" || primary === "wrong_person",
    wrong_number: primary === "wrong_number",
    not_interested: primary === "not_interested",
    hostile: primary === "hostile_or_legal" || c.compliance_flag === "litigator",
    confidence: Number(c.confidence ?? 1) || 0,
    human_review_required: Boolean(c.human_review_required),
  };

  // Price
  const price =
    fe.asking_price ||
    seller.price_mentioned ||
    (primary === "asking_price_provided" ? { value: true } : null);
  if (price) {
    facts.asking_price = typeof price === "object" ? price : { value: price };
    facts.asking_price_known = true;
    facts.asking_price_provided = true;
  }

  // Condition signals
  if (
    primary === "condition_disclosed" ||
    /roof|hvac|foundation|needs work|repairs?/.test(text)
  ) {
    facts.condition_summary = clean(message).slice(0, 200) || "condition_disclosed";
    facts.property_condition_sufficiently_known = true;
    if (/roof/.test(text)) facts.roof = true;
    if (/hvac/.test(text)) facts.hvac = true;
  }

  // Authority
  if (/husband|wife|spouse|also owns|co-?owner/.test(text)) {
    facts.spouse_co_owner = true;
    facts.additional_signers = true;
    facts.can_execute_alone = false;
    facts.authority_risks_identified = true;
  }
  if (/probate|passed away|executor|heir|estate/.test(text)) {
    facts.probate = true;
    facts.probate_heirship = true;
    facts.estate = true;
    facts.authority_risks_identified = true;
  }
  if (/\bllc\b|limited liability/.test(text)) {
    facts.entity_type = "llc";
    facts.llc_authority = true;
    facts.authority_risks_identified = true;
  }
  if (/\btrust\b/.test(text)) {
    facts.entity_type = "trust";
    facts.trust_authority = true;
    facts.authority_risks_identified = true;
  }

  // Transaction claims from text — facts only, no stage advance
  if (/under contract|already sold|went under contract/.test(text)) {
    facts.seller_claims_under_contract = true;
  }
  if (/\bwe closed\b|already closed|closed on/.test(text)) {
    facts.seller_claims_closed = true;
  }
  if (/send (me )?(the )?paperwork|send contract|email (me )?the contract/.test(text)) {
    facts.contract_requested = true;
  }

  if (fe.underwriting_ready) facts.underwriting_ready = true;
  if (fe.authority_risks_identified) facts.authority_risks_identified = true;

  return facts;
}

/**
 * Compare legacy seller-flow decision vs brain NBA (normalized vocabulary).
 */
export function compareShadowDecisions({ brain = null, legacy = null, facts = {} } = {}) {
  return compareNormalizedDecisions({ brain, legacy, facts });
}

/**
 * Pure shadow evaluation. Side-effect free.
 */
export function evaluateAcquisitionBrainShadow({
  classification = null,
  fact_extraction = null,
  message = "",
  current_stage = null,
  thread_key = null,
  inbound_event_id = null,
  message_event_id = null,
  legacy_decision = null,
  inbound_timestamp = null,
  classification_version = null,
  processing_started_at = null,
} = {}) {
  const started = processing_started_at || Date.now();
  const facts = extractBrainFactsFromInbound({
    classification,
    fact_extraction,
    message,
  });
  const stage_before = normalizeLifecycleStage(
    current_stage || classification?.stage_hint || null,
    S.OWNERSHIP_CHECK
  );

  // Unsupported transaction claims from text → facts only
  if (facts.seller_claims_under_contract || facts.seller_claims_closed) {
    const nba = {
      action_type: NBA_ACTION_TYPES.UPDATE_FACTS_ONLY,
      reason_code: "seller_transaction_claim_text_only",
      lifecycle_stage_before: stage_before,
      lifecycle_stage_after: stage_before,
      required_template_use_case: null,
      missing_facts: [],
      facts_satisfied: Object.keys(facts).filter((k) => facts[k] === true),
      confidence: facts.confidence ?? 1,
      timing_policy: "none",
      human_review_flag: false,
      idempotency_key: `nba:update_facts_only:${inbound_event_id || ""}`,
    };
    const comparison = compareShadowDecisions({
      brain: nba,
      legacy: legacy_decision,
      facts,
    });
    return finalizeShadow({
      facts,
      stage_before,
      nba,
      recommendation: { stage: stage_before, reason: "text_transaction_claim" },
      stage5: null,
      stage6: null,
      comparison,
      classification,
      thread_key,
      inbound_event_id,
      message_event_id,
      inbound_timestamp,
      classification_version,
      legacy_decision,
      started,
      unsupported_transition_reason: facts.seller_claims_closed
        ? "seller_text_cannot_advance_to_closed"
        : "seller_text_cannot_advance_to_under_contract",
    });
  }

  const recommendation = recommendStageFromFacts(facts);
  const nba = resolveNextBestAction({
    facts,
    current_stage: stage_before,
    classification,
    confidence: facts.confidence,
    inbound_event_id: inbound_event_id || message_event_id,
  });

  // Stage 5/6 readiness diagnostics (never force advance)
  const stage5 =
    nba.lifecycle_stage_after === S.ACTUAL_PROPOSAL ||
    stage_before === S.ACTUAL_PROPOSAL
      ? evaluateStage5Readiness(facts)
      : null;
  const stage6 =
    nba.lifecycle_stage_after === S.FORMAL_CONTRACT ||
    stage_before === S.FORMAL_CONTRACT ||
    facts.contract_requested
      ? evaluateStage6Readiness(facts)
      : null;

  // If Stage 6 request without readiness, keep facts-only
  let final_nba = nba;
  if (facts.contract_requested && stage6 && !stage6.entry_allowed) {
    final_nba = {
      ...nba,
      action_type: NBA_ACTION_TYPES.HUMAN_REVIEW,
      reason_code: stage6.reason || "stage6_entry_requirements_unmet",
      required_template_use_case: null,
      human_review_flag: true,
      lifecycle_stage_after: stage_before,
    };
  }

  // Guard transaction stages
  const advance_gate = canAdvanceLifecycleStage({
    from_stage: stage_before,
    to_stage: final_nba.lifecycle_stage_after,
    advance_source: "seller_text",
    facts,
  });
  let unsupported_transition_reason = null;
  if (!advance_gate.ok && final_nba.lifecycle_stage_after !== stage_before) {
    unsupported_transition_reason = advance_gate.reason;
    final_nba = {
      ...final_nba,
      lifecycle_stage_after: stage_before,
      action_type:
        final_nba.action_type === NBA_ACTION_TYPES.SEND_TEMPLATE
          ? final_nba.action_type
          : NBA_ACTION_TYPES.UPDATE_FACTS_ONLY,
    };
  }

  const comparison = compareShadowDecisions({
    brain: final_nba,
    legacy: legacy_decision,
    facts,
  });

  return finalizeShadow({
    facts,
    stage_before,
    nba: final_nba,
    recommendation,
    stage5,
    stage6,
    comparison,
    classification,
    thread_key,
    inbound_event_id,
    message_event_id,
    inbound_timestamp,
    classification_version,
    legacy_decision,
    started,
    unsupported_transition_reason,
  });
}

/** Build stable dedupe key; refuse empty/missing message ids. */
export function buildShadowDedupeKey(message_event_id = null) {
  const id = clean(message_event_id);
  if (!id || id === "none") {
    return {
      ok: false,
      dedupe_key: null,
      reason: "missing_message_event_id",
    };
  }
  return {
    ok: true,
    dedupe_key: `acquisition_brain_shadow:${id}`,
    reason: null,
  };
}

function finalizeShadow({
  facts,
  stage_before,
  nba,
  recommendation,
  stage5,
  stage6,
  comparison,
  classification,
  thread_key,
  inbound_event_id,
  message_event_id,
  inbound_timestamp,
  classification_version,
  legacy_decision,
  started,
  unsupported_transition_reason,
}) {
  const duration_ms = Math.max(0, Date.now() - started);
  const satisfied = Object.keys(facts).filter(
    (k) => facts[k] === true || (facts[k] && typeof facts[k] === "object")
  );
  const missing = [...(nba.missing_facts || [])];

  const brain_decision = {
    classification_version:
      classification_version ||
      classification?.classify_version ||
      classification?.version ||
      null,
    canonical_thread: thread_key || null,
    lifecycle_stage_before: stage_before,
    supported_facts: satisfied,
    missing_facts: missing,
    proposed_lifecycle_stage_after: nba.lifecycle_stage_after,
    proposed_next_best_action: nba.action_type,
    action_reason_code: nba.reason_code,
    template_use_case: nba.required_template_use_case,
    timing_policy: nba.timing_policy,
    human_review_flag: Boolean(nba.human_review_flag),
    unsupported_transition_reason,
    brain_registry_version: ACQUISITION_BRAIN_VERSION,
    recommendation_reason: recommendation?.reason || null,
    stage5_readiness: stage5,
    stage6_readiness: stage6,
    confidence: nba.confidence,
    idempotency_key: nba.idempotency_key,
  };

  const legacy_snapshot = legacy_decision
    ? {
        stage_before: legacy_decision.stage_before || null,
        stage_after: legacy_decision.stage_after || null,
        action:
          legacy_decision.effective_action ||
          legacy_decision.action ||
          legacy_decision.next_action ||
          null,
        use_case:
          legacy_decision.use_case ||
          legacy_decision.selected_use_case ||
          legacy_decision.required_template_use_case ||
          null,
        template:
          legacy_decision.template_id ||
          legacy_decision.selected_template_id ||
          null,
        timing_decision: legacy_decision.timing || legacy_decision.timing_policy || null,
      }
    : null;

  const dedupe = buildShadowDedupeKey(message_event_id || inbound_event_id);
  const event =
    dedupe.ok
      ? {
          event_type: SHADOW_EVENT_TYPE,
          dedupe_key: dedupe.dedupe_key,
          conversation_thread_id: thread_key || null,
          payload: {
            message_event_id: message_event_id || inbound_event_id || null,
            thread_key,
            inbound_timestamp: inbound_timestamp || null,
            classifier_output: {
              primary_intent:
                classification?.primary_intent || classification?.detected_intent || null,
              confidence: classification?.confidence ?? null,
              language: classification?.language || null,
              version: brain_decision.classification_version,
            },
            legacy_decision: legacy_snapshot,
            brain_decision,
            comparison_result: comparison.result || comparison.category,
            reason_codes: comparison.reason_codes || [],
            divergence_reason: comparison.divergence_reason,
            brain_normalized: comparison.brain_normalized || null,
            legacy_normalized: comparison.legacy_normalized || null,
            safety_divergence: Boolean(comparison.safety_divergence),
            evidence: comparison.evidence || null,
            registry_version: ACQUISITION_BRAIN_VERSION,
            internal_public_eligibility: "shadow_read_only",
            processing_duration_ms: duration_ms,
          },
        }
      : null;

  return {
    ok: true,
    shadow: true,
    transport_authoritative: "legacy_seller_flow",
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    may_write_send_queue: false,
    may_invoke_provider: false,
    brain_decision,
    legacy_decision: legacy_snapshot,
    comparison: {
      result: comparison.result || comparison.category,
      category: comparison.category || comparison.result,
      reason_codes: comparison.reason_codes || [],
      divergence_reason: comparison.divergence_reason,
      safety_divergence: Boolean(comparison.safety_divergence),
      brain_normalized: comparison.brain_normalized || null,
      legacy_normalized: comparison.legacy_normalized || null,
      evidence: comparison.evidence || null,
    },
    facts,
    processing_duration_ms: duration_ms,
    dedupe,
    event,
  };
}

/**
 * Emit shadow event via existing automation path. Never throws into inbound.
 */
export async function emitAcquisitionBrainShadowDecision(shadow_result, deps = {}) {
  if (!shadow_result?.event) {
    return {
      ok: false,
      reason: shadow_result?.dedupe?.reason || "missing_shadow_event",
      emitted: false,
    };
  }
  const emit = deps.emitAutomationEvent;
  if (typeof emit !== "function") {
    return { ok: false, reason: "emit_unavailable", dry: true, emitted: false };
  }
  try {
    const result = await emit(
      {
        event_type: shadow_result.event.event_type,
        dedupe_key: shadow_result.event.dedupe_key,
        source: "acquisition_brain_shadow",
        conversation_thread_id: shadow_result.event.conversation_thread_id,
        payload: shadow_result.event.payload,
      },
      deps.supabase ? { supabase: deps.supabase, supabaseClient: deps.supabase } : {}
    );
    return {
      ok: true,
      emitted: !result?.duplicate,
      duplicate: Boolean(result?.duplicate),
      dedupe_key: shadow_result.event.dedupe_key,
      event_id: result?.event?.id || result?.id || null,
    };
  } catch (error) {
    // Shadow persistence failure must never affect seller reply processing.
    return {
      ok: false,
      reason: error?.message || "emit_failed",
      emitted: false,
    };
  }
}

export default {
  SHADOW_EVENT_TYPE,
  SHADOW_COMPARISON,
  extractBrainFactsFromInbound,
  compareShadowDecisions,
  evaluateAcquisitionBrainShadow,
  emitAcquisitionBrainShadowDecision,
};
