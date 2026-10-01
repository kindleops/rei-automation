import { describe, expect, it } from 'vitest'
import type { BookCampaign, CampaignIntel, WarSystem } from './war-room-api'
import {
  audienceSteps, bookLine, businessFunnel, capsTruth, counterDrift, feederBlock, gateOfReason, gatesOf, groupRail, missionOf,
  moneyLines, nameParts, nextOf, paceOf, pct, railRowOf, relative, riverOf, stoppingGate, systemPosture, windowTrack, zonesOpenNote,
} from './war-room-model'

/**
 * Fixtures are production's shapes, read-only, 2026-10-01 ~10:30Z (05:30 CDT,
 * the contact window closed): Minneapolis stalled at the template gate,
 * "75+ ACQ SCORE" past its 11:11 AM CT start, Entity Graph · 186 with no
 * sender for most of its markets, an active campaign with no audience.
 */
const NOW = Date.parse('2026-10-01T10:30:00.000Z')

const system: WarSystem = {
  processor: { mode: 'live', execution_mode: 'normal', auto_send: true, auto_enqueue: true, outbound_sms: true, emergency_stop_at: null, heartbeat_at: '2026-10-01T10:29:30.000Z', last_claimed_at: '2026-10-01T00:36:32.000Z' },
  feeder: { heartbeat_at: '2026-10-01T10:25:36.000Z', last_batch_at: '2026-10-01T00:20:43.000Z', cadence_minutes: 5 },
  per_number_cap: 800,
  blocked_sender_count: 8,
  blocked_template_count: 15,
}

const closedWindow = { open: false, reason: 'before_window', window: '08:00–21:00', closes_at: null, next_open_at: '2026-10-01T13:00:00.000Z', timezone: 'America/Chicago', source: 'campaign' as const, policy_version: 'v1' }
const feeder = (over: Partial<NonNullable<BookCampaign['feeder']>> = {}): NonNullable<BookCampaign['feeder']> => ({
  at: '2026-10-01T10:20:32.000Z', inserted: 0, bound: 'buffer', reason: 'no_row_placed', stalled: true, ready_remaining: 15, active_live_rows: 0,
  sent_today: 1, batch_limit: 15, spam_retries: 0, last_refill_at: '2026-09-30T16:05:18.000Z', skipped_counts_by_reason: { NO_TEMPLATE: 6, TEMPLATE_RENDER_LINT_FAILURE: 9 }, skip_summary: null, routing_blocks_by_market: {}, ...over,
})

const minneapolis: BookCampaign = {
  id: '7f2ba659-16ad-463b-851d-3381c81e2e38', name: 'Map area · Minneapolis, MN · 944 properties', status: 'active', archived: false, created_at: '2026-09-28T12:20:21Z', updated_at: null,
  source: { kind: 'map_area', explicit_count: 944, area_property_count: 944, filter_count: 0, market_values: [] },
  timezone: 'America/Chicago', window: closedWindow,
  schedule: { scheduled_for: '2026-09-29T13:00:00Z', missed_for: null, activated_at: '2026-09-28T14:35:33Z', paused_at: null, resumed_at: null, completed_at: null, last_transition_reason: null },
  caps: { daily_cap: 750, total_cap: 1000 },
  targets: { total: 563, ready: 15, planned: 488, held: 60, other: 0, held_by_reason: { entity_contact_requires_review: 49, missing_identity_linkage: 11 } },
  queue: { live: 0, due: 0, overdue: 0, next_at: null },
  sends: { sellers_dispatched: 479, sellers_delivered: 419, last_sent_at: '2026-09-30T19:26:29Z', sent_today: 0, truncated: false },
  replies: { sellers_replied: 33, sellers_asked_to_stop: 10, buckets: { interested: 0, not_interested: 4, wrong_number: 2, opt_out: 10, ambiguous: 12, other: 5 }, latest_reply_at: null, truncated: false },
  feeder: feeder(),
  quarantined: false,
}

