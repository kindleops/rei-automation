import { chromium } from '@playwright/test'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, colorScheme: 'dark' })
const p = await ctx.newPage()
await p.goto('http://127.0.0.1:5188/pipeline', { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => document.querySelectorAll('#root *').length > 200, null, { timeout: 90000, polling: 250 }).catch(()=>{})
await p.waitForTimeout(2500)
const out = await p.evaluate(() => {
  const el = document.querySelector('.nx-notification-button')
  const hits = []
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules } catch { continue }
    const walk = (list, media) => {
      for (const r of list) {
        if (r.cssRules) { walk(r.cssRules, r.conditionText || media); continue }
        if (!r.selectorText) continue
        if (!/min-height|min-width/.test(r.style?.cssText || '')) continue
        try { if (el.matches(r.selectorText)) hits.push({ sel: r.selectorText.slice(0,90), media: media||'', css: r.style.cssText.slice(0,80) }) } catch {}
      }
    }
    walk(rules, '')
  }
  return hits
})
console.log(JSON.stringify(out, null, 1))
await b.close()
