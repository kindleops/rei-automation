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

import { createHash } from 'node:crypto';

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { scoreProperty as defaultScoreProperty } from './acquisitionDecisionEngine.js';

export const DECISION_STATUS = Object.freeze({
  /** A row exists and its inputs still match the world. Reuse it. */
  CURRENT: 'current',
  /** No row. The engine has not run for this property. Run it. */
  NOT_RUN: 'decision_engine_not_run_for_current_state',
  /** A row exists but a material input moved under it. Rerun. */
  STALE: 'decision_engine_stale_for_current_state',
  /** The engine ran and failed. THIS is what makes economics a hold. */
  ENGINE_FAILED: 'decision_engine_failed',
  /** A run happened in this call and produced a fresh row. */
  RECOMPUTED: 'recomputed',
});

/** Default recompute horizon. Comps and buyer behaviour move underneath a
 *  decision even when the subject does not. */
export const DEFAULT_MAX_AGE_DAYS = 30;

/** The engine version whose output counts as current. */
export const CURRENT_ENGINE_VERSION = '2.0.0';

/**
 * Material inputs. Changing any of these can change the number, so any of them
 * changing makes the persisted decision stale.
 *
 * Deliberately NOT included: `cash_offer`, `final_acquisition_score`,
 * `tag_distress_score`, `deal_strength_score`, `structured_motivation_score`,
 * `ai_score`, and the `offer_pp*` family. Those are Podio-era OUTPUT columns,
 * never inputs to this engine, and a change in one must not trigger — or
 * suppress — a recompute.
 */
export const MATERIAL_PROPERTY_FIELDS = Object.freeze([
  // Valuation anchors
  'estimated_value',
  'assd_total_value',
  'market_status_value',
  // Physical identity (drives comp selection and the size gates)
  'property_type',
  'property_class',
  'normalized_asset_class',
  'asset_class',
  'units_count',
  'building_square_feet',
  'total_bedrooms',
  'total_baths',
  'year_built',
  'lot_square_feet',
  // Condition / repairs. `properties` has no `condition` column -- the engine
  // reads condition through `rehab_level` -- and no `listing_price`; naming
  // either here would fail the whole PostgREST select, not just that field.
  'rehab_level',
  // Debt
  'total_loan_amt',
  'total_loan_payment',
  'active_lien',
  'tax_delinquent',
  // Location (drives the comp radius)
  'property_address_zip',
  'latitude',
  'longitude',
]);

/**
 * Seller-stated facts that are engine inputs. These arrive from the
 * conversation, not the property record, and they are exactly the facts that
 * make an S3/S4 rerun necessary.
 */
export const MATERIAL_SELLER_FACT_FIELDS = Object.freeze([
  'asking_price',
  'property_condition',
  'occupancy_status',
  'monthly_gross_rent',
  'reported_unit_rents',
  'mortgage_payoff',
  'units_count',
]);

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clean(value) {
  return String(value ?? '').trim();
}

/** Scalar-ise a fact that may be a bare value or a `{value, ...}` envelope. */
function factValue(fact) {
  if (fact === null || fact === undefined) return null;
  if (typeof fact === 'object' && !Array.isArray(fact)) {
    if ('value' in fact) return fact.value ?? null;
    return null;
  }
  return fact;
}

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  if (typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}

/**
 * Extract the material input state for one property.
 *
 * Normalisation matters more than it looks: `properties` returns numerics as
 * strings over PostgREST, so `'126000.00'` and `126000` are the same input and
 * must produce the same fingerprint — otherwise every check would report stale
 * and the engine would run on every single turn.
 */
export function extractDecisionInputs(propertyRow = {}, sellerFacts = {}) {
  const property = {};
  for (const field of MATERIAL_PROPERTY_FIELDS) {
    const raw = propertyRow?.[field];
    if (raw === null || raw === undefined || raw === '') {
      property[field] = null;
      continue;
    }
    const asNumber = num(raw);
    property[field] = asNumber === null ? clean(raw).toLowerCase() : asNumber;
  }

  const seller = {};
  for (const field of MATERIAL_SELLER_FACT_FIELDS) {
    const raw = factValue(sellerFacts?.[field]);
    if (raw === null || raw === undefined || raw === '') {
      seller[field] = null;
      continue;
    }
    const asNumber = num(raw);
    seller[field] = asNumber === null ? clean(raw).toLowerCase() : asNumber;
  }

  return { property, seller };
}

/** Deterministic fingerprint of a material input set. */
export function decisionInputFingerprint(inputs) {
  return createHash('sha256').update(stableStringify(inputs)).digest('hex').slice(0, 32);
}

/**
 * Build the stamp the engine records inside `evidence.decision_inputs`.
 * The raw values travel with the hash so a stale verdict can name WHICH input
 * moved instead of just asserting that one did.
 */
