/**
 * Platform event envelope — one event language over every ledger.
 * Envelope shape, merge order, exact keyset paging (no dupes, no gaps),
 * campaign-send batching, degrade isolation and subject filters. No network:
 * every read goes through an in-memory PostgREST-shaped fake.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalTime, envelope, EVENT_TYPES } from '@/lib/domain/platform/events/envelope.js'
import { cmpKey, decodeCursor, encodeCursor, mergePage } from '@/lib/domain/platform/events/keyset.js'
import { listPlatformEvents, parseQuery, ADAPTERS } from '@/lib/domain/platform/events/platform-events-service.js'
import { messageEvent, messagesAdapter } from '@/lib/domain/platform/events/adapters/messages.js'
import { campaignSendsAdapter, bucketize, BUCKET_MS } from '@/lib/domain/platform/events/adapters/campaign-sends.js'
import { leadStateEvent, leadStateAdapter } from '@/lib/domain/platform/events/adapters/lead-state.js'
import { campaignEvent, campaignsAdapter } from '@/lib/domain/platform/events/adapters/campaigns.js'
import { notificationEvent, notificationsAdapter } from '@/lib/domain/platform/events/adapters/closing-notifications.js'
import { workflowRunEvent } from '@/lib/domain/platform/events/adapters/workflow.js'

/* ── a tiny PostgREST-shaped fake (only the operators the adapters use) ── */
const path = (row, col) => {
  const m = /^(\w+)->>?(\w+)$/.exec(col)
  return m ? row[m[1]]?.[m[2]] : row[col]
}
function fakeDb(tables, { fail = new Set(), log = [] } = {}) {
  return {
    from(table) {
      const filters = []
      const orders = []
      let range = null
      let single = false
      const api = {
        select() { return api },
        eq(c, v) { filters.push((r) => String(path(r, c)) === String(v)); return api },
        neq(c, v) { filters.push((r) => path(r, c) != null && String(path(r, c)) !== String(v)); return api },
        in(c, vs) { const s = new Set(vs.map(String)); filters.push((r) => s.has(String(path(r, c)))); return api },
        gte(c, v) { filters.push((r) => canonicalTime(path(r, c)) >= canonicalTime(v)); return api },
        lte(c, v) { filters.push((r) => canonicalTime(path(r, c)) <= canonicalTime(v)); return api },
        lt(c, v) { filters.push((r) => canonicalTime(path(r, c)) < canonicalTime(v)); return api },
        gt(c, v) { filters.push((r) => Number(path(r, c)) > Number(v)); return api },
        not(c, op, v) {
          if (op === 'is') filters.push((r) => path(r, c) != null)
          else if (op === 'in') { const s = new Set(String(v).replace(/[()]/g, '').split(',')); filters.push((r) => !s.has(String(path(r, c)))) }
          return api
        },
        order(c, { ascending = true } = {}) { orders.push([c, ascending]); return api },
        range(a, b) { range = [a, b]; return api },
        limit(n) { range = [0, n - 1]; return api },
        maybeSingle() { single = true; return api },
        then(res, rej) {
          log.push(table)
          if (fail.has(table)) return Promise.resolve({ data: null, error: { message: `${table} down` } }).then(res, rej)
          let rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)))
          rows = [...rows].sort((x, y) => {
            for (const [c, asc] of orders) {
              const a = /_at$/.test(c) ? canonicalTime(x[c]) : String(x[c]); const b = /_at$/.test(c) ? canonicalTime(y[c]) : String(y[c])
              if (a !== b) return (a > b ? 1 : -1) * (asc ? 1 : -1)
            }
            return 0
          })
          if (range) rows = rows.slice(range[0], range[1] + 1)
          return Promise.resolve(single ? { data: rows[0] || null, error: null } : { data: rows, error: null }).then(res, rej)
        },
      }
      return api
    },
  }
}

const T0 = Date.parse('2026-10-01T18:00:00Z')
const at = (minAgo, extraMicros = '') => new Date(T0 - minAgo * 60e3).toISOString().replace('Z', `${extraMicros}Z`)
const uid = (p, i) => `${p}${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`

/* ── envelope ─────────────────────────────────────────────────────────── */

