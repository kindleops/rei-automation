// ─── acquisition-brain/shadow-seller-intelligence.js ───────────────────────
// Deterministic, evidence-backed Seller Intelligence + opportunity score.
// Shadow only — never authorizes transport or stage mutations.

import { createHash } from "node:crypto";
import {
  FACT_TYPES,
  toJsonSafe,
  factPrecedenceScore,
} from "./fact-provenance-contract.js";
import { ACQUISITION_BRAIN_VERSION } from "./lifecycle-registry.js";

export const SHADOW_SELLER_INTEL_EVENT =
  "acquisition_brain_shadow_seller_intelligence";
export const SELLER_INTEL_PROFILE_VERSION =
  "acquisition_brain_seller_intel_profile_v2";
export const SELLER_INTEL_SCORING_VERSION =
  "acquisition_brain_seller_intel_score_v2";
/** @deprecated use PROFILE + SCORING versions */
export const SELLER_INTEL_VERSION = SELLER_INTEL_PROFILE_VERSION;

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
  "personality_disorder",
  "emotional_instability",
  "deception",
  "vulnerability",
]);

/** Explicit aliases → canonical FACT_TYPES values only */
export const FACT_TYPE_ALIASES = Object.freeze({
  proposal_interest: FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED,
  condition: FACT_TYPES.CONDITION_SUMMARY,
  repair: FACT_TYPES.REPAIR_ITEM,
  timeline: FACT_TYPES.DESIRED_TIMELINE,
  motivation: FACT_TYPES.REASON_FOR_CONSIDERING,
  objection: FACT_TYPES.NOT_INTERESTED,
  listing_agent: FACT_TYPES.LISTED_WITH_AGENT,
  co_owner: FACT_TYPES.CO_OWNER_REQUIRED,
  transaction_claim: FACT_TYPES.UNDER_CONTRACT_CLAIM,
});

export const TRI_STATE = Object.freeze({
  VERIFIED_TRUE: "verified_true",
  VERIFIED_FALSE: "verified_false",
  UNKNOWN: "unknown",
  CLAIMED_TRUE: "claimed_true",
  CLAIMED_FALSE: "claimed_false",
});

function clean(value) {
  return String(value ?? "").trim();
}

function isCanonicalE164(thread) {
  const t = clean(thread);
  return t.startsWith("+") && t.length >= 11;
}

export function resolveCanonicalFactType(type) {
  const raw = clean(type);
  if (!raw) return null;
  if (Object.values(FACT_TYPES).includes(raw)) return raw;
  if (FACT_TYPE_ALIASES[raw]) return FACT_TYPE_ALIASES[raw];
  // Exact key match on FACT_TYPES enum keys
  if (FACT_TYPES[raw]) return FACT_TYPES[raw];
  const upper = raw.toUpperCase();
  if (FACT_TYPES[upper]) return FACT_TYPES[upper];
  return null;
}

export function getActiveFactsByType(facts = [], type) {
  const canonical = resolveCanonicalFactType(type);
  if (!canonical) return [];
  return (facts || []).filter(
    (f) => f && f.active !== false && f.fact_type === canonical
  );
}

export function getBestActiveFact(facts = [], type) {
  const list = getActiveFactsByType(facts, type);
  if (!list.length) return null;
  return [...list].sort(
    (a, b) => factPrecedenceScore(b) - factPrecedenceScore(a)
  )[0];
}

export function hasFactType(facts = [], type) {
  return getActiveFactsByType(facts, type).length > 0;
}

export function getFactEvidenceIds(facts = [], type) {
  return getActiveFactsByType(facts, type)
    .map((f) => f.source_message_id || f.fact_id || f.authoritative_event_id)
    .filter(Boolean);
}

export function getNormalizedFactValue(facts = [], type) {
  const f = getBestActiveFact(facts, type);
  if (!f) return null;
  return f.normalized_value !== undefined ? f.normalized_value : f.value;
}

function factTimestamp(f) {
  return f?.source_timestamp || f?.observed_at || f?.created_at || null;
}

function messageTimestamp(m) {
  return m?.timestamp || m?.received_at || m?.created_at || m?.event_timestamp || null;
}

function msgId(m) {
  return clean(m?.id || m?.message_event_id);
}

function earliestIso(list, as_of) {
  const times = list.map((t) => Date.parse(t)).filter(Number.isFinite);
  if (!times.length) return as_of;
  return new Date(Math.min(...times)).toISOString();
}

function latestIso(list, as_of) {
  const times = list.map((t) => Date.parse(t)).filter(Number.isFinite);
  if (!times.length) return as_of;
  return new Date(Math.max(...times)).toISOString();
}

function makeSignal({
  value,
  confidence,
  evidence = [],
  explanation = "",
  unit = null,
  sample_size = null,
  calculation_window = "conversation",
  first_observed,
  last_updated,
  as_of,
  extra = {},
}) {
  return {
    value,
    unit,
    confidence: Number(confidence) || 0,
    evidence_event_ids: [...evidence].filter(Boolean).sort(),
    sample_size,
    calculation_window,
    first_observed: first_observed || as_of,
    last_updated: last_updated || as_of,
    version: SELLER_INTEL_PROFILE_VERSION,
    explanation,
    ...extra,
  };
}

/**
 * Authority tri-state — never assume solo authority from absence of complexity.
 */
