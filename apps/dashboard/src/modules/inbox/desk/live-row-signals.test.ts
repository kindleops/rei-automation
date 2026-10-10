import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __rowSignalsTest,
  clearRowArrival,
  ingestInboxRealtimeSignal,
  normalizeSignalKey,
  onSignalTouched,
  readRowArrival,
  readRowSignal,
  seedRowStage,
} from './live-row-signals'

const KEY = '+16122232473'
const T0 = Date.parse('2026-10-01T15:00:00.000Z')
let release: () => void = () => {}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  vi.stubGlobal('window', globalThis)
  __rowSignalsTest.reset()
  release = __rowSignalsTest.enable()
})
afterEach(() => {
  release()
  __rowSignalsTest.reset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('keys', () => {
  it('one key per conversation, whatever shape the event names it in', () => {
    expect(normalizeSignalKey('+16122232473')).toBe('6122232473')
    expect(normalizeSignalKey('ct:prospect:p1|property:9|owner:m|phone:+16122232473')).toBe('6122232473')
    expect(normalizeSignalKey('(612) 223-2473')).toBe('6122232473')
    expect(normalizeSignalKey('property:12345678901')).toBe('property:12345678901')
    expect(normalizeSignalKey('')).toBe('')
  })
})

describe('signals come only from real events', () => {
  it('a seller message landing is an arrival, and is unread until opened', () => {
    ingestInboxRealtimeSignal({ table: 'message_events', eventType: 'INSERT', row: { direction: 'inbound', thread_key: KEY }, threadKey: KEY }, T0)
    expect(readRowSignal(KEY, T0)?.kind).toBe('arrival')
    expect(readRowArrival(KEY)).toBe(T0)
    clearRowArrival(KEY)
    expect(readRowArrival(KEY)).toBeNull()
  })

  it('our own outbound message is not an arrival', () => {
    ingestInboxRealtimeSignal({ table: 'message_events', eventType: 'INSERT', row: { direction: 'outbound' }, threadKey: KEY }, T0)
    expect(readRowSignal(KEY, T0)).toBeNull()
  })

  it('the automation queuing its reply reads "queued", sending reads "replying", sent settles', () => {
    ingestInboxRealtimeSignal({ table: 'send_queue', eventType: 'INSERT', row: { source: 'auto_reply', queue_status: 'queued' }, threadKey: KEY }, T0)
    expect(readRowSignal(KEY, T0)).toMatchObject({ kind: 'queued', automation: true })
    ingestInboxRealtimeSignal({ table: 'send_queue', eventType: 'UPDATE', row: { source: 'auto_reply', queue_status: 'sending' }, threadKey: KEY }, T0 + 60_000)
    expect(readRowSignal(KEY, T0 + 60_000)?.kind).toBe('replying')
    ingestInboxRealtimeSignal({ table: 'send_queue', eventType: 'UPDATE', row: { source: 'auto_reply', queue_status: 'sent' }, threadKey: KEY }, T0 + 66_000)
    expect(readRowSignal(KEY, T0 + 66_000)).toBeNull()
  })

  it('campaign traffic never animates an Inbox row', () => {
    ingestInboxRealtimeSignal({ table: 'send_queue', eventType: 'INSERT', row: { source: 'campaign_launch_execution', queue_status: 'queued' }, threadKey: KEY }, T0)
    expect(readRowSignal(KEY, T0)).toBeNull()
  })

  it('a failed or guard-blocked reply reads "failed"', () => {
    ingestInboxRealtimeSignal({ table: 'send_queue', eventType: 'UPDATE', row: { source: 'auto_reply', queue_status: 'blocked_by_health_guard' }, threadKey: KEY }, T0)
    expect(readRowSignal(KEY, T0)?.kind).toBe('failed')
  })

  it('a transport failure reads "failed"; a sender park (daily cap) does not', () => {
    ingestInboxRealtimeSignal({ table: 'send_queue', eventType: 'UPDATE', row: { source: 'auto_reply', queue_status: 'failed_transport' }, threadKey: KEY }, T0)
    expect(readRowSignal(KEY, T0)?.kind).toBe('failed')
    const OTHER = '+15550009999'
    ingestInboxRealtimeSignal({ table: 'send_queue', eventType: 'UPDATE', row: { source: 'auto_reply', queue_status: 'blocked_sender_ineligible' }, threadKey: OTHER }, T0)
    expect(readRowSignal(OTHER, T0)?.kind).not.toBe('failed')
  })

  it('a message held for review reads "held" (never replying)', () => {
    ingestInboxRealtimeSignal({ table: 'message_events', eventType: 'UPDATE', row: { direction: 'inbound', metadata: { human_review_required: true } }, threadKey: KEY }, T0)
    expect(readRowSignal(KEY, T0)?.kind).toBe('held')
  })

  it('transients expire on their own', () => {
    ingestInboxRealtimeSignal({ table: 'send_queue', eventType: 'INSERT', row: { source: 'auto_reply', queue_status: 'queued' }, threadKey: KEY }, T0)
    expect(readRowSignal(KEY, T0 + 5_000)).toBeNull()
  })
})

describe('stage movement compares like with like', () => {
  it('no baseline, no movement — the first value is only recorded', () => {
    ingestInboxRealtimeSignal({ table: 'inbox_thread_state', eventType: 'UPDATE', row: { seller_stage: 'asking_price' }, threadKey: KEY }, T0)
    expect(readRowSignal(KEY, T0)).toBeNull()
  })

  it('a real change of the same column reads S2 → S3', () => {
    seedRowStage(KEY, 'offer_interest')
    ingestInboxRealtimeSignal({ table: 'inbox_thread_state', eventType: 'UPDATE', row: { seller_stage: 'asking_price' }, threadKey: KEY }, T0)
    expect(readRowSignal(KEY, T0)).toMatchObject({ kind: 'stage', from: 'S2', to: 'S3' })
  })

  it('an update that does not move the stage moves nothing', () => {
    seedRowStage(KEY, 'offer_interest')
    ingestInboxRealtimeSignal({ table: 'inbox_thread_state', eventType: 'UPDATE', row: { seller_stage: 'offer_interest', is_read: true }, threadKey: KEY }, T0)
    expect(readRowSignal(KEY, T0)).toBeNull()
  })
})

describe('bursts are coalesced', () => {
  it('ten replies at once: the first few get a trace, the rest are marked quietly', () => {
    for (let i = 0; i < 10; i += 1) {
      ingestInboxRealtimeSignal({ table: 'message_events', eventType: 'INSERT', row: { direction: 'inbound' }, threadKey: `+1612555000${i}` }, T0 + i * 100)
    }
    const quiet = Array.from({ length: 10 }, (_, i) => readRowSignal(`+1612555000${i}`, T0 + 1_000)?.quiet === true)
    expect(quiet.filter(Boolean).length).toBe(7)
    expect(readRowArrival('+16125550009')).not.toBeNull()
  })
})

describe('touched threads re-read their facts', () => {
  it('reports the row\'s own thread_key', () => {
    const touched: string[] = []
    const stop = onSignalTouched((keys) => touched.push(...keys))
    ingestInboxRealtimeSignal({ table: 'send_queue', eventType: 'INSERT', row: { source: 'auto_reply', queue_status: 'queued', thread_key: KEY }, threadKey: 'ct:prospect:p|phone:+16122232473' }, T0)
    stop()
    expect(touched).toEqual([KEY])
  })
})

describe('inert unless a desk ledger is mounted', () => {
  it('ignores events with no ledger listening (phones never run it)', () => {
    release()
    ingestInboxRealtimeSignal({ table: 'message_events', eventType: 'INSERT', row: { direction: 'inbound' }, threadKey: KEY }, T0)
    expect(readRowSignal(KEY, T0)).toBeNull()
    expect(readRowArrival(KEY)).toBeNull()
    release = __rowSignalsTest.enable()
  })
})
