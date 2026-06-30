import test from 'node:test'
import assert from 'node:assert/strict'

import { unwrapWorkflowApiPayload } from '../../src/views/workflow-studio/workflowStudio.adapter'

test('unwrapWorkflowApiPayload unwraps workflowSuccess envelopes', () => {
  const payload = unwrapWorkflowApiPayload<{ workflows: Array<{ id: string }> }>({
    ok: true,
    data: { workflows: [{ id: 'wf-1' }] },
    meta: { request_id: 'req-1', duration_ms: 12 },
  })

  assert.deepEqual(payload, { workflows: [{ id: 'wf-1' }] })
})

test('unwrapWorkflowApiPayload passes flat mutation bodies through', () => {
  const payload = unwrapWorkflowApiPayload<{ ok: boolean; workflow: { id: string } }>({
    ok: true,
    workflow: { id: 'wf-2' },
    steps: [],
  })

  assert.equal(payload.ok, true)
  assert.equal(payload.workflow.id, 'wf-2')
})

test('unwrapWorkflowApiPayload unwraps nested workflow detail envelopes', () => {
  const payload = unwrapWorkflowApiPayload<{ ok: boolean; workflow: { id: string }; steps: unknown[] }>({
    ok: true,
    data: {
      ok: true,
      workflow: { id: 'wf-3' },
      steps: [{ id: 'step-1' }],
    },
    meta: { request_id: 'req-2', duration_ms: 8 },
  })

  assert.equal(payload.workflow.id, 'wf-3')
  assert.equal(payload.steps.length, 1)
})