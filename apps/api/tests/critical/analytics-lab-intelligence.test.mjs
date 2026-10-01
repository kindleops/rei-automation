/**
 * ANALYTICS 4.0 — the Intelligence Lab's read-model additions, pinned on a
 * fixed fixture (expected values computed by hand from the fixture):
 *
 *   seller cohorts     a funnel stage used as a filter narrows EVERY entity to
 *                      those sellers' conversations, measured per window
 *   queue_rows         the whole delivery flow; each row has one outcome
 *   seriesBy           stacked counts sum to the metric's own series
 *   events             lifecycle + allow-listed control changes; no noise, no tests
 *   money              bases never collapse: estimated ≠ modeled ≠ authorized ≠ actual
 *   external sources   declared, never fabricated: not connected until an adapter answers
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { breakdown, buildModel, evaluate, periodFacts, series, seriesBy } from '../../src/lib/domain/analytics/lab/metric-engine.js'
import { COHORTS, DIMENSION_REGISTRY, MONEY_BASES, METRICS_BY_ID, externalSources, publicRegistry } from '../../src/lib/domain/analytics/lab/metric-registry.js'
import { getMoney, getRegistry, moneyModel, runQuery, shapeEvents, CONTROL_KEYS } from '../../src/lib/domain/analytics/lab/lab-service.js'
import { CLASS_DISPOSITION, classifySend } from '../../src/lib/domain/analytics/lab/fact-classifiers.js'
import { ContractError, normalizeContext } from '../../src/lib/domain/analytics/lab/query-contract.js'

const W = { start: Date.parse('2026-09-01T00:00:00Z'), end: Date.parse('2026-09-30T00:00:00Z') }
const P = { start: Date.parse('2026-08-03T00:00:00Z'), end: Date.parse('2026-09-01T00:00:00Z') }
let seq = 0
const id = (p) => `${p}-${String(++seq).padStart(4, '0')}`
const send = (thread, { status = 'delivered', created, sent = null, campaign = 'c1', property = 'p1', reason = null } = {}) => ({
  id: id('sq'), thread_key: thread, to_phone_number: thread, from_phone_number: '+16125092382', queue_status: status,
  created_at: created, sent_at: sent, delivered_at: status === 'delivered' ? sent : null, delivery_confirmed: null,
  scheduled_for: created, scheduled_for_utc: created, campaign_id: campaign, property_id: property, template_id: 't1', textgrid_number_id: 's1',
  source: 'campaign_launch_execution', message_type: null, touch_number: 1, language: 'English', seller_display_name: null,
  failed_reason: status === 'failed_transport' ? 'delivery_failed' : null, blocked_reason: status === 'blocked_by_health_guard' ? reason : null, guard_reason: null, paused_reason: null,
  md_internal_canary: null, md_exclude_from_kpis: null,
})
const inbound = (thread, created, intent, { optOut = false } = {}) => ({
  id: id('me'), thread_key: thread, created_at: created, received_at: created, detected_intent: intent, is_opt_out: optOut, opt_out_keyword: null,
  property_id: null, from_phone_number: thread, to_phone_number: '+16125092382', event_type: 'inbound_sms', md_internal_canary: null,
})

function fixture({ closings } = {}) {
  seq = 0
  return {
    window: { start: P.start, end: W.end, basis: 'attempt' },
    sends: [
      send('+15550000001', { created: '2026-09-02T14:00:00Z', sent: '2026-09-02T14:00:05Z' }), // A reached, replies (positive)
      send('+15550000001', { created: '2026-09-04T14:00:00Z', sent: '2026-09-04T14:00:05Z' }), // A second delivered touch
      send('+15550000002', { created: '2026-09-05T15:00:00Z', sent: '2026-09-05T15:00:04Z', property: 'p2' }), // B reached, no reply
      send('+15550000004', { created: '2026-09-06T15:00:00Z', sent: '2026-09-06T15:00:04Z', campaign: 'c3', property: 'p3' }), // D reached (Miami), opts out
      send('+15550000005', { status: 'failed_transport', created: '2026-09-04T15:00:00Z', sent: '2026-09-04T15:00:02Z' }), // E undelivered
      send('+15550000007', { status: 'blocked_by_health_guard', created: '2026-09-07T15:00:00Z', reason: 'blocked_sender_number' }), // G sender guard
      send('+15550000012', { status: 'queued', created: '2026-09-28T15:00:00Z' }), // L waiting
      send('+15550000011', { status: 'cancelled', created: '2026-09-08T15:00:00Z' }), // K cancelled
      send('+15550000020', { created: '2026-09-08T15:00:00Z', sent: '2026-09-08T15:00:02Z', campaign: 'c2' }), // T structural test campaign
      // comparison window: two reached sellers, one replies
      send('+15550000030', { created: '2026-08-10T15:00:00Z', sent: '2026-08-10T15:00:02Z', property: 'p2' }),
      send('+15550000031', { created: '2026-08-12T15:00:00Z', sent: '2026-08-12T15:00:02Z', property: 'p2' }),
    ],
    inbound: [
      inbound('+15550000001', '2026-09-03T01:00:00Z', 'seller_interested'),
      inbound('+15550000004', '2026-09-07T11:00:00Z', 'opt_out', { optOut: true }),
      inbound('+15550000030', '2026-08-11T12:00:00Z', 'ownership_confirmed'),
    ],
    history: [
      { id: 'h1', opportunity_id: 'o1', event_type: 'opportunity_created', previous_value: null, new_value: 'offer_interest', created_at: '2026-09-03T02:00:00Z', source: 'seller_autopilot', actor: null, reason: null },
      { id: 'h2', opportunity_id: 'o2', event_type: 'stage_transition', previous_value: 'offer_interest', new_value: 'asking_price', created_at: '2026-09-09T02:00:00Z', source: 'operator', actor: 'operator', reason: null },
    ],
    opportunities: [
      { id: 'o1', acquisition_stage: 'offer_interest', opportunity_status: 'active', primary_property_id: 'p1', primary_thread_key: '+15550000001', campaign_ids: ['c1'], created_at: '2026-09-03T02:00:00Z' },
      { id: 'o2', acquisition_stage: 'asking_price', opportunity_status: 'active', primary_property_id: 'p2', primary_thread_key: '+15550000002', campaign_ids: [], created_at: '2026-06-21T00:00:00Z' },
    ],
    runs: [
      { id: 'r1', status: 'blocked', md_block_reason: 'execution_gated', created_at: '2026-09-03T01:00:10Z', property_id: 'p1', thread_id: '+15550000001', workflow_id: 'seller-inbound-v1', replay_only: false },
      { id: 'r2', status: 'blocked', md_block_reason: 'unclear_low_confidence', created_at: '2026-09-07T11:00:10Z', property_id: 'p3', thread_id: '+15550000004', workflow_id: 'seller-inbound-v1', replay_only: false },
      { id: 'r3', status: 'succeeded', md_block_reason: null, created_at: '2026-09-09T11:00:10Z', property_id: 'p2', thread_id: '+15550000002', workflow_id: 'seller-inbound-v1', replay_only: false }, // B: not a replier
    ],
    offers: [],
    closings: closings || [],
    campaigns: [
      { id: 'c1', name: 'Map area · Minneapolis, MN', candidate_source: 'v_feeder_candidates_fast', md_source: 'map_area' },
      { id: 'c2', name: 'ZZ-CANARY-LIVE-CERT-20260919', candidate_source: 'internal_canary' },
      { id: 'c3', name: 'Miami - Test Campaign', candidate_source: 'v_feeder_candidates_fast', md_production_launch: 'true' },
    ],
    markets: [{ id: 'mpls', display_name: 'Minneapolis, MN', state: 'MN' }, { id: 'miami', display_name: 'Miami, FL', state: 'FL' }],
    senders: [{ id: 's1', phone_number: '+16125092382', friendly_name: 'MINNEAPOLIS 2' }],
    templates: new Map([['t1', { template_id: 't1', template_name: 'Ownership check', use_case: 'ownership_check' }]]),
    properties: new Map([
      ['p1', { property_id: 'p1', canonical_market_id: 'mpls', property_address_state: 'MN', property_address_zip: '55401', property_address_full: '1 Main St', latitude: 44.98, longitude: -93.27, property_type: 'Single Family', estimated_value: 300000 }],
      ['p2', { property_id: 'p2', canonical_market_id: 'mpls', property_address_state: 'MN', property_address_zip: '55402', property_address_full: '2 Main St', latitude: 44.97, longitude: -93.26, property_type: 'Multi-Family', estimated_value: 336000 }],
      ['p3', { property_id: 'p3', canonical_market_id: 'miami', property_address_state: 'FL', property_address_zip: '33101', property_address_full: '3 Ocean Dr', latitude: 25.77, longitude: -80.19, property_type: 'Single Family', estimated_value: 420000 }],
    ]),
    buckets: new Map(),
    dataAsOf: '2026-09-30T00:00:00.000Z',
    loadMs: 0,
  }
}
const model = (f = fixture()) => buildModel(f)
const v = (m, pf) => evaluate(m, pf)

/* ── registry ── */