test('canonical time keeps microseconds and normalizes offsets (exact keyset keys)', () => {
  assert.equal(canonicalTime('2026-10-01 16:20:55.217123+00'), '2026-10-01T16:20:55.217123Z')
  assert.equal(canonicalTime('2026-10-01T16:20:55.2+00:00'), '2026-10-01T16:20:55.200000Z')
  assert.equal(canonicalTime('2026-10-01T11:20:55.5-05:00'), '2026-10-01T16:20:55.500000Z')
  assert.equal(canonicalTime('nope'), null)
  assert.ok(canonicalTime('2026-10-01T16:20:55.000001Z') > canonicalTime('2026-10-01T16:20:55Z'))
})

test('envelope: vocabulary enforced, payload bounded, provenance required', () => {
  const e = envelope({ event_id: 'me:1', occurred_at: '2026-10-01T15:00:00Z', source_system: 'inbox', event_type: 'seller.replied', actor: { kind: 'seller', label: 'J' }, entity_refs: [{ type: 'seller', id: 't1' }, null], summary: 'x'.repeat(400), details: { a: 'y'.repeat(900) }, provenance: { table: 'message_events', row_id: '1', adapter: 'messages' }, thread_key: 't1' })
  for (const k of ['event_id', 'occurred_at', 'source_system', 'event_type', 'severity', 'actor', 'entity_refs', 'summary', 'details', 'deep_link', 'provenance']) assert.ok(k in e, k)
  assert.equal(e.summary.length, 200)
  assert.equal(e.details.a.length, 240)
  assert.equal(e.entity_refs.length, 1)
  assert.equal(e.thread_key, 't1')
  assert.throws(() => envelope({ event_id: 'x', occurred_at: '2026-10-01T15:00:00Z', source_system: 'inbox', event_type: 'seller.waved', provenance: { table: 't', row_id: '1', adapter: 'a' } }), /unknown event_type/)
  for (const a of ADAPTERS) for (const t of a.types) assert.ok(EVENT_TYPES[t], `${a.name} declares ${t}`)
})

test('cursor round-trips; garbage cursor is a 400, not a crash', () => {
  const k = { t: '2026-10-01T15:00:00.123456Z', id: 'me:abc' }
  assert.deepEqual(decodeCursor(encodeCursor(k)), k)
  assert.throws(() => parseQuery({ cursor: 'garbage!!' }), (e) => e.code === 'invalid_cursor')
  assert.throws(() => parseQuery({ subject_type: 'galaxy', subject_id: 'x' }), (e) => e.code === 'unknown_subject_type' && e.status === 400)
  assert.throws(() => parseQuery({ subject_type: 'workflow', subject_id: 'nocolon' }), (e) => e.code === 'invalid_workflow_subject')
  assert.equal(parseQuery({ limit: '9999' }).limit, 200)
})

/* ── merge ────────────────────────────────────────────────────────────── */

const ev = (t, id) => ({ occurred_at: canonicalTime(t), event_id: id })
test('merge: newest first, ties broken by event_id; a truncated adapter holds the page above its horizon', () => {
  const a = { events: [ev('2026-10-01T10:00:00Z', 'a:2'), ev('2026-10-01T09:00:00Z', 'a:1')], complete_above: null }
  const b = { events: [ev('2026-10-01T10:00:00Z', 'b:9'), ev('2026-10-01T09:30:00Z', 'b:8')], complete_above: { t: canonicalTime('2026-10-01T09:30:00Z'), id: 'b:8' } }
  const p = mergePage([a, b], { limit: 10 })
  assert.deepEqual(p.events.map((e) => e.event_id), ['b:9', 'a:2', 'b:8'], 'a:1 is below b’s horizon — it waits for the next page')
  assert.ok(p.next_cursor)
  const k = decodeCursor(p.next_cursor)
  assert.equal(k.id, 'b:8')
  assert.ok(cmpKey({ t: canonicalTime('2026-10-01T09:00:00Z'), id: 'a:1' }, k) < 0)
})

/* ── messages ─────────────────────────────────────────────────────────── */

const msg = (i, minAgo, o = {}) => ({ id: uid('a', i), direction: 'inbound', event_type: 'inbound_sms', created_at: at(minAgo), thread_key: `t${i % 3}`, property_id: `p${i % 3}`, market: 'Dallas', seller_display_name: `Seller ${i % 3}`, message_body: 'yes', metadata: {}, ...o })

