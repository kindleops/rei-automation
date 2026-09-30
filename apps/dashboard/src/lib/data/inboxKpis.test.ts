import { describe, expect, it, vi, beforeEach } from 'vitest'

const diagnostics = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('../api/backendClient', () => ({
  getCockpitOpsMetrics: vi.fn(async () => ({ ok: true, data: { diagnostics: diagnostics.current } })),
}))

import { fetchOperationalKpis } from './inboxKpis'

const base = {
  sent_count: 0, delivered_count: 0, failed_count: 0, received_count: 0,
  reply_rate: 0, positive_rate: 0, negative_rate: 0, delivery_rate: 0, failure_rate: 0, opt_out_rate: 0,
  queue_waiting_count: 0, queue_failed_today_count: 0, metric_source_debug: { message_rows: 10 },
}

describe('operational KPI truth', () => {
  beforeEach(() => { diagnostics.current = { ...base } })

  it('withholds the reply rate when replies outnumber the window’s deliveries (sending paused)', async () => {
    diagnostics.current = { ...base, delivered_count: 6, received_count: 12, reply_rate: 200, opt_out_rate: 33.3 }
    const k = await fetchOperationalKpis('24h')
    const reply = k.messaging.find((m) => m.id === 'reply-rate')!
    expect(reply.isAvailable).toBe(false)
    expect(reply.value).toBe('—')
    expect(k.messaging.find((m) => m.id === 'opt-out-rate')!.isAvailable).toBe(false)
  })

  it('withholds an impossible rate even with a large window', async () => {
    diagnostics.current = { ...base, delivered_count: 40, received_count: 90, reply_rate: 225 }
    const k = await fetchOperationalKpis('24h')
    expect(k.messaging.find((m) => m.id === 'reply-rate')!.isAvailable).toBe(false)
  })

  it('states the rate when the window supports it', async () => {
    diagnostics.current = { ...base, delivered_count: 400, received_count: 50, reply_rate: 12.5, opt_out_rate: 1.2 }
    const k = await fetchOperationalKpis('24h')
    const reply = k.messaging.find((m) => m.id === 'reply-rate')!
    expect(reply.isAvailable).toBe(true)
    expect(reply.value).toBe('12.5')
    expect(reply.unit).toBe('%')
  })

  it('never reports a fabricated zero for metrics this feed does not carry', async () => {
    const k = await fetchOperationalKpis('24h')
    for (const id of ['hot-leads', 'avg-acq-score']) {
      const m = k.quality.find((q) => q.id === id)!
      expect(m.isAvailable).toBe(false)
      expect(m.value).not.toBe(0)
      expect(m.value).not.toBe('0')
    }
  })
})