const missed: BookCampaign = {
  ...minneapolis, id: '9799d345-06c7-46d8-9b4d-db8b8a4e2bdc', name: '75+ ACQ SCORE', status: 'scheduled',
  source: { kind: 'filters', explicit_count: null, filter_count: 1, market_values: [] },
  schedule: { scheduled_for: '2026-09-30T16:11:00Z', missed_for: '2026-09-30T16:11:00.000Z', activated_at: null, paused_at: null, resumed_at: null, completed_at: null, last_transition_reason: 'operator:schedule' },
  targets: { total: 146, ready: 84, planned: 0, held: 62, other: 0, held_by_reason: { entity_contact_requires_review: 62 } },
  sends: { sellers_dispatched: 0, sellers_delivered: 0, last_sent_at: null, sent_today: 0, truncated: false },
  replies: { sellers_replied: 0, sellers_asked_to_stop: 0, buckets: { interested: 0, not_interested: 0, wrong_number: 0, opt_out: 0, ambiguous: 0, other: 0 }, latest_reply_at: null, truncated: false },
  feeder: null,
}

const entityGraph: BookCampaign = {
  ...minneapolis, id: 'df0671fa-4bdf-41a8-bba0-bdd39b2f9bb9', name: 'Entity Graph · 186 properties',
  source: { kind: 'entity_graph', explicit_count: 186 },
  targets: { total: 106, ready: 37, planned: 34, held: 35, other: 0, held_by_reason: { entity_contact_requires_review: 35 } },
  feeder: feeder({ skipped_counts_by_reason: { ROUTING_BLOCKED: 22, sender_blocked_by_operator: 14, TEMPLATE_RENDER_LINT_FAILURE: 1 }, ready_remaining: 37 }),
}

const empty: BookCampaign = { ...minneapolis, id: 'dbcfe227', name: 'Tax Delinquent - Poor and Unsound', source: { kind: 'filters' }, targets: { total: 0, ready: 0, planned: 0, held: 0, other: 0, held_by_reason: {} }, feeder: feeder({ bound: 'cohort_exhausted', reason: 'cohort_exhausted', stalled: false, skipped_counts_by_reason: {} }) }

const healthy: BookCampaign = { ...minneapolis, id: 'h', feeder: feeder({ inserted: 100, skipped_counts_by_reason: {}, stalled: false }), queue: { live: 117, due: 3, overdue: 0, next_at: '2026-10-01T14:00:45.000Z' } }

describe('mission state — every campaign by its real operational state', () => {
  it('stopped at the template gate is attention, named, owned by the operator', () => {
    const m = missionOf({ book: minneapolis, system }, NOW)
    expect(m.group).toBe('attention')
    expect(m.label).toBe('Template unavailable')
    expect(m.gate).toBe('template')
    expect(m.owner).toBe('operator')
    expect(m.why).toContain('15 ready sellers')
  })
  it('a missed start never auto-fires: MISSED SCHEDULE until rescheduled or launched', () => {
    const m = missionOf({ book: missed, system }, NOW)
    expect(m.key).toBe('missed_schedule')
    expect(m.group).toBe('attention')
    expect(m.why).toContain('Yesterday 11:11 AM CDT')
  })
  it('routing blocks read as NO ELIGIBLE SENDER, never a generic failure', () => {
    expect(missionOf({ book: entityGraph, system }, NOW).label).toBe('No eligible sender')
  })
  it('an active campaign with no audience is not "completed"', () => {
    const m = missionOf({ book: empty, system }, NOW)
    expect(m.key).toBe('no_audience')
    expect(m.label).toBe('No executable audience')
  })
  it('a closed window is waiting, not attention and not failed', () => {
    const m = missionOf({ book: healthy, system }, NOW)
    expect(m.key).toBe('waiting_window')
    expect(m.group).toBe('waiting')
    expect(m.tone).toBe('neutral')
  })
  it('daily cap reached is healthy waiting for capacity, still live', () => {
    const m = missionOf({ book: { ...healthy, window: { ...closedWindow, open: true, closes_at: '2026-10-02T02:00:00Z', next_open_at: null }, feeder: feeder({ bound: 'daily_cap_reached', inserted: 0, skipped_counts_by_reason: {}, stalled: false }) }, system }, NOW)
    expect(m.key).toBe('waiting_capacity')
    expect(m.group).toBe('live')
    expect(m.live).toBe(true)
  })
  it('a silent runtime degrades every live campaign — the system owns it', () => {
    const stale = { ...system, processor: { ...system.processor, heartbeat_at: '2026-10-01T09:00:00Z' } }
    const m = missionOf({ book: healthy, system: stale }, NOW)
    expect(m.key).toBe('degraded')
    expect(m.owner).toBe('system')
    expect(systemPosture(stale, NOW).key).toBe('processor_stale')
  })
  it('drafts: built audience, not built, targeting required', () => {
    expect(missionOf({ book: { ...missed, status: 'built', schedule: { ...missed.schedule!, missed_for: null } } }, NOW).key).toBe('audience_built')
    expect(missionOf({ book: { ...empty, status: 'draft', source: { kind: 'none' } } }, NOW).key).toBe('targeting_required')
    expect(missionOf({ book: { ...empty, status: 'draft', source: { kind: 'map_area' } } }, NOW).key).toBe('draft')
  })
})

