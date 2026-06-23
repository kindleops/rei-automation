/**
 * Within-batch dedup for canonical Supabase queue loading.
 * Dedupe key: owner + phone + touch (or explicit dedupe_key).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadRunnableSendQueueRows } from '@/lib/supabase/sms-engine.js'
import {
  buildSupabaseQueueRow,
  makeSelectSupabase,
} from '../helpers/queue-run-test-harness.js'

const NOW = '2026-01-01T12:00:00.000Z'

function dueAt(hour) {
  return {
    scheduled_for: `2026-01-01T${String(hour).padStart(2, '0')}:00:00.000Z`,
    scheduled_for_utc: `2026-01-01T${String(hour).padStart(2, '0')}:00:00.000Z`,
  }
}

function snapshot(owner_id, phone_id, touch_num) {
  return {
    selected_template_id: '200194',
    candidate_snapshot: {
      master_owner_id: owner_id,
      phone_id,
      best_phone_id: phone_id,
      touch_number: touch_num,
      seller_first_name: 'John',
      property_id: 'prop_test',
    },
  }
}

async function loadRows(rawRows, { warn_calls = [] } = {}) {
  return loadRunnableSendQueueRows(50, {
    now: NOW,
    supabase: makeSelectSupabase(rawRows),
    evaluateContactWindow: async () => ({ allowed: true }),
    warn: (event, meta) => warn_calls.push([event, meta]),
  })
}

test('loadRunnableSendQueueRows: duplicate owner+phone+touch — only first row is runnable', async () => {
  const warns = []
  const rows = [
    buildSupabaseQueueRow(1001, {
      master_owner_id: 'mo-201',
      scheduled_for: '2026-01-01T06:00:00.000Z',
      scheduled_for_utc: '2026-01-01T06:00:00.000Z',
      metadata: snapshot('mo-201', 'ph-401', 1),
    }),
    buildSupabaseQueueRow(1002, {
      master_owner_id: 'mo-201',
      scheduled_for: '2026-01-01T07:00:00.000Z',
      scheduled_for_utc: '2026-01-01T07:00:00.000Z',
      metadata: snapshot('mo-201', 'ph-401', 1),
    }),
  ]

  const result = await loadRows(rows, { warn_calls: warns })

  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].id, 1001)
  assert.equal(result.batch_duplicate_suppressed_count, 1)

  const dedup_warn = warns.find(([code]) => code === 'queue.run_batch_duplicates_suppressed')
  assert.ok(dedup_warn, 'batch dedup warning must be emitted')
  assert.equal(dedup_warn[1].duplicate_count, 1)
})

test('loadRunnableSendQueueRows: same owner+phone but different touch numbers — both runnable', async () => {
  const rows = [
    buildSupabaseQueueRow(2001, { master_owner_id: 'mo-201', touch_number: 1, ...dueAt(6), metadata: snapshot('mo-201', 'ph-401', 1) }),
    buildSupabaseQueueRow(2002, { master_owner_id: 'mo-201', touch_number: 2, ...dueAt(7), metadata: snapshot('mo-201', 'ph-401', 2) }),
  ]

  const result = await loadRows(rows)
  assert.equal(result.rows.length, 2)
})

test('loadRunnableSendQueueRows: different owners sharing phone+touch — both runnable', async () => {
  const rows = [
    buildSupabaseQueueRow(3001, { master_owner_id: 'mo-201', ...dueAt(6), metadata: snapshot('mo-201', 'ph-401', 1) }),
    buildSupabaseQueueRow(3002, { master_owner_id: 'mo-202', ...dueAt(7), metadata: snapshot('mo-202', 'ph-401', 1) }),
  ]

  const result = await loadRows(rows)
  assert.equal(result.rows.length, 2)
})

test('loadRunnableSendQueueRows: row missing owner/phone ids is not batch-deduped', async () => {
  const rows = [
    buildSupabaseQueueRow(4001, {
      master_owner_id: null,
      ...dueAt(6),
      metadata: { selected_template_id: '200194', candidate_snapshot: { seller_first_name: 'John' } },
    }),
    buildSupabaseQueueRow(4002, {
      master_owner_id: null,
      ...dueAt(7),
      metadata: { selected_template_id: '200194', candidate_snapshot: { seller_first_name: 'Jane' } },
    }),
  ]

  const result = await loadRows(rows)
  assert.equal(result.rows.length, 2)
})

test('loadRunnableSendQueueRows: three identical touch duplicates — first runnable, two suppressed', async () => {
  const warns = []
  const rows = [1001, 1002, 1003].map((id, idx) =>
    buildSupabaseQueueRow(id, {
      master_owner_id: 'mo-201',
      scheduled_for: `2026-01-01T0${6 + idx}:00:00.000Z`,
      scheduled_for_utc: `2026-01-01T0${6 + idx}:00:00.000Z`,
      metadata: snapshot('mo-201', 'ph-401', 1),
    })
  )

  const result = await loadRows(rows, { warn_calls: warns })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].id, 1001)
  assert.equal(result.batch_duplicate_suppressed_count, 2)

  const dedup_warn = warns.find(([code]) => code === 'queue.run_batch_duplicates_suppressed')
  assert.ok(dedup_warn)
})