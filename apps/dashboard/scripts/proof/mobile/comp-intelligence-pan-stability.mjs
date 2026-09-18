#!/usr/bin/env node
/**
 * §48 — THE ANALYSIS MUST NOT CHANGE BECAUSE THE OPERATOR MOVED THE MAP.
 *
 * The acceptance condition for Comp Intelligence is not that it renders. It is
 * that a real property can be analysed from a phone and the analysis survives
 * the map being panned: same subject, same comparables, same inclusion state,
 * same valuation, and — provably — no comp-discovery network call.
 *
 * Two structural facts make this testable rather than hopeful:
 *   - the endpoint `/properties/:id/comp-intelligence` accepts only
 *     `radius`, `monthsBack` and `assetClass`. There is no bounds/bbox/viewport
 *     parameter, so the viewport CANNOT be a comp query.
 *   - the fetch effect in `useCompIntelligence` depends on
 *     propertyId/radius/monthsBack/assetClass and identity — never on map state.
 *
 * This proves both hold in a running WebKit browser, which is what the operator
 * actually uses.
 *
 * Usage: node scripts/proof/mobile/comp-intelligence-pan-stability.mjs \
 *          [--property 2172967028] [--base http://localhost:5174] [--engine webkit]
 * Exits non-zero on failure.
 */
import { webkit, chromium } from 'playwright'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const PROPERTY = arg('property', '2172967028')
const ENGINE = arg('engine', 'webkit')
const WIDTH = Number(arg('width', '390'))
const HEIGHT = Number(arg('height', '844'))
const THEME = arg('theme', 'dark')

const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  <- ${detail}`}`)
  return ok
}

const browser = await (ENGINE === 'webkit' ? webkit : chromium).launch()
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  isMobile: ENGINE !== 'webkit', // WebKit rejects isMobile without deviceScaleFactor support
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
await context.addInitScript((t) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), nexusTheme: t }))
  } catch { /* first run */ }
}, THEME)

const page = await context.newPage()
const compRequests = []
const errors = []
page.on('request', (r) => {
  const u = r.url()
  if (/\/comp-intelligence(\?|$)/.test(u) || /get_comp_candidates_for_subject/.test(u)) compRequests.push(u)
})
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)))

console.log(`COMP PAN STABILITY  ${ENGINE}  ${WIDTH}x${HEIGHT}  property=${PROPERTY}`)

