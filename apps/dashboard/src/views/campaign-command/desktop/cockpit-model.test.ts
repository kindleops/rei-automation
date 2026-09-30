import { describe, expect, it } from 'vitest'
import type { CampaignSummary } from '../campaigns.types'
import type { CockpitRead } from './cockpit-api'
import {
  DEFAULT_FILTERS, attentionFor, bookSummary, degradedFacts, execState, holdWords, matchesNav, navGroupOf, navRow,
  nextLine, nowFacts, releaseWords, sourceOf, spineOf,
} from './cockpit-model'

/**
 * Production's shapes on 2026-09-30 (read-only): Minneapolis stuck with 160
 * overdue retries, Entity Graph on hold with 6 overdue and 37 unplaceable,
 * Tax Delinquent active with no audience, Miami paused, Atlanta a draft.
 */
const NOW = Date.parse('2026-09-30T12:28:00Z') // 07:28 CDT

function row(over: Partial<CampaignSummary>): CampaignSummary {
  return {
    id: 'c', campaign_name: 'Campaign', status: 'draft', total_targets: 0, ready_targets: 0, scheduled_targets: 0, queued_targets: 0,
    sent_count: 0, delivered_count: 0, failed_count: 0, reply_count: 0, positive_reply_count: 0, negative_reply_count: 0, opt_out_count: 0,
    delivery_rate: 0, reply_rate: 0, positive_rate: 0, opt_out_rate: 0, failure_rate: 0, next_send_at: null, last_send_at: null,
    send_interval_seconds: 45, send_window_start: '08:00', send_window_end: '21:00', auto_send_enabled: false, health_score: 0, health_status: 'caution',
    ...over,
  } as CampaignSummary
}

const mplsLineage = {
  kind: 'map_area' as const, declared_source: 'map_area', explicit_property_count: 944,
  area: { bbox: [-93.3, 44.9, -93.2, 45.0], vertices: 68, truncated: false, property_count: 944, label: null, polygon_stored: false },
  handoff_mode: null, filters: [], market_values: [], timezone: 'America/Chicago', stage_code: 'S1', template_use_case: 'ownership_check', campaign_type: 'outbound_sms', channel: 'sms' as const,
}

const mpls = row({
  id: '7f2ba659-16ad-463b-851d-3381c81e2e38',
  campaign_name: 'Map area · Minneapolis, MN · 944 properties',
  status: 'active', operator_state: 'test_mode', total_targets: 563, ready_targets: 16, planned_targets: 487, held_targets: 60, remaining_targets: 16,
  sent_count: 300, delivered_count: 283, failed_count: 188, has_target_definition: true, target_mode: 'explicit', explicit_target_count: 944,
  lineage: mplsLineage,
  live_queue: { live: 160, due: 160, overdue: 160, oldest_due_at: '2026-09-29T13:00:00.000Z', next_scheduled_at: null, release_reasons: { logical_communication_store_error: 48 } },
  feeder_last: { at: '2026-09-30T12:25:00Z', inserted: 0, active_live_rows: 160, ready_remaining: 16, bound: 'buffer_full', reason: 'buffer_full', stalled: false },
})

