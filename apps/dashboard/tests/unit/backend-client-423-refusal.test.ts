import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The API reports a REFUSAL (runtime brake, compliance block, execution lock,
// paused processor) as HTTP 423 with a body of { ok: false, reason }. The
// client used to rewrite that into { ok: true }, so a blocked composer send
// was painted as sent/delivered while nothing had left. This pins the
// contract: a 423 is a failure, carries the API's reason, and keeps the body
// reachable for the two lock-aware callers that test status === 423.

vi.mock('../../src/lib/supabaseClient', () => ({
  hasSupabaseEnv: false,
  getSupabaseClient: () => null,
  getSupabaseSession: async () => null,
}))

import { callBackend } from '../../src/lib/api/backendClient'

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('backendClient: HTTP 423 is a refusal, never a success', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    vi.stubEnv('VITE_BACKEND_API_URL', 'https://api.test.invalid')
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('maps a 423 brake refusal to ok:false with the API reason', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(423, {
        ok: false,
        blocked: true,
        reason: 'queue_processor_paused',
        message: 'queue_processor_mode is off/paused; live sends are blocked.',
        queue_inserted: false,
      }),
    ) as typeof fetch

    const result = await callBackend('/api/cockpit/inbox/send-now', { method: 'POST', body: '{}' })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(423)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toBe('queue_processor_paused')
    expect(result.message).toContain('live sends are blocked')
    // Lock-aware callers still get the body and the coordination markers.
    expect((result.upstream as Record<string, unknown>).locked).toBe(true)
    expect((result.upstream as Record<string, unknown>).coordination_state).toBe(true)
    expect((result.upstream as Record<string, unknown>).reason).toBe('queue_processor_paused')
  })

  it('never fabricates a queue id or delivery status on a 423', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(423, { ok: false, blocked: true, reason: 'compliance_blocked' }),
    ) as typeof fetch

    const result = await callBackend('/api/cockpit/inbox/send-now', { method: 'POST', body: '{}' })

    expect(result.ok).toBe(false)
    expect('data' in result).toBe(false)
  })

  it('a 200 with an ok body is still a success (no regression)', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, { ok: true, queue_row_id: 'q-1', delivery_status_display: 'sent' }),
    ) as typeof fetch

    const result = await callBackend('/api/cockpit/inbox/send-now', { method: 'POST', body: '{}' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect((result.data as Record<string, unknown>).queue_row_id).toBe('q-1')
  })
})
