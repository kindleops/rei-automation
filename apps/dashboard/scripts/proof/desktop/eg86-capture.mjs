/**
 * EG 8.6 capture (READ ONLY, NO DEV SERVER) — the Overview landing view on
 * every scope + Campaign → Entity Graph (Overview and the all-columns Grid).
 *
 * A dev-mode build is served from an in-process static server. The Entity
 * Graph reads are answered LIVE by the real API services, every Postgres
 * statement:
 *   - read-only (default_transaction_read_only), statement_timeout ≤ 15 s
 *     (any SET above is clamped), SERIAL (one statement at a time, process-wide);
 *   - campaign-scoped cohorts only (keyed on the campaign's ≤ 3,147 ids) or the
 *     unfiltered universe, which the Overview answers "computing" without a scan;
 *   - the PostgREST client is a recorder-backed shim: keyed `in (…)` reads,
 *     LIMIT ≤ 500, no count without an id list.
 * Tab counts / KPIs come from the fixture file; every non-GET and every other
 * API / Supabase request is aborted. Prints timings + counts only.
 *
 * Run from apps/api:
 *   DATABASE_URL=… node --import ./tests/register-aliases.mjs ../dashboard/scripts/proof/desktop/eg86-capture.mjs \
 *     --dist=/tmp/egov86-dist --fixtures=/tmp/egov-fixtures.json --out=/tmp/egov86-shots --campaign=<uuid>
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import pg from 'pg'

const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const DIST = path.resolve(arg('dist', '/tmp/egov86-dist'))
const OUT = path.resolve(arg('out', '/tmp/egov86-shots'))
const FIX = arg('fixtures', '')
const CID = arg('campaign', 'cbc2a5d3-b4d4-4297-a168-1ac69e643ee0')
const ONLY = arg('scenes', '')

/* ── Postgres guard: read-only, ≤ 15 s, serial ─────────────────────────── */
let chain = Promise.resolve()
const origQuery = pg.Client.prototype.query
const dbLog = []
pg.Client.prototype.query = function guardedQuery(config, values, cb) {
  let text = typeof config === 'string' ? config : config?.text
  if (/^\s*set\s+statement_timeout\s*=\s*(\d+)/i.test(text || '')) {
    const ms = Math.min(15_000, Number(/(\d+)/.exec(text)[1]))
    text = `SET statement_timeout = ${ms}`
    config = typeof config === 'string' ? text : { ...config, text }
  }
  if (/^\s*(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i.test(text || '')) return Promise.reject(new Error('capture: write refused'))
  const run = () => { const t0 = Date.now(); return origQuery.call(this, config, values, cb).then((r) => { dbLog.push({ ms: Date.now() - t0, rows: r?.rowCount ?? null, sql: String(text).replace(/\s+/g, ' ').slice(0, 90) }); return r }) }
  const p = chain.then(run, run)
  chain = p.catch(() => {})
  return p
}
process.env.PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=15000'

const { queryWithTimeout } = await import('@/lib/postgres/client.js')
const { createSqlRecorder } = await import('@/lib/domain/entity-graph/entity-graph-facet-sql.js')
const { buildEntityGraphOverview } = await import('@/lib/domain/entity-graph/entity-graph-overview-service.js')
const { getCampaignScopeSummary } = await import('@/lib/domain/entity-graph/entity-graph-campaign-scope.js')
const { browseEntityGraphPage } = await import('@/lib/domain/entity-graph/entity-graph-browse-page.js')
const { getEntityGraphColumnEnrichment } = await import('@/lib/domain/entity-graph/entity-graph-column-enrichment.js')
const { getEntityGraphOutreachState } = await import('@/lib/domain/entity-graph/entity-graph-outreach-state.js')
const { getEntityGraphFilterCatalog, ENTITY_GRAPH_FILTERABLE_TABS } = await import('@/lib/domain/entity-graph/entity-graph-field-filters.js')

/** A PostgREST-shaped client over the direct pool: keyed reads only, LIMIT ≤ 500. */
function shimSupabase() {
  const IDENT = /^[a-z_][a-z0-9_]*$/
  return {
    from(table) {
      if (!IDENT.test(table)) throw new Error(`shim: table ${table}`)
      const rec = createSqlRecorder()
      let cols = '*'
      let head = false
      let count = false
      let order = []
      let limit = 500
      let offset = 0
      let single = false
      let keyed = false
      const b = {
        select(c = '*', opts = {}) { cols = String(c).split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x === '*' ? '*' : IDENT.test(x) ? `"${x}"` : null)).filter(Boolean).join(', ') || '*'; head = Boolean(opts.head); count = opts.count === 'exact'; return b },
        order(col, o = {}) { if (IDENT.test(col)) order.push(`"${col}" ${o.ascending === false ? 'desc' : 'asc'}${o.nullsFirst === false ? ' nulls last' : ''}`); return b },
        limit(n) { limit = Math.min(500, Number(n) || 500); return b },
        range(a, z) { offset = Number(a) || 0; limit = Math.min(500, (Number(z) || 0) - offset + 1); return b },
        maybeSingle() { single = true; limit = 1; return b },
        single() { single = true; limit = 1; return b },
        in(col, ids) { keyed = true; rec.builder.in(col, ids); return b },
        then(resolve, reject) {
          const where = rec.clauses.length ? `where ${rec.clauses.join(' and ')}` : ''
          const run = async () => {
            if (head || count) {
              if (!keyed) return { data: null, count: null, error: null }
              const r = await queryWithTimeout(`select count(*)::bigint as n from public."${table}" ${where}`, rec.params, 8000)
              return { data: head ? null : [], count: Number(r.rows[0]?.n ?? 0), error: null }
            }
            if (!keyed && !where) return { data: [], error: null }
            const r = await queryWithTimeout(`select ${cols} from public."${table}" ${where} ${order.length ? `order by ${order.join(', ')}` : ''} limit ${limit} offset ${offset}`, rec.params, 8000)
            return { data: single ? (r.rows[0] ?? null) : r.rows, error: null }
          }
          return run().then(resolve, (error) => resolve({ data: null, error: { message: String(error?.message || error) } })).then(undefined, reject)
        },
      }
      for (const m of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'ilike', 'like', 'not', 'or', 'overlaps', 'contains']) b[m] = (...a) => { rec.builder[m](...a); if (m === 'eq') keyed = true; return b }
      return b
    },
  }
}
const supabase = shimSupabase()
const ovDeps = { skipSnapshot: false, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }) }