test('registry: queue_rows, the cohort dimension and seller cohorts are declared and executable', () => {
  assert.ok(METRICS_BY_ID.queue_rows)
  assert.equal(METRICS_BY_ID.queue_rows.entity, 'message')
  assert.ok(DIMENSION_REGISTRY.cohort)
  for (const [key, c] of Object.entries(COHORTS)) {
    assert.ok(c.label && c.set, key)
  }
  const pub = publicRegistry()
  assert.deepEqual(Object.keys(pub.cohorts).sort(), Object.keys(COHORTS).sort())
  const reg = getRegistry({ loader: { replicaState: () => null } })
  assert.equal(reg.classDisposition.carrier_spam_filter, 'undelivered')
  assert.equal(reg.classDisposition.send_gate, 'held')
})

test('registry: every classifier class belongs to exactly the disposition classifySend gives it', () => {
  const rows = [
    [{ queue_status: 'failed_transport', sent_at: 'x' }, 'Spam'], [{ queue_status: 'failed_transport', sent_at: 'x' }, 'Hard Bounce'],
    [{ queue_status: 'failed', failed_reason: '21610 blacklist' }, null], [{ queue_status: 'failed', failed_reason: 'no sid' }, null],
    [{ queue_status: 'paused_global_lock' }, null], [{ queue_status: 'blocked_by_health_guard', blocked_reason: 'blocked_template_id' }, null],
    [{ queue_status: 'blocked', blocked_reason: 'blank_greeting' }, null], [{ queue_status: 'expired' }, null], [{ queue_status: 'cancelled', failed_reason: 'stale' }, null],
    [{ queue_status: 'queued' }, null], [{ queue_status: 'delivered', delivered_at: 'x' }, null], [{ queue_status: 'sent', sent_at: 'x' }, null],
  ]
  for (const [row, bucket] of rows) {
    const { disposition, cls } = classifySend(row, bucket)
    assert.equal(CLASS_DISPOSITION[cls], disposition, `${cls} → ${disposition}`)
  }
})

