/**
 * ANALYTICS LAB — engine reconciliation on a FIXED fixture cohort.
 *
 * Every expected value below was computed by hand from the fixture (the
 * independent reference), not by running the engine. The fixture encodes the
 * production traps found in the 2026-09-30 audit:
 *   - a queued-in-August / sent-in-September message (attempt vs created time)
 *   - an inbound row whose received_at was REWRITTEN into the window (created_at is truth)
 *   - canary phones, a structural test campaign, a "Test"-named LIVE campaign
 *   - carrier spam filter vs provider 21610 rejection vs pre-send guards vs send gate
 *   - a null-actor opportunity_created (must count), a certification row (must not),
 *     a backward stage move (not an advancement)
 *   - replay-only autopilot runs, an inbound counter-offer (not an issued offer)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  breakdown, buildModel, cohortOf, compare, contribution, evaluate, heatmap, periodFacts, series, v1Compatible,
} from '../../src/lib/domain/analytics/lab/metric-engine.js'
import { getOverview, getRecords, runQuery } from '../../src/lib/domain/analytics/lab/lab-service.js'
import { normalizeContext } from '../../src/lib/domain/analytics/lab/query-contract.js'
import { classifySend, campaignIntegrity, runClass } from '../../src/lib/domain/analytics/lab/fact-classifiers.js'
import { METRIC_REGISTRY } from '../../src/lib/domain/analytics/lab/metric-registry.js'

const W = { start: Date.parse('2026-09-01T00:00:00Z'), end: Date.parse('2026-09-30T00:00:00Z') }
const P = { start: Date.parse('2026-08-03T00:00:00Z'), end: Date.parse('2026-09-01T00:00:00Z') }
let seq = 0
const id = (p) => `${p}-${String(++seq).padStart(4, '0')}`
const send = (thread, { status = 'delivered', created, sent = null, campaign = 'c1', property = 'p1', template = 't1', sender = 's1', reason = null, touch = 1, source = 'campaign_launch_execution' } = {}) => ({
  id: id('sq'), thread_key: thread, to_phone_number: thread, from_phone_number: '+16125092382', queue_status: status,
  created_at: created, sent_at: sent, delivered_at: status === 'delivered' ? sent : null, delivery_confirmed: null,
  scheduled_for: created, scheduled_for_utc: created, campaign_id: campaign, property_id: property, template_id: template, textgrid_number_id: sender,
  source, message_type: null, touch_number: touch, language: 'English', seller_display_name: null,
  failed_reason: status === 'failed_transport' ? 'delivery_failed' : status === 'failed' ? reason : null,
  blocked_reason: ['blocked', 'blocked_by_health_guard'].includes(status) ? reason : null, guard_reason: null, paused_reason: null,
  md_internal_canary: null, md_exclude_from_kpis: null,
})
const inbound = (thread, created, intent, { property = null, receivedAt = null, optOut = false } = {}) => ({
  id: id('me'), thread_key: thread, created_at: created, received_at: receivedAt || created, detected_intent: intent, is_opt_out: optOut, opt_out_keyword: null,
  property_id: property, from_phone_number: thread, to_phone_number: '+16125092382', event_type: thread ? 'inbound_sms' : 'inbound_unknown', md_internal_canary: null,
})

function fixture() {
  seq = 0
  const sends = [
    send('+15550000001', { created: '2026-09-02T14:00:00Z', sent: '2026-09-02T14:00:05Z' }), // A reached, c1, p1
    send('+15550000002', { created: '2026-09-05T15:00:00Z', sent: '2026-09-05T15:00:04Z', property: 'p2' }), // B reached
    send('+15550000003', { created: '2026-08-20T15:00:00Z', sent: '2026-08-20T15:00:03Z' }), // C reached in AUGUST (comparison)
    send('+15550000004', { created: '2026-08-25T15:00:00Z', sent: '2026-09-01T10:00:00Z', campaign: 'c3', property: 'p3' }), // D queued Aug, sent Sep 1 (Minneapolis property)
    send('+15550000005', { status: 'failed_transport', created: '2026-09-04T15:00:00Z', sent: '2026-09-04T15:00:02Z' }), // E carrier spam
    send('+15550000006', { status: 'failed', created: '2026-09-06T15:00:00Z', reason: 'TextGrid HTTP failure: {"status":"400","code":"21610","message":"The message From/To pair violates a blacklist rule."}' }), // F provider 21610
    send('+15550000007', { status: 'blocked_by_health_guard', created: '2026-09-07T15:00:00Z', reason: 'blocked_sender_number' }), // G sender health
    send('+15550000008', { status: 'blocked_by_health_guard', created: '2026-09-07T16:00:00Z', reason: 'blocked_template_id' }), // H template health
    send('+15550000009', { status: 'paused_global_lock', created: '2026-09-07T17:00:00Z' }), // I send gate
    send('+15550000010', { status: 'blocked', created: '2026-09-07T18:00:00Z', reason: 'blank_greeting_legacy_retired_before_send' }), // J content guard
    send('+15550000011', { status: 'cancelled', created: '2026-09-08T15:00:00Z', reason: 'stale_runnable_row_expired' }), // K cancelled
    send('+15550000012', { status: 'queued', created: '2026-09-28T15:00:00Z' }), // L waiting
    send('+16127433952', { created: '2026-09-03T15:00:00Z', sent: '2026-09-03T15:00:01Z' }), // Z canary phone
    send('+15550000020', { created: '2026-09-08T15:00:00Z', sent: '2026-09-08T15:00:02Z', campaign: 'c2' }), // T structural test campaign
    // comparison window: two more reached sellers (one replies) so a comparison exists
    send('+15550000030', { created: '2026-08-10T15:00:00Z', sent: '2026-08-10T15:00:02Z', property: 'p2' }),
  ]
  const inboundRows = [
    inbound('+15550000001', '2026-09-03T01:00:00Z', 'seller_interested'), // A positive, after anchor
    inbound('+15550000003', '2026-09-02T12:00:00Z', 'not_interested'), // C replies in Sep to August outreach
    inbound('+15550000004', '2026-09-01T11:00:00Z', 'opt_out', { optOut: true }), // D opt-out after anchor
    inbound('+15550000002', '2026-08-10T12:00:00Z', 'unclear', { receivedAt: '2026-09-10T12:00:00Z' }), // B: created in AUGUST, received_at rewritten into Sep
    inbound(null, '2026-09-09T12:00:00Z', null), // unattributable (no thread)
    inbound('+16127433952', '2026-09-03T16:00:00Z', 'seller_interested'), // canary
    inbound('+15550000030', '2026-08-11T12:00:00Z', 'ownership_confirmed'), // comparison-window reply
  ]
  const history = [
    { id: 'h1', opportunity_id: 'o1', event_type: 'opportunity_created', previous_value: null, new_value: 'offer_interest', created_at: '2026-09-03T02:00:00Z', source: 'seller_autopilot', actor: null, reason: null },
    { id: 'h2', opportunity_id: 'o1', event_type: 'stage_transition', previous_value: 'offer_interest', new_value: 'asking_price', created_at: '2026-09-04T02:00:00Z', source: 'seller_autopilot', actor: 'seller_inbound_orchestrator', reason: 'S2_TO_S3_ASKS_OFFER' },
    { id: 'h3', opportunity_id: 'o1', event_type: 'stage_transition', previous_value: 'asking_price', new_value: 'property_condition', created_at: '2026-09-06T02:00:00Z', source: 'seller_autopilot', actor: 'seller_inbound_orchestrator', reason: null },
    { id: 'h4', opportunity_id: 'o2', event_type: 'stage_transition', previous_value: 'closed', new_value: 'asking_price', created_at: '2026-09-07T02:00:00Z', source: 'operator', actor: 'operator', reason: 'None' },
    { id: 'h5', opportunity_id: 'o2', event_type: 'stage_transition', previous_value: 'asking_price', new_value: 'property_condition', created_at: '2026-09-08T02:00:00Z', source: 'operator', actor: 'cert', reason: null },
  ]
  const opportunities = [
    { id: 'o1', acquisition_stage: 'property_condition', opportunity_status: 'active', primary_property_id: 'p1', primary_thread_key: '+15550000001', campaign_ids: ['c1'], created_at: '2026-09-03T02:00:00Z' },
    { id: 'o2', acquisition_stage: 'asking_price', opportunity_status: 'active', primary_property_id: 'p2', primary_thread_key: '+15559999999', campaign_ids: [], created_at: '2026-06-21T00:00:00Z' },
  ]
  const run = (status, reason, at, extra = {}) => ({ id: id('run'), status, md_block_reason: reason, created_at: at, property_id: 'p1', thread_id: null, workflow_id: 'seller-inbound-v1', replay_only: false, ...extra })
  const runs = [
    run('blocked', 'execution_gated', '2026-09-02T00:00:00Z'), run('blocked', 'execution_gated', '2026-09-03T00:00:00Z'), run('blocked', 'execution_gated', '2026-09-04T00:00:00Z'),
    run('blocked', 'unclear_low_confidence', '2026-09-05T00:00:00Z'), run('succeeded', null, '2026-09-06T00:00:00Z'),
    run('blocked', 'auto_reply_mode_disabled', '2026-09-07T00:00:00Z'), run('blocked', 'opt_out_intent_no_marketing', '2026-09-08T00:00:00Z'),
    run('succeeded', null, '2026-09-09T00:00:00Z', { replay_only: true }),
  ]
  const properties = new Map([
    ['p1', { property_id: 'p1', canonical_market_id: 'mpls', property_address_state: 'MN', property_address_zip: '55401', property_address_county_name: 'Hennepin', property_address_full: '1 Main St, Minneapolis, MN', latitude: 44.98, longitude: -93.27, property_type: 'Single Family', equity_percent: 60, owner_type: 'Individual' }],
    ['p2', { property_id: 'p2', canonical_market_id: 'mpls', property_address_state: 'MN', property_address_zip: '55402', property_address_county_name: 'Hennepin', property_address_full: '2 Main St, Minneapolis, MN', latitude: 44.97, longitude: -93.26, property_type: 'Multi-Family', equity_percent: 20, owner_type: 'INDIVIDUAL | ABSENTEE' }],
    ['p3', { property_id: 'p3', canonical_market_id: 'mpls', property_address_state: 'MN', property_address_zip: '55403', property_address_county_name: 'Hennepin', property_address_full: '3 Main St, Minneapolis, MN', latitude: 44.96, longitude: -93.28, property_type: 'Single Family', equity_percent: 75, owner_type: 'Corporate' }],
  ])
  return {
    window: { start: P.start, end: W.end, basis: 'attempt' },
    sends, inbound: inboundRows, history, opportunities, runs,
    offers: [{ id: 'of1', offer_id: 'of1', direction: 'inbound', status: 'withdrawn', purchase_price: 4100, created_at: '2026-09-10T11:59:18Z', property_id: 'p1' }],
    closings: [{ id: 'cc1', closing_status: 'not_scheduled', terminal_outcome: null, contract_signed_date: null, recording_date: null, funding_date: null, created_at: '2026-09-10T11:59:19Z', property_id: 'p1' }],
    campaigns: [
      { id: 'c1', name: 'Map area · Minneapolis, MN · 944 properties', candidate_source: 'v_feeder_candidates_fast', md_source: 'map_area' },
      { id: 'c2', name: 'ZZ-CANARY-LIVE-CERT-20260919', candidate_source: 'internal_canary' },
      { id: 'c3', name: 'Miami - Test Campaign', candidate_source: 'v_feeder_candidates_fast', md_production_launch: 'true' },
    ],
    markets: [{ id: 'mpls', display_name: 'Minneapolis, MN', state: 'MN' }],
    senders: [{ id: 's1', phone_number: '+16125092382', friendly_name: 'MINNEAPOLIS 2' }],
    templates: new Map([['t1', { template_id: 't1', template_name: 'Ownership check', use_case: 'ownership_check' }]]),
    properties,
    buckets: new Map(),
    dataAsOf: '2026-09-30T00:00:00.000Z',
    loadMs: 0,
  }
}
function withBuckets(f) {
  const e = f.sends.find((s) => s.thread_key === '+15550000005')
  f.buckets.set(e.id, 'Spam')
  return f
}
const model = () => buildModel(withBuckets(fixture()))
const val = (idm, pf) => evaluate(idm, pf)

test('classifiers: held ≠ transport failure ≠ provider rejection ≠ guard ≠ campaign hold', () => {
  assert.deepEqual(classifySend({ queue_status: 'failed_transport', sent_at: 'x' }, 'Spam'), { disposition: 'undelivered', cls: 'carrier_spam_filter' })
  assert.deepEqual(classifySend({ queue_status: 'failed', failed_reason: 'TextGrid HTTP failure 21610 blacklist' }), { disposition: 'rejected', cls: 'provider_blacklist' })
  assert.deepEqual(classifySend({ queue_status: 'paused_global_lock' }), { disposition: 'held', cls: 'send_gate' })
  assert.deepEqual(classifySend({ queue_status: 'blocked_by_health_guard', blocked_reason: 'blocked_template_id' }), { disposition: 'blocked', cls: 'template_health' })
  assert.deepEqual(classifySend({ queue_status: 'blocked_by_health_guard', blocked_reason: 'blocked_sender_number' }), { disposition: 'blocked', cls: 'sender_health' })
  assert.deepEqual(classifySend({ queue_status: 'blocked', blocked_reason: 'blank_message_body' }), { disposition: 'blocked', cls: 'content_guard' })
  assert.deepEqual(classifySend({ queue_status: 'cancelled', failed_reason: 'not_interested' }), { disposition: 'cancelled', cls: 'superseded_by_conversation' })
  // the v1 regex would have called these "content blocks"; neither is a carrier content filter
  assert.notEqual(classifySend({ queue_status: 'failed', failed_reason: '21610' }).cls, 'carrier_spam_filter')
  assert.notEqual(classifySend({ queue_status: 'blocked', blocked_reason: 'blank_greeting' }).cls, 'carrier_spam_filter')
})

test('classifiers: campaign integrity is structural; a "Test"-named LIVE campaign is business', () => {
  assert.equal(campaignIntegrity({ name: 'ZZ-CANARY-LIVE-CERT', candidate_source: 'internal_canary' }).test, true)
  assert.equal(campaignIntegrity({ name: 'INTERNAL CANARY - proof', md_internal_canary: 'true' }).test, true)
  assert.equal(campaignIntegrity({ name: 'Miami - Test Campaign', md_production_launch: 'true' }).test, false)
  assert.equal(campaignIntegrity({ name: 'Map area · Minneapolis' }).test, false)
  assert.equal(runClass('blocked', 'execution_gated'), 'send_gate')
  assert.equal(runClass('blocked', 'unclear_low_confidence'), 'human_review')
  assert.equal(runClass('blocked', 'auto_reply_mode_disabled'), 'auto_reply_off')
})

test('sellers: reached by SEND time, replies by receive (created_at) time, canary + test excluded', () => {
  const pf = periodFacts(model(), W)
  // A, B, D. D was queued in August but SENT Sep 1 → reached in September.
  assert.equal(val('sellers_reached', pf).value, 3)
  // A replied after anchor; D opted out after anchor; B's only reply was CREATED in August
  // (its received_at was rewritten into September and must not count).
  assert.equal(val('reached_replied', pf).value, 2)
  const rr = val('reply_rate', pf)
  assert.equal(rr.num, 2); assert.equal(rr.den, 3)
  assert.ok(Math.abs(rr.value - 2 / 3) < 1e-12)
  assert.equal(rr.status, 'insufficient_sample') // n=3 < 30: shown, flagged, never a finding
  assert.ok(rr.ci.low < rr.value && rr.ci.high > rr.value)
  // throughput: A, C (August outreach), D — not B (August reply), not the canary, not the no-thread row
  assert.equal(val('sellers_replied', pf).value, 3)
  assert.equal(val('interested_sellers', pf).value, 1)
  assert.equal(val('opted_out_sellers', pf).value, 1)
  assert.equal(val('interest_rate', pf).num, 1)
  assert.equal(val('opportunity_rate', pf).num, 1) // A's thread produced o1 after its anchor
  assert.equal(val('opportunity_rate', pf).den, 2)
  // numerator ⊆ denominator for every rate over the same entity
  for (const m of METRIC_REGISTRY.filter((x) => x.unit === 'rate')) {
    const r = val(m.id, pf)
    if (r.status !== 'ok' && r.status !== 'insufficient_sample') continue
    const num = new Set(cohortOf(m.id, pf, 'numerator'))
    const den = new Set(cohortOf(m.id, pf, 'denominator'))
    if (['offer_rate', 'contract_rate', 'close_rate'].includes(m.id)) continue
    for (const e of num) assert.ok(den.has(e), `${m.id}: numerator member outside denominator`)
  }
})

test('delivery: sent / delivered / carrier filter / provider rejection / guards / gate', () => {
  const pf = periodFacts(model(), W)
  assert.equal(val('messages_sent', pf).value, 4) // A, B, D delivered + E undelivered (F never left: provider refused)
  assert.equal(val('messages_delivered', pf).value, 3)
  assert.equal(val('delivery_rate', pf).num, 3)
  assert.equal(val('transport_failures', pf).value, 1)
  assert.equal(val('content_filtered', pf).value, 1)
  assert.equal(val('provider_rejections', pf).value, 1)
  assert.equal(val('sender_health_blocks', pf).value, 1)
  assert.equal(val('template_health_blocks', pf).value, 1)
  assert.equal(val('content_guard_blocks', pf).value, 1)
  assert.equal(val('send_gate_holds', pf).value, 1)
  // delivered 3 + undelivered 1 + rejected 1 + blocked 3 + held 1; cancelled + waiting excluded
  assert.equal(val('dispatch_decisions', pf).value, 9)
})

test('pipeline: null-actor creation counts, certification does not, backward is not an advancement', () => {
  const m = model()
  const pf = periodFacts(m, W)
  assert.equal(val('opportunities_created', pf).value, 1)
  assert.equal(val('stage_advancements', pf).value, 2)
  assert.equal(val('stage_regressions', pf).value, 1)
  assert.equal(m.excluded.syntheticHistory, 1)
  const dwell = val('median_stage_dwell', pf)
  assert.equal(dwell.n, 2) // h2 (24h after h1) and h3 (48h after h2); h4 has no prior event
  assert.equal(dwell.value, (24 * 60 + 48 * 60) / 2)
})

test('automation: holds are classes, intervention is not failure, replay runs excluded', () => {
  const pf = periodFacts(model(), W)
  assert.equal(val('autopilot_runs', pf).value, 7)
  const hi = val('human_intervention_rate', pf)
  assert.equal(hi.num, 1); assert.equal(hi.den, 7)
  const wh = val('workflow_hold_rate', pf)
  assert.equal(wh.num, 6)
})

test('missing ≠ 0: an empty offer ledger gates offer/contract/close RATES as unavailable', () => {
  const pf = periodFacts(model(), W)
  assert.equal(val('offers_issued', pf).value, 0) // the inbound counter is not an issued offer
  for (const idm of ['offer_rate', 'contract_rate', 'close_rate']) {
    const r = val(idm, pf)
    assert.equal(r.status, 'unavailable', idm)
    assert.equal(r.value, null, idm)
    assert.ok(r.reason)
  }
  // a rate with no denominator is NO DATA, never 0%
  const empty = periodFacts(model(), { start: Date.parse('2026-09-20T00:00:00Z'), end: Date.parse('2026-09-21T00:00:00Z') })
  const r = val('reply_rate', empty)
  assert.equal(r.status, 'no_data')
  assert.equal(r.value, null)
})

test('breakdowns are additive and test campaigns never rank', () => {
  const pf = periodFacts(model(), W, { filters: [{ field: 'include_test_campaigns', op: 'is_true', value: null }] })
  assert.equal(val('sellers_reached', pf).value, 4) // T joins when test traffic is explicitly included
  const b = breakdown('sellers_reached', pf, 'campaign')
  assert.equal(b.rows.reduce((a, r) => a + r.value, 0), 4)
  assert.equal(b.rows[b.rows.length - 1].test, true) // the test campaign sorts last
  const pfBiz = periodFacts(model(), W)
  const rb = breakdown('reply_rate', pfBiz, 'campaign')
  assert.equal(rb.rows.reduce((a, r) => a + r.den, 0), 3)
  assert.equal(rb.rows.reduce((a, r) => a + r.num, 0), 2)
})

test('filters apply to the cohort; outreach filters make pipeline metrics NOT APPLICABLE (never silently ignored)', () => {
  const pf = periodFacts(model(), W, { filters: [{ field: 'property_type', op: 'in', value: ['Single Family'] }, { field: 'equity_percent', op: 'gt', value: 50 }] })
  assert.equal(val('sellers_reached', pf).value, 2) // A (p1, 60%) and D (p3, 75%)
  const pf2 = periodFacts(model(), W, { filters: [{ field: 'campaign', op: 'in', value: ['c1'] }] })
  assert.equal(val('sellers_reached', pf2).value, 2)
  const oc = val('opportunities_created', pf2)
  assert.equal(oc.status, 'not_applicable')
  assert.match(oc.reason, /campaign/)
  // a breadcrumb step selects exactly the breakdown row it came from
  const row = breakdown('sellers_reached', periodFacts(model(), W), 'campaign').rows.find((r) => r.key === 'c1')
  const seg = periodFacts(model(), W, { segment: [{ dim: 'campaign', value: 'c1' }] })
  assert.equal(val('sellers_reached', seg).value, row.value)
})

test('series bucket seller metrics by anchor so buckets sum to the period', () => {
  const pf = periodFacts(model(), W)
  const s = series('sellers_reached', pf, { grain: 'day', tz: 'UTC' })
  assert.equal(s.length, 29)
  assert.equal(s.reduce((a, b) => a + b.value, 0), 3)
  const rs = series('reply_rate', pf, { grain: 'day', tz: 'UTC' })
  assert.equal(rs.reduce((a, b) => a + (b.num || 0), 0), 2)
  assert.equal(rs.reduce((a, b) => a + (b.den || 0), 0), 3)
})

test('heatmap is seller-local: a 10:00 UTC Tuesday send to Minneapolis lands at 05:00 Tue', () => {
  const pf = periodFacts(model(), W)
  const hm = heatmap('sellers_reached', pf)
  assert.equal(hm.cells[2][5].n, 1) // D: 2026-09-01 10:00Z = 05:00 CDT, Tuesday
  assert.equal(hm.unresolved, 0)
})

test('comparison uses identical definitions; counts are length-aware; rates speak in points', () => {
  const m = model()
  const cur = periodFacts(m, W)
  const prev = periodFacts(m, P)
  // August: C (Aug 20) and thread 30 (Aug 10) reached; thread 30 replied after its anchor, C replied only in September
  assert.equal(val('sellers_reached', prev).value, 2)
  assert.equal(val('reached_replied', prev).value, 1)
  const c = compare('reply_rate', val('reply_rate', cur), val('reply_rate', prev))
  assert.equal(c.kind, 'rate')
  assert.ok(Math.abs(c.pts - (2 / 3 - 1 / 2) * 100) < 1e-9) // points, not percent
  assert.equal(c.comparable, false) // n < 30 on both sides: no claim
  const cc = compare('sellers_reached', val('sellers_reached', cur), val('sellers_reached', prev), { lenCur: 29, lenPrev: 29 })
  assert.equal(cc.delta, 1)
  assert.equal(cc.pct, null) // base < 10: no percentage
  assert.equal(cc.significant, false)
})

test('contribution analysis sums exactly to the observed change', () => {
  const m = model()
  const cur = periodFacts(m, W)
  const prev = periodFacts(m, P)
  for (const dim of ['campaign', 'property_type', 'market']) {
    const c = contribution('reply_rate', cur, prev, dim)
    assert.equal(c.available, true)
    const sum = c.rows.reduce((a, r) => a + r.contributionPts, 0) + c.others
    assert.ok(Math.abs(sum - c.totalPts) < 1e-9, `${dim}: ${sum} vs ${c.totalPts}`)
    assert.equal(c.language, 'contributed to the observed change')
  }
  const k = contribution('sellers_reached', cur, prev, 'property_type')
  assert.equal(k.rows.reduce((a, r) => a + r.contribution, 0) + k.others, k.total)
})

test('v1 compatibility: created_at basis moves the August-queued send out of September', () => {
  const m = buildModel(withBuckets(fixture()), { basis: 'created' })
  const v1 = v1Compatible(m, W)
  assert.equal(v1.delivered_conversations, 3) // A, B, T (test counted in v1); D queued Aug 25
  assert.equal(v1.replied_conversations, 3) // A, C, D (B's reply created in August)
  assert.equal(v1.stage_advancements, 3) // v1 counts the backward move too
  assert.equal(v1.opportunities_created, 1)
  assert.equal(v1.failed, 2) // transport failure + provider rejection merged in v1
})

/* ── service level with an injected loader (no network) ── */

