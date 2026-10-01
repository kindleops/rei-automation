import { describe, expect, it } from 'vitest'
import type { DeskCampaign, DeskEvent, DeskTimeline } from '../../../domain/calendar/calendar-timeline-api'
import {
  NO_FILTERS, aggregatesFrom, applyFilters, attentionGroups, axisTicks, bandDensity, briefModel, eventLabel, fitDomain, laneLayout, loadSeries,
  monthModel, parseDateCommand, rangeFor, scrubberModel, searchEvents, statusOf, timeText, toneOf, waitingOn, weekModel, zoomDomain,
} from './temporal-model'
import { HOUR, MIN, clock, dayBounds, hourTicks, hourAt, zonedInstant } from './temporal-time'

const CT = 'America/Chicago'
const ET = 'America/New_York'
const NOW = Date.parse('2026-10-01T12:10:00Z') // 7:10 AM CDT
const iso = (ms: number) => new Date(ms).toISOString()
let n = 0
const ev = (over: Partial<DeskEvent>): DeskEvent => ({
  id: `e${++n}`, type: 'seller_follow_up', source: 'send_queue', app: 'inbox', title: 'Seller follow-up', subtitle: null, place: null,
  start: iso(NOW + 2 * HOUR), end: null, all_day: false, time_kind: 'scheduled', tz: null, actor: 'system', status: 'upcoming', priority: 'normal',
  overdue: false, attention: false, reason: null, count: 1, links: {}, detail: {}, owner: 'system', state: 'upcoming', history: false, lane: 'automation',
  kind: 'capsule', attention_state: 'none', attention_category: null, subject: null, editable: { mode: 'read_only', owner_app: 'inbox', how: '', effects: [] },
  provenance: { scheduled_by: '', basis: null, timezone: null, timezone_basis: '' }, why: null, next: null, deep_link: null, market: null, actions: null, ...over,
})
const win = (over: Partial<DeskEvent> = {}) => ev({
  type: 'campaign_window', app: 'campaigns', source: 'campaigns.contact_window', title: 'Send window', subtitle: 'Map area · Minneapolis, MN',
  start: '2026-10-01T13:00:00.000Z', end: '2026-10-02T02:00:00.000Z', tz: CT, kind: 'window', lane: 'campaign', links: { campaign_id: 'c-1' }, source_id: 'c-1:2026-10-01', ...over,
})

describe('time — Intl zone math, DST-correct', () => {
  it('a local day is 23 or 25 hours across a DST change, never a fixed 24', () => {
    const fall = dayBounds('2026-11-01', CT)
    expect((fall.end - fall.start) / HOUR).toBe(25)
    const spring = dayBounds('2026-03-08', CT)
    expect((spring.end - spring.start) / HOUR).toBe(23)
    expect(zonedInstant('2026-10-01', '08:00', CT)).toBe(Date.parse('2026-10-01T13:00:00Z'))
    expect(zonedInstant('2026-10-01', '08:00', ET)).toBe(Date.parse('2026-10-01T12:00:00Z'))
    expect(zonedInstant('2026-12-01', '08:00', CT)).toBe(Date.parse('2026-12-01T14:00:00Z'))
  })
  it('hour ticks read from the zone: fall-back shows 1 AM twice', () => {
    const b = dayBounds('2026-11-01', CT)
    const labels = hourTicks(b.start, b.start + 4 * HOUR, CT).map((t) => hourAt(t, CT))
    expect(labels.filter((l) => l === '1 AM')).toHaveLength(2)
  })
})

