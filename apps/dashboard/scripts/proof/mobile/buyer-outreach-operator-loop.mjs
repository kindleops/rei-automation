#!/usr/bin/env node
/**
 * BUYER MATCH — THE OPERATOR LOOP, DRIVEN (§4-§12, §14).
 *
 * The contract proof establishes the surface loads the right subject. This one
 * drives the loop an operator actually performs: enter selection, select real
 * buyers, open outreach, read the server's eligibility verdict, and confirm the
 * surface refuses to offer a send it cannot back.
 *
 * WHY THE SEND IS NEVER CLICKED HERE. With buyer contact enrichment at
 * `not_started` across all 26,390 buyer entities, no buyer has a reachable
 * number — so the truthful verdict is 0 eligible and the button is disabled.
 * That IS the assertion. Clicking through would require inventing a recipient,
 * which is the one thing this whole path is built to make impossible.
 *
 * §12 RESULT STABILITY: the same subject loaded twice must produce the same
 * buyers in the same order. A ranking that reshuffles between visits makes the
 * operator's earlier decision unreproducible.
 *
 * Usage: node scripts/proof/mobile/buyer-outreach-operator-loop.mjs [--property 2130387643]
 */
import { webkit } from 'playwright'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const PROPERTY = arg('property', '2130387643')
const WIDTH = Number(arg('width', '390'))
const HEIGHT = Number(arg('height', '844'))
const THEME = arg('theme', 'dark')

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

console.log(`BUYER OUTREACH OPERATOR LOOP  webkit ${WIDTH}x${HEIGHT} ${THEME}  property=${PROPERTY}`)

const buyerNames = (page) => page.$$eval('.bmm__buyer', (n) => n.map((e) => e.textContent.trim()))
const overflowOf = (page) => page.evaluate(() => {
  const doc = document.scrollingElement || document.documentElement
  return Math.max(0, doc.scrollWidth - window.innerWidth)
})

const load = async (page) => {
  await page.goto(`${BASE}/buyer-match?property_id=${PROPERTY}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('#root > *', { timeout: 90_000 })
  await page.waitForSelector('.bmm__card', { timeout: 90_000 })
}

const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)))

// ── §12 result stability across two independent loads
let firstOrder = []
{
  await load(page)
  firstOrder = await buyerNames(page)
  check('real ranked buyers render', firstOrder.length > 0, `${firstOrder.length} cards`)

  await load(page)
  const secondOrder = await buyerNames(page)
  check('§12 the same subject yields the same buyers in the same order',
    JSON.stringify(firstOrder) === JSON.stringify(secondOrder),
    `first=${firstOrder.slice(0, 3).join(' | ')} second=${secondOrder.slice(0, 3).join(' | ')}`)
}

// ── §4/§5 selection is a mode; reading and selecting do not share a gesture
{
  check('no selection affordance before entering selection mode',
    (await page.$$('.bmm__tick')).length === 0)

  // A tap outside selection mode opens the buyer, it does not select.
  await page.click('.bmm__card')
  await page.waitForSelector('.bmm-sheet', { timeout: 15_000 })
  check('§5 a tap outside selection mode opens the buyer detail', true)
  await page.click('.bmm-sheet__close')
  await page.waitForTimeout(400)

  await page.click('.bmm__selectmode')
  await page.waitForTimeout(300)
  check('§4 selection mode reveals a per-card affordance',
    (await page.$$('.bmm__tick')).length > 0)
  check('no action bar before anything is selected',
    (await page.$$('.bmm-actionbar')).length === 0)
}

// ── §6 the action bar names the count it will act on
{
  const cards = await page.$$('.bmm__card')
  await cards[0].click()
  await cards[1].click()
  await page.waitForSelector('.bmm-actionbar', { timeout: 15_000 })
  const countText = (await page.$eval('.bmm-actionbar__count', (n) => n.textContent) || '').trim()
  check('§6 the action bar states the real selected count', countText === '2 selected', countText)
  check('§6 the action bar does not claim to send', !/send/i.test(countText))
  check('no horizontal overflow with the action bar up', (await overflowOf(page)) <= 1)
}

// ── §7/§8 the outreach sheet shows the SERVER's verdict, with reasons
{
  await page.click('.bmm-actionbar__primary')
  await page.waitForSelector('.bmm-outreach', { timeout: 20_000 })
  await page.waitForFunction(() => !/Checking eligibility/i.test(document.body.innerText), null, { timeout: 60_000 })

  const text = (await page.$eval('.bmm-outreach', (n) => n.innerText)).replace(/\s+/g, ' ')
  check('§7 the sheet reports the selection it was given', /2 selected/.test(text), text.slice(0, 140))
  check('§8 blocked buyers are listed with a reason, not dropped',
    (await page.$$('.bmm-outreach__blocked li')).length === 2,
    text.slice(0, 200))
  check('§8 the reason is stated in words, not as a slug',
    /No contact on record/i.test(text) && !/no_contact_on_record/.test(text),
    text.slice(0, 200))

  const send = await page.$('.bmm-outreach .bmm-act.is-select')
  const disabled = await send.evaluate((n) => n.disabled)
  const label = (await send.evaluate((n) => n.textContent)).trim()
  check('§9 a send that cannot be backed is refused, not offered',
    disabled === true, `label="${label}"`)
  check('§9 the button says why rather than pretending',
    /nothing eligible/i.test(label), label)
  check('no horizontal overflow in the outreach sheet', (await overflowOf(page)) <= 1)
  await page.screenshot({ path: `/tmp/buyer-outreach-${WIDTH}x${HEIGHT}-${THEME}.png` })
}

check('no page errors across the whole loop', errors.length === 0, errors.slice(0, 2).join(' | '))
await page.close()
await browser.close()

console.log('')
if (failures.length) {
  console.error(`✗ ${failures.length} failure(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('✓ Buyer outreach operator loop intact')