const ffParam = (filters) => encodeURIComponent(JSON.stringify(filters))
const scope = (tab) => `/entity-graph?egs=${tab}&ff=${ffParam([{ field_key: 'campaign.membership', operator: 'is_any_of', value: [CID] }])}`
const SCENES = [
  // [name, route, theme, [w,h], action]
  ['01-landing-universe', '/entity-graph', 'dark', [1440, 900]],
  ['02-campaign-overview', `${scope('properties')}&egv=overview`, 'dark', [1440, 900]],
  ['03-campaign-overview-1920', `${scope('properties')}&egv=overview`, 'dark', [1920, 1080]],
  ['04-campaign-overview-light', `${scope('properties')}&egv=overview`, 'light', [1440, 900]],
  ['05-campaign-overview-property', `${scope('properties')}&egv=overview`, 'dark', [1920, 1080], 'scroll-property'],
  ['06-campaign-people', `${scope('people')}&egv=overview`, 'dark', [1920, 1080], 'scroll-wealth'],
  ['07-campaign-owners', `${scope('master_owners')}&egv=overview`, 'dark', [1440, 900]],
  ['08-campaign-grid-all-columns', `${scope('properties')}&egv=grid`, 'dark', [1920, 1080], 'grid'],
  ['09-campaign-grid-light', `${scope('properties')}&egv=grid`, 'light', [1440, 900], 'grid'],
  ['10-click-cross-filter', `${scope('properties')}&egv=overview`, 'dark', [1440, 900], 'click'],
  ['11-ultrawide', `${scope('properties')}&egv=overview`, 'dark', [2560, 1080]],
  ['12-reduced-motion', `${scope('people')}&egv=overview`, 'dark', [1440, 900], 'reduced'],
].filter(([n]) => !ONLY || ONLY.split(',').some((o) => n.startsWith(o)))

