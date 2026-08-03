/**
 * N.2 — canonical control vocabularies and the mutation state machine.
 *
 * Covers DD-002 (lossy vocabularies, silent fallback) and DD-004 (optimistic patches
 * never rolled back).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTOMATION_MODE_ORDER,
  LEGACY_STAGE_MAP,
  LEGACY_STATUS_MAP,
  SUPPRESSION_VOCABULARY,
  UNMAPPED_LEGACY_STAGES,
  describeVocabularyRejection,
  resolveAutomationModeForWrite,
  resolveLeadTemperatureForWrite,
  resolveLifecycleStageForWrite,
  resolveOperationalStatusForWrite,
} from '../../src/domain/lead-state/canonical-control-vocabularies.ts'
import {
  LEAD_TEMPERATURE_ORDER,
  LIFECYCLE_STAGE_ORDER,
  OPERATIONAL_STATUS_ORDER,
} from '../../src/domain/lead-state/universal-lead-state-registry.ts'
import {
  beginMutation,
  clearMutationError,
  confirmMutation,
  createFieldMutationTracker,
  displayedValue,
  failMutation,
  idleMutation,
  reconcileExternalValue,
  rollbackTargetOf,
} from '../../src/domain/inbox/deal-desk-mutation-state.ts'

const ERR = { kind: 'server_error' as const, message: 'Could not save.' }

// ── every canonical value round-trips to itself ──────────────────────────────

test('every canonical lifecycle stage resolves to itself', () => {
  for (const stage of LIFECYCLE_STAGE_ORDER) {
    const r = resolveLifecycleStageForWrite(stage)
    assert.equal(r.ok, true, `${stage} must resolve`)
    assert.equal(r.ok === true && r.value, stage)
    assert.equal(r.ok === true && r.viaAlias, false)
  }
})

test('every canonical operational status resolves to itself', () => {
  for (const status of OPERATIONAL_STATUS_ORDER) {
    const r = resolveOperationalStatusForWrite(status)
    assert.equal(r.ok, true, `${status} must resolve`)
    assert.equal(r.ok === true && r.value, status)
  }
})

test('every canonical temperature resolves to itself', () => {
  for (const temp of LEAD_TEMPERATURE_ORDER) {
    const r = resolveLeadTemperatureForWrite(temp)
    assert.equal(r.ok, true)
    assert.equal(r.ok === true && r.value, temp)
  }
})

test('every canonical automation mode resolves to itself', () => {
  for (const mode of AUTOMATION_MODE_ORDER) {
    const r = resolveAutomationModeForWrite(mode)
    assert.equal(r.ok, true)
    assert.equal(r.ok === true && r.value, mode)
  }
})

// ── THE invariant: suppression can never become a lifecycle stage ────────────

test('INVARIANT: no suppression value can normalize into a lifecycle stage', () => {
  for (const value of SUPPRESSION_VOCABULARY) {
    const r = resolveLifecycleStageForWrite(value)
    assert.equal(
      r.ok,
      false,
      `"${value}" is a suppression value and must never resolve to a lifecycle stage`,
    )
    assert.equal(r.ok === false && r.reason, 'wrong_dimension')
  }
})

test('INVARIANT: no suppression value can normalize into an operational status', () => {
  for (const value of SUPPRESSION_VOCABULARY) {
    const r = resolveOperationalStatusForWrite(value)
    assert.equal(r.ok, false, `"${value}" must not become an operational status`)
  }
})

test('INVARIANT: no suppression value can normalize into a temperature', () => {
  for (const value of SUPPRESSION_VOCABULARY) {
    assert.equal(resolveLeadTemperatureForWrite(value).ok, false)
  }
})

test('mf_suppressed no longer becomes ownership_confirmation (the DD-002 defect)', () => {
  const r = resolveLifecycleStageForWrite('mf_suppressed')
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.reason, 'wrong_dimension')
})

test('dead_suppressed no longer becomes closed', () => {
  // The lenient registry mapped this to `closed` via a `key.includes('dead')` heuristic.
  // Suppression is a contactability fact, not a lifecycle position.
  const r = resolveLifecycleStageForWrite('dead_suppressed')
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.reason, 'wrong_dimension')
})

// ── dimension separation ─────────────────────────────────────────────────────

test('inbox buckets do not normalize into lifecycle stages', () => {
  for (const bucket of ['priority', 'new_replies', 'needs_review', 'cold_no_response']) {
    const r = resolveLifecycleStageForWrite(bucket)
    assert.equal(r.ok, false, `"${bucket}" is a bucket, not a stage`)
  }
})

test('delivery states do not normalize into temperature', () => {
  for (const delivery of ['delivered', 'failed', 'undelivered', 'bounced']) {
    assert.equal(resolveLeadTemperatureForWrite(delivery).ok, false)
  }
})

test('closed is a lifecycle stage and is refused as an operational status', () => {
  // The old INBOX_STATUS_TO_OPERATIONAL collapsed both `closed` and `suppressed` onto
  // `paused`, destroying the difference between them.
  assert.equal(resolveLifecycleStageForWrite('closed').ok, true)
  const asStatus = resolveOperationalStatusForWrite('closed')
  assert.equal(asStatus.ok, false)
  assert.equal(asStatus.ok === false && asStatus.reason, 'wrong_dimension')
})

test('suppressed and closed no longer collapse onto the same status', () => {
  const suppressed = resolveOperationalStatusForWrite('suppressed')
  const closed = resolveOperationalStatusForWrite('closed')
  assert.equal(suppressed.ok, false)
  assert.equal(closed.ok, false)
  // Both rejected — and for a reason the operator can act on, not silently merged.
})

// ── legacy mappings are explicit ─────────────────────────────────────────────

test('every declared legacy stage alias maps to a real canonical stage', () => {
  for (const [legacy, canonical] of Object.entries(LEGACY_STAGE_MAP)) {
    assert.ok(
      (LIFECYCLE_STAGE_ORDER as readonly string[]).includes(canonical),
      `${legacy} maps to ${canonical}, which is not canonical`,
    )
    const r = resolveLifecycleStageForWrite(legacy)
    assert.equal(r.ok, true)
    assert.equal(r.ok === true && r.value, canonical)
    assert.equal(r.ok === true && r.viaAlias, true)
  }
})

test('every declared legacy status alias maps to a real canonical status', () => {
  for (const [legacy, canonical] of Object.entries(LEGACY_STATUS_MAP)) {
    assert.ok((OPERATIONAL_STATUS_ORDER as readonly string[]).includes(canonical), legacy)
    assert.equal(resolveOperationalStatusForWrite(legacy).ok, true)
  }
})

test('multifamily stages with no canonical equivalent are refused, not invented', () => {
  for (const stage of UNMAPPED_LEGACY_STAGES) {
    const r = resolveLifecycleStageForWrite(stage)
    assert.equal(r.ok, false, `${stage} has no canonical equivalent`)
    assert.equal(r.ok === false && r.reason, 'unmapped_legacy')
  }
})

// ── unknown-value policy: never a silent fallback ────────────────────────────

test('unknown values are rejected, never defaulted to a valid unrelated value', () => {
  for (const junk of ['banana', 'stage_47', 'ownership_confirmationX', '???']) {
    const r = resolveLifecycleStageForWrite(junk)
    assert.equal(r.ok, false, `"${junk}" must not resolve`)
    assert.equal(r.ok === false && r.reason, 'unknown')
  }
})

test('empty input is rejected as empty, not defaulted', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const r = resolveLifecycleStageForWrite(empty)
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'empty')
  }
})

test('rejection messages are actionable and carry no internal identifiers', () => {
  const unmapped = resolveLifecycleStageForWrite('mf_rent_roll_requested')
  assert.equal(unmapped.ok, false)
  const msg = describeVocabularyRejection(unmapped as Extract<typeof unmapped, { ok: false }>)
  assert.match(msg, /legacy value with no current equivalent/)
  assert.equal(/undefined|null|\[object|Error:|stack/i.test(msg), false)
})

// ── mutation state machine ───────────────────────────────────────────────────

test('optimistic apply shows the requested value while pending', () => {
  const s = beginMutation(idleMutation('cold'), 'hot', 'm1')
  assert.equal(s.status, 'pending')
  assert.equal(displayedValue(s), 'hot')
  assert.equal(rollbackTargetOf(s), 'cold')
})

test('confirmation adopts the SERVER value, not the requested one', () => {
  const pending = beginMutation(idleMutation('cold'), 'hot', 'm1')
  // Server applied a guard and persisted `warm` instead.
  const confirmed = confirmMutation(pending, 'm1', 'warm')
  assert.equal(confirmed.status, 'confirmed')
  assert.equal(displayedValue(confirmed), 'warm', 'the server wins, and the operator sees it')
})

test('failure restores the previous authoritative value and clears the patch', () => {
  const pending = beginMutation(idleMutation('cold'), 'hot', 'm1')
  const failed = failMutation(pending, 'm1', ERR)
  assert.equal(failed.status, 'failed')
  assert.equal(displayedValue(failed), 'cold', 'rolled back')
  assert.equal(failed.status === 'failed' && failed.attemptedValue, 'hot')
  assert.equal(rollbackTargetOf(failed), null, 'no pending patch survives a failure')
})

test('rollback after rapid changes restores the last CONFIRMED value, not an optimistic one', () => {
  // This is the `useOptimisticField` bug: it reassigns previousRef on every commit, so a
  // rollback after cold→warm→hot would restore `warm` — a value the server never had.
  let s = idleMutation('cold')
  s = beginMutation(s, 'warm', 'm1')
  s = beginMutation(s, 'hot', 'm2')
  assert.equal(rollbackTargetOf(s), 'cold', 'previous authoritative value is carried forward')
  s = failMutation(s, 'm2', ERR)
  assert.equal(displayedValue(s), 'cold')
})

test('a response for a superseded mutation cannot commit', () => {
  let s = beginMutation(idleMutation('cold'), 'warm', 'm1')
  s = beginMutation(s, 'hot', 'm2')
  const stale = confirmMutation(s, 'm1', 'warm')
  assert.equal(displayedValue(stale), 'hot', 'the superseded response is ignored')
  assert.equal(stale.status, 'pending')
})

test('a stale failure cannot roll back a newer mutation', () => {
  let s = beginMutation(idleMutation('cold'), 'warm', 'm1')
  s = beginMutation(s, 'hot', 'm2')
  const stale = failMutation(s, 'm1', ERR)
  assert.equal(stale.status, 'pending', 'the newer mutation is untouched')
  assert.equal(displayedValue(stale), 'hot')
})

test('polling cannot overwrite a pending mutation', () => {
  const pending = beginMutation(idleMutation('cold'), 'hot', 'm1')
  const afterPoll = reconcileExternalValue(pending, 'cold')
  assert.equal(afterPoll, pending, 'operator intent in flight outranks a background refresh')
  assert.equal(displayedValue(afterPoll), 'hot')
})

test('a realtime update reconciles once nothing is pending', () => {
  const confirmed = confirmMutation(beginMutation(idleMutation('cold'), 'hot', 'm1'), 'm1', 'hot')
  const afterRealtime = reconcileExternalValue(confirmed, 'warm')
  assert.equal(displayedValue(afterRealtime), 'warm')
})

test('reconcile returns the identical state when the value is unchanged', () => {
  const confirmed = confirmMutation(beginMutation(idleMutation('cold'), 'hot', 'm1'), 'm1', 'hot')
  assert.equal(reconcileExternalValue(confirmed, 'hot'), confirmed, 'no churn')
})

test('a failed control stays usable for retry and its error can be cleared', () => {
  const failed = failMutation(beginMutation(idleMutation('cold'), 'hot', 'm1'), 'm1', ERR)
  const cleared = clearMutationError(failed)
  assert.equal(cleared.status, 'idle')
  assert.equal(displayedValue(cleared), 'cold')
  const retried = beginMutation(cleared, 'hot', 'm2')
  assert.equal(displayedValue(retried), 'hot')
})

test('no pending patch can outlive its mutation', () => {
  const start = idleMutation('cold')
  for (const terminal of [
    confirmMutation(beginMutation(start, 'hot', 'm'), 'm', 'hot'),
    failMutation(beginMutation(start, 'hot', 'm'), 'm', ERR),
  ]) {
    assert.notEqual(terminal.status, 'pending')
    assert.equal(rollbackTargetOf(terminal), null)
  }
})

// ── per-field serialization ──────────────────────────────────────────────────

test('three rapid temperature writes: only the last may commit', () => {
  const tracker = createFieldMutationTracker()
  const a = tracker.begin('lead_temperature')
  const b = tracker.begin('lead_temperature')
  const c = tracker.begin('lead_temperature')
  assert.equal(tracker.isCurrent('lead_temperature', a), false)
  assert.equal(tracker.isCurrent('lead_temperature', b), false)
  assert.equal(tracker.isCurrent('lead_temperature', c), true)
  assert.equal(tracker.settle('lead_temperature', a), false)
  assert.equal(tracker.settle('lead_temperature', c), true)
  assert.deepEqual(tracker.stats(), { issued: 3, superseded: 2, committed: 1, refused: 1 })
})

test('a slow write on one field does not refuse a fast write on another', () => {
  const tracker = createFieldMutationTracker()
  const stage = tracker.begin('lifecycle_stage')
  const temp = tracker.begin('lead_temperature')
  assert.equal(tracker.isCurrent('lifecycle_stage', stage), true)
  assert.equal(tracker.isCurrent('lead_temperature', temp), true)
  assert.equal(tracker.settle('lead_temperature', temp), true)
  assert.equal(tracker.settle('lifecycle_stage', stage), true, 'fields are independent')
})

test('a duplicate settle for the same mutation is refused (idempotency)', () => {
  const tracker = createFieldMutationTracker()
  const id = tracker.begin('operational_status')
  assert.equal(tracker.settle('operational_status', id), true)
  assert.equal(tracker.settle('operational_status', id), false, 'cannot commit twice')
})

test('pause then rapid resume: resume wins', () => {
  const tracker = createFieldMutationTracker()
  let s = idleMutation('active')
  const pauseId = tracker.begin('automation_mode')
  s = beginMutation(s, 'paused', pauseId)
  const resumeId = tracker.begin('automation_mode')
  s = beginMutation(s, 'active', resumeId)

  // The pause response arrives late and must be refused.
  assert.equal(tracker.settle('automation_mode', pauseId), false)
  assert.equal(confirmMutation(s, pauseId, 'paused').status, 'pending')

  assert.equal(tracker.settle('automation_mode', resumeId), true)
  const final = confirmMutation(s, resumeId, 'active')
  assert.equal(displayedValue(final), 'active')
})