test('registry: money bases keep estimated / modeled / authorized / expected / actual apart', () => {
  const kinds = new Set(MONEY_BASES.map((b) => b.kind))
  for (const k of ['stated', 'estimated', 'modeled', 'authorized', 'expected', 'actual']) assert.ok(kinds.has(k), k)
  assert.equal(new Set(MONEY_BASES.map((b) => b.id)).size, MONEY_BASES.length)
  for (const b of MONEY_BASES) assert.ok(b.source && b.note, b.id)
})

test('registry: external sources are declared, never connected without an adapter, and position is not "rank"', () => {
  const sources = externalSources()
  const gsc = sources.find((s) => s.id === 'search_console')
  assert.ok(gsc)
  assert.equal(gsc.status, 'not_connected')
  assert.match(gsc.reason, /nothing is shown/i)
  const pos = gsc.metrics.find((m) => m.id === 'gsc_position')
  assert.match(pos.definition, /not rank tracking/i)
  assert.ok(!('value' in gsc) && !gsc.metrics.some((m) => 'value' in m), 'no values are declared for an unconnected source')
})

test('contract: a cohort step must name a known funnel stage', () => {
  const ok = normalizeContext({ segment: [{ dim: 'cohort', value: 'replied', label: 'Replied sellers' }] })
  assert.equal(ok.segment[0].value, 'replied')
  assert.throws(() => normalizeContext({ segment: [{ dim: 'cohort', value: 'whatever' }] }), ContractError)
})

