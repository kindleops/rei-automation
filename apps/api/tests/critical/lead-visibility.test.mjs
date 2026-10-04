/**
 * LEAD VISIBILITY — archive as a shared visibility overlay (owner, 2026-10-04).
 * In-memory ports; no network, no database.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createLeadVisibilityService, planThreadAction, planOpportunityAction, planInboundReply, parseVisibilityRequest,
  deterministicActionId, scheduledSendsNote,
} from '../../src/lib/domain/lead-visibility/lead-visibility-service.js'
import { resolveLeadVisibilityGate, resetLeadVisibilityGate } from '../../src/lib/domain/lead-visibility/lead-visibility-gate.js'
import { createBulkArchiveService } from '../../src/lib/domain/archive/bulk-archive-service.js'

const T1 = '+16125550101'
const T2 = '+16125550102'
const O1 = '11111111-1111-4111-8111-111111111111'
const O2 = '22222222-2222-4222-8222-222222222222'
const O3 = '33333333-3333-4333-8333-333333333333'
const OP = 'op-ryan'

function world() {
  const threads = new Map([
    [T1, { thread_key: T1, is_archived: false, archive_scope: null, property_id: 'p1' }],
    [T2, { thread_key: T2, is_archived: false, archive_scope: null, property_id: 'p9' }],
  ])
  const opps = new Map([
    // T1 carries ONE deal (the common case: 786/786 in prod)
    [O1, { id: O1, primary_thread_key: '6125550101', primary_property_id: 'p1', opportunity_status: 'nurture', acquisition_stage: 'offer_interest', archived_at: null }],
    // T2 carries TWO deals (one seller, two properties)
    [O2, { id: O2, primary_thread_key: T2, primary_property_id: 'p2', opportunity_status: 'active', acquisition_stage: 'asking_price', archived_at: null }],
    [O3, { id: O3, primary_thread_key: T2, primary_property_id: 'p3', opportunity_status: 'active', acquisition_stage: 'offer', archived_at: null }],
  ])
  const queue = new Map([[T1, { count: 1, nextAt: '2026-10-30T15:00:00Z' }]])
  const actions = new Map()
  const writes = { thread: [], opp: [], cancelled: 0 }
  const tenOf = (k) => String(k).replace(/\D/g, '').slice(-10)
  const ports = {
    readThreadState: async (k) => threads.get(k) ?? null,
    listLinkedOpportunities: async (k) => [...opps.values()].filter((o) => tenOf(o.primary_thread_key) === tenOf(k)).map((o) => ({ ...o })),
    readOpportunity: async (id) => (opps.get(id) ? { ...opps.get(id) } : null),
    describeScheduledSends: async (k) => queue.get(k) ?? { count: 0, nextAt: null },
    patchLeadState: async ({ threadKey, patch, meta }) => {
      writes.thread.push({ threadKey, patch, meta })
      const t = threads.get(threadKey)
      threads.set(threadKey, { ...t, is_archived: patch.is_archived, archive_scope: patch.is_archived ? patch.archive_scope : null })
      return { ok: true }
    },
    setOpportunityVisibility: async (id, { archived, actionId }) => {
      const o = opps.get(id)
      if (Boolean(o.archived_at) === archived) return { ok: true, changed: false }
      writes.opp.push({ id, archived, actionId })
      opps.set(id, { ...o, archived_at: archived ? '2026-10-04T12:00:00Z' : null })
      return { ok: true, changed: true }
    },
    resolveReplyProperty: async () => null,
    readAction: async (id) => actions.get(id) ?? null,
    insertAction: async (row) => { if (!actions.has(row.action_id)) actions.set(row.action_id, { ...row }) },
    updateAction: async (id, patch) => { actions.set(id, { ...actions.get(id), ...patch }) },
    listPendingResolutions: async (keys) => [...actions.values()].filter((a) => a.status === 'pending_resolution' && keys.includes(a.thread_key)),
    resolvePending: async (key) => { for (const a of actions.values()) if (a.thread_key === key && a.status === 'pending_resolution') a.status = 'resolved' },
  }
  return { ports, threads, opps, queue, actions, writes }
}

test('archive never changes stage, status, automation or nurture — only visibility', async () => {
  const w = world()
  const svc = createLeadVisibilityService(w.ports)
  const out = await svc.apply(parseVisibilityRequest({ action: 'archive', thread_keys: [T1] }), OP)
  assert.equal(out.status, 'applied')
  assert.equal(w.threads.get(T1).is_archived, true)
  assert.ok(w.opps.get(O1).archived_at, 'the linked deal is hidden too (1 thread : 1 deal)')
  assert.equal(w.opps.get(O1).opportunity_status, 'nurture', '30-day follow-up untouched')
  assert.equal(w.opps.get(O1).acquisition_stage, 'offer_interest')
  for (const t of w.writes.thread) assert.deepEqual(Object.keys(t.patch).sort(), ['archive_reason', 'archive_scope', 'is_archived'])
})

test('a queued follow-up never blocks archive, is never cancelled, and is reported', async () => {
  const w = world()
  const svc = createLeadVisibilityService(w.ports)
  const out = await svc.apply(parseVisibilityRequest({ action: 'archive', opportunity_ids: [O1] }), OP)
  const deal = out.results.find((r) => r.kind === 'opportunity')
  assert.equal(deal.outcome, 'archived')
  assert.match(deal.note, /^1 follow-up still scheduled \(Oct 30\)$/)
  assert.equal(deal.queue_link, '/queue')
  assert.equal(w.queue.get(T1).count, 1, 'the send stays queued')
  assert.equal(w.writes.cancelled, 0)
})

test('legacy path (flag off) keeps the queued-sends guard', async () => {
  const legacy = createBulkArchiveService({
    visibility: async () => null, // flag off
    readThreadState: async () => ({ is_archived: false }),
    countActiveSendsForThread: async () => 1,
    readOpportunity: async () => ({ id: O1, opportunity_status: 'active', primary_thread_key: T1 }),
    patchLeadState: async () => ({ ok: true }),
    updateOpportunity: async () => ({ ok: true }),
  })
  const out = await legacy.run({ objectType: 'opportunity', action: 'archive', ids: [O1], reason: null }, OP)
  assert.equal(out.results[0].outcome, 'blocked')
  assert.equal(out.results[0].reason, 'queued_sends')
})

test('visibility path through bulk archive: queued send → archived with a note', async () => {
  const w = world()
  const svc = createLeadVisibilityService(w.ports)
  const bulk = createBulkArchiveService({ visibility: async () => svc })
  const out = await bulk.run({ objectType: 'opportunity', action: 'archive', ids: [O1], reason: null }, OP)
  assert.equal(out.results[0].outcome, 'archived')
  assert.match(out.results[0].message, /Archived · 1 follow-up still scheduled/)
  assert.equal(w.queue.get(T1).count, 1)
})

test('one seller, two deals: archiving one deal keeps the conversation (owner rule 2)', async () => {
  const w = world()
  const svc = createLeadVisibilityService(w.ports)
  const out = await svc.apply(parseVisibilityRequest({ action: 'archive', opportunity_ids: [O2] }), OP)
  assert.ok(w.opps.get(O2).archived_at)
  assert.equal(w.opps.get(O3).archived_at, null)
  assert.equal(w.threads.get(T2).is_archived, false)
  assert.equal(out.results[0].thread_kept, 'other_live_deal')
  // archiving the last live deal now also hides the conversation
  await svc.apply(parseVisibilityRequest({ action: 'archive', opportunity_ids: [O3] }), OP)
  assert.equal(w.threads.get(T2).is_archived, true)
})

test('archiving a two-deal conversation with an unmatched property asks — nothing is written', async () => {
  const w = world()
  const svc = createLeadVisibilityService(w.ports)
  const out = await svc.apply(parseVisibilityRequest({ action: 'archive', thread_keys: [T2] }), OP)
  assert.equal(out.results[0].outcome, 'needs_scope')
  assert.equal(out.results[0].candidates.length, 2)
  assert.equal(w.writes.thread.length + w.writes.opp.length, 0)
  const chosen = await svc.apply(parseVisibilityRequest({ action: 'archive', thread_keys: [T2], scope_choice: [O3] }), OP)
  assert.equal(chosen.status, 'applied')
  assert.ok(w.opps.get(O3).archived_at)
  assert.equal(w.opps.get(O2).archived_at, null)
})

test('idempotent by action id; undo reverses exactly what changed', async () => {
  const w = world()
  const svc = createLeadVisibilityService(w.ports)
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  await svc.apply(parseVisibilityRequest({ action: 'archive', thread_keys: [T1], action_id: id }), OP)
  const writesAfterFirst = w.writes.thread.length + w.writes.opp.length
  const replay = await svc.apply(parseVisibilityRequest({ action: 'archive', thread_keys: [T1], action_id: id }), OP)
  assert.equal(replay.replayed, true)
  assert.equal(w.writes.thread.length + w.writes.opp.length, writesAfterFirst)
  const undo = await svc.apply(parseVisibilityRequest({ undo_of: id }), OP)
  assert.equal(undo.action, 'unarchive')
  assert.equal(w.threads.get(T1).is_archived, false)
  assert.equal(w.opps.get(O1).archived_at, null)
})

test('inbound reply (owner rule 3): one archived deal is restored', async () => {
  const w = world()
  const svc = createLeadVisibilityService(w.ports)
  await svc.apply(parseVisibilityRequest({ action: 'archive', thread_keys: [T1] }), OP)
  const out = await svc.recordInboundReply({ threadKey: T1, inboundEventId: 'evt-1' })
  assert.deepEqual(out.restored, [O1])
  assert.equal(w.opps.get(O1).archived_at, null)
})

test('inbound reply: several archived deals, property unclear → kept archived with a visible pending marker', async () => {
  const w = world()
  const svc = createLeadVisibilityService(w.ports)
  await svc.apply(parseVisibilityRequest({ action: 'archive', thread_keys: [T2], scope_choice: [O2, O3] }), OP)
  const out = await svc.recordInboundReply({ threadKey: T2, inboundEventId: 'evt-2' })
  assert.equal(out.restored.length, 0)
  assert.equal(out.pending.length, 2)
  assert.ok(w.opps.get(O2).archived_at && w.opps.get(O3).archived_at)
  const pending = await svc.listPending([T2])
  assert.equal(pending.length, 1)
  assert.equal(pending[0].candidates.length, 2)
  // replaying the same inbound event is a no-op
  const again = await svc.recordInboundReply({ threadKey: T2, inboundEventId: 'evt-2' })
  assert.equal(again.replayed, true)
  // the operator picks the deal → the marker is resolved
  await svc.apply(parseVisibilityRequest({ action: 'unarchive', opportunity_ids: [O3] }), OP)
  assert.equal((await svc.listPending([T2])).length, 0)
})

test('inbound reply: the reply resolves to one property → only that deal returns', async () => {
  const w = world()
  w.ports.resolveReplyProperty = async () => 'p3'
  const svc = createLeadVisibilityService(w.ports)
  await svc.apply(parseVisibilityRequest({ action: 'archive', thread_keys: [T2], scope_choice: [O2, O3] }), OP)
  const out = await svc.recordInboundReply({ threadKey: T2, inboundEventId: 'evt-3' })
  assert.deepEqual(out.restored, [O3])
  assert.ok(w.opps.get(O2).archived_at)
})

test('pure planners', () => {
  assert.deepEqual(planThreadAction({ action: 'archive', thread: { property_id: 'p2' }, linked: [{ id: 'a', primary_property_id: 'p2' }, { id: 'b', primary_property_id: 'p3' }] }), { opportunityIds: ['a'], needsScope: null })
  assert.equal(planOpportunityAction({ action: 'unarchive', thread: { is_archived: true, archive_scope: 'identity_alignment' } }).thread, null)
  assert.deepEqual(planInboundReply({ archivedLinked: [] }), { restore: [], pending: null })
  assert.equal(deterministicActionId('x'), deterministicActionId('x'))
  assert.match(deterministicActionId('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(scheduledSendsNote({ count: 0 }), null)
})

test('gate: flag off never probes the schema; flag on + missing schema stays off', async () => {
  resetLeadVisibilityGate()
  let probes = 0
  const supabase = { from: () => ({ select: () => ({ limit: async () => { probes += 1; return { error: { code: '42703' } } } }) }) }
  const off = await resolveLeadVisibilityGate({ supabase, getFlag: async () => false, now: 1 })
  assert.deepEqual([off.enabled, off.reason, probes], [false, 'flag_off', 0])
  resetLeadVisibilityGate()
  const missing = await resolveLeadVisibilityGate({ supabase, getFlag: async () => true, now: 2 })
  assert.deepEqual([missing.enabled, missing.reason], [false, 'schema_missing'])
  resetLeadVisibilityGate()
  const ok = await resolveLeadVisibilityGate({ supabase: { from: () => ({ select: () => ({ limit: async () => ({ error: null }) }) }) }, getFlag: async () => true, now: 3 })
  assert.equal(ok.enabled, true)
  resetLeadVisibilityGate()
})
