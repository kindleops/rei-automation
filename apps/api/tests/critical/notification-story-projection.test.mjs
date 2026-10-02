/**
 * NOTIFICATION CENTER 2.0 — the persisted story projection (no network; an
 * in-memory PostgREST stand-in is injected).
 *
 * Parity: for every brief §1 case and every live morph, feeding the facts to the
 * projector ONE AT A TIME (as they occur, in arrival order) gives exactly the
 * stories the snapshot builder gives over the whole window — same ids, same
 * lens, same morph, same chain. Plus: morphs update the SAME row in place,
 * out-of-order arrival converges, keyset paging, summary, state through the
 * projection, and the snapshot fallback while the migration is not applied.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildStories } from '../../src/lib/domain/notifications/stories/story-builder.js'
import { getNotificationStories, updateStoryState, __resetStoryCache } from '../../src/lib/domain/notifications/stories/story-service.js'
import { projectStories, rebuildProjection, __resetProjector, STORIES_TABLE } from '../../src/lib/domain/notifications/stories/story-projector.js'
import { toInputs, partitionOfSubject } from '../../src/lib/domain/notifications/stories/story-projection.js'

const T0 = Date.parse('2026-10-02T15:00:00.000Z')
const at = (s) => new Date(T0 + s * 1000).toISOString()
const NOW = T0 + 3600e3

/* ── fixtures (the envelope's own shape; same as notification-stories.test) ── */
const inbound = (id, { tk = '+16125550101', prop = 'p1', s = 0, name = 'Gale Leflore', type = 'seller.replied', sid = `SM${id}`, preview = 'I would take 185k' } = {}) => ({
  event_id: `me:${id}`, occurred_at: at(s), source_system: 'inbox', event_type: type, severity: 'info', actor: { kind: 'seller', label: name },
  entity_refs: [{ type: 'seller', id: tk, label: name }, { type: 'property', id: prop }], summary: `${name} replied`, details: { preview, provider_sid: sid },
  deep_link: `/inbox?thread=${tk}`, provenance: { table: 'message_events', row_id: id, adapter: 'messages' }, thread_key: tk, property_id: prop,
})
const stage = (id, { tk = '+16125550101', prop = 'p1', s = 3, to = 'asking_price' } = {}) => ({
  event_id: `lse:${id}`, occurred_at: at(s), source_system: 'pipeline', event_type: 'stage.advanced', severity: 'info', actor: { kind: 'automation' },
  entity_refs: [], summary: 'x', details: { field: 'lifecycle_stage', from: 'offer_interest', to }, provenance: { table: 'universal_lead_state_events', row_id: id, adapter: 'lead_state' }, thread_key: tk, property_id: prop,
})
const price = (id, { tk = '+16125550101', prop = 'p1', s = 2 } = {}) => ({
  event_id: `mv:${id}`, occurred_at: at(s), source_system: 'pipeline', event_type: 'fact.captured', severity: 'info', actor: { kind: 'automation' },
  entity_refs: [], summary: 'x', details: { kind: 'price', title: 'Asking price captured', detail: '$185K' }, provenance: { table: 'acquisition_opportunity_history', row_id: id, adapter: 'pipeline' }, thread_key: tk, property_id: prop, opportunity_id: 'opp-1',
})
const run = (id, status, { tk = '+16125550101', prop = 'p1', s = 4, msg = 'm1' } = {}) => ({
  event_id: `wf:seller_inbound:${id}`, occurred_at: at(s), source_system: 'workflow', event_type: status, severity: 'info', actor: { kind: 'automation', label: 'Seller conversation' },
  entity_refs: [], summary: 'x', details: { workflow_key: 'seller_inbound', status, source_message_id: msg, result: status === 'workflow.held' ? 'Held for review' : null }, provenance: { table: 'seller_automation_executions', row_id: id, adapter: 'workflow' }, thread_key: tk, property_id: prop, workflow_run_id: id,
})
const sent = (id, { tk = '+16125550101', prop = 'p1', s = 20, origin = 'auto_reply', operator = false } = {}) => ({
  event_id: `me:${id}`, occurred_at: at(s), source_system: 'queue', event_type: 'message.sent', severity: 'info', actor: operator ? { kind: 'operator', label: 'You' } : { kind: 'automation', label: 'Auto reply' },
  entity_refs: [], summary: 'x', details: { origin }, provenance: { table: 'message_events', row_id: id, adapter: 'messages' }, thread_key: tk, property_id: prop,
})
const campaignEv = (id, type, s, cid = 'c1') => ({
  event_id: id, occurred_at: at(s), source_system: 'campaign', event_type: type, severity: type === 'campaign.blocked' ? 'warning' : 'info', actor: { kind: 'automation' },
  entity_refs: [{ type: 'campaign', id: cid, label: 'Dallas Absentee' }], summary: 'x', details: { description: 'Sender pool exhausted' }, provenance: { table: 'campaign_events', row_id: id, adapter: 'campaigns' }, campaign_id: cid,
})
const alert = (id, event_type, { domain = 'inbox', tk = '+16125550101', prop = 'p1', s = 1, sid = 'SMm1', severity = 'positive', status = 'active', read_at = null, resolved_at = null, extra = {} } = {}) => ({
  id, event_type, domain, severity, title: event_type, description: null, source_entity_type: domain === 'inbox' ? 'thread' : domain === 'numbers' ? 'sender' : domain, source_entity_id: domain === 'inbox' ? tk : 'x',
  property_id: domain === 'inbox' ? prop : null, campaign_id: null, sender_number_id: domain === 'numbers' ? '+13055550100' : null, metrics_snapshot: { provider_message_sid: sid }, action_state: {}, group_count: 1, status, read_at, resolved_at, dismissed_at: null,
  created_at: at(s), updated_at: at(s), ...extra,
})
const signal = (sev, extra = {}) => ({ id: 'sg1', event_type: 'signal_watch_activity', domain: 'signals', severity: sev === 'critical' ? 'critical' : 'warning', title: 'Watched seller replied', description: null, source_entity_type: 'campaign', source_entity_id: 'c1', campaign_id: 'c1', property_id: null, metrics_snapshot: { signal_id: 'x', rule_key: 'watch', signal_severity: sev }, action_state: {}, group_count: 1, status: 'active', read_at: null, resolved_at: null, dismissed_at: null, created_at: at(0), updated_at: at(0), ...extra })

