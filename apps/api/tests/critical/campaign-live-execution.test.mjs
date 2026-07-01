import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CANONICAL_FULL_AUTOPILOT_MODE,
  isCampaignFullyLive,
  isCampaignLiveInconsistent,
  mergeLaunchWriteModeIntoInput,
  resolveCampaignLaunchWriteMode,
} from '@/lib/domain/campaigns/campaign-live-execution.js'
import { convertTestCampaignToLive } from '@/lib/domain/campaigns/campaign-convert-to-live.js'
import { resolveCampaignQueueWriteMode } from '@/lib/domain/campaigns/campaign-automation-service.js'
import { makeTerminalQuery } from '../helpers/chainable-supabase.mjs'

test('canonical Full Autopilot mode is live_limited', () => {
  assert.equal(CANONICAL_FULL_AUTOPILOT_MODE, 'live_limited')
})

test('active campaign with auto_send disabled is live inconsistent when production launch', () => {
  const inconsistent = isCampaignLiveInconsistent({
    status: 'active',
    auto_queue_enabled: true,
    auto_send_enabled: false,
    auto_reply_mode: 'disabled',
    metadata: { production_launch: true },
  })
  assert.equal(inconsistent, true)
})

test('fully live campaign is not inconsistent', () => {
  const campaign = {
    status: 'active',
    auto_queue_enabled: true,
    auto_send_enabled: true,
    auto_reply_mode: 'live_limited',
    metadata: { production_launch: true, converted_to_live_at: '2026-06-30T00:00:00.000Z' },
  }
  assert.equal(isCampaignFullyLive(campaign), true)
  assert.equal(isCampaignLiveInconsistent(campaign), false)
})

test('production live campaign never resolves to proof mode', () => {
  const campaign = {
    status: 'active',
    auto_send_enabled: true,
    auto_queue_enabled: true,
    auto_reply_mode: 'live_limited',
    metadata: { production_launch: true },
  }
  const mode = resolveCampaignLaunchWriteMode(campaign, { lock_owner: 'campaign_feeder' })
  assert.equal(mode.no_send, false)
  assert.equal(mode.confirm_live, true)
  assert.equal(mode.proof_hydration, false)
  assert.equal(mode.launch_mode, 'guarded_live_queue_creation')
})

test('test preview explicitly requests proof hydration', () => {
  const mode = resolveCampaignLaunchWriteMode(
    { status: 'active', metadata: {} },
    { no_send: true, proof_hydration: true },
  )
  assert.equal(mode.no_send, true)
  assert.equal(mode.proof_hydration, true)
})

test('live write mode allows auto_send enabled production campaigns', () => {
  const campaign = {
    status: 'active',
    auto_send_enabled: true,
    auto_reply_mode: 'live_limited',
    auto_queue_enabled: true,
    metadata: { production_launch: true },
  }
  const writeMode = resolveCampaignQueueWriteMode(
    { confirm_live: true, no_send: false, production_live_write: true, dry_run: false },
    campaign,
  )
  assert.equal(writeMode.isLiveSendWrite, true)
  assert.equal(writeMode.productionLiveWrite, true)
})

test('convert to live reconciles already-active auto-send-disabled campaign', async () => {
  const campaignId = 'miami-test-campaign'
  const updates = []
  const inserts = []
  const supabase = {
    from(table) {
      if (table === 'campaigns') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: campaignId,
                  name: 'Miami - Test Campaign',
                  status: 'active',
                  auto_queue_enabled: true,
                  auto_send_enabled: false,
                  auto_reply_mode: 'disabled',
                  daily_cap: 750,
                  batch_max: 50,
                  market_cap: 400,
                  per_sender_cap: 150,
                  total_cap: 802,
                  contact_window_start: '08:00',
                  contact_window_end: '21:00',
                  market: 'Miami, FL',
                  metadata: {},
                  queued_count: 0,
                  sent_count: 16,
                },
                error: null,
              }),
              single: async () => ({
                data: {
                  id: campaignId,
                  status: 'active',
                  auto_queue_enabled: true,
                  auto_send_enabled: false,
                  auto_reply_mode: 'disabled',
                  daily_cap: 750,
                  batch_max: 50,
                  market_cap: 400,
                  per_sender_cap: 150,
                  total_cap: 802,
                  metadata: {},
                },
                error: null,
              }),
            }),
          }),
          update: (patch) => ({
            eq: () => ({
              select: () => ({
                maybeSingle: async () => {
                  updates.push(patch)
                  return {
                    data: { id: campaignId, ...patch, status: 'active' },
                    error: null,
                  }
                },
              }),
            }),
          }),
        }
      }
      if (table === 'send_queue') {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                limit: async () => ({ data: [], error: null }),
                filter: () => ({
                  order: () => ({
                    limit: async () => ({ data: [], error: null }),
                  }),
                }),
              }),
              filter: () => ({
                order: () => ({
                  limit: async () => ({ data: [], error: null }),
                }),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              in: () => ({
                filter: () => ({
                  select: async () => ({ data: [], error: null }),
                }),
                select: async () => ({ data: [], error: null }),
              }),
              filter: () => ({
                select: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'campaign_events') {
        return {
          insert: async (row) => {
            inserts.push(row)
            return { error: null }
          },
        }
      }
      return makeTerminalQuery()
    },
  }

  const result = await convertTestCampaignToLive(
    campaignId,
    { confirm_live: true, batch_max: 5, enable_processor: false },
    {
      supabase,
      recomputeCampaignProgress: async () => ({ ok: true }),
      getSystemValue: async () => null,
      setSystemValues: async () => ({}),
      createCampaignQueuePlan: async () => ({
        ok: true,
        send_queue_rows_created: 5,
        skipped_count: 0,
        blockers: [],
      }),
      runCanonicalCampaignActivation: async () => ({
        ok: true,
        inserted: 0,
        skipped: 0,
        steps: [],
      }),
      buildCampaignCommandSummary: async () => ({
        ok: true,
        state: 'live',
        state_label: 'Live',
        mode: 'live',
        counts: { live_send_rows: 5 },
        blockers: [],
        warnings: [],
        execution: { proof_mode: false, transmission_enabled: true },
      }),
      syncCampaignMetrics: async () => ({ ok: true }),
      setSystemValues: async () => ({}),
      getSystemValue: async () => null,
    },
  )

  assert.equal(result.ok, true)
  assert.ok(['live_state_repaired', 'successfully_converted'].includes(result.outcome))
  const livePatch = updates.find((patch) => patch.auto_send_enabled === true)
  assert.ok(livePatch)
  assert.equal(livePatch.auto_reply_mode, 'live_limited')
  assert.equal(livePatch.metadata.production_launch, true)
})