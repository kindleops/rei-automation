/**
 * Writes the dashboard's ?demo=1 Calendar data by running the raw scenario
 * rows (tests/fixtures/calendar-timeline-scenarios.mjs + the closing
 * scenarios) through the REAL loader — getCalendarTimeline(view=desk) — so the
 * demo can never drift from what production projects. Demo data is never
 * served by the API and is always labelled DEMO in the UI. Re-run after
 * changing the read model:
 *   node --import ./tests/register-aliases.mjs scripts/gen-calendar-demo.mjs
 */
import { writeFileSync } from 'node:fs'
import { getCalendarTimeline } from '../src/lib/domain/calendar/calendar-timeline-service.js'
import { DEMO_NOW, calendarScenarioClosings, calendarScenarioTables, scenarioDb } from '../tests/fixtures/calendar-timeline-scenarios.mjs'

const tables = calendarScenarioTables(DEMO_NOW)
const closings = calendarScenarioClosings(DEMO_NOW)
const out = await getCalendarTimeline(
  { from: '2026-09-20', to: '2026-10-24', tz: 'America/Chicago', view: 'desk' },
  { supabase: scenarioDb(tables), now: DEMO_NOW, getClosingPortfolio: async () => ({ items: closings }) },
)
const file = { ...out, demo: true, generatedFrom: 'apps/api/tests/fixtures/calendar-timeline-scenarios.mjs' }
writeFileSync(new URL('../../dashboard/src/views/calendar/desktop/calendar-demo.generated.json', import.meta.url), JSON.stringify(file) + '\n')
console.log('wrote', out.events.length, 'demo events ·', out.attention.length, 'attention ·', Object.keys(out.days).length, 'days')
