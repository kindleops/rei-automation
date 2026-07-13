import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  classifyBackendFailure,
  opsError,
  opsSuccess,
} from '../../src/domain/ops/ops-surface-result'
import { fetchCampaignsSurface } from '../../src/views/campaign-command/campaigns.adapter'
import { loadPipelineOpportunitiesSurface } from '../../src/domain/pipeline/pipeline-surface-loader'
import { loadWorkflowAutomationActivitySurface } from '../../src/views/workflow-studio/workflow-automation-activity.adapter'
import { loadWorkflowStudioSurface } from '../../src/views/workflow-studio/workflowStudio.adapter'
import * as backendClient from '../../src/lib/api/backendClient'

const { supabaseMockState } = vi.hoisted(() => ({
  supabaseMockState: {
    hasEnv: false,
    campaigns: [] as Array<Record<string, unknown>>,
    campaignTargets: [] as Array<Record<string, unknown>>,
  },
}))

vi.mock('../../src/lib/supabaseClient', () => ({
  get hasSupabaseEnv() {
    return supabaseMockState.hasEnv
  },
  getSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'campaigns') {
        return {
          select: () => ({
            order: () => ({
              limit: async () => ({ data: supabaseMockState.campaigns, error: null }),
            }),
          }),
        }
      }
      if (table === 'campaign_targets') {
        return {
          select: () => ({
            in: async () => ({ data: supabaseMockState.campaignTargets, error: null }),
          }),
        }
      }
      return {
        select: () => ({
          order: () => ({
            limit: async () => ({ data: [], error: null }),
          }),
        }),
      }
    },
  }),
}))

describe('ops surface shared handling', () => {
  it('13. typed degraded result preserves retryable error', () => {
    const result = opsError([], 'backend_unavailable', 'upstream down', { degraded: true, retryable: true, source: 'backend_api' })
    expect(result.ok).toBe(false)
    expect(result.degraded).toBe(true)
    expect(result.retryable).toBe(true)
    expect(result.errorType).toBe('backend_unavailable')
  })

  it('classifies auth failures distinctly from query failures', () => {
    expect(classifyBackendFailure({ ok: false, status: 401, error: 'unauthorized', message: 'unauthorized' })).toBe('auth_error')
    expect(classifyBackendFailure({ ok: false, status: 500, error: 'query_failed', message: 'db error' })).toBe('query_failed')
    expect(classifyBackendFailure({
      ok: false,
      status: 404,
      error: 'BACKEND_HTML_ERROR',
      message: 'Backend returned an HTML error page instead of JSON.',
    })).toBe('backend_unavailable')
  })
})

