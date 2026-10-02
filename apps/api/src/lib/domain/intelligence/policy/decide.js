/**
 * IC8 POLICY ENGINE (architecture §9). Guardrails first; observe/shadow only.
 *
 * decide({ decisionType, context, candidates, mode }, deps) runs:
 *   1. deterministic guardrails -- injected ADAPTERS that call the existing
 *      production authorities (suppression/DNC/opt-out, relationship-scoped
 *      wrong person, contact window with blank zone = BLOCK, sender health,
 *      provider eligibility, caps, template governance, stage authority, offer
 *      authority). Nothing is re-implemented here and no production module is
 *      imported. A missing, throwing, slow or malformed adapter BLOCKS
 *      (fail closed). A blocked candidate never reaches a model.
 *   2. scorer -- shadow mode only: the champion if it loads (decision status,
 *      verifiable feature set, no prohibited column), its features are fresh,
 *      the input is in distribution and confidence clears the bar; otherwise
 *      the deterministic default with a FALLBACK_* reason code.
 *   3. choice -- exploration share is 0 in this phase.
 *   4. output -- { allowed, ranked, chosen, confidence, reasonCodes, fallback }.
 * There is no act path: the result is never executed (executed: false), and
 * assist/act modes are refused.
 */

import { DECISION_STATUSES, modelFairnessProfile } from "../registry/model-registry.js";
import { DECISION_TYPES } from "../journal/decision-journal.js";
import { isRegisteredReasonCode } from "../journal/reason-codes.js";
import { settleWithin } from "../util/async.js";

export const POLICY_ENGINE_VERSION = "ic8_policy_engine@1";
export const POLICY_MODES = Object.freeze(["observe", "shadow"]);
export const EXPLORATION_SHARE = 0;
export const GUARDRAIL_IDS = Object.freeze([
  "suppression",
  "wrong_person",
  "contact_window",
  "sender_health",
  "provider_eligibility",
  "caps",
  "template_governance",
  "stage_authority",
  "offer_authority",
]);

const OUTBOUND = Object.freeze(["suppression", "wrong_person", "contact_window", "sender_health", "provider_eligibility", "caps", "template_governance"]);
/** Which authorities must answer before a candidate of each decision type is allowed. */
export const REQUIRED_GUARDRAILS = Object.freeze({
  seller_turn: GUARDRAIL_IDS,
  message_strategy: GUARDRAIL_IDS,
  follow_up_timing: OUTBOUND,
  fact_acceptance: Object.freeze(["stage_authority"]),
  campaign_feed: OUTBOUND,
  campaign_selection: OUTBOUND,
  campaign_scale: Object.freeze(["contact_window", "sender_health", "provider_eligibility", "caps"]),
  campaign_pause: Object.freeze([]),
  comp_selection: Object.freeze([]),
  valuation: Object.freeze(["offer_authority"]),
  human_handoff: Object.freeze([]),
});

export const DEFAULT_POLICY_OPTIONS = Object.freeze({ minConfidence: 0.5, guardrailTimeoutMs: 2000, scorerTimeoutMs: 2000 });
const ACTION_RE = /^[a-z0-9][a-z0-9_:.-]{0,79}$/i;

function refused(code, extra = {}) {
  return { ok: false, code, reasonCodes: [code], chosen: null, executed: false, ...extra };
}

/** Throws unless a model version may be loaded by a scorer (decision status, verifiable features). */
export function assertScorerLoadable(modelVersion, { featureRegistry } = {}) {
  const verdict = scorerEligibility(modelVersion, { featureRegistry });
  if (!verdict.ok) {
    const error = new Error(`scorer refuses model ${modelVersion?.model_version_id}: ${verdict.code}`);
    error.code = verdict.code;
    error.details = verdict;
    throw error;
  }
  return true;
}

function scorerEligibility(modelVersion, { featureRegistry }) {
  if (!modelVersion || !modelVersion.model_version_id) return { ok: false, code: "FALLBACK_MODEL_UNAVAILABLE" };
  if (!DECISION_STATUSES.includes(modelVersion.status)) return { ok: false, code: "FALLBACK_MODEL_UNAVAILABLE", status: modelVersion.status };
  const profile = modelFairnessProfile(modelVersion, featureRegistry);
  if (!profile.resolved || profile.prohibitedColumns.length) return { ok: false, code: "FALLBACK_MODEL_INELIGIBLE", profile };
  return { ok: true };
}

