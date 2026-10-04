/**
 * BULK LEAD-STATE — the Inbox bulk bar's one server authority.
 * Each item through the canonical writer; guards reported per item; nothing
 * suppresses, archives, writes a disposition or sends; per-item deadline.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBulkLeadStateService, parseBulkLeadStateRequest, BulkLeadStateError } from '../../src/lib/domain/lead-state/bulk-lead-state-service.js'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const A = '+16125550101'
const B = '+16125550102'

test('parse: stage S1-S6 only; S7+ goes to Closing Desk; no suppression/disposition writes exist', () => {
  assert.deepEqual(parseBulkLeadStateRequest({ action: 'stage', ids: [A], value: 'asking_price' }, NOW).patch, { lifecycle_stage: 'asking_price' })
  assert.throws(() => parseBulkLeadStateRequest({ action: 'stage', ids: [A], value: 'closed' }, NOW), (e) => e instanceof BulkLeadStateError && e.code === 'stage_needs_closing_desk')
  assert.throws(() => parseBulkLeadStateRequest({ action: 'stage', ids: [A], value: 'dead_suppressed' }, NOW))
  assert.throws(() => parseBulkLeadStateRequest({ action: 'status', ids: [A], value: 'suppressed' }, NOW))
  assert.throws(() => parseBulkLeadStateRequest({ action: 'suppress', ids: [A] }, NOW))
  assert.throws(() => parseBulkLeadStateRequest({ action: 'disposition', ids: [A], value: 'not_interested' }, NOW))
})

test('parse: follow-up is a date (no send), snooze defaults to 24 h, read/unread explicit', () => {
  assert.deepEqual(parseBulkLeadStateRequest({ action: 'follow_up', ids: [A], value: '2026-10-30' }, NOW).patch, { follow_up_at: '2026-10-30T00:00:00.000Z' })
  assert.throws(() => parseBulkLeadStateRequest({ action: 'follow_up', ids: [A], value: '2030-01-01' }, NOW))
  assert.equal(parseBulkLeadStateRequest({ action: 'snooze', ids: [A] }, NOW).patch.snoozed_until, '2026-10-05T12:00:00.000Z')
  assert.deepEqual(parseBulkLeadStateRequest({ action: 'unsnooze', ids: [A] }, NOW).patch, { snoozed_until: null })
  assert.deepEqual(parseBulkLeadStateRequest({ action: 'read', ids: [A] }, NOW).patch, { is_read: true })
  assert.deepEqual(parseBulkLeadStateRequest({ action: 'unread', ids: [A] }, NOW).patch, { is_read: false })
})

test('run: one canonical write per item; a guard refusal is reported per item; no manufactured reason', async () => {
  const calls = []
  const service = createBulkLeadStateService({
    patchLeadState: async (args) => {
      calls.push(args)
      if (args.threadKey === B) return { ok: true, blocked: true, reason: 'canonical_stage_transition_refused' }
      return { ok: true, row: {}, opportunity_stage_sync: { ok: true } }
    },
  })
  const out = await service.run(parseBulkLeadStateRequest({ action: 'stage', ids: [A, B, 'bogus'], value: 'offer' }, NOW), 'op-1')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].meta.source_view, 'bulk_lead_state')
  assert.equal(calls[0].meta.operator_id, 'op-1')
  assert.equal(calls[0].meta.reason, null, 'never a manufactured reason (the projection fence relies on it)')
  const by = Object.fromEntries(out.results.map((r) => [r.id, r]))
  assert.equal(by[A].outcome, 'changed')
  assert.equal(by[B].outcome, 'blocked')
  assert.match(by[B].message, /stage rules refuse/)
  assert.equal(by.bogus.outcome, 'failed')
  assert.deepEqual(out.summary, { requested: 3, changed: 1, unchanged: 0, blocked: 1, failed: 1 })
})

test('run: a slow item answers unconfirmed within its deadline', async () => {
  const service = createBulkLeadStateService({
    itemTimeoutMs: 30,
    patchLeadState: async ({ threadKey }) => { if (threadKey === B) await new Promise((r) => setTimeout(r, 200)); return { ok: true } },
  })
  const out = await service.run(parseBulkLeadStateRequest({ action: 'read', ids: [A, B] }, NOW), 'op-1')
  assert.deepEqual(out.results.map((r) => r.outcome), ['changed', 'unconfirmed'])
})

test('run: operator required', async () => {
  const service = createBulkLeadStateService({ patchLeadState: async () => ({ ok: true }) })
  await assert.rejects(() => service.run(parseBulkLeadStateRequest({ action: 'read', ids: [A] }, NOW), null), (e) => e.code === 'operator_unknown')
})
