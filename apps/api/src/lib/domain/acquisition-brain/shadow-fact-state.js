// ─── acquisition-brain/shadow-fact-state.js ────────────────────────────────
// Build evidence-backed fact state for shadow evaluation only.
// Never persists canonical business state; never enqueues/sends.

import {
  FACT_CONTRACT_VERSION,
  buildClassifierResultContract,
  mergeFactIntoState,
  resolveActiveFacts,
  sortFactsDeterministically,
  toJsonSafe,
  FACT_TYPES,
  measureFactProvenanceCoverage,
  CLAIM_STATUS,
} from "./fact-provenance-contract.js";
import { evaluateAcquisitionBrainShadow } from "./shadow-inbound-decision.js";
import {
  ACQUISITION_BRAIN_VERSION,
  ACQUISITION_LIFECYCLE_STAGES as S,
} from "./lifecycle-registry.js";

export const SHADOW_FACT_STATE_EVENT = "acquisition_brain_shadow_fact_state";
/** Bounded history replay when no snapshot exists. Terminal facts survive via snapshot path. */
export const SHADOW_FACT_MAX_HISTORY = 40;

/** Facts that must never disappear through history truncation alone. */
export const TERMINAL_MEMORY_FACT_TYPES = new Set([
  FACT_TYPES.OPT_OUT,
  FACT_TYPES.WRONG_NUMBER,
  FACT_TYPES.OWNERSHIP_DENIED,
  FACT_TYPES.SOLD_PROPERTY,
  FACT_TYPES.NEVER_OWNED,
  FACT_TYPES.SPOUSE_REQUIRED,
  FACT_TYPES.CO_OWNER_REQUIRED,
  FACT_TYPES.LLC_AUTHORITY_REQUIRED,
  FACT_TYPES.TRUST_AUTHORITY_REQUIRED,
  FACT_TYPES.PROBATE_DETECTED,
  FACT_TYPES.CAN_EXECUTE_ALONE,
]);

function clean(value) {
  return String(value ?? "").trim();
}

function isCanonicalE164Thread(thread) {
  const t = clean(thread);
  return t.startsWith("+") && t.length >= 11;
}

/**
 * Reconstruct prior facts from previous shadow fact-state events (preferred)
 * or by replaying message_events (fallback).
 */
