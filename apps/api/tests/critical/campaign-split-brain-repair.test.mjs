import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVE_QUEUE_STATUSES,
  assertCampaignExecutionConsistent,
  countLiveConfirmedQueueRows,
  detectCampaignImpossibleStates,
  isCampaignFullyLive,
  isCampaignLiveInconsistentWithQueue,
  reconcileCampaignLiveState,
} from '@/lib/domain/campaigns/campaign-live-execution.js'
import { runCanonicalCampaignActivation } from '@/lib/domain/campaigns/campaign-activation-orchestrator.js'

/**
 * The confirmed invalid production state for campaign
 * dbcfe227-4423-4b74-bb28-2af02c45dde7: status=active with 50 live-confirmed
 * queue rows but proof/disabled campaign flags (execution_mode=proof).
 */
function brokenSplitBrainCampaign(overrides = {}) {
  return {
    id: 'dbcfe227-4423-4b74-bb28-2af02c45dde7',
    name: 'Tax Delinquent - Poor and Unsound',
    status: 'active',
    activated_at: '2026-06-30T12:00:00.000Z',
    auto_queue_enabled: false,
    auto_send_enabled: false,
    auto_reply_mode: 'disabled',
    batch_max: 50,
    daily_cap: 50,
    market: 'miami, fl',
    metadata: { execution_mode: 'proof', production_launch: false, test_mode_cleared: false },
    ...overrides,
  }
}

function fullyLiveCampaign(overrides = {}) {
  return {
    id: 'live-1',
    status: 'active',
    activated_at: '2026-06-30T12:00:00.000Z',
    auto_queue_enabled: true,
    auto_send_enabled: true,
    auto_reply_mode: 'live_limited',
    metadata: { production_launch: true, converted_to_live_at: '2026-06-30T12:00:00.000Z' },
    ...overrides,
  }
}

function liveRow(id) {
  return { id, queue_status: 'scheduled', sms_eligible: true, routing_allowed: true, metadata: { confirm_live: true, no_send: false, launch_mode: 'guarded_live_queue_creation' } }
}
function proofRow(id) {
  return { id, queue_status: 'scheduled', metadata: { no_send: true, launch_mode: 'proof_hydration_no_send' } }
}

/** Minimal stateful PostgREST-style mock covering the reconcile/orchestrator paths. */
function makeFakeSupabase({ campaign, queueRows = [] }) {
  const state = { campaign: { ...campaign }, queueRows: [...queueRows] }
  const events = []
  const client = {
    _state: state,
    _events: events,
    from(table) {
      if (table === 'campaigns') {
        return {
          select() {
            return {
              eq: () => ({ maybeSingle: async () => ({ data: { ...state.campaign }, error: null }) }),
            }
          },
          update(patch) {
            return {
              eq: () => ({
                select: () => ({
                  maybeSingle: async () => {
                    state.campaign = { ...state.campaign, ...patch }
                    return { data: { ...state.campaign }, error: null }
                  },
                }),
                // update without .select() (idempotency-key write path)
                then: (resolve) => {
                  state.campaign = { ...state.campaign, ...patch }
                  return Promise.resolve({ data: null, error: null }).then(resolve)
                },
              }),
            }
          },
        }
      }
      if (table === 'send_queue') {
        return {
          select(_cols, opts) {
            const head = opts && opts.head
            const chain = {
              eq: () => chain,
              in: (_col, statuses) => {
                const rows = state.queueRows.filter((r) => statuses.includes(r.queue_status))
                if (head) return Promise.resolve({ count: rows.length, error: null })
                return Promise.resolve({ data: rows, error: null })
              },
            }
            return chain
          },
        }
      }
      if (table === 'campaign_events') {
        return { insert: async (row) => { events.push(row); return { data: null, error: null } } }
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }
    },
  }
  return client
}

const noopDeps = () => ({
  recomputeCampaignProgress: async () => ({ ok: true }),
  setSystemValues: async () => ({ ok: true }),
})

// ---------------------------------------------------------------------------
// Pure detection
// ---------------------------------------------------------------------------

test('active campaign with live-confirmed rows but proof flags is split-brain inconsistent', () => {
  assert.equal(isCampaignLiveInconsistentWithQueue(brokenSplitBrainCampaign(), { liveQueueRows: 50 }), true)
})

test('active campaign with only proof rows (no live rows) is not queue-inconsistent', () => {
  const campaign = { status: 'active', auto_queue_enabled: false, auto_send_enabled: false, metadata: {} }
  assert.equal(isCampaignLiveInconsistentWithQueue(campaign, { liveQueueRows: 0 }), false)
})

test('fully live campaign is never flagged inconsistent even with live rows', () => {
  const campaign = fullyLiveCampaign()
  assert.equal(isCampaignFullyLive(campaign), true)
  assert.equal(isCampaignLiveInconsistentWithQueue(campaign, { liveQueueRows: 50 }), false)
})

test('paused campaign with live rows is not flagged (legitimate pause preserved)', () => {
  const paused = fullyLiveCampaign({ status: 'paused' })
  assert.equal(isCampaignLiveInconsistentWithQueue(paused, { liveQueueRows: 50 }), false)
})

