import assert from 'node:assert/strict'
import {
  buildMonthGrid,
  buildWeekDays,
  daysInMonth,
  toIsoDate,
  zonedDayBoundaryProof,
} from '../../src/lib/calendar/calendar-date-engine.ts'

// Month grid proofs
const feb2024 = buildMonthGrid(new Date(2024, 1, 1))
assert.equal(feb2024.length % 7, 0, 'month grid uses full weeks')
assert.equal(feb2024.filter((c) => c.inMonth).length, daysInMonth(2024, 1), 'february 2024 day count')
assert.ok(feb2024.some((c) => !c.inMonth), 'february grid includes leading/trailing days')

const leapFeb = buildMonthGrid(new Date(2024, 1, 15))
assert.equal(daysInMonth(2024, 1), 29, 'leap year february has 29 days')

const week = buildWeekDays(new Date('2026-06-21'), 1)
assert.equal(week.length, 7, 'week view has seven days')
assert.equal(toIsoDate(week[0]), '2026-06-15', 'week starts on Monday when configured')

const dst = zonedDayBoundaryProof('2026-03-08', 'America/New_York')
assert.ok(dst.localDay, 'DST boundary proof returns localized day')

const midnight = zonedDayBoundaryProof('2026-06-21', 'America/Los_Angeles')
assert.ok(midnight.localDay, 'midnight boundary proof returns localized day')

console.log('calendar-nexus-proof: PASS', {
  monthCells: feb2024.length,
  inMonthDays: feb2024.filter((c) => c.inMonth).length,
  weekStart: toIsoDate(week[0]),
  dst,
  midnight,
})