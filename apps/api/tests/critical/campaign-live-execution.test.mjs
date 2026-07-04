import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProductionQueueRailsPatch,
  syncProductionQueueRailsFromCampaign,
  finalizeOperatorLiveActivation,
  CANONICAL_FULL_AUTOPILOT_MODE,
  isCampaignFullyLive,
  isCampaignLiveInconsistent,
  mergeLaunchWriteModeIntoInput,
  resolveCampaignLaunchWriteMode,
} from '@/lib/domain/campaigns/campaign-live-execution.js'
import { buildProductionLiveCampaignPersistencePatch } from '@/lib/domain/campaigns/campaign-canonical-write.js'
import { validateLiveLimitedRails } from '@/lib/domain/queue/queue-control-safety.js'
import { handleQueueRunRequest } from '@/lib/domain/queue/queue-run-request.js'
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

test('production queue rails patch uses campaign caps not stale canary limits', () => {
  const patch = buildProductionQueueRailsPatch({
    batch_max: 50,
    daily_cap: 750,
    market_cap: 400,
    per_sender_cap: 150,
    market: 'Miami, FL',
    metadata: { production_launch: true },
  })
  assert.equal(patch.queue_max_batch_size, '50')
  assert.equal(patch.queue_daily_send_cap, '750')
  assert.equal(patch.queue_market_cap, '400')
  assert.equal(patch.queue_per_number_cap, '150')
  assert.equal(patch.queue_run_limit, '50')
  assert.equal(patch.queue_emergency_stop_at, '')
  // Global inbound auto-reply containment is decoupled from outbound rails:
  // the rails patch must NEVER carry auto_reply_mode (see decoupling tests below).
  assert.equal(patch.auto_reply_mode, undefined)
  assert.equal('auto_reply_mode' in patch, false)
})

// ── auto_reply_mode decoupling (global inbound containment must not be ────────
//    overwritten by outbound campaign queue-rail synchronization) ─────────────

const OUTBOUND_RAILS_KEYS = [
  'queue_processor_mode',
  'queue_auto_enqueue_enabled',
  'queue_auto_send_enabled',
  'outbound_sms_enabled',
  'campaign_mode',
  'queue_execution_mode',
  'queue_run_limit',
  'queue_hard_cap',
  'queue_max_batch_size',
  'queue_daily_send_cap',
  'queue_market_cap',
  'queue_per_number_cap',
]

function liveProductionCampaign(overrides = {}) {
  return {
    id: 'camp-1',
    status: 'active',
    auto_queue_enabled: true,
    auto_send_enabled: true,
    auto_reply_mode: 'live_limited',
    batch_max: 50,
    daily_cap: 750,
    market_cap: 400,
    per_sender_cap: 150,
    market: 'Miami, FL',
    metadata: { production_launch: true },
    ...overrides,
  }
}

test('buildProductionQueueRailsPatch omits auto_reply_mode but keeps outbound rails', () => {
  const patch = buildProductionQueueRailsPatch(liveProductionCampaign())
  assert.equal('auto_reply_mode' in patch, false)
  // All legitimate outbound rails are still present.
  for (const key of OUTBOUND_RAILS_KEYS) {
    assert.ok(key in patch, `expected rails patch to still set ${key}`)
  }
  assert.equal(patch.campaign_mode, 'live_limited')
  assert.equal(patch.queue_processor_mode, 'on')
  assert.equal(patch.queue_auto_send_enabled, 'true')
  assert.equal(patch.queue_market_filter, 'Miami, FL')
})

test('syncProductionQueueRailsFromCampaign never writes auto_reply_mode to system_control', async () => {
  const writes = []
  const res = await syncProductionQueueRailsFromCampaign(liveProductionCampaign(), {
    setSystemValues: async (payload) => {
      writes.push(payload)
      return { ok: true }
    },
  })
  assert.equal(res.ok, true)
  assert.equal(writes.length, 1)
  assert.equal('auto_reply_mode' in writes[0], false)
  // Outbound rails still synchronized.
  assert.equal(writes[0].queue_auto_send_enabled, 'true')
  assert.equal(writes[0].campaign_mode, 'live_limited')
})

test('campaign rails sync leaves an existing internal_only mode unchanged', async () => {
  // Simulate the global containment already set to internal_only. The rails sync
  // must not include auto_reply_mode, so the persisted value survives intact.
  let systemAutoReplyMode = 'internal_only'
  await syncProductionQueueRailsFromCampaign(liveProductionCampaign(), {
    setSystemValues: async (payload) => {
      if ('auto_reply_mode' in payload) systemAutoReplyMode = payload.auto_reply_mode
      return { ok: true }
    },
  })
  assert.equal(systemAutoReplyMode, 'internal_only')
})

test('campaign rails sync leaves an existing live_limited mode unchanged', async () => {
  let systemAutoReplyMode = 'live_limited'
  await syncProductionQueueRailsFromCampaign(liveProductionCampaign(), {
    setSystemValues: async (payload) => {
      if ('auto_reply_mode' in payload) systemAutoReplyMode = payload.auto_reply_mode
      return { ok: true }
    },
  })
  assert.equal(systemAutoReplyMode, 'live_limited')
})

test('multiple active campaigns and repeated 5-min feed ticks cannot change auto_reply_mode', async () => {
  // Model the campaigns/feed + activate-due crons re-running the rails sync for
  // several live campaigns across many ticks. internal_only must survive all of them.
  let systemAutoReplyMode = 'internal_only'
  const campaigns = [
    liveProductionCampaign({ id: 'tax-delinquent', market: 'Nashville, TN' }),
    liveProductionCampaign({ id: 'miami-test', market: 'Miami, FL' }),
    liveProductionCampaign({ id: 'la-multifamily', market: 'Los Angeles, CA' }),
  ]
  for (let tick = 0; tick < 5; tick += 1) {
    for (const campaign of campaigns) {
      await syncProductionQueueRailsFromCampaign(campaign, {
        setSystemValues: async (payload) => {
          if ('auto_reply_mode' in payload) systemAutoReplyMode = payload.auto_reply_mode
          return { ok: true }
        },
      })
    }
  }
  assert.equal(systemAutoReplyMode, 'internal_only')
})

