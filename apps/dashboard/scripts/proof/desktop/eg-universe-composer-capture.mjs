/**
 * ENTITY GRAPH OVERVIEW PAGE + CAMPAIGN COMPOSER (premium) capture — READ ONLY.
 *
 * Serves a dev-mode build from an in-process static server
 * (NODE_ENV=development npx vite build --mode development --outDir <dist>).
 *
 *   GET /api/cockpit/entity-graph/universe  LIVE from the real universe
 *     service over ONE read-only connection (default_transaction_read_only,
 *     15 s statement timeout, serial) — aggregates only: counts, market and
 *     category labels; no names, phones or addresses exist in its answer.
 *   Composer reads                           SYNTHETIC fixtures in this file
 *     (redacted: "Seller A.", "1200 Sample Ave"); nothing real is rendered.
 *   Every non-GET and every other API / Supabase request is aborted; nothing
 *   that writes or sends is clicked.
 *
 * Credential (rc-8.5.21-c): LC_RO_ENTITY_GRAPH_DB_URL_FILE — the role-enforced read-only
 * diagnostics role, verified by scripts/lib/prod-db-credentials.mjs.
 * Run from apps/api (the service imports resolve through its alias loader):
 *   node --import ./tests/register-aliases.mjs ../dashboard/scripts/proof/desktop/eg-universe-composer-capture.mjs \
 *     --dist=/tmp/egu-dist --out=/tmp/overview-composer-shots --themes=dark,light --sizes=1440x900,1920x1080
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { connectReadOnlyDiagnostics } from '../../../../../scripts/lib/prod-db-credentials.mjs'

const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const DIST = path.resolve(arg('dist', '/tmp/egu-dist'))
const OUT = path.resolve(arg('out', '/tmp/overview-composer-shots'))
const THEMES = arg('themes', 'dark').split(',')
const SIZES = arg('sizes', '1440x900').split(',').filter(Boolean).map((s) => s.split('x').map(Number))
const ONLY = arg('scenes', '')

const { buildEntityGraphUniverse } = await import('@/lib/domain/entity-graph/entity-graph-universe-service.js')
const client = await connectReadOnlyDiagnostics({ purpose: 'entity_graph', applicationName: 'lc-eg-universe-capture', statementTimeoutMs: 15_000 })
await client.query('set default_transaction_read_only = on')
let lock = Promise.resolve()
const query = (sql, params = [], ms = 15_000) => {
  const p = lock.then(async () => { await client.query(`set statement_timeout = ${Math.min(15_000, Math.trunc(ms || 15_000))}`); return client.query(sql, params) })
  lock = p.catch(() => {})
  return p
}

/* ── synthetic composer fixtures (no real person, phone or address) ───────── */
const at = new Date().toISOString()
const SAMPLES = [
  { id: 's1', property_id: 'prop_fixture_1', recipient: 'Seller A.', place: '1200 Sample Ave · Dallas', market: 'Dallas, TX', language: 'English', ok: true, text: 'Hi Seller A., this is Jordan with LeadCommand — are you still the owner of 1200 Sample Ave? We buy as-is and can close on your timeline.', template_id: 'tpl-s1-en-04', template_language: 'English', reason: null },
  { id: 's2', property_id: 'prop_fixture_2', recipient: 'Seller B.', place: '88 Example St · Dallas', market: 'Dallas, TX', language: 'Spanish', ok: true, text: 'Hola Seller B., ¿sigue siendo el dueño de 88 Example St? Compramos tal como está y cerramos cuando usted diga.', template_id: 'tpl-s1-es-02', template_language: 'Spanish', reason: null },
  { id: 's3', property_id: 'prop_fixture_3', recipient: null, place: '42 Placeholder Rd · Fort Worth', market: 'Dallas, TX', language: 'English', ok: false, text: null, template_id: null, reason: 'missing_first_name' },
]
const AUDIENCE = {
  ok: true, at, strategy: { use_case: 'ownership_check', stage_code: 'S1' },
  matched: 7741, addressable: 7402, reachable: 6112, sms_eligible: 5320, clean: 4410, eligible_in_audience: 4288,
  exclusions: { suppressed: 132, dnc: 0, wrong_number: 21, no_phone: 1290, sms_ineligible: 771, no_sender_route: 0, pending_prior_touch: 736, active_queue: 42 },
  build: { ok: true, whole_cohort: true, rows_read: 4288, recipients: 4012, duplicates_collapsed: 276, built: 4012, ready: 3921, held: 91, held_by_reason: { missing_first_name: 58, language_not_supported: 33 }, sendable_now: 3874, no_sendable_number: 47, sendable_after_language: 3841, sendable_after_personalization: 3802, timings_ms: { read: 2140, total: 3380 }, personalization: { first_name: 3610, deed_name: 192, none: 58 }, sender_markets: [{ market: 'Dallas, TX', sellers: 3921, sendable: true, route_tier: 'exact_market_match', block_reason: null, summary: null }] },
  universe: { count: 7741, location_filters: ['properties.market'], targeting_filters: [] },
  graph_coverage: null,
  distributions: {
    markets: [{ value: 'Dallas, TX', label: 'Dallas, TX', count: 7741 }],
    languages: [{ value: 'English', label: 'English', count: 6820 }, { value: 'Spanish', label: 'Spanish', count: 870 }, { value: 'unknown', label: 'Unknown', count: 51 }],
    property_types: [{ value: 'SFR', label: 'Single family', count: 6302 }, { value: 'Duplex', label: 'Duplex', count: 901 }, { value: 'Triplex', label: 'Triplex', count: 338 }],
    zips: [{ value: '75217', label: '75217', count: 612 }, { value: '75216', label: '75216', count: 540 }, { value: '75211', label: '75211', count: 498 }],
    zones: [{ value: 'America/Chicago', label: 'Central', count: 7741 }],
  },
  zones: { scanned: 4288, unresolved: 0 }, inapplicable_filters: [], unsupported_filters: [], dropped_filter_count: 0,
  graph_freshness: { latest_generated_at: at, refresh_finished_at: at, refresh_status: 'ok' }, graph_unavailable: false, warnings: [], samples: SAMPLES,
}
const COHORT = { ok: true, at, queue_eligible_in_audience: 4288, rows_read: 4288, capped_by_build_limit: false, build_limit: 20000, recipients: 4012, duplicates_collapsed: 276, ready: 3921, held: 91, held_by_reason: AUDIENCE.build.held_by_reason, sendable_now: 3874, no_sendable_number: 47, sender_markets: AUDIENCE.build.sender_markets, personalization: AUDIENCE.build.personalization, sendable_after_personalization: 3802, ready_by_zone: { 'America/Chicago': 3921 }, ready_by_market: { 'Dallas, TX': 3921 }, timings_ms: { read: 2140, total: 3380 } }
const lang = (language, sendable) => ({ language, templates: sendable + 1, sendable, paused: 1, blocked: 0, inactive: 0 })
const TEMPLATES = { ok: true, at, governance_readable: true, strategies: [
  { use_case: 'ownership_check', stage_code: 'S1', label: 'Ownership check', touch: 'first', languages: [lang('English', 6), lang('Spanish', 3)], templates: 11, sendable: 9, governed: [{ template_id: 'tpl-s1-en-04', name: 'S1 · ownership · casual', language: 'English', rotation_status: 'active', selectable: true, reason: null, notes: null, daily_cap: 400, performance: { sample: 2210, reply_rate: 7.4, delivery_rate: 96.1, opt_out_rate: 1.2 }, performance_sample: 2210 }] },
  { use_case: 'reengagement', stage_code: 'S1', label: 'Re-engagement', touch: 'follow_up', languages: [lang('English', 3)], templates: 4, sendable: 3, governed: [] },
] }
const FLEET = { ok: true, at, numbers: [], markets: [{ market: 'Dallas, TX', state: 'TX', numbers: 6, by_state: { active: 6 }, capacity_per_day: 1800, remaining_today: 1440, unavailable_per_day: 0, unknown_limit: 0 }], blocklist_readable: true, system: { per_number_cap: 300, processor_mode: 'off', emergency_stop_at: null, outbound_sms_enabled: false, contact_window: { start: '08:00', end: '21:00' }, auto_reply_mode: 'off', followup_automation_mode: 'off' } }
const COVERAGE = { ok: true, at, engine: 'sender_routing_v2', markets: [{ market_id: 'dallas_tx', market: 'Dallas, TX', targets: 3921, coverage: 'LOCAL', serving_pool: 'Dallas', serving_tier: 'exact_market_match', healthy_numbers: 6, daily_capacity: 1800, unavailable: [] }], totals: { distinct_healthy_numbers: 6, distinct_daily_capacity: 1800, targets: 3921 }, v2_preview: null }
const OFFER = { ok: true, source: 'composer_cohort', at, sendable: 3802, offer_ready: 3510, review_only: 292, by_reason: { offer_ready: 3510, score_stale: 201, not_scored: 91 }, predicate: { epoch: '2026-09-12', max_age_days: 30, tiers: [] }, label: 'Offer Ready' }
const composerPart = (u) => {
  const part = u.searchParams.get('part')
  return { audience: AUDIENCE, cohort: COHORT, templates: TEMPLATES, fleet: FLEET, coverage: COVERAGE, offer_ready: OFFER }[part] ?? null
}

