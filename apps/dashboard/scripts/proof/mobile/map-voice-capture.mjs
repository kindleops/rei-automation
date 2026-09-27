import { chromium } from 'playwright'
import fs from 'node:fs/promises'
/**
 * Map in-card conversation + voice message. Fake mic (Chrome fake device) and a
 * stubbed SpeechRecognition that "hears" a messy dictation. Only the read-only
 * polish/translate POSTs are allowed; every other non-GET is aborted and no
 * send button is ever tapped.
 */
const OUT = 'artifacts/map-v5'
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['microphone'] })
await ctx.addInitScript(() => {
  window.__loop = []; const ce = console.error.bind(console); console.error = (...a) => { if (String(a[0]).includes('Maximum update') && window.__loop.length < 3) window.__loop.push(new Error().stack.split('\n').slice(2, 16).join('\n')); ce(...a) }
  localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ lens: 'none', pins: true, everyProperty: true, mapKey: false }))
  const script = ['hi linda um this is ryan', 'hi linda um this is ryan i wanted to follow up comma', 'hi linda um this is ryan i wanted to follow up comma would you be open to a cash offer on the property question mark', 'hi linda um this is ryan i wanted to follow up comma would you be open to a cash offer on the property question mark we can close in 21 days']
  class FakeRec {
    constructor() { this.continuous = true; this.interimResults = true; this.lang = 'en-US'; this.onresult = null; this.onend = null; this.onerror = null; this.i = 0 }
    start() { window.__rec = this; this.t = setInterval(() => { if (this.i >= script.length) return; const text = script[this.i++]; this.onresult?.({ results: { length: 1, 0: { 0: { transcript: text }, isFinal: false } } }) }, 700) }
    stop() { clearInterval(this.t); setTimeout(() => this.onend?.(), 50) }
    abort() { this.stop() }
  }
  window.webkitSpeechRecognition = FakeRec
  window.SpeechRecognition = FakeRec
})
const page = await ctx.newPage()
const allowed = /\/api\/cockpit\/inbox\/(polish-draft|translate)$/
const blocked = []
await page.route('**/api/**', (r) => {
  const m = r.request().method()
  if (['GET', 'OPTIONS'].includes(m) || allowed.test(new URL(r.request().url()).pathname)) return r.continue()
  blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort()
})
const polishRes = []
page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/CORS|Failed to load resource|pbf/.test(m.text())) polishRes.push('CONSOLE ' + (m.text().includes('Maximum update') ? m.text().slice(0, 1500) : m.text().slice(0, 120))) })
page.on('request', (r) => { if (/polish|translate/.test(r.url())) polishRes.push('REQ ' + r.method() + ' ' + r.url().slice(0, 120)) })
page.on('requestfailed', (r) => { if (/polish|translate/.test(r.url())) polishRes.push('FAIL ' + r.failure()?.errorText) })
page.on('response', async (r) => { if (allowed.test(new URL(r.url()).pathname)) polishRes.push(`${r.status()} ${(await r.text().catch(() => '')).slice(0, 200)}`) })
polishRes.push('STEP goto'); await page.goto('http://localhost:5173/map', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 90000 }); await page.waitForTimeout(3000)
polishRes.push('STEP jump'); await page.evaluate(() => window.__nxMap.jumpTo({ center: [-84.39, 33.75], zoom: 12.5 }))
await page.waitForFunction(() => { const m = window.__nxMap; return m.getLayer('prop-tiles-hit') && m.queryRenderedFeatures({ layers: ['prop-tiles-hit'] }).length > 20 }, undefined, { timeout: 60000, polling: 500 })
await page.waitForTimeout(1500)
const pin = await page.evaluate(() => { const m = window.__nxMap; const r = m.getCanvas().getBoundingClientRect(); for (const f of m.queryRenderedFeatures({ layers: ['prop-tiles-hit'] })) { const p = m.project(f.geometry.coordinates); if (p.y > 200 && p.y < 520 && p.x > 40 && p.x < 350) return { x: r.left + p.x, y: r.top + p.y } } return null })
polishRes.push('STEP tap-pin'); await page.touchscreen.tap(pin.x, pin.y); await page.waitForTimeout(3000)
polishRes.push('STEP messages'); await page.locator('[data-seller-action="messages"]').tap(); await page.waitForTimeout(4000); polishRes.push('STEP messages+4s')
await page.screenshot({ path: `${OUT}/16-map-conversation.png` })
const mic = page.locator('[data-composer-action="voice"]')
const R = { mic: await mic.count() }
if (R.mic) {
  polishRes.push('STEP mic'); await mic.first().tap(); await page.waitForTimeout(2400)
  await page.screenshot({ path: `${OUT}/17-voice-recording.png` })
  R.stage = await page.locator('.nx-voice-stage').count()
  R.liveWords = await page.locator('.nx-voice-stage__words').textContent().catch(() => null)
  await page.waitForTimeout(900)
  await page.locator('.nx-voice-stage__btn.is-done').tap(); await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/17b-voice-polishing.png` })
  await page.waitForTimeout(4000)
  R.draft = await page.locator('.smc-composer-wrap textarea').inputValue().catch(() => null)
  await page.screenshot({ path: `${OUT}/18-voice-polished.png` })
}
console.log('LOOPSTACK\n' + (await page.evaluate(() => window.__loop.join('\n-----\n'))))
console.log(JSON.stringify({ R, blocked, marks: polishRes.filter((x) => /^(STEP|RENDERS)/.test(x)) }, null, 1))
await browser.close()
