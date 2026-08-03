// ─── conversation-behavior-scoring.js ────────────────────────────────────────
// Evidence-based, confidence-qualified behavioral/conversation scoring.
//
// Replaces the analysis contract's `{value:null, scorer:"unscored"}`
// placeholders with real score objects. Every score carries machine-readable
// EVIDENCE — a score with no evidence does not exist (value:null,
// fallback_reason:"insufficient_evidence"). Nothing here is fabricated from
// message length: length may only ground `reply_effort` (an explicitly
// mechanical measure of typing effort, documented as such, not psychology)
// and may never, alone, produce sentiment/motivation/engagement.
//
// Deliberately NOT consumed as evidence (fabrication sources):
//   * classify()'s `motivation_score` / `seller_state.motivation_level` —
//     partially derived from the guarded/calm length proxy;
//   * emotion values `guarded` / `calm` — classify.js emits them from word
//     count alone (wordCount <= 2 ? guarded : calm), which is typing, not
//     psychology. Only the semantic emotions (motivated, curious, skeptical,
//     frustrated, tired_landlord, overwhelmed, grieving) count.
//
// ── Bounded transition rules (the ONLY ways scores may influence state) ─────
// Scores never write state. They flow exclusively through the
// temperature-signal-model `behavior` seam, under these caps:
//
// | score                 | effect                                    | cap |
// |-----------------------|-------------------------------------------|-----|
// | hostility             | value>=0.6 && conf>=0.7 adds friction     | friction only; explicit-negative
// |                       | reason code BEHAVIOR_HOSTILITY_FRICTION   | intents already cap COLD |
// | urgency               | value>=0.7 && conf>=0.6 may lift          | 0.4 < every floor threshold —
// |                       | urgency_score to at most 0.4 when NO      | can never create WARM/HOT |
// |                       | explicit timeline fact exists             | alone |
// | engagement            | reason code only (BEHAVIOR_ENGAGEMENT_    | engagement floor stays
// |                       | CORROBORATED); never changes the score    | COLD-only (model lines
// |                       |                                           | 161-179 preserved) |
// | re_engagement_strength| corroboration metadata only — may never   | precedence remains the only
// |                       | create a re-engagement precedence missed  | re-engagement authority |
// | all others            | descriptive only (analysis contract)      | no state effect |
//
// ── Model-assist seam ────────────────────────────────────────────────────────
// `modelAssistScorer` (injectable, DEFAULT null, never called when absent)
// may only NARROW ambiguity on mid-range deterministic scores:
//   * ignored entirely when compliance/suppression/identity context is
//     present (opt_out, wrong_number, hostile_or_legal, who_is_this, any
//     compliance_flag, active suppression) — model output can never override
//     opt-out, wrong-number, identity, compliance, or authoritative state;
//   * `hostility` is permanently protected;
//   * per accepted dimension: deterministic value must be non-null and in
//     [0.3, 0.7], the proposal within ±0.15 of it; confidence may rise by at
//     most +0.1. Everything else is discarded. Null stays null — the model
//     may never invent a score the evidence didn't support.

export const CONVERSATION_BEHAVIOR_SCORING_VERSION =
  "conversation_behavior_scoring_v1";

export const DETERMINISTIC_SCORER = "deterministic_v1";

export const BEHAVIOR_SCORE_DIMENSIONS = Object.freeze([
  "sentiment",
  "hostility",
  "urgency",
  "confusion",
  "skepticism",
  "trust_concern",
  "engagement",
  "motivation",
  "sale_readiness",
  "price_sensitivity",
  "timing_sensitivity",
  "reply_effort",
  "conversational_momentum",
  "re_engagement_strength",
]);

// Dimensions the model-assist seam may never touch, regardless of context.
export const PROTECTED_BEHAVIOR_DIMENSIONS = Object.freeze(["hostility"]);

// Compliance/identity contexts in which model assist is ignored wholesale.
const PROTECTED_CONTEXT_INTENTS = new Set([
  "opt_out",
  "wrong_number",
  "hostile_or_legal",
  "who_is_this",
]);

// classify.js emits these two from word count alone — typing, not psychology.
const LENGTH_PROXY_EMOTIONS = new Set(["guarded", "calm"]);

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round3(value) {
  return Number(value.toFixed(3));
}

