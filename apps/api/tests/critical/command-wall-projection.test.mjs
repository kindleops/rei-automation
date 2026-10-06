/**
 * Command Wall — privacy modes strip PII, aggregation, the shared tick, and
 * failure honesty (owner brief §14, §15, §24, §25, §43, §57, §66).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { wallEventFromInput, foldAggregates, aggregateToEvent, createWallEventLog, SEND_BUCKET_MS, signalLabel } from '@/lib/domain/command-wall/wall-projection.js'
import { projectEvent, projectSnapshot, projectGeo } from '@/lib/domain/command-wall/wall-privacy.js'
import { createWallFeed, TICK_MS } from '@/lib/domain/command-wall/wall-feed-service.js'
import { createWallSnapshot, deriveSystem, fleetSummary, deriveQueueStatus } from '@/lib/domain/command-wall/wall-snapshot-service.js'
import { validateConfigPatch, resolveDisplayConfig, PRESET_IDS } from '@/lib/domain/command-wall/wall-config.js'
import { createFakeDb } from '../helpers/command-wall-fake-db.mjs'

const PII = { name: 'Diane Whitfield', phone: '+19498421374', address: '4127 Larkspur Ave', body: 'my tenants never miss their rental payments' }

function replyInput(id, at, extra = {}) {
  return {
    input_id: id,
    kind: 'event',
    occurred_at: at,
    payload: {
      event_id: `e-${id}`,
      event_type: 'seller.replied',
      occurred_at: at,
      property_id: 'p-1',
      market: 'Dallas, TX',
      summary: `${PII.name} replied: ${PII.body}`,
      actor: { kind: 'seller', label: PII.name },
      entity_refs: [{ type: 'seller', label: PII.name }, { type: 'property', label: PII.address }],
      details: { intent: 'seller_interested', preview: PII.body, provider_sid: 'SM123', from: PII.phone },
      deep_link: `/inbox?thread=${PII.phone}`,
      ...extra,
    },
  }
}

const GEO = { market_id: 'dallas-tx', market_name: 'Dallas, TX', market_lat: 32.78, market_lng: -96.96, zip: '75217', zip_lat: 32.71, zip_lng: -96.68, lat: 32.712345, lng: -96.681234 }
const geoFor = () => GEO

test('a wall event never carries source free text, in ANY privacy mode', () => {
  const ev = wallEventFromInput(replyInput('1', '2026-10-06T07:41:08Z'), geoFor)
  assert.equal(ev.kind, 'interest')
  assert.equal(ev.label, 'Interested seller')
  for (const mode of ['operations', 'privacy', 'public_safe']) {
    const out = JSON.stringify(projectEvent({ ...ev, seq: 1 }, mode))
    for (const v of Object.values(PII)) assert.ok(!out.includes(v), `${mode} leaks ${v}`)
    assert.ok(!out.includes('SM123') && !out.includes('/inbox'), `${mode} leaks provider ids or deep links`)
  }
})

test('privacy modes: operations ≈ property, privacy = ZIP centroid, public-safe = market only', () => {
  const ops = projectGeo(GEO, 'operations')
  assert.equal(ops.precision, 'property')
  assert.equal(ops.lat, 32.712)
  const priv = projectGeo(GEO, 'privacy')
  assert.equal(priv.precision, 'zip')
  assert.equal(priv.lat, 32.71)
  assert.equal(priv.zip, '75217')
  const pub = projectGeo(GEO, 'public_safe')
  assert.equal(pub.precision, 'market')
  assert.equal(pub.zip, undefined)
  assert.equal(pub.lat, 32.78)
  // privacy without a ZIP centroid snaps to a ~2 km grid, never the raw point
  const grid = projectGeo({ ...GEO, zip_lat: null, zip_lng: null }, 'privacy')
  assert.equal(grid.precision, 'grid')
  assert.notEqual(grid.lat, 32.712)
  // unknown mode falls back to PRIVACY, never operations
  assert.equal(projectGeo(GEO, 'bogus').precision, 'zip')
})

test('privacy modes strip campaign names, amounts and signal detail', () => {
  const ev = { id: 'x', seq: 3, kind: 'offer', priority: 1, tone: 'gold', label: 'Offer set', occurred_at: '2026-10-06T07:00:00Z', amount: 245000, campaign: { id: 'c1' }, intent: null, geo: GEO, signal: null }
  assert.equal(projectEvent(ev, 'operations').amount, 245000)
  assert.equal(projectEvent(ev, 'privacy').amount, undefined)
  assert.equal(projectEvent(ev, 'privacy').campaign, undefined)
  const snap = {
    campaigns: [{ id: 'c1', name: 'Dallas Absentee Wave 3 — Whitfield list', market_id: 'dallas-tx', market_name: 'Dallas, TX', status: 'active', sent: 10, queued: 5, replied: 1, positive: 1, progress_pct: 66.7 }],
    signals: [{ id: 's1', rule_key: 'queue.stalled', severity: 'critical', label: 'Queue stalled', subject_type: 'queue', fired_at: 't' }],
    mi: { markets: [{ id: 'dallas-tx', top_zips: [{ zip: '75217' }] }] },
  }
  assert.equal(projectSnapshot(snap, 'operations').campaigns[0].name, snap.campaigns[0].name)
  assert.equal(projectSnapshot(snap, 'privacy').campaigns[0].name, null)
  const pub = projectSnapshot(snap, 'public_safe')
  assert.equal(pub.campaigns[0].name, null)
  assert.equal(pub.campaigns[0].sent, undefined)
  assert.equal(pub.signals[0].rule_key, undefined)
  assert.deepEqual(pub.mi.markets[0].top_zips, [])
})

test('only Signal Center notifications reach the wall; inbox notifications (with phones in titles) never do', () => {
  const inbox = { input_id: 'n1', kind: 'notification', occurred_at: 't', payload: { event_type: 'inbox_message_received', severity: 'neutral', title: `New message — ${PII.phone}` } }
  assert.equal(wallEventFromInput(inbox, geoFor), null)
  const sig = wallEventFromInput({ input_id: 'n2', kind: 'notification', occurred_at: '2026-10-06T07:00:00Z', payload: { event_type: 'signal_reply_backlog', severity: 'warning', title: `Backlog — ${PII.phone}` } }, geoFor)
  assert.equal(sig.kind, 'signal')
  assert.equal(sig.label, 'Replies backlog')
  assert.ok(!JSON.stringify(sig).includes(PII.phone))
  assert.equal(signalLabel('queue.stalled'), 'Queue stalled')
  assert.equal(signalLabel('sender.delivery_degraded'), 'Delivery degraded')
})

test('priority vocabulary (§66): interest/offer/deal = P1, stage/campaign = P2, failures P0, noise excluded', () => {
  const mk = (type, details = {}) => wallEventFromInput({ input_id: type, kind: 'event', occurred_at: 't', payload: { event_type: type, occurred_at: '2026-10-06T07:00:00Z', details } }, geoFor)
  assert.equal(mk('offer.generated').priority, 1)
  assert.equal(mk('deal.opened').priority, 1)
  assert.equal(mk('stage.advanced').priority, 2)
  assert.equal(mk('campaign.failed').priority, 0)
  assert.equal(mk('fact.captured', { history_type: 'asking_price_changed' }).kind, 'asking_price')
  assert.equal(mk('fact.captured', { history_type: 'condition_changed' }), null)
  assert.equal(mk('workflow.held'), null)
  assert.equal(mk('lead.temperature_changed'), null)
  assert.equal(mk('seller.replied', { intent: 'unclear' }).kind, 'reply')
})

test('bulk sends fold into per-market 2-minute aggregates with distinct counts (§25)', () => {
  const t0 = Date.parse('2026-10-06T07:40:00Z')
  const rows = Array.from({ length: 48 }, (_, i) => ({ id: `s${i}`, at: t0 + i * 1000, market_id: 'houston-tx', market_name: 'Houston, TX', geo: { market_id: 'houston-tx' } }))
  const aggs = foldAggregates(new Map(), rows, { kind: 'sends', label: 'Outbound', bucketMs: SEND_BUCKET_MS })
  assert.equal(aggs.size, 1)
  // overlapping re-read of the same rows does not double count
  foldAggregates(aggs, rows.slice(10), { kind: 'sends', label: 'Outbound', bucketMs: SEND_BUCKET_MS })
  const ev = aggregateToEvent([...aggs.values()][0])
  assert.equal(ev.count, 48)
  assert.equal(ev.priority, 3)
  assert.equal(ev.window_ms, SEND_BUCKET_MS)
  // a different market is a different aggregate
  foldAggregates(aggs, [{ id: 'd1', at: t0, market_id: 'dallas-tx' }], { kind: 'sends', label: 'Outbound', bucketMs: SEND_BUCKET_MS })
  assert.equal(aggs.size, 2)
})

test('event log: monotonic seq, upsert-by-id, unchanged aggregates are not re-sent, bounded', () => {
  let t = Date.parse('2026-10-06T08:00:00Z')
  const log = createWallEventLog({ maxAgeMs: 60_000, maxEvents: 3, now: () => t })
  const ev = (id, count = 1) => ({ id, count, label: 'x', occurred_at: new Date(t).toISOString() })
  assert.equal(log.upsert(ev('a')), true)
  assert.equal(log.upsert(ev('a')), false, 'identical upsert is a no-op')
  log.upsert(ev('a', 2))
  assert.deepEqual(log.after(0).map((e) => [e.id, e.seq]), [['a', 2]])
  for (const id of ['b', 'c', 'd', 'e']) log.upsert(ev(id))
  log.prune()
  assert.equal(log.size(), 3)
  t += 120_000
  log.prune()
  assert.equal(log.size(), 0)
})

function feedDb({ inputs = [], sends = [] } = {}) {
  return createFakeDb({
    handlers: {
      notification_story_inputs: (q) => {
        const since = q.filters.find((f) => f[0] === 'gt')?.[2]
        return { data: inputs.filter((r) => !since || r.occurred_at > since) }
      },
      send_queue: (q) => {
        const since = q.filters.find((f) => f[0] === 'gt')?.[2]
        return { data: sends.filter((r) => !since || r.sent_at > since) }
      },
      notification_story_projector: () => ({ data: [{ projected_at: '2026-10-06T07:59:40Z' }] }),
      canonical_markets: () => ({ data: [{ id: 'dallas-tx', display_name: 'Dallas, TX', state: 'TX' }, { id: 'houston-tx', display_name: 'Houston, TX', state: 'TX' }] }),
      mi_zip_geo: () => ({ data: [{ zip: '75217', min_lat: 32.7, max_lat: 32.72, min_lng: -96.7, max_lng: -96.66, sales_n: 5 }] }),
      properties: () => ({ data: [{ property_id: 'p-1', property_address_zip: '75217', latitude: 32.712, longitude: -96.681, canonical_market_id: 'dallas-tx' }] }),
    },
  })
}

test('ONE shared tick serves every display: 25 concurrent reads → one set of queries', async () => {
  let t = Date.parse('2026-10-06T08:00:00Z')
  const now = () => t
  const inputs = [replyInput('1', '2026-10-06T07:50:00Z')]
  const sends = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, sent_at: new Date(Date.parse('2026-10-06T07:58:00Z') + i * 1000).toISOString(), market: 'Houston, TX', campaign_id: 'c1' }))
  const db = feedDb({ inputs, sends })
  const feed = createWallFeed({ db, now, epoch: 'test' })
  const reads = await Promise.all(Array.from({ length: 25 }, () => feed.read(0)))
  const sourceQueries = db.log.filter((l) => l.table === 'notification_story_inputs' || l.table === 'send_queue')
  assert.equal(sourceQueries.length, 2, 'one inputs read + one sends read for 25 displays')
  assert.equal(reads[0].events.length, 2)
  const kinds = reads[0].events.map((e) => e.kind).sort()
  assert.deepEqual(kinds, ['interest', 'sends'])
  assert.equal(reads[0].events.find((e) => e.kind === 'sends').count, 30)
  // within TICK_MS: zero new queries
  t += TICK_MS - 1
  await feed.read(reads[0].head)
  assert.equal(db.log.filter((l) => l.table === 'notification_story_inputs').length, 1)
  // after TICK_MS: exactly one more pair
  t += 2
  const next = await feed.read(reads[0].head)
  assert.equal(db.log.filter((l) => l.table === 'notification_story_inputs').length, 2)
  assert.equal(next.events.length, 0, 'nothing new → nothing resent (dedupe across the overlap)')
  assert.equal(next.status.state, 'live')
  // geography was read once for the property, and is cached after
  assert.equal(db.log.filter((l) => l.table === 'properties').length, 1)
})

test('a cursor from another server lifetime resends the window instead of skipping events', async () => {
  const t = Date.parse('2026-10-06T08:00:00Z')
  const feed = createWallFeed({ db: feedDb({ inputs: [replyInput('1', '2026-10-06T07:50:00Z')] }), now: () => t, epoch: 'b' })
  const out = await feed.read(999_999)
  assert.equal(out.events.length, 1)
})

test('feed failure is reported as degraded, never as an empty healthy feed', async () => {
  const db = createFakeDb({ handlers: { notification_story_inputs: () => ({ error: { message: 'timeout' } }), send_queue: () => ({ data: [] }) } })
  const feed = createWallFeed({ db, now: () => Date.parse('2026-10-06T08:00:00Z'), epoch: 'c' })
  const out = await feed.read(0)
  assert.equal(out.status.state, 'degraded')
  assert.equal(out.status.inputs, 'unavailable')
})

test('snapshot: unavailable parts say Unavailable (never 0); stale parts keep their last value', async () => {
  let t = Date.parse('2026-10-06T08:00:00Z')
  let fail = false
  const db = createFakeDb({
    rpcs: {
      cockpit_ops_metrics_snapshot: () => { if (fail) throw new Error('boom'); return { sent_count: 412, received_count: 37, positive_count: 9, delivered_count: 400 } },
      // queue RPC missing entirely → unavailable
    },
    handlers: {
      textgrid_numbers: () => ({ data: [{ status: 'active', health_state: 'unverified', daily_limit: 800, messages_sent_today: 120 }, { status: 'active', health_state: 'cooling', cooling_until: '2026-10-07T00:00:00Z' }, { status: 'paused', health_state: 'disabled' }] }),
      campaigns: () => ({ data: [{ id: 'c1', name: 'Dallas wave', status: 'active', market: 'Dallas, TX', queued_count: 50, sent_count: 150, replied_count: 4, positive_count: 2 }] }),
      signals: () => ({ data: [{ id: 'a', rule_key: 'inbox.new_replies_backlog', severity: 'attention', status: 'new', fired_at: 't2' }, { id: 'b', rule_key: 'inbox.new_replies_backlog', severity: 'attention', status: 'new', fired_at: 't1' }, { id: 'c', rule_key: 'queue.stalled', severity: 'critical', status: 'new', fired_at: 't0' }] }),
      notification_story_inputs: () => ({ count: 3 }),
    },
  })
  const snap = createWallSnapshot({ db, now: () => t })
  const s1 = await snap.read()
  assert.equal(s1.metrics.status, 'ok')
  assert.equal(s1.metrics.sent, 412)
  assert.equal(s1.queue.status, 'unavailable')
  assert.equal(s1.queue.waiting, undefined, 'no fabricated zero')
  assert.equal(s1.fleet.online, 1)
  assert.equal(s1.fleet.cooling, 1)
  assert.equal(s1.offers.today, 3)
  assert.equal(s1.signals.items.length, 2, 'one line per rule')
  assert.equal(s1.signals.items[0].rule_key, 'queue.stalled', 'critical first')
  assert.equal(s1.signals.items.find((s) => s.rule_key === 'inbox.new_replies_backlog').open, 2)
  const before = db.log.length
  await snap.read()
  assert.equal(db.log.length, before, 'cached for every display within the TTL')
  fail = true
  t += 31_000
  const s2 = await snap.read()
  assert.equal(s2.metrics.status, 'stale')
  assert.equal(s2.metrics.sent, 412)
  const sys = deriveSystem({ queue: s2.queue, fleet: s2.fleet, signals: s2.signals, feed: { state: 'live' } })
  assert.equal(sys.level, 'critical')
  assert.ok(sys.parts.some((p) => p.label === 'Queue unavailable'))
  assert.ok(sys.parts.some((p) => p.label === 'Queue stalled'))
})

test('queue status derivation and fleet summary', () => {
  assert.equal(deriveQueueStatus({}), 'idle')
  assert.equal(deriveQueueStatus({ queued: 4 }), 'healthy')
  assert.equal(deriveQueueStatus({ queued: 4, lag_active: 1 }), 'delayed')
  assert.equal(deriveQueueStatus({ scheduled: 513, stale_active: 516 }), 'healthy', 'future-scheduled rows are not a delay')
  assert.equal(deriveQueueStatus({ queued: 4, failed_today: 2 }), 'attention')
  const f = fleetSummary([{ status: 'active' }, { status: 'active', spam_flagged_at: 'x' }])
  assert.equal(f.online, 1)
  assert.equal(f.flagged, 1)
})

test('display config validation keeps only view state', () => {
  const r = validateConfigPatch({ preset: 'campaign_operations', rotation: { enabled: true, steps: [{ preset: 'national_command', minutes: 4 }, { preset: 'acquisition_pulse', minutes: 0 }] }, watched_markets: ['dallas-tx', 'x; drop', 'houston-tx'], map_view: { lng: -96.8, lat: 32.8, zoom: 40 }, launch: true })
  assert.equal(r.patch.preset, 'campaign_operations')
  assert.equal(r.patch.rotation.steps[1].minutes, 1, 'clamped')
  assert.deepEqual(r.patch.watched_markets, ['dallas-tx', 'houston-tx'])
  assert.equal(r.patch.map_view.zoom, 16)
  assert.equal('launch' in r.patch, false)
  const cfg = resolveDisplayConfig({ preset: 'nope', settings_json: { audio: 'loud' } })
  assert.equal(cfg.preset, 'national_command')
  assert.equal(cfg.audio, 'off')
  assert.equal(cfg.privacy_mode, 'privacy')
  assert.equal(PRESET_IDS.length, 6)
})