const fakeLoader = { load: async () => withBuckets(fixture()) }
const ctxOf = (raw) => normalizeContext({ tz: 'America/Chicago', range: { preset: 'custom', start: '2026-09-01T00:00:00Z', end: '2026-09-30T00:00:00Z' }, ...raw }, { now: Date.parse('2026-09-30T12:00:00Z') })

test('records: VIEW RECORDS returns exactly the numerator and denominator cohorts', async () => {
  const ctx = ctxOf({ metric: 'reply_rate' })
  const num = await getRecords(ctx, { metric: 'reply_rate', part: 'numerator' }, { page: 1, pageSize: 50 }, { loader: fakeLoader })
  const den = await getRecords(ctx, { metric: 'reply_rate', part: 'denominator' }, { page: 1, pageSize: 50 }, { loader: fakeLoader })
  assert.equal(num.total, 2)
  assert.equal(den.total, 3)
  assert.equal(num.entity, 'seller')
  assert.ok(num.rows.every((r) => den.rows.some((d) => d.thread === r.thread)))
  assert.ok(num.rows.every((r) => !String(r.phone).includes('5550000')), 'phones are masked in records')
  assert.ok(den.handoff.threads.length === 3 && den.handoff.propertyIds.length === 3)
  const grp = await getRecords(ctx, { metric: 'sellers_reached', group: { dim: 'campaign', key: 'c1' } }, { page: 1, pageSize: 50 }, { loader: fakeLoader })
  assert.equal(grp.total, 2)
  const paged = await getRecords(ctx, { metric: 'dispatch_decisions' }, { page: 1, pageSize: 10 }, { loader: fakeLoader })
  assert.equal(paged.total, 9)
  assert.equal(paged.rows.length, 9)
})