export function buildDecisionInputStamp(propertyRow, sellerFacts, now = new Date()) {
  const inputs = extractDecisionInputs(propertyRow, sellerFacts);
  return {
    fingerprint: decisionInputFingerprint(inputs),
    fingerprint_version: 'decision_inputs_v1',
    engine_version: CURRENT_ENGINE_VERSION,
    captured_at: now.toISOString(),
    inputs,
  };
}

function diffInputs(previous = {}, next = {}) {
  const changed = [];
  for (const scope of ['property', 'seller']) {
    const before = previous?.[scope] || {};
    const after = next?.[scope] || {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[key] !== after[key]) {
        changed.push({ scope, field: key, from: before[key] ?? null, to: after[key] ?? null });
      }
    }
  }
  return changed;
}

/**
 * Is this persisted decision still the current answer?
 *
 * @returns {{status, reason, age_days, changed_inputs, fingerprint}}
 */
export function evaluateDecisionFreshness({
  score = null,
  stamp = null,
  now = new Date(),
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
} = {}) {
  const fingerprint = stamp?.fingerprint ?? null;

  if (!score) {
    return { status: DECISION_STATUS.NOT_RUN, reason: 'no_decision_row', age_days: null, changed_inputs: [], fingerprint };
  }

  const evidence = score.evidence && typeof score.evidence === 'object' ? score.evidence : {};
  const recorded = evidence.decision_inputs || null;

  const computedAt = score.computed_at ? new Date(score.computed_at) : null;
  const ageDays =
    computedAt && Number.isFinite(computedAt.valueOf())
      ? (now.valueOf() - computedAt.valueOf()) / 86_400_000
      : null;

  // Rows written before the freshness contract existed carry no input state.
  // They are not provably current, so they are not treated as current — the
  // alternative is trusting a number whose inputs we cannot see, which is the
  // failure mode this module exists to end.
  if (!recorded?.fingerprint) {
    return {
      status: DECISION_STATUS.STALE,
      reason: 'fingerprint_absent_predates_freshness_contract',
      age_days: ageDays,
      changed_inputs: [],
      fingerprint,
    };
  }

  const recordedEngine = clean(recorded.engine_version) || clean(evidence.engine?.version);
  if (recordedEngine && recordedEngine !== CURRENT_ENGINE_VERSION) {
    return {
      status: DECISION_STATUS.STALE,
      reason: 'engine_version_changed',
      age_days: ageDays,
      changed_inputs: [{ scope: 'engine', field: 'engine_version', from: recordedEngine, to: CURRENT_ENGINE_VERSION }],
      fingerprint,
    };
  }

  if (fingerprint && recorded.fingerprint !== fingerprint) {
    return {
      status: DECISION_STATUS.STALE,
      reason: 'material_inputs_changed',
      age_days: ageDays,
      changed_inputs: diffInputs(recorded.inputs, stamp?.inputs),
      fingerprint,
    };
  }

  if (ageDays !== null && maxAgeDays !== null && ageDays > maxAgeDays) {
    return {
      status: DECISION_STATUS.STALE,
      reason: 'decision_older_than_max_age',
      age_days: ageDays,
      changed_inputs: [],
      fingerprint,
    };
  }

  return { status: DECISION_STATUS.CURRENT, reason: 'inputs_unchanged', age_days: ageDays, changed_inputs: [], fingerprint };
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

/**
 * Presentation state for a property whose economics may or may not have been
 * computed (brief section 6). Read-only: it runs nothing.
 *
 * The fourth state is the one that matters. A legacy value may be SHOWN, but
 * only under its own provenance, and never as the current recommended offer.
 */
export const ECONOMICS_DISPLAY_STATE = Object.freeze({
  CURRENT: 'current',
  NOT_RUN: 'decision_engine_not_run',
  STALE: 'decision_engine_stale',
  FAILED: 'decision_engine_failed',
});

export function resolveEconomicsDisplayState({ score = null, freshness = null, engineError = null } = {}) {
  if (engineError) {
    return {
      state: ECONOMICS_DISPLAY_STATE.FAILED,
      can_run_engine: true,
      actionable: 'review',
      detail: engineError,
    };
  }
  if (!score) {
    return {
      state: ECONOMICS_DISPLAY_STATE.NOT_RUN,
      can_run_engine: true,
      actionable: 'run_decision_engine',
      detail: DECISION_STATUS.NOT_RUN,
    };
  }
  if (freshness && freshness.status === DECISION_STATUS.STALE) {
    return {
      state: ECONOMICS_DISPLAY_STATE.STALE,
      can_run_engine: true,
      actionable: 'rerun_decision_engine',
      detail: freshness.reason,
    };
  }
  return {
    state: ECONOMICS_DISPLAY_STATE.CURRENT,
    can_run_engine: true,
    actionable: null,
    detail: freshness?.reason ?? null,
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
