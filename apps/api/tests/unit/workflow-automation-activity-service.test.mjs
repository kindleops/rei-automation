import test from 'node:test'
import assert from 'node:assert/strict'

import { listWorkflowAutomationActivity } from '../../src/lib/domain/workflow-v2/workflow-automation-activity-service.js'
import { makeTerminalQuery } from '../helpers/chainable-supabase.mjs'

function mockSupabase(handlers) {
  return {
    from(table) {
      const handler = handlers[table]
      if (!handler) {
        return { select: () => makeTerminalQuery({ data: [], error: null }) }
      }
      return handler()
    },
  }
}

test('automation activity degrades when workflow_enrollments query fails but send_queue follow-ups return', async () => {
  const supabase = mockSupabase({
    workflow_enrollments: () => ({
      select: (columns) => {
        assert.equal(columns.includes('workflow_run_id'), false)
        return makeTerminalQuery({
          data: null,
          error: { message: 'column workflow_enrollments.workflow_run_id does not exist' },
        })
      },
    }),
    workflow_scheduled_tasks: () => ({
      select: (columns) => {
        assert.equal(columns.includes('subject_id'), false)
        return makeTerminalQuery({ data: [], error: null })
      },
    }),
    send_queue: () => ({
      select: () => ({
        gt: () => ({
          in: () => ({
            order: () => ({
              limit: () => makeTerminalQuery({
                data: [{
                  id: 'sq-1',
                  queue_status: 'scheduled',
                  touch_number: 2,
                  use_case: 'no_reply_follow_up',
                  metadata: { seller_stage: 'consider_selling', thread_key: '+15551234567' },
                  created_at: '2026-07-09T12:00:00.000Z',
                  updated_at: '2026-07-09T12:00:00.000Z',
                }],
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  })

  const result = await listWorkflowAutomationActivity({ limit: 10 }, { supabase })

  assert.equal(result.ok, true)
  assert.equal(result.degraded, true)
  assert.ok(Array.isArray(result.warnings))
  assert.match(result.warnings[0], /workflow_enrollments/)
  assert.equal(result.counts.send_queue_followups, 1)
  assert.equal(result.counts.total, 1)
  assert.equal(result.activity[0].source, 'send_queue_followup')
  assert.equal(result.sources_present.send_queue_followup, true)
})

test('automation activity maps enrollments from schema-safe columns only', async () => {
  const supabase = mockSupabase({
    workflow_enrollments: () => ({
      select: (columns) => {
        assert.ok(columns.includes('pause_reason'))
        assert.equal(columns.includes('workflow_run_id'), false)
        return makeTerminalQuery({
          data: [{
            id: 'enr-1',
            workflow_definition_id: 'def-1',
            subject_id: 'seller-1',
            status: 'waiting',
            context: { seller_stage: 'ownership_check', property_address: '123 Main St' },
            enrolled_at: '2026-07-09T10:00:00.000Z',
            updated_at: '2026-07-09T11:00:00.000Z',
            next_execution_at: '2026-07-09T13:00:00.000Z',
            waiting_reason: 'seller_replied',
            pause_reason: null,
          }],
          error: null,
        })
      },
    }),
    workflow_scheduled_tasks: () => ({
      select: () => makeTerminalQuery({ data: [], error: null }),
    }),
    send_queue: () => ({
      select: () => ({
        gt: () => ({
          in: () => ({
            order: () => ({
              limit: () => makeTerminalQuery({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }),
  })

  const result = await listWorkflowAutomationActivity({ limit: 5 }, { supabase })

  assert.equal(result.ok, true)
  assert.equal(result.counts.workflow_enrollments, 1)
  assert.equal(result.activity[0].seller_stage, 'ownership_check')
  assert.equal(result.activity[0].property_label, '123 Main St')
})