async function evaluateGuardrails({ decisionType, context, candidates, adapters, timeoutMs }) {
  const required = REQUIRED_GUARDRAILS[decisionType] || GUARDRAIL_IDS;
  const summary = {};
  for (const id of required) summary[id] = { evaluated: 0, blocked: 0, errors: 0, missing: !adapters || typeof adapters[id]?.check !== "function" };
  const results = [];
  for (const candidate of candidates) {
    const blockedBy = [];
    for (const id of required) {
      const adapter = adapters ? adapters[id] : null;
      if (!adapter || typeof adapter.check !== "function") {
        blockedBy.push("GUARDRAIL_ADAPTER_MISSING");
        continue;
      }
      if (typeof adapter.appliesTo === "function") {
        let applies = true;
        try {
          applies = adapter.appliesTo(candidate, context) !== false;
        } catch {
          applies = true;
        }
        if (!applies) continue;
      }
      summary[id].evaluated += 1;
      const outcome = await settleWithin(() => adapter.check({ decisionType, context, candidate }), timeoutMs);
      if (outcome.timedOut) {
        summary[id].errors += 1;
        blockedBy.push("GUARDRAIL_ADAPTER_TIMEOUT");
      } else if (outcome.error) {
        summary[id].errors += 1;
        blockedBy.push("GUARDRAIL_ADAPTER_ERROR");
      } else {
        const verdict = outcome.value;
        if (!verdict || typeof verdict.allow !== "boolean") {
          summary[id].errors += 1;
          blockedBy.push("GUARDRAIL_ADAPTER_MALFORMED");
        } else if (!verdict.allow) {
          summary[id].blocked += 1;
          const code = String(verdict.code || "");
          blockedBy.push(code.startsWith("GUARDRAIL_") && isRegisteredReasonCode(code) ? code : "GUARDRAIL_ADAPTER_MALFORMED");
        }
      }
    }
    results.push({ candidate, blockedBy: [...new Set(blockedBy)] });
  }
  return { results, summary };
}

/**
 * @param request { decisionType, context, candidates: [{ action, production_choice? }], mode }
 * @param deps    { guardrails: {[id]: {check, appliesTo?}}, scorer: { modelVersion, score(input) },
 *                  deterministicDefault({decisionType, context, allowed, candidates}) -> action|null,
 *                  featureRegistry, minConfidence, guardrailTimeoutMs, scorerTimeoutMs }
 */
