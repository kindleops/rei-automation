/**
 * BULK ARCHIVE — per-item, reversible, audited archive for threads,
 * opportunities and campaigns. No network, no database: in-memory ports.
 *   auth gate · operator required · validation · idempotency · partial
 *   failure · blocked-with-queued-sends · won refused · unarchive restores the
 *   recorded prior status (never guessed) · campaigns go through the lifecycle.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createBulkArchiveService,
  parseBulkRequest,
  threadKeyVariants,
  BULK_MAX_IDS,
} from '../../src/lib/domain/archive/bulk-archive-service.js'
import { createBulkArchiveRoutes } from '../../src/lib/domain/archive/bulk-archive-routes.js'

const OP = 'op-ryan'
const T1 = '+15551230001'
const T2 = '+15551230002'
const T3 = '+15551230003'
const O1 = '11111111-1111-4111-8111-111111111111'
const O2 = '22222222-2222-4222-8222-222222222222'
const O3 = '33333333-3333-4333-8333-333333333333'
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const C2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function fakePorts() {
  const threads = new Map([[T1, { is_archived: false }], [T2, { is_archived: true }], [T3, { is_archived: false }]])
  const opps = new Map([
    [O1, { id: O1, opportunity_status: 'dead', primary_thread_key: '15551239999' }],
    [O2, { id: O2, opportunity_status: 'won', primary_thread_key: null }],
    [O3, { id: O3, opportunity_status: 'active', primary_thread_key: T3 }],
  ])
  const oppHistory = []
  const campaigns = new Map([[C1, { id: C1, status: 'draft' }], [C2, { id: C2, status: 'active' }], [C3, { id: C3, status: 'completed' }]])
  const queued = new Map([[T3, 2]]) // thread key → active sends
  const campaignQueued = new Map([[C3, 1]])
  const calls = { patch: [], opp: [], lifecycle: [], events: [] }
  const ports = {
    readThreadState: async (k) => threads.get(k) ?? null,
    countActiveSendsForThread: async (k) => queued.get(k) ?? 0,
    patchLeadState: async ({ threadKey, patch, meta }) => {
      calls.patch.push({ threadKey, patch, meta })
      if (threadKey === '+15550000000') return { ok: false, blocked: true, reason: 'boom' }
      threads.set(threadKey, { ...(threads.get(threadKey) ?? {}), is_archived: patch.is_archived })
      return { ok: true, row: {} }
    },
    readOpportunity: async (id) => opps.get(id) ?? null,
    findStatusBeforeArchive: async (id) => {
      const hit = [...oppHistory].reverse().find((h) => h.id === id && h.to === 'archived')
      return hit?.from ?? null
    },
    updateOpportunity: async (id, patch) => {
      calls.opp.push({ id, patch })
      const row = opps.get(id)
      oppHistory.push({ id, from: row.opportunity_status, to: patch.opportunity_status })
      row.opportunity_status = patch.opportunity_status
      return { ok: true }
    },
    readCampaign: async (id) => campaigns.get(id) ?? null,
    countActiveSendsForCampaign: async (id) => campaignQueued.get(id) ?? 0,
    campaignLifecycle: async (id, input) => {
      calls.lifecycle.push({ id, input })
      const row = campaigns.get(id)
      row.status = input.action === 'archive' ? 'archived' : 'draft'
      return { ok: true }
    },
    recordCampaignEvent: async (fields) => { calls.events.push(fields) },
  }
  return { ports, calls, threads, opps, campaigns, queued, campaignQueued }
}

const byId = (out) => Object.fromEntries(out.results.map((r) => [r.id, r]))

test('parseBulkRequest validates type, action, ids and the per-request cap; dedupes ids', () => {
  assert.throws(() => parseBulkRequest(null), /body must be an object/)
  assert.throws(() => parseBulkRequest({ object_type: 'property', action: 'archive', ids: ['x'] }), /object_type/)
  assert.throws(() => parseBulkRequest({ object_type: 'campaign', action: 'delete', ids: ['x'] }), /action/)
  assert.throws(() => parseBulkRequest({ object_type: 'campaign', action: 'archive', ids: [] }), /non-empty/)
  assert.throws(() => parseBulkRequest({ object_type: 'campaign', action: 'archive', ids: Array.from({ length: BULK_MAX_IDS + 1 }, (_, i) => `id${i}`) }), /at most/)
  const ok = parseBulkRequest({ object_type: 'campaign', action: 'archive', ids: [' a ', 'a', 'b', ''] })
  assert.deepEqual(ok.ids, ['a', 'b'])
})

test('threadKeyVariants covers every stored spelling', () => {
  assert.deepEqual(threadKeyVariants('+15551230001').sort(), ['+15551230001', '15551230001', '5551230001'].sort())
})

test('threads: archive is idempotent, blocked with queued sends, audited with the operator', async () => {
  const { ports, calls, threads } = fakePorts()
  const svc = createBulkArchiveService(ports)
  const out = await svc.run({ objectType: 'inbox_thread', action: 'archive', ids: [T1, T2, T3, 'bad-key'], reason: null }, OP)
  const r = byId(out)
  assert.equal(r[T1].outcome, 'archived')
  assert.equal(r[T2].outcome, 'unchanged')
  assert.equal(r[T3].outcome, 'blocked')
  assert.equal(r[T3].reason, 'queued_sends')
  assert.equal(r[T3].queued_sends, 2)
  assert.equal(r['bad-key'].outcome, 'failed')
  assert.deepEqual(out.summary, { requested: 4, changed: 1, unchanged: 1, blocked: 1, failed: 1 })
  assert.equal(out.partial, true)
  // only T1 was written, with the operator on the audit meta, and nothing touched read state
  assert.equal(calls.patch.length, 1)
  assert.equal(calls.patch[0].meta.operator_id, OP)
  assert.equal(calls.patch[0].meta.source_view, 'bulk_archive')
  assert.equal('is_read' in calls.patch[0].patch, false)
  assert.equal(threads.get(T3).is_archived, false)
  // running it again changes nothing
  const again = await svc.run({ objectType: 'inbox_thread', action: 'archive', ids: [T1], reason: null }, OP)
  assert.equal(again.results[0].outcome, 'unchanged')
  assert.equal(calls.patch.length, 1)
})

test('threads: unarchive reverses, never checks sends, and is idempotent', async () => {
  const { ports, threads } = fakePorts()
  const svc = createBulkArchiveService(ports)
  const out = await svc.run({ objectType: 'inbox_thread', action: 'unarchive', ids: [T2, T1], reason: null }, OP)
  const r = byId(out)
  assert.equal(r[T2].outcome, 'unarchived')
  assert.equal(r[T1].outcome, 'unchanged')
  assert.equal(threads.get(T2).is_archived, false)
})

test('threads: a refused write is a per-item failure, not a crash', async () => {
  const { ports } = fakePorts()
  const svc = createBulkArchiveService(ports)
  const out = await svc.run({ objectType: 'inbox_thread', action: 'archive', ids: ['+15550000000', T1], reason: null }, OP)
  const r = byId(out)
  assert.equal(r['+15550000000'].outcome, 'failed')
  assert.equal(r['+15550000000'].reason, 'boom')
  assert.equal(r[T1].outcome, 'archived')
})

test('a thrown port error fails that item only', async () => {
  const { ports } = fakePorts()
  ports.readThreadState = async (k) => { if (k === T1) throw new Error('db down'); return { is_archived: false } }
  const out = await createBulkArchiveService(ports).run({ objectType: 'inbox_thread', action: 'archive', ids: [T1, T2], reason: null }, OP)
  const r = byId(out)
  assert.equal(r[T1].outcome, 'failed')
  assert.match(r[T1].message, /db down/)
  assert.equal(r[T2].outcome, 'archived')
})

test('opportunities: won refused, queued sends block, archive → unarchive restores the recorded prior status', async () => {
  const { ports, opps, calls } = fakePorts()
  const svc = createBulkArchiveService(ports)
  const out = await svc.run({ objectType: 'opportunity', action: 'archive', ids: [O1, O2, O3], reason: 'stray' }, OP)
  const r = byId(out)
  assert.equal(r[O1].outcome, 'archived')
  assert.equal(r[O1].previous_status, 'dead')
  assert.equal(r[O2].reason, 'won_is_closing_authority')
  assert.equal(r[O3].reason, 'queued_sends')
  assert.equal(opps.get(O1).opportunity_status, 'archived')
  assert.equal(calls.opp[0].patch.actor, OP)
  assert.equal(calls.opp[0].patch.source, 'operator_bulk_archive')

  const undo = await svc.run({ objectType: 'opportunity', action: 'unarchive', ids: [O1], reason: null }, OP)
  assert.equal(undo.results[0].outcome, 'unarchived')
  assert.equal(undo.results[0].state, 'dead')
  assert.equal(opps.get(O1).opportunity_status, 'dead')
})

test('opportunities: unarchive without history is refused, not guessed', async () => {
  const { ports, opps } = fakePorts()
  opps.get(O1).opportunity_status = 'archived' // archived before this feature: no history row
  const out = await createBulkArchiveService(ports).run({ objectType: 'opportunity', action: 'unarchive', ids: [O1, O3, '00000000-0000-4000-8000-000000000000'], reason: null }, OP)
  const r = byId(out)
  assert.equal(r[O1].outcome, 'blocked')
  assert.equal(r[O1].reason, 'prior_status_unknown')
  assert.equal(r[O3].outcome, 'unchanged')
  assert.equal(r['00000000-0000-4000-8000-000000000000'].reason, 'not_found')
  assert.equal(opps.get(O1).opportunity_status, 'archived')
})

test('campaigns: live and pending-send campaigns are blocked; archive goes through the lifecycle with an actor event; restore → draft', async () => {
  const { ports, calls, campaigns } = fakePorts()
  const svc = createBulkArchiveService(ports)
  const out = await svc.run({ objectType: 'campaign', action: 'archive', ids: [C1, C2, C3], reason: null }, OP)
  const r = byId(out)
  assert.equal(r[C1].outcome, 'archived')
  assert.equal(r[C2].reason, 'campaign_live')
  assert.equal(r[C3].reason, 'queued_sends')
  assert.equal(calls.lifecycle.length, 1)
  assert.equal(calls.lifecycle[0].input.action, 'archive')
  assert.match(calls.lifecycle[0].input.reason, /operator:op-ryan/)
  assert.equal(calls.events[0].metadata.actor, OP)
  assert.equal(campaigns.get(C2).status, 'active')

  const again = await svc.run({ objectType: 'campaign', action: 'archive', ids: [C1], reason: null }, OP)
  assert.equal(again.results[0].outcome, 'unchanged')

  const undo = await svc.run({ objectType: 'campaign', action: 'unarchive', ids: [C1, C2], reason: null }, OP)
  const u = byId(undo)
  assert.equal(u[C1].outcome, 'unarchived')
  assert.equal(u[C1].state, 'draft')
  assert.equal(u[C2].outcome, 'unchanged')
  assert.equal(calls.lifecycle[1].input.action, 'restore')
})

test('campaigns: a lifecycle refusal is reported per item', async () => {
  const { ports } = fakePorts()
  ports.campaignLifecycle = async () => ({ ok: false, error: 'illegal_campaign_transition' })
  const out = await createBulkArchiveService(ports).run({ objectType: 'campaign', action: 'archive', ids: [C1], reason: null }, OP)
  assert.equal(out.results[0].outcome, 'failed')
  assert.equal(out.results[0].reason, 'illegal_campaign_transition')
})

test('service refuses to run without an operator', async () => {
  const { ports } = fakePorts()
  await assert.rejects(() => createBulkArchiveService(ports).run({ objectType: 'campaign', action: 'archive', ids: [C1] }, null), /operator/)
})

/* ── route ───────────────────────────────────────────────────────────── */

