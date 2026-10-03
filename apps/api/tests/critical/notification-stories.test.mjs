/**
 * NOTIFICATION CENTER 2.0 — story grammar, read model and state (no network;
 * every dependency injected). Brief §1 Tests:
 *   message + fact + stage collapse · message + hot collapse · responding → sent ·
 *   campaign blocked → resumed · sender degraded → restored · duplicate suppression ·
 *   two unrelated sellers in the same second stay separate · one seller's two
 *   independent conversations don't merge
 * plus: READ ≠ RESOLVED, persisted state, no reappearance, badge, supersede,
 * paging, incremental refresh, degrade without the state table, route auth.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildStories, countStories } from '../../src/lib/domain/notifications/stories/story-builder.js'
import { itemFromEvent, itemFromNotification, STORY_EVENT_TYPES, LENSES } from '../../src/lib/domain/notifications/stories/story-grammar.js'
import { getNotificationStories, updateStoryState, __resetStoryCache, StoryError } from '../../src/lib/domain/notifications/stories/story-service.js'
import { EVENT_TYPES } from '../../src/lib/domain/platform/events/envelope.js'
import { messageEvent } from '../../src/lib/domain/platform/events/adapters/messages.js'

const T0 = Date.parse('2026-10-02T15:00:00.000Z')
const at = (s) => new Date(T0 + s * 1000).toISOString()
const NOW = T0 + 3600e3

/* ── fixtures in the envelope's own shape ─────────────────────────────── */
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
const build = (events, notifications = [], state = new Map()) => buildStories({ events, notifications, state, now: NOW }).stories

/* ── vocabulary ───────────────────────────────────────────────────────── */
test('every story event type is in the platform vocabulary; four lenses only', () => {
  for (const t of STORY_EVENT_TYPES) assert.ok(EVENT_TYPES[t], t)
  assert.deepEqual([...LENSES], ['needs_you', 'now', 'resolved', 'system'])
  assert.equal(itemFromEvent({ ...campaignEv('ce:1', 'campaign.created', 0) }), null, 'Machine-Feed-only types are not stories')
})

test('the messages adapter carries the provider sid — the causal id the inbound alerts hold', () => {
  const e = messageEvent({ id: 'm9', direction: 'inbound', created_at: at(0), thread_key: 't', provider_message_sid: 'SMabc', message_body: 'hi', metadata: {} })
  assert.equal(e.details.provider_sid, 'SMabc')
})

/* ── brief §1 cases ───────────────────────────────────────────────────── */
test('message + fact + stage collapse into ONE story', () => {
  const stories = build([inbound('m1'), price('h1'), stage('l1')])
  assert.equal(stories.length, 1)
  const s = stories[0]
  assert.equal(s.title, 'Gale Leflore replied')
  assert.equal(s.summary, '$185K asking price · Moved to Asking price')
  assert.deepEqual(s.source_event_ids, ['me:m1', 'mv:h1', 'lse:l1'])
  assert.equal(s.lens, 'now')
  assert.equal(s.priority, 'important', 'a normal seller reply is not red')
  assert.equal(s.deep_link, '/inbox?thread=%2B16125550101')
})

test('message + hot collapse (by provider sid, and the restating "message received" alert is no second line)', () => {
  const stories = build([inbound('m1', { sid: 'SMm1' })], [alert('n1', 'inbox_hot_lead', { sid: 'SMm1' }), alert('n2', 'inbox_message_received', { sid: 'SMm1', severity: 'neutral' })])
  assert.equal(stories.length, 1)
  assert.deepEqual(stories[0].chain.map((c) => c.label), ['Replied', 'Hot lead'])
  assert.deepEqual(stories[0].notification_ids.sort(), ['n1', 'n2'])
  // causal beats time: a hot-lead alert 50 minutes later with the same sid still joins
  const late = build([inbound('m1', { sid: 'SMm1' })], [alert('n1', 'inbox_hot_lead', { sid: 'SMm1', s: 3000 })])
  assert.equal(late.length, 1)
})

test('responding → response sent morphs the SAME story', () => {
  const before = build([inbound('m1'), run('r1', 'workflow.waiting')])
  assert.equal(before.length, 1)
  assert.equal(before[0].state.label, 'Responding…')
  assert.equal(before[0].resolved, false)
  const after = build([inbound('m1'), run('r1', 'workflow.waiting'), sent('m2')])
  assert.equal(after.length, 1)
  assert.equal(after[0].id, before[0].id, 'stable id across the morph')
  assert.equal(after[0].state.label, 'Response sent ✓')
  assert.equal(after[0].resolved_by, 'machine')
  assert.equal(after[0].lens, 'resolved')
})