describe('the axis — fit, zoom, ticks', () => {
  it('fits the working day the events occupy and always includes NOW (§123)', () => {
    const d = fitDomain([win()], { day: '2026-10-01', tz: CT, now: NOW })
    expect(clock(d.from, CT)).toBe('6:00 AM') // NOW 7:10 − 1 h, floored
    expect(clock(d.to, CT)).toBe('10:00 PM') // window end 9 PM + 1 h
  })
  it('an empty day falls back to the contact window and never shrinks below the minimum span', () => {
    const d = fitDomain([], { day: '2026-10-05', tz: CT, now: NOW })
    expect(clock(d.from, CT)).toBe('8:00 AM')
    expect(clock(d.to, CT)).toBe('9:00 PM')
    const one = fitDomain([ev({ start: '2026-10-05T19:00:00.000Z' })], { day: '2026-10-05', tz: CT, now: NOW, minHours: 8 })
    expect((one.to - one.from) / HOUR).toBeGreaterThanOrEqual(8)
  })
  it('6h zoom centres on NOW and stays inside the day', () => {
    const fit = fitDomain([win()], { day: '2026-10-01', tz: CT, now: NOW })
    const z = zoomDomain('6h', { fit, day: '2026-10-01', tz: CT, now: NOW })
    expect((z.to - z.from) / HOUR).toBe(6)
    expect(z.from).toBeLessThanOrEqual(NOW)
    expect(z.to).toBeGreaterThan(NOW)
    const full = zoomDomain('24h', { fit, day: '2026-11-01', tz: CT, now: NOW })
    expect((full.to - full.from) / HOUR).toBe(25)
  })
  it('thins labels to the width but keeps every hour tick', () => {
    const d = { from: zonedInstant('2026-10-01', '06:00', CT), to: zonedInstant('2026-10-01', '22:00', CT) }
    const wide = axisTicks(d, CT, 1600)
    const narrow = axisTicks(d, CT, 420)
    expect(wide).toHaveLength(17)
    expect(narrow).toHaveLength(17)
    expect(narrow.filter((t) => t.label).length).toBeLessThan(wide.filter((t) => t.label).length)
  })
})