describe('Campaign Command surface truth', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    supabaseMockState.hasEnv = false
    supabaseMockState.campaigns = []
    supabaseMockState.campaignTargets = []
  })

  it('1. backend auth failure does not return empty successful campaigns', async () => {
    vi.spyOn(backendClient, 'listCampaignsBackend').mockResolvedValue({
      ok: false,
      status: 401,
      error: 'unauthorized',
      message: '[401] unauthorized',
    })
    const result = await fetchCampaignsSurface()
    expect(result.ok).toBe(false)
    expect(result.errorType).toBe('auth_error')
    expect(result.data).toEqual([])
  })

  it('2. missing fallback view does not show success empty campaigns', async () => {
    vi.spyOn(backendClient, 'listCampaignsBackend').mockResolvedValue({
      ok: false,
      status: 503,
      error: 'BACKEND_NOT_CONFIGURED',
      message: 'backend unavailable',
    })
    const result = await fetchCampaignsSurface()
    expect(result.ok).toBe(false)
    expect(result.data).toEqual([])
    expect(result.errorType).toBe('backend_unavailable')
  })

  it('3. canonical campaign rows render from backend', async () => {
    vi.spyOn(backendClient, 'listCampaignsBackend').mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        ok: true,
        campaigns: [{
          id: 'c1',
          campaign_name: 'Dallas Launch',
          status: 'active',
          total_targets: 12,
          ready_targets: 4,
          scheduled_targets: 1,
          queued_targets: 2,
          sent_count: 0,
          delivered_count: 0,
          failed_count: 0,
          reply_count: 0,
          positive_reply_count: 0,
          negative_reply_count: 0,
          opt_out_count: 0,
          delivery_rate: 0,
          reply_rate: 0,
          positive_rate: 0,
          opt_out_rate: 0,
          failure_rate: 0,
          next_send_at: null,
          last_send_at: null,
          send_interval_seconds: 900,
          auto_send_enabled: false,
          health_score: 80,
          health_status: 'healthy',
        }],
      },
    })
    const result = await fetchCampaignsSurface()
    expect(result.ok).toBe(true)
    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.campaign_name).toBe('Dallas Launch')
    expect(result.source).toBe('backend_api')
  })

  it('4. true zero campaigns shows successful empty state', async () => {
    vi.spyOn(backendClient, 'listCampaignsBackend').mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, campaigns: [] },
    })
    const result = await fetchCampaignsSurface()
    expect(result.ok).toBe(true)
    expect(result.data).toEqual([])
    expect(result.errorType).toBeUndefined()
  })

  it('4b. empty RLS fallback after backend failure is not a successful empty list', async () => {
    supabaseMockState.hasEnv = true
    supabaseMockState.campaigns = []
    vi.spyOn(backendClient, 'listCampaignsBackend').mockResolvedValue({
      ok: false,
      status: 404,
      error: 'BACKEND_HTML_ERROR',
      message: 'Backend returned an HTML error page instead of JSON.',
    })
    const result = await fetchCampaignsSurface()
    expect(result.ok).toBe(false)
    expect(result.data).toEqual([])
    expect(result.errorType).toBe('backend_unavailable')
    expect(result.degraded).toBe(true)
    expect(result.source).toBe('supabase_campaigns')
  })

  it('4c. non-empty RLS fallback still degrades when backend fails', async () => {
    supabaseMockState.hasEnv = true
    supabaseMockState.campaigns = [{
      id: 'c-fallback',
      name: 'Fallback Campaign',
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      metadata: {},
      auto_send_enabled: false,
      send_interval_seconds: 900,
      send_window_start: null,
      send_window_end: null,
    }]
    supabaseMockState.campaignTargets = [
      { campaign_id: 'c-fallback', status: 'ready' },
      { campaign_id: 'c-fallback', status: 'sent' },
    ]
    vi.spyOn(backendClient, 'listCampaignsBackend').mockResolvedValue({
      ok: false,
      status: 502,
      error: 'BACKEND_UNAVAILABLE',
      message: 'backend down',
    })
    const result = await fetchCampaignsSurface()
    expect(result.ok).toBe(true)
    expect(result.degraded).toBe(true)
    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.campaign_name).toBe('Fallback Campaign')
    expect(result.source).toBe('supabase_campaigns')
  })
})

describe('Pipeline surface truth', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('5. backend 500 does not show blank successful pipeline payload', async () => {
    vi.spyOn(backendClient, 'callBackend').mockResolvedValue({
      ok: false,
      status: 500,
      error: 'pipeline_opportunities_fetch_failed',
      message: '[500] pipeline_opportunities_fetch_failed',
      upstream: { ok: false, errorType: 'query_failed', message: 'db exploded' },
    })
    const result = await loadPipelineOpportunitiesSurface({ limit: 10 })
    expect(result.ok).toBe(false)
    expect(result.data.rows).toEqual([])
    expect(result.errorType).toBe('query_failed')
  })

  it('6. auth failure shows auth error', async () => {
    vi.spyOn(backendClient, 'callBackend').mockResolvedValue({
      ok: false,
      status: 401,
      error: 'unauthorized',
      message: '[401] unauthorized',
      upstream: { ok: false, errorType: 'auth_error', message: 'Dashboard authentication required' },
    })
    const result = await loadPipelineOpportunitiesSurface({ limit: 10 })
    expect(result.errorType).toBe('auth_error')
    expect(result.retryable).toBe(true)
  })

  it('7. canonical opportunities render', async () => {
    vi.spyOn(backendClient, 'callBackend').mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        ok: true,
        data: [{ id: 'opp-1', pipeline_stage: 'qualified', universal_status: 'active' }],
        total: 1,
        pagination: { limit: 10, offset: 0, has_more: false },
      },
    })
    const result = await loadPipelineOpportunitiesSurface({ limit: 10 })
    expect(result.ok).toBe(true)
    expect(result.data.rows).toHaveLength(1)
    expect(result.data.rows[0]?.id).toBe('opp-1')
  })

  it('8. true zero opportunities shows successful empty state', async () => {
    vi.spyOn(backendClient, 'callBackend').mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, data: [], total: 0, pagination: { limit: 10, offset: 0, has_more: false } },
    })
    const result = await loadPipelineOpportunitiesSurface({ limit: 10 })
    expect(result.ok).toBe(true)
    expect(result.data.rows).toEqual([])
    expect(result.data.total).toBe(0)
  })
})