export function buildAuthorityProfile(facts = [], as_of) {
  const spouse = hasFactType(facts, FACT_TYPES.SPOUSE_REQUIRED);
  const co = hasFactType(facts, FACT_TYPES.CO_OWNER_REQUIRED);
  const llc = hasFactType(facts, FACT_TYPES.LLC_AUTHORITY_REQUIRED);
  const trust = hasFactType(facts, FACT_TYPES.TRUST_AUTHORITY_REQUIRED);
  const executor = hasFactType(facts, FACT_TYPES.EXECUTOR_AUTHORITY_REQUIRED);
  const probate = hasFactType(facts, FACT_TYPES.PROBATE_DETECTED);
  const heir = hasFactType(facts, FACT_TYPES.HEIRSHIP_DETECTED);
  const poa = hasFactType(facts, FACT_TYPES.POWER_OF_ATTORNEY_CLAIM);
  const ownership = hasFactType(facts, FACT_TYPES.OWNERSHIP_CONFIRMED);
  const canAloneFact = getBestActiveFact(facts, FACT_TYPES.CAN_EXECUTE_ALONE);
  const relation = getNormalizedFactValue(facts, FACT_TYPES.OWNERSHIP_RELATION);
  const authorityType = getNormalizedFactValue(facts, FACT_TYPES.AUTHORITY_TYPE);

  let can_execute_alone = TRI_STATE.UNKNOWN;
  let authority_claim_status = "unknown";
  let authority_confidence = 0.2;
  const missing_verification = [];

  if (spouse || co || llc || trust || executor || probate || heir) {
    can_execute_alone = TRI_STATE.VERIFIED_FALSE;
    authority_claim_status = "complex_required";
    authority_confidence = 0.85;
    if (llc) missing_verification.push("llc_signer_verification");
    if (trust) missing_verification.push("trust_authority_verification");
    if (probate || heir || executor) missing_verification.push("estate_executor_verification");
    if (spouse || co) missing_verification.push("co_owner_signer");
  } else if (canAloneFact) {
    const v = canAloneFact.normalized_value ?? canAloneFact.value;
    const auth =
      canAloneFact.claimed_or_verified === "authoritative" ||
      canAloneFact.claimed_or_verified === "verified";
    if (v === true || v === "true") {
      can_execute_alone = auth ? TRI_STATE.VERIFIED_TRUE : TRI_STATE.CLAIMED_TRUE;
      authority_claim_status = auth ? "verified" : "claimed";
      authority_confidence = auth ? 0.9 : 0.55;
    } else if (v === false || v === "false") {
      can_execute_alone = auth ? TRI_STATE.VERIFIED_FALSE : TRI_STATE.CLAIMED_FALSE;
      authority_claim_status = auth ? "verified" : "claimed";
      authority_confidence = auth ? 0.9 : 0.55;
    }
  } else if (ownership) {
    // Ownership alone does NOT prove solo authority
    can_execute_alone = TRI_STATE.UNKNOWN;
    authority_claim_status = "claimed_owner_unverified_solo";
    authority_confidence = 0.35;
    missing_verification.push("solo_authority_verification");
  }

  const evidence = [
    ...getFactEvidenceIds(facts, FACT_TYPES.SPOUSE_REQUIRED),
    ...getFactEvidenceIds(facts, FACT_TYPES.CO_OWNER_REQUIRED),
    ...getFactEvidenceIds(facts, FACT_TYPES.LLC_AUTHORITY_REQUIRED),
    ...getFactEvidenceIds(facts, FACT_TYPES.PROBATE_DETECTED),
    ...getFactEvidenceIds(facts, FACT_TYPES.CAN_EXECUTE_ALONE),
    ...getFactEvidenceIds(facts, FACT_TYPES.OWNERSHIP_CONFIRMED),
  ];

  return {
    authority_type: authorityType || null,
    authority_claim_status,
    ownership_relation: relation || null,
    co_owner_required: co,
    spouse_required: spouse,
    llc_authority_required: llc,
    trust_authority_required: trust,
    executor_authority_required: executor,
    probate_or_heirship: probate || heir,
    power_of_attorney_claim: poa,
    signer_count_claim: getNormalizedFactValue(facts, FACT_TYPES.SIGNER_COUNT_CLAIM),
    can_execute_alone,
    authority_confidence,
    evidence_event_ids: [...new Set(evidence)].sort(),
    missing_verification,
    human_review_required:
      can_execute_alone === TRI_STATE.UNKNOWN ||
      missing_verification.length > 0 ||
      probate ||
      llc ||
      trust,
    first_observed: earliestIso(
      getActiveFactsByType(facts, FACT_TYPES.OWNERSHIP_CONFIRMED)
        .concat(getActiveFactsByType(facts, FACT_TYPES.SPOUSE_REQUIRED))
        .map(factTimestamp),
      as_of
    ),
    last_updated: latestIso(
      (facts || []).filter((f) => f.active !== false).map(factTimestamp),
      as_of
    ),
  };
}

function computeLatencies(messages = []) {
  const ordered = [...(messages || [])].sort((a, b) => {
    const ta = Date.parse(messageTimestamp(a) || 0) || 0;
    const tb = Date.parse(messageTimestamp(b) || 0) || 0;
    if (ta !== tb) return ta - tb;
    return msgId(a).localeCompare(msgId(b));
  });
  const inbound = ordered.filter(
    (m) => !m.direction || m.direction === "inbound"
  );
  const gaps = [];
  for (let i = 1; i < inbound.length; i += 1) {
    const a = Date.parse(messageTimestamp(inbound[i - 1]) || 0);
    const b = Date.parse(messageTimestamp(inbound[i]) || 0);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) gaps.push(b - a);
  }
  const sorted = [...gaps].sort((x, y) => x - y);
  const median = sorted.length
    ? sorted[Math.floor(sorted.length / 2)]
    : null;
  return {
    sample_size: gaps.length,
    first_response_latency_ms: gaps[0] ?? null,
    median_response_latency_ms: median,
    latest_response_latency_ms: gaps.length ? gaps[gaps.length - 1] : null,
    gaps,
    inbound_count: inbound.length,
    conversation_duration_ms:
      inbound.length >= 2
        ? Date.parse(messageTimestamp(inbound[inbound.length - 1])) -
          Date.parse(messageTimestamp(inbound[0]))
        : null,
  };
}

