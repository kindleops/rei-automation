// ─── decisionAuthority.js ───────────────────────────────────────────────────
// THE one answer to "what are this property's current economics?"
//
// BUSINESS SHAPE (clarified by the operator, 2026-09-12):
// `property_acquisition_scores` is the canonical current Decision Engine output
// table, and its low row count is INTENTIONAL. A row is created or refreshed
// when the engine is run — manually from Deal Intelligence, or programmatically
// when the acquisition flow reaches the point where economics are required
// (roughly S3/S4). 163 rows against 169,802 properties is the lifecycle working,
// not coverage missing.
//
// WHAT THAT MAKES ABSENCE MEAN
//   Absence is NOT "economics unavailable".
//   Absence is `decision_engine_not_run_for_current_state` — an instruction to
//   run the engine. Only a FAILED engine run makes economics a hold/review.
//
// WHY THIS MODULE EXISTS
// Before it, three separate things answered "do current economics exist?":
//   * the manual button, which always recomputed;
//   * the seller flow, which read `opportunity.metadata.ade_snapshot` — a COPY
//     taken at some past turn, so a property scored from the dashboard was
//     invisible to automation and vice versa;
//   * nothing at all checked whether the answer was still true, because
//     `property_acquisition_scores` records no input state. `ade_result ? NONE
//     : RUN_FULL` treated a snapshot of any age as current.
// So `score exists` and `score is current` were the same question, and neither
// was asked against the canonical table.
//
// THE INVARIANT
//   Economics come from `property_acquisition_scores` / its immutable upstream
//   snapshot, or they are recomputed. There is no legacy fallback: the
//   Podio-era `properties.cash_offer` family is never consulted here, at any
//   confidence, for any reason.
//
// FRESHNESS MECHANISM. `property_acquisition_scores` has `computed_at` and
// `created_at` and no input state whatsoever — there is nothing to compare a
// row against, so "is it current" was unanswerable. Rather than add columns,
// the fingerprint lives in the `evidence` jsonb the engine already writes, and
// THIS module owns both halves: it computes the fingerprint from the raw
// property row plus the seller's stated facts, hands it to the engine to record
// verbatim, and recomputes it the same way when checking. Both sides of every
// comparison are therefore produced by one extractor, so the check cannot drift
// from the stamp.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { scoreProperty as defaultScoreProperty } from './acquisitionDecisionEngine.js';
import {
  DECISION_STATUS,
  DEFAULT_MAX_AGE_DAYS,
  CURRENT_ENGINE_VERSION,
  MATERIAL_PROPERTY_FIELDS,
  MATERIAL_SELLER_FACT_FIELDS,
  extractDecisionInputs,
  decisionInputFingerprint,
  buildDecisionInputStamp,
  evaluateDecisionFreshness,
  ECONOMICS_DISPLAY_STATE,
  resolveEconomicsDisplayState,
} from './decisionFreshness.js';

// The pure freshness contract lives in decisionFreshness.js; re-exported here so
// every existing import of decisionAuthority.js keeps working unchanged.
export {
  DECISION_STATUS,
  DEFAULT_MAX_AGE_DAYS,
  CURRENT_ENGINE_VERSION,
  MATERIAL_PROPERTY_FIELDS,
  MATERIAL_SELLER_FACT_FIELDS,
  extractDecisionInputs,
  decisionInputFingerprint,
  buildDecisionInputStamp,
  evaluateDecisionFreshness,
  ECONOMICS_DISPLAY_STATE,
  resolveEconomicsDisplayState,
};

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clean(value) {
  return String(value ?? '').trim();
}

const FRESHNESS_PROPERTY_SELECT = ['property_id', ...MATERIAL_PROPERTY_FIELDS].join(', ');