export async function decide({ decisionType, context = {}, candidates = [], mode = "observe" } = {}, deps = {}) {
  const opts = { ...DEFAULT_POLICY_OPTIONS, ...deps };
  if (!POLICY_MODES.includes(mode)) return refused("POLICY_MODE_NOT_PERMITTED", { mode });
  if (!DECISION_TYPES[decisionType] || DECISION_TYPES[decisionType].reserved) return refused("POLICY_INVALID_REQUEST", { detail: "decision_type" });
  if (!Array.isArray(candidates) || !candidates.length || candidates.some((c) => !c || !ACTION_RE.test(String(c.action ?? "")))) {
    return refused("POLICY_INVALID_REQUEST", { detail: "candidates" });
  }
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.action)) return refused("POLICY_INVALID_REQUEST", { detail: "duplicate_candidate" });
    seen.add(c.action);
  }

  const reasonCodes = [mode === "shadow" ? "MODE_SHADOW" : "MODE_OBSERVE"];
  const { results, summary } = await evaluateGuardrails({
    decisionType,
    context,
    candidates,
    adapters: deps.guardrails,
    timeoutMs: opts.guardrailTimeoutMs,
  });
  const allowed = results.filter((r) => r.blockedBy.length === 0).map((r) => r.candidate);
  const blocked = results.filter((r) => r.blockedBy.length > 0).map((r) => ({ action: r.candidate.action, blocked_by: r.blockedBy }));
  for (const b of blocked) for (const code of b.blocked_by) if (!reasonCodes.includes(code)) reasonCodes.push(code);

  let productionChoice = null;
  try {
    productionChoice =
      typeof deps.deterministicDefault === "function"
        ? (deps.deterministicDefault({ decisionType, context, allowed: allowed.map((c) => c.action), candidates: candidates.map((c) => c.action) }) ?? null)
        : (candidates.find((c) => c.production_choice === true)?.action ?? null);
  } catch {
    productionChoice = null;
  }
  if (productionChoice && blocked.some((b) => b.action === productionChoice)) reasonCodes.push("GUARDRAIL_DISAGREES_WITH_PRODUCTION");
  const defaultChoice = productionChoice && allowed.some((c) => c.action === productionChoice) ? productionChoice : null;

  let fallbackCode = null;
  let ranked = [];
  let chosen = null;
  let confidence = null;
  let modelVersionId = null;
  if (!allowed.length) {
    fallbackCode = "FALLBACK_NO_ALLOWED_CANDIDATES";
  } else if (mode === "observe") {
    fallbackCode = "FALLBACK_OBSERVE_MODE";
  } else if (!deps.scorer || typeof deps.scorer.score !== "function") {
    fallbackCode = "FALLBACK_NO_CHAMPION";
  } else {
    const loadable = scorerEligibility(deps.scorer.modelVersion, { featureRegistry: deps.featureRegistry });
    if (!loadable.ok) {
      fallbackCode = loadable.code;
    } else {
      modelVersionId = deps.scorer.modelVersion.model_version_id;
      const outcome = await settleWithin(() => deps.scorer.score({ decisionType, context, candidates: allowed }), opts.scorerTimeoutMs);
      const result = outcome.value;
      if (outcome.timedOut) fallbackCode = "FALLBACK_SCORER_TIMEOUT";
      else if (outcome.error || !result || typeof result !== "object") fallbackCode = "FALLBACK_SCORER_ERROR";
      else if (result.fresh === false) fallbackCode = "FALLBACK_STALE_FEATURES";
      else if (result.inDistribution === false) fallbackCode = "FALLBACK_OUT_OF_DISTRIBUTION";
      else if (!allowed.every((c) => Number.isFinite(result.scores?.[c.action]))) fallbackCode = "FALLBACK_FEATURES_MISSING";
      else if (!(Number(result.confidence) >= opts.minConfidence)) fallbackCode = "FALLBACK_LOW_CONFIDENCE";
      else {
        ranked = allowed
          .map((c, index) => ({ action: c.action, score: result.scores[c.action], index }))
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .map(({ action, score }) => ({ action, score }));
        chosen = ranked[0].action;
        confidence = Number(result.confidence);
        reasonCodes.push("CHOICE_MODEL_RANKED");
        if (EXPLORATION_SHARE === 0) reasonCodes.push("CHOICE_EXPLORATION_DISABLED");
      }
    }
  }
  if (fallbackCode) {
    reasonCodes.push(fallbackCode);
    chosen = defaultChoice;
    reasonCodes.push(chosen ? "CHOICE_DETERMINISTIC_DEFAULT" : "CHOICE_NONE");
  }
  const scoreOf = new Map(ranked.map((r) => [r.action, r.score]));
  return {
    ok: true,
    policyVersion: POLICY_ENGINE_VERSION,
    decisionType,
    mode,
    allowed: allowed.map((c) => c.action),
    blocked,
    ranked,
    chosen,
    confidence,
    reasonCodes,
    fallback: { used: Boolean(fallbackCode), code: fallbackCode },
    productionChoice,
    modelVersionId,
    guardrails: summary,
    candidates: results.map((r) => ({ action: r.candidate.action, allowed: r.blockedBy.length === 0, blocked_by: r.blockedBy, score: scoreOf.has(r.candidate.action) ? scoreOf.get(r.candidate.action) : null })),
    executed: false,
  };
}

/** A decision-journal entry for a decide() result (shadow rows point at the production decision). */
export function toJournalEntry(result, { idempotencyKey, decidedAt, context = {}, championDecisionId = null, featureSnapshotId = null, featureSetId = null }) {
  const guardrails = {};
  for (const [id, s] of Object.entries(result.guardrails || {})) {
    guardrails[id] = { verdict: s.missing ? "error" : s.errors ? "error" : s.blocked ? "block" : s.evaluated ? "allow" : "skipped", code: s.missing ? "GUARDRAIL_ADAPTER_MISSING" : null };
  }
  return {
    decision_type: result.decisionType,
    idempotency_key: idempotencyKey,
    decided_at: decidedAt,
    mode: result.mode,
    context,
    feature_snapshot_id: featureSnapshotId,
    feature_set_id: featureSetId,
    model_version_id: result.modelVersionId,
    policy_version: result.policyVersion,
    candidates: result.candidates,
    chosen_action: result.chosen,
    confidence: result.confidence,
    guardrails,
    reason_codes: result.reasonCodes,
    champion_decision_id: championDecisionId,
  };
}