function cockpit(over: Partial<CockpitRead> = {}): CockpitRead {
  return {
    ok: true, campaign_id: mpls.id, at: new Date(NOW).toISOString(), name: mpls.campaign_name, status: 'active', lineage: mplsLineage,
    lifecycle: { created_at: '2026-09-28T12:20:21Z', scheduled_for: '2026-09-29T13:00:00Z', activated_at: '2026-09-28T14:35:33Z', paused_at: '2026-09-28T20:04:13Z', resumed_at: '2026-09-28T14:47:08Z', completed_at: null, last_transition_reason: 'operator: resume', last_transition_at: '2026-09-28T23:15:06Z', execution_heartbeat_at: '2026-09-30T12:25:00Z', schedule_missed_for: null, schedule_missed_at: null },
    flags: { auto_queue_enabled: true, auto_send_enabled: false, auto_reply_mode: 'disabled', emergency_stop_at: null, production_launch: false, quarantine: null },
    caps: { daily_cap: 750, total_cap: 1000, market_cap: 400, per_sender_cap: 800, configured_per_number_cap: 800, batch_max: 50, send_interval_seconds: 45 },
    targets: { total: 563, by_status: { planned: 487, blocked: 60, ready: 16 }, held_by_reason: { entity_contact_requires_review: 49, missing_identity_linkage: 11 }, advisories: {}, ready: 16, held: 60, committed: 487 },
    send_states: { by_status: { delivered: 283, sent: 17, failed_transport: 182, failed: 6, queued: 160 }, sent: 300, delivered: 283, failed: 188 },
    queue: { live: 160, proof: 0, by_status: { queued: 160 }, due: 160, overdue: 160, processing: 0, spam_retries: 160, oldest_due_at: '2026-09-29T13:00:00.000Z', next_scheduled_at: null, latest_scheduled_at: '2026-09-29T14:30:00.000Z', release_reasons: { logical_communication_store_error: 48 }, by_sender: { '+16125092382': 39, '+16125092623': 121 }, truncated: false },
    sends: { sent_today: 0, day_start: '2026-09-30T05:00:00.000Z', day_timezone: 'America/Chicago', day_timezone_basis: 'campaign', last_sent_at: '2026-09-29T00:33:19.968Z', first_sent_at: '2026-09-28T14:50:24Z', failed_last_hour: 0 },
    feed: { limit: 0, bound: 'buffer_full', buffer_need: 0, daily_remaining: 590, total_remaining: 513, buffer_target: 150, chunk: 100 },
    window: { open: false, reason: 'before_window', window: '08:00–21:00', closes_at: null, next_open_at: '2026-09-30T13:00:00.000Z', timezone: 'America/Chicago', source: 'campaign' },
    processor: { mode: 'live', execution_mode: 'normal', auto_send: true, auto_enqueue: true, outbound_sms: true, emergency_stop_at: null, heartbeat_at: '2026-09-30T12:27:30Z', last_claimed_at: '2026-09-30T01:59:42Z' },
    feeder: { heartbeat_at: '2026-09-30T12:25:10Z', last_batch_at: '2026-09-29T01:45:52Z', campaign_last: { at: '2026-09-30T12:25:09Z', inserted: 0, bound: 'buffer_full', reason: 'buffer_full', stalled: false, ready_remaining: 16, active_live_rows: 160, last_refill_at: '2026-09-29T01:45:50Z', skipped_counts_by_reason: {} } },
    senders: [
      { phone: '+16125092623', label: 'MINNEAPOLIS 3', market: 'Minneapolis, MN', known: true, status: 'active', health_state: 'unverified', health_reason: null, cooling_until: null, spam_flagged_at: null, operator_blocked: false, daily_limit: 800, carrying_campaign: true, campaign_queued: 121, campaign_sent_today: 0, campaign_last_sent_at: null, last_used_at: null },
      { phone: '+16125092382', label: 'MINNEAPOLIS 2', market: 'Minneapolis, MN', known: true, status: 'active', health_state: 'unverified', health_reason: null, cooling_until: null, spam_flagged_at: null, operator_blocked: false, daily_limit: 800, carrying_campaign: true, campaign_queued: 39, campaign_sent_today: 0, campaign_last_sent_at: null, last_used_at: null },
    ],
    email: { campaign_rows: 0, sender_identities: 0 },
    responses: { sellers_messaged: 300, sellers_replied: 18, reply_messages: 18, sellers_asked_to_stop: 5, latest_reply_at: '2026-09-30T04:27:58Z', truncated: false, intents: { unclear: 7, opt_out: 5 }, latest: [] },
    exceptions: { run_id: 'r', execution: { total: 230, truncated: false, groups: [] }, target_preparation: { total: 60, truncated: false, groups: [] } },
    geography: { markets: [{ market: 'Minneapolis, MN', state: 'MN', targets: 563 }], market_count: 1, total: 563, truncated: false },
    timeline: { events: [], idle_feeder_checks: { count: 12, last_at: '2026-09-30T12:25:00Z' } },
    unavailable: [],
    ...over,
  }
}