function scored(value, confidence, evidence) {
  return {
    value: round3(value),
    confidence: round3(clamp(confidence, 0, 1)),
    evidence,
    scorer: DETERMINISTIC_SCORER,
    scorer_version: CONVERSATION_BEHAVIOR_SCORING_VERSION,
    fallback_reason: null,
  };
}

function unscored(fallback_reason = "insufficient_evidence") {
  return {
    value: null,
    confidence: 0,
    evidence: [],
    scorer: "unscored",
    scorer_version: CONVERSATION_BEHAVIOR_SCORING_VERSION,
    fallback_reason,
  };
}

// Confidence grows with independent corroborating evidence, never past 0.95.
function confidenceFor(evidence, base = 0.55) {
  return clamp(base + 0.12 * Math.max(0, evidence.length - 1), 0, 0.95);
}

/**
 * Aggregate weighted evidence into one score. Each entry:
 *   { kind, detail, weight }  → evidence output drops `weight`.
 * Aggregation: strongest signal anchors, additional distinct evidence pulls
 * the value 25% of the way toward its own weight (diminishing corroboration,
 * never simple averaging that would dilute a strong explicit signal).
 */
function aggregate(entries, { base_confidence = 0.55 } = {}) {
  if (!entries.length) return null;
  const sorted = [...entries].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  let value = sorted[0].weight;
  for (const entry of sorted.slice(1)) {
    value = value + 0.25 * (entry.weight - value);
  }
  const evidence = sorted.map(({ kind, detail }) => ({ kind, detail }));
  return scored(clamp(value, -1, 1), confidenceFor(evidence, base_confidence), evidence);
}

function collectClassificationSignals(classification) {
  const primary = lower(classification?.primary_intent);
  const secondary = Array.isArray(classification?.secondary_intents)
    ? classification.secondary_intents.map(lower)
    : [];
  const objection = lower(classification?.objection);
  const raw_emotion = lower(classification?.emotion);
  const emotion = LENGTH_PROXY_EMOTIONS.has(raw_emotion) ? null : raw_emotion || null;
  const positives = Array.isArray(classification?.positive_signals)
    ? classification.positive_signals.map(lower)
    : [];
  const compliance_flag = lower(classification?.compliance_flag) || null;
  const ambiguity = Array.isArray(classification?.ambiguity_flags)
    ? classification.ambiguity_flags
    : [];
  const price = classification?.price_parse || null;
  const intents = new Set([primary, ...secondary].filter(Boolean));
  return {
    primary,
    secondary,
    intents,
    objection,
    emotion,
    positives,
    compliance_flag,
    ambiguity,
    price,
  };
}

function extractionObjectionList(extraction) {
  const value = extraction?.facts?.objections?.value;
  return Array.isArray(value?.objections) ? value.objections.map(lower) : [];
}

function extractionTimeline(extraction) {
  return lower(extraction?.facts?.timeline?.value) || null;
}

// ── Per-dimension deterministic scorers ─────────────────────────────────────

function scoreSentiment(sig) {
  const entries = [];
  if (sig.intents.has("hostile_or_legal"))
    entries.push({ kind: "intent", detail: "hostile_or_legal", weight: -0.9 });
  if (sig.intents.has("opt_out"))
    entries.push({ kind: "intent", detail: "opt_out", weight: -0.7 });
  if (sig.intents.has("not_interested"))
    entries.push({ kind: "intent", detail: "not_interested", weight: -0.5 });
  if (sig.emotion === "frustrated")
    entries.push({ kind: "emotion", detail: "frustrated", weight: -0.6 });
  if (sig.emotion === "grieving")
    entries.push({ kind: "emotion", detail: "grieving", weight: -0.4 });
  if (sig.intents.has("seller_interested"))
    entries.push({ kind: "intent", detail: "seller_interested", weight: 0.6 });
  if (sig.intents.has("asks_offer"))
    entries.push({ kind: "intent", detail: "asks_offer", weight: 0.5 });
  if (sig.intents.has("asking_price_provided"))
    entries.push({ kind: "intent", detail: "asking_price_provided", weight: 0.4 });
  if (sig.emotion === "motivated")
    entries.push({ kind: "emotion", detail: "motivated", weight: 0.5 });
  if (sig.emotion === "curious")
    entries.push({ kind: "emotion", detail: "curious", weight: 0.3 });
  // `affirmative` alone on a bare acknowledgement is typing, not positivity —
  // it only counts when an interest-bearing intent corroborates it.
  if (
    sig.positives.includes("affirmative") &&
    ["seller_interested", "ownership_confirmed", "asks_offer", "asking_price_provided"].some(
      (i) => sig.intents.has(i)
    )
  ) {
    entries.push({ kind: "positive_signal", detail: "affirmative_corroborated", weight: 0.3 });
  }
  return aggregate(entries) || unscored();
}

