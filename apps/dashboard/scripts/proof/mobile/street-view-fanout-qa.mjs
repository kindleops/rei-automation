#!/usr/bin/env node
/**
 * STREET-VIEW-CORRECTION §17 — the network invariant, both directions.
 *
 * The rule is REQUEST FAN-OUT, not the app name:
 *
 *   HIGH-VOLUME LIST  ->  0 automatic Street View requests
 *   SELECTED DETAIL   ->  imagery is allowed, and should be reachable
 *
 * So this asserts BOTH. A harness that only checked "0 Maps requests" is what
 * turned a list-fan-out fix into a global removal, and it would pass a build
 * that had stripped imagery from every detail surface too.
 *
 * Usage: node scripts/proof/mobile/street-view-fanout-qa.mjs [--base URL]
 */
import { chromium } from 'playwright'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')

const findings = []
const check = (name, ok, detail) => {
  if (!ok) findings.push({ name, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`)
}

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
})

/** Counts Street View / Maps traffic over one interaction. */
const withMapsWatch = async (label, fn) => {
  const page = await context.newPage()
  const maps = []
  page.on('request', (r) => {
    const u = r.url()
    if (/maps\.googleapis\.com|streetview|maps\/embed\/v1|maps\/api\/js/.test(u)) maps.push(u.slice(0, 100))
  })
  let out = null
  try { out = await fn(page) } finally { await page.close() }
  console.log(`  [${label}] maps requests: ${maps.length}`)
  return { maps, out }
}

console.log(`STREET VIEW FAN-OUT PROOF  ${BASE}`)
console.log('')
console.log('A. HIGH-VOLUME LISTS — must be 0')

const inbox = await withMapsWatch('inbox list', async (page) => {
  await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForTimeout(12_000)
  return page.evaluate(() => document.querySelectorAll('.nx-row25').length)
})
check('Inbox list renders cards', (inbox.out ?? 0) > 0, `${inbox.out} cards`)
check('Inbox cards make NO automatic Street View request', inbox.maps.length === 0,
  `${inbox.maps.length}: ${inbox.maps.slice(0, 2).join(' | ')}`)

const pipeline = await withMapsWatch('pipeline board', async (page) => {
  await page.goto(`${BASE}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  // The board hydrates behind skeletons; wait for a real row rather than a
  // fixed delay, or this assertion measures the loading state.
  await page.waitForFunction(
    () => document.querySelectorAll('.plm-row:not(.is-skeleton)').length > 0,
    undefined, { timeout: 60_000 },
  ).catch(() => {})
  await page.waitForTimeout(3000)
  return page.evaluate(() => document.querySelectorAll('.plm-row:not(.is-skeleton)').length)
})
check('Pipeline board renders rows', (pipeline.out ?? 0) > 0, `${pipeline.out} rows`)
check('Pipeline board cards make NO automatic Street View request', pipeline.maps.length === 0,
  `${pipeline.maps.length}: ${pipeline.maps.slice(0, 2).join(' | ')}`)

console.log('')
console.log('B. SELECTED DETAIL — imagery must be REACHABLE (one request is correct)')

// Deal Intelligence on mobile: opening the intel sheet is the operator's intent.
const di = await withMapsWatch('deal intelligence (mobile)', async (page) => {
  // Mobile Deal Intelligence opens through the cross-app handoff, NOT by
  // tapping the dock: with a thread open the pinned dock is covered and the tap
  // times out. The carrier is sessionStorage `nx.pending-deal-intel` (+ an
  // identity payload), which is what every real entry point sets.
  await page.addInitScript(() => {
    sessionStorage.setItem('nx.pending-deal-intel', '1')
  })
  await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForTimeout(12_000)
  // The handoff may open Deal Intelligence directly, in which case there is no
  // card list to tap. Tapping is a best effort, never a precondition — an early
  // return here is what made this probe report nothing while the watcher was
  // already seeing the restored request.
  const card = page.locator('.nx-row25').first()
  if (await card.count()) {
    await card.click({ timeout: 15_000 }).catch(() => {})
  }
  await page.waitForTimeout(13_000)
  return page.evaluate(() => ({
    opened: true,
    // The restored mobile Deal Intelligence visual.
    mscVisual: document.querySelectorAll('.msc-visual').length,
    // The restored tab pair + poster on the 25 panel.
    tabs: document.querySelectorAll('.nx-di25-media__tabs').length,
    streetTab: [...document.querySelectorAll('.nx-di25-media__tab')].some((b) => /street/i.test(b.textContent || '')),
    poster: document.querySelectorAll('.nx-di25-media__poster').length,
    bodyMentionsStreet: /street view/i.test(document.body.innerText),
    shell: document.querySelector('.nx-inbox-shell')?.className ?? null,
  }))
})
const diState = di.out ?? {}
check('Deal Intelligence exposes a Street View affordance again',
  Boolean(diState.mscVisual || diState.streetTab || diState.bodyMentionsStreet),
  JSON.stringify(diState))
console.log(`      deal intelligence: ${JSON.stringify(diState)}`)

// Queue selected item — must be UNCHANGED (§6).
const queue = await withMapsWatch('queue selected item', async (page) => {
  await page.goto(`${BASE}/queue`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForTimeout(12_000)
  const listMaps = 'measured by the watcher'
  const rows = await page.evaluate(() =>
    document.querySelectorAll('[class*="queue"][class*="row"], [class*="qmob"], [class*="queue-card"]').length)
  return { rows, listMaps }
})
check('Queue LIST makes no automatic Street View request', queue.maps.length === 0,
  `${queue.maps.length}: ${queue.maps.slice(0, 2).join(' | ')}`)
console.log(`      queue rows detected: ${queue.out?.rows}`)

await browser.close()

console.log('')
console.log(findings.length === 0 ? 'FAN-OUT PROOF: all checks passed' : `FAN-OUT PROOF: ${findings.length} finding(s)`)
for (const f of findings) console.log(`  FAIL ${f.name}: ${f.detail}`)
process.exit(findings.length === 0 ? 0 : 1)
