import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateGuardNode } from '@/lib/domain/workflow-v2/guard-evaluator.js'
import { enrollSubject, findReadyEnrollments } from '@/lib/domain/workflow-v2/enrollment-service.js'
import { runEnrollment } from '@/lib/domain/workflow-v2/workflow-runner.js'
import { executeActionNode } from '@/lib/domain/workflow-v2/action-executor.js'

// Minimal chainable fake: records every call so a test can assert what was (not) written.
function fake(tables = {}, { failSelect = null } = {}) {
  const calls = []
  const client = {
    calls,
    from(table) {
      const q = { table, op: 'select', filters: [], patch: null }
      calls.push(q)
      const rows = () => (tables[table] || []).filter((r) => q.filters.every(([k, v]) => r[k] === v))
      const result = () => {
        if (failSelect === table) return { data: null, count: null, error: { message: 'relation unavailable' } }
        if (q.op === 'update') { rows().forEach((r) => Object.assign(r, q.patch)); return { data: rows()[0] ?? null, error: null } }
        return { data: rows(), count: rows().length, error: null }
      }
      const chain = {
        select() { return chain }, insert(v) { q.op = 'insert'; q.patch = v; return chain }, update(v) { q.op = 'update'; q.patch = v; return chain },
        eq(k, v) { q.filters.push([k, v]); return chain }, in() { return chain }, or(expr) { q.or = expr; return chain }, is(k, v) { q.is = [k, v]; return chain },
        gte() { return chain }, lte() { return chain }, order() { return chain }, limit() { return chain },
        maybeSingle() { const r = result(); return Promise.resolve({ ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }) },
        single() { return chain.maybeSingle() },
        then(res, rej) { return Promise.resolve(result()).then(res, rej) },
      }
      return chain
    },
  }
  return client
}

test('suppression guard fails CLOSED when the opt-out check cannot run', async () => {
  const enrollment = { id: 'e1', context: { master_owner_id: 'mo-1' } }
  const errored = await evaluateGuardNode({ node_type: 'guard.suppression' }, enrollment, {}, { supabase: fake({}, { failSelect: 'message_events' }) })
  assert.deepEqual(errored, { passed: false, reason: 'suppression_check_unavailable' })

  const thrown = await evaluateGuardNode({ node_type: 'guard.suppression' }, enrollment, {}, { supabase: { from() { throw new Error('down') } } })
  assert.equal(thrown.passed, false)

  const clear = await evaluateGuardNode({ node_type: 'guard.suppression' }, enrollment, {}, { supabase: fake({ message_events: [] }) })
  assert.equal(clear.passed, true)
})

test('an unknown guard holds instead of passing through', async () => {
  const r = await evaluateGuardNode({ node_type: 'guard.made_up' }, { context: {} }, {}, {})
  assert.deepEqual(r, { passed: false, reason: 'unsupported_guard:guard.made_up' })
})

test('only an armed (active) definition accepts enrollments', async () => {
  for (const status of ['draft', 'published', 'paused', 'archived']) {
    const db = fake({ workflow_definitions: [{ id: 'd1', status }], workflow_enrollments: [] })
    const r = await enrollSubject('d1', { subject_type: 'lead', subject_id: 's1' }, { supabase: db })
    assert.equal(r.ok, false, status)
    assert.equal(r.error, 'workflow_definition_not_active')
    assert.ok(!db.calls.some((c) => c.table === 'workflow_enrollments' && c.op === 'insert'), `${status}: no enrollment written`)
  }
})

test('a paused enrollment neither runs nor is selected as due', async () => {
  const paused = { id: 'e1', status: 'waiting', paused_at: '2026-09-29T00:00:00Z', next_execution_at: null, context: {} }
  const db = fake({ workflow_enrollments: [paused], workflow_definitions: [], workflow_nodes: [], workflow_edges: [] })
  const r = await runEnrollment('e1', { supabase: db })
  assert.equal(r.skipped, true)
  assert.equal(r.reason, 'enrollment_paused')

  const sel = fake({ workflow_enrollments: [] })
  await findReadyEnrollments(10, { supabase: sel })
  assert.deepEqual(sel.calls[0].is, ['paused_at', null])
})

test('update_status never writes master_owners.contact_status', async () => {
  const db = fake({ workflow_enrollments: [{ id: 'e1', context: { master_owner_id: 'mo-1' } }], master_owners: [{ id: 'mo-1', contact_status: null }] })
  const r = await executeActionNode({ id: 'n1', node_type: 'action.update_status', config: { status: 'hot' } }, { id: 'e1', subject_id: 's1', context: { master_owner_id: 'mo-1' } }, { id: 'd1' }, { supabase: db })
  assert.equal(r.status, 'completed')
  assert.equal(r.action.crm_update.attempted, false)
  assert.ok(!db.calls.some((c) => c.table === 'master_owners'))
})