function scoreHostility(sig) {
  const entries = [];
  if (sig.intents.has("hostile_or_legal"))
    entries.push({ kind: "intent", detail: "hostile_or_legal", weight: 0.9 });
  if (sig.emotion === "frustrated")
    entries.push({ kind: "emotion", detail: "frustrated", weight: 0.5 });
  return aggregate(entries, { base_confidence: 0.7 }) || unscored();
}

function scoreUrgency(sig, extraction) {
  const entries = [];
  const timeline = extractionTimeline(extraction);
  if (timeline === "immediate")
    entries.push({ kind: "fact", detail: "timeline_immediate", weight: 0.9 });
  else if (timeline === "soon")
    entries.push({ kind: "fact", detail: "timeline_soon", weight: 0.6 });
  if (sig.positives.includes("urgency"))
    entries.push({ kind: "positive_signal", detail: "urgency", weight: 0.8 });
  if (sig.positives.includes("financial_pressure"))
    entries.push({ kind: "positive_signal", detail: "financial_pressure", weight: 0.6 });
  if (sig.objection === "financial_distress")
    entries.push({ kind: "objection", detail: "financial_distress", weight: 0.6 });
  return aggregate(entries) || unscored();
}

function scoreConfusion(sig) {
  const entries = [];
  if (sig.primary === "unclear" && sig.ambiguity.length > 0) {
    entries.push({
      kind: "ambiguity_flag",
      detail: sig.ambiguity.slice(0, 3).join(","),
      weight: 0.6,
    });
  }
  if (sig.intents.has("property_correction"))
    entries.push({ kind: "intent", detail: "property_correction", weight: 0.5 });
  if (sig.objection === "who_is_this")
    entries.push({ kind: "objection", detail: "who_is_this", weight: 0.4 });
  if (sig.emotion === "overwhelmed")
    entries.push({ kind: "emotion", detail: "overwhelmed", weight: 0.5 });
  return aggregate(entries) || unscored();
}

function scoreSkepticism(sig, extraction) {
  const entries = [];
  if (sig.emotion === "skeptical")
    entries.push({ kind: "emotion", detail: "skeptical", weight: 0.7 });
  if (sig.intents.has("who_is_this"))
    entries.push({ kind: "intent", detail: "who_is_this", weight: 0.5 });
  if (sig.objection === "wants_proof_of_funds")
    entries.push({ kind: "objection", detail: "wants_proof_of_funds", weight: 0.6 });
  if (extractionObjectionList(extraction).includes("trust_concern"))
    entries.push({ kind: "objection", detail: "trust_concern", weight: 0.6 });
  return aggregate(entries) || unscored();
}

function scoreTrustConcern(sig, extraction) {
  const entries = [];
  if (extractionObjectionList(extraction).includes("trust_concern"))
    entries.push({ kind: "objection", detail: "trust_concern", weight: 0.7 });
  if (sig.objection === "wants_proof_of_funds")
    entries.push({ kind: "objection", detail: "wants_proof_of_funds", weight: 0.6 });
  if (sig.emotion === "skeptical")
    entries.push({ kind: "emotion", detail: "skeptical", weight: 0.5 });
  if (sig.intents.has("who_is_this"))
    entries.push({ kind: "intent", detail: "who_is_this", weight: 0.4 });
  return aggregate(entries) || unscored();
}

function scoreEngagement(sig, thread_stats, mech) {
  const entries = [];
  const replies = Number(thread_stats?.seller_reply_count);
  const depth = Number(thread_stats?.conversation_depth);
  const latency = Number(thread_stats?.reply_latency_seconds);
  if (Number.isFinite(replies) && replies >= 3)
    entries.push({ kind: "thread_stat", detail: `seller_reply_count:${replies}`, weight: 0.7 });
  else if (Number.isFinite(replies) && replies >= 1)
    entries.push({ kind: "thread_stat", detail: `seller_reply_count:${replies}`, weight: 0.4 });
  if (Number.isFinite(depth) && depth >= 6)
    entries.push({ kind: "thread_stat", detail: `conversation_depth:${depth}`, weight: 0.6 });
  if (Number.isFinite(latency) && latency > 0 && latency < 15 * 60)
    entries.push({ kind: "thread_stat", detail: "reply_latency_under_15m", weight: 0.6 });
  // Questions are semantic participation — but only alongside a real thread
  // stat; a lone "?" on an otherwise evidence-free message is not engagement.
  if (mech.question_count >= 1 && entries.length > 0)
    entries.push({ kind: "mechanical", detail: `question_count:${mech.question_count}`, weight: 0.5 });
  return aggregate(entries) || unscored();
}

