import test from 'node:test'
import assert from 'node:assert/strict'

import { runQueueAction, runInboxAction, isCanonicalThreadKey } from '@/lib/cockpit/cockpit-service.js'
import { POST as queueApprovePost } from '@/app/api/cockpit/queue/approve/route.js'

function makeSupabase({ queueRow = null, threadStateRow = null } = {}) {
  const calls = { updates: 0, upserts: 0, inserts: 0 }

  return {
    calls,
    from(table) {
      const state = { table, where: {} }
      return {
        select() { return this },
        eq(k, v) { state.where[k] = v; return this },
        neq() { return this },
        in() { return this },
        limit() { return this },
        maybeSingle: async () => {
          if (table === 'send_queue') return { data: queueRow, error: null }
          if (table === 'inbox_thread_state') return { data: threadStateRow, error: null }
          return { data: null, error: null }
        },
        update() {
          calls.updates += 1
          return {
            eq() {
              return {
                select() {
                  return { maybeSingle: async () => ({ data: { id: 'q1', queue_status: 'queued', thread_key: queueRow?.thread_key || null }, error: null }) }
                },
              }
            },
          }
        },
        upsert() {
          calls.upserts += 1
          return {
            select() {
              return { maybeSingle: async () => ({ data: { thread_key: threadStateRow?.thread_key || 't:1', is_read: true }, error: null }) }
            },
          }
        },
      }
    },
  }
}

const flagsAllOn = async () => ({
  outbound_sms_enabled: true,
  queue_runner_enabled: true,
  followup_enabled: true,
  auto_reply_enabled: true,
})

test('unauthenticated mutation rejects', async () => {
  process.env.OPS_DASHBOARD_SECRET = 'test-secret'
  const req = new Request('http://localhost/api/cockpit/queue/approve', { method: 'POST', body: JSON.stringify({ queue_item_id: '1' }) })
  const res = await queueApprovePost(req)
  const body = await res.json()
  assert.equal(res.status, 401)
  assert.equal(body.ok, false)
})

test('dry_run queue action does not mutate', async () => {
  const supabase = makeSupabase({ queueRow: { id: 'q1', queue_status: 'approval', thread_key: 'abc:1234', to_phone_number: '+15550001111' } })
  const result = await runQueueAction({
    action: 'approve',
    payload: { queue_item_id: 'q1', dry_run: true },
    supabase,
    getFlags: flagsAllOn,
  })
  assert.equal(result.ok, true)
  assert.equal(result.dry_run, true)
  assert.equal(supabase.calls.updates, 0)
})

test('paused_review cannot approve', async () => {
  const supabase = makeSupabase({ queueRow: { id: 'q1', queue_status: 'paused_review', thread_key: 'abc:1234' } })
  const result = await runQueueAction({ action: 'approve', payload: { queue_item_id: 'q1', dry_run: true }, supabase, getFlags: flagsAllOn })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'paused_review')
})

test('incident quarantine cannot send-now', async () => {
  const supabase = makeSupabase({
    threadStateRow: { thread_key: '+18605733879', status: 'active', metadata: { incident_quarantine: true } },
  })
  const result = await runInboxAction({
    action: 'send-now',
    payload: { dry_run: true, thread_key: '+18605733879', to_phone_number: '+15550001111', from_phone_number: '+15550002222' },
    supabase,
    getFlags: flagsAllOn,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'incident_quarantine')
})

test('negative reply cannot auto-reply', async () => {
  const supabase = makeSupabase({ threadStateRow: { thread_key: '+18605733879', status: 'active', metadata: {} } })
  const result = await runInboxAction({
    action: 'auto-reply',
    payload: { dry_run: true, thread_key: '+18605733879', intent: 'not_interested' },
    supabase,
    getFlags: flagsAllOn,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'negative_or_wrong_number_intent_blocked')
})

test('wrong-number cannot auto-reply', async () => {
  const supabase = makeSupabase({ threadStateRow: { thread_key: '+18605733879', status: 'active', metadata: {} } })
  const result = await runInboxAction({
    action: 'auto-reply',
    payload: { dry_run: true, thread_key: '+18605733879', intent: 'wrong_number' },
    supabase,
    getFlags: flagsAllOn,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'negative_or_wrong_number_intent_blocked')
})

test('noncanonical thread_key rejected', async () => {
  assert.equal(isCanonicalThreadKey('bad key with space'), false)
  const supabase = makeSupabase({ threadStateRow: null })
  const result = await runInboxAction({
    action: 'queue-reply',
    payload: { dry_run: true, thread_key: 'bad key with space', to_phone_number: '+15550001111', from_phone_number: '+15550002222' },
    supabase,
    getFlags: flagsAllOn,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid_canonical_thread_key')
})

test('fallback template path does not exist', async () => {
  const supabase = makeSupabase({ threadStateRow: { thread_key: '+18605733879', status: 'active', metadata: {} } })
  const result = await runInboxAction({
    action: 'auto-reply',
    payload: { dry_run: false, thread_key: '+18605733879', intent: 'seller_interested' },
    supabase,
    getFlags: flagsAllOn,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'BACKEND_ENDPOINT_NOT_READY')
  assert.equal('template_fallback' in (result.diagnostics || {}), false)
})
