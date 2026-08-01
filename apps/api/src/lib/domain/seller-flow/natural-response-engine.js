// Natural response engine (natural_response_engine_v1)
//
// Policy-constrained wording layer behind the deterministic reply-policy
// interface. The deterministic layers (applyInboundAutomationDecision +
// ontology reply policy + safe-template select/render) decide WHETHER to
// reply, to WHOM, and with what OBJECTIVE; this module only proposes the
// WORDING. Every generated candidate must survive the deterministic policy
// validator below, and any failure — model error, timeout, invalid schema,
// low confidence, policy violation, excessive length, language mismatch —
// falls back to the already-rendered safe-template text. The engine can
// therefore never widen what automation is allowed to say, only phrase it.
//
// Suppression is checked first and absolutely: after an opt-out or
// wrong-number suppression there is no reply at all, generated or otherwise.

export const NATURAL_RESPONSE_ENGINE_VERSION = "natural_response_engine_v1";

const DEFAULT_MAX_SMS_LENGTH = 320;
const DEFAULT_TIMEOUT_MS = 3500;
const MIN_MODEL_CONFIDENCE = 0.6;
const MIN_LANGUAGE_CONFIDENCE = 0.8;

// Suppression reasons after which no reply may ever be generated. Kept as an
// explicit allow-nothing list so a new binding reason fails closed by default
// via the generic `active` check in generateConstrainedReply.
const HARD_NO_REPLY_SUPPRESSION_REASONS = new Set([
  "opt_out",
  "stop",
  "wrong_number",
  "compliance_stop",
  "seller_initiated_after_stop",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// Digit sequences that read as prices, timelines, percentages, or offer
// amounts. Bare years inside allowed facts are matched exactly, so anything
// numeric the model emits must be traceable to an allowed fact or to text the
// seller/system already exchanged.
const NUMERIC_CLAIM_RE = /\$?\d[\d,]*(?:\.\d+)?\s*(?:k|K|mil|million|%|percent|days?|weeks?|months?|years?|hours?)?/g;

function extractNumericTokens(text) {
  const tokens = new Set();
  for (const match of clean(text).matchAll(NUMERIC_CLAIM_RE)) {
    const normalized = lower(match[0]).replace(/[\s,$]/g, "");
    if (/\d/.test(normalized)) tokens.add(normalized);
  }
  return tokens;
}

function collectPermittedNumericTokens({ allowedFacts, conversationHistory, deterministicText }) {
  const permitted = new Set();
  const ingest = (text) => {
    for (const token of extractNumericTokens(text)) permitted.add(token);
  };
  for (const value of Object.values(allowedFacts || {})) ingest(String(value ?? ""));
  for (const turn of asArray(conversationHistory)) ingest(turn?.text || turn?.body || "");
  ingest(deterministicText);
  return permitted;
}

// Heuristic language check: a Spanish reply should contain Spanish signal
// words; an English reply should not be dominated by them. This is a guard
// against the model answering an English thread in another language (or vice
// versa), not a full language identifier.
const SPANISH_SIGNAL_RE = /\b(?:hola|gracias|usted|casa|propiedad|precio|vender|venta|somos|estamos|puede|cuando|cuanto|dueñ[oa]|señor|si\s+le|le\s+interesa|día)\b/i;

function violatesLanguagePolicy({ text, language, languageConfidence }) {
  const wantsNonEnglish = lower(language) && lower(language) !== "english";
  if (wantsNonEnglish && Number(languageConfidence) < MIN_LANGUAGE_CONFIDENCE) {
    // Not confident enough in the thread language: only English is allowed.
    return SPANISH_SIGNAL_RE.test(text) ? "language_confidence_insufficient" : null;
  }
  if (wantsNonEnglish && lower(language) === "spanish" && !SPANISH_SIGNAL_RE.test(text)) {
    return "language_mismatch";
  }
  if (!wantsNonEnglish && SPANISH_SIGNAL_RE.test(text)) {
    return "language_mismatch";
  }
  return null;
}

function validateModelOutputSchema(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return "invalid_schema";
  }
  if (!clean(output.response_text)) return "invalid_schema";
  if (output.facts_used != null && !Array.isArray(output.facts_used)) return "invalid_schema";
  if (output.questions_answered != null && !Array.isArray(output.questions_answered)) {
    return "invalid_schema";
  }
  if (output.confidence != null && typeof output.confidence !== "number") {
    return "invalid_schema";
  }
  return null;
}

// Deterministic post-generation policy validation. Returns the first
// violation reason or null. Order is stable so audits are comparable.
export function validateGeneratedReply({
  candidate = null,
  allowedFacts = {},
  prohibitedClaims = [],
  unansweredSellerQuestions = [],
  conversationHistory = [],
  deterministicText = "",
  language = "English",
  languageConfidence = 0,
  maxLength = DEFAULT_MAX_SMS_LENGTH,
  reEngagement = false,
} = {}) {
  const schema_violation = validateModelOutputSchema(candidate);
  if (schema_violation) return schema_violation;

  const text = clean(candidate.response_text);

  if (text.length > maxLength) return "excessive_length";

  if (candidate.confidence != null && Number(candidate.confidence) < MIN_MODEL_CONFIDENCE) {
    return "low_confidence";
  }

  // Never invent prices, timelines, percentages, or offer amounts: every
  // numeric token must already exist in an allowed fact, the conversation
  // history, or the deterministic template text.
  const permitted = collectPermittedNumericTokens({
    allowedFacts,
    conversationHistory,
    deterministicText,
  });
  for (const token of extractNumericTokens(text)) {
    if (!permitted.has(token)) return "invented_numeric_claim";
  }

  for (const claim of asArray(prohibitedClaims)) {
    const needle = lower(claim);
    if (needle && lower(text).includes(needle)) return "prohibited_claim";
  }

  // Facts and answered questions must be subsets of what policy approved —
  // a model claiming to have used an unapproved fact is a policy violation
  // even if the text scan missed it.
  const allowed_fact_keys = new Set(Object.keys(allowedFacts || {}).map(lower));
  for (const fact of asArray(candidate.facts_used)) {
    if (!allowed_fact_keys.has(lower(fact))) return "unapproved_fact_used";
  }
  const open_questions = new Set(asArray(unansweredSellerQuestions).map(lower));
  for (const answered of asArray(candidate.questions_answered)) {
    if (!open_questions.has(lower(answered))) return "unapproved_question_answered";
  }

  const language_violation = violatesLanguagePolicy({ text, language, languageConfidence });
  if (language_violation) return language_violation;

  // Re-engagement must continue the conversation, not restart it: reusing the
  // original outbound opener verbatim is a mechanical restart.
  if (reEngagement) {
    const first_outbound = asArray(conversationHistory).find(
      (turn) => lower(turn?.direction) === "outbound"
    );
    if (first_outbound && lower(text) === lower(first_outbound.text || first_outbound.body || "")) {
      return "mechanical_restart";
    }
  }

  return null;
}

// Optional env-gated live model adapter. Both supported providers speak the
// OpenAI-compatible chat completions dialect already present in the AI router
// priority list. No key configured ⇒ null ⇒ the engine falls back
// deterministically, which is the required production-safe default.
export function buildModelCallFromEnv({ env = process.env, fetchImpl = fetch } = {}) {
  const groqKey = clean(env.GROQ_API_KEY);
  const openrouterKey = clean(env.OPENROUTER_API_KEY);
  const provider = groqKey ? "groq" : openrouterKey ? "openrouter" : null;
  if (!provider) return null;

  const base_url =
    provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://openrouter.ai/api/v1/chat/completions";
  const api_key = provider === "groq" ? groqKey : openrouterKey;
  const model =
    clean(env.NATURAL_REPLY_MODEL) ||
    (provider === "groq" ? "llama-3.3-70b-versatile" : "meta-llama/llama-3.3-70b-instruct");

  return async function modelCall({ system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base_url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${api_key}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!response.ok) throw new Error(`model_http_${response.status}`);
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      return { output: JSON.parse(String(content ?? "")), provider, model };
    } finally {
      clearTimeout(timer);
    }
  };
}