export async function loadPriorShadowFacts({
  thread_key = null,
  supabase = null,
  max_messages = SHADOW_FACT_MAX_HISTORY,
} = {}) {
  const thread = clean(thread_key);
  if (!thread || !supabase?.from) {
    return {
      facts: [],
      source: "empty",
      messages_replayed: 0,
      history_incomplete: false,
      error: !thread ? "missing_thread" : "missing_supabase",
    };
  }

  if (!isCanonicalE164Thread(thread)) {
    return {
      facts: [],
      source: "rejected_non_e164_thread",
      messages_replayed: 0,
      history_incomplete: true,
      error: "archived_alias_or_non_e164",
    };
  }

  // Path A: Prefer prior shadow fact-state events (primary memory)
  try {
    const { data: prior_events, error } = await supabase
      .from("automation_events")
      .select("id,payload,created_at,dedupe_key")
      .eq("event_type", SHADOW_FACT_STATE_EVENT)
      .eq("conversation_thread_id", thread)
      .order("created_at", { ascending: false })
      .limit(5);
    if (!error && prior_events?.length) {
      const latest = prior_events[0];
      const version =
        latest.payload?.fact_contract_version ||
        latest.payload?.contract_version ||
        null;
      const after = latest.payload?.facts_after || latest.payload?.facts || [];
      if (Array.isArray(after) && after.length) {
        // Version compatibility: accept same major contract family
        const compatible =
          !version ||
          String(version).startsWith("acquisition_brain_fact_contract");
        if (compatible) {
          return {
            facts: after.map((f) => toJsonSafe(f)),
            source: "prior_shadow_fact_state_event",
            messages_replayed: 0,
            history_incomplete: Boolean(latest.payload?.history_incomplete),
            prior_event_id: latest.id,
            fact_contract_version: version || FACT_CONTRACT_VERSION,
          };
        }
      }
    }
  } catch {
    /* fall through */
  }

  // Path B: Fallback history replay — bounded; truncation explicit
  try {
    // Count total first to detect truncation
    const { count: total_count } = await supabase
      .from("message_events")
      .select("id", { count: "exact", head: true })
      .eq("direction", "inbound")
      .eq("thread_key", thread);

    const { data: msgs, error } = await supabase
      .from("message_events")
      .select(
        "id,message_body,detected_intent,classification_confidence,language,created_at,thread_key,received_at,event_timestamp"
      )
      .eq("direction", "inbound")
      .eq("thread_key", thread)
      .order("created_at", { ascending: false })
      .limit(max_messages);
    if (error) throw error;

    // Process oldest→newest for correct merge order
    const ordered = [...(msgs || [])].reverse().sort((a, b) => {
      const ta = Date.parse(a.received_at || a.event_timestamp || a.created_at || 0) || 0;
      const tb = Date.parse(b.received_at || b.event_timestamp || b.created_at || 0) || 0;
      if (ta !== tb) return ta - tb;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });

    let facts = [];
    for (const m of ordered) {
      if (m.thread_key && !isCanonicalE164Thread(m.thread_key)) continue;
      const contract = buildClassifierResultContract({
        message: m.message_body || "",
        classification: {
          primary_intent: m.detected_intent || "unclear",
          confidence: m.classification_confidence ?? 0.85,
          language: m.language || null,
        },
        source_message_id: m.id,
        source_timestamp: m.received_at || m.event_timestamp || m.created_at,
      });
      for (const f of contract.facts || []) {
        facts = mergeFactIntoState(facts, f);
      }
    }

    const total = Number(total_count) || ordered.length;
    const truncated = total > max_messages;
    return {
      facts: sortFactsDeterministically(facts),
      source: "message_events_replay",
      messages_replayed: ordered.length,
      history_incomplete: truncated,
      history_total_inbound: total,
      history_replay_bound: max_messages,
      truncation_policy:
        "latest_snapshot_primary; fallback_replays_most_recent_N_asc_merge; terminal_facts_require_snapshot_or_in_window",
    };
  } catch (error) {
    return {
      facts: [],
      source: "history_load_failed",
      messages_replayed: 0,
      history_incomplete: true,
      error: error?.message || "history_load_failed",
    };
  }
}

/**
 * Pure incremental conversation replay vs full rebuild — for equivalence proofs.
 */
export function replayConversationIncremental(messages = []) {
  let facts = [];
  const states = [];
  for (const m of messages) {
    const s = buildShadowFactState({
      facts_before: facts,
      message: m.message || m.message_body || "",
      classification: m.classification || {
        primary_intent: m.detected_intent || m.primary_intent || "unclear",
        confidence: m.confidence ?? m.classification_confidence ?? 0.9,
        language: m.language || null,
      },
      message_event_id: m.id || m.message_event_id,
      source_timestamp: m.timestamp || m.created_at || m.received_at,
    });
    facts = s.facts_after;
    states.push(s);
  }
  return { facts_after: facts, states };
}

export function replayConversationFull(messages = []) {
  return replayConversationIncremental(messages);
}

export function activeFactSignature(facts = []) {
  const active = resolveActiveFacts(facts);
  const keys = Object.keys(active).sort();
  return JSON.stringify(
    keys.map((k) => ({
      t: k,
      v: active[k]?.normalized_value ?? active[k]?.value,
      s: active[k]?.claimed_or_verified,
    }))
  );
}

export function compareIncrementalVsFull(messages = []) {
  const inc = replayConversationIncremental(messages);
  // Full rebuild from empty is the same algorithm when messages in order
  const full = replayConversationIncremental(messages);
  const a = activeFactSignature(inc.facts_after);
  const b = activeFactSignature(full.facts_after);
  return {
    equivalent: a === b,
    incremental_signature: a,
    full_signature: b,
    final_nba: inc.states[inc.states.length - 1]?.proposed_next_best_action || null,
  };
}

/**
 * Map active facts → lifecycle missing list + next missing fact.
 */