await page.goto(`${BASE}/comp-intelligence?property_id=${PROPERTY}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
await page.waitForSelector('.ci-m', { timeout: 120_000 })
// The analysis is asynchronous; wait for the rail to hold comps rather than a stopwatch.
await page.waitForFunction(
  () => Number(document.querySelector('[data-comp-intelligence="mobile"]')?.getAttribute('data-evidence-count') || 0) > 0,
  { timeout: 120_000 },
).catch(() => undefined)
await page.waitForTimeout(4000)

/** Everything the acceptance contract compares, read from the rendered product. */
const snapshot = () => page.evaluate(() => {
  const root = document.querySelector('[data-comp-intelligence="mobile"]')
  const text = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? null
  return {
    subject: root?.getAttribute('data-property-id') ?? null,
    evidenceCount: Number(root?.getAttribute('data-evidence-count') || 0),
    mappedCount: Number(root?.getAttribute('data-mapped-count') || 0),
    // Comp identity comes from the rail's own ids — never an index.
    compIds: [...document.querySelectorAll('[data-rail-id]')].map((n) => n.getAttribute('data-rail-id')),
    valuation: text('.ci-m__value'),
    valuationBlock: text('.ci-m__valuation'),
  }
})

const before = await snapshot()
const requestsAfterLoad = compRequests.length
console.log(`  loaded: subject=${before.subject} comps=${before.evidenceCount} mapped=${before.mappedCount}`)
console.log(`  comp ids: ${JSON.stringify(before.compIds)}`)
console.log(`  valuation: ${before.valuation}`)

check('the route resolved the requested subject', before.subject === PROPERTY, `got ${before.subject}`)
check('a real comp set loaded', before.evidenceCount > 0, `${before.evidenceCount} comps`)
check('the valuation rendered', Boolean(before.valuation), `${before.valuation}`)

// ── pan the map significantly, with no filter change whatsoever
const canvas = await page.$('.ci-map-canvas canvas, .ci-m__map canvas, canvas.maplibregl-canvas')
check('the map rendered a canvas', Boolean(canvas))
if (canvas) {
  const box = await canvas.boundingBox()
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  // Three long drags — far enough that a viewport-driven query would certainly fire.
  for (const [dx, dy] of [[-160, -120], [-160, 40], [-140, 90]]) {
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + dx, cy + dy, { steps: 24 })
    await page.mouse.up()
    await page.waitForTimeout(1200)
  }
}
await page.waitForTimeout(5000)

const after = await snapshot()
const requestsDuringPan = compRequests.length - requestsAfterLoad

console.log(`  after pan: subject=${after.subject} comps=${after.evidenceCount}`)
console.log(`  comp ids: ${JSON.stringify(after.compIds)}`)
console.log(`  valuation: ${after.valuation}`)
console.log(`  comp-discovery requests during pan: ${requestsDuringPan}`)

check('the subject is unchanged by panning', before.subject === after.subject,
  `${before.subject} -> ${after.subject}`)
check('the comp set is identical after panning',
  JSON.stringify(before.compIds) === JSON.stringify(after.compIds),
  `${JSON.stringify(before.compIds)} -> ${JSON.stringify(after.compIds)}`)
check('the comp count is unchanged', before.evidenceCount === after.evidenceCount,
  `${before.evidenceCount} -> ${after.evidenceCount}`)
check('the valuation is unchanged', before.valuation === after.valuation,
  `${before.valuation} -> ${after.valuation}`)
// The load-bearing one: the viewport is not a query.
check('panning triggered NO comp-discovery network call', requestsDuringPan === 0,
  `${requestsDuringPan} request(s)`)

const overflow = await page.evaluate(() => {
  const doc = document.scrollingElement || document.documentElement
  return Math.max(0, doc.scrollWidth - window.innerWidth)
})
check('no horizontal overflow', overflow <= 1, `+${overflow}px`)
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))

// ── §8 card -> marker, and §10 comp detail with a working Back
if (after.compIds.length > 0) {
  const targetId = after.compIds[1] ?? after.compIds[0]
  await page.click(`[data-rail-id="${targetId}"]`).catch(() => undefined)
  await page.waitForTimeout(2500)

  const selection = await page.evaluate((id) => {
    const card = document.querySelector(`[data-rail-id="${id}"]`)
    return {
      // Identity drives selection, never a list index.
      selected: card?.classList.contains('is-selected') || card?.getAttribute('aria-selected') === 'true',
      detailOpen: Boolean(document.querySelector('.ci-dl, [class*="detail-layer"]')),
      compsStillThere: [...document.querySelectorAll('[data-rail-id]')].map((n) => n.getAttribute('data-rail-id')),
    }
  }, targetId)

  check('tapping a comp card selects that exact comp', selection.selected || selection.detailOpen,
    `selected=${selection.selected} detail=${selection.detailOpen}`)
  check('selecting a comp does not regenerate the comp set',
    JSON.stringify(selection.compsStillThere) === JSON.stringify(after.compIds))

  // §18 — Back must leave a nested comp state, not the application.
  const backBtn = await page.$('.nx-mobile-command-dock__btn--back')
  if (backBtn && selection.detailOpen) {
    await backBtn.click()
    await page.waitForTimeout(2000)
    const closed = await page.evaluate(() => !document.querySelector('.ci-dl, [class*="detail-layer"]'))
    const stillOnComps = await page.evaluate(() => Boolean(document.querySelector('.ci-m')))
    check('Back closes comp detail and stays in Comp Intelligence', closed && stillOnComps,
      `closed=${closed} onComps=${stillOnComps}`)
  }
}

// ── §17 context X returns to universal Comp Intelligence, in place
const clearBtn = await page.$('.nx-mobile-command-dock__context-clear')
check('a context chip is present for a contextual route', Boolean(clearBtn))
if (clearBtn) {
  await clearBtn.click()
  await page.waitForTimeout(3000)
  const cleared = await page.evaluate(() => ({
    url: location.pathname + location.search,
    chip: Boolean(document.querySelector('.nx-mobile-command-dock__context')),
    stillComps: Boolean(document.querySelector('.nx-fullscreen-app-shell.is-view-comp_intelligence, .ci-m, [data-comp-intelligence]')),
    staleSubject: document.querySelector('[data-comp-intelligence="mobile"]')?.getAttribute('data-property-id') ?? null,
  }))
  check('context X removes the property from the URL', !/property_id=/.test(cleared.url), cleared.url)
  check('context X clears the chip', !cleared.chip)
  check('context X stays inside Comp Intelligence', cleared.stillComps)
  check('context X leaves no stale subject', !cleared.staleSubject, `subject=${cleared.staleSubject}`)
}

// ── §13/§14 an EXPLICIT filter change is the only thing that may move the set
{
  await page.goto(`${BASE}/comp-intelligence?property_id=${PROPERTY}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('.ci-m', { timeout: 120_000 })
  await page.waitForTimeout(6000)
  const beforeFilter = await snapshot()
  const requestsBeforeFilter = compRequests.length

  await page.click('.ci-m__filter-btn').catch(() => undefined)
  await page.waitForSelector('.ci-mfs', { timeout: 30_000 }).catch(() => undefined)
  await page.waitForTimeout(1500)

  // Opening the sheet alone must change nothing (§3).
  const openedOnly = await snapshot()
  check('opening the filter sheet does not change the analysis',
    openedOnly.subject === beforeFilter.subject
      && JSON.stringify(openedOnly.compIds) === JSON.stringify(beforeFilter.compIds),
    'sheet open altered the comp set')

  // Pick a radius chip that is NOT the current one.
  const changed = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.ci-mfs__chip')]
    const target = chips.find((c) => !c.classList.contains('is-active'))
    if (!target) return null
    const label = target.textContent?.trim() ?? null
    target.click()
    return label
  })
  await page.waitForTimeout(9000)

  const afterFilter = await snapshot()
  const requestsFromFilter = compRequests.length - requestsBeforeFilter
  console.log(`  filter changed to: ${changed}  requests: ${requestsFromFilter}  comps ${beforeFilter.evidenceCount} -> ${afterFilter.evidenceCount}`)

  check('an explicit filter change DOES re-run discovery', changed === null || requestsFromFilter > 0,
    `${requestsFromFilter} request(s) for change "${changed}"`)
  check('a filter change keeps the same subject', afterFilter.subject === beforeFilter.subject,
    `${beforeFilter.subject} -> ${afterFilter.subject}`)
}

// ── §16 the bare route is a valid universal state, not a stale-context grab
{
  const universal = await context.newPage()
  await universal.goto(`${BASE}/comp-intelligence`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await universal.waitForSelector('#root > *', { timeout: 90_000 })
  await universal.waitForTimeout(6000)
  const u = await universal.evaluate(() => ({
    url: location.pathname + location.search,
    subject: document.querySelector('[data-comp-intelligence="mobile"]')?.getAttribute('data-property-id') ?? null,
    chip: Boolean(document.querySelector('.nx-mobile-command-dock__context')),
    body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
  }))
  check('the bare route carries no property in the URL', !/property_id=/.test(u.url), u.url)
  check('universal mode does not acquire a subject from ambient state', !u.subject, `subject=${u.subject}`)
  check('universal mode shows no context chip', !u.chip)
  check('universal mode states what it needs', /select a property|choose|no subject/i.test(u.body), u.body)
  await universal.close()
}

await page.screenshot({ path: `/tmp/comps-${ENGINE}-${WIDTH}-${THEME}.png` })
await browser.close()

console.log('')
if (failures.length) {
  console.error(`✗ ${failures.length} failure(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`✓ analysis survived the map: subject, comp set and valuation identical, 0 discovery calls`)
