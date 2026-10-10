// ─── llm-fallback-classifier.js ──────────────────────────────────────────────
// A SECOND OPINION for the replies the deterministic classifier cannot read.
// Owner P0 2026-10-10: "Classify every response correctly. Use Haiku 5.5 if
// needed."
//
// FLAG: INBOX_LLM_FALLBACK_MODE = off (default) | shadow | on
//   off     never called.
//   shadow  called, verdict recorded for evaluation only; the deterministic
//           result is returned unchanged.
//   on      a valid verdict at >= APPLY_MIN_CONFIDENCE replaces "unclear".
//           Fail closed: an error / timeout / refusal / invalid JSON / budget
//           stop / an LLM compliance suspicion -> Needs Review; a merely
//           low-confidence read keeps the deterministic lane (Unclear), except
//           an ambiguous deal signal -> Needs Review.
//
// WHEN: only when the deterministic result is unclear (or a blank intent) or
// its confidence is below LOW_CONFIDENCE. NEVER when the deterministic layer
// returned a compliance or legal verdict: STOP / wrong number / legal threat /
// compliance_flag stay deterministic and always win.
//
// WHAT IS SENT (PII minimized): the seller's message and our last outbound,
// with phone numbers, e-mails, street addresses and greeting names masked.
// Never a phone, never a name field, never property data.
//
// WHAT COMES BACK: { intent, confidence, rationale } validated against the
// canonical taxonomy. The model may NOT emit a compliance verdict: an LLM
// "opt_out" / "wrong_number" / "hostile_or_legal" is never applied -- it is a
// signal for a person (Needs Review, reason llm_suspects_<intent>).
//
// COST: claude-haiku-5-5, $0.10 / MTok in, $0.50 / MTok out, $0.01 cache read,
// $0.125 5-minute cache write (platform pricing page, 10-10; prompts under
// 100K tokens). A small separate cap, INBOX_LLM_DAILY_CAP_USD (default $2/day),
// enforced BEFORE the call from a worst-case reservation; exhausted -> no call,
// Needs Review. The frozen system prompt carries cache_control (prefix caching
// engages once the prompt is above the model's minimum cacheable length).
//
// Transport: raw fetch to the Messages API (no SDK dependency in this repo).

import { CANONICAL_INTENTS } from "@/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js";

export const LLM_FALLBACK_MODEL = "claude-haiku-5-5";
export const LLM_FALLBACK_VERSION = "llm_fallback_v1";
export const LOW_CONFIDENCE = 0.65;
// Measured 2026-10-10 (200 calls, $0.014): at 0.75 the fallback fixed 10 and
// broke 26 of 150 candidates on the 598-label set; at 0.9 it fixed 1, broke 2.
export const APPLY_MIN_CONFIDENCE = 0.9;
/** An ambiguous verdict worth a person: the model leans to a deal signal. */
const VALUABLE_INTENTS = new Set(["asking_price_provided", "asks_offer", "seller_interested", "contract_requested", "callback_requested", "voicemail_call_request", "latent_interest", "condition_disclosed"]);
export const DEFAULT_DAILY_CAP_USD = 2;
export const PRICE_PER_MTOK = Object.freeze({ input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 });
const MAX_TOKENS = 400;
const TIMEOUT_MS = 8000;

/** Deterministic verdicts the model can never override. */
export const COMPLIANCE_INTENTS = Object.freeze(["opt_out", "wrong_number", "hostile_or_legal"]);
/** The model's vocabulary: the canonical taxonomy (+ two legacy spellings the inbox reads). */
export const FALLBACK_TAXONOMY = Object.freeze([...new Set([...CANONICAL_INTENTS, "sold_property", "language_switch"])]);

function lower(v) {
  return String(v ?? "").trim().toLowerCase();
}

export function resolveFallbackMode(env = process.env) {
  const m = lower(env.INBOX_LLM_FALLBACK_MODE);
  return m === "on" || m === "shadow" ? m : "off";
}

/** Is the deterministic result one the fallback may look at? */
export function shouldUseLlmFallback(classification = {}) {
  const intent = lower(classification.primary_intent);
  if (COMPLIANCE_INTENTS.includes(intent)) return false;
  if (classification.compliance_flag) return false;
  if (classification.is_opt_out === true) return false;
  if (classification.automation_decision?.legal_hold === true) return false;
  if (!intent || intent === "unclear") return true;
  const conf = Number(classification.confidence);
  return Number.isFinite(conf) && conf < LOW_CONFIDENCE;
}

