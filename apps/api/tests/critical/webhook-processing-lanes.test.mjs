import test from 'node:test'
import assert from 'node:assert/strict'

import {
  selectTerminalDeliveryEvent,
  groupDeliveryEventsByProvider,
  detectContradictoryTerminalStates,
  normalizeProviderEventPayload,
  inboundProcessingPriority,
} from '@/lib/domain/webhooks/provider-event-state-machine.js'
import {
  processDeliveryProviderGroup,
  processDeliveryWebhookLive,
} from '@/lib/domain/webhooks/webhook-event-processor.js'
import { recoverDeliveryWebhookBacklog } from '@/lib/domain/delivery/delivery-webhook-recovery.js'

test('selectTerminalDeliveryEvent prefers delivered over sent and failed', () => {
  const events = [
    normalizeProviderEventPayload({
      id: '1',
      provider_message_sid: 'SM1',
      payload: { message_id: 'SM1', status: 'sent' },
      created_at: '2026-07-01T10:00:00.000Z',
    }),
    normalizeProviderEventPayload({
      id: '2',
      provider_message_sid: 'SM1',
      payload: { message_id: 'SM1', status: 'delivered' },
      created_at: '2026-07-01T10:01:00.000Z',
    }),
    normalizeProviderEventPayload({
      id: '3',
      provider_message_sid: 'SM1',
      payload: { message_id: 'SM1', status: 'failed' },
      created_at: '2026-07-01T10:02:00.000Z',
    }),
  ]

  const terminal = selectTerminalDeliveryEvent(events)
  assert.equal(terminal.canonical_status, 'delivered')
})

test('groupDeliveryEventsByProvider compacts multiple webhook rows per provider sid', () => {
  const rows = [
    {
      id: 'a',
      provider_message_sid: 'SM-group',
      event_type: 'delivery',
      payload: { message_id: 'SM-group', status: 'sent' },
      created_at: '2026-07-01T10:00:00.000Z',
    },
    {
      id: 'b',
      provider_message_sid: 'SM-group',
      event_type: 'delivery',
      payload: { message_id: 'SM-group', status: 'delivered' },
      created_at: '2026-07-01T10:01:00.000Z',
    },
  ]

  const groups = groupDeliveryEventsByProvider(rows)
  assert.equal(groups.size, 1)
  const group = groups.get('SM-group')
  assert.equal(group.rows.length, 2)
  assert.equal(group.events.length, 2)
})

test('detectContradictoryTerminalStates flags delivered+failed combinations', () => {
  const events = [
    normalizeProviderEventPayload({
      payload: { message_id: 'SM-x', status: 'delivered' },
    }),
    normalizeProviderEventPayload({
      payload: { message_id: 'SM-x', status: 'failed' },
    }),
  ]
  const result = detectContradictoryTerminalStates(events)
  assert.equal(result.contradictory, true)
})

test('normalizeProviderEventPayload ignores webhook signature metadata as delivery failure', () => {
  const normalized = normalizeProviderEventPayload({
    provider_message_sid: 'SM-delivered-sig',
    payload: {
      message_id: 'SM-delivered-sig',
      status: 'delivered',
      signature_failure_reason: 'no_mode_produced_matching_digest',
      webhook_verification: { ok: false, reason: 'invalid_signature' },
    },
  })
  assert.equal(normalized.canonical_status, 'delivered')
})

test('inboundProcessingPriority ranks STOP/opt-out above generic inbound', () => {
  const stop_row = {
    created_at: new Date().toISOString(),
    payload: { message_body: 'STOP' },
  }
  const generic_row = {
    created_at: new Date().toISOString(),
    payload: { message_body: 'maybe interested' },
  }
  assert.ok(inboundProcessingPriority(stop_row) > inboundProcessingPriority(generic_row))
})

test('processDeliveryProviderGroup marks all grouped webhook rows processed once', async () => {
  const group = {
    provider_message_sid: 'SM-live-1',
    webhook_rows: [
      { id: 'wh-1', payload: { message_id: 'SM-live-1', status: 'sent' } },
      { id: 'wh-2', payload: { message_id: 'SM-live-1', status: 'delivered' } },
    ],
    events: [],
  }

  const outcome = await processDeliveryProviderGroup(group, {}, {
    supabase: {
      from() {
        return {
          update() {
            return this
          },
          eq() {
            return this
          },
          select() {
            return this
          },
          maybeSingle: async () => ({ data: { id: 'x', processed: true } }),
        }
      },
    },
    syncDeliveryEvent: async () => ({
      final_delivery_status: 'delivered',
      send_queue_count: 1,
      message_events_count: 1,
    }),
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.matched, true)
  assert.equal(outcome.recovered, 2)
  assert.equal(outcome.terminal_provider_status, 'delivered')
})

test('processDeliveryWebhookLive uses live lane and records latency', async () => {
  const row = {
    id: 'wh-live',
    provider_message_sid: 'SM-live-2',
    payload: { message_id: 'SM-live-2', status: 'delivered' },
    event_type: 'delivery',
    created_at: new Date().toISOString(),
  }

  const outcome = await processDeliveryWebhookLive(row, {}, {
    supabase: {
      from() {
        return {
          update() {
            return this
          },
          eq() {
            return this
          },
          select() {
            return this
          },
          maybeSingle: async () => ({ data: { id: 'wh-live', processed: true } }),
        }
      },
    },
    syncDeliveryEvent: async () => ({
      final_delivery_status: 'delivered',
      send_queue_count: 1,
      message_events_count: 0,
    }),
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.lane, 'live')
  assert.equal(outcome.matched, true)
  assert.ok(Number(outcome.latency_ms) >= 0)
})

test('recoverDeliveryWebhookBacklog supports targeted provider id mode', async () => {
  const outcome = await recoverDeliveryWebhookBacklog(
    { provider_message_sids: ['SM-target-1', 'SM-target-2'] },
    {
      supabase: {
        from() {
          return {
            select() {
              return this
            },
            eq() {
              return this
            },
            in() {
              return this
            },
            order() {
              return this
            },
            filter() {
              return this
            },
            limit() {
              return Promise.resolve({ data: [], error: null })
            },
          }
        },
      },
    },
  )

  assert.equal(outcome.mode, 'targeted')
  assert.equal(outcome.provider_groups_scanned, 2)
})