describe('rail', () => {
  it('rows carry progress against the executable cohort, never the original audience', () => {
    const row = railRowOf({ book: minneapolis, system }, NOW)
    expect(row.title).toBe('Minneapolis, MN')
    expect(row.eyebrow).toBe('Map area · 944')
    expect(row.progress).toEqual({ sent: 479, of: 503, pct: (479 / 503) * 100 })
    expect(row.replies).toBe(33)
    expect(row.cue).toBe('Template · 15 held')
  })
  it('groups in the brief’s order and summarises the book', () => {
    const rows = [minneapolis, missed, healthy, empty].map((b) => railRowOf({ book: b, system }, NOW))
    expect(groupRail(rows).map((g) => g.key)).toEqual(['attention', 'waiting'])
    expect(bookLine(rows).map((x) => x.text)).toEqual(['1 live', '3 need attention'])
    // before the book has loaded there is no '0 live' — the header says it is reading
    expect(bookLine([])).toEqual([])
  })
  it('names: generated names split into place + source; free names stay whole', () => {
    expect(nameParts('Entity Graph · 186 properties', 'entity_graph', 186)).toEqual({ title: 'Entity Graph · 186', eyebrow: 'Entity Graph · 186 selected' })
    expect(nameParts('75+ ACQ SCORE', 'filters', null)).toEqual({ title: '75+ ACQ SCORE', eyebrow: 'Filters' })
  })
})

describe('river — one connected system, sellers then opportunities', () => {
  it('Minneapolis: audience 563 → eligible 503 → planned 488; the queue is buffer telemetry; held at the template gate', () => {
    const { nodes, pin } = riverOf({ book: minneapolis, system }, NOW)
    const v = Object.fromEntries(nodes.map((n) => [n.key, n.value]))
    expect(v).toMatchObject({ audience: 563, eligible: 503, planned: 488, queued: 0, sent: 479, delivered: 419, replied: 33, opportunity: null })
    expect(nodes.find((n) => n.key === 'eligible')!.rate).toBe('89.3%')
    expect(nodes.find((n) => n.key === 'queued')!.buffer).toBe(true)
    expect(nodes.find((n) => n.key === 'queued')!.rate).toBeNull()
    expect(nodes.find((n) => n.key === 'audience')!.sub).toBe('944 selected')
    expect(pin).toMatchObject({ after: 'eligible', gate: 'template', state: 'blocked' })
  })
  it('missed start: AUDIENCE 146 → ELIGIBLE 84 → SCHEDULE GATE blocked → nothing planned', () => {
    const { nodes, pin, current } = riverOf({ book: missed, system }, NOW)
    expect(current).toBe('eligible')
    expect(pin).toMatchObject({ after: 'eligible', gate: 'schedule', state: 'blocked', detail: 'Missed start · 11:11 AM CDT' })
    expect(nodes.find((n) => n.key === 'planned')!.state).toBe('blocked')
    expect(nodes.find((n) => n.key === 'eligible')!.state).toBe('active')
  })
  it('a closed window holds the flow after the queue', () => {
    const { pin } = riverOf({ book: healthy, system }, NOW)
    expect(pin).toMatchObject({ after: 'queued', gate: 'window', state: 'waiting', detail: 'Opens 8:00 AM CDT' })
  })
})

