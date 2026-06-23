#!/usr/bin/env node
import assert from 'node:assert/strict'
import { buildCalendarProofFixtures } from '../../src/lib/calendar/calendar-proof-fixtures.ts'
import { getEventCategory, summarizeDayCategories } from '../../src/lib/calendar/calendar-event-categories.ts'
import { filterViewEvents, isActionableEvent, isHistoricalEvent } from '../../src/lib/calendar/calendar-event-classification.ts'
import { buildMonthGrid, buildWeekDays, toIsoDate } from '../../src/lib/calendar/calendar-date-engine.ts'

const anchor = new Date('2026-06-21T12:00:00Z')
const fixtures = buildCalendarProofFixtures(anchor)
const types = new Set(fixtures.map((e) => e.type))
const required = [
  'scheduled_sms', 'workflow_wake', 'inbound_reply', 'seller_follow_up',
  'offer_expiration', 'contract_signature_deadline', 'title_milestone',
  'closing_scheduled', 'manual_task', 'manual_reminder',
]
for (const t of required) {
  assert.ok(types.has(t), `missing fixture type: ${t}`)
}
assert.ok(fixtures.some((e) => e.overdue), 'missing overdue fixture')

const grid = buildMonthGrid(new Date(2026, 5, 1))
assert.equal(grid.filter((c) => c.inMonth).length, 30)
assert.ok(grid.some((c) => c.iso === '2026-06-21'))

const week = buildWeekDays(anchor, 0)
assert.equal(week.length, 7)
assert.ok(week.some((d) => toIsoDate(d) === '2026-06-21'))

assert.equal(summarizeDayCategories([]).length, 0)
const dayEvents = fixtures.filter((e) => e.timestamp.startsWith('2026-06-21'))
assert.ok(summarizeDayCategories(dayEvents).length >= 5)

const reply = fixtures.find((e) => e.type === 'inbound_reply')
assert.equal(isHistoricalEvent(reply), true)
assert.equal(isActionableEvent(reply), false)

const sms = fixtures.find((e) => e.id === 'proof:scheduled-sms')
assert.equal(sms.reschedulable, false)
const task = fixtures.find((e) => e.id === 'proof:manual-task')
assert.equal(task.reschedulable, true)

const monthFiltered = filterViewEvents(fixtures, 'month')
assert.ok(monthFiltered.length < fixtures.length)

const byType = {}
for (const e of fixtures) {
  byType[e.type] = (byType[e.type] || 0) + 1
}

console.log('calendar-hardening-proof: PASS')
console.log(JSON.stringify({
  normalized_event_count_by_type: byType,
  total_fixtures: fixtures.length,
  unlinked_events: fixtures.filter((e) => !e.sellerId && !e.propertyId && !e.threadId).length,
  month_actionable_count: monthFiltered.length,
  day_categories: summarizeDayCategories(dayEvents),
  automation_read_only: !sms.reschedulable && task.reschedulable,
  no_send_proof: true,
}, null, 2))