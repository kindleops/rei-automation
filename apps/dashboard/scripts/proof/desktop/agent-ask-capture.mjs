/**
 * AGENT ASK (8.5.10 Cursor-grade composer) CAPTURE — DEV build, NO API.
 *
 * Every /api request is answered in-process; non-local hosts are aborted.
 * The research agent routes (/api/cockpit/agent/live/ask*) are answered by a
 * harness double whose run audit is released step by step, so mid-run shots
 * are deterministic. All identities are SYNTHETIC (no real owner, address
 * or campaign). Nothing here ships: it is a proof script, not app code.
 *
 *   node scripts/proof/desktop/agent-ask-capture.mjs --base=http://localhost:5398 --out=/tmp/agent-ui-v2-shots
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5398')
const OUT = path.resolve(arg('out', '/tmp/agent-ui-v2-shots'))
await fs.mkdir(OUT, { recursive: true })

const PIDS = ['1000001', '1000002', '1000003']
const ADDR = { 1000001: '1418 Larkspur Ct (synthetic)', 1000002: '77 Quarry Row (synthetic)', 1000003: '9 Fennel Way (synthetic)' }
const CAMPAIGN = { id: '11111111-2222-3333-4444-555555555555', campaign_name: 'Synthetic · Spring probate', status: 'active' }
const STATUS = {
  ok: true, live: true, fixture: false, read_only: true, enabled: true, mode_ok: true,
  models: { ok: true, default: { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }, escalation: { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' } },
  caps: { day_usd: 10, user_day_usd: 10, cycle_usd: 150, run_usd: 2.5 },
  spend: { day_usd: 1.84, cycle_usd: 12.4, day_remaining_usd: 8.16, cycle_remaining_usd: 137.6 },
  runs_today: 6, daily_run_cap: 40, limits: { question_max_chars: 2000, max_model_calls: 10, max_tool_calls: 24 },
  tools: [
    { name: 'eg.distress_signals', label: 'Reading distress signals' }, { name: 'eg.contact_map', label: 'Reading the contact map' },
    { name: 'eg.facts', label: 'Reading Entity Graph facts' }, { name: 'campaign.overview', label: 'Reading campaign overview' }, { name: 'campaign.audience_top', label: 'Ranking the campaign audience' },
  ],
}
const t0 = Date.parse('2026-10-11T22:10:00Z')
const at = (s) => new Date(t0 + s * 1000).toISOString()
const AUDIT = [
  { at: at(0), kind: 'run_start', name: 'research.ask' },
  { at: at(1), kind: 'model_call', name: 'claude-haiku-5-5', latency_ms: 840, cost_usd: 0.0021, outcome: 'tool_use' },
  { at: at(2), kind: 'tool_call', name: 'eg.distress_signals', rows_returned: 6, latency_ms: 212, outcome: 'ok' },
  { at: at(2), kind: 'tool_call', name: 'eg.distress_signals', rows_returned: 5, latency_ms: 188, outcome: 'ok' },
  { at: at(3), kind: 'tool_call', name: 'eg.distress_signals', rows_returned: 4, latency_ms: 240, outcome: 'ok' },
  { at: at(4), kind: 'tool_call', name: 'eg.contact_map', rows_returned: 3, latency_ms: 96, outcome: 'ok' },
  { at: at(5), kind: 'model_call', name: 'claude-haiku-5-5', latency_ms: 1210, cost_usd: 0.0034, outcome: 'tool_use' },
  { at: at(6), kind: 'escalation', name: 'claude-sonnet-5-5', outcome: 'multi_property_synthesis' },
  { at: at(7), kind: 'tool_call', name: 'eg.facts', rows_returned: 0, latency_ms: 30000, outcome: 'TOOL_TIMEOUT' },
  { at: at(14), kind: 'model_call', name: 'claude-sonnet-5-5', latency_ms: 6480, cost_usd: 0.0412, outcome: 'end_turn' },
  { at: at(14), kind: 'run_end', outcome: 'completed' },
]
const CALLS = [
  { model: 'claude-haiku-5-5', route: 'default', input_tokens: 3120, output_tokens: 184, cost_usd: 0.0021, latency_ms: 840 },
  { model: 'claude-haiku-5-5', route: 'default', input_tokens: 7410, output_tokens: 96, cost_usd: 0.0034, latency_ms: 1210 },
  { model: 'claude-sonnet-5-5', route: 'escalation', input_tokens: 9820, output_tokens: 712, cost_usd: 0.0412, latency_ms: 6480 },
]
const ANSWER = [
  'Of the three properties, **1000001** carries the strongest distress evidence: a recorded tax delinquency (recorded_parcel) that the campaign target graph also flags, plus a verified probate status (probate_status).',
  '',
  '**Evidence**',
  '- 1000001 — tax delinquent 2 years (recorded_parcel); probate verified (probate_status); 3 reachable contacts as handles P1–P3, best via SMS (eg.contact_map).',
  '- 1000002 — preforeclosure flag from the target graph; not confirmed by preforeclosure_status_v2 (unavailable is not "no").',
  '- 1000003 — no distress flags in any source read; high estimated equity (vendor-reported).',
  '',
  '**Inconsistencies**',
  '- 1000002: the target graph reports a lien the recorded parcel snapshot does not show.',
  '',
  '**Gaps / not available**',
  '- eg_property_facts timed out for 1000003; its facts were not applied.',
].join('\n')

const harness = { released: AUDIT.length, state: 'completed', denied: false }
function runBody() {
  const audit = AUDIT.slice(0, harness.released)
  const done = harness.state !== 'running'
  const calls = CALLS.slice(0, audit.filter((a) => a.kind === 'model_call').length)
  return {
    ok: true, live: true, fixture: false, read_only: true, run_id: 'ask_SYNTHrun0001demo', state: harness.state, outcome: done ? 'completed' : null,
    created_at: at(0), ended_at: done ? at(14.3) : null, latency_ms: done ? 14300 : null, cost_usd: calls.reduce((n, c) => n + c.cost_usd, 0),
    models: { default: 'claude-haiku-5-5', escalation: 'claude-sonnet-5-5' },
    counters: { model_calls: calls.length, escalated_calls: audit.some((a) => a.kind === 'escalation') && done ? 1 : 0, escalated_usd: done ? 0.0412 : 0, tool_calls: audit.filter((a) => a.kind === 'tool_call').length },
    answer: done ? { answer_md: ANSWER, property_ids: PIDS } : null, calls, audit,
  }
}

async function api(route) {
  const req = route.request()
  const u = new URL(req.url())
  const p = u.pathname
  const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) })
  if (p.startsWith('/api/cockpit/agent/live/ask')) {
    if (harness.denied) return json({ ok: false, live: true, fixture: false, error: 'NOT_ALLOWLISTED', message: 'This account is not authorized to use the agent.' }, 403)
    if (p === '/api/cockpit/agent/live/ask' && req.method() === 'GET') return json(STATUS)
    if (p === '/api/cockpit/agent/live/ask' && req.method() === 'POST') return json({ ok: true, live: true, fixture: false, run_id: 'ask_SYNTHrun0001demo', state: 'running' }, 202)
    return json(runBody())
  }
  if (p === '/api/cockpit/agent/live') return route.fulfill({ status: 404, body: '' })
  if (p === '/api/cockpit/entity-graph/search') {
    const tab = u.searchParams.get('tab')
    const q = (u.searchParams.get('q') || '').toLowerCase()
    if (tab === 'properties') return json({ ok: true, results: PIDS.filter((id) => ADDR[id].toLowerCase().includes(q) || q.length < 3).map((id) => ({ entityType: 'property', entityId: id, title: ADDR[id], subtitle: 'Synthetic County, TX', badges: [], linkedCounts: {} })), pagination: {} })
    if (tab === 'master_owners') return json({ ok: true, results: [{ entityType: 'master_owner', entityId: 'mo_synth_1', title: 'Owner A (redacted)', subtitle: '3 properties', badges: [], linkedCounts: {} }], pagination: {} })
    if (tab === 'markets') return json({ ok: true, results: [{ entityType: 'market', entityId: 'mkt_synth', title: 'Synthetic Metro, TX', subtitle: 'market', badges: [], linkedCounts: {} }], pagination: {} })
  }
  if (p === '/api/cockpit/campaigns') return json({ ok: true, campaigns: [CAMPAIGN, { id: '22222222-3333-4444-5555-666666666666', campaign_name: 'Synthetic · Tax delinquent Q4', status: 'paused' }] })
  if (p.startsWith('/api/')) return json({ ok: true, data: null, items: [], rows: [] })
  return route.continue()
}

const browser = await chromium.launch()
const stats = { aborted: 0, errors: [] }
async function page({ W = 1920, H = 1080, theme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const pg = await ctx.newPage()
  pg.on('pageerror', (e) => stats.errors.push(String(e.message).slice(0, 200)))
  await pg.route('**/*', (r) => {
    const u = new URL(r.request().url())
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (local && u.pathname.startsWith('/api/')) return api(r)
    if (local) return r.continue()
    stats.aborted += 1
    return r.abort()
  })
  await pg.goto(`${BASE}/entity-graph`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await pg.waitForSelector('.cd', { timeout: 180000 })
  await pg.waitForFunction(() => Boolean(window.__lcAgent), null, { timeout: 90000 })
  await pg.evaluate(() => { window.__lcAgent.reset(); sessionStorage.removeItem('lc.agent.ask.v1') })
  // what Entity Graph does on a row click (synthetic subject) + its published selection
  await pg.evaluate(([id, addr]) => {
    const v = { propertyId: id, threadKey: null, masterOwnerId: null, prospectId: null, opportunityId: null, address: addr, setAt: Date.now() }
    sessionStorage.setItem('nexus:property-locator:v1', JSON.stringify(v))
    window.dispatchEvent(new CustomEvent('nexus:property-locator', { detail: v }))
  }, ['1000001', ADDR[1000001]])
  await pg.waitForTimeout(800)
  return { ctx, pg }
}
const shot = async (pg, name) => { await pg.waitForTimeout(700); await pg.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log('  ✓', name) }
const openDock = async (pg) => { await pg.keyboard.press('Meta+l'); await pg.waitForSelector('.ak-composer textarea', { timeout: 20000 }); await pg.waitForTimeout(600) }
const type = async (pg, s) => { await pg.locator('.ak-composer textarea').first().pressSequentially(s, { delay: 25 }) }