test('finalizeOperatorLiveActivation (activate-due path) never writes auto_reply_mode to system_control', async () => {
  const systemWrites = []
  const supabase = {
    from(table) {
      if (table !== 'campaigns') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: liveProductionCampaign({ id: 'la-1' }), error: null }),
          }),
        }),
        update: (patch) => ({
          eq: () => ({
            select: () => ({
              maybeSingle: async () => ({
                data: { ...liveProductionCampaign({ id: 'la-1' }), ...patch, metadata: { production_launch: true } },
                error: null,
              }),
            }),
          }),
        }),
      }
    },
  }
  const result = await finalizeOperatorLiveActivation('la-1', { batch_max: 50 }, {
    supabase,
    setSystemValues: async (payload) => {
      systemWrites.push(payload)
      return { ok: true }
    },
    runSendQueue: async () => ({ ok: true, sent_count: 0, claimed_count: 0, results: [] }),
  })
  assert.equal(result.ok, true)
  assert.ok(systemWrites.length >= 1, 'expected at least one system_control write (queue rails)')
  for (const payload of systemWrites) {
    assert.equal('auto_reply_mode' in payload, false, 'no system_control write may carry auto_reply_mode')
  }
})

test('campaign row still carries its own auto_reply_mode (campaign-level field is NOT removed)', () => {
  // Decoupling removes ONLY the system_control global write. The campaign row's
  // own auto_reply_mode (persistence patch) remains live_limited when going live.
  const patch = buildProductionLiveCampaignPersistencePatch(
    liveProductionCampaign(),
    { scheduled_for: '2026-07-05T13:00:00.000Z' },
    { status: 'active', execution_mode: 'immediate_live' },
  )
  assert.equal(patch.auto_reply_mode, CANONICAL_FULL_AUTOPILOT_MODE)
})

test('live limited rails auto-cap dispatch limit instead of rejecting cron default', () => {
  const validation = validateLiveLimitedRails({
    campaign_mode: 'live_limited',
    limit: 50,
    hard_cap: 5,
    max_batch_size: 5,
    daily_cap: 5,
    market_cap: 5,
    per_number_cap: 5,
  }, { require_scope: false, require_send_caps: true })
  assert.equal(validation.ok, true)
  assert.equal(validation.effective_limit, 5)
})

test('finalizeOperatorLiveActivation applies live patch and kicks processor', async () => {
  const updates = []
  const supabase = {
    from(table) {
      if (table !== 'campaigns') throw new Error(`unexpected table ${table}`)
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: {
                    id: 'la-1',
                    status: 'active',
                    batch_max: 5,
                    daily_cap: 750,
                    market_cap: 400,
                    per_sender_cap: 150,
                    market: 'Los Angeles, CA',
                    metadata: { production_launch: true },
                  },
                  error: null,
                }),
              }
            },
          }
        },
        update(patch) {
          updates.push(patch)
          return {
            eq() {
              return {
                select() {
                  return {
                    maybeSingle: async () => ({
                      data: {
                        id: 'la-1',
                        status: 'active',
                        auto_send_enabled: true,
                        auto_reply_mode: 'live_limited',
                        batch_max: 5,
                        daily_cap: 750,
                        market_cap: 400,
                        per_sender_cap: 150,
                        market: 'Los Angeles, CA',
                        metadata: { production_launch: true },
                      },
                      error: null,
                    }),
                  }
                },
              }
            },
          }
        },
      }
    },
  }

  const result = await finalizeOperatorLiveActivation('la-1', { batch_max: 5 }, {
    supabase,
    setSystemValues: async () => ({}),
    runSendQueue: async () => ({ ok: true, sent_count: 2, claimed_count: 2, results: [] }),
  })

  assert.equal(result.ok, true)
  assert.ok(updates.some((patch) => patch.auto_send_enabled === true))
  assert.equal(result.processor_result?.ok, true)
})

test('internal queue run passes when request limit exceeds configured hard cap', async () => {
  const runCalls = []
  const responses = []
  await handleQueueRunRequest(
    { url: 'https://app.example.com/api/internal/queue/run', json: async () => ({}) },
    'GET',
    {
      requireCronAuth: () => ({
        authorized: true,
        auth: { authenticated: true, is_vercel_cron: true },
        response: null,
      }),
      getSystemValue: async (key) => {
        const values = {
          queue_processor_mode: 'on',
          queue_execution_mode: 'normal',
          campaign_mode: 'live_limited',
          queue_hard_cap: '5',
          queue_max_batch_size: '5',
          queue_daily_send_cap: '5',
          queue_market_cap: '5',
          queue_per_number_cap: '5',
          queue_run_limit: '5',
          queue_emergency_stop_at: '',
        }
        return values[key] ?? null
      },
      runSendQueue: async (opts) => {
        runCalls.push(opts)
        return { ok: true, sent_count: 1, claimed_count: 1, results: [] }
      },
      logger: { info() {}, warn() {}, error() {} },
      jsonResponse: (body, init) => {
        responses.push({ body, status: init?.status ?? 200 })
        return { body, status: init?.status ?? 200 }
      },
    },
  )
  assert.equal(responses[0]?.status, 200)
  assert.equal(runCalls[0]?.limit, 5)
})