describe('Workflow Studio automation surface truth', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('9. empty workflow tables but send_queue follow-ups exist shows automation activity', async () => {
    vi.spyOn(backendClient, 'callBackend').mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        ok: true,
        data: {
          activity: [{
            id: 'sq-1',
            source: 'send_queue_followup',
            status: 'scheduled',
            touch_number: 2,
            seller_label: 'Jordan',
            property_label: '123 Main',
          }],
          counts: { workflow_enrollments: 0, workflow_scheduled_tasks: 0, send_queue_followups: 1, total: 1 },
          sources_present: { workflow_v2: false, send_queue_followup: true },
        },
      },
    })
    const result = await loadWorkflowAutomationActivitySurface()
    expect(result.ok).toBe(true)
    expect(result.data.activity).toHaveLength(1)
    expect(result.data.counts.send_queue_followups).toBe(1)
  })

  it('10. pending follow-up row appears with source send_queue_followup', async () => {
    vi.spyOn(backendClient, 'callBackend').mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        ok: true,
        data: {
          activity: [{ id: 'sq-2', source: 'send_queue_followup', status: 'queued', touch_number: 3 }],
          counts: { workflow_enrollments: 0, workflow_scheduled_tasks: 0, send_queue_followups: 1, total: 1 },
          sources_present: {},
        },
      },
    })
    const result = await loadWorkflowAutomationActivitySurface()
    expect(result.data.activity[0]?.source).toBe('send_queue_followup')
  })

  it('11. stopped/cancelled automation reason renders in payload', async () => {
    vi.spyOn(backendClient, 'callBackend').mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        ok: true,
        data: {
          activity: [{ id: 'en-1', source: 'workflow_v2', status: 'paused', stopped_reason: 'human_review_required' }],
          counts: { workflow_enrollments: 1, workflow_scheduled_tasks: 0, send_queue_followups: 0, total: 1 },
          sources_present: {},
        },
      },
    })
    const result = await loadWorkflowAutomationActivitySurface()
    expect(result.data.activity[0]?.stopped_reason).toBe('human_review_required')
  })

  it('12. backend failure does not show fake empty automation list', async () => {
    vi.spyOn(backendClient, 'callBackend').mockResolvedValue({
      ok: false,
      status: 500,
      error: 'automation_activity_fetch_failed',
      message: '[500] automation_activity_fetch_failed',
    })
    const result = await loadWorkflowAutomationActivitySurface()
    expect(result.ok).toBe(false)
    expect(result.data.activity).toEqual([])
  })

  it('14. workflow list backend failure is typed, not fake empty success', async () => {
    vi.spyOn(backendClient, 'listWorkflowsBackend').mockResolvedValue({
      ok: false,
      status: 503,
      error: 'BACKEND_NOT_CONFIGURED',
      message: 'backend unavailable',
    })
    const result = await loadWorkflowStudioSurface()
    expect(result.ok).toBe(false)
    expect(result.data.workflows).toEqual([])
    expect(result.errorType).toBe('backend_unavailable')
  })
})