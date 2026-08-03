// ─── inbound-analysis-contract.js ────────────────────────────────────────────
// Canonical per-message/per-burst inbound analysis contract. One shape, one
// version, persisted with every processing attempt (ledger disposition_detail
// and intelligence snapshots).
//
// Honesty rule: deterministic surface signals are computed here; behavioral /
// psychological estimates (sentiment, hostility, trust, motivation, …) are
// EVIDENCE-BEARING ESTIMATES produced by conversation-behavior-scoring.js —
// deterministic evidence first, every score carrying value/confidence/
// evidence/scorer/version, and value:null + fallback_reason when the evidence
// is insufficient. Nothing is fabricated from message length or punctuation
// (message length alone reveals typing, not psychology; only the explicitly
// mechanical reply_effort measure may use it). Dimensions outside the scorer's
// scope (emotional_tone, ownership_authority_confidence,
// property_identity_confidence) remain scorer:"unscored".

import { scoreConversationBehavior } from "@/lib/domain/seller-flow/conversation-behavior-scoring.js";

export const INBOUND_ANALYSIS_VERSION = "inbound_analysis_contract_v1";

function clean(value) {
  return String(value ?? "").trim();
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const QUESTION_RE = /\?/g;
// Terminal punctuation followed by whitespace or true end-of-input. Inside a
// character class `$` is a literal dollar sign, so `[\s$]` would count
// currency-adjacent punctuation ("10.$") as a sentence boundary.
const SENTENCE_SPLIT_RE = /[.!?]+(?:\s|$)/g;

function safeCount(value, re) {
  const matches = clean(value).match(re);
  return matches ? matches.length : 0;
}

function minutesBetween(later, earlier) {
  const later_ts = Date.parse(later || "");
  const earlier_ts = Date.parse(earlier || "");
  if (!Number.isFinite(later_ts) || !Number.isFinite(earlier_ts)) return null;
  return Math.round((later_ts - earlier_ts) / 60_000);
}

/**
 * Build the canonical analysis object for one inbound message (or aggregated
 * burst text).
 *
 * @param {object} input
 * @param {string} input.raw_text
 * @param {object} [input.classification] classify() result
 * @param {object} [input.timing] { received_at, prior_inbound_at,
 *   prior_outbound_at, thread_created_at }
 * @param {object} [input.precedence] latest-intent precedence decision
 * @param {object} [input.decision] automation decision (route/reply policy)
 * @param {object} [input.extraction] extractSellerFacts() record (optional
 *   evidence source for the behavior scorer)
 * @param {object} [input.thread_stats] { seller_reply_count,
 *   conversation_depth, reply_latency_seconds } (optional)
 * @param {object} [input.behavior] precomputed scoreConversationBehavior()
 *   result — when omitted, scores are computed here from the same inputs
 */
export function buildInboundAnalysis({
  raw_text = "",
  classification = {},
  timing = {},
  precedence = null,
  decision = null,
  extraction = null,
  thread_stats = null,
  behavior = null,
} = {}) {
  const raw = String(raw_text ?? "");
  const normalized = clean(raw).replace(/\s+/g, " ");
  const words = normalized ? normalized.split(" ").filter(Boolean) : [];
  const letters = normalized.replace(/[^a-zA-Z]/g, "");
  const uppercase = normalized.replace(/[^A-Z]/g, "");
  const punctuation = normalized.replace(/[a-zA-Z0-9\s]/g, "");

  // Deliberately-unscored dimensions carry the FULL score-object contract
  // (value/confidence/evidence/scorer/scorer_version/fallback_reason) so no
  // consumer needs a special case for out-of-scope fields.
  const unscored = {
    value: null,
    confidence: 0,
    evidence: [],
    scorer: "unscored",
    scorer_version: null,
    fallback_reason: "out_of_scope",
  };

  // Behavioral scores: evidence-based, confidence-qualified, safe-degrading.
  // A scorer failure (or absent classification) yields all-null score objects
  // carrying fallback_reason — the contract never throws because of scoring.
  const reply_latency_minutes_for_stats = minutesBetween(
    timing.received_at,
    timing.prior_outbound_at
  );
  const behavior_result =
    behavior && behavior.scores
      ? behavior
      : scoreConversationBehavior({
          raw_text: raw,
          classification,
          extraction,
          precedence,
          thread_stats:
            thread_stats ||
            (reply_latency_minutes_for_stats != null
              ? { reply_latency_seconds: reply_latency_minutes_for_stats * 60 }
              : null),
        });
  const scores = behavior_result?.scores || {};
  const dim = (name) => scores[name] || unscored;

  return {
    version: INBOUND_ANALYSIS_VERSION,

    // ── Deterministic surface signals ──────────────────────────────────────
    raw_text: raw,
    normalized_text: normalized,
    language: clean(classification.language) || null,
    character_count: raw.length,
    word_count: words.length,
    sentence_count: normalized ? Math.max(1, safeCount(normalized, SENTENCE_SPLIT_RE)) : 0,
    question_count: safeCount(normalized, QUESTION_RE),
    punctuation_intensity: normalized.length
      ? Number((punctuation.length / normalized.length).toFixed(3))
      : 0,
    capitalization_intensity: letters.length
      ? Number((uppercase.length / letters.length).toFixed(3))
      : 0,
    emoji_count: safeCount(raw, EMOJI_RE),
    emoji_only: raw.length > 0 && clean(raw.replace(EMOJI_RE, "")) === "",
    empty_or_media_only: clean(raw) === "",

    // ── Timing ─────────────────────────────────────────────────────────────
    reply_latency_minutes: minutesBetween(timing.received_at, timing.prior_outbound_at),
    minutes_since_prior_inbound: minutesBetween(timing.received_at, timing.prior_inbound_at),
    minutes_since_prior_outbound: minutesBetween(timing.received_at, timing.prior_outbound_at),
    thread_age_minutes: minutesBetween(timing.received_at, timing.thread_created_at),

    // ── Intent (deterministic classifier) ──────────────────────────────────
    intent: clean(classification.primary_intent) || null,
    secondary_intents: Array.isArray(classification.secondary)
      ? classification.secondary
      : Array.isArray(classification.secondary_intents)
        ? classification.secondary_intents
        : [],
    compliance_flag: clean(classification.compliance_flag) || null,
    confidence: Number.isFinite(Number(classification.confidence))
      ? Number(classification.confidence)
      : null,
    classifier_version: clean(classification.version) || null,

    // ── Precedence / supersession ──────────────────────────────────────────
    re_engagement_signal: precedence?.re_engagement_detected === true,
    reversal_signal: precedence?.state_patch?.reversal === true,
    prior_state_superseded: precedence?.supersedes_prior_state === true,
    precedence_evidence: precedence?.evidence ?? null,
    precedence_version: precedence?.version ?? null,

    // ── Behavioral estimates (conversation-behavior-scoring.js) ────────────
    // Evidence-backed score objects: { value, confidence, evidence, scorer,
    // scorer_version, fallback_reason }. Insufficient evidence → value:null.
    sentiment: dim("sentiment"),
    emotional_tone: unscored,
    hostility: dim("hostility"),
    urgency: dim("urgency"),
    confusion: dim("confusion"),
    skepticism: dim("skepticism"),
    // `trust` predates the scorer; it now carries the trust_concern score
    // (higher value = more seller concern about legitimacy).
    trust: dim("trust_concern"),
    trust_concern: dim("trust_concern"),
    engagement: dim("engagement"),
    motivation: dim("motivation"),
    sale_readiness: dim("sale_readiness"),
    price_sensitivity: dim("price_sensitivity"),
    timing_sensitivity: dim("timing_sensitivity"),
    reply_effort: dim("reply_effort"),
    conversational_momentum: dim("conversational_momentum"),
    re_engagement_strength: dim("re_engagement_strength"),
    ownership_authority_confidence: unscored,
    property_identity_confidence: unscored,
    behavior_scoring: {
      version: behavior_result?.version || null,
      scorer: behavior_result?.scorer || "unscored",
      model_assist: behavior_result?.model_assist || null,
    },

    // ── Recommended action (from the deterministic decision layer) ─────────
    recommended_action: decision?.next_action ?? null,
    reply_policy: decision
      ? {
          reply_permitted: decision.should_queue_reply === true,
          reply_required: decision.should_queue_reply === true,
          escalate_to_human: decision.should_mark_human_review === true,
          route_hint: decision.route_hint ?? null,
          audit_reason: decision.audit_reason ?? null,
        }
      : null,
  };
}

export default buildInboundAnalysis;
