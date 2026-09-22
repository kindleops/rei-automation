/**
 * §1 — THE PROPERTY INTELLIGENCE VALUATION MATCHES THE CARD THAT OPENED IT.
 *
 * The dossier used to render a property with no valuation while the Inbox card
 * for the same thread displayed one, because the sheet derived its row on every
 * render from `threads` -- which is re-filtered while a conversation is open,
 * so a full record on one pass became nothing on the next. The fix is a
 * snapshot captured once at selection; this proves the two agree.
 *
 * Each thread gets its OWN page load. An earlier version reused one page and
 * walked back through the list between threads, and the third iteration failed
 * on a stale UI state rather than on anything about valuations -- the harness
 * was testing its own navigation, not the claim.
 *
 * READ ONLY: opens a thread and a sheet. No send, no mutation.
 */
import { chromium } from 'playwright'

const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '--base=http://localhost:5174').split('=')[1]

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
})

const listPage = await ctx.newPage()
await listPage.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
await listPage.waitForFunction(() => document.querySelectorAll('.nx-row25').length > 0,
  undefined, { timeout: 180_000, polling: 400 })
await listPage.waitForTimeout(2000)

const candidates = await listPage.evaluate(() =>
  [...document.querySelectorAll('.nx-row25')]
    .map((r, i) => ({
      i,
      name: (r.querySelector('.nx-row25__name')?.textContent || '').trim().slice(0, 24),
      cardValue: (r.querySelector('.nx-card-assetline__value')?.textContent || '').trim(),
      suppressed: Boolean(r.querySelector('.nx-card-state.is-suppressed')),
    }))
    .filter((x) => /\$\d/.test(x.cardValue))
    /*
     * Skip suppressed contacts. Their composer is disabled by design -- you
     * cannot message someone who opted out -- and Quick Actions goes with it,
     * so the dossier is not reachable by this path for them. That is a routing
     * question, not a valuation one, and it is recorded as backlog rather than
     * allowed to fail a proof about numbers agreeing.
     */
    .filter((x) => !x.suppressed)
    .slice(0, 3))
await listPage.close()

console.log(`  threads with a nonzero card value: ${candidates.length}`)
let failures = 0

for (const c of candidates) {
  const page = await ctx.newPage()
  try {
    await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
    await page.waitForFunction(() => document.querySelectorAll('.nx-row25').length > 0,
      undefined, { timeout: 180_000, polling: 400 })
    await page.waitForTimeout(1500)

    const box = await page.locator('.nx-row25').nth(c.i).boundingBox()
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
    // Settle on the composer: the conversation is mounted once that exists.
    await page.waitForFunction(() => document.querySelector('[class*="composer"]') !== null,
      undefined, { timeout: 60_000, polling: 300 }).catch(() => {})

    await page.locator('[aria-label="Open quick actions"]').first().click({ timeout: 30_000 })
    await page.getByRole('button', { name: /Offer \/ Deal/i }).first().click({ timeout: 30_000 })
    await page.waitForFunction(() => document.querySelector('.nx-pis') !== null,
      undefined, { timeout: 30_000, polling: 200 })
    await page.waitForTimeout(600)

    const sheet = await page.evaluate(() => ({
      open: document.querySelector('.nx-pis') !== null,
      title: (document.querySelector('.nx-mobile-sheet__title-wrap strong')?.textContent || '').trim().slice(0, 34),
      value: (document.querySelector('.nx-pis__value')?.textContent || '').trim(),
    }))

    const ok = sheet.open && sheet.value === c.cardValue
    if (!ok) failures += 1
    console.log(`  ${ok ? 'MATCH ' : 'DIFFER'}  ${c.name.padEnd(24)} card=${c.cardValue.padEnd(7)} sheet=${(sheet.value || '(none)').padEnd(7)} open=${sheet.open}`)
  } catch (error) {
    failures += 1
    console.log(`  ERROR   ${c.name.padEnd(24)} ${String(error?.message || error).slice(0, 70)}`)
  } finally { await page.close() }
}

await browser.close()
console.log('─'.repeat(64))
console.log(failures === 0
  ? `PASS — ${candidates.length}/${candidates.length} valuations match the card`
  : `FAIL — ${failures} of ${candidates.length} did not match`)
process.exitCode = failures ? 1 : 0