describe('gates — where execution stops', () => {
  it('Minneapolis stops at TEMPLATE; holds are not stops', () => {
    const gates = gatesOf({ book: minneapolis, system }, NOW)
    const stop = stoppingGate(gates)
    expect(stop?.key).toBe('template')
    expect(stop?.value).toBe('15 can’t be placed')
    expect(gates.find((g) => g.key === 'identity')).toMatchObject({ state: 'hold', count: 60 })
    expect(gates.find((g) => g.key === 'window')!.state).toBe('wait')
  })
  it('75+ ACQ SCORE stops at SCHEDULE', () => {
    expect(stoppingGate(gatesOf({ book: missed, system }, NOW))?.key).toBe('schedule')
  })
  it('reasons map onto gates', () => {
    expect(gateOfReason('TEMPLATE_RENDER_LINT_FAILURE')).toBe('template')
    expect(gateOfReason('insufficient_template_rotation_pool:auto:0<2')).toBe('template')
    expect(gateOfReason('ROUTING_BLOCKED')).toBe('sender')
    expect(gateOfReason('sender_blocked_by_operator')).toBe('sender')
    expect(gateOfReason('per_sender_cap_reached')).toBe('capacity')
    expect(gateOfReason('prior_contacted_suppression')).toBe('suppression')
    expect(gateOfReason('entity_contact_requires_review')).toBe('identity')
    expect(gateOfReason('missing_to_phone_number')).toBe('eligibility')
    expect(feederBlock(feeder({ skipped_counts_by_reason: { per_sender_cap_reached: 40 } }))?.gate).toBe('capacity')
  })
})

