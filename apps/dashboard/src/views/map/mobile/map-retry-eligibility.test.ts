import { describe, expect, it } from 'vitest'
import { retryVerdict, type QueueRetryRow } from './map-retry-eligibility'

const NOW = Date.parse('2026-10-01T15:00:00Z')
const minutes = (n: number) => new Date(NOW + n * 60_000).toISOString()

function row(overrides: Partial<QueueRetryRow> = {}): QueueRetryRow {
  return {
    id: 'q1',
    queue_status: 'failed',
    retry_count: 1,
    max_retries: 3,
    next_retry_at: null,
    failed_reason: 'carrier_timeout',
    blocked_reason: null,
    paused_reason: null,
    guard_reason: null,
    sent_at: null,
    delivered_at: null,
    scheduled_for_utc: null,
    scheduled_for: null,
    updated_at: minutes(-12),
    ...overrides,
  }
}

const verdict = (r: QueueRetryRow | null | undefined, extra: Partial<Parameters<typeof retryVerdict>[0]> = {}) =>
  retryVerdict({ row: r, finalFailure: false, suppressed: false, authority: { ok: true }, now: NOW, ...extra })

describe('retry send is a state, not a generic button', () => {
  it('offers a retry only when the row is still failed and the queue authority would take it', () => {
    const v = verdict(row())
    expect(v.kind).toBe('eligible')
    expect(v.line).toContain('failed 12m ago')
    expect(v.line).toContain("the queue's checks still decide")
    expect(v.meta).toBe('1 of 3 attempts used · Carrier timeout')
  })

  it('says the authority is still being asked instead of offering the button early', () => {
    expect(verdict(row(), { authority: undefined }).kind).toBe('checking')
    expect(verdict(undefined).kind).toBe('checking')
  })

  it('names the authority refusal in words: a duplicate would double-text', () => {
    const v = verdict(row(), { authority: { ok: false, reason: 'duplicate_active_or_sent_queue_row' } })
    expect(v.kind).toBe('held')
    expect(v.line).toMatch(/double-text/)
  })

  it('names outbound off and runner off', () => {
    expect(verdict(row(), { authority: { ok: false, reason: 'outbound_sms_disabled' } }).line).toMatch(/Outbound SMS is switched off/)
    expect(verdict(row(), { authority: { ok: false, reason: 'queue_runner_disabled' } }).line).toMatch(/queue runner is off/)
  })

  it('a network failure is "could not reach", never a refusal', () => {
    const v = verdict(row(), { authority: { ok: false, reason: 'BACKEND_NETWORK_ERROR' } })
    expect(v.kind).toBe('unknown')
    expect(v.line).toMatch(/Could not reach the queue/)
  })

  it('an automatic retry already scheduled is shown, with no button', () => {
    const v = verdict(row({ queue_status: 'queued', next_retry_at: minutes(4) }))
    expect(v.kind).toBe('in_queue')
    expect(v.line).toBe('The queue retries this automatically in 4 min.')
  })

  it('a row already back in the queue says when it is due', () => {
    const v = verdict(row({ queue_status: 'scheduled', scheduled_for_utc: minutes(30) }))
    expect(v.kind).toBe('in_queue')
    expect(v.line).toBe('Already back in the queue, due in 30 min.')
  })

  it('a later attempt that was delivered closes the question', () => {
    const v = verdict(row({ queue_status: 'delivered', delivered_at: minutes(-3) }))
    expect(v.kind).toBe('went_out')
    expect(v.line).toBe('A later attempt was delivered 3m ago.')
  })

  it('a later attempt that went out but is unconfirmed says so', () => {
    expect(verdict(row({ queue_status: 'sent', sent_at: minutes(-1) })).line).toBe('A later attempt went out 1m ago. Delivery is not confirmed yet.')
  })

  it('a carrier-final failure is closed, whatever the authority says', () => {
    const v = verdict(row(), { finalFailure: true })
    expect(v.kind).toBe('closed')
    expect(v.line).toMatch(/final/)
  })

  it('a suppressed number is closed before anything else', () => {
    expect(verdict(row({ queue_status: 'queued' }), { suppressed: true }).kind).toBe('closed')
  })

  it('a guard-held row is not offered a retry (the guard decides)', () => {
    const v = verdict(row({ queue_status: 'blocked_by_health_guard', blocked_reason: 'sender_cooling' }))
    expect(v.kind).toBe('held')
    expect(v.line).toBe('Held by the queue: sender cooling. The guard decides, not a retry.')
  })

  it('out of automatic attempts: a deliberate retry is offered, and says the queue stopped', () => {
    const v = verdict(row({ queue_status: 'paused_max_retries', retry_count: 3 }))
    expect(v.kind).toBe('eligible')
    expect(v.line).toMatch(/stopped after its last attempt/)
    expect(v.meta).toMatch(/^3 of 3 attempts used/)
  })

  it('cancelled, expired and replied-first rows are closed', () => {
    expect(verdict(row({ queue_status: 'cancelled' })).kind).toBe('closed')
    expect(verdict(row({ queue_status: 'expired' })).kind).toBe('closed')
    expect(verdict(row({ queue_status: 'replied_before_send' })).line).toBe('The seller replied before it went out.')
  })

  it('a missing row is said plainly', () => {
    expect(verdict(null).line).toBe('The queue row behind this message is no longer there.')
  })
})
