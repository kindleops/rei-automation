/**
 * Writes the dashboard's ?demo=1 Closing Desk data by running the raw
 * scenario rows (tests/fixtures/closing-execution-scenarios.mjs) through the
 * REAL derivation. Demo data is never served by the API and is always
 * labelled DEMO in the UI. Re-run after changing the model:
 *   node --import ./tests/register-aliases.mjs scripts/gen-closing-demo.mjs
 */
import { writeFileSync } from 'node:fs'
import { deriveClosingExecution, summarizePortfolio } from '../src/lib/domain/closings/closing-execution-model.js'
import { closingScenarios } from '../tests/fixtures/closing-execution-scenarios.mjs'

const NOW = Date.parse('2026-09-29T15:00:00Z')
const items = closingScenarios(NOW).map((s) => deriveClosingExecution({ ...s, now: NOW }))
const activityFor = (x) => [
  { id: `${x.id}:a1`, type: 'title_intro_email', actor: 'system', source: 'title_intro', detail: { to: x.title.email }, at: x.title.introSentAt },
  { id: `${x.id}:a2`, type: 'docusign_status', actor: 'docusign', source: 'docusign_webhook', detail: { status: x.contract.status }, at: x.contract.executedAt || x.contract.sentAt },
].filter((a) => a.at)
const out = {
  generatedFrom: 'apps/api/tests/fixtures/closing-execution-scenarios.mjs',
  now: new Date(NOW).toISOString(),
  portfolio: { items, summary: summarizePortfolio(items, { now: NOW }), degraded: [], sort: 'most_urgent', recentDays: 120, generatedAt: new Date(NOW).toISOString() },
  activity: Object.fromEntries(items.map((x) => [x.id, activityFor(x)])),
}
writeFileSync(new URL('../../dashboard/src/views/closing-desk/mobile/closing-demo.generated.json', import.meta.url), JSON.stringify(out) + '\n')
console.log('wrote', items.length, 'demo closings')