test('a held run joins by its source message id and needs the operator', () => {
  const [s] = build([inbound('m1'), run('r1', 'workflow.held', { s: 2000, msg: 'm1' })])
  assert.equal(s.lens, 'needs_you')
  assert.equal(s.priority, 'action')
  assert.equal(s.reason, 'Held for your review')
  assert.equal(s.run_link, '/workflow-studio?wf=seller_inbound&run=r1')
})

test('campaign blocked → resumed is one story that morphs', () => {
  const open = build([campaignEv('ce:1', 'campaign.blocked', 0)])
  assert.equal(open[0].lens, 'needs_you')
  assert.equal(open[0].title, 'Dallas Absentee · Blocked')
  const closed = build([campaignEv('ce:1', 'campaign.blocked', 0), campaignEv('cs-resumed_at:c1', 'campaign.resumed', 7200)])
  assert.equal(closed.length, 1, 'hours later is still the same condition')
  assert.equal(closed[0].id, open[0].id)
  assert.equal(closed[0].state.label, 'Resumed ✓')
  assert.equal(closed[0].lens, 'resolved')
  assert.equal(closed[0].deep_link, '/campaign-command?campaign=c1')
})

test('sender degraded → restored (and global degraded is ONE system story, not five)', () => {
  const bad = [alert('s1', 'sender_delivery_spike_failure', { domain: 'numbers', severity: 'critical', s: 0 }), alert('s2', 'sender_content_filter_spike', { domain: 'numbers', severity: 'critical', s: 60 })]
  const open = build([], bad)
  assert.equal(open.length, 1)
  assert.equal(open[0].lens, 'system')
  assert.equal(open[0].title, 'Sender health degraded')
  assert.equal(open[0].priority, 'critical')
  assert.equal(countStories(open).badge, 1)
  const fixed = build([], [...bad, alert('s3', 'sender_delivery_improving', { domain: 'numbers', severity: 'positive', s: 900 })])
  assert.equal(fixed.length, 1)
  assert.equal(fixed[0].state.label, 'Restored ✓')
  assert.equal(fixed[0].resolved, true)
  assert.equal(countStories(fixed).badge, 0)
  // the scanner resolving the rows themselves also restores
  const rows = build([], bad.map((r) => ({ ...r, status: 'resolved', resolved_at: at(1200), action_state: { resolve_reason: 'auto_resolved' } })))
  assert.equal(rows[0].state.code, 'restored')
  const platform = build([], ['platform_queue_processor_degraded', 'platform_webhook_stale', 'platform_send_failure_spike', 'platform_queue_lag_detected', 'platform_rpc_fallback_active'].map((t, i) => alert(`p${i}`, t, { domain: 'platform', severity: 'warning', s: i })))
  assert.equal(platform.length, 1)
})

test('duplicate suppression is by canonical id, never title text', () => {
  const e = inbound('m1')
  const stories = build([e, { ...e }, price('h1'), price('h1')], [alert('n1', 'inbox_hot_lead'), alert('n1', 'inbox_hot_lead')])
  assert.equal(stories.length, 1)
  assert.equal(new Set(stories[0].source_event_ids).size, stories[0].source_event_ids.length)
  // same title, different sellers → not deduped
  const two = build([inbound('a', { tk: '+1', name: 'Same Name' }), inbound('b', { tk: '+2', name: 'Same Name' })])
  assert.equal(two.length, 2)
})

test('two unrelated sellers in the same second stay separate', () => {
  const stories = build([inbound('a', { tk: '+16125550101', prop: 'p1', s: 0 }), inbound('b', { tk: '+16125550202', prop: 'p2', s: 0, name: 'Kyle Young' }), stage('l1', { tk: '+16125550202', prop: 'p2', s: 1 })])
  assert.equal(stories.length, 2)
  const kyle = stories.find((s) => s.subject.thread_key === '+16125550202')
  assert.deepEqual(kyle.source_event_ids, ['me:b', 'lse:l1'])
})