describe('Minneapolis — stuck, not paused', () => {
  it('reads degraded from the list alone, and groups under Needs you', () => {
    expect(execState(mpls, null, NOW).key).toBe('degraded')
    expect(navGroupOf(mpls, null, NOW)).toBe('needs_you')
    const a = attentionFor(mpls, null, NOW)
    expect(a[0].key).toBe('overdue')
    expect(a[0].title).toBe('160 messages overdue in the queue')
    expect(a[0].actions.map((x) => x.id)).toEqual(['pause', 'view_targets'])
    expect(a[0].stopped).toMatch(/Not paused/)
  })
  it('never calls it test mode: the operator_state label is not the headline', () => {
    const r = navRow(mpls, null, NOW)
    expect(r.state.label).toBe('Degraded')
    expect(r.exception).toBe('160 overdue')
    expect(r.progress).toEqual({ sent: 300, of: 503, pct: 60 })
  })
  it('with the cockpit read: says why, and what happens at the window', () => {
    const k = cockpit()
    const a = attentionFor(mpls, k, NOW)
    expect(a[0].detail).toMatch(/Due since Sep 29, 8:00 AM CDT\./)
    expect(a[0].detail).toMatch(/All 160 are retries of first texts the carrier filtered\./)
    expect(a[0].detail).toMatch(/the send record couldn’t be written \(48\)/)
    expect(a[0].todo).toMatch(/engineering fix/)
    const claimed = attentionFor(mpls, cockpit({ queue: { ...cockpit().queue!, last_claimed_at: '2026-09-30T01:59:42.345Z' } }), NOW)
    expect(claimed[0].detail).toMatch(/The processor last picked them up Sep 29, 8:59 PM CDT and sent none\./)
    expect(nextLine(mpls, k, NOW)).toBe('Window opens 8:00 AM CDT (in 32 min); the 160 overdue messages will be tried again then.')
  })
  it('the degraded banner: real sends, claims and releases — never “ready”, no score', () => {
    const k = cockpit({ queue: { ...cockpit().queue!, last_claimed_at: '2026-09-30T01:59:42.345Z', last_released_at: '2026-09-30T01:59:07.291Z', last_release_reason: 'logical_communication_store_error' } })
    const facts = degradedFacts(k, NOW)
    expect(facts.map((f) => f.key)).toEqual(['feeder', 'queue', 'overdue', 'last_sent', 'last_claim', 'sender', 'window', 'failed'])
    expect(facts.find((f) => f.key === 'queue')?.value).toBe('160 queued')
    expect(facts.some((f) => /ready|sending/i.test(f.value))).toBe(false)
    expect(facts.find((f) => f.key === 'overdue')).toMatchObject({ value: '160 · since Sep 29, 8:00 AM CDT', tone: 'bad' })
    expect(facts.find((f) => f.key === 'last_sent')).toMatchObject({ value: 'Sep 28, 7:33 PM CDT · 35h 55m ago', tone: 'bad' })
    expect(facts.find((f) => f.key === 'last_claim')?.value).toBe('Sep 29, 8:59 PM CDT · released: the send record couldn’t be written')
    expect(facts.find((f) => f.key === 'window')?.value).toBe('closed · opens 8:00 AM CDT')
    expect(facts.find((f) => f.key === 'feeder')?.tone).toBe('ok')
  })
  it('the spine carries units and denominators, and marks where work is stuck', () => {
    const s = spineOf(mpls, cockpit(), false, NOW)
    expect(s.map((n) => [n.key, n.value, n.of, n.unit])).toEqual([
      ['audience', 563, null, 'sellers'],
      ['eligible', 503, 563, 'sellers'],
      ['queued', 487, 503, 'sellers'],
      ['sent', 300, null, 'messages'],
      ['delivered', 283, 300, 'messages'],
      ['replied', 18, 300, 'sellers'],
    ])
    expect(s.find((n) => n.key === 'queued')?.state).toBe('stuck')
    expect(s.find((n) => n.key === 'sent')?.note).toBe('188 failed')
    expect(s.find((n) => n.key === 'eligible')?.note).toBe('60 held')
  })
  it('replies are pending while loading and unavailable (null) after — never 0', () => {
    expect(spineOf(mpls, null, true, NOW).find((n) => n.key === 'replied')).toMatchObject({ value: null, pending: true })
    expect(spineOf(mpls, cockpit({ responses: null }), false, NOW).find((n) => n.key === 'replied')).toMatchObject({ value: null, pending: false })
  })
})

