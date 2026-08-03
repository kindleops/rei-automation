import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildOperatorAutomationPatch,
  getAutomationResumeBlock,
  resolveAutomationModeFromRow,
  resolveStageFromRow,
  serializeOperatorAutomationMode,
} from '../../src/domain/lead-state/deal-desk-control-contract'
import {
  resolveLeadTemperatureForWrite,
  resolveOperationalStatusForWrite,
  resolveOperatorAutomationMode,
} from '../../src/domain/lead-state/canonical-control-vocabularies'

test('operator automation values serialize through the explicit legacy boundary', () => {
  assert.equal(serializeOperatorAutomationMode('active'), 'running')
  assert.equal(serializeOperatorAutomationMode('paused'), 'paused')
  assert.equal(serializeOperatorAutomationMode('human_controlled'), 'manual')
})

test('autopilot_mode reconciles from automation_state and never automation_status', () => {
  assert.deepEqual(resolveAutomationModeFromRow({ automation_state: 'running', automation_status: 'suppressed' }), {
    ok: true,
    value: 'active',
    viaAlias: true,
  })
  assert.equal(resolveAutomationModeFromRow({ automation_status: 'paused' }).ok, false)
  assert.equal(resolveAutomationModeFromRow({ queue_status: 'waiting' }).ok, false)
})

test('operator mode resolver rejects system-only values', () => {
  for (const value of ['review_required', 'disabled', 'completed']) {
    const resolved = resolveOperatorAutomationMode(value)
    assert.equal(resolved.ok, false, value)
    assert.equal(resolved.ok ? null : resolved.reason, 'wrong_dimension', value)
  }
})

test('resume is explicitly rejected for suppressed, terminal, archived, and closed rows', () => {
  const blockedRows = [
    { is_suppressed: true },
    { automation_status: 'suppressed' },
    { automation_status: 'off' },
    { is_archived: true },
    { lifecycle_stage: 'closed' },
    { contactability_status: 'opted_out' },
  ]
  for (const row of blockedRows) {
    assert.equal(getAutomationResumeBlock(row).blocked, true, JSON.stringify(row))
    assert.equal(buildOperatorAutomationPatch('active', row).ok, false, JSON.stringify(row))
  }
  assert.deepEqual(buildOperatorAutomationPatch('active', { automation_status: 'waiting' }), {
    ok: true,
    patch: { automation_state: 'running' },
  })
})

test('mf_suppressed can never become lifecycle stage S1', () => {
  const resolved = resolveStageFromRow({ lifecycle_stage: 'mf_suppressed' })
  assert.equal(resolved.ok, false)
  assert.notEqual(resolved.ok ? resolved.value : null, 'ownership_confirmation')
})

test('status and temperature reject values from the wrong dimension', () => {
  for (const value of ['mf_suppressed', 'suppressed', 'delivered', 'new_reply']) {
    assert.equal(resolveLeadTemperatureForWrite(value).ok, false, `temperature:${value}`)
  }
  for (const value of ['mf_suppressed', 'suppressed', 'delivered', 'ownership_confirmation']) {
    assert.equal(resolveOperationalStatusForWrite(value).ok, false, `status:${value}`)
  }
})

test('ThreadStateBar is the only Deal Desk N.2 mutation owner', () => {
  const stateBar = readFileSync(new URL('../../src/modules/inbox/components/ThreadStateBar.tsx', import.meta.url), 'utf8')
  const dealIntel = readFileSync(new URL('../../src/modules/deal-intelligence/DealIntelligenceLeadStateBar.tsx', import.meta.url), 'utf8')
  const intelligence = readFileSync(new URL('../../src/modules/inbox/components/IntelligencePanel.tsx', import.meta.url), 'utf8')
  const inboxPage = readFileSync(new URL('../../src/modules/inbox/InboxPage.tsx', import.meta.url), 'utf8')

  assert.match(stateBar, /useCanonicalControlMutations/)
  assert.match(stateBar, /patchLeadStateFromView/)
  assert.match(stateBar, /automation_state/)
  assert.doesNotMatch(stateBar, /persist\s*\(\s*\{\s*autopilot_mode/)

  assert.doesNotMatch(dealIntel, /patchLeadStateFromView|persistUniversalLeadState|useOptimisticField/)
  assert.match(dealIntel, /data-state-mirror="deal-intelligence"/)
  assert.doesNotMatch(intelligence, /onStatusChange\(|onStageChange\(/)
  assert.doesNotMatch(inboxPage, /updateThreadStatus\(|updateThreadStage\(|markThreadRead\(|markThreadUnread\(/)
})

test('legacy adapter no longer reconstructs operator mode from queue state', () => {
  const adapter = readFileSync(new URL('../../src/modules/inbox/inbox.adapter.ts', import.meta.url), 'utf8')
  const workflow = readFileSync(new URL('../../src/lib/data/inboxWorkflowData.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(adapter, /threadIsArchived \|\| t\.threadIsSuppressed \? 'completed' : 'active'/)
  assert.match(adapter, /resolveAutomationModeFromRow/)
  assert.doesNotMatch(workflow, /automationState === 'paused'\) canonical\.operational_status/)
  assert.match(workflow, /canonical\.automation_state = 'running'/)
})