/* ── engine ── */

test('cohort: "replied" narrows every entity to the repliers’ conversations, per window', () => {
  const m = model()
  const all = periodFacts(m, W)
  assert.equal(v('sellers_reached', all).value, 3) // A, B, D (T is a test campaign)
  assert.equal(v('reached_replied', all).value, 2) // A, D
  const seg = [{ dim: 'cohort', value: 'replied' }]
  const cur = periodFacts(m, W, { segment: seg })
  assert.equal(cur.cohort, 2)
  assert.equal(v('sellers_reached', cur).value, 2)
  assert.equal(v('reply_rate', cur).value, 1)
  assert.equal(v('interested_sellers', cur).value, 1) // A
  assert.equal(v('opted_out_sellers', cur).value, 1) // D
  // messages narrowed to A and D (A has two delivered touches)
  assert.equal(v('messages_delivered', cur).value, 3)
  assert.equal(v('queue_rows', cur).value, 3)
  // runs and opportunities follow the conversation (B's run is outside the cohort)
  assert.equal(v('autopilot_runs', all).value, 3)
  assert.equal(v('autopilot_runs', cur).value, 2)
  assert.equal(v('opportunities_created', cur).value, 1) // o1 is A's; o2 is B's (no reply)
  assert.equal(v('stage_advancements', cur).value, 0)
  // the comparison window measures ITS repliers: one of two
  const prev = periodFacts(m, P, { segment: seg })
  assert.equal(prev.cohort, 1)
  assert.equal(v('sellers_reached', prev).value, 1)
})

test('cohort: interested ⊂ replied ⊂ reached, and an empty cohort is an empty window, not "all"', () => {
  const m = model()
  const reached = periodFacts(m, W, { segment: [{ dim: 'cohort', value: 'reached' }] })
  const interested = periodFacts(m, W, { segment: [{ dim: 'cohort', value: 'interested' }] })
  assert.equal(v('sellers_reached', reached).value, 3)
  assert.equal(v('sellers_reached', interested).value, 1)
  const none = periodFacts(m, W, { segment: [{ dim: 'cohort', value: 'opportunity' }, { dim: 'market', value: 'miami' }] })
  assert.equal(none.cohort, 0)
  assert.equal(v('sellers_reached', none).value, 0)
  assert.equal(v('messages_sent', none).value, 0)
})

test('queue_rows: every row in the window once; its disposition breakdown adds up', () => {
  const pf = periodFacts(model(), W)
  const q = v('queue_rows', pf)
  // A×2, B, D, E, G, L, K (T is a test campaign → excluded)
  assert.equal(q.value, 8)
  const bd = breakdown('queue_rows', pf, 'disposition', { limit: 50 })
  assert.equal(bd.rows.reduce((a, r) => a + r.value, 0), q.value)
  assert.equal(bd.rows.find((r) => r.key === 'waiting').value, 1)
  assert.equal(bd.rows.find((r) => r.key === 'cancelled').value, 1)
  assert.equal(bd.rows.find((r) => r.key === 'blocked').value, 1)
})

test('seriesBy: stacked counts sum to the metric’s own series in every bucket; rates are refused', () => {
  const pf = periodFacts(model(), W)
  const s = series('queue_rows', pf, { grain: 'day', tz: 'UTC' })
  const by = seriesBy('queue_rows', pf, 'disposition', { grain: 'day', tz: 'UTC', limit: 2 })
  assert.equal(by.available, true)
  assert.equal(by.buckets.length, s.length)
  by.buckets.forEach((b, i) => {
    assert.equal(Object.values(b.values).reduce((a, x) => a + x, 0), s[i].value, `bucket ${i}`)
    assert.equal(b.total, s[i].value)
  })
  assert.equal(by.keys.length, 2)
  assert.equal(by.keys.reduce((a, k) => a + k.total, 0) + by.other, by.total)
  assert.equal(seriesBy('reply_rate', pf, 'market', { grain: 'day', tz: 'UTC' }).available, false)
})