/* ── scenes ───────────────────────────────────────────────────────────────── */
const SCENES = [
  ['01-eg-overview-universe', '/entity-graph?egs=overview', 'universe'],
  ['02-eg-overview-miami', `/entity-graph?egs=overview&egm=${encodeURIComponent(JSON.stringify(['Miami, FL']))}`, 'universe'],
  ['03-eg-overview-drill', '/entity-graph?egs=overview', 'drill'],
  ['04-composer-dallas', `/campaign-command?compose=1&market=${encodeURIComponent('Dallas, TX')}`, 'composer'],
  ['05-composer-message', `/campaign-command?compose=1&market=${encodeURIComponent('Dallas, TX')}`, 'composer-message'],
].filter(([n]) => !ONLY || ONLY.split(',').some((o) => n.startsWith(o)))

await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 20 * 60_000)
const timings = []
const blocked = []
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg' }
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = path.join(DIST, p)
  try { if (!(await fs.stat(file)).isFile()) throw 0 } catch { file = path.join(DIST, 'index.html') }
  res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
  res.end(await fs.readFile(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

async function guard(page) {
  await page.route('**/*', async (r) => {
    const req = r.request()
    const u = new URL(req.url())
    const local = u.origin === BASE
    const isApi = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
    if (isApi && req.method() !== 'GET') { blocked.push(`${req.method()} ${u.pathname}`); return r.abort() }
    if (u.pathname === '/api/cockpit/entity-graph/universe') {
      const t0 = Date.now()
      try {
        const body = await buildEntityGraphUniverse(Object.fromEntries(u.searchParams.entries()), { query })
        timings.push({ scope: u.searchParams.get('scope'), globals: body.globals, ms: Date.now() - t0, server: body.timings, cache: body.cache })
        return json(r, body)
      } catch (e) { return json(r, { ok: false, error: e?.code || 'failed', message: String(e?.message || e), cards: [] }, 500) }
    }
    if (u.pathname === '/api/cockpit/campaigns/composer') { const b = composerPart(u); return b ? json(r, b) : json(r, { ok: false, error: 'fixture_missing' }, 404) }
    if (u.pathname === '/api/cockpit/campaigns/options') return json(r, { ok: true, options: [{ value: 'Dallas, TX', label: 'Dallas, TX', count: 7741 }, { value: 'Miami, FL', label: 'Miami, FL', count: 20395 }] })
    if (u.pathname.startsWith('/api/') || isApi) return json(r, { ok: false, error: 'fixture_missing' }, 404)
    if (!local && (u.hostname.includes('googleapis') || u.hostname.includes('basemaps') || u.hostname.includes('carto'))) return r.abort()
    return r.continue()
  })
}

const browser = await chromium.launch()
const report = []
for (const theme of THEMES) for (const [W, H] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, serviceWorkers: 'block' })
  await ctx.addInitScript((t) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      sessionStorage.removeItem('lc.workspace.session.v1')
      sessionStorage.removeItem('lc.entityGraph.desk.state.v1')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const s = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...s, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  await guard(page)
  const label = `${theme}-${W}x${H}`
  for (const [name, route, mode] of SCENES) {
    const row = { label, name }
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      if (mode === 'universe' || mode === 'drill') {
        await page.waitForSelector('.egu', { timeout: 60_000 })
        await page.waitForFunction(() => document.querySelectorAll('.egu-card:not(.is-skeleton)').length >= 8, null, { timeout: 120_000 }).catch(() => { row.note = 'cards still loading' })
        await page.waitForTimeout(1600)
        row.computing = await page.locator('text=/Computing/i').count()
        row.asOf = await page.locator('.egu-hero__asof').innerText().catch(() => null)
        if (mode === 'drill') {
          const bar = page.locator('.egu-card.is-properties .egu-chart[aria-label="Asset type"] button.egu-bar').first()
          row.clicked = await bar.getAttribute('title')
          await bar.click()
          await page.waitForSelector('.egdk-tablebar', { timeout: 60_000 }).catch(() => { row.note = 'grid did not open' })
          await page.waitForTimeout(1200)
          row.url = decodeURIComponent(page.url().split('?')[1] || '')
        }
      } else {
        await page.waitForSelector('.ccz', { timeout: 60_000 })
        await page.waitForSelector('.ccz-lens:not(.is-loading)', { timeout: 60_000 }).catch(() => { row.note = 'lens not shown' })
        await page.waitForTimeout(1800)
        if (mode === 'composer-message') {
          await page.locator('.ccz-story__step', { hasText: 'Message' }).click()
          await page.waitForTimeout(900)
          await page.locator('.ccz-phone').scrollIntoViewIfNeeded().catch(() => {})
          await page.waitForTimeout(600)
        }
      }
      await page.screenshot({ path: path.join(OUT, `${label}-${name}.png`) })
    } catch (e) {
      row.failed = String(e.message).slice(0, 200)
      await page.screenshot({ path: path.join(OUT, `${label}-${name}-failed.png`) }).catch(() => {})
    }
    report.push(row)
    console.log(JSON.stringify(row))
  }
  if (errors.length) console.log('page errors:', label, errors.slice(0, 6))
  await ctx.close()
}
await browser.close()
server.close()
await client.end()
clearTimeout(watchdog)
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ report, timings, blocked }, null, 1))
console.log('universe requests:', timings.length, '· blocked non-GETs:', blocked.length)