test("the same seller's two independent conversations (two properties) don't merge", () => {
  const stories = build([inbound('a', { prop: 'p1', s: 0 }), inbound('b', { prop: 'p2', s: 30 }), price('h1', { prop: 'p2', s: 40 })])
  assert.equal(stories.length, 2)
  const p2 = stories.find((s) => s.subject.property_id === 'p2')
  assert.deepEqual(p2.source_event_ids, ['me:b', 'mv:h1'])
})

test('successive messages in a burst are one story; a later burst is a new story and supersedes the old need', () => {
  const burst = build([inbound('a', { s: 0 }), inbound('b', { s: 120 })])
  assert.equal(burst.length, 1)
  assert.equal(burst[0].title, 'Gale Leflore replied · 2 messages')
  const two = build([inbound('a', { s: 0 }), run('r1', 'workflow.held', { msg: 'a', s: 5 }), inbound('b', { s: 7200 })])
  assert.equal(two.length, 2)
  const old = two.find((s) => s.primary_event.id === 'me:a')
  assert.equal(old.resolved_by, 'superseded')
  assert.equal(old.requires_operator, false)
})

test('a reply sent hours later still answers the conversation (late morph), operator wins', () => {
  const [s] = build([inbound('a', { s: 0 }), run('r1', 'workflow.held', { msg: 'a', s: 5 }), sent('o1', { s: 9000, origin: 'inbox', operator: true })])
  assert.equal(s.state.label, 'You replied ✓')
  assert.equal(s.resolved_by, 'operator')
  assert.equal(s.lens, 'resolved')
})

test('a call request outside any burst opens its own NEEDS YOU story; derivatives alone never do', () => {
  const stories = build([stage('l9', { s: 0 })], [alert('n9', 'inbox_needs_call', { sid: null, s: 14400 })])
  assert.equal(stories.length, 1)
  assert.equal(stories[0].lens, 'needs_you')
  assert.equal(stories[0].title, '(612) 555-0101 · Wants a call')
})

/* ── state ────────────────────────────────────────────────────────────── */
test('READ ≠ RESOLVED; resolved does not reappear unless a new trigger arrives', () => {
  const ev = [inbound('m1'), run('r1', 'workflow.held', { msg: 'm1' })]
  const [s] = build(ev)
  const read = build(ev, [], new Map([[s.id, { read_at: at(100) }]]))[0]
  assert.equal(read.read, true)
  assert.equal(read.resolved, false)
  assert.equal(read.lens, 'needs_you', 'reading does not resolve')
  const done = build(ev, [], new Map([[s.id, { resolved_at: at(200), resolved_by: 'operator' }]]))[0]
  assert.equal(done.resolved, true)
  assert.equal(done.read, true)
  assert.equal(done.lens, 'resolved')
  // a second message joins the same story after resolve → it comes back, unread
  const again = build([...ev, inbound('m2', { s: 300 })], [], new Map([[s.id, { resolved_at: at(200), read_at: at(200) }]]))[0]
  assert.equal(again.id, s.id)
  assert.equal(again.resolved, false)
  assert.equal(again.read, false)
})

test('legacy alert state carries over: a dismissed alert reads as operator-resolved; a machine-resolved row does not', () => {
  const ev = [inbound('m1', { sid: 'S1' })]
  const dismissed = build(ev, [alert('n1', 'inbox_needs_call', { sid: 'S1', status: 'dismissed', extra: { dismissed_at: at(50), updated_at: at(50) } })])[0]
  assert.equal(dismissed.resolved_by, 'operator')
  const read = build(ev, [alert('n1', 'inbox_hot_lead', { sid: 'S1', read_at: at(40) })])[0]
  assert.equal(read.read, true)
  assert.equal(read.resolved, false)
})

test('badge counts meaningful unresolved stories, not raw events', () => {
  const stories = build([
    inbound('a', { tk: '+1', s: 0 }), price('x', { tk: '+1', s: 1 }), stage('y', { tk: '+1', s: 2 }), // 1 unread NOW story (3 events)
    inbound('b', { tk: '+2', s: 0 }), run('r', 'workflow.held', { tk: '+2', msg: 'b', s: 3 }), // 1 NEEDS YOU
    inbound('c', { tk: '+3', s: 0 }), sent('d', { tk: '+3', s: 9 }), // resolved by machine
  ])
  const c = countStories(stories)
  assert.equal(c.badge, 2)
  assert.equal(c.needs_you, 1)
  assert.equal(c.resolved, 1)
})

