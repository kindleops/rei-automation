import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CURRENT_ENGINE_VERSION,
  DECISION_STATUS,
  buildDecisionInputStamp,
  decisionInputFingerprint,
  ensurePropertyAcquisitionDecision,
  evaluateDecisionFreshness,
  extractDecisionInputs,
  resolveEconomicsDisplayState,
} from '@/lib/acquisition/decisionAuthority.js'

/**
 * DECISION ENGINE AUTHORITY.
 *
 * `property_acquisition_scores` is the canonical current Decision Engine output
 * table, written on demand when the acquisition flow reaches its
 * economics-required state. Its low row count is the lifecycle working.
 *
 * The two failures these tests exist to prevent:
 *   1. Absence of a row being read as "economics unavailable" rather than
 *      "the engine has not run" — a hold instead of an instruction.
 *   2. ANY legacy `properties.cash_offer`-family value standing in for a
 *      current decision, at any confidence, under any absence.
 */

// Ronald. 5115 Michigan Ave, Kansas City MO. Real persisted values.
const RONALD_PROPERTY_ID = '278477219'
const RONALD_DECISION = Object.freeze({
  property_id: RONALD_PROPERTY_ID,
  recommended_cash_offer: 62_300,
  minimum_acceptable_offer: 57_300,
  investor_ceiling_mid: 113_800,
  valuation_mid: 162_500,
  estimated_repairs: 34_700,
  expected_assignment_fee: 16_800,
  best_strategy: 'CASH_ASSIGNMENT',
  decision_tier: 'CREATIVE_TERMS',
  confidence: 76,
  comp_count: 12,
  computed_at: '2026-09-12T18:56:40.805Z',
})

// The Podio-era import column for the SAME property. Never an answer.
const RONALD_LEGACY_CASH_OFFER = 26_110

const RONALD_PROPERTY_ROW = Object.freeze({
  property_id: RONALD_PROPERTY_ID,
  estimated_value: '126000.00',
  property_type: 'Single Family',
  property_class: 'Residential',
  units_count: 1,
  building_square_feet: '992',
  year_built: 1925,
  total_loan_amt: '30000',
  property_address_zip: '64130',
  rehab_level: 'Full Rehab',
  cash_offer: RONALD_LEGACY_CASH_OFFER,
  final_acquisition_score: 91,
})

function stampedDecision(decision, propertyRow, sellerFacts = {}, at = new Date()) {
  return {
    ...decision,
    evidence: {
      engine: { name: 'acquisition_decision_engine', version: CURRENT_ENGINE_VERSION },
      decision_inputs: buildDecisionInputStamp(propertyRow, sellerFacts, at),
    },
  }
}

function harness({ score = null, propertyRow = RONALD_PROPERTY_ROW, engine } = {}) {
  const calls = []
  const scoreProperty = engine
    || (async (id, deps) => {
      calls.push({ id, stamp: deps?.decisionInputStamp ?? null })
      return {
        ok: true,
        score: { ...RONALD_DECISION, property_id: id, evidence: { decision_inputs: deps?.decisionInputStamp ?? null } },
        immutable_snapshot_id: 'snap-new',
      }
    })
  return {
    calls,
    deps: {
      supabase: {},
      scoreProperty,
      loadScoreRow: async () => score,
      loadFreshnessPropertyRow: async () => propertyRow,
    },
  }
}

// ── Absence means "run the engine", never "fall back" ──────────────────────

test('AUTHORITY: no decision row runs the engine rather than reporting unavailable', async () => {
  const h = harness({ score: null })
  const result = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, { deps: h.deps })

  assert.equal(result.freshness.status, DECISION_STATUS.NOT_RUN)
  assert.equal(result.freshness.reason, 'no_decision_row')
  assert.equal(result.ran, true, 'the engine must run when no decision exists')
  assert.equal(result.status, DECISION_STATUS.RECOMPUTED)
  assert.equal(result.decision.recommended_cash_offer, 62_300)
})

test('AUTHORITY: an absent decision never yields the legacy cash_offer', async () => {
  const h = harness({ score: null })
  const result = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, { deps: h.deps })
  assert.notEqual(result.decision.recommended_cash_offer, RONALD_LEGACY_CASH_OFFER)
})

test('AUTHORITY: a failed engine run is a HOLD, and still not a legacy fallback', async () => {
  const h = harness({ score: null, engine: async () => ({ ok: false, error: 'property_not_found' }) })
  const result = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, { deps: h.deps })

  assert.equal(result.status, DECISION_STATUS.ENGINE_FAILED)
  assert.equal(result.error, 'property_not_found')
  assert.equal(result.decision, null)
})