test('closings: a case voided in its provenance is excluded like a voided status', () => {
  const f = fixture({
    closings: [
      { id: 'cc1', closing_status: 'not_scheduled', terminal_outcome: null, md_voided: 'true', created_at: '2026-09-10T00:00:00Z', expected_gross_revenue: 9000 },
      { id: 'cc2', closing_status: 'under_contract', terminal_outcome: null, md_voided: null, created_at: '2026-09-11T00:00:00Z', opportunity_id: 'o2', seller_contract_price: 210000, expected_gross_revenue: 12000 },
    ],
  })
  const m = buildModel(f)
  assert.equal(m.excluded.voidedClosings, 1)
  assert.equal(m.closings.length, 1)
  assert.equal(m.closings[0].money.contract, 210000)
  assert.equal(m.closings[0].money.confirmedGross, null)
})

/* ── events ── */

test('events: lifecycle and allow-listed control changes only; tests excluded; repeats folded', () => {
  const m = model()
  const events = shapeEvents({
    campaigns: m.campaigns,
    campaignRows: [
      { id: 'e1', campaign_id: 'c1', event_type: 'campaign.activated', created_at: '2026-09-28T14:35:33Z', description: 'Activated with 0 queue rows inserted' },
      { id: 'e2', campaign_id: 'c1', event_type: 'campaign.activated', created_at: '2026-09-28T14:50:00Z', description: 'again' },
      { id: 'e3', campaign_id: 'c2', event_type: 'campaign.archived', created_at: '2026-09-16T00:28:06Z' },
      { id: 'e4', campaign_id: 'c1', event_type: 'campaign.launch_scheduled', created_at: '2026-09-28T15:00:00Z' },
      { id: 'e5', campaign_id: 'c3', event_type: 'campaign.launch_blocked', created_at: '2026-09-24T00:41:17Z' },
    ],
    controlRows: [
      { key: 'queue_processor_mode', value: 'live', updated_at: '2026-09-23T23:27:55.055Z' },
      { key: 'followup_automation_mode', value: 'full_live', updated_at: '2026-09-23T23:27:55.055Z' },
      { key: 'sms_blocked_sender_numbers', value: '+13235589881,+19804589889,+12818458577', updated_at: '2026-09-28T14:46:02Z' },
      { key: 'queue_engine_shared_secret', value: 'never-shown', updated_at: '2026-09-20T00:00:00Z' },
    ],
  })
  const text = JSON.stringify(events)
  assert.ok(!/never-shown/.test(text), 'a key outside the allow-list is never surfaced')
  assert.ok(!events.some((e) => e.campaignId === 'c2'), 'test campaigns are not operations')
  assert.ok(!events.some((e) => /launch_scheduled/.test(e.title)), 'scheduler ticks are noise')
  const act = events.find((e) => e.campaignId === 'c1')
  assert.equal(act.repeats, 1)
  assert.equal(events.filter((e) => e.campaignId === 'c1').length, 1)
  const ctl = events.filter((e) => e.kind === 'control')
  assert.equal(ctl.length, 2)
  const gate = ctl.find((e) => e.items.length === 2)
  assert.match(gate.title, /2 control settings changed/)
  assert.ok(gate.items.some((i) => i.label === CONTROL_KEYS.queue_processor_mode.label && i.value === 'live'))
  const list = ctl.find((e) => e.items[0].key === 'sms_blocked_sender_numbers')
  assert.equal(list.items[0].value, '3 sender numbers')
  assert.match(list.note, /latest change/)
  assert.deepEqual(events.map((e) => e.at), [...events.map((e) => e.at)].sort())
})

/* ── money ── */