test('messages: replies are seller.replied; conversation sends one event with outcome; campaign sends never individually in the global feed; test traffic excluded', () => {
  assert.equal(messageEvent(msg(1, 5)).event_type, 'seller.replied')
  const sent = messageEvent(msg(2, 5, { direction: 'outbound', event_type: 'outbound_send', delivery_status: 'delivered', metadata: { source: 'auto_reply' } }))
  assert.equal(sent.event_type, 'message.sent')
  assert.equal(sent.source_system, 'queue')
  assert.match(sent.summary, /delivered/)
  const failed = messageEvent(msg(3, 5, { direction: 'outbound', event_type: 'outbound_send', delivery_status: 'failed', metadata: { source: 'inbox', failure_class: 'content_filter_blocked' } }))
  assert.equal(failed.event_type, 'message.failed')
  assert.equal(failed.severity, 'warning')
  assert.equal(failed.actor.kind, 'operator')
  const camp = msg(4, 5, { direction: 'outbound', event_type: 'outbound_send', metadata: { source: 'campaign_launch_execution' } })
  assert.equal(messageEvent(camp, { source: 'campaign_launch_execution', campaign_id: 'c1' }), null)
  const inReplay = messageEvent(camp, { source: 'campaign_launch_execution', campaign_id: 'c1' }, { includeCampaignSends: true })
  assert.equal(inReplay.source_system, 'campaign')
  assert.equal(inReplay.campaign_id, 'c1')
  assert.equal(messageEvent(msg(5, 5, { metadata: { internal_test: true } })), null)
  assert.equal(messageEvent(msg(6, 5, { direction: 'outbound', metadata: { source: 'x' } }), { source: 'internal_canary' }), null)
})

/* ── campaign batching ────────────────────────────────────────────────── */

const sq = (i, sentAt, o = {}) => ({ id: uid('b', i), campaign_id: 'c1', sent_at: sentAt, delivered_at: null, queue_status: 'delivered', source: 'campaign_launch_execution', market: 'Dallas', ...o })

test('campaign sends: one batch per campaign per 10-minute bucket with real counts', () => {
  const B = Math.floor(T0 / BUCKET_MS) * BUCKET_MS - 3 * BUCKET_MS
  const rows = [
    sq(1, new Date(B + 9 * 60e3).toISOString()), sq(2, new Date(B + 60e3).toISOString(), { queue_status: 'failed_transport' }),
    sq(3, new Date(B + 2 * 60e3).toISOString(), { campaign_id: 'c2', queue_status: 'sent' }),
    sq(4, new Date(B - 60e3).toISOString()),
  ].sort((a, b) => b.sent_at.localeCompare(a.sent_at))
  const { events, complete_above } = bucketize(rows, { exhausted: true, upperMs: T0 })
  assert.equal(complete_above, null)
  assert.equal(events.length, 3)
  const c1 = events.find((e) => e.campaign_id === 'c1' && e.details.bucket_start === new Date(B).toISOString())
  assert.equal(c1.event_type, 'campaign.batch_sent')
  assert.deepEqual([c1.details.count, c1.details.delivered, c1.details.failed], [2, 1, 1])
  assert.equal(c1.severity, 'attention')
  assert.equal(c1.occurred_at, canonicalTime(new Date(B + 9 * 60e3).toISOString()), 'a batch sits at its last send')
  // a read that stops inside a bucket never emits that bucket
  const cut = bucketize(rows.slice(0, 2), { exhausted: false, upperMs: T0 })
  assert.ok(cut.events.every((e) => e.details.bucket_start !== new Date(B).toISOString()))
})

test('campaign sends paged 1 batch at a time = the whole set, no dupes, no partial counts', async () => {
  const rows = []
  for (let i = 0; i < 60; i++) rows.push(sq(i, new Date(T0 - (i * 97 + 30) * 1000).toISOString(), { campaign_id: i % 2 ? 'c1' : 'c2' }))
  const db = fakeDb({ send_queue: rows, campaigns: [{ id: 'c1', name: 'One' }, { id: 'c2', name: 'Two' }] })
  const since = new Date(T0 - 3 * 3600e3).toISOString()
  const full = await listPlatformEvents({ limit: '200', since, sources: 'campaign' }, { supabase: db, now: () => T0, adapters: [campaignSendsAdapter], quiet: true })
  const total = full.events.reduce((s, e) => s + e.details.count, 0)
  assert.equal(total, 60)
  const seen = []
  let cursor = null
  let guard = 0
  do {
    const r = await listPlatformEvents({ limit: '1', since, sources: 'campaign', ...(cursor ? { cursor } : {}) }, { supabase: db, now: () => T0, adapters: [campaignSendsAdapter], quiet: true })
    seen.push(...r.events)
    cursor = r.next_cursor
  } while (cursor && ++guard < 100)
  assert.deepEqual(seen.map((e) => `${e.event_id}#${e.details.count}`), full.events.map((e) => `${e.event_id}#${e.details.count}`))
})

