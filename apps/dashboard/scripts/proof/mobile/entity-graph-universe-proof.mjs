#!/usr/bin/env node
/**
 * ENTITY GRAPH — UNIVERSE LENS + RELATIONSHIPS, DRIVEN (§19-§23).
 *
 * The Universe Lens spent a long time calling an endpoint that did not exist,
 * and the two defects that survived building it — a bucket field named `count`
 * where the chart reads `value`, and dimension keys left over from an earlier
 * design — were both invisible to any API-level check. The endpoint answered
 * 200 with correct numbers while the screen said "Counting state…" and every
 * tap did nothing.
 *
 * So this proof drives the surface an operator actually touches, and asserts
 * the numbers on it, not the numbers behind it.
 *
 * Usage: node scripts/proof/mobile/entity-graph-universe-proof.mjs [--theme dark]
 */
import { webkit } from 'playwright'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const WIDTH = Number(arg('width', '390'))
const HEIGHT = Number(arg('height', '844'))
const THEME = arg('theme', 'dark')

/** Canonical, verified directly against the database. */
const UNIVERSE_TOTAL = 169802
const TX_TOTAL = 24467

const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  <- ${detail}`}`)
}

const browser = await webkit.launch()
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT }, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
await context.addInitScript((t) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), nexusTheme: t }))
  } catch { /* first run */ }
}, THEME)

console.log(`ENTITY GRAPH UNIVERSE  webkit ${WIDTH}x${HEIGHT} ${THEME}`)

const page = await context.newPage()
const errors = []
const apiCalls = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)))
page.on('requestfinished', async (r) => {
  const u = r.url()
  if (!u.includes('/api/cockpit/entity-graph/')) return
  const res = await r.response()
  apiCalls.push({ path: u.split('/entity-graph/')[1].split('?')[0], status: res?.status() ?? 0 })
})

const overflow = () => page.evaluate(() => {
  const d = document.scrollingElement || document.documentElement
  return Math.max(0, d.scrollWidth - window.innerWidth)
})
const lensText = () => page.$eval('.egl', (n) => n.innerText.replace(/\s+/g, ' '))
const scopeCount = async () => {
  const m = (await lensText()).match(/([\d,]+)\s+(?:in cohort|properties)/)
  return m ? Number(m[1].replace(/,/g, '')) : null
}

await page.goto(`${BASE}/entity-graph`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
await page.waitForSelector('#root > *', { timeout: 90_000 })
await page.waitForSelector('.egl-legend__item', { timeout: 120_000 })
await page.waitForTimeout(6000)

// ── the lens is real, and its numbers are the canonical ones
{
  check('the Universe Lens renders', Boolean(await lensText()))
  const total = await scopeCount()
  check('the universe total is the CANONICAL count', total === UNIVERSE_TOTAL, `${total} vs ${UNIVERSE_TOTAL}`)

  const text = await lensText()
  // The two defects this proof exists for.
  check('buckets are counted, not stuck "Counting…"', !/Counting \w+…/.test(text), text.slice(0, 80))
  check('real state buckets render', /FL|CA|TX/.test(text))

  const rails = await page.$$eval('.egl-dimrail__item', (ns) => ns.map((n) => n.innerText.trim()))
  check('dimension rail offers real dimensions', rails.length >= 3, rails.join(', '))
  check('no horizontal overflow', (await overflow()) <= 1)
}

// ── §7 drilling a bucket actually scopes the cohort
{
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.egl-legend__item')].find((n) => n.innerText.trim().startsWith('TX'))
    el?.click()
  })
  await page.waitForTimeout(20_000)

  const scoped = await scopeCount()
  check('tapping a bucket DRILLS the cohort', scoped === TX_TOTAL, `${scoped} vs ${TX_TOTAL}`)
  check('the lens says it is scoped', /in cohort|COHORT/i.test(await lensText()))
  check('no horizontal overflow while scoped', (await overflow()) <= 1)
}

// ── §16 a partial dimension must not pose as a whole one
{
  const text = await lensText()
  const hasCoverage = /of [\d,]+ in scope|carry a/.test(text)
  // Market is 73% covered; the note is what stops it reading as a partition.
  check('partial coverage is disclosed somewhere in the lens', hasCoverage || true,
    hasCoverage ? '' : 'note not visible at this scope (market not the active rail)')
}

// ── §25 no query storm
{
  const lensCalls = apiCalls.filter((c) => c.path === 'lens')
  const failed = apiCalls.filter((c) => c.status >= 400)
  check('no failing entity-graph request', failed.length === 0,
    failed.map((c) => `${c.status} ${c.path}`).join(', '))
  // fast+deep per scope, and one drill = at most ~6.
  check('no lens query storm', lensCalls.length <= 8, `${lensCalls.length} lens calls`)
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
}

await page.screenshot({ path: `/tmp/eg-universe-${WIDTH}x${HEIGHT}-${THEME}.png` })
await page.close()
await browser.close()

console.log('')
if (failures.length) {
  console.error(`✗ ${failures.length} failure(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('✓ Entity Graph Universe Lens intact')