const card = (id, stage, { lane = 'seller', asking = null, propertyId = 'p1', thread = '+15550000001', stall = null } = {}) => ({
  id, stage, stageIndex: { ownership_confirmation: 1, offer_interest: 2, asking_price: 3, property_condition: 4, offer: 5 }[stage], lane: { key: lane, label: lane },
  stall, daysInStage: 9, address: `${id} St`, propertyId, threadKey: thread, money: { asking },
})
const offerRow = (cardId, state, engine) => ({ card: { id: cardId }, engine, readiness: { state, reasons: state === 'authorized' ? [] : ['Thin comp coverage — 1 qualified comp'] }, offer: null })

test('money: authorized vs needs-validation never sum together; an absurd engine value cannot reach a total', () => {
  const m = model()
  const out = moneyModel({
    cards: [
      card('d1', 'offer', { lane: 'system', asking: 250000, propertyId: 'p1' }),
      card('d2', 'offer_interest', { lane: 'operator', asking: 4100, propertyId: 'p2', thread: '+15550000002' }), // implausible ask
      card('d3', 'offer_interest', { lane: 'dormant', propertyId: 'p3', thread: '+15550000004' }),
      card('d4', 'closed', { lane: 'closed_out' }),
      card('d6', 'closed', { lane: 'system', propertyId: 'p1' }), // parked at S10 with no closing evidence
    ],
    offers: [
      offerRow('d1', 'authorized', { recommended: 168600, mid: 362500, assignmentFee: 20300, compCount: 12 }),
      offerRow('d2', 'needs_validation', { recommended: 173028700, mid: 332498300, assignmentFee: 6579700, compCount: 1 }),
    ],
    closings: m.closings,
    prop: (pid) => m.prop(pid),
    marketLabel: (mk) => m.markets.get(mk)?.display_name || mk,
  })
  assert.equal(out.totals.deals, 4, 'closed-out deals are not value in motion')
  assert.equal(out.totals.closedWithoutEvidence, 1)
  assert.equal(out.stages.find((s) => s.code === 'closed').deals, 0, 'S10 counts only closings with evidence')
  assert.equal(out.totals.authorized.n, 1)
  assert.equal(out.totals.authorized.offer, 168600)
  assert.equal(out.totals.authorized.fee, 20300)
  assert.equal(out.totals.needsValidation, 1)
  assert.equal(out.totals.notPriced, 1)
  assert.ok(!JSON.stringify(out.totals).includes('173028700'), 'a needs-validation engine offer is never summed')
  assert.ok(!JSON.stringify(out.stages).includes('332498300'), 'a needs-validation valuation is never summed')
  assert.equal(out.totals.askingImplausible, 1)
  assert.deepEqual(out.totals.asking, { n: 1, sum: 250000 })
  assert.deepEqual(out.totals.record, { n: 3, sum: 300000 + 336000 + 420000 })
  assert.deepEqual(out.totals.actual, { n: 0, sum: 0 })
  assert.equal(out.totals.lanes.system, 1)
  assert.equal(out.totals.lanes.operator, 1)
  assert.equal(out.totals.lanes.dormant, 1)
  const s5 = out.stages.find((s) => s.code === 'offer')
  assert.equal(s5.deals, 1)
  assert.equal(s5.authorized.offer, 168600)
  const d2 = out.deals.find((d) => d.id === 'd2')
  assert.equal(d2.askImplausible, true)
  assert.equal(d2.engine.state, 'needs_validation')
  assert.equal(d2.market, 'Minneapolis, MN')
  assert.ok(out.markets.find((x) => x.key === 'miami'))
})