test('overview: strip, narrative refs, no fabricated comparison, funnel honesty', async () => {
  const ctx = ctxOf({ metric: 'reply_rate', compare: { mode: 'custom', start: '2026-08-03T00:00:00Z', end: '2026-09-01T00:00:00Z' } })
  const o = await getOverview(ctx, { loader: fakeLoader })
  assert.equal(o.strip.length, 10)
  const ids = new Set(METRIC_REGISTRY.map((x) => x.id))
  for (const s of o.narrative) for (const r of s.refs) assert.ok(ids.has(r), `narrative ref ${r}`)
  assert.match(o.narrative[0].text, /reached 3 sellers/)
  assert.ok(o.narrative.some((s) => /No offers, contracts or closings/.test(s.text)))
  // tiny samples: nothing is reported as a meaningful change
  assert.equal(o.changes.length, 0)
  assert.equal(o.funnel.steps[0].value, 3)
  assert.equal(o.funnel.steps[1].value, 2)
  assert.equal(o.funnel.events.find((e) => e.id === 'offers_issued').value, 0)
  const text = JSON.stringify(o)
  assert.ok(!/NaN|Infinity/.test(text))
})

test('query views: breakdown carries prior-period rows; contribution requires a comparison', async () => {
  const ctx = ctxOf({ metric: 'reply_rate', groupBy: 'campaign', compare: { mode: 'custom', start: '2026-08-03T00:00:00Z', end: '2026-09-01T00:00:00Z' } })
  const q = await runQuery(ctx, 'breakdown', { loader: fakeLoader })
  assert.ok(q.result.rows.find((r) => r.key === 'c1').prev)
  const none = await runQuery(ctxOf({ metric: 'reply_rate', groupBy: 'campaign', compare: { mode: 'none' } }), 'contribution', { loader: fakeLoader })
  assert.equal(none.result.available, false)
})

