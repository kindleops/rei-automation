import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PIPELINE_ADMISSION_REASONS,
  shouldEnterAcquisitionPipeline,
  shouldPromoteThreadToOpportunity,
} from '@/lib/domain/opportunity/universal-pipeline-registry.js'
import { promoteThreadToOpportunity } from '@/lib/domain/opportunity/opportunity-service.js'

/**
 * PIPELINE ADMISSION AUTHORITY.
 *
 * Membership in the current V2 acquisition pipeline is decided by CURRENT
 * acquisition evidence. It used to end with `final_acquisition_score >= 70` — a
 * Podio-era import on `properties`, surfaced through `inbox_threads_hydrated`,
 * deciding membership in a pipeline it predates.
 *
 * The two invariants these tests hold:
 *   high score           != pipeline membership
 *   pipeline membership  != seller motivation
 */

/** The legacy score family, all pinned absurdly high. */
const ABSURD_LEGACY_SCORES = Object.freeze({
  final_acquisition_score: 999,
  deal_strength_score: 999,
  structured_motivation_score: 999,
  tag_distress_score: 999,
  ai_score: 999,
})

// ── Legacy score alone admits nothing ──────────────────────────────────────

test('ADMISSION: a 999 legacy score with no acquisition evidence is NOT admitted', () => {
  const verdict = shouldEnterAcquisitionPipeline({
    thread_key: '+15550000001',
    ...ABSURD_LEGACY_SCORES,
    // No inbound. No opportunity. No campaign target. No manual enrollment.
  })
  assert.equal(verdict.eligible, false)
  assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.LEGACY_PIPELINE_CANDIDATE)
  assert.equal(verdict.evidence.disposition, 'legacy_unenrolled')
})

test('ADMISSION: the score at exactly the old threshold no longer admits', () => {
  // 70 was the old cut. It is not a cut any more.
  assert.equal(shouldPromoteThreadToOpportunity({ final_acquisition_score: 70 }), false)
  assert.equal(shouldPromoteThreadToOpportunity({ final_acquisition_score: 100 }), false)
})

test('ADMISSION: a legacy-only thread is FLAGGED, not enrolled', () => {
  // It stays classifiable for review — the number is historical data, not a
  // reason to start seller automation.
  const verdict = shouldEnterAcquisitionPipeline({ final_acquisition_score: 88 })
  assert.equal(verdict.legacy_pipeline_candidate, true)
  assert.equal(verdict.eligible, false)
})

test('ADMISSION: no legacy score becomes a seller fact', () => {
  // The verdict must not manufacture interest, temperature, priority or
  // ownership out of a score.
  const verdict = shouldEnterAcquisitionPipeline({ ...ABSURD_LEGACY_SCORES })
  const serialized = JSON.stringify(verdict)
  for (const fabricated of ['seller_interested', 'hot', 'priority', 'ownership_confirmed']) {
    assert.ok(!serialized.includes(fabricated), `verdict invented "${fabricated}": ${serialized}`)
  }
})

// ── Real current evidence admits, regardless of score ──────────────────────

test('ADMISSION: a real seller inbound admits with a null legacy score', () => {
  const verdict = shouldEnterAcquisitionPipeline({
    thread_key: '+15550000002',
    final_acquisition_score: null,
    last_inbound_at: '2026-09-12T18:30:00.000Z',
  })
  assert.equal(verdict.eligible, true)
  assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.SELLER_INBOUND)
})

test('ADMISSION: deal_thread_state has no last_inbound_at, so direction is the evidence', () => {
  // The workflow path passes a `deal_thread_state` row, which carries
  // `latest_message_direction` and no `last_inbound_at` at all. Before this,
  // that path could not see an inbound.
  const verdict = shouldEnterAcquisitionPipeline({
    thread_key: '6512603774',
    latest_message_direction: 'inbound',
    final_acquisition_score: 3,
  })
  assert.equal(verdict.eligible, true)
  assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.SELLER_INBOUND)
})

test('ADMISSION: an explicit inbound flag admits when the last message is outbound', () => {
  // 65 production threads have a real seller reply followed by an outbound, so
  // `latest_message_direction` reads 'outbound' and cannot see the inbound. A
  // caller that already knows can say so.
  const verdict = shouldEnterAcquisitionPipeline({
    thread_key: '+15550000011',
    latest_message_direction: 'outbound',
    has_seller_inbound: true,
    final_acquisition_score: null,
  })
  assert.equal(verdict.eligible, true)
  assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.SELLER_INBOUND)
})