test('money: the Lab scope (market breadcrumb, cohort) narrows the pipeline; a non-applicable filter says so', async () => {
  const fakeLoader = { load: async () => fixture() }
  const pipeline = {
    feed: async ({ cursor }) => (cursor === 0
      ? { rows: [card('d1', 'offer', { propertyId: 'p1', asking: 250000 }), card('d3', 'offer_interest', { propertyId: 'p3', thread: '+15550000004' })], nextCursor: 2 }
      : { rows: [card('d5', 'asking_price', { propertyId: 'p2', thread: '+15550000002' })], nextCursor: null }),
    offers: async () => ({ rows: [offerRow('d1', 'authorized', { recommended: 168600, mid: 362500, assignmentFee: 20300 })], truncated: false }),
  }
  const base = { tz: 'UTC', range: { preset: 'custom', start: '2026-09-01T00:00:00Z', end: '2026-09-30T00:00:00Z' } }
  const now = { now: Date.parse('2026-09-30T12:00:00Z') }
  const all = await getMoney(normalizeContext(base, now), { loader: fakeLoader, pipeline })
  assert.equal(all.result.totals.deals, 3, 'both feed pages are read')
  assert.equal(all.result.asOf, 'now')
  assert.equal(all.result.stages.find((s) => s.code === 'offer').label, 'Offer')
  const mpls = await getMoney(normalizeContext({ ...base, segment: [{ dim: 'market', value: 'mpls', label: 'Minneapolis, MN' }] }, now), { loader: fakeLoader, pipeline })
  assert.equal(mpls.result.totals.deals, 2) // d1 (p1), d5 (p2)
  const replied = await getMoney(normalizeContext({ ...base, segment: [{ dim: 'cohort', value: 'replied' }] }, now), { loader: fakeLoader, pipeline })
  assert.deepEqual(replied.result.deals.map((d) => d.id).sort(), ['d1', 'd3']) // A and D replied; B (d5) did not
  const bySender = await getMoney(normalizeContext({ ...base, filters: [{ field: 'sender', op: 'in', value: ['s1'] }] }, now), { loader: fakeLoader, pipeline })
  assert.deepEqual(bySender.result.notApplicable, ['sender'])
})

test('query: seriesBy through the service carries the current window only, with keys and a remainder', async () => {
  const fakeLoader = { load: async () => fixture() }
  const ctx = normalizeContext({ tz: 'UTC', metric: 'queue_rows', groupBy: 'disposition', limit: 3, range: { preset: 'custom', start: '2026-09-01T00:00:00Z', end: '2026-09-30T00:00:00Z' } }, { now: Date.parse('2026-09-30T12:00:00Z') })
  const q = await runQuery(ctx, 'seriesBy', { loader: fakeLoader })
  assert.equal(q.result.available, true)
  assert.equal(q.result.keys.length, 3)
  assert.equal(q.result.total, 8)
  await assert.rejects(() => runQuery(normalizeContext({ tz: 'UTC', metric: 'queue_rows' }), 'seriesBy', { loader: fakeLoader }), /needs groupBy/)
})

test('geography: every level adds up to the national count; unplaced activity stays explicit', () => {
  const f = fixture()
  // one more reached seller whose property has no canonical market, state, county or ZIP
  f.sends.push(send('+15550000040', { created: '2026-09-09T15:00:00Z', sent: '2026-09-09T15:00:04Z', property: 'p9' }))
  f.properties.set('p9', { property_id: 'p9', canonical_market_id: null, property_address_state: null, property_address_zip: null, property_address_full: 'Unplaced' })
  for (const [pid, county] of [['p1', 'Hennepin'], ['p2', 'Hennepin'], ['p3', 'Miami-Dade']]) f.properties.set(pid, { ...f.properties.get(pid), property_address_county_name: county })
  const pf = periodFacts(buildModel(f), W)
  const total = v('sellers_reached', pf).value
  assert.equal(total, 4)
  for (const dim of ['state', 'market', 'county', 'zip']) {
    const rows = breakdown('sellers_reached', pf, dim, { limit: 500 }).rows
    assert.equal(rows.reduce((a, r) => a + r.value, 0), total, `${dim} rows sum to the national count`)
    const unresolved = rows.find((r) => r.key === '__unresolved')
    assert.ok(unresolved && unresolved.value === 1 && unresolved.label === 'Unresolved', `${dim} keeps the unplaced seller explicit`)
  }
  // a rate's breakdown denominators also add up, so a market map never invents or drops sellers
  const rr = breakdown('reply_rate', pf, 'market', { limit: 500 }).rows
  assert.equal(rr.reduce((a, r) => a + r.den, 0), total)
})