test('table: several metrics by one dimension keep their own entities; invalid dimensions are reported, not faked', async () => {
  const { table } = await import('../../src/lib/domain/analytics/lab/metric-engine.js')
  const pf = periodFacts(model(), W)
  const t = table(['sellers_reached', 'reply_rate', 'messages_sent', 'opportunities_created'], pf, 'campaign')
  const c1 = t.rows.find((r) => r.key === 'c1')
  assert.equal(c1.values.sellers_reached.value, 2)
  assert.equal(c1.values.reply_rate.den, 2)
  assert.equal(c1.values.messages_sent.value, 3) // A, B delivered + E undelivered, all c1
  assert.ok(t.skipped.some((s) => s.id === 'opportunities_created'))
})

test('stage matrix: entries, forward share of exits, dwell, and who moved them', async () => {
  const { stageMatrix } = await import('../../src/lib/domain/analytics/lab/metric-engine.js')
  const pf = periodFacts(model(), W)
  const m = stageMatrix(pf, { now: Date.parse('2026-09-30T00:00:00Z'), maxDays: { property_condition: 10 } })
  const s2 = m.find((x) => x.code === 'offer_interest')
  assert.equal(s2.entered, 1) // o1 created at S2 (null actor → operator-attributed, not autopilot)
  assert.equal(s2.exits, 1)
  assert.equal(s2.forwardShare, 1)
  const s3 = m.find((x) => x.code === 'asking_price')
  assert.equal(s3.entered, 2) // o1 advanced into S3; o2 re-opened from closed into S3
  assert.equal(s3.enteredBySystem, 1)
  assert.equal(s3.enteredByHuman, 1)
  const s10 = m.find((x) => x.code === 'closed')
  assert.equal(s10.backward, 1)
  assert.equal(s10.forwardShare, 0)
})