test('ADMISSION: an asking price admits with a low legacy score', () => {
  const verdict = shouldEnterAcquisitionPipeline({
    thread_key: '+15550000003',
    final_acquisition_score: 4,
    asking_price: 150_000,
  })
  assert.equal(verdict.eligible, true)
  assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.ASKING_PRICE_CAPTURED)
})

test('ADMISSION: an active acquisition opportunity admits with no legacy score', () => {
  const verdict = shouldEnterAcquisitionPipeline({
    thread_key: '+15550000004',
    opportunity_id: 'opp-1234',
  })
  assert.equal(verdict.eligible, true)
  assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.ACTIVE_ACQUISITION_OPPORTUNITY)
})

test('ADMISSION: an active campaign target admits; a cancelled one does not', () => {
  assert.equal(
    shouldEnterAcquisitionPipeline({ campaign_target_id: 'tgt-1' }).reason,
    PIPELINE_ADMISSION_REASONS.ACTIVE_CAMPAIGN_TARGET,
  )
  assert.equal(
    shouldEnterAcquisitionPipeline({ campaign_target_id: 'tgt-1', campaign_target_state: 'cancelled' }).eligible,
    false,
  )
})

test('ADMISSION: operator enrollment admits on its own', () => {
  const verdict = shouldEnterAcquisitionPipeline({ manually_promoted: true, final_acquisition_score: 0 })
  assert.equal(verdict.eligible, true)
  assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.MANUAL_OPERATOR_ENROLLMENT)
})

test('ADMISSION: seller engagement and in-progress stages still admit', () => {
  assert.equal(
    shouldEnterAcquisitionPipeline({ universal_status: 'negotiating' }).reason,
    PIPELINE_ADMISSION_REASONS.SELLER_ENGAGEMENT,
  )
  assert.equal(
    shouldEnterAcquisitionPipeline({ inbox_bucket: 'new_replies' }).reason,
    PIPELINE_ADMISSION_REASONS.SELLER_ENGAGEMENT,
  )
  assert.equal(
    shouldEnterAcquisitionPipeline({ universal_stage: 'asking_price' }).reason,
    PIPELINE_ADMISSION_REASONS.ACQUISITION_STAGE_IN_PROGRESS,
  )
})

// ── §7: absurd legacy scores, then a real inbound ─────────────────────────

test('ADMISSION §7: 999 across the score family admits nothing; one inbound does', () => {
  const legacyOnly = {
    thread_key: '+15550000005',
    ...ABSURD_LEGACY_SCORES,
  }
  assert.equal(shouldEnterAcquisitionPipeline(legacyOnly).eligible, false)

  const withInbound = { ...legacyOnly, last_inbound_at: '2026-09-12T19:00:00.000Z' }
  const verdict = shouldEnterAcquisitionPipeline(withInbound)
  assert.equal(verdict.eligible, true)
  // Admitted by the conversation, not by the 999s that were there all along.
  assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.SELLER_INBOUND)
})

// ── Terminal disposition ordering ─────────────────────────────────────────

test('ADMISSION: a seller who replied and then opted out stays in the pipeline', () => {
  // Ordering is load-bearing. Suppression is something the pipeline has to
  // carry; it is not a reason to forget the conversation happened.
  const verdict = shouldEnterAcquisitionPipeline({
    last_inbound_at: '2026-09-01T00:00:00.000Z',
    opt_out: true,
  })
  assert.equal(verdict.eligible, true)
  assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.SELLER_INBOUND)
})

test('ADMISSION: terminal disposition with no engagement is denied as such', () => {
  const verdict = shouldEnterAcquisitionPipeline({ wrong_number: true })
  assert.equal(verdict.eligible, false)
  assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.TERMINAL_DISPOSITION)
})

test('ADMISSION: a terminal thread carrying a 999 score is terminal, not legacy', () => {
  const verdict = shouldEnterAcquisitionPipeline({ not_interested: true, ...ABSURD_LEGACY_SCORES })
  assert.equal(verdict.eligible, false)
  assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.TERMINAL_DISPOSITION)
})

test('ADMISSION: an empty thread is denied for absence, not for a score', () => {
  const verdict = shouldEnterAcquisitionPipeline({})
  assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.NO_CURRENT_ACQUISITION_EVIDENCE)
  assert.equal(verdict.legacy_pipeline_candidate, false)
})

// ── Ronald ────────────────────────────────────────────────────────────────