function scoreMotivation(sig, extraction) {
  const entries = [];
  if (sig.emotion === "motivated")
    entries.push({ kind: "emotion", detail: "motivated", weight: 0.7 });
  if (sig.emotion === "tired_landlord")
    entries.push({ kind: "emotion", detail: "tired_landlord", weight: 0.6 });
  if (sig.positives.includes("financial_pressure"))
    entries.push({ kind: "positive_signal", detail: "financial_pressure", weight: 0.7 });
  if (sig.positives.includes("urgency"))
    entries.push({ kind: "positive_signal", detail: "urgency", weight: 0.6 });
  if (sig.positives.includes("as_is_willing"))
    entries.push({ kind: "positive_signal", detail: "as_is_willing", weight: 0.5 });
  if (sig.positives.includes("cash_aware"))
    entries.push({ kind: "positive_signal", detail: "cash_aware", weight: 0.4 });
  if (sig.objection === "financial_distress")
    entries.push({ kind: "objection", detail: "financial_distress", weight: 0.6 });
  if (sig.objection === "tenant_issue")
    entries.push({ kind: "objection", detail: "tenant_issue", weight: 0.5 });
  if (sig.intents.has("asks_offer"))
    entries.push({ kind: "intent", detail: "asks_offer", weight: 0.6 });
  if (sig.intents.has("asking_price_provided"))
    entries.push({ kind: "intent", detail: "asking_price_provided", weight: 0.6 });
  return aggregate(entries) || unscored();
}

function scoreSaleReadiness(sig) {
  const entries = [];
  if (sig.intents.has("asking_price_provided"))
    entries.push({ kind: "intent", detail: "asking_price_provided", weight: 0.8 });
  if (sig.intents.has("asks_offer"))
    entries.push({ kind: "intent", detail: "asks_offer", weight: 0.7 });
  if (sig.intents.has("seller_interested"))
    entries.push({ kind: "intent", detail: "seller_interested", weight: 0.6 });
  if (sig.price?.qualifies_as_seller_asking_price === true)
    entries.push({ kind: "price_parse", detail: "seller_asking_price_stated", weight: 0.7 });
  const scoredResult = aggregate(entries);
  if (!scoredResult) return unscored();
  // Readiness blockers cap the score: an interested seller who needs time or
  // family sign-off is not ready, whatever the enthusiasm.
  const blockers = [];
  if (sig.objection === "need_time") blockers.push("need_time");
  if (sig.objection === "need_family_ok") blockers.push("need_family_ok");
  if (sig.intents.has("need_time")) blockers.push("need_time_intent");
  if (blockers.length && scoredResult.value > 0.4) {
    scoredResult.value = 0.4;
    scoredResult.evidence.push({ kind: "objection", detail: `readiness_capped:${blockers.join(",")}` });
  }
  return scoredResult;
}

function scorePriceSensitivity(sig) {
  const entries = [];
  if (sig.objection === "need_more_money")
    entries.push({ kind: "objection", detail: "need_more_money", weight: 0.8 });
  if (sig.objection === "wants_retail")
    entries.push({ kind: "objection", detail: "wants_retail", weight: 0.7 });
  if (sig.objection === "send_offer_first")
    entries.push({ kind: "objection", detail: "send_offer_first", weight: 0.5 });
  if (sig.intents.has("asking_price_provided"))
    entries.push({ kind: "intent", detail: "asking_price_provided", weight: 0.5 });
  if (sig.positives.includes("price_curious"))
    entries.push({ kind: "positive_signal", detail: "price_curious", weight: 0.5 });
  return aggregate(entries) || unscored();
}