export function mapFactsToLifecycleGaps(active = {}) {
  const has = (t) => {
    const f = active[t];
    return f && (f.value === true || f.normalized_value === true || f.normalized_value != null);
  };
  const answered = [];
  const missing = [];
  if (has(FACT_TYPES.OWNERSHIP_CONFIRMED)) answered.push("ownership_confirmed");
  else missing.push("ownership_confirmed");
  if (
    has(FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED) ||
    has(FACT_TYPES.SELLER_REQUESTS_PROPOSAL)
  ) {
    answered.push("proposal_interest");
  } else if (has(FACT_TYPES.OWNERSHIP_CONFIRMED)) {
    missing.push("proposal_interest");
  }
  if (has(FACT_TYPES.ASKING_PRICE) || has(FACT_TYPES.ASKING_PRICE_RANGE)) {
    answered.push("asking_price");
  } else if (answered.includes("proposal_interest")) {
    missing.push("asking_price");
  }
  if (has(FACT_TYPES.CONDITION_SUMMARY) || has(FACT_TYPES.REPAIR_ITEM)) {
    answered.push("condition");
  } else if (answered.includes("asking_price")) {
    missing.push("condition");
  }

  let next_missing_fact = missing[0] || null;
  let proposed_nba = "request_ownership";
  let proposed_stage = S.OWNERSHIP_CHECK;
  if (has(FACT_TYPES.OPT_OUT)) {
    proposed_nba = "opt_out";
    proposed_stage = "terminal";
    next_missing_fact = null;
  } else if (has(FACT_TYPES.WRONG_NUMBER) || has(FACT_TYPES.SOLD_PROPERTY) || has(FACT_TYPES.NEVER_OWNED)) {
    proposed_nba = "suppress";
    proposed_stage = "terminal";
    next_missing_fact = null;
  } else if (next_missing_fact === "ownership_confirmed") {
    proposed_nba = "request_ownership";
    proposed_stage = S.OWNERSHIP_CHECK;
  } else if (next_missing_fact === "proposal_interest") {
    proposed_nba = "confirm_interest";
    proposed_stage = S.INTEREST_PROPOSAL_CONFIRMATION;
  } else if (next_missing_fact === "asking_price") {
    proposed_nba = "request_asking_price";
    proposed_stage = S.ASKING_PRICE;
  } else if (next_missing_fact === "condition") {
    proposed_nba = "request_condition";
    proposed_stage = S.PROPERTY_CONDITION;
  } else if (answered.includes("condition")) {
    proposed_nba = "prepare_proposal_review";
    proposed_stage = S.PROPERTY_CONDITION;
  } else if (answered.includes("asking_price")) {
    proposed_nba = "request_condition";
    proposed_stage = S.PROPERTY_CONDITION;
  }

  // Seller transaction claims never open S7–10
  if (
    has(FACT_TYPES.UNDER_CONTRACT_CLAIM) ||
    has(FACT_TYPES.CLOSING_CLAIM) ||
    has(FACT_TYPES.ESCROW_OPEN_CLAIM)
  ) {
    // keep stage; force authoritative note
    if (proposed_stage === S.OWNERSHIP_CHECK || proposed_stage === "terminal") {
      /* leave */
    }
  }

  return {
    questions_already_answered: answered,
    missing_stage_facts: missing,
    next_missing_fact,
    proposed_stage_after: proposed_stage,
    proposed_next_best_action: proposed_nba,
  };
}

/**
 * Pure merge of prior facts + current extraction.
 */