// 5115 Michigan Ave, Kansas City MO. Real thread, real inbound, $150,000 ask.
const RONALD_THREAD = Object.freeze({
  thread_key: '+12063359131',
  property_id: '278477219',
  master_owner_id: 'mo_ronald',
  last_inbound_at: '2026-09-12T19:34:06.639Z',
  reply_intent: 'asking_price_provided',
  asking_price: 150_000,
  universal_stage: 'asking_price',
})

test('RONALD: admitted with the legacy score stripped entirely', () => {
  const verdict = shouldEnterAcquisitionPipeline({ ...RONALD_THREAD, final_acquisition_score: null })
  assert.equal(verdict.eligible, true)
  assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.SELLER_INBOUND)
  assert.equal(verdict.legacy_pipeline_candidate, false)
})

test('RONALD: admitted with the legacy score at zero', () => {
  assert.equal(shouldPromoteThreadToOpportunity({ ...RONALD_THREAD, final_acquisition_score: 0 }), true)
})

test('RONALD: admission is unchanged across every legacy-score value', () => {
  // The score is not an input to membership, so no value of it can move the
  // answer — including the one that used to be the whole rule.
  for (const score of [null, 0, 1, 69, 70, 999]) {
    const verdict = shouldEnterAcquisitionPipeline({ ...RONALD_THREAD, final_acquisition_score: score })
    assert.equal(verdict.eligible, true, `score ${score} changed admission`)
    assert.equal(verdict.reason, PIPELINE_ADMISSION_REASONS.SELLER_INBOUND)
  }
})

test('RONALD: his conversation, not his price, is the primary evidence', () => {
  // Both would admit him; the reason has to name the one that actually fired.
  const noPrice = shouldEnterAcquisitionPipeline({ ...RONALD_THREAD, asking_price: null })
  assert.equal(noPrice.eligible, true)
  assert.equal(noPrice.reason, PIPELINE_ADMISSION_REASONS.SELLER_INBOUND)
})

// ── Replay / idempotency ──────────────────────────────────────────────────

test('ADMISSION: the predicate is pure — 10 evaluations, one answer', () => {
  const verdicts = Array.from({ length: 10 }, () => shouldEnterAcquisitionPipeline(RONALD_THREAD))
  const distinct = new Set(verdicts.map((v) => `${v.eligible}:${v.reason}`))
  assert.equal(distinct.size, 1)
})

test('ADMISSION: the same inbound promoted 10x yields one membership state', async () => {
  // The dedupe key is what makes this one row, and it must not vary across
  // replays of an identical inbound.
  const writes = []
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { id: 'opp-1', version: 1 } }) }),
      }),
      update: (row) => ({
        eq: () => ({
          select: () => ({
            single: async () => {
              writes.push(row)
              return { data: { id: 'opp-1', ...row }, error: null }
            },
          }),
        }),
      }),
    }),
  }

  for (let i = 0; i < 10; i += 1) {
    const result = await promoteThreadToOpportunity(RONALD_THREAD, { source: 'test' }, { supabase: client })
    assert.equal(result.ok, true)
    assert.equal(result.created, false)
  }
  assert.equal(writes.length, 10)
  assert.equal(new Set(writes.map((w) => w.dedupe_key)).size, 1)
  assert.equal(new Set(writes.map((w) => w.promotion_reason)).size, 1)
  assert.equal(writes[0].promotion_reason, PIPELINE_ADMISSION_REASONS.SELLER_INBOUND)
})

test('ADMISSION: a rejected thread reports WHY it was skipped', async () => {
  const result = await promoteThreadToOpportunity(
    { thread_key: '+15550000009', ...ABSURD_LEGACY_SCORES },
    {},
    { supabase: {} },
  )
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.equal(result.admission.reason, PIPELINE_ADMISSION_REASONS.LEGACY_PIPELINE_CANDIDATE)
  assert.equal(result.admission.eligible, false)
})

test('ADMISSION: promotion_reason records what actually admitted the thread', async () => {
  // It used to default to a hardcoded 'seller_engagement', which claimed a
  // reason the thread might not have had.
  const writes = []
  const client = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'opp-2', version: 1 } }) }) }),
      update: (row) => ({
        eq: () => ({ select: () => ({ single: async () => { writes.push(row); return { data: { id: 'opp-2', ...row }, error: null } } }) }),
      }),
    }),
  }
  await promoteThreadToOpportunity(
    { thread_key: '+15550000010', master_owner_id: 'mo-1', manually_promoted: true },
    { source: 'operator' },
    { supabase: client },
  )
  assert.equal(writes[0].promotion_reason, PIPELINE_ADMISSION_REASONS.MANUAL_OPERATOR_ENROLLMENT)
})