describe('lanes — bands, rides, clusters (§9, §72)', () => {
  const domain = { from: zonedInstant('2026-10-01', '06:00', CT), to: zonedInstant('2026-10-01', '22:00', CT) }
  it('overlapping windows stack in rows; a campaign day rides inside its own window', () => {
    const sends = ev({ id: 'g', type: 'campaign_sends', app: 'campaigns', links: { campaign_id: 'c-1' }, source_id: 'c-1:2026-10-01', start: '2026-10-01T13:05:00.000Z', end: '2026-10-01T16:00:00.000Z' })
    const lanes = laneLayout([win({ id: 'w1' }), win({ id: 'w2', links: { campaign_id: 'c-2' }, source_id: 'c-2:2026-10-01' }), sends], { domain, widthPx: 1000 })
    const c = lanes.find((l) => l.key === 'campaigns')!
    expect(c.rows).toBe(2)
    expect(c.bands.find((b) => b.e.id === 'w1')!.sends?.id).toBe('g')
    expect(c.marks).toHaveLength(0) // the ride is not drawn twice
  })
  it('marks that would collide become ONE cluster; isolated marks keep their label', () => {
    const t = zonedInstant('2026-10-01', '14:20', CT)
    const lanes = laneLayout([
      ev({ id: 'a', start: iso(t) }), ev({ id: 'b', start: iso(t + MIN) }), ev({ id: 'c', start: iso(t + 2 * MIN) }),
      ev({ id: 'd', start: iso(zonedInstant('2026-10-01', '09:00', CT)) }),
    ], { domain, widthPx: 1000 })
    const s = lanes.find((l) => l.key === 'sellers')!
    expect(s.clusters).toHaveLength(1)
    expect(s.clusters[0].members.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(s.marks.map((m) => m.e.id)).toEqual(['d'])
    expect(s.marks[0].label).toBe(true)
  })
  it('only lanes with activity appear', () => {
    expect(laneLayout([win()], { domain, widthPx: 1000 }).map((l) => l.key)).toEqual(['campaigns'])
  })
  it('send density comes from the queue slots, placed on the operator axis', () => {
    const sends = ev({ type: 'campaign_sends', detail: { slot_minutes: 30, slots: [[16, 10, 0, 1], [18, 0, 25, 0]] } })
    const d = bandDensity(sends, { domain, tz: CT, day: '2026-10-01' })
    expect(d.bars).toHaveLength(2)
    expect(d.max).toBe(25)
    expect(d.bars[0].left).toBeCloseTo(((zonedInstant('2026-10-01', '08:00', CT) - domain.from) / (domain.to - domain.from)) * 100, 5)
  })
})

describe('operations load (§66–68)', () => {
  const domain = { from: zonedInstant('2026-10-01', '06:00', CT), to: zonedInstant('2026-10-01', '22:00', CT) }
  it('campaign texts land in their real slots; cancelled never counts; windows are coverage, not load', () => {
    const s = loadSeries([
      win(),
      ev({ type: 'campaign_sends', app: 'campaigns', start: '2026-10-01T13:05:00.000Z', detail: { slot_minutes: 30, slots: [[16, 12, 3, 0]] } }),
      ev({ start: iso(zonedInstant('2026-10-01', '14:10', CT)) }),
      ev({ start: iso(zonedInstant('2026-10-01', '14:20', CT)), state: 'cancelled', history: true }),
    ], { domain, tz: CT, binMinutes: 30 })
    expect(s.max).toBe(15)
    expect(s.peak?.values.campaigns).toBe(15)
    expect(s.bins.reduce((a, b) => a + b.values.sellers, 0)).toBe(1)
    expect(s.coverage).toHaveLength(1)
  })
})

describe('vocabulary — status, tone, time, ownership', () => {
  it('a missed campaign start is MISSED (gold), never running; a blocked send is FAILED (red)', () => {
    const missed = ev({ type: 'campaign_start', status: 'missed', state: 'overdue', attention: true, actor: 'blocked' })
    expect(statusOf(missed)).toBe('missed')
    expect(toneOf(missed)).toBe('attn')
    const blocked = ev({ type: 'scheduled_message', status: 'blocked', state: 'overdue', actor: 'blocked', attention: true })
    expect(statusOf(blocked)).toBe('failed')
    expect(toneOf(blocked)).toBe('crit')
    expect(statusOf(win({ state: 'live', status: 'open' }))).toBe('running')
    expect(toneOf(ev({ state: 'waiting', owner: 'title' }))).toBe('neutral')
  })
  it('a campaign window reads in its market zone, with the operator clock when it differs (§82)', () => {
    const t = timeText(win({ tz: ET, start: '2026-10-01T12:00:00.000Z', end: '2026-10-02T01:00:00.000Z' }), CT)
    expect(t.main).toBe('8:00 AM–9:00 PM ET')
    expect(t.alt).toBe('7:00 AM–8:00 PM CT')
    expect(timeText(win(), CT).alt).toBeNull()
    expect(timeText(ev({ all_day: true, date: '2026-10-03', time_kind: 'due' }), CT).main).toBe('Due · date only')
  })
  it('names what an event waits on — a clock, a party, you, or the system', () => {
    expect(waitingOn(ev({ type: 'workflow_timer', start: '2026-10-01T16:45:00.000Z' }), CT)).toBe('Waiting until 11:45 AM')
    expect(waitingOn(ev({ owner: 'title' }), CT)).toBe('Waiting on title')
    expect(waitingOn(ev({ owner: 'you' }), CT)).toBe('Waiting on you')
    expect(waitingOn(ev({}), CT)).toBe('System handling')
  })
  it('the screen-reader label carries title, time, status, owner, source and attention (§161)', () => {
    const l = eventLabel(ev({ subtitle: 'Dana Whitfield', attention: true, state: 'overdue' }), CT)
    expect(l).toContain('Seller follow-up')
    expect(l).toContain('Dana Whitfield')
    expect(l).toContain('Overdue')
    expect(l).toContain('owner System')
    expect(l).toContain('from Inbox')
    expect(l).toContain('needs attention')
  })
})

describe('filters (§53–58) — System + Campaign + Today returns the exact cohort', () => {
  const list = [
    win({ id: 'w' }),
    ev({ id: 'f', owner: 'system', market: 'Minneapolis, MN' }),
    ev({ id: 'y', owner: 'you', state: 'needs_you', market: 'Dallas, TX' }),
    ev({ id: 't', owner: 'title', type: 'closing_milestone', app: 'closing', state: 'waiting' }),
    ev({ id: 'h', state: 'completed', history: true, actor: 'completed' }),
  ]
  it('owner, source, status, market and history compose', () => {
    expect(applyFilters(list, { ...NO_FILTERS, owner: 'system', sources: ['campaigns'] }).map((e) => e.id)).toEqual(['w'])
    expect(applyFilters(list, { ...NO_FILTERS, owner: 'you' }).map((e) => e.id)).toEqual(['y'])
    expect(applyFilters(list, { ...NO_FILTERS, owner: 'external' }).map((e) => e.id)).toEqual(['t'])
    expect(applyFilters(list, { ...NO_FILTERS, markets: ['Dallas, TX'] }).map((e) => e.id)).toEqual(['y'])
    expect(applyFilters(list, { ...NO_FILTERS, history: false }).map((e) => e.id)).not.toContain('h')
    expect(applyFilters(list, { ...NO_FILTERS, statuses: ['completed'] }).map((e) => e.id)).toEqual(['h'])
  })
})

describe('date commands (§52) — deterministic phrases only', () => {
  const today = '2026-10-01' // a Thursday
  it.each([
    ['today', '2026-10-01', 'today'], ['tomorrow', '2026-10-02', 'today'], ['yesterday', '2026-09-30', 'today'],
    ['this week', '2026-10-01', 'week'], ['next week', '2026-10-08', 'week'], ['next month', '2026-11-01', 'month'], ['last month', '2026-09-01', 'month'],
    ['fri', '2026-10-02', 'today'], ['thursday', '2026-10-01', 'today'], ['mon', '2026-10-05', 'today'],
    ['Oct 15', '2026-10-15', 'today'], ['october 15', '2026-10-15', 'today'], ['15 oct', '2026-10-15', 'today'],
    ['10/15', '2026-10-15', 'today'], ['10/15/2027', '2027-10-15', 'today'], ['2026-12-24', '2026-12-24', 'today'],
  ])('%s → %s', (q, day, mode) => {
    const c = parseDateCommand(q, { today })
    expect(c?.day).toBe(day)
    expect(c?.mode).toBe(mode)
  })
  it('anything else is not a date — no pretend parsing', () => {
    for (const q of ['13/45', 'feb 30', 'wendy', 'next tuesday afternoon', 'oc 15', '']) expect(parseDateCommand(q, { today })).toBeNull()
  })
})

describe('search (§51)', () => {
  it('matches seller, address, campaign, workflow and market — every word', () => {
    const list = [
      ev({ id: 's', subtitle: 'Wendy B Stuhr', place: '3831 Sheridan Ave N, Minneapolis, MN' }),
      win({ id: 'c' }),
      ev({ id: 'w', type: 'workflow_timer', app: 'workflow', title: 'Seller review escalation', detail: { workflow_name: 'Seller review escalation' } }),
    ]
    expect(searchEvents(list, 'wendy').map((e) => e.id)).toEqual(['s'])
    expect(searchEvents(list, 'sheridan minneapolis').map((e) => e.id)).toEqual(['s'])
    expect(searchEvents(list, 'minneapolis window').map((e) => e.id)).toEqual(['c'])
    expect(searchEvents(list, 'escalation').map((e) => e.id)).toEqual(['w'])
    expect(searchEvents(list, '  ')).toEqual([])
  })
})

const timeline = (over: Partial<DeskTimeline> = {}): DeskTimeline => ({
  contract: 'calendar.desk/v5',
  range: { from: '2026-09-21', to: '2026-10-25', tz: CT, today: '2026-10-01', now: iso(NOW), lookback_from: '2026-09-07' },
  events: [], attention: [], today: { total: 0, operator: 0, system: 0, external: 0, blocked: 0, completed: 0, attention: 0, overdue: 0, scheduled_messages: 0, closings: 0, campaigns: 0 },
  next_event: null, source_status: {}, property_scope: null,
  system: { processor: 'live', execution_mode: 'normal', emergency_stop: false, email_sending: false, workflow_orchestrator: true, workflow_heartbeat_at: null, contact_window: { start: '08:00', end: '21:00' } },
  days: {}, board: { overdue: [], due_today: [], tomorrow: [], missing_date: [], blocking_closing: [], stale_follow_up: [], missed_campaign_schedule: [], waiting_too_long: [] },
  definitions: {} as DeskTimeline['definitions'],
  telemetry: { today: { total: 0, system: 0, you: 0, external: 0, ids: [] }, needs_you: { total: 0 }, attention: { total: 0, overdue: 0 }, live: [], next: null, next_system: null, next_you: null, basis: {} },
  campaigns: [], ...over,
})
const camp = (over: Partial<DeskCampaign>): DeskCampaign => ({
  id: 'c-1', name: 'Map area · Minneapolis, MN', status: 'active', market: null, tz: CT, window: '08:00–21:00', window_today: { opens_at: '2026-10-01T13:00:00.000Z', closes_at: '2026-10-02T02:00:00.000Z' },
  scheduled_for: null, situation: 'window_ahead', halted: null, window_event_id: 'campaign:c-1:window:2026-10-01',
  counts: { audience: 563, eligible: 503, held: 60, committed: 488, sent: 438, remaining: 15, queued: 0 }, feeder: null,
  deep_link: { app: 'campaigns', label: 'Open in Campaign Command', path: '/campaign-command?campaign=c-1' }, ...over,
})

describe('the temporal brief (§60–65) — deterministic lines only', () => {
  it('production 2026-10-01 07:10 CT: three windows open at 8 AM, nothing queued, one missed start, nothing on you', () => {
    const missed = ev({ id: 'm', type: 'campaign_start', status: 'missed', state: 'overdue', attention: true, start: '2026-09-30T16:11:00.000Z' })
    const data = timeline({
      events: [win({ id: 'w1' }), win({ id: 'w2' }), win({ id: 'w3' })],
      attention: [missed],
      campaigns: [camp({ id: 'a' }), camp({ id: 'b' }), camp({ id: 'c' }), camp({ id: 'd', situation: 'exhausted', window_today: null, counts: { audience: 0, eligible: 0, held: 0, committed: 0, sent: 9, remaining: 0, queued: 0 } }), camp({ id: 'm', situation: 'missed', window_today: null })],
    })
    const b = briefModel(data, data.events, { now: NOW, tz: CT, day: '2026-10-01' })
    expect(b.rightNow.map((l) => l.text)).toEqual(['3 campaign windows open at 8:00 AM', 'No campaign texts queued', 'No operator action required'])
    // the missed start is its own line — never counted twice
    expect(b.forecast.map((l) => l.key)).toEqual(['missed', 'exhausted'])
    expect(b.posture).toBe('attention')
    expect(b.headline).toBe('1 item needs attention')
    expect(b.next.map((e) => e.id)).toEqual(['w1', 'w2', 'w3'])
    expect(b.endOfDay[0].text).toBe('45 campaign targets ready to send')
  })
  it('an overdue item of yours from before the loaded range still reads as waiting on you', () => {
    const review = ev({ id: 'r', owner: 'you', state: 'overdue', attention: true, start: '2026-09-10T11:59:17.221Z', title: 'Review seller' })
    const data = timeline({ events: [win()], attention: [review], campaigns: [camp({})] })
    const b = briefModel(data, data.events, { now: NOW, tz: CT, day: '2026-10-01' })
    expect(b.rightNow.find((l) => l.key === 'you')?.text).toBe('1 item waiting on you')
    expect(b.forecast.find((l) => l.key === 'overdue')?.text).toBe('1 item overdue')
    expect(b.headline).toBe('1 item needs attention')
  })
  it('a system-only day reads "LeadCommand is handling today"; an empty one is a clear day (§148–149)', () => {
    const sys = timeline({ events: [win()], campaigns: [camp({})] })
    expect(briefModel(sys, sys.events, { now: NOW, tz: CT, day: '2026-10-01' }).headline).toBe('LeadCommand is handling today')
    const empty = timeline()
    expect(briefModel(empty, [], { now: NOW, tz: CT, day: '2026-10-01' }).headline).toBe('Clear day')
  })
})

describe('attention (§35, §113) — grouped by time, every item with a reason', () => {
  it('overdue first (most late first), then later today, next 24 h, this week, undated', () => {
    const data = timeline({
      attention: [
        ev({ id: 'old', state: 'overdue', owner: 'you', attention: true, start: '2026-09-10T11:59:17.221Z', reason: 'Waiting on you — this review is past due', attention_category: 'overdue' }),
        ev({ id: 'recent', state: 'overdue', attention: true, start: iso(NOW - 2 * HOUR), reason: 'Automation has not acted', attention_category: 'stale_follow_up' }),
        ev({ id: 'nodate', type: 'closing_missing_date', undated: true, attention: true, start: '', reason: 'Stage is Prepared to Close with no date on record.', attention_category: 'missing_date' }),
      ],
      events: [ev({ id: 'later', owner: 'you', state: 'needs_you', start: iso(NOW + 3 * HOUR) })],
      board: { overdue: [], due_today: ['later'], tomorrow: [], missing_date: [], blocking_closing: [], stale_follow_up: [], missed_campaign_schedule: [], waiting_too_long: [] },
    })
    const g = attentionGroups(data, { now: NOW, tz: CT })
    expect(g.map((x) => x.key)).toEqual(['overdue', 'today', 'undated'])
    expect(g[0].items.map((i) => i.e.id)).toEqual(['old', 'recent'])
    expect(g[0].items[0].when).toBe('Overdue 21d')
    expect(g[0].items[1].kind).toBe('Follow-up not acted on')
    expect(g[1].items[0].when).toBe('Due 10:10 AM')
    expect(g[2].items[0].why).toMatch(/no date on record/)
  })
})

describe('week, month, scrubber', () => {
  it('week: per-day composition, real hour density, plain summaries', () => {
    const w = weekModel([
      win(),
      ev({ type: 'campaign_sends', app: 'campaigns', start: '2026-10-01T13:05:00.000Z', detail: { slot_minutes: 30, slots: [[16, 12, 3, 0]] } }),
      ev({ start: '2026-10-02T14:00:00.000Z' }),
    ], { from: '2026-09-27', tz: CT })
    const thu = w.days.find((d) => d.day === '2026-10-01')!
    expect(thu.texts).toBe(15)
    expect(thu.hours[8]).toBe(15)
    expect(thu.windows).toHaveLength(1)
    expect(thu.summary).toBe('campaigns')
    expect(w.days.find((d) => d.day === '2026-10-02')!.summary).toBe('follow-ups')
    expect(w.days.find((d) => d.day === '2026-09-27')!.summary).toBe('Clear')
  })
  it('month: the chosen metric per cell on a square-root scale, with quiet marks', () => {
    const days = aggregatesFrom([win(), ev({ start: '2026-10-02T14:00:00.000Z' }), ev({ start: '2026-10-02T15:00:00.000Z' })], { from: '2026-09-27', to: '2026-11-07', tz: CT })
    const m = monthModel('2026-10-15', days, 'follow_ups')
    const c = m.cells.find((x) => x.day === '2026-10-02')!
    expect(c.value).toBe(2)
    expect(c.intensity).toBe(1)
    expect(m.cells.find((x) => x.day === '2026-10-01')!.marks.campaign).toBe(true)
    expect(m.cells).toHaveLength(42)
  })
  it('scrubber: density normalised to the busiest day; ranges stay bounded', () => {
    const s = scrubberModel({ '2026-10-01': { total: 4, completed: 0, campaign: 3, windows: 3, closing: 0, attention: 0, automation: 3, manual: 0, workflow: 0, external: 0, sends: 0 }, '2026-10-02': { total: 2, completed: 0, campaign: 0, windows: 0, closing: 0, attention: 1, automation: 1, manual: 0, workflow: 0, external: 0, sends: 0 } }, { from: '2026-10-01', to: '2026-10-03' })
    expect(s.map((d) => d.load)).toEqual([1, 0.5, 0])
    expect(s[1].marks.attention).toBe(true)
    expect(s[2].known).toBe(false)
    const r = rangeFor('today', '2026-10-01')
    expect(r).toEqual({ from: '2026-09-20', to: '2026-10-24' })
    expect(rangeFor('month', '2026-10-15')).toEqual({ from: '2026-09-27', to: '2026-11-07' })
  })
})