test('sound: one sound per story trigger; derivatives silent; rail-voiced moments stay with the rail', () => {
  const [s] = build([inbound('m1'), price('h1'), stage('l1')])
  assert.equal(s.sound.id, 'story:me:m1')
  assert.equal(s.sound.voiced_by, 'rail')
  const [c] = build([campaignEv('ce:1', 'campaign.blocked', 0)])
  assert.equal(c.sound.voiced_by, 'plane')
  assert.equal(c.sound.category, 'needsAttention')
  const [r] = build([inbound('m1'), sent('m2')])
  assert.equal(r.sound, null, 'a resolved story makes no sound')
})

test('signals: severity maps explicitly; an event-rule firing joins the event that fired it; resolved signal morphs', () => {
  const sig = (sev, extra = {}) => ({ id: 'sg1', event_type: 'signal_watch_activity', domain: 'signals', severity: sev === 'critical' ? 'critical' : 'warning', title: 'Watched seller replied', description: null, source_entity_type: 'campaign', source_entity_id: 'c1', campaign_id: 'c1', property_id: null, metrics_snapshot: { signal_id: 'x', rule_key: 'watch', signal_severity: sev }, action_state: {}, group_count: 1, status: 'active', read_at: null, resolved_at: null, dismissed_at: null, created_at: at(0), updated_at: at(0), ...extra })
  assert.equal(itemFromNotification(sig('critical')).priority, 'critical')
  assert.equal(itemFromNotification(sig('warning')).priority, 'action')
  assert.equal(itemFromNotification(sig('attention')).priority, 'important')
  assert.equal(itemFromNotification(sig('attention')).needs_operator, false)
  assert.equal(itemFromNotification(sig('info')).priority, 'info')
  const joined = build([inbound('m1')], [sig('warning', { source_entity_type: 'seller', source_entity_id: '+16125550101', property_id: 'p1', metrics_snapshot: { rule_key: 'watch', signal_severity: 'warning', event_id: 'me:m1' }, created_at: at(30), updated_at: at(30) })])
  assert.equal(joined.length, 1)
  assert.equal(joined[0].lens, 'needs_you')
  const cleared = build([], [sig('warning', { status: 'resolved', resolved_at: at(600) })])
  assert.equal(cleared[0].state.code, 'restored')
  assert.equal(cleared[0].lens, 'resolved')
})

/* ── service: paging, incremental, state persistence, degrade ─────────── */
function fakeDb({ stateTable = true, notifications = [], archivedRows = {} } = {}) {
  const writes = []
  const stateRows = []
  const db = {
    writes, stateRows,
    from(table) {
      const q = { table, filters: [], op: 'select' }
      const chain = {
        select() { return chain }, gte() { return chain }, order() { return chain }, eq(c, v) { q.filters.push([c, v]); return chain },
        // [8.3] the archive lookup (inbox_thread_state / campaigns): nothing archived unless the test says so
        in(c, v) { q.filters.push([c, v]); return chain },
        then(res, rej) { return Promise.resolve({ data: (archivedRows[table] || []), error: null }).then(res, rej) },
        limit() {
          if (table === 'notification_events') return Promise.resolve({ data: notifications, error: null })
          if (table === 'notification_story_state') return Promise.resolve(stateTable ? { data: stateRows, error: null } : { data: null, error: { code: 'PGRST205', message: 'Could not find the table public.notification_story_state in the schema cache' } })
          return Promise.resolve({ data: [], error: null })
        },
        upsert(rows) { writes.push({ table, op: 'upsert', rows }); if (!stateTable) return Promise.resolve({ error: { code: '42P01', message: 'relation "notification_story_state" does not exist' } }); stateRows.push(...rows); return Promise.resolve({ error: null }) },
        update(patch) { const w = { table, op: 'update', patch, filters: q.filters }; writes.push(w); return { eq(c, v) { w.filters = [[c, v]]; return Promise.resolve({ error: null }) } } },
        insert(row) { writes.push({ table, op: 'insert', row }); return Promise.resolve({ error: null }) },
      }
      return chain
    },
  }
  return db
}
const listEvents = (events) => async () => ({ ok: true, events, next_cursor: null, degraded: [] })