/** Mask what the model does not need. */
export function minimizePii(text) {
  let t = String(text ?? "");
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]");
  t = t.replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]");
  t = t.replace(/\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Pl|Place|Cir|Circle|Trl|Trail|Pkwy|Hwy|Ter|Terrace)\b\.?/gi, "[address]");
  t = t.replace(/\b(Hi|Hey|Hello|Hola|Buenos días|Buenas)\s+[A-ZÁÉÍÓÚÑ][\p{L}'-]+/gu, "$1 [name]");
  t = t.replace(/\b(this is|my name is|soy|me llamo)\s+[A-ZÁÉÍÓÚÑ][\p{L}'-]+/giu, "$1 [agent]");
  return t.slice(0, 1200);
}

const SYSTEM_PROMPT = [
  "You classify one SMS reply from a property owner to a real-estate investor's text.",
  "Return the single best intent from the allowed list, a confidence from 0 to 1, and a one-sentence rationale.",
  "Read the reply as an answer to OUR LAST MESSAGE when one is given (\"No\" to \"are you the owner?\" is a denial of ownership; \"No\" to \"would you sell?\" is not_interested).",
  "Key meanings:",
  "- ownership_confirmed: yes, they own it. seller_interested: open to selling. latent_interest: maybe later / only for the right price.",
  "- not_interested: does not want to sell (now or ever). need_time: not now, later.",
  "- asking_price_provided: states a price they would take. asking_price_implausible: an absurd joke price. asks_offer: asks what we would pay.",
  "- condition_disclosed / tenant_occupied: facts about the house or its occupants.",
  "- who_is_this / info_request: asks who we are or what this is about.",
  "- property_specific_non_owner: says they do not own THIS property. wrong_number: this phone is not the person we texted.",
  "- hostile_or_troll: insults, mockery, nonsense. hostile_or_legal: threatens legal action or a regulator.",
  "- opt_out: asks us to stop texting / remove them.",
  "- acknowledgement / reaction_only: thanks, ok, an emoji, with no new information.",
  "- unclear: genuinely cannot be read even with our last message.",
  "Use a confidence below 0.6 whenever two intents are plausible. Never invent facts.",
  "Keep the rationale to one short sentence (at most 20 words).",
  `Allowed intents: ${FALLBACK_TAXONOMY.join(", ")}.`,
].join("\n");

export const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    intent: { type: "string", enum: [...FALLBACK_TAXONOMY] },
    confidence: { type: "number" },
    rationale: { type: "string" },
  },
  required: ["intent", "confidence", "rationale"],
  additionalProperties: false,
});

export function buildFallbackRequest({ message = "", lastOutbound = "" } = {}) {
  const user = [
    lastOutbound ? `OUR LAST MESSAGE: ${minimizePii(lastOutbound)}` : "OUR LAST MESSAGE: (none on record)",
    `THEIR REPLY: ${minimizePii(message)}`,
  ].join("\n");
  return {
    model: LLM_FALLBACK_MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
  };
}

export function costOfUsage(usage = {}) {
  const u = (k) => Number(usage?.[k]) || 0;
  return (u("input_tokens") * PRICE_PER_MTOK.input
    + u("output_tokens") * PRICE_PER_MTOK.output
    + u("cache_read_input_tokens") * PRICE_PER_MTOK.cache_read
    + u("cache_creation_input_tokens") * PRICE_PER_MTOK.cache_write) / 1e6;
}

/** Worst case for one call: the request's input estimate (chars/3) + max output. */
export function worstCaseUsd(request) {
  const chars = JSON.stringify(request?.system ?? "").length + JSON.stringify(request?.messages ?? "").length;
  return ((chars / 3) * PRICE_PER_MTOK.input + MAX_TOKENS * PRICE_PER_MTOK.output) / 1e6;
}

/**
 * In-memory daily ledger. Production can pass a durable store with the same
 * shape ({ spentToday(), record(usd) }) -- e.g. the agent budget ledger.
 */
export function createDailyBudget({ capUsd = DEFAULT_DAILY_CAP_USD, now = () => Date.now() } = {}) {
  let day = null;
  let spent = 0;
  const roll = () => {
    const d = new Date(now()).toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      spent = 0;
    }
  };
  return {
    capUsd,
    spentToday() {
      roll();
      return spent;
    },
    canSpend(usd) {
      roll();
      return spent + usd <= capUsd;
    },
    record(usd) {
      roll();
      spent += usd;
    },
  };
}

/** Validate the model's JSON against the taxonomy. */
export function validateFallbackVerdict(raw) {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  }
  if (!v || typeof v !== "object") return { ok: false, reason: "not_an_object" };
  const intent = lower(v.intent);
  if (!FALLBACK_TAXONOMY.includes(intent)) return { ok: false, reason: "intent_not_in_taxonomy" };
  const confidence = Number(v.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { ok: false, reason: "bad_confidence" };
  const rationale = String(v.rationale ?? "").slice(0, 300);
  return { ok: true, intent, confidence, rationale };
}