/* ── paging across adapters ───────────────────────────────────────────── */

function world() {
  const messages = []
  for (let i = 0; i < 40; i++) messages.push(msg(i, i * 7, i % 4 === 0 ? { direction: 'outbound', event_type: 'outbound_send', delivery_status: 'delivered', metadata: { source: i % 8 === 0 ? 'campaign_launch_execution' : 'inbox' } } : {}))
  // same-instant ties across rows
  messages.push(msg(90, 14), msg(91, 14))
  const lse = []
  for (let i = 0; i < 25; i++) lse.push({ id: uid('c', i), thread_key: `t${i % 3}`, property_id: `p${i % 3}`, field_name: i % 5 === 0 ? 'operational_status' : 'lead_temperature', previous_value: 'warm', new_value: i % 2 ? 'hot' : 'cold', source_view: i % 7 === 0 ? 'send_success_seam' : 'seller_inbound_orchestrator', change_source: 'autopilot', created_at: at(i * 11 + 3) })
  const notes = []
  for (let i = 0; i < 12; i++) notes.push({ id: uid('d', i), event_type: i % 3 ? 'inbox_hot_lead' : 'inbox_message_received', domain: 'inbox', severity: i % 2 ? 'warning' : 'positive', title: `Alert ${i}`, source_entity_type: 'thread', source_entity_id: `t${i % 3}`, property_id: `p${i % 3}`, created_at: at(i * 19 + 1) })
  const sends = []
  for (let i = 0; i < 30; i++) sends.push(sq(i, at(i * 4 + 2)))
  return { message_events: messages, universal_lead_state_events: lse, notification_events: notes, send_queue: sends, campaigns: [{ id: 'c1', name: 'One', market: 'Dallas' }], inbox_thread_state: [{ thread_key: 't1', property_id: 'p1', seller_display_name: 'Seller 1', market: 'Dallas' }], properties: [] }
}
const ADS = [messagesAdapter, campaignSendsAdapter, leadStateAdapter, notificationsAdapter]

async function walk(q, limit, deps) {
  const out = []
  let cursor = null
  let n = 0
  do {
    const r = await listPlatformEvents({ ...q, limit: String(limit), ...(cursor ? { cursor } : {}) }, deps)
    out.push(...r.events)
    cursor = r.next_cursor
  } while (cursor && ++n < 500)
  return out
}

test('keyset paging over several ledgers: every page size yields the same ordered set — no dupes, no gaps', async () => {
  const deps = { supabase: fakeDb(world()), now: () => T0, adapters: ADS, quiet: true }
  const since = new Date(T0 - 12 * 3600e3).toISOString()
  const all = await walk({ since }, 200, deps)
  assert.ok(all.length > 50)
  for (let i = 1; i < all.length; i++) assert.ok(cmpKey({ t: all[i - 1].occurred_at, id: all[i - 1].event_id }, { t: all[i].occurred_at, id: all[i].event_id }) > 0, 'strictly descending')
  assert.equal(new Set(all.map((e) => e.event_id)).size, all.length)
  for (const size of [1, 3, 7, 13]) {
    const paged = await walk({ since }, size, deps)
    assert.deepEqual(paged.map((e) => e.event_id), all.map((e) => e.event_id), `page size ${size}`)
  }
  assert.ok(!all.some((e) => e.details?.field === 'operational_status'), 'machine-internal state is not projected')
  assert.ok(!all.some((e) => e.details?.kind === 'inbox_message_received'), 'a notification restating a reply is not a second event')
})