test('endpoint: lens filter, cursor paging, incremental since, summary', async () => {
  __resetStoryCache()
  const events = [...Array.from({ length: 5 }, (_, i) => inbound(`m${i}`, { tk: `+1612555000${i}`, s: i * 10 })), inbound('h', { tk: '+19', s: 100 }), run('rh', 'workflow.held', { tk: '+19', msg: 'h', s: 101 })]
  const deps = { supabase: fakeDb(), listEvents: listEvents(events), now: () => NOW, fresh: true }
  const all = await getNotificationStories({ lens: 'all', limit: '2' }, deps)
  assert.equal(all.stories.length, 2)
  assert.ok(all.next_cursor)
  const seen = new Set(all.stories.map((s) => s.id))
  let cursor = all.next_cursor
  while (cursor) {
    const page = await getNotificationStories({ lens: 'all', limit: '2', cursor }, { ...deps, fresh: false })
    for (const s of page.stories) { assert.ok(!seen.has(s.id), 'no duplicates across pages'); seen.add(s.id) }
    cursor = page.next_cursor
  }
  assert.equal(seen.size, 6)
  const needs = await getNotificationStories({ lens: 'needs_you' }, { ...deps, fresh: false })
  assert.equal(needs.stories.length, 1)
  const inc = await getNotificationStories({ since: at(50) }, { ...deps, fresh: false })
  assert.ok(inc.incremental)
  assert.ok(inc.stories.every((s) => s.updated_at > at(50)))
  const sum = await getNotificationStories({ summary: '1' }, { ...deps, fresh: false })
  assert.equal(sum.stories, undefined)
  assert.equal(sum.counts.needs_you, 1)
  await assert.rejects(() => getNotificationStories({ lens: 'everything' }, deps), StoryError)
  await assert.rejects(() => getNotificationStories({ cursor: '!!' }, deps), StoryError)
})

test('state: persisted in the story table and written through to member alerts; resolve is audited', async () => {
  __resetStoryCache()
  const db = fakeDb({ notifications: [alert('n1', 'inbox_needs_call', { sid: 'SMm1', s: 1 })] })
  const audits = []
  const deps = { supabase: db, listEvents: listEvents([inbound('m1')]), now: () => NOW, fresh: true, audit: async (a) => audits.push(a) }
  const page = await getNotificationStories({}, deps)
  const id = page.stories[0].id
  const r = await updateStoryState({ story_ids: [id], action: 'read' }, { ...deps, fresh: false })
  assert.equal(r.persisted[id], 'table')
  assert.equal(r.stories[0].read, true)
  assert.equal(r.stories[0].resolved, false)
  assert.ok(db.writes.some((w) => w.table === 'notification_events' && w.patch.read_at))
  assert.equal(audits.length, 0, 'reads are not audited')
  const res = await updateStoryState({ story_ids: [id], action: 'resolve' }, { ...deps, fresh: false })
  assert.equal(res.stories[0].resolved_by, 'operator')
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action_type, 'story_resolve')
  await assert.rejects(() => updateStoryState({ story_ids: [id], action: 'delete' }, deps), StoryError)
})

test('degrades without the state table: alert rows persist, otherwise the client keeps local state', async () => {
  __resetStoryCache()
  const db = fakeDb({ stateTable: false, notifications: [alert('n1', 'inbox_hot_lead', { sid: 'SMm1' })] })
  const deps = { supabase: db, listEvents: listEvents([inbound('m1'), campaignEv('ce:1', 'campaign.blocked', 0)]), now: () => NOW, fresh: true, audit: async () => {} }
  const page = await getNotificationStories({}, deps)
  assert.equal(page.state_store, 'notification_rows')
  const seller = page.stories.find((s) => s.subject.type === 'seller')
  const camp = page.stories.find((s) => s.subject.type === 'campaign')
  const r = await updateStoryState({ story_ids: [seller.id, camp.id], action: 'read' }, { ...deps, fresh: false })
  assert.equal(r.persisted[seller.id], 'notification_rows')
  assert.equal(r.persisted[camp.id], 'none')
  assert.equal(r.stories.find((s) => s.id === seller.id).read, true)
})

test('routes are auth-only (never anonymous)', async () => {
  // the gate is configured in every real environment; without it the auth helper is open by design
  process.env.OPS_DASHBOARD_SECRET = process.env.OPS_DASHBOARD_SECRET || 'test-ops-secret'
  const { GET } = await import('../../src/app/api/cockpit/notifications/stories/route.js')
  const { POST } = await import('../../src/app/api/cockpit/notifications/stories/state/route.js')
  const g = await GET(new Request('http://localhost/api/cockpit/notifications/stories'))
  assert.equal(g.status, 401)
  const p = await POST(new Request('http://localhost/api/cockpit/notifications/stories/state', { method: 'POST', body: JSON.stringify({ story_ids: ['x'], action: 'read' }) }))
  assert.equal(p.status, 401)
})

