/**
 * CALENDAR 3.0 desk model — arrangement only. Run:
 *   npx tsx --test src/views/calendar/desktop/desk-model.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { DeskEvent } from '../../../domain/calendar/calendar-timeline-api'
import {
  aggLine, attentionSections, densityRail, eventDay, groupSlots, isGroup, monthCells, nowWindow, timeText, todayModel, weekGrid, zoneFor,
} from './desk-model'

const CT = 'America/Chicago'
const NOW = Date.parse('2026-09-30T14:20:00Z') // 9:20 AM CDT
let n = 0
const ev = (over: Partial<DeskEvent>): DeskEvent => ({
  id: `e${++n}`, type: 'seller_follow_up', source: 'send_queue', app: 'inbox', title: 'Seller follow-up', subtitle: null, place: null,
  start: '2026-09-30T15:00:00.000Z', end: null, all_day: false, time_kind: 'scheduled', tz: null, actor: 'system', status: 'upcoming', priority: 'normal',
  overdue: false, attention: false, reason: null, count: 1, links: {}, detail: {}, owner: 'system', state: 'upcoming', history: false, lane: 'automation',
  kind: 'capsule', attention_state: 'none', attention_category: null, subject: null, editable: { mode: 'read_only', owner_app: 'inbox', how: '', effects: [] },
  provenance: { scheduled_by: '', basis: null, timezone: null, timezone_basis: '' }, why: null, next: null, deep_link: null, ...over,
} as DeskEvent)

test('37 follow-ups in one slot read as ONE group that keeps every seller', () => {
  const list = Array.from({ length: 37 }, (_, i) => ev({ start: new Date(Date.parse('2026-10-01T13:00:00Z') + (i % 6) * 120_000).toISOString() }))
  const out = groupSlots(list, CT)
  assert.equal(out.length, 1)
  assert.ok(isGroup(out[0]))
  if (isGroup(out[0])) { assert.equal(out[0].count, 37); assert.equal(out[0].members.length, 37); assert.equal(out[0].title, '37 seller follow-ups') }
  assert.equal(groupSlots(list.slice(0, 2), CT).length, 2, 'two stay individual')
})

test('a group never mixes states: completed history stays apart from what is upcoming', () => {
  const a = Array.from({ length: 3 }, () => ev({ start: '2026-10-01T13:00:00.000Z' }))
  const b = Array.from({ length: 3 }, () => ev({ start: '2026-10-01T13:05:00.000Z', state: 'completed', history: true }))
  assert.equal(groupSlots([...a, ...b], CT).length, 2)
})

test('today: live windows, next three, later, earlier and history are separate', () => {
  const win = ev({ type: 'campaign_window', kind: 'window', lane: 'campaign', state: 'live', start: '2026-09-30T13:00:00.000Z', end: '2026-10-01T02:00:00.000Z', tz: CT })
  const past = ev({ start: '2026-09-30T13:30:00.000Z' })
  const done = ev({ start: '2026-09-30T13:31:00.000Z', state: 'completed', history: true })
  const f = [1, 2, 3, 4, 5].map((h) => ev({ start: new Date(NOW + h * 3_600_000).toISOString() }))
  const yours = ev({ owner: 'you', state: 'needs_you', start: '2026-09-30T19:00:00.000Z', lane: 'manual' })
  const m = todayModel([win, past, done, ...f, yours], { day: '2026-09-30', now: NOW, tz: CT })
  assert.deepEqual(m.windows.map((e) => e.id), [win.id])
  assert.equal(m.live.length, 1)
  assert.equal(m.next.length, 3)
  assert.equal(m.later.length, 3, 'two follow-ups and yours')
  assert.deepEqual(m.earlier.map((e) => e.id), [past.id])
  assert.deepEqual(m.history.map((e) => e.id), [done.id])
  assert.deepEqual(m.needsYou.map((e) => e.id), [yours.id])
})

test('week grid: items at their clock, clustered into stacks, windows as spans', () => {
  const days = ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']
  const win = ev({ type: 'campaign_window', kind: 'window', lane: 'campaign', start: '2026-09-30T13:00:00.000Z', end: '2026-10-01T02:00:00.000Z', tz: CT })
  const a = ev({ start: '2026-09-30T15:00:00.000Z' }) // 10:00
  const b = ev({ start: '2026-09-30T15:20:00.000Z' }) // 10:20 → same stack
  const c = ev({ start: '2026-09-30T19:00:00.000Z' }) // 2 PM
  const cells = weekGrid([win, a, b, c], days, CT, { startHour: 6, endHour: 23 })
  const wed = cells[3]
  assert.equal(wed.spans.length, 1)
  assert.equal(Math.round(wed.spans[0].top), Math.round(((8 - 6) / 17) * 100))
  assert.equal(wed.stacks.length, 2)
  assert.equal(wed.stacks[0].items.length, 2)
  assert.equal(Math.round(wed.stacks[0].top), Math.round(((10 - 6) / 17) * 100))
})

test('month: 42 cells from the server aggregates; spec line only names what is non-zero, in order', () => {
  const cells = monthCells('2026-09-15', { '2026-09-30': { total: 9, campaign: 3, windows: 3, closing: 1, attention: 2, automation: 4, manual: 1, workflow: 0, external: 0, completed: 1, sends: 56 } })
  assert.equal(cells.length, 42)
  assert.equal(cells[0].day, '2026-08-30')
  const d = cells.find((c) => c.day === '2026-09-30')!
  assert.deepEqual(aggLine(d.agg), ['3 windows', '1 closing', '2 attention', '1 yours', '4 automated'])
  assert.deepEqual(aggLine(null), [])
})

test('density rail: per-channel max normalisation; unloaded days say so', () => {
  const r = densityRail({ '2026-09-30': { total: 4, campaign: 2, windows: 2, closing: 0, attention: 1, automation: 2, manual: 0, workflow: 0, external: 0, completed: 0, sends: 0 }, '2026-10-01': { total: 2, campaign: 1, windows: 1, closing: 0, attention: 0, automation: 1, manual: 0, workflow: 0, external: 0, completed: 0, sends: 0 } }, '2026-09-30', '2026-10-02')
  assert.equal(r.length, 3)
  assert.equal(r[0].ch.campaign, 1)
  assert.equal(r[1].ch.campaign, 0.5)
  assert.equal(r[2].known, false)
})

test('timezone: OPERATOR reads your zone; EVENT-LOCAL reads the zone the time is defined in', () => {
  const win = ev({ type: 'campaign_window', start: '2026-09-30T12:00:00.000Z', end: '2026-10-01T01:00:00.000Z', tz: 'America/New_York' })
  assert.equal(zoneFor(win, 'operator', CT), CT)
  assert.equal(zoneFor(win, 'event', CT), 'America/New_York')
  assert.deepEqual(timeText(win, 'event', CT), { main: '8:00 AM–9:00 PM ET', alt: '7:00 AM–8:00 PM CT' })
  assert.deepEqual(timeText(win, 'operator', CT), { main: '7:00 AM–8:00 PM CT', alt: '8:00 AM–9:00 PM ET' })
  const allDay = ev({ all_day: true, date: '2026-10-05', start: '2026-10-05T00:00:00.000Z', time_kind: 'due' })
  assert.equal(eventDay(allDay, 'Pacific/Honolulu'), '2026-10-05', 'a date is never shifted by a zone')
  assert.equal(timeText(allDay, 'operator', CT).main, 'Due · all day')
})

test('now: past 2 h → now → next 6 h, laned; the playhead sits at 25%', () => {
  const w = nowWindow([ev({ start: new Date(NOW + 3_600_000).toISOString() }), ev({ start: new Date(NOW + 9 * 3_600_000).toISOString() })], NOW)
  assert.equal(Math.round(w.nowPct), 25)
  assert.equal(w.lanes.find((l) => l.key === 'automation')!.items.length, 1)
})

test('attention: sections follow the canonical order and only list board ids', () => {
  const a = ev({ id: 'a', attention: true, attention_category: 'stale_follow_up' })
  const s = attentionSections({ board: { overdue: [], due_today: [], tomorrow: [], missing_date: [], blocking_closing: [], stale_follow_up: ['a', 'ghost'], missed_campaign_schedule: [], waiting_too_long: [] }, definitions: {} as never, events: [a], attention: [a] })
  assert.equal(s[0].key, 'overdue')
  assert.deepEqual(s.find((x) => x.key === 'stale_follow_up')!.items.map((e) => e.id), ['a'], 'an id the read model did not return is never drawn')
})