function buildGenerationPrompt({
  objective,
  allowedFacts,
  prohibitedClaims,
  unansweredSellerQuestions,
  nextQuestion,
  conversationHistory,
  stage,
  status,
  temperature,
  sellerTone,
  language,
  maxLength,
}) {
  const history = asArray(conversationHistory)
    .slice(-12)
    .map((turn) => `${lower(turn?.direction) === "inbound" ? "SELLER" : "US"}: ${clean(turn?.text || turn?.body)}`)
    .join("\n");
  const facts = Object.entries(allowedFacts || {})
    .map(([key, value]) => `- ${key}: ${clean(String(value))}`)
    .join("\n");
  return [
    `Objective: ${clean(objective)}`,
    `Stage: ${clean(stage) || "unknown"} | Status: ${clean(status) || "unknown"} | Temperature: ${clean(temperature) || "unknown"}`,
    `Seller tone: ${clean(sellerTone) || "neutral"} | Reply language: ${clean(language) || "English"}`,
    `Allowed facts (the ONLY facts you may state):\n${facts || "- none"}`,
    `Prohibited claims: ${asArray(prohibitedClaims).join("; ") || "none listed"}`,
    `Unanswered seller questions you must answer directly: ${asArray(unansweredSellerQuestions).join("; ") || "none"}`,
    `Next question to ask (exactly one, if natural): ${clean(nextQuestion) || "none"}`,
    `Conversation so far:\n${history || "(none)"}`,
    `Hard rules: never invent facts, prices, authority, timelines, or offers; answer the seller's open questions first; do not repeat questions the seller already answered; if this is a re-engagement, continue the conversation naturally instead of restarting it; stay under ${maxLength} characters; plain human SMS, no signatures, no legalese.`,
    `Respond with JSON: {"response_text": string, "facts_used": string[], "questions_answered": string[], "next_question": string|null, "confidence": number}`,
  ].join("\n\n");
}

