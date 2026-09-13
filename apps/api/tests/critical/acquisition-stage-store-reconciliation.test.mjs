import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACQUISITION_STAGE_ORDER,
  PROJECTION_GUARDS,
  acquisitionStageRank,
  projectAcquisitionStageToThread,
  resolveProjectedLifecycleStage,
} from '@/lib/domain/lead-state/project-acquisition-stage.js'

/**
 * ACQUISITION STAGE STORE RECONCILIATION.
 *
 * ONE lifecycle authority: `acquisition_opportunities.acquisition_stage`.
 * `inbox_thread_state.lifecycle_stage` is a PROJECTION and may trail it, never
 * lead it.
 *
 * PRODUCTION DEFECT (thread +19549807015 / opportunity 2b3c261d, 2026-09-10):
 * a rent of "$4100.00  per  Month." was misread as a purchase price, written as
 * a seller_counter and accepted 6 seconds later. The orchestrator projected
 * asking_price -> formal_contract (reasoning_code S3_TO_S6_UNCLEAR). Twelve
 * hours later an authorized correction voided the offer, voided the closing
 * case and reset canonical to asking_price — and the projection stayed at
 * formal_contract, because automated writers may not regress a stage. The
 * overshoot became permanent.
 */

const project = (requested, canonical, reconciliation = false) =>
  resolveProjectedLifecycleStage({ requested, canonical, reconciliation })

// ── The fence ─────────────────────────────────────────────────────────────

test('STORES: the projection may not lead the canonical acquisition stage', () => {
  const r = project('formal_contract', 'asking_price')
  assert.equal(r.stage, 'asking_price')
  assert.equal(r.changed, true)
  assert.equal(r.guard, PROJECTION_GUARDS.CLAMPED_TO_CANONICAL)
})

test('STORES: the projection may mirror canonical', () => {
  const r = project('asking_price', 'asking_price')
  assert.equal(r.stage, 'asking_price')
  assert.equal(r.changed, false)
  assert.equal(r.guard, null)
})

test('STORES: the projection may trail canonical', () => {
  // Trailing is normal projection lag and is left alone; the existing
  // monotonic guard decides whether it may advance.
  const r = project('offer_interest', 'offer')
  assert.equal(r.stage, 'offer_interest')
  assert.equal(r.changed, false)
})

test('STORES: with no canonical stage there is nothing to clamp against', () => {
  const r = project('asking_price', null)
  assert.equal(r.stage, 'asking_price')
  assert.equal(r.changed, false)
  assert.equal(r.guard, null)
})

// ── §13 required matrix ──────────────────────────────────────────────────

test('STORES: opportunity S3 / thread S6 repairs the thread to S3', () => {
  const r = project('formal_contract', 'asking_price', true)
  assert.equal(r.stage, 'asking_price')
  assert.equal(r.guard, PROJECTION_GUARDS.RECONCILED)
})

test('STORES: opportunity at S5 cannot make the thread S6', () => {
  assert.equal(project('formal_contract', 'offer').stage, 'offer')
})

test('STORES: an accepted offer at canonical S6 lets the projection be S6', () => {
  const r = project('formal_contract', 'formal_contract')
  assert.equal(r.stage, 'formal_contract')
  assert.equal(r.changed, false)
})

test('STORES: a closing case cannot promote the projection', () => {
  // The only production closing_case belongs to an opportunity at asking_price.
  // Its existence is not an input here at all — the projection reads exactly
  // one field, the canonical stage.
  assert.equal(project('formal_contract', 'asking_price').stage, 'asking_price')
  assert.equal(projectAcquisitionStageToThread({ acquisition_stage: 'asking_price', closing_case_id: 'closing:x' }), 'asking_price')
})

test('STORES: a seller_offers row cannot promote the projection', () => {
  assert.equal(
    projectAcquisitionStageToThread({ acquisition_stage: 'offer', active_offer_id: 'offer:x:v1' }),
    'offer',
  )
})

test('STORES: a contract request cannot promote the projection', () => {
  assert.equal(project('formal_contract', 'property_condition').stage, 'property_condition')
})

test('STORES: the projection is a pure read of canonical, with no inference', () => {
  // Every one of these is a different fact about the deal. None is its stage.
  const opportunity = {
    acquisition_stage: 'offer_interest',
    closing_case_id: 'closing:x',
    active_offer_id: 'offer:x:v1',
    contract_requested: true,
    final_acquisition_score: 999,
    temperature: 'hot',
  }
  assert.equal(projectAcquisitionStageToThread(opportunity), 'offer_interest')
})

test('STORES: projection is idempotent', () => {
  const once = project('formal_contract', 'asking_price')
  const twice = project(once.stage, 'asking_price')
  assert.equal(once.stage, twice.stage)
  assert.equal(twice.changed, false)
})

