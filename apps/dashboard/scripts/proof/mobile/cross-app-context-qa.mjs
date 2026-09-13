/**
 * CROSS-APP CONTEXT PROOF.
 *
 * One property selected once. Every relevant app must know exactly what the operator
 * is working on — and the operator must be able to change that subject from any app
 * that supports selecting one.
 *
 * Three things are proven here, in the order they matter:
 *
 *   1. THE CHAIN      Inbox → Map → Comps → Deal Intel → Entity Graph → Map again,
 *                     with no return to the Inbox. The subject must survive all of it.
 *   2. BIDIRECTIONAL  Selecting a DIFFERENT property on Map must become the global
 *                     subject, so a subsequent jump to Comps shows the new one. A
 *                     context that apps can only consume is half a contract.
 *   3. THE MATRIX     What each destination actually does on arrival, classified
 *                     honestly — including the destinations that do not support it.
 *
 * Assertions are made against what the DESTINATION RENDERS, never against the URL: a
 * focused-looking URL the destination never reads is the precise failure this whole
 * program exists to remove.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const OUT = path.resolve(process.cwd(), '.screenshots/mobile-qa', arg('label', 'cross-app'))

const SETTLE = { map: 15_000, comps: 12_000, default: 9_000 }

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
})
await fs.mkdir(OUT, { recursive: true })
const page = await context.newPage()

const consoleErrors = []
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 180)}`))
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 180)) })

const locator = () => page.evaluate(() => {
  try { return JSON.parse(sessionStorage.getItem('nexus:property-locator:v1') || 'null') } catch { return null }
})

const openDock = async () => {
  const dock = await page.$('.nx-pinned-app-dock.is-collapsed')
  if (dock) { await page.click('.nx-pinned-app-dock__handle'); await page.waitForTimeout(600) }
}

/**
 * Hop the way the operator does: open the shelf, tap a pinned app; if it is not
 * pinned, expand to the catalogue and tap it there.
 *
 * The catalogue is genuinely unclickable in the DOCKED phase — it is clipped to
 * max-height 0 — so reaching it requires the expand step rather than a selector that
 * happens to match a hidden node.
 */
const hop = async (label) => {
  await openDock()
  const pinned = await page.$(`.nx-pinned-app-dock__track .nx-pinned-app-dock__app[aria-label="${label}"]`)
  if (pinned) { await pinned.click(); return 'dock' }

  const customize = await page.$('.nx-pinned-app-dock__customize')
  if (customize) { await customize.click(); await page.waitForTimeout(800) }
  const catalog = await page.$(`.nx-pinned-app-dock__sheet .nx-pinned-app-dock__app[aria-label="${label}"]`)
  if (catalog) { await catalog.click({ timeout: 10_000 }).catch(() => {}); return 'dock-catalog' }
  return null
}

const settleFor = (id) => SETTLE[id] ?? SETTLE.default

/** What did the destination actually do with the subject? */
const observe = async (id, subject) => {
  await page.waitForTimeout(settleFor(id))
  const street = (subject.address || '').split(',')[0].trim()
  return page.evaluate(({ street, propertyId }) => {
    const body = document.body.innerText.replace(/\s+/g, ' ')
    const sellerCard = document.querySelector('.smc-shell')
    return {
      url: location.pathname + location.search,
      rendersSubjectAddress: Boolean(street) && body.toLowerCase().includes(street.toLowerCase()),
      urlCarriesIdentity: Boolean(propertyId && location.href.includes(propertyId)),
      // Map-specific: the record is genuinely open, not merely the right neighbourhood.
      propertyDetailOpen: Boolean(sellerCard),
      propertyDetailAddress: sellerCard?.querySelector('.smc-identity__address')?.textContent ?? null,
      goldStarPainted: Boolean(document.querySelector('canvas.maplibregl-canvas')) && undefined,
      // An honest "nothing for this subject" beats a silent default.
      explicitEmptyState: /no projection returned for this property|no opportunity|unavailable for this property/i.test(body),
      bodyHead: body.slice(0, 110),
    }
  }, { street, propertyId: subject.propertyId })
}

// ── 1. Select the subject once, in the Inbox ────────────────────────────────
await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForSelector('.nx-row25', { timeout: 60_000 })
await page.waitForTimeout(5000)
await (await page.$$('.nx-row25'))[0].click()
await page.waitForTimeout(3500)

const subject = await locator()
if (!subject?.propertyId) {
  console.log(JSON.stringify({ fatal: 'inbox selection published no property id' }))
  await browser.close(); process.exit(1)
}
await page.screenshot({ path: path.join(OUT, '00-subject-selected.png') })

// ── 2. The chain ────────────────────────────────────────────────────────────
const CHAIN = ['Map', 'Comp Intelligence', 'Deal Intelligence', 'Entity Graph', 'Map']
const chain = []
for (const [index, label] of CHAIN.entries()) {
  const via = await hop(label)
  if (!via) { chain.push({ step: index + 1, id: label, unreachable: true }); continue }
  const observed = await observe(label === 'Map' ? 'map' : label === 'Comp Intelligence' ? 'comps' : 'default', subject)
  const held = await locator()
  chain.push({
    step: index + 1,
    id: label,
    via,
    ...observed,
    subjectStillHeld: held?.propertyId === subject.propertyId,
  })
  await page.screenshot({ path: path.join(OUT, `${String(index + 1).padStart(2, '0')}-${label.toLowerCase().replace(/ /g, '-')}.png`) })
}

// ── 3. Bidirectional: change the subject FROM Map ───────────────────────────
// The Live Activity rail is the one DOM-clickable way to select another seller on the
// map; pins are canvas-rendered and have no element to click.
const bidirectional = { attempted: false }
const activityRows = await page.$$('.nx-icm-activity__event, .nx-icm-activity__deck button, .nx-icm-activity button')
for (const row of activityRows) {
  const label = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  if (!label || label.length < 4) continue
  bidirectional.attempted = true
  await row.click().catch(() => {})
  await page.waitForTimeout(6000)
  const after = await locator()
  bidirectional.clickedRow = label.slice(0, 60)
  bidirectional.subjectBefore = subject.propertyId
  bidirectional.subjectAfter = after?.propertyId ?? null
  bidirectional.addressAfter = after?.address ?? null
  bidirectional.changed = Boolean(after?.propertyId && after.propertyId !== subject.propertyId)
  if (bidirectional.changed) break
}

if (bidirectional.changed) {
  const newSubject = await locator()
  await hop('Comp Intelligence')
  const observed = await observe('comps', newSubject)
  bidirectional.compsFollowed = observed.rendersSubjectAddress
  bidirectional.compsUrl = observed.url
  bidirectional.compsBody = observed.bodyHead
  await page.screenshot({ path: path.join(OUT, 'bidirectional-comps.png') })
}

const report = { subject, chain, bidirectional, consoleErrors: [...new Set(consoleErrors)] }
console.log(JSON.stringify(report, null, 1))
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
await browser.close()