function routesWith({ authorized = true, ports } = {}) {
  const svc = createBulkArchiveService(ports ?? fakePorts().ports)
  return createBulkArchiveRoutes({
    getService: async () => svc,
    authorize: () => (authorized ? { ok: true } : { ok: false, response: new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 }) }),
    cors: () => ({}),
  })
}

const post = (body, headers = { 'x-ops-user-id': OP }) => new Request('http://local/api/cockpit/archive/bulk', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

test('route: dashboard auth gate first', async () => {
  const res = await routesWith({ authorized: false }).POST(post({ object_type: 'campaign', action: 'archive', ids: [C1] }))
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error, 'unauthorized')
})

test('route: a missing Worker-verified operator is 401 operator_unknown; a body actor is ignored', async () => {
  const { ports, calls } = fakePorts()
  const res = await routesWith({ ports }).POST(post({ object_type: 'campaign', action: 'archive', ids: [C1], actor: 'someone' }, {}))
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error, 'operator_unknown')
  assert.equal(calls.lifecycle.length, 0)
})

test('route: invalid body is 400 with the reason', async () => {
  const res = await routesWith().POST(post({ object_type: 'campaign', action: 'archive', ids: 'x' }))
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error, 'invalid_request')
})

test('route: partial results are 200 with one result per id', async () => {
  const res = await routesWith().POST(post({ object_type: 'inbox_thread', action: 'archive', ids: [T1, T3] }))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.partial, true)
  assert.equal(body.operator_id, OP)
  assert.equal(body.results.length, 2)
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

/* ── exclusion predicates: archived leaves the counts ─────────────────── */

import { threadMatchesBucketFilter, isArchivedThread } from '../../src/lib/domain/inbox/inbox-bucket-predicates.js'
import { applyFilters } from '../../src/lib/domain/opportunity/opportunity-service.js'

test('inbox: an archived thread matches only the Archived bucket', () => {
  const archived = { is_archived: true, inbox_bucket: 'dead', opt_out: true, property_id: null, latest_message_direction: 'inbound' }
  assert.equal(isArchivedThread(archived), true)
  for (const bucket of ['all', 'all_messages', 'priority', 'new_replies', 'needs_review', 'follow_up', 'cold', 'dead', 'suppressed', 'active', 'unlinked']) {
    assert.equal(threadMatchesBucketFilter(archived, bucket), false, `archived thread leaked into ${bucket}`)
  }
  assert.equal(threadMatchesBucketFilter(archived, 'archived'), true)
  // the same thread unarchived is back in its bucket
  assert.equal(threadMatchesBucketFilter({ ...archived, is_archived: false }, 'dead'), true)
})

function recordingQuery() {
  const calls = []
  const q = new Proxy({}, { get: (_t, op) => (...args) => { calls.push([op, ...args]); return q } })
  return { q, calls }
}

test('pipeline: the default scope excludes archived; scope=archived reads archived only (not won/lost/closed)', () => {
  const def = recordingQuery()
  applyFilters(def.q, {})
  assert.deepEqual(def.calls, [['not', 'opportunity_status', 'in', '(dead,archived,suppressed,lost,won)']])
  const active = recordingQuery()
  applyFilters(active.q, { scope: 'active' })
  assert.deepEqual(active.calls, [['in', 'opportunity_status', ['active', 'waiting', 'paused', 'nurture']]])
  const arch = recordingQuery()
  applyFilters(arch.q, { scope: 'archived' })
  assert.deepEqual(arch.calls, [['eq', 'opportunity_status', 'archived']])
})
