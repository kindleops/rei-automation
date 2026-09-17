/**
 * KEYBOARD-OPEN CONTRACT (§20 / §30.26).
 *
 * WHAT THIS CAN AND CANNOT PROVE. Headless Chromium has no virtual keyboard, so
 * `visualViewport` never shrinks and the actual overlap cannot be reproduced
 * here. What CAN be measured is the mechanism that breaks keyboard-open layouts
 * on iOS in the first place:
 *
 *   1. FONT SIZE. Safari zooms the page when a focused input's computed
 *      font-size is under 16px. That zoom is what detaches every fixed surface
 *      in the shell — the docks, the sheets, the safe-area maths — so a sub-16px
 *      input is the defect, and the visible symptom is downstream of it.
 *   2. HORIZONTAL OVERFLOW ON FOCUS. Focusing must not widen the document.
 *   3. THE SUBMIT CONTROL. It has to be inside the viewport with the field
 *      focused, which is the part an operator loses first when a composer is
 *      laid out against `100vh`.
 *
 * The keyboard-inset plumbing itself (`useMobileKeyboardInset`, which reads
 * window.visualViewport and publishes `--nx-keyboard-inset`) is asserted as
 * present rather than exercised, for the same reason.
 *
 * Usage: node scripts/proof/mobile/mobile-keyboard-qa.mjs [--base ...] [--width 390]
 * Exits non-zero on any failure.
 */
import { chromium } from 'playwright'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const BASE = arg('base', 'http://localhost:5174')
const WIDTH = Number(arg('width', '390'))

/** Every mobile surface where the operator types. */
const CASES = [
  {
    id: 'global-search',
    route: '/map',
    open: async (page) => {
      await page.click('.nx-mobile-command-dock__btn[aria-label="Universal search"]')
      await page.waitForSelector('.nx-mgs__field input', { timeout: 20_000 })
    },
    input: '.nx-mgs__field input',
    submit: null,
  },
  {
    id: 'app-launcher-search',
    route: '/map',
    open: async (page) => {
      await page.click('.nx-mobile-command-dock__btn--workspace')
      await page.waitForSelector('.nx-app-launcher__search input', { timeout: 20_000 })
    },
    input: '.nx-app-launcher__search input',
    submit: null,
  },
  {
    id: 'email-composer',
    route: '/email-command',
    open: async (page) => {
      await page.waitForSelector('.ecc__mtab', { timeout: 30_000 })
      await page.locator('.ecc__mtab', { hasText: 'Compose' }).first().click()
      await page.waitForSelector('.ecc__composer textarea', { timeout: 20_000 })
    },
    input: '.ecc__composer textarea',
    submit: '.ecc__composer button',
  },
  {
    id: 'inbox-advanced-filters',
    route: '/inbox',
    open: async (page) => {
      await page.waitForSelector('button[title="Advanced filters"]', { timeout: 40_000 })
      await page.click('button[title="Advanced filters"]')
      await page.waitForSelector('.nx-ifm-search-input', { timeout: 20_000 })
    },
    input: '.nx-ifm-search-input',
    submit: '.nx-ifm-footer button',
  },
]

const failures = []
const rows = []
const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: WIDTH, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})

for (const c of CASES) {
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)))
  try {
    await page.goto(`${BASE}${c.route}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForSelector('.nx-mobile-command-dock', { timeout: 60_000 })
    await page.waitForTimeout(5000)
    await c.open(page)
    await page.waitForTimeout(700)
    await page.focus(c.input)
    await page.waitForTimeout(700)

    const probe = await page.evaluate(({ input, submit }) => {
      const el = document.querySelector(input)
      const cs = el ? getComputedStyle(el) : null
      const sub = submit ? document.querySelector(submit) : null
      const doc = document.scrollingElement || document.documentElement
      return {
        focused: document.activeElement === el,
        fontSize: cs ? Math.round(parseFloat(cs.fontSize) * 100) / 100 : null,
        overflow: Math.max(0, doc.scrollWidth - window.innerWidth),
        submit: sub
          ? { bottom: Math.round(sub.getBoundingClientRect().bottom), h: Math.round(sub.getBoundingClientRect().height) }
          : null,
        // The plumbing that reacts to a real keyboard.
        insetVar: getComputedStyle(document.documentElement).getPropertyValue('--nx-keyboard-inset').trim() || null,
        viewportH: window.innerHeight,
      }
    }, { input: c.input, submit: c.submit })

    /**
     * EVERY visible field on the surface, not only the one being focused.
     *
     * The blanket `select { font-size: 14px !important }` in mobile-responsive.css
     * carried the comment "prevent iOS auto-zoom" while doing the opposite, and it
     * applied to all 30 selects in the advanced-filter sheet. Checking only the
     * focused input would have passed that surface. `input` with no `type`
     * attribute is the other trap: an attribute selector does not match it.
     */
    const allFields = await page.evaluate(() => {
      const small = []
      for (const el of document.querySelectorAll('input, select, textarea')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'range') continue
        const fs = parseFloat(getComputedStyle(el).fontSize)
        if (fs < 16) {
          small.push(`${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ''} in .${String(el.parentElement?.className || '?').split(' ')[0]} @${fs}px`)
        }
      }
      return { total: document.querySelectorAll('input, select, textarea').length, small }
    })

    const fail = (msg) => failures.push(`${c.id}: ${msg}`)
    if (allFields.small.length) {
      fail(`${allFields.small.length} visible field(s) under the 16px iOS zoom threshold — ${allFields.small.slice(0, 4).join('; ')}`)
    }
    if (!probe.focused) fail('the input did not take focus')
    // 16px is the iOS zoom threshold. Below it Safari scales the page and every
    // fixed surface in the shell detaches from its anchor.
    if (probe.fontSize == null || probe.fontSize < 16) fail(`focused input is ${probe.fontSize}px — under the 16px iOS zoom threshold`)
    if (probe.overflow > 1) fail(`focusing widened the document by ${probe.overflow}px`)
    if (probe.submit && probe.submit.bottom > probe.viewportH + 1) {
      fail(`the submit control sits ${probe.submit.bottom - probe.viewportH}px below the viewport while typing`)
    }
    if (probe.insetVar === null) fail('--nx-keyboard-inset is not published — the shell cannot react to a real keyboard')
    if (errors.length) fail(`page errors: ${errors.slice(0, 2).join(' | ')}`)

    rows.push({ id: c.id, ...probe, fields: allFields.total, under16: allFields.small.length })
    console.log(`${c.id.padEnd(24)} font=${String(probe.fontSize).padEnd(5)} fields=${String(allFields.total).padEnd(4)} under16=${String(allFields.small.length).padEnd(3)} overflow=${String(probe.overflow).padEnd(3)} submitBottom=${probe.submit?.bottom ?? '-'} inset=${probe.insetVar}`)
  } catch (error) {
    failures.push(`${c.id}: ${String(error?.message || error).slice(0, 160)}`)
  }
  await page.close()
}

await browser.close()

console.log('')
if (failures.length) {
  console.error(`✗ ${failures.length} keyboard-contract failure(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`✓ keyboard contract intact @ ${WIDTH}px across ${rows.length} typing surfaces`)