function engagementTrajectory(gaps) {
  if (!gaps || gaps.length < 2) {
    return { value: "insufficient_data", confidence: 0.2 };
  }
  const first = gaps[0];
  const last = gaps[gaps.length - 1];
  if (last < first * 0.7) return { value: "increasing", confidence: 0.6 };
  if (last > first * 1.3) return { value: "decreasing", confidence: 0.6 };
  return { value: "steady", confidence: 0.55 };
}

/**
 * Versioned scoring registry with separate component domains.
 */
export function computeOpportunityScore({
  facts = [],
  messages = [],
  authority = null,
  engagement = null,
  as_of,
} = {}) {
  const opt_out = hasFactType(facts, FACT_TYPES.OPT_OUT);
  const wrong = hasFactType(facts, FACT_TYPES.WRONG_NUMBER);
  const never = hasFactType(facts, FACT_TYPES.NEVER_OWNED);
  const sold = hasFactType(facts, FACT_TYPES.SOLD_PROPERTY);
  const not_int = hasFactType(facts, FACT_TYPES.NOT_INTERESTED);
  const ownership = hasFactType(facts, FACT_TYPES.OWNERSHIP_CONFIRMED);
  const interest =
    hasFactType(facts, FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED) ||
    hasFactType(facts, FACT_TYPES.SELLER_REQUESTS_PROPOSAL);
  const price =
    hasFactType(facts, FACT_TYPES.ASKING_PRICE) ||
    hasFactType(facts, FACT_TYPES.ASKING_PRICE_RANGE);
  const condition =
    hasFactType(facts, FACT_TYPES.CONDITION_SUMMARY) ||
    hasFactType(facts, FACT_TYPES.REPAIR_ITEM) ||
    hasFactType(facts, FACT_TYPES.ROOF_CONDITION);
  const timeline = hasFactType(facts, FACT_TYPES.DESIRED_TIMELINE);
  const under = hasFactType(facts, FACT_TYPES.UNDER_CONTRACT_CLAIM);
  const contract_intent =
    hasFactType(facts, FACT_TYPES.CONTRACT_REQUESTED) ||
    hasFactType(facts, FACT_TYPES.CONTRACT_SIGNED_CLAIM);

  const components = [];
  const push = (domain, name, raw, weight, conf, evidence, note, gates = []) => {
    const normalized = Math.max(0, Math.min(100, raw));
    components.push({
      domain,
      name,
      raw_score: raw,
      normalized_score: normalized,
      confidence: conf,
      weight,
      weighted_contribution: (normalized / 100) * weight,
      evidence_event_ids: evidence,
      note,
      gates,
    });
  };

  // A viability gates
  if (opt_out) {
    return terminalScore("terminal", "opt_out", getFactEvidenceIds(facts, FACT_TYPES.OPT_OUT));
  }
  if (wrong) {
    return terminalScore("terminal", "wrong_number", getFactEvidenceIds(facts, FACT_TYPES.WRONG_NUMBER));
  }
  if (never || sold) {
    return terminalScore(
      "unavailable",
      never ? "never_owned" : "sold_property",
      getFactEvidenceIds(facts, never ? FACT_TYPES.NEVER_OWNED : FACT_TYPES.SOLD_PROPERTY)
    );
  }

  push(
    "acquisition_readiness",
    "ownership_certainty",
    ownership ? 90 : 10,
    20,
    ownership ? 0.9 : 0.4,
    getFactEvidenceIds(facts, FACT_TYPES.OWNERSHIP_CONFIRMED),
    "Ownership confirmed fact"
  );
  push(
    "acquisition_readiness",
    "proposal_interest",
    interest ? 85 : 10,
    18,
    interest ? 0.85 : 0.4,
    [
      ...getFactEvidenceIds(facts, FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED),
      ...getFactEvidenceIds(facts, FACT_TYPES.SELLER_REQUESTS_PROPOSAL),
    ],
    "Proposal interest / request"
  );
  push(
    "acquisition_readiness",
    "asking_price_availability",
    price ? 85 : 10,
    15,
    price ? 0.9 : 0.35,
    getFactEvidenceIds(facts, FACT_TYPES.ASKING_PRICE),
    "Price fact present"
  );
  push(
    "acquisition_readiness",
    "condition_completeness",
    condition ? 80 : 10,
    10,
    condition ? 0.85 : 0.35,
    getFactEvidenceIds(facts, FACT_TYPES.CONDITION_SUMMARY),
    "Condition/repair facts"
  );
  push(
    "acquisition_readiness",
    "timeline_clarity",
    timeline ? 75 : 10,
    8,
    timeline ? 0.8 : 0.3,
    getFactEvidenceIds(facts, FACT_TYPES.DESIRED_TIMELINE),
    "Timeline disclosed"
  );
  push(
    "acquisition_readiness",
    "contract_intent",
    contract_intent ? 70 : 0,
    5,
    contract_intent ? 0.7 : 0.2,
    getFactEvidenceIds(facts, FACT_TYPES.CONTRACT_REQUESTED),
    "Acquisition contract intent (not external under-contract claim)"
  );

  // External transaction claim reduces availability — does not add readiness
  push(
    "transaction_availability",
    "under_contract_claim_penalty",
    under ? 20 : 100,
    8,
    under ? 0.7 : 0.5,
    getFactEvidenceIds(facts, FACT_TYPES.UNDER_CONTRACT_CLAIM),
    "Seller under-contract claim reduces availability; does not advance stages"
  );

  const eng_count = Number(
    engagement?.inbound_count_raw ??
      engagement?.inbound_count?.value ??
      (messages || []).length ??
      0
  );
  // Engagement alone cannot exceed "developing" — cap weight contribution
  push(
    "seller_engagement",
    "engagement_volume",
    Math.min(40, (Number.isFinite(eng_count) ? eng_count : 0) * 8),
    5,
    eng_count >= 2 ? 0.7 : 0.3,
    (messages || []).map(msgId).filter(Boolean),
    "Volume only; cannot create high_priority alone"
  );

  const auth = authority || {};
  const complex =
    auth.can_execute_alone === TRI_STATE.VERIFIED_FALSE ||
    auth.can_execute_alone === TRI_STATE.CLAIMED_FALSE ||
    (auth.missing_verification || []).length > 0;
  push(
    "authority_readiness",
    "authority_status",
    auth.can_execute_alone === TRI_STATE.VERIFIED_TRUE
      ? 90
      : auth.can_execute_alone === TRI_STATE.UNKNOWN
        ? 40
        : complex
          ? 25
          : 50,
    12,
    auth.authority_confidence || 0.3,
    auth.evidence_event_ids || [],
    "Unverified authority cannot be contract ready"
  );

  push(
    "objection_burden",
    "not_interested",
    not_int ? 5 : 100,
    10,
    not_int ? 0.9 : 0.5,
    getFactEvidenceIds(facts, FACT_TYPES.NOT_INTERESTED),
    "Explicit not interested caps opportunity"
  );

  const missing = [];
  if (!ownership) missing.push("ownership_confirmed");
  if (!interest) missing.push("proposal_interest");
  if (!price) missing.push("asking_price");
  if (!condition) missing.push("condition");
  push(
    "data_completeness",
    "fact_completeness",
    Math.max(0, 100 - missing.length * 20),
    7,
    0.8,
    [],
    `Missing: ${missing.join(", ") || "none"}`
  );

  let weighted = components.reduce((s, c) => s + c.weighted_contribution, 0);
  const weight_sum = components.reduce((s, c) => s + c.weight, 0) || 1;
  let final_normalized = Math.round((weighted / weight_sum) * 100);

  // Hard caps
  if (not_int) final_normalized = Math.min(final_normalized, 15);
  // Engagement-only path: no ownership/interest → max developing (35)
  if (!ownership && !interest) {
    final_normalized = Math.min(final_normalized, 35);
  }
  // Unverified authority cannot be contract ready (cap 70 for qualified+)
  if (auth.can_execute_alone !== TRI_STATE.VERIFIED_TRUE && final_normalized > 75) {
    final_normalized = Math.min(final_normalized, 72);
  }

  let temperature = "cold";
  if (final_normalized >= 80 && ownership && interest && price) temperature = "high_priority";
  else if (final_normalized >= 65 && ownership && interest) temperature = "qualified";
  else if (final_normalized >= 45) temperature = "warm";
  else if (final_normalized >= 25) temperature = "developing";
  else if (under) temperature = "unavailable";
  else temperature = "cold";

  if (auth.human_review_required && temperature === "high_priority") {
    temperature = "human_review";
  }

  // Engagement alone cannot create high_priority / qualified
  if (!ownership || !interest) {
    if (temperature === "high_priority" || temperature === "qualified") {
      temperature = "developing";
      final_normalized = Math.min(final_normalized, 35);
    }
  }

  return {
    components,
    final_raw_score: weighted,
    final_normalized_score: final_normalized,
    temperature,
    overall_confidence: ownership || interest ? 0.75 : 0.4,
    positive_signals: components.filter((c) => c.weighted_contribution > c.weight * 0.4).map((c) => c.name),
    negative_signals: components.filter((c) => c.name.includes("penalty") || c.name === "not_interested").map((c) => c.name),
    missing_signals: missing,
    gating_rules: {
      opt_out_terminal: false,
      wrong_number_terminal: false,
      not_interested_cap: not_int,
      engagement_alone_max_developing: true,
      score_cannot_advance_stages: true,
      score_cannot_authorize_send: true,
      under_contract_claim_not_stage_advance: true,
      unverified_authority_not_contract_ready: true,
    },
    score_version: SELLER_INTEL_SCORING_VERSION,
    as_of,
  };
}