test('a source that times out keeps the previous snapshot’s events (no silent un-morph), and says it is degraded', async () => {
  __resetStoryCache()
  const db = fakeDb()
  let round = 0
  const listEvents = async () => {
    round += 1
    return round === 1
      ? { ok: true, events: [inbound('m1'), run('r1', 'workflow.held', { msg: 'm1' })], next_cursor: null, degraded: [] }
      : { ok: true, events: [inbound('m1')], next_cursor: null, degraded: ['workflow'] }
  }
  const first = await getNotificationStories({}, { supabase: db, listEvents, now: () => NOW, fresh: true })
  assert.equal(first.stories[0].lens, 'needs_you')
  const second = await getNotificationStories({}, { supabase: db, listEvents, now: () => NOW + 60e3, fresh: true })
  assert.deepEqual(second.degraded, ['workflow'])
  assert.equal(second.stories[0].lens, 'needs_you', 'the held run is still known')
})

/* ── [8.3] archived subjects leave the stories ───────────────────────── */
import { parsePartition, isArchivedPartition, loadArchivedPartitions } from '../../src/lib/domain/notifications/stories/story-archive-filter.js'

test('[8.3] an archived conversation / campaign leaves every lens and count; a failed lookup hides nothing', async () => {
  const CID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const events = [inbound('m1', { tk: '+16125550101' }), inbound('m2', { tk: '+16125550202', s: 5 }), campaignEv('ce:1', 'campaign.blocked', 8, CID)]
  __resetStoryCache()
  const open = await getNotificationStories({}, { supabase: fakeDb(), listEvents: listEvents(events), now: () => NOW, fresh: true, projection: false })
  const keys = (r) => r.stories.map((s) => s.subject.type === 'seller' ? s.subject.thread_key : s.subject.id).sort()
  assert.deepEqual(keys(open), ['+16125550101', '+16125550202', CID].sort())

  __resetStoryCache()
  const db = fakeDb({ archivedRows: { inbox_thread_state: [{ thread_key: '+16125550101' }], campaigns: [{ id: CID }] } })
  const hidden = await getNotificationStories({}, { supabase: db, listEvents: listEvents(events), now: () => NOW, fresh: true, projection: false })
  assert.deepEqual(keys(hidden), ['+16125550202'])
  const total = (c) => c.needs_you + c.now + c.resolved + c.system
  assert.equal(total(hidden.counts), 1)
  assert.ok(total(open.counts) > total(hidden.counts))

  __resetStoryCache()
  const failing = await getNotificationStories({}, { supabase: fakeDb(), listEvents: listEvents(events), now: () => NOW, fresh: true, projection: false, loadArchivedPartitions: async () => { throw new Error('db down') } })
  assert.equal(failing.stories.length, open.stories.length)
  assert.ok(failing.degraded.some((d) => d.startsWith('archive_filter:')))
})

test('[8.3] partition parsing and lookup', async () => {
  assert.deepEqual(parsePartition('seller:+16125550101|p1'), { type: 'seller', id: '+16125550101' })
  assert.deepEqual(parsePartition('campaign:abc'), { type: 'campaign', id: 'abc' })
  assert.equal(parsePartition('system:senders'), null)
  const set = new Set(['seller:+16125550101'])
  assert.equal(isArchivedPartition(set, 'seller:+16125550101|p9'), true)
  assert.equal(isArchivedPartition(set, 'system:senders'), false)
  const seen = []
  const db = { from: (t) => { const c = { select: () => c, in: (col, v) => { seen.push([t, v.length]); return c }, eq: () => c, then: (res) => Promise.resolve({ data: t === 'campaigns' ? [] : [{ thread_key: '+16125550101' }], error: null }).then(res) }; return c } }
  const out = await loadArchivedPartitions(db, ['seller:+16125550101', 'campaign:not-a-uuid', 'system:x'])
  assert.deepEqual([...out], ['seller:+16125550101'])
  assert.deepEqual(seen, [['inbox_thread_state', 1]])
})
