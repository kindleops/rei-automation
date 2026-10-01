/**
 * Writes a CAPTURE FIXTURE for the desktop Calendar: the raw scenario rows
 * (tests/fixtures/calendar-timeline-scenarios.mjs + the closing scenarios)
 * run through the REAL loader — getCalendarTimeline(view=desk) — so the
 * fixture can never drift from what production projects.
 *
 * The fixture is never bundled into the dashboard and never served by the
 * API: a Playwright proof script serves it for the states production does not
 * hold today (a live closing, a running workflow timer, a message you
 * scheduled, a follow-up cluster), and those captures are named as fixtures.
 *
 *   node --import ./tests/register-aliases.mjs scripts/gen-calendar-demo.mjs --out=/abs/path/calendar-fixture.json
 */
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getCalendarTimeline } from '../src/lib/domain/calendar/calendar-timeline-service.js'
import { DEMO_NOW, calendarScenarioClosings, calendarScenarioTables, scenarioDb } from '../tests/fixtures/calendar-timeline-scenarios.mjs'

const outArg = process.argv.find((a) => a.startsWith('--out='))
const out = outArg ? path.resolve(outArg.slice(6)) : path.join(os.tmpdir(), 'calendar-desk-fixture.json')
const from = (process.argv.find((a) => a.startsWith('--from=')) || '--from=2026-09-20').slice(7)
const to = (process.argv.find((a) => a.startsWith('--to=')) || '--to=2026-10-24').slice(5)

const tables = calendarScenarioTables(DEMO_NOW)
const closings = calendarScenarioClosings(DEMO_NOW)
const data = await getCalendarTimeline(
  { from, to, tz: 'America/Chicago', view: 'desk' },
  { supabase: scenarioDb(tables), now: DEMO_NOW, getClosingPortfolio: async () => ({ items: closings }) },
)
writeFileSync(out, JSON.stringify({ ...data, fixture: true, generatedFrom: 'apps/api/tests/fixtures/calendar-timeline-scenarios.mjs' }) + '\n')
console.log('wrote', out, '·', data.events.length, 'events ·', data.attention.length, 'attention ·', Object.keys(data.days).length, 'days')