/**
 * Merge: deterministic compliance always wins; an LLM compliance verdict is a
 * human signal; a confident valid verdict replaces unclear; else Needs Review.
 * @returns {{ intent:string, source:string, needs_review:boolean, reason:string, llm:object|null }}
 */
export function mergeFallbackVerdict(deterministic = {}, verdict = null, { minConfidence = APPLY_MIN_CONFIDENCE } = {}) {
  const det = lower(deterministic.primary_intent) || "unclear";
  if (!shouldUseLlmFallback(deterministic)) return { intent: det, source: "deterministic", needs_review: false, reason: "deterministic_authoritative", llm: null };
  if (!verdict?.ok) return { intent: det, source: "deterministic", needs_review: true, reason: `llm_${verdict?.reason || "unavailable"}`, llm: verdict || null };
  if (COMPLIANCE_INTENTS.includes(verdict.intent)) {
    return { intent: det, source: "deterministic", needs_review: true, reason: `llm_suspects_${verdict.intent}`, llm: verdict };
  }
  if (verdict.intent === "unclear" || verdict.confidence < minConfidence) {
    // Owner P0 2026-10-10: Needs Review is only for what a person must decide.
    // A low-confidence read stays in the deterministic (non-alerting) lane,
    // unless the model leans to a deal signal: ambiguous-but-valuable.
    const valuable = VALUABLE_INTENTS.has(verdict.intent) && verdict.confidence >= 0.6;
    return { intent: det, source: "deterministic", needs_review: valuable, reason: valuable ? "llm_ambiguous_but_valuable" : "llm_low_confidence", llm: verdict };
  }
  return { intent: verdict.intent, source: "llm_fallback", needs_review: false, reason: "llm_confident", llm: verdict };
}

/**
 * One fallback call. Never throws: every failure is a fail-closed verdict.
 * @param {object} args
 * @param {object} args.classification   deterministic classify() output
 * @param {string} args.message          the seller's text
 * @param {string} [args.lastOutbound]   our last outbound text
 * @param {object} [deps] { fetch, apiKey, budget, env, mode }
 */
export async function runLlmFallback({ classification = {}, message = "", lastOutbound = "" } = {}, deps = {}) {
  const env = deps.env || process.env;
  const mode = deps.mode || resolveFallbackMode(env);
  const base = { mode, model: LLM_FALLBACK_MODEL, version: LLM_FALLBACK_VERSION };
  if (mode === "off") return { ...base, called: false, merged: mergeFallbackVerdict(classification, { ok: false, reason: "mode_off" }), applied: false };
  if (!shouldUseLlmFallback(classification)) {
    return { ...base, called: false, merged: mergeFallbackVerdict(classification, null), applied: false };
  }
  const apiKey = deps.apiKey ?? env.ANTHROPIC_API_KEY;
  const budget = deps.budget || createDailyBudget({ capUsd: Number(env.INBOX_LLM_DAILY_CAP_USD) || DEFAULT_DAILY_CAP_USD });
  const request = buildFallbackRequest({ message, lastOutbound });
  const finish = (verdict, extra = {}) => {
    const merged = mergeFallbackVerdict(classification, verdict);
    return { ...base, ...extra, verdict, merged, applied: mode === "on" && merged.source === "llm_fallback" };
  };
  if (!apiKey) return finish({ ok: false, reason: "no_api_key" }, { called: false });
  const reserve = worstCaseUsd(request);
  if (!budget.canSpend(reserve)) return finish({ ok: false, reason: "budget_exhausted" }, { called: false });

  const doFetch = deps.fetch || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs || TIMEOUT_MS);
  try {
    const res = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(request),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => null);
    const usd = costOfUsage(body?.usage);
    budget.record(res.ok ? usd : 0);
    if (!res.ok) return finish({ ok: false, reason: `http_${res.status}` }, { called: true, usd: 0 });
    if (body?.stop_reason === "refusal") return finish({ ok: false, reason: "refusal" }, { called: true, usd, usage: body.usage });
    if (body?.stop_reason === "max_tokens") return finish({ ok: false, reason: "max_tokens" }, { called: true, usd, usage: body.usage });
    const text = (body?.content || []).filter((b) => b?.type === "text").map((b) => b.text).join("");
    return finish(validateFallbackVerdict(text), { called: true, usd, usage: body?.usage || null });
  } catch (e) {
    return finish({ ok: false, reason: e?.name === "AbortError" ? "timeout" : "transport_error" }, { called: true, usd: 0 });
  } finally {
    clearTimeout(timer);
  }
}

export default {
  LLM_FALLBACK_MODEL,
  resolveFallbackMode,
  shouldUseLlmFallback,
  minimizePii,
  buildFallbackRequest,
  validateFallbackVerdict,
  mergeFallbackVerdict,
  runLlmFallback,
  createDailyBudget,
  costOfUsage,
};