await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 25 * 60_000)
const fixtures = FIX ? JSON.parse(await fs.readFile(FIX, 'utf8')) : {}
const misses = new Set()
const timings = []
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = path.join(DIST, p)
  try { if (!(await fs.stat(file)).isFile()) throw 0 } catch { file = path.join(DIST, 'index.html') }
  res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
  res.end(await fs.readFile(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

const LIVE = {
  '/api/cockpit/entity-graph/overview': async (q) => {
    const body = await buildEntityGraphOverview(q, ovDeps)
    timings.push({ route: 'overview', tab: q.tab, sections: q.sections, ms: body.timings?.totalMs, total: body.total, statements: body.timings?.statements?.map((s) => `${s.label}=${s.ms}`).join(' ') })
    return { ok: true, ...body }
  },
  '/api/cockpit/entity-graph/campaign-scope': async (q) => ({ ok: true, scope: await getCampaignScopeSummary(q.campaign_id) }),
  '/api/cockpit/entity-graph/browse': async (q) => {
    const t0 = Date.now()
    const body = await browseEntityGraphPage(q, { supabase })
    timings.push({ route: 'browse', tab: q.tab, ms: Date.now() - t0, total: body.pagination?.total, rows: body.results?.length, attachErrors: body.attached?.errors?.map((e) => e.source) })
    return { ok: true, ...body }
  },
  '/api/cockpit/entity-graph/columns': async (q) => ({ ok: true, ...(await getEntityGraphColumnEnrichment(q, { supabase })) }),
  '/api/cockpit/entity-graph/outreach-state': async (q) => ({ ok: true, ...(await getEntityGraphOutreachState(q, { supabase })) }),
  '/api/cockpit/entity-graph/filter-catalog': async (q) => ({ ok: true, ...getEntityGraphFilterCatalog(q.tab || 'properties'), filterable_tabs: ENTITY_GRAPH_FILTERABLE_TABS }),
}

async function guard(page) {
  await page.route('**/*', async (r) => {
    const req = r.request()
    const u = new URL(req.url())
    const isApi = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
    if (isApi && req.method() !== 'GET') return r.abort()
    const live = LIVE[u.pathname]
    if (live) {
      try {
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(await live(Object.fromEntries(u.searchParams.entries()))) })
      } catch (e) {
        const status = e?.code === 'unsupported_entity_graph_filters' || e?.name === 'CampaignScopeError' ? 422 : 500
        return r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: e?.code || 'failed', message: String(e?.message || e).slice(0, 200) }) })
      }
    }
    if (u.pathname.startsWith('/api/cockpit/entity-graph/')) {
      const k = u.pathname
      const hit = Object.keys(fixtures).find((f) => f === k || f.startsWith(`${k}?`))
      if (hit) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[hit]) })
      misses.add(u.pathname)
      return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'fixture_missing' }) })
    }
    if (isApi || u.hostname.includes('googleapis') || u.hostname.includes('basemaps')) return r.abort()
    return r.continue()
  })
}