describe('the other live shapes', () => {
  it('active with an empty audience needs you', () => {
    const tax = row({ id: 'tax', campaign_name: 'Tax Delinquent - Poor and Unsound', status: 'active', total_targets: 0, sent_count: 9, delivered_count: 9 })
    expect(execState(tax, null, NOW).key).toBe('needs_you')
    expect(attentionFor(tax, null, NOW)[0].key).toBe('no_audience')
    expect(navRow(tax, null, NOW).exception).toBe('No audience')
  })
  it('on hold + overdue + unplaceable: degraded first, all three said', () => {
    const eg = row({
      id: 'eg', campaign_name: 'Entity Graph · 186 properties', status: 'active', quarantined: true, quarantine_reason: 'target_integrity_violation',
      total_targets: 106, ready_targets: 37, held_targets: 35,
      live_queue: { live: 6, due: 6, overdue: 6, oldest_due_at: '2026-09-29T13:00:00.000Z', next_scheduled_at: null, release_reasons: {} },
      feeder_last: { at: '2026-09-30T12:25:00Z', inserted: 0, active_live_rows: 6, ready_remaining: 37, bound: 'buffer', reason: 'no_row_placed', stalled: false, ...({ skipped_counts_by_reason: { ROUTING_BLOCKED: 22, sender_blocked_by_operator: 14, TEMPLATE_RENDER_LINT_FAILURE: 1 } }) },
    })
    const a = attentionFor(eg, null, NOW)
    expect(a.map((x) => x.key)).toEqual(['overdue', 'hold', 'not_placed'])
    expect(a[2].detail).toMatch(/no sender for their market \(22\), the sender is blocked by an operator \(14\)/)
    expect(execState(eg, null, NOW).key).toBe('degraded')
  })
  it('a running campaign in its window is Running; outside it, Waiting for window', () => {
    const ok = row({ id: 'ok', status: 'active', total_targets: 100, ready_targets: 40, sent_count: 50, delivered_count: 48, live_queue: { live: 10, due: 1, overdue: 0, oldest_due_at: null, next_scheduled_at: '2026-09-30T12:30:00Z', release_reasons: {} } })
    const open = cockpit({ queue: { ...cockpit().queue!, live: 10, due: 1, overdue: 0, release_reasons: {} }, window: { ...cockpit().window, open: true, closes_at: '2026-09-31T02:00:00Z', next_open_at: null } })
    expect(execState(ok, open, NOW).key).toBe('running')
    expect(spineOf(ok, open, false, NOW).find((n) => n.key === 'sent')?.state).toBe('current')
    const closed = cockpit({ queue: { ...cockpit().queue!, live: 10, due: 0, overdue: 0, release_reasons: {} } })
    expect(execState(ok, closed, NOW).key).toBe('waiting')
  })
  it('a system-wide stop, and a silent feeder, are degraded — whatever the campaign does', () => {
    const ok = row({ id: 'ok', status: 'active', total_targets: 10, ready_targets: 10 })
    const off = cockpit({ queue: { ...cockpit().queue!, overdue: 0, live: 0 }, processor: { ...cockpit().processor, mode: 'safe' } })
    expect(attentionFor(ok, off, NOW)[0].key).toBe('processor_off')
    const silent = cockpit({ queue: { ...cockpit().queue!, overdue: 0, live: 0 }, feeder: { ...cockpit().feeder, heartbeat_at: '2026-09-30T11:00:00Z' } })
    expect(attentionFor(ok, silent, NOW).map((x) => x.key)).toContain('feeder_stale')
    expect(execState(ok, silent, NOW).key).toBe('degraded')
    // Ages are measured at the read: an old read of a healthy processor is not a silent one.
    const oldRead = cockpit({ at: '2026-09-30T12:28:00Z', queue: { ...cockpit().queue!, overdue: 0, live: 0 } })
    expect(attentionFor(ok, oldRead, NOW + 20 * 60 * 1000).map((x) => x.key)).not.toContain('processor_stale')
  })
  it('NOW facts read the runtime only; room left today is the feeder’s own arithmetic', () => {
    const facts = nowFacts(cockpit({ queue: { ...cockpit().queue!, overdue: 0 } }), NOW)
    expect(facts.map((f) => f.key)).toEqual(['queue', 'senders', 'window', 'last_sent', 'today', 'refill'])
    expect(facts.find((f) => f.key === 'today')).toMatchObject({ value: '590', sub: '0 sent today of 750' })
    expect(facts.find((f) => f.key === 'refill')?.value).toBe('None — 160 already queued (keeps 150 ahead)')
  })
})

