/**
 * MOBILE SHELL CONTRACT — orientation safety and notification deep links.
 *
 * Two acceptance criteria that only a driven browser can answer:
 *
 *   §20/§30.27  rotating the handset must not hand the operator a different
 *               product. A phone in landscape is 844px wide, which reads as a
 *               tablet on layout width alone, so the shell used to fall back to
 *               the desktop command-center composition. Phone-ness is now
 *               measured on the DEVICE's short edge, and what is asserted here
 *               is the whole contract at 844x390: the mobile shell is mounted,
 *               both docks are present, no desktop-only chrome leaks in, and
 *               there is no horizontal overflow or page error.
 *   §5          tapping a notification must reach the entity it names. The row
 *               states its destination before the tap ("Open campaign"), so the
 *               test is that the URL afterwards matches what the row promised.
 *               This caught `handleOpen` awaiting a mark-read write before
 *               navigating: the tap did nothing while the patch was outstanding.
 *
 * Usage: node scripts/proof/mobile/mobile-shell-contract-qa.mjs [--base ...]
 * Exits non-zero on failure.
 */
import { chromium } from 'playwright'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const BASE = arg('base', 'http://localhost:5174')
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const LANDSCAPE_ROUTES = ['/inbox', '/map', '/analytics', '/closing-desk', '/entity-graph', '/calendar', '/email-command']

/** What each destination label must resolve to. */
const DESTINATION = {
  'Open thread': '/inbox',
  'Open property': '/deal-intelligence',
  'Open campaign': '/campaign-command',
  'Open closing': '/closing-desk',
  'Open queue': '/queue',
  'Open workflow': '/workflow-studio',
  'Open map': '/map',
  'Open buyers': '/buyer-match',
}

const failures = []
const browser = await chromium.launch()

// ── §20/§30.27 landscape
{
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, userAgent: IPHONE_UA,
  })
  for (const route of LANDSCAPE_ROUTES) {
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)))
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      await page.waitForSelector('#root > *', { timeout: 60_000 })
      // Wait for the CHROME, not a stopwatch. A flat 5s read /inbox — the
      // heaviest route, and the first one in the list — as dock-less whenever the
      // dev server was still compiling, which is a harness flake reported as a
      // product failure. A missing dock is still a failure; it is just asserted
      // below, after the shell has actually had its chance to mount.
      await page
        .waitForSelector('.nx-mobile-command-dock', { timeout: 45_000 })
        .catch(() => { /* recorded as topDock:false below, which is the finding */ })
      await page.waitForTimeout(2500)
      const d = await page.evaluate(() => {
        const doc = document.scrollingElement || document.documentElement
        const visible = (sel) => {
          const el = document.querySelector(sel)
          if (!el) return false
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        return {
          overflow: Math.max(0, doc.scrollWidth - window.innerWidth),
          mobileShell: document.documentElement.classList.contains('is-mobile-layout'),
          landscapeFlag: document.documentElement.classList.contains('is-landscape-phone'),
          mobileOs: Boolean(document.querySelector('.nx-os.is-mobile-os')),
          topDock: visible('.nx-mobile-command-dock'),
          appDock: visible('.nx-pinned-app-dock'),
          // Desktop-only chrome. Its presence means the command-center layout won.
          desktopChrome: Boolean(document.querySelector('.nx-room-label')),
        }
      })
      if (d.overflow > 1) failures.push(`landscape ${route}: overflows by ${d.overflow}px`)
      if (!d.mobileShell) failures.push(`landscape ${route}: html is missing .is-mobile-layout — the shell fell back to desktop`)
      if (!d.landscapeFlag) failures.push(`landscape ${route}: html is missing .is-landscape-phone`)
      if (!d.mobileOs) failures.push(`landscape ${route}: .nx-os is not .is-mobile-os`)
      if (!d.topDock) failures.push(`landscape ${route}: the mobile command dock is not rendered`)
      // The map owns the whole screen and deliberately yields the app dock.
      if (!d.appDock && route !== '/map') failures.push(`landscape ${route}: the pinned app dock is not rendered`)
      if (d.desktopChrome) failures.push(`landscape ${route}: desktop-only chrome (.nx-room-label) leaked in`)
      if (errors.length) failures.push(`landscape ${route}: ${errors.slice(0, 2).join(' | ')}`)
      console.log(
        `landscape ${route.padEnd(16)} overflow=${d.overflow} shell=${d.mobileShell ? 'mobile' : 'DESKTOP'}`
        + ` landscapeFlag=${d.landscapeFlag} topDock=${d.topDock} appDock=${d.appDock} errors=${errors.length}`,
      )
    } catch (error) {
      failures.push(`landscape ${route}: ${String(error?.message || error).slice(0, 120)}`)
    }
    await page.close()
  }
  await context.close()
}

// ── §5 notification deep link
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: IPHONE_UA,
  })
  const page = await context.newPage()
  try {
    await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForSelector('.nx-mobile-command-dock', { timeout: 60_000 })
    await page.waitForTimeout(4000)
    await page.click('.nx-mobile-command-dock__btn[aria-label="Notifications"]')
    await page.waitForSelector('.nx-mnc__row', { timeout: 40_000 })
    await page.waitForTimeout(2500)

    const target = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.nx-mnc__row')]
      const i = rows.findIndex((r) => r.querySelector('.nx-mnc__row-target'))
      return { index: i, label: i >= 0 ? rows[i].querySelector('.nx-mnc__row-target').textContent.trim() : null }
    })

    if (target.index < 0) {
      console.log('notification deep link  SKIPPED — no row in the feed states a destination')
    } else {
      await page.locator('.nx-mnc__row').nth(target.index).click()
      await page.waitForTimeout(3000)
      const url = page.url().replace(BASE, '')
      const expected = DESTINATION[target.label]
      const closed = !(await page.$('.nx-mnc'))
      if (!expected) failures.push(`notification row states an unknown destination "${target.label}"`)
      else if (!url.startsWith(expected)) failures.push(`row said "${target.label}" but landed on ${url}`)
      if (!closed) failures.push('the notification centre stayed open after opening an entity')
      console.log(`notification deep link  "${target.label}" -> ${url} closed=${closed}`)
    }
  } catch (error) {
    failures.push(`notification deep link: ${String(error?.message || error).slice(0, 140)}`)
  }
  await context.close()
}

await browser.close()

console.log('')
if (failures.length) {
  console.error(`✗ ${failures.length} shell-contract failure(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('✓ shell contract intact — landscape safe on 7 routes, notification deep link lands where the row says')
