// ─── inbound-analysis-contract.js ────────────────────────────────────────────
// Canonical per-message/per-burst inbound analysis contract. One shape, one
// version, persisted with every processing attempt (ledger disposition_detail
// and intelligence snapshots).
//
// Honesty rule: deterministic surface signals are computed here; behavioral /
// psychological estimates (sentiment, hostility, trust, motivation, …) are
// EVIDENCE-BEARING ESTIMATES that require a scoring model. Until one is wired,
// those fields are null with scorer:"unscored" — never fabricated from message
// length or punctuation. Message length alone reveals typing, not psychology.

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
 */
export function buildInboundAnalysis({
  raw_text = "",
  classification = {},
  timing = {},
  precedence = null,
  decision = null,
} = {}) {
  const raw = String(raw_text ?? "");
  const normalized = clean(raw).replace(/\s+/g, " ");
  const words = normalized ? normalized.split(" ").filter(Boolean) : [];
  const letters = normalized.replace(/[^a-zA-Z]/g, "");
  const uppercase = normalized.replace(/[^A-Z]/g, "");
  const punctuation = normalized.replace(/[a-zA-Z0-9\s]/g, "");

  const unscored = { value: null, scorer: "unscored", evidence: null };

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

    // ── Behavioral estimates: require a scoring model; never fabricated ────
    sentiment: unscored,
    emotional_tone: unscored,
    hostility: unscored,
    urgency: unscored,
    confusion: unscored,
    skepticism: unscored,
    trust: unscored,
    engagement: unscored,
    motivation: unscored,
    sale_readiness: unscored,
    price_sensitivity: unscored,
    timing_sensitivity: unscored,
    ownership_authority_confidence: unscored,
    property_identity_confidence: unscored,

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