function fallbackResult({ deterministicText, reason, model = null, audit }) {
  const text = clean(deterministicText);
  return {
    ok: Boolean(text),
    response_text: text || null,
    source: "deterministic_fallback",
    facts_used: [],
    questions_answered: [],
    next_question: null,
    confidence: null,
    model,
    engine_version: NATURAL_RESPONSE_ENGINE_VERSION,
    fallback_reason: reason,
    audit: { ...audit, fallback_reason: reason },
  };
}

// Entry point. `modelCall` is injectable so tests and future providers plug in
// without touching policy; absent a model the deterministic template text is
// returned unchanged (source: deterministic_fallback, reason:
// no_model_configured) — automation behavior is byte-identical to today.
export async function generateConstrainedReply({
  objective = "",
  deterministicText = "",
  allowedFacts = {},
  prohibitedClaims = [],
  unansweredSellerQuestions = [],
  nextQuestion = null,
  conversationHistory = [],
  stage = null,
  status = null,
  temperature = null,
  sellerTone = null,
  language = "English",
  languageConfidence = 0,
  maxLength = DEFAULT_MAX_SMS_LENGTH,
  reEngagement = false,
  suppression = null,
  modelCall = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const audit = {
    engine_version: NATURAL_RESPONSE_ENGINE_VERSION,
    objective: clean(objective) || null,
    language: clean(language) || "English",
    language_confidence: Number(languageConfidence) || 0,
    max_length: maxLength,
    re_engagement: Boolean(reEngagement),
    suppression_reason: suppression?.reason ? lower(suppression.reason) : null,
  };

  // Absolute gate: any active suppression means no reply of any kind. Binding
  // reasons are named for the audit trail; unknown active reasons fail closed
  // the same way.
  if (suppression?.active) {
    const reason = lower(suppression.reason) || "unknown_suppression";
    return {
      ok: false,
      response_text: null,
      source: "suppressed_no_reply",
      facts_used: [],
      questions_answered: [],
      next_question: null,
      confidence: null,
      model: null,
      engine_version: NATURAL_RESPONSE_ENGINE_VERSION,
      fallback_reason: HARD_NO_REPLY_SUPPRESSION_REASONS.has(reason)
        ? `suppressed_${reason}`
        : "suppressed_unknown_reason",
      audit,
    };
  }

  if (typeof modelCall !== "function") {
    return fallbackResult({ deterministicText, reason: "no_model_configured", audit });
  }

  const prompt = buildGenerationPrompt({
    objective,
    allowedFacts,
    prohibitedClaims,
    unansweredSellerQuestions,
    nextQuestion,
    conversationHistory,
    stage,
    status,
    temperature,
    sellerTone,
    language,
    maxLength,
  });
  const system =
    "You write one SMS reply for a real-estate acquisition conversation. You must obey every hard rule in the user message. Output only the requested JSON.";

  let call_result;
  try {
    call_result = await Promise.race([
      modelCall({ system, prompt, timeoutMs }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("model_timeout")), timeoutMs)
      ),
    ]);
  } catch (error) {
    const reason = String(error?.message || "") === "model_timeout" ? "model_timeout" : "model_error";
    return fallbackResult({ deterministicText, reason, audit });
  }

  const candidate = call_result?.output ?? null;
  const model = {
    provider: clean(call_result?.provider) || "injected",
    model: clean(call_result?.model) || null,
    version: NATURAL_RESPONSE_ENGINE_VERSION,
  };

  const violation = validateGeneratedReply({
    candidate,
    allowedFacts,
    prohibitedClaims,
    unansweredSellerQuestions,
    conversationHistory,
    deterministicText,
    language,
    languageConfidence,
    maxLength,
    reEngagement,
  });
  if (violation) {
    return fallbackResult({ deterministicText, reason: violation, model, audit });
  }

  return {
    ok: true,
    response_text: clean(candidate.response_text),
    source: "generated",
    facts_used: asArray(candidate.facts_used).map(clean),
    questions_answered: asArray(candidate.questions_answered).map(clean),
    next_question: clean(candidate.next_question) || null,
    confidence: Number(candidate.confidence ?? 0),
    model,
    engine_version: NATURAL_RESPONSE_ENGINE_VERSION,
    fallback_reason: null,
    audit,
  };
}