function terminalScore(temperature, reason, evidence) {
  return {
    components: [
      {
        domain: "opportunity_viability",
        name: reason,
        raw_score: 0,
        normalized_score: 0,
        confidence: 1,
        weight: 100,
        weighted_contribution: 0,
        evidence_event_ids: evidence,
        note: `Hard gate: ${reason}`,
        gates: [reason],
      },
    ],
    final_raw_score: 0,
    final_normalized_score: 0,
    temperature,
    overall_confidence: 1,
    positive_signals: [],
    negative_signals: [reason],
    missing_signals: [],
    gating_rules: {
      opt_out_terminal: reason === "opt_out",
      wrong_number_terminal: reason === "wrong_number",
      not_interested_cap: false,
      engagement_alone_max_developing: true,
      score_cannot_advance_stages: true,
      score_cannot_authorize_send: true,
    },
    score_version: SELLER_INTEL_SCORING_VERSION,
  };
}

export function computeProfileInputHash({
  thread_key,
  facts = [],
  messages = [],
  burst_ref = null,
  followup_ref = null,
  as_of,
} = {}) {
  const fact_part = (facts || [])
    .filter((f) => f && f.active !== false)
    .map((f) => ({
      id: f.fact_id || null,
      t: f.fact_type,
      v: f.normalized_value ?? f.value,
      s: f.source_message_id || null,
    }))
    .sort((a, b) =>
      `${a.t}:${a.id}`.localeCompare(`${b.t}:${b.id}`)
    );
  const msg_part = (messages || [])
    .map((m) => ({
      id: msgId(m),
      ts: messageTimestamp(m),
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const payload = JSON.stringify({
    thread: clean(thread_key),
    facts: fact_part,
    messages: msg_part,
    burst: burst_ref || null,
    followup: followup_ref || null,
    profile_version: SELLER_INTEL_PROFILE_VERSION,
    scoring_version: SELLER_INTEL_SCORING_VERSION,
    as_of,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Pure profile builder — no wall-clock side effects when as_of provided.
 */
export function buildSellerIntelligenceProfile({
  thread_key = null,
  facts_after = [],
  messages = [],
  fact_state_ref = null,
  decision_ref = null,
  burst_ref = null,
  followup_ref = null,
  current_stage = null,
  burst_events = [],
  as_of = "2026-07-18T00:00:00.000Z",
  processing_started_ms = null,
} = {}) {
  const t0 = processing_started_ms != null ? processing_started_ms : 0;
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

  const facts = Array.isArray(facts_after) ? facts_after : [];
  const msgs = Array.isArray(messages) ? messages : [];
  const lat = computeLatencies(msgs);
  const traj = engagementTrajectory(lat.gaps);

  const bodies = msgs.map((m) => clean(m.message || m.message_body));
  const lengths = bodies.map((b) => b.length);
  const avg_len = lengths.length
    ? lengths.reduce((a, b) => a + b, 0) / lengths.length
    : 0;
  const variance =
    lengths.length > 1
      ? lengths.reduce((s, l) => s + (l - avg_len) ** 2, 0) / lengths.length
      : 0;

  const msg_ids = msgs.map(msgId).filter(Boolean).sort();
  const ts_list = msgs.map(messageTimestamp).filter(Boolean);

  const engagement = {
    first_response_latency_ms: makeSignal({
      value: lat.first_response_latency_ms,
      unit: "ms",
      confidence: lat.sample_size >= 1 ? 0.8 : 0.2,
      sample_size: lat.sample_size,
      evidence: msg_ids,
      explanation:
        lat.sample_size >= 1
          ? "Gap between first two inbound timestamps"
          : "insufficient_data",
      as_of,
      first_observed: earliestIso(ts_list, as_of),
      last_updated: latestIso(ts_list, as_of),
    }),
    median_response_latency_ms: makeSignal({
      value: lat.median_response_latency_ms,
      unit: "ms",
      confidence: lat.sample_size >= 2 ? 0.75 : 0.2,
      sample_size: lat.sample_size,
      evidence: msg_ids,
      explanation:
        lat.sample_size >= 2 ? "Median inter-inbound gap" : "insufficient_data",
      as_of,
      first_observed: earliestIso(ts_list, as_of),
      last_updated: latestIso(ts_list, as_of),
    }),
    inbound_count: makeSignal({
      value: lat.inbound_count,
      unit: "count",
      confidence: 0.95,
      sample_size: lat.inbound_count,
      evidence: msg_ids,
      explanation: "Inbound message count",
      as_of,
      first_observed: earliestIso(ts_list, as_of),
      last_updated: latestIso(ts_list, as_of),
    }),
    conversation_duration_ms: makeSignal({
      value: lat.conversation_duration_ms,
      unit: "ms",
      confidence: lat.inbound_count >= 2 ? 0.8 : 0.2,
      evidence: msg_ids,
      explanation: "First to last inbound",
      as_of,
      first_observed: earliestIso(ts_list, as_of),
      last_updated: latestIso(ts_list, as_of),
    }),
    engagement_trajectory: makeSignal({
      value: traj.value,
      confidence: traj.confidence,
      sample_size: lat.sample_size,
      evidence: msg_ids,
      explanation:
        lat.sample_size < 2
          ? "insufficient_data — need 2+ gaps for trend"
          : `Trajectory from latency gaps: ${traj.value}`,
      as_of,
      first_observed: earliestIso(ts_list, as_of),
      last_updated: latestIso(ts_list, as_of),
    }),
    multi_message_burst_count: makeSignal({
      value: Array.isArray(burst_events) ? burst_events.length : 0,
      unit: "count",
      confidence: Array.isArray(burst_events) ? 0.85 : 0.3,
      evidence: (burst_events || []).map((b) => b.burst_id || b.id).filter(Boolean),
      explanation: "From acquisition_brain_shadow_burst_plan events when provided",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
    inbound_count_raw: lat.inbound_count,
  };

  const q_marks = bodies.filter((b) => b.includes("?")).length;
  const communication = {
    length_style: makeSignal({
      value: avg_len < 40 ? "concise" : avg_len > 120 ? "detailed" : "moderate",
      confidence: lengths.length ? 0.7 : 0.2,
      sample_size: lengths.length,
      evidence: msg_ids,
      explanation: `Mean length ${Math.round(avg_len)} chars`,
      as_of,
      first_observed: earliestIso(ts_list, as_of),
      last_updated: latestIso(ts_list, as_of),
    }),
    average_response_length: makeSignal({
      value: Math.round(avg_len),
      unit: "chars",
      confidence: lengths.length ? 0.8 : 0.2,
      evidence: msg_ids,
      explanation: "Mean inbound length",
      as_of,
      first_observed: earliestIso(ts_list, as_of),
      last_updated: latestIso(ts_list, as_of),
    }),
    response_length_variance: makeSignal({
      value: Math.round(variance),
      unit: "chars^2",
      confidence: lengths.length > 1 ? 0.7 : 0.2,
      evidence: msg_ids,
      explanation: "Variance of lengths",
      as_of,
      first_observed: earliestIso(ts_list, as_of),
      last_updated: latestIso(ts_list, as_of),
    }),
    question_style: makeSignal({
      value:
        bodies.length === 0
          ? "insufficient_data"
          : q_marks / bodies.length > 0.5
            ? "question_heavy"
            : q_marks === 0
              ? "declarative"
              : "mixed",
      confidence: bodies.length ? 0.65 : 0.2,
      evidence: msg_ids,
      explanation: "Punctuation ? density only",
      as_of,
      first_observed: earliestIso(ts_list, as_of),
      last_updated: latestIso(ts_list, as_of),
    }),
    preferred_language: makeSignal({
      value: msgs.find((m) => m.language)?.language || getNormalizedFactValue(facts, FACT_TYPES.LANGUAGE) || "unknown",
      confidence: msgs.some((m) => m.language) || hasFactType(facts, FACT_TYPES.LANGUAGE) ? 0.85 : 0.2,
      evidence: getFactEvidenceIds(facts, FACT_TYPES.LANGUAGE).concat(msg_ids).slice(0, 10),
      explanation: "From language tags / language fact",
      as_of,
      first_observed: earliestIso(ts_list, as_of),
      last_updated: latestIso(ts_list, as_of),
    }),
    preferred_contact_time: makeSignal({
      value: "insufficient_data",
      confidence: 0.15,
      evidence: [],
      explanation: "Insufficient timestamp density for preferred contact window",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
  };

  const ownership = hasFactType(facts, FACT_TYPES.OWNERSHIP_CONFIRMED);
  const interest =
    hasFactType(facts, FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED) ||
    hasFactType(facts, FACT_TYPES.SELLER_REQUESTS_PROPOSAL);
  const price = hasFactType(facts, FACT_TYPES.ASKING_PRICE);
  const condition =
    hasFactType(facts, FACT_TYPES.CONDITION_SUMMARY) ||
    hasFactType(facts, FACT_TYPES.ROOF_CONDITION);

  const acquisition_intent = {
    ownership_certainty: makeSignal({
      value: ownership ? "confirmed" : "unknown",
      confidence: ownership ? 0.9 : 0.3,
      evidence: getFactEvidenceIds(facts, FACT_TYPES.OWNERSHIP_CONFIRMED),
      explanation: "Exact ownership_confirmed fact",
      claim_verification_status: ownership ? "claimed_or_verified" : "missing",
      as_of,
      first_observed: earliestIso(
        getActiveFactsByType(facts, FACT_TYPES.OWNERSHIP_CONFIRMED).map(factTimestamp),
        as_of
      ),
      last_updated: latestIso(
        getActiveFactsByType(facts, FACT_TYPES.OWNERSHIP_CONFIRMED).map(factTimestamp),
        as_of
      ),
    }),
    proposal_openness: makeSignal({
      value: interest ? "open" : "unknown",
      confidence: interest ? 0.85 : 0.3,
      evidence: [
        ...getFactEvidenceIds(facts, FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED),
        ...getFactEvidenceIds(facts, FACT_TYPES.SELLER_REQUESTS_PROPOSAL),
      ],
      explanation: "Proposal interest / seller requests proposal",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
    price_supplied: makeSignal({
      value: price ? getNormalizedFactValue(facts, FACT_TYPES.ASKING_PRICE) : null,
      confidence: price ? 0.9 : 0.3,
      evidence: getFactEvidenceIds(facts, FACT_TYPES.ASKING_PRICE),
      explanation: "Exact asking_price fact",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
    condition_completeness: makeSignal({
      value: condition ? "partial_or_complete" : "unknown",
      confidence: condition ? 0.8 : 0.3,
      evidence: getFactEvidenceIds(facts, FACT_TYPES.CONDITION_SUMMARY),
      explanation: "Condition facts present",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
    not_interested: makeSignal({
      value: hasFactType(facts, FACT_TYPES.NOT_INTERESTED),
      confidence: hasFactType(facts, FACT_TYPES.NOT_INTERESTED) ? 0.95 : 0.4,
      evidence: getFactEvidenceIds(facts, FACT_TYPES.NOT_INTERESTED),
      explanation: "Explicit not_interested fact",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
    // Separated from external transaction claims
    contract_intent: makeSignal({
      value: hasFactType(facts, FACT_TYPES.CONTRACT_REQUESTED)
        ? "contract_requested"
        : "none",
      confidence: hasFactType(facts, FACT_TYPES.CONTRACT_REQUESTED) ? 0.8 : 0.4,
      evidence: getFactEvidenceIds(facts, FACT_TYPES.CONTRACT_REQUESTED),
      explanation: "Acquisition contract intent only — not under_contract_claim",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
    external_transaction_claims: {
      already_under_contract_claim: hasFactType(facts, FACT_TYPES.UNDER_CONTRACT_CLAIM),
      escrow_open_claim: hasFactType(facts, FACT_TYPES.ESCROW_OPEN_CLAIM),
      closing_claim: hasFactType(facts, FACT_TYPES.CLOSING_CLAIM),
      sold_claim: hasFactType(facts, FACT_TYPES.SOLD_PROPERTY),
      note: "Claims remain claimed unless authoritative; never advance Stages 7–10",
    },
  };

  const negotiation = {
    initial_price_anchor: makeSignal({
      value: getNormalizedFactValue(facts, FACT_TYPES.ASKING_PRICE),
      confidence: price ? 0.85 : 0.2,
      evidence: getFactEvidenceIds(facts, FACT_TYPES.ASKING_PRICE),
      explanation: "From asking_price fact only",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
    asking_price_range: makeSignal({
      value: getNormalizedFactValue(facts, FACT_TYPES.ASKING_PRICE_RANGE),
      confidence: hasFactType(facts, FACT_TYPES.ASKING_PRICE_RANGE) ? 0.85 : 0.2,
      evidence: getFactEvidenceIds(facts, FACT_TYPES.ASKING_PRICE_RANGE),
      explanation: "Price range fact",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
    price_firmness: makeSignal({
      value: getNormalizedFactValue(facts, FACT_TYPES.PRICE_FIRMNESS),
      confidence: hasFactType(facts, FACT_TYPES.PRICE_FIRMNESS) ? 0.8 : 0.2,
      evidence: getFactEvidenceIds(facts, FACT_TYPES.PRICE_FIRMNESS),
      explanation: "Explicit firmness fact",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
    price_flexibility: makeSignal({
      value: getNormalizedFactValue(facts, FACT_TYPES.PRICE_FLEXIBILITY),
      confidence: hasFactType(facts, FACT_TYPES.PRICE_FLEXIBILITY) ? 0.8 : 0.2,
      evidence: getFactEvidenceIds(facts, FACT_TYPES.PRICE_FLEXIBILITY),
      explanation: "Explicit flexibility — never infers desperation",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
    seller_counter_count: makeSignal({
      value: getActiveFactsByType(facts, FACT_TYPES.SELLER_COUNTER).length,
      unit: "count",
      confidence: 0.7,
      evidence: getFactEvidenceIds(facts, FACT_TYPES.SELLER_COUNTER),
      explanation: "Count of seller_counter facts",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
    competing_proposal_mention: makeSignal({
      value: hasFactType(facts, FACT_TYPES.COMPETING_PROPOSAL),
      confidence: hasFactType(facts, FACT_TYPES.COMPETING_PROPOSAL) ? 0.85 : 0.3,
      evidence: getFactEvidenceIds(facts, FACT_TYPES.COMPETING_PROPOSAL),
      explanation: "Competing proposal fact",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
    credibility_or_trust_questions: makeSignal({
      value:
        hasFactType(facts, FACT_TYPES.CREDIBILITY_QUESTION) ||
        hasFactType(facts, FACT_TYPES.TRUST_QUESTION),
      confidence: 0.8,
      evidence: [
        ...getFactEvidenceIds(facts, FACT_TYPES.CREDIBILITY_QUESTION),
        ...getFactEvidenceIds(facts, FACT_TYPES.TRUST_QUESTION),
      ],
      explanation: "Trust/credibility question facts",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
  };

  // Surface tone — evidence-backed, no psych diagnosis
  let tone_value = "insufficient_data";
  let tone_conf = 0.25;
  let tone_ev = [];
  if (hasFactType(facts, FACT_TYPES.OPT_OUT) || hasFactType(facts, FACT_TYPES.WRONG_NUMBER)) {
    tone_value = "terminal_compliance";
    tone_conf = 1;
    tone_ev = [
      ...getFactEvidenceIds(facts, FACT_TYPES.OPT_OUT),
      ...getFactEvidenceIds(facts, FACT_TYPES.WRONG_NUMBER),
    ];
  } else if (hasFactType(facts, FACT_TYPES.HOSTILITY) || hasFactType(facts, FACT_TYPES.LEGAL_THREAT)) {
    tone_value = "hostile";
    tone_conf = 0.9;
    tone_ev = getFactEvidenceIds(facts, FACT_TYPES.HOSTILITY);
  } else if (hasFactType(facts, FACT_TYPES.NOT_INTERESTED)) {
    tone_value = "disinterested";
    tone_conf = 0.9;
    tone_ev = getFactEvidenceIds(facts, FACT_TYPES.NOT_INTERESTED);
  } else if (hasFactType(facts, FACT_TYPES.CREDIBILITY_QUESTION)) {
    tone_value = "skeptical";
    tone_conf = 0.75;
    tone_ev = getFactEvidenceIds(facts, FACT_TYPES.CREDIBILITY_QUESTION);
  } else if (interest || ownership) {
    tone_value = "positive";
    tone_conf = 0.65;
    tone_ev = getFactEvidenceIds(facts, FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED);
  } else if (msgs.length) {
    tone_value = "neutral";
    tone_conf = 0.5;
    tone_ev = msg_ids.slice(0, 3);
  }

  const tone = {
    conversation_tone: makeSignal({
      value: tone_value,
      confidence: tone_conf,
      evidence: tone_ev,
      explanation: "Surface intent/fact based only — not a mental-state diagnosis",
      as_of,
      first_observed: as_of,
      last_updated: as_of,
    }),
  };

  const authority = buildAuthorityProfile(facts, as_of);
  const opportunity_score = computeOpportunityScore({
    facts,
    messages: msgs,
    authority,
    engagement,
    as_of,
  });

  const input_hash = computeProfileInputHash({
    thread_key: thread,
    facts,
    messages: msgs,
    burst_ref,
    followup_ref,
    as_of,
  });

  const profile = {
    thread_key: thread,
    fact_state_ref,
    decision_ref,
    burst_ref,
    followup_ref,
    current_stage,
    calculation_window: "conversation",
    as_of,
    input_hash,
    profile_version: SELLER_INTEL_PROFILE_VERSION,
    scoring_version: SELLER_INTEL_SCORING_VERSION,
    signals: {
      engagement,
      communication,
      acquisition_intent,
      negotiation,
      authority,
      tone,
    },
    opportunity_score,
    safety_exclusions: SELLER_INTEL_EXCLUSIONS,
    evidence_completeness: {
      fact_count: facts.filter((f) => f.active !== false).length,
      message_count: msgs.length,
      missing_acquisition: opportunity_score.missing_signals,
    },
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    lifecycle_registry_version: ACQUISITION_BRAIN_VERSION,
    processing_duration_ms:
      processing_started_ms != null
        ? Math.max(0, Date.now() - processing_started_ms)
        : 0,
  };

  // Deterministic processing_duration for pure replay: zero when no wall clock start
  if (processing_started_ms == null) {
    profile.processing_duration_ms = 0;
  }

  const dedupe_key = `seller_intelligence:${thread}:${input_hash.slice(0, 32)}:${SELLER_INTEL_PROFILE_VERSION}:${SELLER_INTEL_SCORING_VERSION}`;

  return {
    ok: true,
    profile: toJsonSafe(profile),
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    event: {
      event_type: SHADOW_SELLER_INTEL_EVENT,
      dedupe_key,
      conversation_thread_id: thread,
      payload: toJsonSafe(profile),
    },
  };
}

export async function emitShadowSellerIntelligence(result, deps = {}) {
  const emit = deps.emitAutomationEvent;
  if (typeof emit !== "function" || !result?.event) {
    return { ok: false, reason: "emit_unavailable" };
  }
  try {
    const out = await emit(
      {
        event_type: result.event.event_type,
        dedupe_key: result.event.dedupe_key,
        source: "acquisition_brain_shadow",
        conversation_thread_id: result.event.conversation_thread_id,
        payload: result.event.payload,
      },
      deps.supabase
        ? { supabase: deps.supabase, supabaseClient: deps.supabase }
        : {}
    );
    return { ok: true, event: out };
  } catch (error) {
    return { ok: false, reason: error?.message || "emit_failed" };
  }
}

/** Calibration personas A–H */
export function buildCalibrationFixtures(as_of = "2026-07-18T12:00:00.000Z") {
  const f = (type, value, id) => ({
    fact_type: type,
    value,
    normalized_value: value,
    active: true,
    source_message_id: id,
    source_timestamp: as_of,
    fact_id: `${type}:${id}`,
  });
  const m = (id, text, offset_s = 0) => ({
    id,
    message: text,
    timestamp: new Date(Date.parse(as_of) + offset_s * 1000).toISOString(),
  });

  return {
    A_fast_no_ownership: buildSellerIntelligenceProfile({
      thread_key: "+15550000001",
      as_of,
      facts_after: [],
      messages: [m("1", "hi", 0), m("2", "yes?", 30)],
    }),
    B_slow_qualified: buildSellerIntelligenceProfile({
      thread_key: "+15550000002",
      as_of,
      facts_after: [
        f(FACT_TYPES.OWNERSHIP_CONFIRMED, true, "1"),
        f(FACT_TYPES.SELLER_REQUESTS_PROPOSAL, true, "2"),
        f(FACT_TYPES.ASKING_PRICE, 250000, "3"),
      ],
      messages: [m("1", "Yes I own it", 0), m("2", "proposal?", 86400), m("3", "250k", 172800)],
    }),
    C_long_not_interested: buildSellerIntelligenceProfile({
      thread_key: "+15550000003",
      as_of,
      facts_after: [f(FACT_TYPES.NOT_INTERESTED, true, "1")],
      messages: [
        m("1", "I am writing a very long message ".repeat(10), 0),
        m("2", "still not selling ".repeat(5), 60),
      ],
    }),
    D_brief_complete: buildSellerIntelligenceProfile({
      thread_key: "+15550000004",
      as_of,
      facts_after: [
        f(FACT_TYPES.OWNERSHIP_CONFIRMED, true, "1"),
        f(FACT_TYPES.ASKING_PRICE, 200000, "1"),
        f(FACT_TYPES.ROOF_CONDITION, "needs_work", "1"),
        f(FACT_TYPES.DESIRED_TIMELINE, "30_days", "1"),
        f(FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED, true, "1"),
      ],
      messages: [m("1", "Own it. 200k. Roof old. 30 days.", 0)],
    }),
    E_probate: buildSellerIntelligenceProfile({
      thread_key: "+15550000005",
      as_of,
      facts_after: [
        f(FACT_TYPES.FAMILY_MEMBER, true, "1"),
        f(FACT_TYPES.PROBATE_DETECTED, true, "2"),
        f(FACT_TYPES.OWNERSHIP_CONFIRMED, true, "1"),
      ],
      messages: [m("1", "brother owns it", 0), m("2", "he passed", 60)],
    }),
    F_llc: buildSellerIntelligenceProfile({
      thread_key: "+15550000006",
      as_of,
      facts_after: [
        f(FACT_TYPES.LLC_AUTHORITY_REQUIRED, true, "1"),
        f(FACT_TYPES.OWNERSHIP_CONFIRMED, true, "1"),
      ],
      messages: [m("1", "LLC owns it", 0)],
    }),
    G_under_contract_claim: buildSellerIntelligenceProfile({
      thread_key: "+15550000007",
      as_of,
      facts_after: [
        f(FACT_TYPES.OWNERSHIP_CONFIRMED, true, "1"),
        f(FACT_TYPES.UNDER_CONTRACT_CLAIM, true, "2"),
      ],
      messages: [m("1", "I own it", 0), m("2", "already under contract", 60)],
    }),
    H_opt_out: buildSellerIntelligenceProfile({
      thread_key: "+15550000008",
      as_of,
      facts_after: [
        f(FACT_TYPES.OWNERSHIP_CONFIRMED, true, "1"),
        f(FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED, true, "2"),
        f(FACT_TYPES.OPT_OUT, true, "3"),
      ],
      messages: [m("1", "yes", 0), m("2", "proposal", 30), m("3", "STOP", 60)],
    }),
  };
}

export default {
  SHADOW_SELLER_INTEL_EVENT,
  SELLER_INTEL_PROFILE_VERSION,
  SELLER_INTEL_SCORING_VERSION,
  SELLER_INTEL_VERSION,
  SELLER_INTEL_EXCLUSIONS,
  FACT_TYPE_ALIASES,
  TRI_STATE,
  resolveCanonicalFactType,
  hasFactType,
  getActiveFactsByType,
  getBestActiveFact,
  getFactEvidenceIds,
  getNormalizedFactValue,
  buildAuthorityProfile,
  computeOpportunityScore,
  computeProfileInputHash,
  buildSellerIntelligenceProfile,
  emitShadowSellerIntelligence,
  buildCalibrationFixtures,
};