describe('the rest of the book', () => {
  it('paused is the operator’s choice, not attention', () => {
    const miami = row({ id: 'm', campaign_name: 'Miami - Test Campaign', status: 'paused', total_targets: 802, ready_targets: 789, sent_count: 354, delivered_count: 351 })
    expect(execState(miami, null, NOW).key).toBe('paused')
    expect(navGroupOf(miami, null, NOW)).toBe('paused')
    expect(nextLine(miami, null, NOW)).toBe('Paused. Resuming continues with 789 ready sellers.')
  })
  it('a draft reads inactive; a built audience reads Ready', () => {
    const atl = row({ id: 'a', campaign_name: 'Map area · Atlanta, GA · 220 properties', status: 'draft', has_target_definition: true, lineage: { ...mplsLineage, explicit_property_count: 220, timezone: null } })
    expect(execState(atl, null, NOW).key).toBe('draft')
    const r = navRow(atl, null, NOW)
    expect(r.inactive).toBe(true)
    expect(r.result).toBe('Audience not built')
    expect(r.title).toBe('Map area · Atlanta, GA')
    const built = row({ id: 't', campaign_name: 'Test', status: 'built', total_targets: 854, held_targets: 350, ready_targets: 504 })
    expect(execState(built, null, NOW).key).toBe('ready')
    expect(nextLine(built, null, NOW)).toBe('Audience built — 504 eligible sellers. Schedule or launch it.')
  })
  it('a scheduled campaign that missed its start needs you', () => {
    const s = row({ id: 's', status: 'scheduled', schedule_missed_for: '2026-09-25T17:10:00Z', total_targets: 5 })
    expect(attentionFor(s, null, NOW)[0]).toMatchObject({ key: 'missed_start', actions: [{ id: 'reschedule', label: 'Reschedule' }] })
  })
  it('a source is what the row stored; an older audience is still an audience', () => {
    expect(sourceOf(mpls).label).toBe('Map area')
    expect(sourceOf(row({ total_targets: 802, lineage: { ...mplsLineage, kind: 'none', explicit_property_count: null } })).label).toBe('Built audience')
    expect(sourceOf(row({ lineage: undefined })).label).toBe('Source unavailable')
  })
  it('navigation filters: archived hidden by default; source, market and search match', () => {
    const arch = row({ id: 'x', status: 'archived' })
    expect(matchesNav(arch, DEFAULT_FILTERS, { group: 'archived', markets: [] })).toBe(false)
    expect(matchesNav(arch, { ...DEFAULT_FILTERS, status: 'archived' }, { group: 'archived', markets: [] })).toBe(true)
    const ctx = { group: 'needs_you' as const, markets: ['Minneapolis, MN'] }
    expect(matchesNav(mpls, { ...DEFAULT_FILTERS, source: 'entity_graph' }, ctx)).toBe(false)
    expect(matchesNav(mpls, { ...DEFAULT_FILTERS, market: 'Minneapolis, MN' }, ctx)).toBe(true)
    expect(matchesNav(mpls, { ...DEFAULT_FILTERS, query: '7f2ba659' }, ctx)).toBe(true)
    expect(matchesNav(mpls, { ...DEFAULT_FILTERS, query: 'minneapolis ownership' }, ctx)).toBe(true)
    expect(matchesNav(mpls, { ...DEFAULT_FILTERS, query: 'dallas' }, ctx)).toBe(false)
  })
  it('the header line counts what the navigation shows', () => {
    const groups = new Map([['a', 'needs_you'], ['b', 'active'], ['c', 'drafts']] as const)
    const s = bookSummary([
      row({ id: 'a', status: 'active', ready_targets: 16, remaining_targets: 16 }),
      row({ id: 'b', status: 'active', ready_targets: 4 }),
      row({ id: 'c', status: 'built', ready_targets: 504 }),
      row({ id: 'd', status: 'archived', ready_targets: 999 }),
    ], new Map(groups))
    expect(s).toEqual({ active: 2, attention: 1, remaining: 524 })
  })
  it('canonical codes are said in words', () => {
    expect(holdWords('entity_contact_requires_review')).toBe('Company owner — contact needs review')
    expect(holdWords('insufficient_template_rotation_pool:auto:0<2')).toBe('Too few approved messages to rotate')
    expect(holdWords('insufficient_template_rotation_pool:Vietnamese:0<2')).toBe('Too few approved Vietnamese messages')
    expect(releaseWords('logical_communication_store_error')).toBe('the send record couldn’t be written')
  })
})
