// ─── decisionFreshness.js ───────────────────────────────────────────────────
// The PURE half of decisionAuthority.js: the freshness contract (material
// inputs, the input fingerprint, the stamp the engine records, the freshness
// verdict) and the economics display state. No I/O, no Supabase client, no
// engine import — so read-only callers (LeadCommand MCP, tests) can apply the
// one definition of "current" without reaching the engine's write path.
//
// decisionAuthority.js re-exports every name here unchanged; it remains THE
// entry point for running the engine (ensurePropertyAcquisitionDecision).

import { createHash } from 'node:crypto';

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