test('AUTHORITY: an engine that throws becomes a status, not an exception', async () => {
  const h = harness({ score: null, engine: async () => { throw new Error('comp_loader_timeout') } })
  const result = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, { deps: h.deps })
  assert.equal(result.status, DECISION_STATUS.ENGINE_FAILED)
  assert.equal(result.error, 'comp_loader_timeout')
})

// ── A current row is reused ────────────────────────────────────────────────

test('AUTHORITY: an unchanged property reuses its decision and runs nothing', async () => {
  const score = stampedDecision(RONALD_DECISION, RONALD_PROPERTY_ROW, {}, new Date())
  const h = harness({ score })
  const result = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, { deps: h.deps })

  assert.equal(result.status, DECISION_STATUS.CURRENT)
  assert.equal(result.ran, false)
  assert.equal(h.calls.length, 0, 'the engine must not run for a current decision')
  assert.equal(result.decision.recommended_cash_offer, 62_300)
})

test('AUTHORITY: PostgREST numeric strings do not fake a change', () => {
  // `properties` returns numerics as strings. '126000.00' and 126000 are the
  // same input; if they fingerprinted differently the engine would rerun every
  // single turn and "reuse" would never happen.
  const a = extractDecisionInputs({ ...RONALD_PROPERTY_ROW, estimated_value: '126000.00' })
  const b = extractDecisionInputs({ ...RONALD_PROPERTY_ROW, estimated_value: 126_000 })
  assert.equal(decisionInputFingerprint(a), decisionInputFingerprint(b))
})

// ── A stale row is recomputed ──────────────────────────────────────────────

test('AUTHORITY: a changed seller ask makes the decision stale and reruns', async () => {
  const score = stampedDecision(RONALD_DECISION, RONALD_PROPERTY_ROW, { asking_price: 150_000 })
  const h = harness({ score })
  const result = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, {
    sellerFacts: { asking_price: { value: 135_000 } },
    deps: h.deps,
  })

  assert.equal(result.freshness.reason, 'material_inputs_changed')
  assert.equal(result.ran, true)
  assert.ok(
    result.freshness.changed_inputs.some((c) => c.field === 'asking_price'),
    `stale verdict must name the input: ${JSON.stringify(result.freshness.changed_inputs)}`,
  )
})

test('AUTHORITY: a changed valuation anchor makes the decision stale', async () => {
  const score = stampedDecision(RONALD_DECISION, RONALD_PROPERTY_ROW)
  const h = harness({ score, propertyRow: { ...RONALD_PROPERTY_ROW, estimated_value: 210_000 } })
  const result = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, { deps: h.deps })
  assert.equal(result.freshness.reason, 'material_inputs_changed')
  assert.equal(result.ran, true)
})

test('AUTHORITY: a changed LEGACY column does not make the decision stale', async () => {
  // cash_offer / final_acquisition_score are Podio-era OUTPUT columns. They are
  // not engine inputs, so moving one must neither trigger nor suppress a rerun.
  const score = stampedDecision(RONALD_DECISION, RONALD_PROPERTY_ROW)
  const h = harness({
    score,
    propertyRow: { ...RONALD_PROPERTY_ROW, cash_offer: 999_999, final_acquisition_score: 1 },
  })
  const result = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, { deps: h.deps })
  assert.equal(result.status, DECISION_STATUS.CURRENT)
  assert.equal(result.ran, false)
})

test('AUTHORITY: a decision older than the horizon is stale even if inputs held', () => {
  const score = stampedDecision(
    { ...RONALD_DECISION, computed_at: '2026-01-01T00:00:00.000Z' },
    RONALD_PROPERTY_ROW,
  )
  const freshness = evaluateDecisionFreshness({
    score,
    stamp: buildDecisionInputStamp(RONALD_PROPERTY_ROW, {}),
    now: new Date('2026-09-12T00:00:00.000Z'),
  })
  assert.equal(freshness.status, DECISION_STATUS.STALE)
  assert.equal(freshness.reason, 'decision_older_than_max_age')
})

test('AUTHORITY: a pre-contract row with no stamp is not presumed current', () => {
  const freshness = evaluateDecisionFreshness({
    score: { ...RONALD_DECISION, evidence: { engine: { version: CURRENT_ENGINE_VERSION } } },
    stamp: buildDecisionInputStamp(RONALD_PROPERTY_ROW, {}),
  })
  assert.equal(freshness.status, DECISION_STATUS.STALE)
  assert.equal(freshness.reason, 'fingerprint_absent_predates_freshness_contract')
})

test('AUTHORITY: an older engine version is stale regardless of inputs', () => {
  const score = stampedDecision(RONALD_DECISION, RONALD_PROPERTY_ROW)
  score.evidence.decision_inputs.engine_version = '1.4.0'
  const freshness = evaluateDecisionFreshness({
    score,
    stamp: buildDecisionInputStamp(RONALD_PROPERTY_ROW, {}),
  })
  assert.equal(freshness.reason, 'engine_version_changed')
})