test('STORES: reconciliation applied twice converges and stops changing', () => {
  const once = project('formal_contract', 'asking_price', true)
  const twice = project(once.stage, 'asking_price', true)
  assert.equal(twice.stage, 'asking_price')
  assert.equal(twice.changed, false)
})

// ── The fence at the single writer ───────────────────────────────────────

/** Minimal PostgREST-shaped fake: one thread row, one opportunity row. */
function fakeSupabase({ thread, opportunity }) {
  const writes = []
  const table = (name) => {
    const q = {
      _filters: [], _patch: null,
      select() { return q },
      update(patch) { q._patch = patch; return q },
      eq() { return q },
      in() { return q },
      order() { return q },
      limit() { return Promise.resolve({ data: rows(name), error: null }) },
      maybeSingle() { return Promise.resolve({ data: rows(name)[0] || null, error: null }) },
      single() {
        if (q._patch) { writes.push({ table: name, patch: q._patch }) }
        return Promise.resolve({ data: { ...(rows(name)[0] || {}), ...(q._patch || {}) }, error: null })
      },
      insert(row) { writes.push({ table: name, insert: row }); return q },
      upsert(row) { writes.push({ table: name, patch: row }); q._patch = row; return q },
      then(onF, onR) {
        if (q._patch) writes.push({ table: name, patch: q._patch })
        return Promise.resolve({ data: rows(name), error: null }).then(onF, onR)
      },
    }
    return q
  }
  const rows = (name) => {
    if (name === 'inbox_thread_state') return [thread]
    if (name === 'acquisition_opportunities') return [opportunity]
    return []
  }
  return { from: table, _writes: writes }
}

test('FENCE: the single writer clamps a projection that would lead canonical', async () => {
  const { patchUniversalLeadState } = await import('@/lib/domain/lead-state/patch-universal-lead-state.js')
  const supabase = fakeSupabase({
    thread: { thread_key: '+19549807015', lifecycle_stage: 'asking_price', manual_stage_lock: false },
    opportunity: { acquisition_stage: 'asking_price', updated_at: '2026-09-12T00:00:00Z' },
  })
  const result = await patchUniversalLeadState({
    threadKey: '+19549807015',
    patch: { lifecycle_stage: 'formal_contract' },
    meta: { change_source: 'system', source_view: 'test' },
    supabase,
  })
  const guards = result.stage_guards || []
  assert.ok(
    guards.includes(PROJECTION_GUARDS.CLAMPED_TO_CANONICAL) || result.blocked === true,
    `expected the projection to be clamped or blocked, got ${JSON.stringify(result)}`,
  )
  const staged = supabase._writes.find((w) => w.patch?.lifecycle_stage)
  if (staged) assert.notEqual(staged.patch.lifecycle_stage, 'formal_contract')
})

test('FENCE: a caller-supplied canonical stage avoids the extra read and still clamps', () => {
  // meta.canonical_acquisition_stage is the same fence, pre-resolved.
  const r = resolveProjectedLifecycleStage({
    requested: 'formal_contract', canonical: 'offer',
  })
  assert.equal(r.stage, 'offer')
  assert.equal(r.guard, PROJECTION_GUARDS.CLAMPED_TO_CANONICAL)
})

// ── Canonical order ──────────────────────────────────────────────────────

test('STORES: the canonical 10-stage order is unchanged', () => {
  assert.deepEqual(ACQUISITION_STAGE_ORDER, [
    'ownership_confirmation', 'offer_interest', 'asking_price', 'property_condition',
    'offer', 'formal_contract', 'disposition', 'under_contract', 'prepared_to_close', 'closed',
  ])
  assert.equal(acquisitionStageRank('formal_contract'), 5)
  assert.equal(acquisitionStageRank('asking_price'), 2)
})

test('STORES: canonical acquisition stage stays monotonic in normal seller flow', async () => {
  // Administrative projection repair is not a seller-stage regression: it moves
  // the MIRROR, never the canonical opportunity stage.
  const { resolveSellerStageTransition } = await import('@/lib/domain/seller-flow/resolve-seller-stage-transition.js')
  const t = resolveSellerStageTransition({
    stage_before: 'offer',
    intent: 'counter_offer',
    known_facts: { asking_price: { value: 500_000 }, ownership_status: 'confirmed', interest: 'interested' },
    new_facts: { asking_price: 500_000 },
    negotiation_state: { latest_offer: 62_300, offers_made: [{ amount: 62_300 }] },
    ade_result: { recommended_offer: 62_300, max_allowable_offer: 79_100, sufficient_facts: true, underwriting_ready: true },
  })
  assert.ok(
    acquisitionStageRank(t.stage_after) >= acquisitionStageRank('offer'),
    `canonical regressed to ${t.stage_after}`,
  )
})
