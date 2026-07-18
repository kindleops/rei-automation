// ─── acquisition-brain/shadow-seller-intelligence.js ───────────────────────
// Explainable Seller Intelligence profile + opportunity score (shadow only).
// Does not infer protected traits or authorize transport.

import { createHash } from "node:crypto";
import { toJsonSafe } from "./fact-provenance-contract.js";
import { ACQUISITION_BRAIN_VERSION } from "./lifecycle-registry.js";

export const SHADOW_SELLER_INTEL_EVENT =
  "acquisition_brain_shadow_seller_intelligence";
export const SELLER_INTEL_VERSION = "acquisition_brain_seller_intel_v1";

/** Explicit safety exclusions — never inferred or stored as profile signals. */
export const SELLER_INTEL_EXCLUSIONS = Object.freeze([
  "race_or_ethnicity",
  "religion",
  "medical_condition",
  "mental_health_diagnosis",
  "intelligence",
  "disability",
  "financial_desperation",
  "family_vulnerability",
  "political_views",
  "sexual_orientation",
  "other_protected_traits",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function isCanonicalE164(thread) {
  const t = clean(thread);
  return t.startsWith("+") && t.length >= 11;
}

function signal(value, confidence, evidence = [], explanation = "", extra = {}) {
  const now = new Date().toISOString();
  return {
    value,
    confidence: Number(confidence) || 0,
    evidence_event_ids: evidence,
    calculation_window: extra.calculation_window || "conversation",
    first_observed: extra.first_observed || now,
    last_updated: now,
    version: SELLER_INTEL_VERSION,
    explanation,
  };
}

/**
 * Build deterministic explainable signals from facts + message metrics.
 * Pure; no I/O; no protected-trait inference.
 */
export function buildSellerIntelligenceProfile({
  thread_key = null,
  facts_after = [],
  messages = [],
  fact_state_ref = null,
  decision_ref = null,
  burst_ref = null,
  followup_ref = null,
} = {}) {
  const t0 = Date.now();
  const thread = clean(thread_key);
  if (!isCanonicalE164(thread)) {
    return {
      ok: false,
      reason: "non_e164_or_archived_alias",
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const active = (facts_after || []).filter((f) => f.active !== false);
  const has = (type) =>
    active.some(
      (f) =>
        f.fact_type === type ||
        String(f.fact_type).includes(type) ||
        f.normalized_value === true
    );
  const factIds = (type) =>
    active
      .filter((f) => String(f.fact_type).includes(type))
      .map((f) => f.source_message_id)
      .filter(Boolean);

  const bodies = (messages || []).map((m) =>
    clean(m.message || m.message_body)
  );
  const lengths = bodies.map((b) => b.length);
  const avg_len = lengths.length
    ? lengths.reduce((a, b) => a + b, 0) / lengths.length
    : 0;
  const multi_burst = (messages || []).length >= 3;

  const ownership = has("ownership_confirmed");
  const interest =
    has("proposal_interest") || has("seller_requests_proposal") || has("asks_offer");
  const price = has("asking_price");
  const condition = has("condition") || has("repair") || has("roof");
  const timeline = has("timeline") || has("desired_timeline");
  const opt_out = has("opt_out");
  const wrong = has("wrong_number");
  const not_interested = has("not_interested") || has("disinterest");
  const authority_complex =
    has("spouse") || has("probate") || has("llc") || has("trust") || has("co_owner");
  const under_contract_claim = has("under_contract");

  // Engagement (behavioral, not psychological diagnosis)
  const engagement = {
    response_frequency: signal(
      messages.length,
      messages.length ? 0.8 : 0.3,
      messages.map((m) => m.id).filter(Boolean),
      "Count of inbound messages in window"
    ),
    response_length_distribution: signal(
      avg_len < 40 ? "concise" : avg_len > 120 ? "detailed" : "moderate",
      0.7,
      [],
      `Mean inbound length ${Math.round(avg_len)} chars`
    ),
    conversation_depth: signal(
      messages.length >= 5 ? "deep" : messages.length >= 2 ? "moderate" : "shallow",
      0.75,
      [],
      "Based on inbound message count"
    ),
    multi_message_burst_tendency: signal(
      multi_burst,
      0.7,
      [],
      multi_burst ? "3+ inbounds observed" : "No multi-message burst pattern"
    ),
    engagement_trajectory: signal(
      messages.length >= 3 ? "increasing_or_steady" : "early",
      0.5,
      [],
      "Trajectory from message volume only; not a mood diagnosis"
    ),
  };

  const communication = {
    concise_versus_detailed: signal(
      avg_len < 40 ? "concise" : "detailed_or_moderate",
      0.65,
      [],
      "Length proxy only"
    ),
    preferred_language: signal(
      messages.find((m) => m.language)?.language || "unknown",
      messages.some((m) => m.language) ? 0.8 : 0.2,
      [],
      "From message language tags when present"
    ),
    multi_message_burst_tendency: engagement.multi_message_burst_tendency,
  };

  const acquisition_intent = {
    verified_ownership: signal(ownership, ownership ? 0.9 : 0.4, factIds("ownership")),
    proposal_interest: signal(interest, interest ? 0.85 : 0.4, factIds("proposal")),
    asking_price_readiness: signal(price, price ? 0.9 : 0.35, factIds("asking_price")),
    condition_disclosure: signal(condition, condition ? 0.85 : 0.35, factIds("condition")),
    timeline_disclosure: signal(timeline, timeline ? 0.8 : 0.3, factIds("timeline")),
    contract_intent: signal(
      under_contract_claim,
      under_contract_claim ? 0.6 : 0.2,
      factIds("under_contract"),
      "Seller claim only; not stage advance"
    ),
  };

  const authority = {
    co_owner_or_complex: signal(
      authority_complex,
      authority_complex ? 0.85 : 0.4,
      factIds("spouse").concat(factIds("probate")),
      "Complex authority reduces execute-alone readiness"
    ),
    can_execute_alone: signal(
      !authority_complex && ownership,
      ownership && !authority_complex ? 0.6 : 0.3,
      [],
      "Unverified unless authority facts clear"
    ),
  };

  const tone = {
    // Only surface-level labels from intents — not psychological diagnosis
    conversation_tone: signal(
      opt_out || wrong
        ? "terminal"
        : not_interested
          ? "disinterested"
          : interest
            ? "positive"
            : "neutral",
      0.7,
      [],
      "Derived from compliance and acquisition intents only"
    ),
  };

  // Opportunity score components (deterministic)
  const components = [];
  const add = (name, weight, active_flag, note) => {
    const contribution = active_flag ? weight : 0;
    components.push({ name, weight, contribution, active: Boolean(active_flag), note });
  };
  add("ownership_certainty", 20, ownership, "Ownership confirmed fact");
  add("proposal_interest", 18, interest, "Proposal interest or request");
  add("asking_price_availability", 15, price, "Asking price present");
  add("condition_completeness", 10, condition, "Condition/repair facts");
  add("timeline_clarity", 8, timeline, "Timeline disclosed");
  add("engagement_volume", 5, messages.length >= 2, "Multi-message engagement");
  add("authority_readiness", -12, authority_complex, "Complex authority penalty");
  add("objection_or_disinterest", -25, not_interested, "Not interested");
  add("terminal_opt_out", -100, opt_out, "Opt-out terminal");
  add("terminal_wrong_number", -100, wrong, "Wrong number terminal");

  let raw = components.reduce((s, c) => s + c.contribution, 0);
  if (opt_out || wrong) raw = 0;
  if (not_interested && !opt_out && !wrong) raw = Math.min(raw, 15);
  // Hard rules: fast/long reply alone cannot make hot — engagement max +5
  const normalized = Math.max(0, Math.min(100, raw));
  let temperature = "cold";
  if (opt_out || wrong) temperature = "terminal";
  else if (normalized >= 70) temperature = "hot";
  else if (normalized >= 40) temperature = "warm";
  else if (normalized >= 20) temperature = "cool";

  const positive = components.filter((c) => c.contribution > 0).map((c) => c.name);
  const negative = components.filter((c) => c.contribution < 0).map((c) => c.name);
  const missing = [];
  if (!ownership) missing.push("ownership_confirmed");
  if (!interest) missing.push("proposal_interest");
  if (!price) missing.push("asking_price");
  if (!condition) missing.push("condition");

  const opportunity_score = {
    raw_score: raw,
    normalized_score: normalized,
    temperature,
    component_contributions: components,
    positive_signals: positive,
    negative_signals: negative,
    missing_facts: missing,
    confidence: ownership || interest ? 0.75 : 0.45,
    version: SELLER_INTEL_VERSION,
    hard_rules: {
      opt_out_terminal: opt_out,
      wrong_number_terminal: wrong,
      not_interested_not_overridden_by_engagement: not_interested,
      engagement_alone_cannot_make_hot: true,
      score_cannot_advance_stages: true,
      score_cannot_authorize_send: true,
    },
  };

  const profile = {
    thread_key: thread,
    fact_state_ref,
    decision_ref,
    burst_ref,
    followup_ref,
    signals: {
      engagement,
      communication,
      acquisition_intent,
      authority,
      tone,
    },
    opportunity_score,
    safety_exclusions: SELLER_INTEL_EXCLUSIONS,
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    profile_version: SELLER_INTEL_VERSION,
    lifecycle_registry_version: ACQUISITION_BRAIN_VERSION,
    processing_duration_ms: Math.max(0, Date.now() - t0),
  };

  const profile_hash = createHash("sha256")
    .update(JSON.stringify({ thread, normalized, ownership, interest, price }), "utf8")
    .digest("hex")
    .slice(0, 24);

  return {
    ok: true,
    profile: toJsonSafe(profile),
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    event: {
      event_type: SHADOW_SELLER_INTEL_EVENT,
      dedupe_key: `acquisition_brain_shadow_seller_intelligence:${thread}:${profile_hash}:${SELLER_INTEL_VERSION}`,
      conversation_thread_id: thread,
      payload: toJsonSafe(profile),
    },
  };
}

export default {
  SHADOW_SELLER_INTEL_EVENT,
  SELLER_INTEL_VERSION,
  SELLER_INTEL_EXCLUSIONS,
  buildSellerIntelligenceProfile,
};