async function loadScoreRow(supabase, propertyId) {
  const { data, error } = await supabase
    .from('property_acquisition_scores')
    .select('*')
    .eq('property_id', propertyId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function loadFreshnessPropertyRow(supabase, propertyId) {
  const { data, error } = await supabase
    .from('properties')
    .select(FRESHNESS_PROPERTY_SELECT)
    .eq('property_id', propertyId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * THE canonical entry point. Guarantee a current Decision Engine result for one
 * property, running the engine when there isn't one.
 *
 * The manual Deal Intelligence button and the automated acquisition flow both
 * come through here, so there is exactly one calculation authority and exactly
 * one definition of "current". `force` is what the button passes: an operator
 * asking for a rerun gets a rerun, but it is still the same engine writing the
 * same table with the same stamp.
 *
 * Never throws for an engine failure — a failure is a STATUS, because the
 * caller has to be able to tell "we could not compute this" apart from "we
 * computed this and it is bad". Never consults a legacy column in either case.
 *
 * @returns {{status, ran, decision, freshness, snapshot_id, error, stamp}}
 */
export async function ensurePropertyAcquisitionDecision(propertyId, options = {}) {
  const {
    sellerFacts = {},
    force = false,
    now = new Date(),
    maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    reason = null,
    deps = {},
  } = options;

  const id = clean(propertyId);
  if (!id) {
    return {
      status: DECISION_STATUS.ENGINE_FAILED,
      ran: false,
      decision: null,
      freshness: { status: DECISION_STATUS.ENGINE_FAILED, reason: 'property_id_required', age_days: null, changed_inputs: [], fingerprint: null },
      snapshot_id: null,
      error: 'property_id_required',
      stamp: null,
      requested_reason: reason,
    };
  }

  const supabase = deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
  const runEngine = deps.scoreProperty ?? defaultScoreProperty;

  let score = null;
  let propertyRow = null;
  let loadError = null;
  try {
    [score, propertyRow] = await Promise.all([
      deps.loadScoreRow ? deps.loadScoreRow(id) : loadScoreRow(supabase, id),
      deps.loadFreshnessPropertyRow ? deps.loadFreshnessPropertyRow(id) : loadFreshnessPropertyRow(supabase, id),
    ]);
  } catch (error) {
    loadError = error;
  }

  if (loadError && !force) {
    // Without the current state we can neither prove reuse nor build an honest
    // stamp, and running the engine on every read blip would be a stampede.
    return {
      status: DECISION_STATUS.ENGINE_FAILED,
      ran: false,
      decision: null,
      freshness: { status: DECISION_STATUS.ENGINE_FAILED, reason: 'decision_state_load_failed', age_days: null, changed_inputs: [], fingerprint: null },
      snapshot_id: null,
      error: loadError?.message || 'decision_state_load_failed',
      error_kind: 'state_load_threw',
      error_cause: loadError,
      stamp: null,
      requested_reason: reason,
    };
  }

  // A forced run is going to recompute regardless, so a failed freshness read
  // must not stop it. The stamp is simply absent, which later reads as "not
  // provably current" -- honest, and self-correcting on the next successful run.
  const stamp = loadError ? null : buildDecisionInputStamp(propertyRow || {}, sellerFacts, now);
  const freshness = loadError
    ? { status: DECISION_STATUS.STALE, reason: 'decision_state_load_failed', age_days: null, changed_inputs: [], fingerprint: null }
    : evaluateDecisionFreshness({ score, stamp, now, maxAgeDays });

  if (!force && freshness.status === DECISION_STATUS.CURRENT) {
    return {
      status: DECISION_STATUS.CURRENT,
      ran: false,
      decision: score,
      freshness,
      snapshot_id: score?.evidence?.immutable_snapshot_id ?? null,
      error: null,
      stamp,
      requested_reason: reason,
    };
  }

  let result = null;
  // An engine that REPORTS a failure and an engine that THROWS are different
  // events. The first is a decision outcome; the second is an infrastructure
  // fault whose original error still has to reach the logs and the caller's
  // status code. Collapsing them would turn a broken query into a quiet 400.
  let thrown = null;
  try {
    result = await runEngine(id, { ...deps, supabase, decisionInputStamp: stamp, now });
  } catch (engineError) {
    thrown = engineError;
    result = { ok: false, error: engineError?.message || 'engine_threw' };
  }

  if (!result?.ok) {
    // The previous decision is returned alongside the failure so a caller can
    // say "we could not refresh this" without losing the last known answer —
    // but the STATUS is the failure, and no caller may spend a stale number by
    // mistaking it for a current one.
    return {
      status: DECISION_STATUS.ENGINE_FAILED,
      ran: true,
      decision: score,
      freshness,
      snapshot_id: null,
      error: result?.error || 'decision_engine_failed',
      error_kind: thrown ? 'engine_threw' : 'engine_reported',
      error_cause: thrown,
      stamp,
      requested_reason: reason,
    };
  }

  return {
    status: DECISION_STATUS.RECOMPUTED,
    ran: true,
    decision: result.score || null,
    freshness: { ...freshness, recomputed_because: freshness.reason },
    snapshot_id: result.immutable_snapshot_id ?? result.snapshot_id ?? null,
    error: null,
    stamp,
    requested_reason: reason,
  };
}


export default {
  DECISION_STATUS,
  ECONOMICS_DISPLAY_STATE,
  CURRENT_ENGINE_VERSION,
  DEFAULT_MAX_AGE_DAYS,
  MATERIAL_PROPERTY_FIELDS,
  MATERIAL_SELLER_FACT_FIELDS,
  extractDecisionInputs,
  decisionInputFingerprint,
  buildDecisionInputStamp,
  evaluateDecisionFreshness,
  ensurePropertyAcquisitionDecision,
  resolveEconomicsDisplayState,
};
