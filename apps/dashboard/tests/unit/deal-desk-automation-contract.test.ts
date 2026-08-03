/**
 * N.2 — the automation persistence contract and the Deal Desk control contract.
 *
 * These cover the boundary between the canonical operator vocabulary and what
 * `inbox_thread_state` actually stores, plus the per-field request/read-back rules that
 * every control shares.
 *
 * Run with `npx tsx --test apps/dashboard/tests/unit/deal-desk-automation-contract.test.ts`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTOMATION_MODE_FIELD,
  AUTOMATION_QUEUE_STATUS_FIELD,
  MANUAL_STAGE_LOCK_FIELD,
  OPERATOR_MODE_TO_PERSISTED,
  PERSISTED_AUTOMATION_STATES,
  PERSISTED_TO_MODE,
  buildAutomationModePatch,
  deserializeAutomationState,
  evaluateAutomationResume,
  isResumeTransition,
  isUnsupportedAutomationState,
  readAutomationModeFromThread,
  readManualStageLock,
  readQueueStatusFromThread,
  resolveOperatorAutomationModeForControl,
  serializeOperatorAutomationMode,
} from '../../src/domain/lead-state/automation-persistence-contract.ts'
import {
  DEAL_DESK_CONTROL_FIELDS,
  buildControlWritePayload,
  describeServerRefusal,
  isKnownServerRefusal,
  readAutomationValue,
  readBackControlValue,
  readReadStateValue,
  readStageValue,
  readStatusValue,
  readTemperatureValue,
  resolveReadStateForWrite,
} from '../../src/domain/inbox/deal-desk-control-contract.ts'
import { OPERATOR_SELECTABLE_AUTOMATION_MODES } from '../../src/domain/lead-state/canonical-control-vocabularies.ts'
import {
  PERSISTED_AUTOMATION_STATE_VALUES,
  UNIVERSAL_LEAD_STATE_PATCH_FIELDS,
  normalizePatchToCanonical,
} from '../../src/domain/lead-state/universal-lead-state-registry.ts'

// ── field identity ───────────────────────────────────────────────────────────

test('the automation write target is automation_state, never automation_status', () => {
  assert.equal(AUTOMATION_MODE_FIELD, 'automation_state')
  assert.equal(AUTOMATION_QUEUE_STATUS_FIELD, 'automation_status')
  assert.notEqual(AUTOMATION_MODE_FIELD, AUTOMATION_QUEUE_STATUS_FIELD)
  assert.equal(MANUAL_STAGE_LOCK_FIELD, 'manual_stage_lock')
})

test('the control field list is exactly the five canonical operator fields', () => {
  assert.deepEqual([...DEAL_DESK_CONTROL_FIELDS], [
    'lifecycle_stage', 'operational_status', 'lead_temperature', 'automation_state', 'is_read',
  ])
  assert.ok(!DEAL_DESK_CONTROL_FIELDS.includes('automation_status' as never))
  assert.ok(!DEAL_DESK_CONTROL_FIELDS.includes('autopilot_mode' as never))
})

// ── serialization ────────────────────────────────────────────────────────────

test('every operator-selectable mode has exactly one located persisted value', () => {
  for (const mode of OPERATOR_SELECTABLE_AUTOMATION_MODES) {
    const serialized = serializeOperatorAutomationMode(mode)
    assert.ok(serialized.ok, `${mode} must be serializable`)
    assert.ok(
      PERSISTED_AUTOMATION_STATES.includes(serialized.persistedValue),
      `${mode} serialized to an unlocated value: ${serialized.persistedValue}`,
    )
  }
})

test('active serializes to running — the value production actually holds', () => {
  const serialized = serializeOperatorAutomationMode('active')
  assert.ok(serialized.ok)
  assert.equal(serialized.persistedValue, 'running')
})

test('paused serializes to paused and human_controlled to manual', () => {
  const paused = serializeOperatorAutomationMode('paused')
  assert.ok(paused.ok)
  assert.equal(paused.persistedValue, 'paused')

  const manual = serializeOperatorAutomationMode('human_controlled')
  assert.ok(manual.ok)
  assert.equal(manual.persistedValue, 'manual')
})

test('system-only modes are refused with a distinguishable reason', () => {
  for (const mode of ['review_required', 'disabled', 'completed']) {
    const serialized = serializeOperatorAutomationMode(mode)
    assert.ok(!serialized.ok, `${mode} must not be operator-writable`)
    assert.equal(serialized.reason, 'system_only_mode')
  }
})

test('a display label never reaches the database as itself', () => {
  // Some labels normalise onto a real legacy code ("Autopilot On" → `autopilot_on`), so
  // they are accepted — but only ever as a canonical mode, and what is PERSISTED is always
  // one of the three located `automation_state` values, never the label.
  for (const label of ['Autopilot On', 'Manual Only', 'Automation Paused', 'Paused ', 'Review Required', 'Not A Mode']) {
    const serialized = serializeOperatorAutomationMode(label)
    if (!serialized.ok) continue
    assert.ok(
      PERSISTED_AUTOMATION_STATES.includes(serialized.persistedValue),
      `${label} serialized to an unlocated value: ${serialized.persistedValue}`,
    )
    assert.notEqual(serialized.persistedValue as string, label)
  }
  assert.equal(serializeOperatorAutomationMode('Autopilot On').ok, true)
  assert.equal(serializeOperatorAutomationMode('Review Required').ok, false, 'a system-only label stays refused')
  assert.equal(serializeOperatorAutomationMode('Not A Mode').ok, false)
})

test('the persisted map and its inverse agree', () => {
  for (const [mode, persisted] of Object.entries(OPERATOR_MODE_TO_PERSISTED)) {
    assert.equal(PERSISTED_TO_MODE[persisted as keyof typeof PERSISTED_TO_MODE], mode)
  }
  for (const [persisted, mode] of Object.entries(PERSISTED_TO_MODE)) {
    assert.equal(OPERATOR_MODE_TO_PERSISTED[mode], persisted)
  }
})

// ── deserialization ──────────────────────────────────────────────────────────

test('running / paused / manual read back as the canonical modes', () => {
  assert.equal(deserializeAutomationState('running'), 'active')
  assert.equal(deserializeAutomationState('paused'), 'paused')
  assert.equal(deserializeAutomationState('manual'), 'human_controlled')
  assert.equal(deserializeAutomationState('RUNNING'), 'active')
  assert.equal(deserializeAutomationState('  paused '), 'paused')
})

test('an unset automation_state reads as active, matching the backend default', () => {
  // `shouldSuppressSellerAutoReply` uses `automation_state || "running"`, so a null row's
  // effective behaviour is "automation may send".
  for (const empty of ['', null, undefined, '   ']) {
    assert.equal(deserializeAutomationState(empty), 'active')
  }
})

test('an unrecognised automation_state is null, not a guess', () => {
  assert.equal(deserializeAutomationState('quantum'), null)
  assert.equal(isUnsupportedAutomationState('quantum'), true)
  assert.equal(isUnsupportedAutomationState('running'), false)
})

test('the mode is never read out of automation_status', () => {
  // A row that is paused in the queue dimension but running in the mode dimension must
  // read as active. This is the hydrated view's COALESCE behaviour, refused here.
  assert.equal(readAutomationModeFromThread({ automation_state: 'running', automation_status: 'paused' }), 'active')
  assert.equal(readAutomationModeFromThread({ automation_status: 'paused' }), 'active')
  assert.equal(readAutomationModeFromThread({ automation_status: 'suppressed' }), 'active')
})

test('queue status is read verbatim and separately', () => {
  assert.equal(readQueueStatusFromThread({ automation_status: 'manual_review' }), 'manual_review')
  assert.equal(readQueueStatusFromThread({ automation_state: 'running' }), null)
  assert.equal(readQueueStatusFromThread({}), null)
})

test('the automation control value ignores the synthesised camelCase automationState', () => {
  // `toWorkflowThread` used to synthesise `automationState` from isArchived/isSuppressed.
  const resolved = readAutomationValue({ automationState: 'completed', automation_state: 'paused' })
  assert.equal(resolved.canonical, 'paused')
  const noColumn = readAutomationValue({ automationState: 'completed' })
  assert.equal(noColumn.canonical, 'active', 'a display artefact is not a stored value')
})

// ── resume eligibility ───────────────────────────────────────────────────────

test('only a transition into active counts as a resume', () => {
  assert.equal(isResumeTransition('active'), true)
  assert.equal(isResumeTransition('paused'), false)
  assert.equal(isResumeTransition('human_controlled'), false)
})

test('a suppressed record refuses a resume', () => {
  for (const thread of [
    { is_suppressed: true },
    { isSuppressed: true },
    { opt_out: true },
    { contactability_status: 'opted_out' },
    { contactability_status: 'dnc' },
    { contactability_status: 'invalid_number' },
  ]) {
    const verdict = evaluateAutomationResume(thread)
    assert.equal(verdict.allowed, false, JSON.stringify(thread))
    assert.equal(verdict.reason, 'suppressed')
    assert.match(verdict.message ?? '', /suppressed/i)
  }
})

test('a terminal record refuses a resume', () => {
  const closed = evaluateAutomationResume({ lifecycle_stage: 'closed' })
  assert.equal(closed.allowed, false)
  assert.equal(closed.reason, 'terminal_stage')

  for (const disposition of ['not_interested', 'wrong_number', 'sold', 'duplicate', 'unqualified', 'wrong_person']) {
    const verdict = evaluateAutomationResume({ disposition })
    assert.equal(verdict.allowed, false, disposition)
    assert.equal(verdict.reason, 'terminal_disposition')
  }
})

test('a live record allows a resume', () => {
  assert.equal(evaluateAutomationResume({}).allowed, true)
  assert.equal(evaluateAutomationResume({ contactability_status: 'contactable' }).allowed, true)
  assert.equal(evaluateAutomationResume({ lifecycle_stage: 'offer', disposition: 'interested' }).allowed, true)
  assert.equal(evaluateAutomationResume({ disposition: 'no_response' }).allowed, true)
})

// ── patch building ───────────────────────────────────────────────────────────

test('human control couples the manual stage lock; other modes do not', () => {
  assert.deepEqual(buildAutomationModePatch('human_controlled'), {
    patch: { automation_state: 'manual', manual_stage_lock: true },
    meta: { manual_stage_lock: true },
  })
  assert.deepEqual(buildAutomationModePatch('active'), { patch: { automation_state: 'running' }, meta: {} })
  assert.deepEqual(buildAutomationModePatch('paused'), { patch: { automation_state: 'paused' }, meta: {} })
})

test('a mode change never CLEARS the manual stage lock', () => {
  for (const mode of OPERATOR_SELECTABLE_AUTOMATION_MODES) {
    const built = buildAutomationModePatch(mode)
    assert.ok(built)
    assert.notEqual(built.patch.manual_stage_lock, false,
      'releasing the lock is an explicit action, not a side effect of switching mode')
  }
})

test('a system-only mode has no patch at all', () => {
  assert.equal(buildAutomationModePatch('review_required'), null)
  assert.equal(buildAutomationModePatch('disabled'), null)
  assert.equal(buildAutomationModePatch('completed'), null)
})

test('each canonical field writes exactly its own key', () => {
  assert.deepEqual(buildControlWritePayload('lifecycle_stage', 'asking_price')?.patch, { lifecycle_stage: 'asking_price' })
  assert.deepEqual(buildControlWritePayload('operational_status', 'paused')?.patch, { operational_status: 'paused' })
  assert.deepEqual(buildControlWritePayload('lead_temperature', 'hot')?.patch, { lead_temperature: 'hot' })
  assert.deepEqual(buildControlWritePayload('is_read', 'read')?.patch, { is_read: true })
  assert.deepEqual(buildControlWritePayload('is_read', 'unread')?.patch, { is_read: false })
})

test('a stage write never carries a suppression or bucket value', () => {
  for (const bad of ['mf_suppressed', 'dead_suppressed', 'suppressed', 'needs_review', 'follow_up', 'priority']) {
    assert.equal(buildControlWritePayload('lifecycle_stage', bad), null, bad)
  }
})

test('a status write never carries a stage, delivery or suppression value', () => {
  for (const bad of ['closed', 'suppressed', 'delivered', 'undelivered', 'bounced', 'mf_offer_sent']) {
    assert.equal(buildControlWritePayload('operational_status', bad), null, bad)
  }
})

test('a temperature write never carries a delivery value', () => {
  for (const bad of ['delivered', 'failed', 'queued', 'suppressed']) {
    assert.equal(buildControlWritePayload('lead_temperature', bad), null, bad)
  }
})

test('an automation write never carries a system-only mode', () => {
  for (const bad of ['review_required', 'disabled', 'completed', 'quantum']) {
    assert.equal(buildControlWritePayload('automation_state', bad), null, bad)
  }
})

test('a raw boolean is not a read-state value', () => {
  assert.equal(resolveReadStateForWrite(true).ok, false)
  assert.equal(resolveReadStateForWrite('yes').ok, false)
  assert.equal(resolveReadStateForWrite('read').ok, true)
  assert.equal(resolveReadStateForWrite('unread').ok, true)
})

// ── read-back ────────────────────────────────────────────────────────────────

test('a row missing the field is never a confirmation', () => {
  for (const field of DEAL_DESK_CONTROL_FIELDS) {
    assert.equal(readBackControlValue(field, {}), null, field)
    assert.equal(readBackControlValue(field, null), null, field)
  }
})

test('an absent automation_state column is not read as active', () => {
  // The deserializer maps "absent" to `active`; the read-back must NOT, or a failed resume
  // would report success.
  assert.equal(readBackControlValue('automation_state', { lifecycle_stage: 'offer' }), null)
  assert.equal(readBackControlValue('automation_state', { automation_state: 'running' }), 'active')
  assert.equal(readBackControlValue('automation_state', { automation_state: '' }), 'active')
})

test('read-back adopts the server value even when it differs from the request', () => {
  assert.equal(readBackControlValue('lifecycle_stage', { lifecycle_stage: 'ownership_confirmation' }), 'ownership_confirmation')
  assert.equal(readBackControlValue('operational_status', { operational_status: 'snoozed' }), 'snoozed')
  assert.equal(readBackControlValue('is_read', { is_read: false }), 'unread')
  assert.equal(readBackControlValue('is_read', { is_read: true }), 'read')
})

test('a read-back value the strict resolver refuses is not a confirmation', () => {
  assert.equal(readBackControlValue('lifecycle_stage', { lifecycle_stage: 'mf_units_confirmed' }), null)
  assert.equal(readBackControlValue('operational_status', { operational_status: 'suppressed' }), null)
})

// ── current-value reads ──────────────────────────────────────────────────────

test('a stored mf_suppressed stage is unsupported, not ownership_confirmation', () => {
  const resolved = readStageValue({ lifecycle_stage: 'mf_suppressed' })
  assert.equal(resolved.canonical, null)
  assert.equal(resolved.unsupported, true)
  assert.equal(resolved.raw, 'mf_suppressed')
})

test('a declared legacy stage maps deliberately', () => {
  assert.equal(readStageValue({ seller_stage: 'ownership_check' }).canonical, 'ownership_confirmation')
  assert.equal(readStageValue({ stage: 'price_discovery' }).canonical, 'asking_price')
  assert.equal(readStageValue({ lifecycle_stage: 'offer' }).canonical, 'offer')
})

test('the canonical stage column outranks every legacy source', () => {
  const resolved = readStageValue({ lifecycle_stage: 'offer', seller_stage: 'ownership_check', stage: 'negotiation' })
  assert.equal(resolved.canonical, 'offer')
})

test('operational status is never read out of the read/archive `status` field', () => {
  // `InboxThread.status` is 'read' | 'unread' | 'archived'.
  const resolved = readStatusValue({ status: 'unread' })
  assert.equal(resolved.canonical, null)
  assert.equal(resolved.raw, '')
  assert.equal(resolved.unsupported, false, 'an unread flag is simply not a status, not a broken one')
})

test('inboxStatus is consulted only through the strict resolver', () => {
  assert.equal(readStatusValue({ inboxStatus: 'new_reply' }).canonical, 'new_reply')
  assert.equal(readStatusValue({ inboxStatus: 'queued' }).canonical, 'scheduled')
  const suppressed = readStatusValue({ inboxStatus: 'suppressed' })
  assert.equal(suppressed.canonical, null)
  assert.equal(suppressed.unsupported, true)
})

test('temperature falls back to unscored, never to a hot guess', () => {
  assert.equal(readTemperatureValue({}).canonical, 'unscored')
  assert.equal(readTemperatureValue({ isHotLead: true }).canonical, 'unscored')
  assert.equal(readTemperatureValue({ lead_temperature: 'hot' }).canonical, 'hot')
  assert.equal(readTemperatureValue({ temperature: 'urgent' }).canonical, 'hot')
})

test('read state handles both is_read and the inverse unread shape', () => {
  assert.equal(readReadStateValue({ is_read: true }).canonical, 'read')
  assert.equal(readReadStateValue({ is_read: false }).canonical, 'unread')
  assert.equal(readReadStateValue({ unread: true }).canonical, 'unread')
  assert.equal(readReadStateValue({}).canonical, 'unread')
})

test('the manual stage lock is read from its own column', () => {
  assert.equal(readManualStageLock({ manual_stage_lock: true }), true)
  assert.equal(readManualStageLock({ manualStageLock: true }), true)
  assert.equal(readManualStageLock({ automation_state: 'manual' }), false, 'never inferred from the mode')
  assert.equal(readManualStageLock({}), false)
})

// ── operator-facing failure text ─────────────────────────────────────────────

test('every server reason resolves to an operator-safe message', () => {
  const codes = [
    'automation_resume_blocked_suppressed',
    'automation_resume_blocked_terminal_stage',
    'automation_resume_blocked_terminal_disposition',
    'manual_stage_lock_blocked_stage_write',
    'invalid_canonical_thread_key',
    'no_allowed_patch_fields',
  ]
  for (const code of codes) {
    assert.ok(isKnownServerRefusal(code), code)
    const message = describeServerRefusal(code)
    assert.ok(message.length > 0)
    assert.doesNotMatch(message, /\+1\d{10}/, 'no phone number')
    assert.doesNotMatch(message, /https?:/, 'no URL')
    assert.doesNotMatch(message, new RegExp(code), 'no raw identifier')
  }
})

test('an unknown reason falls back to a neutral message and is flagged as unknown', () => {
  assert.equal(isKnownServerRefusal('mystery'), false)
  assert.equal(describeServerRefusal('mystery'), 'The change could not be saved.')
  assert.equal(describeServerRefusal(null), 'The change could not be saved.')
  assert.equal(describeServerRefusal(undefined), 'The change could not be saved.')
})

test('prototype keys cannot reach the message table or the mode resolver', () => {
  assert.equal(describeServerRefusal('constructor'), 'The change could not be saved.')
  assert.equal(describeServerRefusal('__proto__'), 'The change could not be saved.')
  assert.equal(resolveOperatorAutomationModeForControl('constructor').ok, false)
  assert.equal(resolveOperatorAutomationModeForControl('__proto__').ok, false)
})

// ── the client-side patch allowlist ──────────────────────────────────────────

test('the client patch allowlist carries automation_state', () => {
  // Without this the patch is emptied before the request is built and
  // `persistUniversalLeadState` returns "No allowed universal lead state fields in patch"
  // — a save failure with nothing on the wire to explain it.
  assert.ok(UNIVERSAL_LEAD_STATE_PATCH_FIELDS.includes('automation_state'))
})

test('the client patch normalizer is as strict as the server', () => {
  assert.deepEqual(normalizePatchToCanonical({ automation_state: 'running' }), { automation_state: 'running' })
  assert.deepEqual(normalizePatchToCanonical({ automation_state: 'PAUSED' }), { automation_state: 'paused' })
  assert.deepEqual(normalizePatchToCanonical({ automation_state: 'active' }), {},
    'the canonical UI code is not a database value')
  assert.deepEqual(normalizePatchToCanonical({ automation_state: 'quantum' }), {})
})

test('the registry duplicate of the persisted automation values matches the contract', () => {
  // The registry cannot import the contract (that would be circular), so the two lists are
  // asserted equal here instead.
  assert.deepEqual([...PERSISTED_AUTOMATION_STATE_VALUES], [...PERSISTED_AUTOMATION_STATES])
})

test('every operator write payload survives the client patch normalizer intact', () => {
  const payloads = [
    buildControlWritePayload('automation_state', 'active'),
    buildControlWritePayload('automation_state', 'paused'),
    buildControlWritePayload('automation_state', 'human_controlled'),
    buildControlWritePayload('lifecycle_stage', 'asking_price'),
    buildControlWritePayload('operational_status', 'waiting_on_seller'),
    buildControlWritePayload('lead_temperature', 'hot'),
    buildControlWritePayload('is_read', 'read'),
  ]
  for (const payload of payloads) {
    assert.ok(payload)
    const normalized = normalizePatchToCanonical(payload.patch)
    assert.deepEqual(normalized, payload.patch,
      `the allowlist dropped part of ${JSON.stringify(payload.patch)} — the write would never be sent`)
  }
})