function scoreTimingSensitivity(sig, extraction) {
  const entries = [];
  const timeline = extractionTimeline(extraction);
  if (timeline === "immediate")
    entries.push({ kind: "fact", detail: "timeline_immediate", weight: 0.8 });
  else if (timeline === "soon")
    entries.push({ kind: "fact", detail: "timeline_soon", weight: 0.6 });
  else if (timeline === "long_term" || timeline === "flexible")
    entries.push({ kind: "fact", detail: `timeline_${timeline}`, weight: 0.5 });
  if (sig.objection === "need_time" || sig.intents.has("need_time"))
    entries.push({ kind: "objection", detail: "need_time", weight: 0.7 });
  if (sig.positives.includes("urgency"))
    entries.push({ kind: "positive_signal", detail: "urgency", weight: 0.6 });
  return aggregate(entries) || unscored();
}

// Reply effort is EXPLICITLY mechanical: how much typing/composition the
// seller invested. Length, punctuation and question counts are its evidence
// basis by design — this measures effort, not psychology, and nothing may
// launder it into a psychological score.
function scoreReplyEffort(mech) {
  if (!mech.has_text) return unscored("empty_message");
  const entries = [];
  let value;
  if (mech.word_count >= 40) value = 0.85;
  else if (mech.word_count >= 15) value = 0.6;
  else if (mech.word_count >= 4) value = 0.35;
  else value = 0.15;
  entries.push({ kind: "mechanical", detail: `word_count:${mech.word_count}`, weight: value });
  if (mech.question_count >= 1) {
    value = clamp(value + 0.1, 0, 1);
    entries.push({ kind: "mechanical", detail: `question_count:${mech.question_count}` });
  }
  return {
    ...scored(value, 0.9, entries.map(({ kind, detail }) => ({ kind, detail }))),
  };
}

function scoreConversationalMomentum(thread_stats) {
  const entries = [];
  const latency = Number(thread_stats?.reply_latency_seconds);
  const replies = Number(thread_stats?.seller_reply_count);
  if (Number.isFinite(latency) && latency > 0) {
    if (latency < 15 * 60)
      entries.push({ kind: "thread_stat", detail: "reply_latency_under_15m", weight: 0.75 });
    else if (latency < 24 * 3600)
      entries.push({ kind: "thread_stat", detail: "reply_latency_under_24h", weight: 0.5 });
    else if (latency > 7 * 24 * 3600)
      entries.push({ kind: "thread_stat", detail: "reply_latency_over_7d", weight: 0.1 });
    else entries.push({ kind: "thread_stat", detail: "reply_latency_1d_7d", weight: 0.3 });
  }
  if (Number.isFinite(replies) && replies >= 2)
    entries.push({ kind: "thread_stat", detail: `seller_reply_count:${replies}`, weight: 0.6 });
  return aggregate(entries, { base_confidence: 0.6 }) || unscored();
}

// Corroboration ONLY: precedence (latest-intent-precedence.js) is the sole
// authority on whether a re-engagement happened. Without a precedence-detected
// re-engagement this score is null — it can never create one.
function scoreReEngagementStrength(sig, precedence, mech) {
  if (precedence?.re_engagement_detected !== true) {
    return unscored(
      precedence == null ? "precedence_unavailable" : "no_precedence_re_engagement"
    );
  }
  const entries = [
    { kind: "precedence", detail: "re_engagement_detected", weight: 0.6 },
  ];
  if (
    ["seller_interested", "asks_offer", "asking_price_provided", "latent_interest"].some((i) =>
      sig.intents.has(i)
    )
  ) {
    entries.push({ kind: "intent", detail: "positive_intent_on_reengage", weight: 0.8 });
  }
  if (mech.question_count >= 1)
    entries.push({ kind: "mechanical", detail: `question_count:${mech.question_count}`, weight: 0.6 });
  return aggregate(entries, { base_confidence: 0.6 });
}

// ── Model assist (bounded enrichment) ───────────────────────────────────────

