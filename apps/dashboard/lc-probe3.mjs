import { chromium } from '@playwright/test'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, colorScheme: 'dark' })
const p = await ctx.newPage()
await p.goto('http://127.0.0.1:5188/pipeline', { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => document.querySelectorAll('#root *').length > 200, null, { timeout: 90000, polling: 250 }).catch(()=>{})
await p.waitForTimeout(2500)
const out = await p.evaluate(() => {
  const el = document.querySelector('.nx-notification-button')
  const probe = document.createElement('button'); probe.textContent='x'; document.body.appendChild(probe)
  const pcs = getComputedStyle(probe)
  let lcText = ''
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules } catch { continue }
    for (const r of rules) {
      if (r.cssText && r.cssText.includes('lc-responsive')) lcText = 'marker'
    }
  }
  const hasLcSheet = [...document.querySelectorAll('style')].some(s => (s.textContent||'').includes('R15.2 — 100vw includes the scrollbar'))
  return {
    tag: el?.tagName, inlineStyle: el?.getAttribute('style'),
    matchesButton: el?.matches('button'),
    probeMinH: pcs.minHeight, probeMinW: pcs.minWidth,
    lcSheetPresent: hasLcSheet,
    styleTags: document.querySelectorAll('style').length,
  }
})
console.log(JSON.stringify(out, null, 1))
await b.close()