test('degrade isolation: one failing ledger is listed, the rest still answer', async () => {
  const deps = { supabase: fakeDb(world(), { fail: new Set(['universal_lead_state_events']) }), now: () => T0, adapters: ADS, quiet: true }
  const r = await listPlatformEvents({ since: new Date(T0 - 6 * 3600e3).toISOString() }, deps)
  assert.equal(r.ok, true)
  assert.deepEqual(r.degraded, ['lead_state'])
  assert.equal(r.sources.lead_state.ok, false)
  assert.equal(r.sources.messages.ok, true)
  assert.ok(r.events.length > 0)
  assert.ok(!r.events.some((e) => e.provenance.adapter === 'lead_state'))
  // a hanging adapter times out instead of holding the response
  const hang = { name: 'hang', table: 'x', systems: ['inbox'], types: ['seller.replied'], supports: () => true, read: () => new Promise(() => {}) }
  const r2 = await listPlatformEvents({}, { ...deps, adapters: [hang, messagesAdapter], timeoutMs: 50 })
  assert.ok(r2.degraded.includes('hang'))
})

test('filters: sources, types, severity and market narrow the stream', async () => {
  const deps = { supabase: fakeDb(world()), now: () => T0, adapters: ADS, quiet: true }
  const since = new Date(T0 - 12 * 3600e3).toISOString()
  const inbox = await walk({ since, sources: 'inbox' }, 50, deps)
  assert.ok(inbox.length && inbox.every((e) => e.source_system === 'inbox'))
  const warn = await walk({ since, severity: 'warning' }, 50, deps)
  assert.ok(warn.length && warn.every((e) => e.severity === 'warning'))
  const batches = await walk({ since, types: 'campaign.batch_sent' }, 50, deps)
  assert.ok(batches.length && batches.every((e) => e.event_type === 'campaign.batch_sent'))
  const dallas = await walk({ since, market: 'dallas' }, 50, deps)
  assert.ok(dallas.length && dallas.every((e) => String(e.market).toLowerCase() === 'dallas'))
})

test('subject replay: a seller resolves through inbox_thread_state and only its events come back (campaign sends individually)', async () => {
  const w = world()
  const deps = { supabase: fakeDb(w), now: () => T0, adapters: ADS, quiet: true }
  const r = await listPlatformEvents({ subject_type: 'seller', subject_id: 't1', since: new Date(T0 - 12 * 3600e3).toISOString(), limit: '200' }, deps)
  assert.equal(r.subject.label, 'Seller 1')
  assert.ok(r.events.length > 0)
  assert.ok(r.events.every((e) => e.thread_key === 't1' || e.entity_refs.some((x) => x.id === 't1')), 'nothing from other sellers')
  assert.ok(!r.events.some((e) => e.event_type === 'campaign.batch_sent'), 'a seller replay shows sends, not batches')
  await assert.rejects(listPlatformEvents({ subject_type: 'seller', subject_id: 'nobody' }, deps), (e) => e.code === 'subject_not_found' && e.status === 404)
})

test('live tail: a fresh head returns new events; a stale head never replays history as live', async () => {
  const deps = { supabase: fakeDb(world()), now: () => T0, adapters: ADS, quiet: true }
  const fresh = await listPlatformEvents({ tail: '1', since: new Date(T0 - 10 * 60e3).toISOString() }, deps)
  assert.equal(fresh.replay_suppressed, false)
  assert.ok(fresh.events.every((e) => Date.parse(e.occurred_at) >= T0 - 10 * 60e3 - BUCKET_MS))
  const stale = await listPlatformEvents({ tail: '1', since: new Date(T0 - 3 * 3600e3).toISOString() }, deps)
  assert.equal(stale.replay_suppressed, true)
  assert.equal(stale.events.length, 0)
})

/* ── adapter mappings ─────────────────────────────────────────────────── */

test('lead state: stage moves are owned here (forward/back), seam rows and opt-outs mapped honestly', () => {
  const base = { id: 'x', thread_key: 't', created_at: '2026-10-01T10:00:00Z', change_source: 'autopilot' }
  assert.equal(leadStateEvent({ ...base, field_name: 'lifecycle_stage', previous_value: 'ownership_confirmation', new_value: 'offer_interest' }).event_type, 'stage.advanced')
  assert.equal(leadStateEvent({ ...base, field_name: 'lifecycle_stage', previous_value: 'offer', new_value: 'asking_price' }).event_type, 'stage.regressed')
  assert.equal(leadStateEvent({ ...base, field_name: 'lifecycle_stage', previous_value: null, new_value: 'ownership_confirmation', source_view: 'send_success_seam' }), null)
  const out = leadStateEvent({ ...base, field_name: 'contactability_status', previous_value: 'contactable', new_value: 'opted_out' })
  assert.equal(out.event_type, 'seller.opted_out')
  assert.equal(leadStateEvent({ ...base, field_name: 'next_action', previous_value: '', new_value: 'send_message_now' }), null)
  assert.equal(leadStateEvent({ ...base, field_name: 'lifecycle_stage', change_source: 'manual', previous_value: 'asking_price', new_value: 'offer' }).actor.kind, 'operator')
})