/* ── an in-memory PostgREST subset (only what the projector + service use) ── */
function memDb(seed = {}) {
  const tables = new Map(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  const missing = new Set(seed.__missing || [])
  const KEYS = { notification_stories: 'story_id', notification_story_inputs: 'input_id', notification_story_projector: 'id', notification_story_state: 'story_id', notification_events: 'id' }
  const writes = []
  const rows = (t) => tables.get(t) || tables.set(t, []).get(t)
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  const db = {
    tables, writes,
    from(table) {
      const st = { op: 'select', filters: [], orders: [], limit: Infinity, payload: null, onConflict: null }
      const fail = () => ({ data: null, error: { code: 'PGRST205', message: `Could not find the table public.${table} in the schema cache` } })
      const run = () => {
        if (missing.has(table)) return fail()
        const all = rows(table)
        const match = (r) => st.filters.every((f) => f(r))
        if (st.op === 'select') {
          let out = all.filter(match)
          for (const [c, asc] of [...st.orders].reverse()) out = [...out].sort((a, b) => (asc ? 1 : -1) * cmp(a[c], b[c]))
          return { data: structuredClone(out.slice(0, st.limit)), error: null }
        }
        if (st.op === 'upsert') {
          const key = st.onConflict || KEYS[table]
          for (const r of st.payload) {
            const i = all.findIndex((x) => x[key] === r[key])
            if (i >= 0) all[i] = { ...all[i], ...structuredClone(r) }
            else all.push(structuredClone(r))
          }
          writes.push({ table, op: 'upsert', n: st.payload.length })
          return { data: null, error: null }
        }
        if (st.op === 'update') {
          for (const r of all) if (match(r)) Object.assign(r, structuredClone(st.payload))
          writes.push({ table, op: 'update' })
          return { data: null, error: null }
        }
        if (st.op === 'delete') {
          tables.set(table, all.filter((r) => !match(r)))
          writes.push({ table, op: 'delete' })
          return { data: null, error: null }
        }
        return { data: null, error: null }
      }
      const b = {
        select() { return b },
        eq(c, v) { st.filters.push((r) => r[c] === v); return b },
        in(c, vs) { const s = new Set(vs); st.filters.push((r) => s.has(r[c])); return b },
        gte(c, v) { st.filters.push((r) => r[c] >= v); return b },
        gt(c, v) { st.filters.push((r) => r[c] > v); return b },
        lt(c, v) { st.filters.push((r) => r[c] < v); return b },
        or(expr) {
          const m = /^updated_at\.lt\.(.+?),and\(updated_at\.eq\.(.+?),story_id\.lt\.(.+)\)$/.exec(expr)
          if (!m) throw new Error(`memDb: unsupported or(${expr})`)
          st.filters.push((r) => r.updated_at < m[1] || (r.updated_at === m[2] && r.story_id < m[3]))
          return b
        },
        order(c, o = {}) { st.orders.push([c, o.ascending !== false]); return b },
        limit(n) { st.limit = n; return b },
        upsert(p, o = {}) { st.op = 'upsert'; st.payload = Array.isArray(p) ? p : [p]; st.onConflict = o.onConflict || null; return b },
        update(p) { st.op = 'update'; st.payload = p; return b },
        delete() { st.op = 'delete'; return b },
        insert(p) { st.op = 'upsert'; st.payload = Array.isArray(p) ? p : [p]; return b },
        then(res, rej) { try { res(run()) } catch (e) { rej(e) } },
      }
      return b
    },
  }
  return db
}

/** listPlatformEvents stand-in over a mutable source list (newest first, since-bounded, no paging). */
const eventSource = (list) => async (q) => ({ ok: true, events: list.filter((e) => e.occurred_at >= q.since).sort((a, b) => cmp2(b.occurred_at, a.occurred_at)), next_cursor: null, degraded: [] })
const cmp2 = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const factTime = (f) => (f.event_id ? Date.parse(f.occurred_at) : Date.parse(f.updated_at || f.created_at))

/**
 * Project facts one at a time, in `order` (default: chronological), each pass at
 * "fact time + 1s" — exactly how the projector sees them in production.
 */
async function projectOneByOne(events, notifications, { order = null, state = [] } = {}) {
  __resetProjector()
  __resetStoryCache()
  const srcEvents = []
  const db = memDb({ notification_events: [], notification_story_state: state })
  const listEvents = eventSource(srcEvents)
  // backfill over an empty window creates the cursor
  await rebuildProjection({ supabase: db, listEvents, now: () => T0 - 60e3 })
  const facts = order || [...events, ...notifications].sort((a, b) => factTime(a) - factTime(b))
  for (const f of facts) {
    if (f.event_id) srcEvents.push(f)
    else db.tables.get('notification_events').push(structuredClone(f))
    const r = await projectStories({ supabase: db, listEvents, now: () => factTime(f) + 1000 })
    assert.equal(r.available, true)
  }
  return { db, listEvents }
}

async function readAll(db, listEvents, now = NOW) {
  const out = []
  let cursor = null
  do {
    const page = await getNotificationStories({ lens: 'all', limit: '2', ...(cursor ? { cursor } : {}) }, { supabase: db, listEvents, now: () => now, projection: true, noKick: true })
    assert.equal(page.source, 'projection')
    out.push(...page.stories)
    cursor = page.next_cursor
  } while (cursor)
  return out
}

const expected = (events, notifications, state = new Map()) => buildStories({ events, notifications, state, now: NOW }).stories

async function assertParity(name, events, notifications = [], opts = {}) {
  const want = expected(events, notifications)
  const { db, listEvents } = await projectOneByOne(events, notifications, opts)
  const got = await readAll(db, listEvents)
  assert.equal(got.length, want.length, `${name}: story count`)
  assert.deepEqual(got, want, `${name}: projected stories === builder stories`)
  return { got, db, listEvents }
}

/* ── parity: brief §1 cases ───────────────────────────────────────────── */
test('parity: message + fact + stage collapse', async () => {
  const { got } = await assertParity('collapse', [inbound('m1'), price('h1'), stage('l1')])
  assert.equal(got.length, 1)
})

test('parity: message + hot collapse (causal sid; restatement is no second line)', async () => {
  await assertParity('hot', [inbound('m1', { sid: 'SMm1' })], [alert('n1', 'inbox_hot_lead', { sid: 'SMm1' }), alert('n2', 'inbox_message_received', { sid: 'SMm1', severity: 'neutral' })])
  await assertParity('hot-late', [inbound('m1', { sid: 'SMm1' })], [alert('n1', 'inbox_hot_lead', { sid: 'SMm1', s: 3000 })])
})

test('parity: responding → response sent', async () => {
  const { got } = await assertParity('morph', [inbound('m1'), run('r1', 'workflow.waiting'), sent('m2')])
  assert.equal(got[0].state.label, 'Response sent ✓')
})

test('parity: campaign blocked → resumed', async () => {
  const { got } = await assertParity('campaign', [campaignEv('ce:1', 'campaign.blocked', 0), campaignEv('cs-resumed_at:c1', 'campaign.resumed', 2400)])
  assert.equal(got[0].state.label, 'Resumed ✓')
})

test('parity: sender degraded → restored (one system story)', async () => {
  const bad = [alert('s1', 'sender_delivery_spike_failure', { domain: 'numbers', severity: 'critical', s: 0 }), alert('s2', 'sender_content_filter_spike', { domain: 'numbers', severity: 'critical', s: 60 })]
  const { got } = await assertParity('sender', [], [...bad, alert('s3', 'sender_delivery_improving', { domain: 'numbers', severity: 'positive', s: 900 })])
  assert.equal(got.length, 1)
  assert.equal(got[0].state.label, 'Restored ✓')
})

test('parity: duplicate suppression by canonical id', async () => {
  const e = inbound('m1')
  // the same fact delivered twice (two passes see it) is still one input
  const { db } = await assertParity('dupes', [e, price('h1')], [alert('n1', 'inbox_hot_lead')], { order: [e, price('h1'), { ...e }, alert('n1', 'inbox_hot_lead'), price('h1')] })
  const inputs = db.tables.get('notification_story_inputs')
  assert.equal(new Set(inputs.map((i) => i.input_id)).size, inputs.length)
})

test('parity: two unrelated sellers in the same second stay separate', async () => {
  const { got } = await assertParity('two-sellers', [inbound('a', { tk: '+16125550101', prop: 'p1', s: 0 }), inbound('b', { tk: '+16125550202', prop: 'p2', s: 0, name: 'Kyle Young' }), stage('l1', { tk: '+16125550202', prop: 'p2', s: 1 })])
  assert.equal(got.length, 2)
})

test("parity: one seller's two conversations don't merge", async () => {
  const { got } = await assertParity('two-convos', [inbound('a', { prop: 'p1', s: 0 }), inbound('b', { prop: 'p2', s: 30 }), price('h1', { prop: 'p2', s: 40 })])
  assert.equal(got.length, 2)
})

/* ── parity: the other morphs and joins ───────────────────────────────── */
test('parity: held run → you replied (late morph), supersede, call request, signal joined to its event', async () => {
  await assertParity('held', [inbound('m1'), run('r1', 'workflow.held', { s: 2000, msg: 'm1' })])
  await assertParity('late-reply', [inbound('m1'), run('r1', 'workflow.held', { s: 60 }), sent('m2', { s: 3 * 3600, origin: 'manual', operator: true })])
  await assertParity('supersede', [inbound('a', { s: 0, type: 'seller.call_request' }), inbound('b', { s: 2000 })])
  await assertParity('call-request-orphan', [inbound('m1')], [alert('n1', 'inbox_needs_call', { s: 4 * 3600, sid: 'other' })])
  // a Signal fired by a seller message joins that message's story — even though the signal's own subject is elsewhere
  await assertParity('signal-host', [inbound('m1')], [signal('warning', { source_entity_type: 'seller', source_entity_id: '+16125550101', property_id: 'p1', metrics_snapshot: { rule_key: 'watch', signal_severity: 'warning', event_id: 'me:m1' }, created_at: at(30), updated_at: at(30) })])
  await assertParity('signal-cross-subject', [inbound('m1')], [signal('warning', { metrics_snapshot: { rule_key: 'watch', signal_severity: 'warning', event_id: 'me:m1' }, created_at: at(30), updated_at: at(30) })])
  await assertParity('signal-resolved', [], [signal('warning', { status: 'resolved', resolved_at: at(600), updated_at: at(600) })])
})

test('out-of-order arrival converges (a derivative landing before its trigger)', async () => {
  const facts = [inbound('m1'), price('h1'), stage('l1'), run('r1', 'workflow.waiting')]
  // the ledger lags: the projector sees the price and the run before the message itself
  await assertParity('out-of-order', facts, [], { order: [price('h1'), run('r1', 'workflow.waiting'), inbound('m1'), stage('l1')] })
})

/* ── live morph in place ──────────────────────────────────────────────── */
test('a live morph updates the SAME row in place and surfaces on the incremental read', async () => {
  const { db, listEvents } = await projectOneByOne([inbound('m1'), run('r1', 'workflow.waiting')], [])
  const deps = { supabase: db, listEvents, projection: true, noKick: true }
  const first = await getNotificationStories({}, { ...deps, now: () => T0 + 10e3 })
  assert.equal(first.stories.length, 1)
  const id = first.stories[0].id
  assert.equal(first.stories[0].state.label, 'Responding…')
  // the auto reply goes out
  await projectStories({ supabase: db, listEvents: eventSource([inbound('m1'), run('r1', 'workflow.waiting'), sent('m2')]), now: () => T0 + 21e3 })
  assert.equal(db.tables.get(STORIES_TABLE).length, 1, 'no second row')
  const inc = await getNotificationStories({ since: first.generated_at }, { ...deps, now: () => T0 + 22e3 })
  assert.ok(inc.incremental)
  assert.equal(inc.stories.length, 1)
  assert.equal(inc.stories[0].id, id, 'stable id across the morph')
  assert.equal(inc.stories[0].state.label, 'Response sent ✓')
  assert.equal(inc.stories[0].lens, 'resolved')
  assert.deepEqual(inc.ids, [id])
  // nothing re-projected since (beyond the 5s commit skew) → empty incremental page
  const later = await getNotificationStories({ summary: '1' }, { ...deps, now: () => T0 + 40e3 })
  const quiet = await getNotificationStories({ since: later.generated_at }, { ...deps, now: () => T0 + 60e3 })
  assert.equal(quiet.stories.length, 0)
})

test('blocked → resumed and degraded → restored morph in place (one row each)', async () => {
  const srcEvents = [campaignEv('ce:1', 'campaign.blocked', 0)]
  const { db } = await projectOneByOne(srcEvents, [alert('s1', 'sender_delivery_spike_failure', { domain: 'numbers', severity: 'critical', s: 0 })])
  const before = new Map(db.tables.get(STORIES_TABLE).map((r) => [r.subject_key, r]))
  srcEvents.push(campaignEv('cs-resumed_at:c1', 'campaign.resumed', 600))
  db.tables.get('notification_events').push(alert('s3', 'sender_delivery_improving', { domain: 'numbers', severity: 'positive', s: 600 }))
  await projectStories({ supabase: db, listEvents: eventSource(srcEvents), now: () => T0 + 601e3 })
  const after = db.tables.get(STORIES_TABLE)
  assert.equal(after.length, 2)
  for (const r of after) {
    assert.equal(before.get(r.subject_key).story_id, r.story_id)
    assert.equal(r.resolved, true)
    assert.equal(r.badge, false)
  }
})

/* ── read path ────────────────────────────────────────────────────────── */
test('projection read: lens filter, keyset paging without duplicates, summary counts = builder counts', async () => {
  const events = [...Array.from({ length: 5 }, (_, i) => inbound(`m${i}`, { tk: `+1612555000${i}`, s: i * 10 })), inbound('h', { tk: '+19', s: 100 }), run('rh', 'workflow.held', { tk: '+19', msg: 'h', s: 101 })]
  const { db, listEvents } = await projectOneByOne(events, [])
  const deps = { supabase: db, listEvents, now: () => NOW, projection: true, noKick: true }
  const all = await readAll(db, listEvents)
  assert.equal(new Set(all.map((s) => s.id)).size, 6)
  const needs = await getNotificationStories({ lens: 'needs_you' }, deps)
  assert.equal(needs.stories.length, 1)
  const sum = await getNotificationStories({ summary: '1' }, deps)
  assert.equal(sum.stories, undefined)
  const snap = await getNotificationStories({ summary: '1' }, { supabase: memDb({ notification_events: [] }), listEvents: eventSource(events), now: () => NOW, projection: false, fresh: true })
  assert.deepEqual(sum.counts, snap.counts, 'the badge is the same number either way')
  assert.equal(sum.source, 'projection')
  assert.equal(snap.source, 'snapshot')
})

test('falls back to the snapshot builder while the migration is not applied (and never writes)', async () => {
  __resetStoryCache()
  __resetProjector()
  const db = memDb({ notification_events: [], __missing: ['notification_stories', 'notification_story_inputs', 'notification_story_projector', 'notification_story_state'] })
  const r = await getNotificationStories({}, { supabase: db, listEvents: eventSource([inbound('m1')]), now: () => NOW, fresh: true })
  assert.equal(r.source, 'snapshot')
  assert.equal(r.stories.length, 1)
  const p = await projectStories({ supabase: db, listEvents: eventSource([]), now: () => NOW })
  assert.equal(p.available, false)
  assert.equal(p.reason, 'migration_not_applied')
  const b = await rebuildProjection({ supabase: db, listEvents: eventSource([]), now: () => NOW })
  assert.equal(b.available, false)
  assert.equal(db.writes.length, 0)
})

test('state through the projection: READ / RESOLVED persist, the row re-projects, badge follows', async () => {
  const { db, listEvents } = await projectOneByOne([inbound('m1')], [alert('n1', 'inbox_needs_call', { sid: 'SMm1', s: 1 })])
  const deps = { supabase: db, listEvents, now: () => NOW, projection: true, noKick: true, audit: async () => {} }
  const page = await getNotificationStories({}, deps)
  const s = page.stories[0]
  assert.equal(s.lens, 'needs_you')
  assert.equal(page.counts.badge, 1)
  const read = await updateStoryState({ story_ids: [s.id], action: 'read' }, deps)
  assert.equal(read.persisted[s.id], 'table')
  assert.equal(read.stories[0].read, true)
  const res = await updateStoryState({ story_ids: [s.id], action: 'resolve' }, deps)
  assert.equal(res.stories[0].resolved_by, 'operator')
  assert.equal(res.counts.badge, 0)
  const row = db.tables.get(STORIES_TABLE).find((r) => r.story_id === s.id)
  assert.equal(row.resolved, true)
  assert.equal(row.lens, 'resolved')
  // parity with the builder given the same persisted state
  const state = new Map(db.tables.get('notification_story_state').map((r) => [r.story_id, r]))
  const want = expected([inbound('m1')], db.tables.get('notification_events'), state)
  assert.deepEqual((await readAll(db, listEvents)), want)
})

test('partitions: a seller is its thread (both conversations), anything else its subject', () => {
  assert.equal(partitionOfSubject({ type: 'seller', thread_key: '+1', property_id: 'p1' }), 'seller:+1')
  assert.equal(partitionOfSubject({ type: 'campaign', id: 'c1' }), 'campaign:c1')
  const ins = toInputs({ events: [inbound('m1'), campaignEv('ce:x', 'campaign.created', 0)], notifications: [signal('warning', { metrics_snapshot: { rule_key: 'watch', signal_severity: 'warning', event_id: 'me:m1' } })] })
  assert.equal(ins.length, 2, 'Machine-Feed-only facts are not kept')
  assert.equal(ins.find((i) => i.input_id === 'ne:sg1').partition_key, 'seller:+16125550101', 'a signal is projected with the event that fired it')
})

test('Signal Center in the plane: a seller signal (seller_thread) is the seller story; New Replies is operator work; stories carry rule + ledger ids', async () => {
  const sellerSig = signal('warning', { id: 'sg2', source_entity_type: 'seller_thread', source_entity_id: '+16125550101', campaign_id: null, metrics_snapshot: { signal_id: 'sig-2', rule_key: 'watched_seller_reply', signal_severity: 'warning' }, created_at: at(30), updated_at: at(30) })
  const inboxSig = signal('warning', { id: 'sg3', source_entity_type: 'inbox', source_entity_id: 'backlog', campaign_id: null, metrics_snapshot: { signal_id: 'sig-3', rule_key: 'new_replies_backlog', signal_severity: 'warning' }, created_at: at(40), updated_at: at(40) })
  const { got } = await assertParity('signals-in-plane', [inbound('m1')], [sellerSig, inboxSig])
  const seller = got.find((s) => s.subject.type === 'seller')
  assert.deepEqual(seller.signal.rule_keys, ['watched_seller_reply'])
  assert.deepEqual(seller.signal.signal_ids, ['sig-2'])
  assert.equal(seller.lens, 'needs_you')
  const inbox = got.find((s) => s.subject.type === 'inbox')
  assert.equal(inbox.lens, 'needs_you', 'not SYSTEM: the backlog needs an operator')
  assert.equal(inbox.title, 'New Replies · Watched seller replied')
  assert.equal(inbox.deep_link, '/inbox')
  assert.equal(got.every((s) => s.subject.type !== 'system'), true)
})