test('detectCampaignImpossibleStates enumerates the exact broken combination', () => {
  const violations = detectCampaignImpossibleStates(brokenSplitBrainCampaign(), { liveQueueRows: 50 })
  assert.ok(violations.includes('active_with_proof_execution_mode'))
  assert.ok(violations.includes('active_live_rows_without_production_launch'))
  assert.ok(violations.includes('active_live_rows_without_auto_send'))
})

test('explicitly paused campaign does not raise auto_send violations', () => {
  const paused = { status: 'paused', auto_send_enabled: false, metadata: { production_launch: true } }
  const violations = detectCampaignImpossibleStates(paused, { liveQueueRows: 50, explicitlyPaused: true })
  assert.equal(violations.length, 0)
})

test('assertCampaignExecutionConsistent throws on impossible state and passes when healthy', () => {
  assert.throws(
    () => assertCampaignExecutionConsistent(brokenSplitBrainCampaign(), { liveQueueRows: 50 }),
    /campaign_execution_impossible_state/,
  )
  assert.equal(assertCampaignExecutionConsistent(fullyLiveCampaign(), { liveQueueRows: 50 }), true)
})

test('ACTIVE_QUEUE_STATUSES excludes terminal/proof-cancelled statuses', () => {
  assert.ok(ACTIVE_QUEUE_STATUSES.includes('scheduled'))
  assert.ok(!ACTIVE_QUEUE_STATUSES.includes('cancelled'))
  assert.ok(!ACTIVE_QUEUE_STATUSES.includes('sent'))
})

// ---------------------------------------------------------------------------
// Queue separation
// ---------------------------------------------------------------------------

test('countLiveConfirmedQueueRows excludes proof rows', async () => {
  const rows = [...Array(50)].map((_, i) => liveRow(`l${i}`)).concat([...Array(6)].map((_, i) => proofRow(`p${i}`)))
  const supabase = makeFakeSupabase({ campaign: brokenSplitBrainCampaign(), queueRows: rows })
  assert.equal(await countLiveConfirmedQueueRows(supabase, 'dbcfe227-4423-4b74-bb28-2af02c45dde7'), 50)
})

// ---------------------------------------------------------------------------
// Reconciliation (self-heal)
// ---------------------------------------------------------------------------

test('reconcileCampaignLiveState repairs the split-brain campaign atomically', async () => {
  const rows = [...Array(50)].map((_, i) => liveRow(`l${i}`)).concat([...Array(6)].map((_, i) => proofRow(`p${i}`)))
  const supabase = makeFakeSupabase({ campaign: brokenSplitBrainCampaign(), queueRows: rows })
  const result = await reconcileCampaignLiveState('dbcfe227-4423-4b74-bb28-2af02c45dde7', { ...noopDeps(), supabase })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'live_state_repaired')
  assert.equal(result.repaired, true)
  assert.equal(result.live_queue_rows, 50)
  assert.equal(result.campaign.auto_send_enabled, true)
  assert.equal(result.campaign.auto_queue_enabled, true)
  assert.equal(result.campaign.auto_reply_mode, 'live_limited')
  assert.equal(result.campaign.metadata.production_launch, true)
  assert.equal(result.campaign.metadata.test_mode_cleared, true)
  assert.equal(isCampaignFullyLive(result.campaign), true)
  assert.deepEqual(result.residual_violations, [])
})

test('reconcile is idempotent on an already-live campaign (no rewrite)', async () => {
  const rows = [...Array(50)].map((_, i) => liveRow(`l${i}`))
  const supabase = makeFakeSupabase({ campaign: fullyLiveCampaign(), queueRows: rows })
  const result = await reconcileCampaignLiveState('live-1', { ...noopDeps(), supabase })
  assert.equal(result.repaired, false)
  assert.equal(result.outcome, 'already_live_and_healthy')
})

// ---------------------------------------------------------------------------
// Orchestrator parity — mobile & desktop route through this single entry
// ---------------------------------------------------------------------------

test('runCanonicalCampaignActivation reconciles instead of returning stale "already active"', async () => {
  const rows = [...Array(50)].map((_, i) => liveRow(`l${i}`)).concat([...Array(6)].map((_, i) => proofRow(`p${i}`)))
  const supabase = makeFakeSupabase({ campaign: brokenSplitBrainCampaign(), queueRows: rows })
  const result = await runCanonicalCampaignActivation(
    'dbcfe227-4423-4b74-bb28-2af02c45dde7',
    { action: 'activate' },
    { ...noopDeps(), supabase },
  )

  assert.equal(result.ok, true)
  assert.equal(result.reconciled, true)
  assert.equal(result.outcome, 'live_state_repaired')
  assert.equal(result.inserted, 0, 'repair must not create additional rows')
  assert.equal(isCampaignFullyLive(supabase._state.campaign), true)
})

test('repeated activation of a repaired campaign stays idempotent and healthy', async () => {
  const rows = [...Array(50)].map((_, i) => liveRow(`l${i}`))
  const supabase = makeFakeSupabase({ campaign: fullyLiveCampaign(), queueRows: rows })
  const deps = { ...noopDeps(), supabase }
  const first = await runCanonicalCampaignActivation('live-1', { action: 'activate' }, deps)
  const second = await runCanonicalCampaignActivation('live-1', { action: 'activate' }, deps)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.idempotent, true)
  assert.notEqual(second.outcome, 'live_state_repaired')
  assert.equal(isCampaignFullyLive(supabase._state.campaign), true)
})
