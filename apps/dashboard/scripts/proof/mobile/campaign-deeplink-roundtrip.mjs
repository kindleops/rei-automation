import { chromium } from 'playwright'
// Deep-link round trip. EVERY non-GET API request is aborted, so opening a
// thread cannot mark anything read or write anything else.
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const blocked = []
await p.route('**/api/**', (route) => {
  const m = route.request().method()
  if (m === 'GET' || m === 'OPTIONS') return route.continue()
  blocked.push(`${m} ${route.request().url().replace(/^https?:\/\/[^/]+/, '')}`)
  return route.abort()
})
const errs = []; p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
// 1. Arrive by link, straight onto a section.
await p.goto('http://localhost:5173/campaign-command?campaign=320c798a-84c9-45b8-a7c9-d166ddd7bd46&section=replies', { waitUntil: 'domcontentloaded', timeout: 180000 })
await p.waitForSelector('.cdm2', { timeout: 120000 }); await p.waitForTimeout(3500)
const active1 = await p.evaluate(() => document.querySelector('.cst__tab.is-on')?.textContent?.trim())
console.log('1. linked arrival → detail open on:', active1, '| url:', p.url().replace(/^https?:\/\/[^/]+/, ''))
// 2. Switch section; URL follows.
await p.locator('.cst__tab').filter({ hasText: 'Queue' }).click(); await p.waitForTimeout(1500)
console.log('2. after tapping Queue → url:', p.url().replace(/^https?:\/\/[^/]+/, ''))
// 3. Open a sent message's conversation, then come back.
await p.waitForSelector('.cq-row.is-link', { timeout: 20000 })
await p.locator('.cq-row.is-link').first().click(); await p.waitForTimeout(2500)
console.log('3. tapped a message → url:', p.url().replace(/^https?:\/\/[^/]+/, ''))
await p.goBack()
const tBack = Date.now()
await p.waitForSelector('.cdm2 .cst__tab.is-on', { timeout: 60000 }); await p.waitForTimeout(600)
console.log(`   detail back after ${Date.now() - tBack}ms`)
const active2 = await p.evaluate(() => document.querySelector('.cst__tab.is-on')?.textContent?.trim())
console.log('4. Back → url:', p.url().replace(/^https?:\/\/[^/]+/, ''), '| section:', active2, '| detail open:', await p.locator('.cdm2').count() > 0)
// 5. Close the detail; params leave the URL.
await p.locator('.cdb2 button').first().click(); await p.waitForTimeout(1200)
console.log('5. closed → url:', p.url().replace(/^https?:\/\/[^/]+/, ''))
// 6. A link to a campaign that doesn't exist falls back to the list.
await p.goto('http://localhost:5173/campaign-command?campaign=00000000-0000-0000-0000-000000000000', { waitUntil: 'domcontentloaded' })
await p.waitForSelector('.cxc__hit', { timeout: 120000 }); await p.waitForTimeout(2500)
console.log('6. unknown id → list shown:', await p.locator('.cxc__hit').count() > 0, '| url:', p.url().replace(/^https?:\/\/[^/]+/, ''))
console.log('blocked writes:', blocked.length ? blocked : 'none attempted')
if (errs.length) console.log('page errors:', errs)
await b.close()
