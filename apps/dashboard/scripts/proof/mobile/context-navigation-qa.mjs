/**
 * CONTEXT-PRESERVING NAVIGATION PROOF.
 *
 * The operator requirement is specific: select a property anywhere, tap any
 * destination, arrive at THAT property. This drives it for real — select a thread in
 * the Inbox, then jump to each destination through the dock/launcher and assert the
 * arrived-at surface is showing the same property.
 *
 * It asserts on the ADDRESS rendered by the destination, not on the URL, because a
 * focused-looking URL that the destination never reads is exactly the failure mode
 * this program is trying to remove.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const OUT = path.resolve(process.cwd(), '.screenshots/mobile-qa', arg('label', 'context'))

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
})
await fs.mkdir(OUT, { recursive: true })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

const readLocator = () => page.evaluate(() => {
  try { return JSON.parse(sessionStorage.getItem('nexus:property-locator:v1') || 'null') } catch { return null }
})

await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForSelector('.nx-pinned-app-dock__rail', { timeout: 60_000 })
await page.waitForTimeout(6000)

// ── 1. Select a real thread. This is the ONE choke point that publishes the locator.
// `.nx-row25` is the live mobile inbox row (role=button inside .nx-row-pick).
const rows = await page.$$('.nx-row25')
if (rows.length === 0) {
  console.log(JSON.stringify({ fatal: 'no inbox rows rendered — cannot prove context navigation' }))
  await browser.close()
  process.exit(1)
}
await rows[0].click()
await page.waitForTimeout(3500)

const locator = await readLocator()
const subject = {
  address: locator?.address ?? null,
  propertyId: locator?.propertyId ?? null,
  threadKey: locator?.threadKey ?? null,
}
await page.screenshot({ path: path.join(OUT, '01-selected.png') })

/** Did the destination actually land on the subject property? */
const assertFocused = async (id) => {
  // Comp Intelligence hydrates its subject, comps and map in ~10s on a cold dev
  // server; a 5s settle reported a populated workspace as empty.
  await page.waitForTimeout(11000)
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  const url = page.url()
  const needle = (subject.address || '').split(',')[0].trim()
  return {
    id,
    url: url.replace(BASE, ''),
    // The address the operator selected, rendered by the destination.
    showsSubjectAddress: Boolean(needle) && text.toLowerCase().includes(needle.toLowerCase()),
    // A destination that carries the id in its URL is focused by construction.
    urlCarriesIdentity: Boolean(
      (subject.propertyId && url.includes(subject.propertyId))
      || (subject.threadKey && url.includes(encodeURIComponent(subject.threadKey))),
    ),
    locatorSurvived: Boolean(await readLocator()),
    // A destination that says "for this property" HAS the subject; it simply has no
    // data for it. That is a data finding, not a navigation finding, and conflating
    // the two is how a working jump gets reported as broken.
    hasSubjectButNoData: /no projection returned for this property|unavailable for this property/i.test(text),
  }
}

const results = []

/**
 * A CONTINUOUS CHAIN, with no return to the Inbox between hops.
 *
 * Bouncing back to /inbox between destinations was not just slower — it re-entered the
 * thread list and could land on a different row, so a later hop was asserted against a
 * property the operator had not selected. The operator does not do that either: they
 * pick a deal once and then move through the apps carrying it.
 */
const hopViaRail = async (label) => {
  const button = await page.$(`.nx-pinned-app-dock__rail-app[aria-label="${label}"]`)
  if (!button) return false
  await button.click()
  return true
}

const hopViaLauncher = async (label) => {
  const launcher = await page.$('.nx-pinned-app-dock__rail-app.is-launcher')
  if (!launcher) return false
  await launcher.click()
  await page.waitForSelector('.nx-app-launcher', { timeout: 10_000 })
  await page.waitForTimeout(500)
  const tile = await page.$(`.nx-app-launcher__tile:has(.nx-app-launcher__label:text-is("${label}"))`)
  if (!tile) return false
  await tile.click()
  return true
}

const CHAIN = [
  { label: 'Map', via: hopViaRail },
  { label: 'Comp Intelligence', via: hopViaLauncher },
  { label: 'Pipeline', via: hopViaRail },
  { label: 'Deal Intelligence', via: hopViaLauncher },
  { label: 'Entity Graph', via: hopViaRail },
]

for (const hop of CHAIN) {
  const opened = await hop.via(hop.label)
  if (!opened) { results.push({ id: hop.label, missing: true }); continue }
  results.push(await assertFocused(hop.label))
  await page.screenshot({ path: path.join(OUT, `${hop.label.toLowerCase().replace(/ /g, '-')}.png`) })
}

console.log(JSON.stringify({ subject, results, errors }, null, 1))
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ subject, results, errors }, null, 2))
await browser.close()