for (const theme of ['dark', 'light']) {
  const { ctx, pg } = await page({ theme })
  await openDock(pg)
  if (theme === 'dark') {
    await shot(pg, `01-${theme}-dock-empty-auto-chip`)
    await type(pg, '@')
    await shot(pg, `02-${theme}-mention-categories`)
    await type(pg, 'campaign ')
    await pg.waitForSelector('.ak-opt', { timeout: 10000 })
    await shot(pg, `03-${theme}-mention-campaign-typeahead`)
    await pg.keyboard.press('Enter')
    await pg.locator('.ak-composer textarea').first().fill('')
    await type(pg, '/')
    await shot(pg, `04-${theme}-slash-commands`)
    await pg.locator('.ak-composer textarea').first().fill('')
    await type(pg, '/compare ')
  } else {
    await type(pg, '/compare ')
  }
  // add the other two synthetic properties via @-typeahead
  for (const q of ['Quarry', 'Fennel']) {
    await type(pg, `@property ${q}`)
    await pg.waitForSelector('.ak-opt', { timeout: 10000 }).catch(async (e) => { await pg.screenshot({ path: path.join(OUT, `_fail-${theme}-${q}.png`) }); throw e })
    await pg.waitForTimeout(500)
    await pg.keyboard.press('Enter')
    await pg.waitForTimeout(500)
  }
  await type(pg, 'Which has the strongest distress evidence?')
  if (theme === 'dark') await shot(pg, `05-${theme}-composer-chips-ready`)
  // run: release the audit in steps
  harness.state = 'running'; harness.released = 4
  await pg.keyboard.press('Meta+Enter')
  await pg.waitForSelector('.ak-step', { timeout: 15000 })
  await pg.waitForTimeout(1600)
  if (theme === 'dark') await shot(pg, `06-${theme}-running-timeline`)
  harness.released = 9
  await pg.waitForTimeout(2600)
  if (theme === 'dark') await shot(pg, `07-${theme}-running-escalated`)
  harness.state = 'completed'; harness.released = AUDIT.length
  await pg.waitForSelector('.ak-foot', { timeout: 15000 })
  await pg.waitForTimeout(1600)
  await shot(pg, `08-${theme}-answer-evidence-followups`)
  if (theme === 'dark') {
    await pg.locator('.ak-tl__head').first().click()
    await pg.locator('.ak-step__row').nth(1).click()
    await shot(pg, `09-${theme}-timeline-expanded`)
    await pg.keyboard.press('Meta+Shift+l')
    await pg.waitForSelector('.ak-palette__card', { timeout: 10000 })
    await shot(pg, `10-${theme}-palette`)
    await pg.keyboard.press('Escape')
    await openDock(pg)
    await pg.getByRole('button', { name: 'History' }).first().click()
    await shot(pg, `11-${theme}-history`)
  }
  await ctx.close()
}

// the unauthorized state (403 from the server allowlist)
harness.denied = true
{
  const { ctx, pg } = await page({ theme: 'dark' })
  await pg.keyboard.press('Meta+l')
  await pg.waitForSelector('.ak-locked', { timeout: 20000 })
  await shot(pg, '12-dark-not-enabled-for-account')
  await ctx.close()
}
await browser.close()
console.log(JSON.stringify({ out: OUT, aborted_external: stats.aborted, page_errors: stats.errors }))