test('campaign lifecycle: no-op scheduler passes are not events; placed rows are', () => {
  const c = { name: 'Dallas' }
  assert.equal(campaignEvent({ id: '1', campaign_id: 'c', event_type: 'campaign.launch_scheduled', metadata: { send_queue_rows_created: 0 }, created_at: '2026-10-01T10:00:00Z' }, c), null)
  const placed = campaignEvent({ id: '2', campaign_id: 'c', event_type: 'campaign.launch_scheduled', metadata: { send_queue_rows_created: 12 }, created_at: '2026-10-01T10:00:00Z' }, c)
  assert.equal(placed.event_type, 'campaign.queue_planned')
  assert.match(placed.summary, /12 sends scheduled/)
  assert.equal(campaignEvent({ id: '3', campaign_id: 'c', event_type: 'campaign.launch_blocked', severity: 'warning', title: 'Campaign launch blocked', created_at: '2026-10-01T10:00:00Z' }, c).event_type, 'campaign.blocked')
})

test('campaigns adapter reads only through campaign ids and skips no-op passes in SQL', async () => {
  const log = []
  const db = fakeDb({
    campaigns: [{ id: 'c1', name: 'One', paused_at: at(30) }],
    campaign_events: [
      { id: uid('e', 1), campaign_id: 'c1', event_type: 'campaign.launch_scheduled', metadata: { send_queue_rows_created: 0 }, created_at: at(5) },
      { id: uid('e', 2), campaign_id: 'c1', event_type: 'campaign.launch_scheduled', metadata: { send_queue_rows_created: 3 }, created_at: at(6) },
      { id: uid('e', 3), campaign_id: 'c1', event_type: 'campaign.activated', title: 'Campaign activated', created_at: at(7) },
    ],
  }, { log })
  const r = await listPlatformEvents({ since: new Date(T0 - 3600e3).toISOString() }, { supabase: db, now: () => T0, adapters: [campaignsAdapter], quiet: true })
  assert.deepEqual(r.events.map((e) => e.event_type), ['campaign.queue_planned', 'campaign.activated', 'campaign.paused'])
})

test('notifications: severity mapped, restatements skipped', () => {
  assert.equal(notificationEvent({ id: '1', event_type: 'inbox_message_received', created_at: '2026-10-01T10:00:00Z' }), null)
  const n = notificationEvent({ id: '2', event_type: 'inbox_opt_out_received', severity: 'warning', title: 'Opt-out received', source_entity_type: 'thread', source_entity_id: 't1', created_at: '2026-10-01T10:00:00Z' })
  assert.equal(n.event_type, 'alert.triggered')
  assert.equal(n.severity, 'warning')
  assert.equal(n.thread_key, 't1')
  assert.equal(notificationEvent({ id: '3', event_type: 'inbox_hot_lead', severity: 'positive', created_at: '2026-10-01T10:00:00Z' }).severity, 'info')
})

test('workflow runs: status decides the type; the handled inbound message is the causal link', () => {
  const o = (status) => ({ run: { run_id: 'r1', started_at: '2026-10-01T10:00:00Z', status, result: 'Needs your review', subject: { kind: 'seller', id: 't1', name: 'Jane' } }, events: [], raw: { source_message_id: 'm1', property_id: 'p1' } })
  assert.equal(workflowRunEvent(o('needs_you'), { workflowKey: 'seller_inbound', workflowName: 'Seller conversation' }).event_type, 'workflow.held')
  assert.equal(workflowRunEvent(o('failed'), { workflowKey: 'seller_inbound', workflowName: 'S' }).severity, 'warning')
  const done = workflowRunEvent(o('completed'), { workflowKey: 'seller_inbound', workflowName: 'S' })
  assert.equal(done.event_type, 'workflow.completed')
  assert.equal(done.details.source_message_id, 'm1')
  assert.equal(done.thread_key, 't1')
  assert.equal(workflowRunEvent(o('failed'), { workflowKey: 'email_dispatch', workflowName: 'Email' }).event_type, 'email.failed')
})