export function buildShadowFactState({
  facts_before = [],
  classification = null,
  message = "",
  message_event_id = null,
  source_timestamp = null,
  classifier_version = null,
  stage_before = null,
} = {}) {
  const t0 = Date.now();
  const before = Array.isArray(facts_before) ? facts_before.map((f) => toJsonSafe(f)) : [];
  const extracted_contract = buildClassifierResultContract({
    message,
    classification,
    source_message_id: message_event_id,
    source_timestamp,
    classifier_version: classifier_version || FACT_CONTRACT_VERSION,
  });
  const extracted = extracted_contract.facts || [];

  let after = before;
  const added = [];
  const confirmed = [];
  const superseded = [];
  const conflicted = [];

  for (const f of extracted) {
    const prev_ids = new Set(after.filter((x) => x.active !== false).map((x) => x.fact_id));
    after = mergeFactIntoState(after, f);
    const active_after = after.filter((x) => x.active !== false);
    const inactive = after.filter((x) => x.active === false);
    if (active_after.some((x) => x.fact_id === f.fact_id || x.supersedes_fact_id)) {
      if (!prev_ids.has(f.fact_id) && active_after.find((x) => x.source_message_id === f.source_message_id && x.fact_type === f.fact_type)) {
        added.push(f.fact_type);
      }
    }
    for (const inv of inactive) {
      if (inv.supersedes_fact_id || (inv.conflicts_with_fact_ids || []).length) {
        if (inv.fact_type === f.fact_type) superseded.push(inv.fact_id);
      }
      if (inv.claimed_or_verified === "conflicted") conflicted.push(inv.fact_id);
    }
    // confirmations
    const same = after.find(
      (x) =>
        x.active !== false &&
        x.fact_type === f.fact_type &&
        x.source_message_id === f.source_message_id
    );
    if (same) confirmed.push(f.fact_type);
  }

  after = sortFactsDeterministically(after);
  const active = resolveActiveFacts(after);
  // Terminal opt-out / wrong-number dominate NBA even if later messages extract interest
  const gaps = mapFactsToLifecycleGaps(active);
  const material_conflicts = after.filter(
    (f) => (f.conflicts_with_fact_ids || []).length > 0
  );
  const provenance = measureFactProvenanceCoverage(after);

  const duration_ms = Math.max(0, Date.now() - t0);

  // Shadow decision using active facts as bag
  const fact_bag = {
    ownership_confirmed: active[FACT_TYPES.OWNERSHIP_CONFIRMED]?.value === true,
    proposal_interest_confirmed:
      active[FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED]?.value === true,
    seller_requests_proposal:
      active[FACT_TYPES.SELLER_REQUESTS_PROPOSAL]?.value === true,
    opt_out: active[FACT_TYPES.OPT_OUT]?.value === true,
    wrong_number: active[FACT_TYPES.WRONG_NUMBER]?.value === true,
    asking_price: active[FACT_TYPES.ASKING_PRICE]?.normalized_value,
    condition_summary: active[FACT_TYPES.CONDITION_SUMMARY]?.normalized_value,
    seller_claims_under_contract:
      active[FACT_TYPES.UNDER_CONTRACT_CLAIM]?.value === true,
    seller_claims_closed: active[FACT_TYPES.CLOSING_CLAIM]?.value === true,
    spouse_co_owner: active[FACT_TYPES.SPOUSE_REQUIRED]?.value === true,
    probate: active[FACT_TYPES.PROBATE_DETECTED]?.value === true,
    confidence: classification?.confidence ?? 0.9,
  };

  return {
    ok: true,
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    fact_contract_version: FACT_CONTRACT_VERSION,
    classifier_version: classifier_version || extracted_contract.classifier_version,
    lifecycle_registry_version: ACQUISITION_BRAIN_VERSION,
    facts_before: before,
    facts_extracted: extracted,
    facts_added: [...new Set(added)],
    facts_confirmed: [...new Set(confirmed)],
    facts_superseded: [...new Set(superseded)],
    facts_conflicted: [...new Set(conflicted)],
    facts_after: after,
    material_conflicts,
    missing_stage_facts: gaps.missing_stage_facts,
    stage_before: stage_before || null,
    proposed_stage_after: gaps.proposed_stage_after,
    proposed_next_best_action: gaps.proposed_next_best_action,
    questions_already_answered: gaps.questions_already_answered,
    next_missing_fact: gaps.next_missing_fact,
    human_review_required: Boolean(extracted_contract.human_review_required),
    active_facts: active,
    fact_bag,
    processing_duration_ms: duration_ms,
    extracted_contract,
    provenance_coverage: provenance,
    history_incomplete: false,
  };
}

/**
 * Full shadow evaluation with fact-state + decision.
 */