describe('next, time, pace, caps', () => {
  it('next: the window opening, or the expected feeder pass from the real heartbeat', () => {
    expect(nextOf({ book: healthy, system }, NOW)).toMatchObject({ label: 'Contact window opens', when: 'Today 8:00 AM CDT', rel: 'in 2h 30m' })
    const open = { ...healthy, queue: { live: 0, due: 0, overdue: 0, next_at: null }, window: { ...closedWindow, open: true, closes_at: '2026-10-02T02:00:00Z', next_open_at: null } }
    const next = nextOf({ book: open, system }, NOW)
    expect(next.label).toBe('Queue refill')
    expect(next.expected).toBe(true)
    expect(next.when).toBe('next feeder pass ≈ 5:30 AM CDT')
    expect(nextOf({ book: missed, system }, NOW).when).toBe('Reschedule or launch now')
  })
  it('the window track is in the campaign’s zone', () => {
    const w = windowTrack(closedWindow, NOW, 'America/New_York')!
    expect(w.start).toBe(8)
    expect(w.end).toBe(21)
    expect(Math.round(w.now * 10) / 10).toBe(5.5)
    expect(w.label).toBe('8:00 AM–9:00 PM CDT')
    expect(w.operatorLabel).toBe('6:30 AM EDT your time')
  })
  it('a multi-zone window says how many recipient zones are open; single-zone label is unchanged (RC 7.1)', () => {
    const multi = { ...closedWindow, timezones: ['America/New_York', 'America/Chicago', 'America/Los_Angeles'], open_zones: ['America/Chicago'] }
    expect(zonesOpenNote(multi)).toBe(' · 1 of 3 zones open')
    expect(zonesOpenNote(closedWindow)).toBe('')
    expect(zonesOpenNote({ ...closedWindow, timezones: ['America/Chicago'], open_zones: [] })).toBe('')
    expect(windowTrack(multi, NOW, 'America/New_York')!.label).toBe('8:00 AM–9:00 PM CDT · 1 of 3 zones open')
  })
  it('caps are named by what they bound: refill size is a worker chunk, total cap is scope', () => {
    const intel = { caps: { daily_cap: 750, total_cap: 1000, market_cap: 400, batch_max: 50, per_sender_cap: null, system_per_number_cap: 800, send_interval_seconds: 45 }, feeder: { buffer_target: 150, chunk: 100 } } as unknown as CampaignIntel
    const caps = capsTruth({ book: minneapolis, intel })
    expect(caps.find((c) => c.key === 'total')).toMatchObject({ limiting: false, meaning: 'Above the 503 executable sellers — not limiting.' })
    expect(caps.find((c) => c.key === 'refill')).toMatchObject({ label: 'Queue refill size', scope: 'worker' })
    expect(caps.find((c) => c.key === 'batch')).toMatchObject({ label: 'Activation first chunk' })
    expect(caps.find((c) => c.key === 'sender')).toMatchObject({ label: 'System limit', value: '800 / sender / day' })
    expect(caps.find((c) => c.key === 'market')!.label).toBe('Market cap per planning pass')
  })
  it('pace: the tightest real limit sets the day; days are an estimate from it', () => {
    const intel = { caps: { daily_cap: 750, send_interval_seconds: 45 }, routing: [{ market: 'Minneapolis, MN', targets: 563, ready: 15, numbers: 3, eligible: 3, by_state: {}, remaining_today: 2400 }], feeder: { buffer_target: 150, chunk: 100 } } as unknown as CampaignIntel
    const p = paceOf({ book: { ...minneapolis, targets: { ...minneapolis.targets!, ready: 1500 } }, intel }, NOW)
    expect(p.daily).toBe(750)
    expect(p.basis).toBe('daily cap')
    expect(p.days).toBe(2)
    expect(p.dayIndex).toBe(4)
  })
})

describe('audience, outcomes, money', () => {
  it('waterfall: selected → resolved → eligible; held is its own step', () => {
    const steps = audienceSteps({ book: minneapolis })
    expect(steps.map((s) => [s.key, s.value])).toEqual([['selected', 944], ['resolved', 563], ['eligible', 503], ['held', 60], ['unplaced', 15], ['planned', 488]])
    expect(steps[1].detail).toBe('381 did not resolve to a messageable owner')
  })
  it('funnel stages a read does not carry stay null, never zero', () => {
    const f = businessFunnel({ book: minneapolis })
    expect(f.find((s) => s.key === 'opportunities')!.value).toBeNull()
    expect(f.find((s) => s.key === 'interested')!.value).toBe(0)
  })
  it('money keeps modeled, estimated and actual apart', () => {
    const intel = { outcomes: { opportunities: [{ recommended_offer: 168600 }, { recommended_offer: 150400 }, { recommended_offer: null }], offers: [], closings: [], stage_moves: 2, opportunities_moved: 2, basis: 'replied_sellers' } } as unknown as CampaignIntel
    const m = moneyLines(intel)
    expect(m.find((x) => x.key === 'recommended')).toMatchObject({ value: '$319K', n: 2, basis: 'modeled' })
    expect(m.find((x) => x.key === 'closed')).toMatchObject({ value: '—', n: 0, basis: 'actual' })
  })
  it('helpers', () => {
    expect(pct(479, 503)).toBe('95.2%')
    expect(pct(0, 5)).toBe('0%')
    expect(pct(3, 0)).toBeNull()
    expect(relative('2026-10-01T10:30:38.000Z', NOW)).toBe('in 38s')
    expect(relative('2026-10-01T10:26:00.000Z', NOW)).toBe('4 min ago')
    expect(counterDrift({ router_counter: 281, sent_today: 0 } as never)).toBe(true)
  })
})