function applyModelAssist(scores, sig, suppression, modelAssistScorer) {
  if (typeof modelAssistScorer !== "function") return { scores, model_assist: null };

  const protected_context =
    Boolean(sig.compliance_flag) ||
    PROTECTED_CONTEXT_INTENTS.has(sig.primary) ||
    [...sig.intents].some((i) => PROTECTED_CONTEXT_INTENTS.has(i)) ||
    suppression?.active === true;

  if (protected_context) {
    return {
      scores,
      model_assist: {
        applied: false,
        ignored_reason: "protected_compliance_context",
        adjusted: [],
      },
    };
  }

  let proposals;
  try {
    proposals = modelAssistScorer({ scores });
  } catch (error) {
    return {
      scores,
      model_assist: {
        applied: false,
        ignored_reason: `model_assist_error:${error?.message || "unknown"}`,
        adjusted: [],
      },
    };
  }

  const adjusted = [];
  const next = { ...scores };
  for (const [dimension, proposal] of Object.entries(proposals || {})) {
    if (!BEHAVIOR_SCORE_DIMENSIONS.includes(dimension)) continue;
    if (PROTECTED_BEHAVIOR_DIMENSIONS.includes(dimension)) continue;
    const det = scores[dimension];
    const proposed_value = Number(proposal?.value);
    if (!det || det.value == null) continue; // null stays null — no invention
    if (!Number.isFinite(proposed_value)) continue;
    if (det.value < 0.3 || det.value > 0.7) continue; // only ambiguous mid-range
    if (Math.abs(proposed_value - det.value) > 0.15) continue;
    next[dimension] = {
      ...det,
      value: round3(clamp(proposed_value, -1, 1)),
      // Bounded BOTH directions: the documented contract is ≤ ±0.1 — a large
      // negative delta must not zero out deterministic confidence any more
      // than a large positive one may inflate it.
      confidence: round3(
        clamp(
          det.confidence +
            clamp(Number(proposal?.confidence_delta) || 0, -0.1, 0.1),
          0,
          1
        )
      ),
      evidence: [...det.evidence, { kind: "model_assist", detail: "mid_range_refinement" }],
    };
    adjusted.push(dimension);
  }
  return {
    scores: next,
    model_assist: { applied: adjusted.length > 0, ignored_reason: null, adjusted },
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {string} [input.raw_text] seller message text (used ONLY for the
 *   mechanical reply_effort measure and question counting)
 * @param {object} [input.classification] classify() result
 * @param {object} [input.extraction] extractSellerFacts() record
 * @param {object} [input.thread_stats] { seller_reply_count,
 *   conversation_depth, reply_latency_seconds }
 * @param {object} [input.precedence] latest-intent precedence decision
 * @param {object} [input.suppression] { active, reason }
 * @param {object} [opts]
 * @param {Function|null} [opts.modelAssistScorer] bounded enrichment seam —
 *   see module header. Default null; never called when absent.
 */
export function scoreConversationBehavior(
  {
    raw_text = "",
    classification = null,
    extraction = null,
    thread_stats = null,
    precedence = null,
    suppression = null,
  } = {},
  { modelAssistScorer = null } = {}
) {
  try {
    const sig = collectClassificationSignals(classification);
    const text = String(raw_text ?? "").trim();
    const mech = {
      has_text: text.length > 0,
      word_count: text ? text.split(/\s+/).filter(Boolean).length : 0,
      question_count: (text.match(/\?/g) || []).length,
    };

    const deterministic = {
      sentiment: scoreSentiment(sig),
      hostility: scoreHostility(sig),
      urgency: scoreUrgency(sig, extraction),
      confusion: scoreConfusion(sig),
      skepticism: scoreSkepticism(sig, extraction),
      trust_concern: scoreTrustConcern(sig, extraction),
      engagement: scoreEngagement(sig, thread_stats, mech),
      motivation: scoreMotivation(sig, extraction),
      sale_readiness: scoreSaleReadiness(sig),
      price_sensitivity: scorePriceSensitivity(sig),
      timing_sensitivity: scoreTimingSensitivity(sig, extraction),
      reply_effort: scoreReplyEffort(mech),
      conversational_momentum: scoreConversationalMomentum(thread_stats),
      re_engagement_strength: scoreReEngagementStrength(sig, precedence, mech),
    };

    const { scores, model_assist } = applyModelAssist(
      deterministic,
      sig,
      suppression,
      modelAssistScorer
    );

    return {
      version: CONVERSATION_BEHAVIOR_SCORING_VERSION,
      scorer: DETERMINISTIC_SCORER,
      scores,
      model_assist,
    };
  } catch (error) {
    // The scorer must never take the pipeline down: total failure degrades to
    // the exact pre-scoring behavior (all dimensions unscored).
    const scores = {};
    for (const dimension of BEHAVIOR_SCORE_DIMENSIONS) {
      scores[dimension] = unscored("scorer_unavailable");
    }
    return {
      version: CONVERSATION_BEHAVIOR_SCORING_VERSION,
      scorer: "unscored",
      scores,
      model_assist: null,
      error: error?.message || "unknown_scoring_error",
    };
  }
}

export default scoreConversationBehavior;
