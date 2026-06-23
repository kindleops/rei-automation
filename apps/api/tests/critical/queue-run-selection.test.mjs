import test from 'node:test'
import assert from 'node:assert/strict'

import { runSendQueue } from '@/lib/domain/queue/run-send-queue.js'
import {
  buildSupabaseQueueRow,
  makeRunSendQueueDeps,
} from '../helpers/queue-run-test-harness.js'

const NOW = '2026-04-04T15:00:00.000Z'

test('runSendQueue selects a queued row whose scheduled_for is in the past', async () => {
  const row = buildSupabaseQueueRow(2001, {
    scheduled_for: '2026-04-04T12:00:00.000Z',
    scheduled_for_utc: '2026-04-04T12:00:00.000Z',
  })
  const { deps, processed } = makeRunSendQueueDeps({ rows: [row], now: NOW })

  const result = await runSendQueue({ limit: 10, now: NOW }, deps)

  assert.equal(result.processed_count, 1)
  assert.equal(processed.length, 1)
  assert.equal(processed[0].id, 2001)
  assert.equal(result.due_rows, 1)
})

test('runSendQueue excludes a queued row whose scheduled_for is in the future', async () => {
  const row = buildSupabaseQueueRow(2002, {
    scheduled_for: '2026-04-04T20:00:00.000Z',
    scheduled_for_utc: '2026-04-04T20:00:00.000Z',
  })
  const { deps, processed } = makeRunSendQueueDeps({ rows: [row], now: NOW })

  const result = await runSendQueue({ limit: 10, now: NOW }, deps)

  assert.equal(result.processed_count, 0)
  assert.deepEqual(processed, [])
  assert.equal(result.future_rows, 1)
})

test('runSendQueue selects a queued row with no scheduled_for (treated as immediately due)', async () => {
  const row = buildSupabaseQueueRow(2003, {
    scheduled_for: null,
    scheduled_for_utc: null,
  })
  const { deps, processed } = makeRunSendQueueDeps({ rows: [row], now: NOW })

  const result = await runSendQueue({ limit: 10, now: NOW }, deps)

  assert.equal(result.processed_count, 1)
  assert.deepEqual(processed.map((r) => r.id), [2003])
})

test('runSendQueue passes a due row through to the send branch and records sent_count', async () => {
  const row = buildSupabaseQueueRow(2004, {
    scheduled_for: '2026-04-04T10:00:00.000Z',
    scheduled_for_utc: '2026-04-04T10:00:00.000Z',
  })
  const { deps } = makeRunSendQueueDeps({
    rows: [row],
    now: NOW,
    processResult: { ok: true, sent: true, provider_message_id: 'msg-abc' },
  })

  const result = await runSendQueue({ limit: 10, now: NOW }, deps)

  assert.equal(result.sent_count, 1)
  assert.equal(result.failed_count, 0)
  assert.equal(result.ok, true)
  assert.equal(result.results[0].status, 'sent')
  assert.equal(result.results[0].provider_message_id, 'msg-abc')
})

test('runSendQueue records failed_count when processSendQueueItem returns not sent', async () => {
  const row = buildSupabaseQueueRow(2005, {
    scheduled_for: '2026-04-04T12:00:00.000Z',
    scheduled_for_utc: '2026-04-04T12:00:00.000Z',
  })
  const { deps } = makeRunSendQueueDeps({
    rows: [row],
    now: NOW,
    processResult: { ok: false, reason: 'missing_textgrid_number' },
  })

  const result = await runSendQueue({ limit: 10, now: NOW }, deps)

  assert.equal(result.sent_count, 0)
  assert.equal(result.failed_count, 1)
  assert.equal(result.results[0].reason, 'missing_textgrid_number')
})