const browser = await chromium.launch()
const report = []
for (const [name, route, theme, [W, H], action] of SCENES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, serviceWorkers: 'block', reducedMotion: action === 'reduced' ? 'reduce' : 'no-preference' })
  await ctx.addInitScript((t) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      sessionStorage.clear()
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const s = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...s, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  // privacy in the artefacts: record identities (addresses / names) are blurred in every capture
  await page.addInitScript(() => {
    const css = '.egdk-cell-id, .egdk-cell-id * { filter: blur(5px) !important; }'
    const add = () => { const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st) }
    if (document.head) add(); else document.addEventListener('DOMContentLoaded', add)
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  await guard(page)
  const row = { name, theme, size: `${W}x${H}` }
  try {
    const t0 = Date.now()
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForSelector('.egdk', { timeout: 60_000 })
    if (action === 'grid' ) {
      await page.waitForSelector('.lc-grid__row', { timeout: 90_000 })
      // the campaign outcome cells fill from the same page / the keyed column read
      await page.waitForFunction(() => [...document.querySelectorAll('.lc-grid__row')].some((r) => { const c = r.querySelectorAll('.lc-grid__cell')[2]; return c && c.textContent && c.textContent.trim() !== '—' }), null, { timeout: 60_000 }).catch(() => { row.note = 'campaign cells still empty' })
      await page.waitForTimeout(1500)
      row.bands = await page.locator('.lc-grid__band:not(.is-empty)').allInnerTexts().catch(() => [])
      row.gridCount = await page.locator('.egdk-tablebar__count').first().innerText().catch(() => null)
    } else {
      await page.waitForSelector('.egov-mode', { timeout: 60_000 })
      await page.waitForFunction(() => document.querySelectorAll('.egov-mode .egov-kpi:not(.is-skeleton)').length >= 2 || document.querySelector('.egov-computing'), null, { timeout: 90_000 }).catch(() => { row.note = 'kpis still loading' })
      await page.waitForFunction(() => document.querySelectorAll('.egov-mode .egov-card:not(.is-skeleton)').length >= 4 || document.querySelector('.egov-computing'), null, { timeout: 90_000 }).catch(() => { row.note = 'cards still loading' })
      if (action?.startsWith('scroll-')) {
        const id = action.slice('scroll-'.length)
        const sec = page.locator(`[id$="-${id}"]`).first()
        await sec.scrollIntoViewIfNeeded()
        await page.waitForFunction((i) => document.querySelectorAll(`[id$="-${i}"] .egov-card:not(.is-skeleton)`).length >= 2, id, { timeout: 90_000 }).catch(() => { row.note = `${id} still loading` })
        await sec.evaluate((el) => el.scrollIntoView({ block: 'start' }))
      }
      if (action === 'click') {
        const sec = page.locator('[id$="-property"]').first()
        await sec.scrollIntoViewIfNeeded()
        await page.waitForSelector('.egov-card[data-field="properties.total_bedrooms"] .egov-col:not(.is-static)', { timeout: 90_000 })
        await page.waitForTimeout(600)
        const before = await page.locator('.egov-mode__id h2').first().innerText()
        // the "3" bar of Total Bedrooms: the chip lands in the rail, every chart refetches the narrower cohort
        const bar = page.locator('.egov-card[data-field="properties.total_bedrooms"] .egov-col:not(.is-static)').nth(3)
        await bar.scrollIntoViewIfNeeded()
        const label = await bar.getAttribute('aria-label')
        await bar.click()
        await page.waitForFunction((b) => { const t = document.querySelector('.egov-mode__id h2')?.textContent; return t && t !== b && !/^0 /.test(t) }, before, { timeout: 60_000 }).catch(() => { row.note = 'total did not change' })
        await page.waitForTimeout(1600)
        row.click = { bar: label, before, after: await page.locator('.egov-mode__id h2').first().innerText(), chips: await page.locator('.egdk-rail__active .lc-chip').allInnerTexts().catch(() => []), ff: decodeURIComponent(new URL(page.url()).searchParams.get('ff') || '') }
        await page.locator('.egov-mode__scroll').evaluate((el) => el.scrollTo(0, 0))
      }
      await page.waitForTimeout(1400)
      row.total = await page.locator('.egov-mode__id h2').first().innerText().catch(() => null)
      row.cards = await page.locator('.egov-mode .egov-card:not(.is-skeleton)').count()
      row.sensitive = await page.locator('.egov-mode .egov-card.is-sensitive').count()
    }
    row.banner = await page.locator('.egdk-campaign strong').first().innerText().then((t) => (t ? `${t.length} chars` : null)).catch(() => null)
    row.ms = Date.now() - t0
    await page.screenshot({ path: path.join(OUT, `${name}.png`) })
  } catch (e) {
    row.failed = String(e.message).slice(0, 200)
    await page.screenshot({ path: path.join(OUT, `${name}-failed.png`) }).catch(() => {})
  }
  if (errors.length) row.pageErrors = errors.slice(0, 4)
  report.push(row)
  console.log(JSON.stringify(row))
  await ctx.close()
}
await browser.close()
server.close()
clearTimeout(watchdog)
const slow = [...dbLog].sort((a, b) => b.ms - a.ms).slice(0, 12)
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ report, timings, misses: [...misses], db: { statements: dbLog.length, maxRows: Math.max(0, ...dbLog.map((d) => d.rows ?? 0)), slowest: slow } }, null, 1))
console.log('misses:', [...misses].join(', ') || 'none', '· db statements:', dbLog.length, '· slowest:', JSON.stringify(slow.slice(0, 5)))
process.exit(0)