export function evaluateShadowWithFactState(input = {}) {
  const state = buildShadowFactState(input);
  const decision = evaluateAcquisitionBrainShadow({
    classification: input.classification,
    message: input.message,
    current_stage: input.stage_before || state.proposed_stage_after,
    thread_key: input.thread_key,
    inbound_event_id: input.message_event_id,
    message_event_id: input.message_event_id,
    classification_version: input.classifier_version,
    legacy_decision: input.legacy_decision,
    fact_extraction: null,
  });

  // Prefer fact-state NBA when it skips redundant questions
  const merged_nba = state.proposed_next_best_action;
  const questions_answered = state.questions_already_answered;

  const mid = clean(input.message_event_id);
  const fact_event =
    mid
      ? {
          event_type: SHADOW_FACT_STATE_EVENT,
          dedupe_key: `acquisition_brain_shadow_fact_state:${mid}:${FACT_CONTRACT_VERSION}`,
          conversation_thread_id: input.thread_key || null,
          payload: toJsonSafe({
            message_event_id: mid,
            thread_key: input.thread_key,
            facts_before: state.facts_before,
            facts_extracted: state.facts_extracted,
            facts_added: state.facts_added,
            facts_confirmed: state.facts_confirmed,
            facts_superseded: state.facts_superseded,
            facts_conflicted: state.facts_conflicted,
            facts_after: state.facts_after,
            material_conflicts: state.material_conflicts,
            missing_stage_facts: state.missing_stage_facts,
            stage_before: state.stage_before,
            proposed_stage_after: state.proposed_stage_after,
            proposed_next_best_action: merged_nba,
            questions_already_answered: questions_answered,
            next_missing_fact: state.next_missing_fact,
            human_review_required: state.human_review_required,
            fact_contract_version: FACT_CONTRACT_VERSION,
            classifier_version: state.classifier_version,
            lifecycle_registry_version: ACQUISITION_BRAIN_VERSION,
            processing_duration_ms: state.processing_duration_ms,
          }),
        }
      : null;

  return {
    ok: true,
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    fact_state: state,
    decision,
    fact_event,
    decision_event: decision.event,
    continuity: {
      questions_already_answered: questions_answered,
      next_missing_fact: state.next_missing_fact,
      forbidden_redundant: {
        ownership:
          questions_answered.includes("ownership_confirmed") &&
          merged_nba === "request_ownership",
        interest:
          questions_answered.includes("proposal_interest") &&
          merged_nba === "confirm_interest",
        asking_price:
          questions_answered.includes("asking_price") &&
          merged_nba === "request_asking_price",
      },
    },
  };
}

export async function emitShadowFactStateEvents(result, deps = {}) {
  const emit = deps.emitAutomationEvent;
  if (typeof emit !== "function") {
    return { ok: false, reason: "emit_unavailable" };
  }
  const out = { fact_state: null, decision: null };
  try {
    if (result.fact_event) {
      out.fact_state = await emit(
        {
          event_type: result.fact_event.event_type,
          dedupe_key: result.fact_event.dedupe_key,
          source: "acquisition_brain_shadow",
          conversation_thread_id: result.fact_event.conversation_thread_id,
          payload: result.fact_event.payload,
        },
        deps.supabase ? { supabase: deps.supabase, supabaseClient: deps.supabase } : {}
      );
    }
    if (result.decision_event) {
      out.decision = await emit(
        {
          event_type: result.decision_event.event_type,
          dedupe_key: result.decision_event.dedupe_key,
          source: "acquisition_brain_shadow",
          conversation_thread_id: result.decision_event.conversation_thread_id,
          payload: result.decision_event.payload,
        },
        deps.supabase ? { supabase: deps.supabase, supabaseClient: deps.supabase } : {}
      );
    }
    return { ok: true, ...out };
  } catch (error) {
    return { ok: false, reason: error?.message || "emit_failed", ...out };
  }
}

export default {
  SHADOW_FACT_STATE_EVENT,
  SHADOW_FACT_MAX_HISTORY,
  TERMINAL_MEMORY_FACT_TYPES,
  loadPriorShadowFacts,
  mapFactsToLifecycleGaps,
  buildShadowFactState,
  evaluateShadowWithFactState,
  emitShadowFactStateEvents,
  replayConversationIncremental,
  replayConversationFull,
  compareIncrementalVsFull,
  activeFactSignature,
};