// ── Manual and automated share ONE authority ───────────────────────────────

test('AUTHORITY: force reruns a decision that is already current', async () => {
  const score = stampedDecision(RONALD_DECISION, RONALD_PROPERTY_ROW)
  const h = harness({ score })
  const result = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, {
    force: true,
    reason: 'manual_deal_intelligence_run',
    deps: h.deps,
  })
  assert.equal(result.ran, true)
  assert.equal(h.calls.length, 1)
})

test('AUTHORITY: manual and automated runs stamp identical inputs', async () => {
  // Same property, same facts, two entry points -> one calculation authority.
  // If the stamps differed, the two paths would disagree about what "current"
  // means and each would invalidate the other's work.
  const manual = harness({ score: null })
  const automated = harness({ score: null })
  const facts = { asking_price: { value: 150_000 } }

  const a = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, {
    force: true, sellerFacts: facts, deps: manual.deps,
  })
  const b = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, {
    sellerFacts: facts, deps: automated.deps,
  })

  assert.equal(manual.calls[0].stamp.fingerprint, automated.calls[0].stamp.fingerprint)
  assert.equal(a.decision.recommended_cash_offer, b.decision.recommended_cash_offer)
})

test('AUTHORITY: the engine is handed the stamp it must record', async () => {
  const h = harness({ score: null })
  await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, { deps: h.deps })
  assert.equal(h.calls[0].stamp.fingerprint_version, 'decision_inputs_v1')
  assert.equal(h.calls[0].stamp.engine_version, CURRENT_ENGINE_VERSION)
})

// ── Ronald, end to end ─────────────────────────────────────────────────────

test('RONALD: canonical economics come from the decision row, not properties', async () => {
  const score = stampedDecision(RONALD_DECISION, RONALD_PROPERTY_ROW)
  const h = harness({ score })
  const result = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, { deps: h.deps })

  assert.equal(result.decision.recommended_cash_offer, 62_300)
  assert.equal(result.decision.minimum_acceptable_offer, 57_300)
  assert.equal(result.decision.expected_assignment_fee, 16_800)
  assert.notEqual(result.decision.recommended_cash_offer, RONALD_LEGACY_CASH_OFFER)
})

test('RONALD: an absurd legacy cash_offer changes nothing', async () => {
  const score = stampedDecision(RONALD_DECISION, RONALD_PROPERTY_ROW)
  const h = harness({ score, propertyRow: { ...RONALD_PROPERTY_ROW, cash_offer: 999_999 } })
  const result = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, { deps: h.deps })

  assert.equal(result.decision.recommended_cash_offer, 62_300)
  assert.notEqual(result.decision.recommended_cash_offer, 999_999)
  assert.equal(result.status, DECISION_STATUS.CURRENT)
})

test('RONALD: deleting the canonical record yields run-the-engine, never 999,999', async () => {
  const h = harness({
    score: null,
    propertyRow: { ...RONALD_PROPERTY_ROW, cash_offer: 999_999 },
    engine: async () => ({ ok: false, error: 'engine_unavailable' }),
  })
  const result = await ensurePropertyAcquisitionDecision(RONALD_PROPERTY_ID, { deps: h.deps })

  assert.equal(result.freshness.status, DECISION_STATUS.NOT_RUN)
  assert.equal(result.status, DECISION_STATUS.ENGINE_FAILED)
  assert.equal(result.decision, null)
})

// ── Display state ──────────────────────────────────────────────────────────

test('DISPLAY: no decision reads as not-run and actionable, not unavailable', () => {
  const state = resolveEconomicsDisplayState({ score: null })
  assert.equal(state.state, 'decision_engine_not_run')
  assert.equal(state.actionable, 'run_decision_engine')
  assert.equal(state.can_run_engine, true)
})

test('DISPLAY: a failed run reads as review, distinct from never-run', () => {
  const state = resolveEconomicsDisplayState({ score: null, engineError: 'comp_loader_timeout' })
  assert.equal(state.state, 'decision_engine_failed')
  assert.equal(state.actionable, 'review')
})

test('DISPLAY: a stale decision is rerunnable, not blank', () => {
  const state = resolveEconomicsDisplayState({
    score: RONALD_DECISION,
    freshness: { status: DECISION_STATUS.STALE, reason: 'material_inputs_changed' },
  })
  assert.equal(state.state, 'decision_engine_stale')
  assert.equal(state.actionable, 'rerun_decision_engine')
})

test('DISPLAY: a current decision is current', () => {
  const state = resolveEconomicsDisplayState({
    score: RONALD_DECISION,
    freshness: { status: DECISION_STATUS.CURRENT, reason: 'inputs_unchanged' },
  })
  assert.equal(state.state, 'current')
  assert.equal(state.actionable, null)
})
