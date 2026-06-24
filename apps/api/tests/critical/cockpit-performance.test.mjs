import test from 'node:test'
import assert from 'node:assert/strict'

import { createRequestTimer } from '../../src/lib/cockpit/server-timing.js'
import { getLiveCounts } from '../../src/lib/domain/inbox/live-inbox-service.js'

function buildLiveCountRow() {
  return {
    all: 12,
    all_messages: 12,
    priority: 2,
    hot_leads: 2,
    new_replies: 3,
    new_inbound: 3,
    needs_reply: 3,
    needs_review: 1,
    manual_review: 1,
    automated: 1,
    follow_up: 4,
    outbound_active: 4,
    cold: 1,
    cold_no_response: 1,
    dead: 0,
    suppressed: 1,
    dnc_opt_out: 1,
    active: 10,
    waiting: 2,
    waiting_on_seller: 2,
    unlinked: 1,
  }
}

test('createRequestTimer records phases in dev summary shape', () => {
  const timer = createRequestTimer('test-route')
  timer.mark('auth_config')
  timer.mark('supabase_query')
  const summary = timer.summary({ ok: true })
  assert.equal(summary.route, 'test-route')
  assert.equal(summary.phases.length, 2)
  assert.equal(summary.ok, true)
  assert.ok(summary.totalMs >= 0)
})

test('getLiveCounts prefers pre-aggregated count view before authoritative scan', async () => {
  const calls = []
  const supabase = {
    from(table) {
      calls.push(table)
      const state = { table }
      const api = {
        select() { return api },
        eq() { return api },
        is() { return api },
        lt() { return api },
        limit() { return api },
        order() { return api },
        range() { return api },
        async then(resolve) {
          if (table === 'v_inbox_thread_counts_live_v2') {
            resolve({ data: [buildLiveCountRow()], error: null })
            return
          }
          resolve({ data: [], error: null, count: 0 })
        },
      }
      return api
    },
  }

  const counts = await getLiveCounts({}, { supabase })
  assert.equal(counts.all, 12)
  assert.equal(counts.priority, 2)
  assert.equal(calls[0], 'v_inbox_thread_counts_live_v2')
  assert.equal(calls.includes('inbox_thread_state'), false)
})