test('runSendQueue fails soft on unexpected process crash and continues later work', async () => {
  const crash = buildSupabaseQueueRow(2012, {
    scheduled_for: '2026-04-04T09:00:00.000Z',
    scheduled_for_utc: '2026-04-04T09:00:00.000Z',
  })
  const ok = buildSupabaseQueueRow(2013, {
    scheduled_for: '2026-04-04T10:00:00.000Z',
    scheduled_for_utc: '2026-04-04T10:00:00.000Z',
  })
  const { deps } = makeRunSendQueueDeps({
    rows: [crash, ok],
    now: NOW,
    processImpl: async (row) => {
      if (row.id === 2012) throw new Error('boom')
      return { ok: true, sent: true }
    },
  })

  const result = await runSendQueue({ limit: 10, now: NOW }, deps)

  assert.equal(result.ok, true)
  assert.equal(result.processed_count, 2)
  assert.equal(result.sent_count, 1)
  assert.equal(result.failed_count, 1)
})

test('runSendQueue processes due row and excludes future row from mixed batch', async () => {
  const due = buildSupabaseQueueRow(2010, {
    scheduled_for: '2026-04-04T08:00:00.000Z',
    scheduled_for_utc: '2026-04-04T08:00:00.000Z',
  })
  const future = buildSupabaseQueueRow(2011, {
    scheduled_for: '2026-04-04T22:00:00.000Z',
    scheduled_for_utc: '2026-04-04T22:00:00.000Z',
  })
  const { deps, processed } = makeRunSendQueueDeps({ rows: [due, future], now: NOW })

  const result = await runSendQueue({ limit: 10, now: NOW }, deps)

  assert.equal(result.processed_count, 1)
  assert.deepEqual(processed.map((r) => r.id), [2010])
  assert.equal(result.due_rows, 1)
  assert.equal(result.future_rows, 1)
})

test('runSendQueue counts skipped rows when processor returns skipped', async () => {
  const row = buildSupabaseQueueRow(2020, {
    scheduled_for: '2026-04-04T08:00:00.000Z',
    scheduled_for_utc: '2026-04-04T08:00:00.000Z',
  })
  const { deps } = makeRunSendQueueDeps({
    rows: [row],
    now: NOW,
    processResult: {
      ok: true,
      skipped: true,
      reason: 'queue_item_claim_conflict',
      claim_conflict: true,
      claimed: false,
    },
  })

  const result = await runSendQueue({ limit: 10, now: NOW }, deps)

  assert.equal(result.ok, true)
  assert.equal(result.skipped_count, 1)
  assert.equal(result.sent_count, 0)
})

test('runSendQueue returns due_rows and future_rows in summary object', async () => {
  const due = buildSupabaseQueueRow(3001, {
    scheduled_for: '2026-04-04T10:00:00.000Z',
    scheduled_for_utc: '2026-04-04T10:00:00.000Z',
  })
  const future = buildSupabaseQueueRow(3002, {
    scheduled_for: '2026-04-05T10:00:00.000Z',
    scheduled_for_utc: '2026-04-05T10:00:00.000Z',
  })
  const { deps } = makeRunSendQueueDeps({ rows: [due, future], now: NOW })

  const result = await runSendQueue({ limit: 10, now: NOW }, deps)

  assert.equal(result.due_rows, 1)
  assert.equal(result.future_rows, 1)
  assert.equal(result.eligible_claim_count, 1)
})

test('runSendQueue dry_run=true returns diagnostics without provider processing', async () => {
  const due = buildSupabaseQueueRow(3010, {
    scheduled_for: '2026-04-04T08:00:00.000Z',
    scheduled_for_utc: '2026-04-04T08:00:00.000Z',
  })
  const { deps, processed } = makeRunSendQueueDeps({ rows: [due], now: NOW })

  const result = await runSendQueue({ limit: 10, now: NOW, dry_run: true }, deps)

  assert.equal(result.processed_count, 1)
  assert.equal(processed.length, 0, 'dry_run must not invoke processor')
  assert.equal(result.results[0].dry_run, true)
})