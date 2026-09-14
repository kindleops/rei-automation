import { chromium } from 'playwright'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
await page.goto('http://localhost:5174/inbox', { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.nx-row25', { timeout: 120000 }); await page.waitForTimeout(5000)
await (await page.$$('.nx-row25'))[0].click(); await page.waitForTimeout(3500)
await page.click('.nx-pinned-app-dock__handle'); await page.waitForTimeout(700)
await (await page.$('.nx-pinned-app-dock__track .nx-pinned-app-dock__app[aria-label="Map"]'))?.click()
await page.waitForFunction(() => Boolean(window.__nexusMaps?.length), null, { timeout: 60000 })
await page.waitForTimeout(16000)
console.log('filters tab present:', await page.$$eval('.nx-icm__mode-tab--filters', (n) => n.length).catch(() => 'ERR'))
const tab = await page.$('.nx-icm__mode-tab--filters')
if (!tab) { console.log('NO FILTER TAB'); await browser.close(); process.exit(0) }
await tab.click(); await page.waitForTimeout(2500)
console.log('modal present:', await page.$$eval('.nx-ifm-modal', (n) => n.length).catch(() => 0))
for (const sel of ['.nx-ifm-rail-item', '.nx-ifm-flag-block', '.nx-ifm-flag-mode', '.nx-ifm-field', '.nx-ifm-btn-primary', '.nx-ifm-btn-ghost']) {
  console.log(sel, '=>', await page.$$eval(sel, (n) => n.length).catch(() => 'ERR'))
}
const rails = await page.$$('.nx-ifm-rail-item')
for (const [i, name] of [[0,'MapStatus'],[1,'Property'],[2,'Financials']]) {
  await rails[i].click(); await page.waitForTimeout(1200)
  const inputs = await page.$$eval('.nx-ifm-fields input, .nx-ifm-fields select', (ns) => ns.map((n) => ({ tag: n.tagName, type: n.type, ph: n.placeholder || '', opts: n.tagName === 'SELECT' ? [...n.options].slice(0,6).map((o) => o.value) : undefined })))
  const labels = await page.$$eval('.nx-ifm-fields .nx-ifm-field', (ns) => ns.slice(0,6).map((n) => n.textContent.trim().slice(0,40)))
  console.log(name, JSON.stringify({ inputs, labels }, null, 1))
}
await rails[4].click(); await page.waitForTimeout(1500)
console.log('AFTER selecting Distress & Flags:')
for (const sel of ['.nx-ifm-flag-block', '.nx-ifm-flag-mode', '.nx-ifm-field']) {
  console.log(' ', sel, '=>', await page.$$eval(sel, (n) => n.length).catch(() => 'ERR'))
}
console.log(' flag modes:', await page.$$eval('.nx-ifm-flag-mode', (ns) => ns.slice(0,8).map((n) => n.textContent.trim())).catch(() => []))
console.log(' flag labels:', await page.$$eval('.nx-ifm-flag-block', (ns) => ns.slice(0,4).map((n) => n.textContent.trim().slice(0,40))).catch(() => []))
console.log('rail groups:', await page.$$eval('.nx-ifm-rail-item', (ns) => ns.map((n) => n.textContent.trim().slice(0, 30))).catch(() => []))
console.log('apply label:', await page.$eval('.nx-ifm-btn-primary', (n) => `${n.textContent.trim()} disabled=${n.disabled}`).catch(() => 'none'))
await page.screenshot({ path: '.screenshots/filter-modal.png' })
await browser.close()
