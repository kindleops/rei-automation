// Proves the typing engine's real Web Audio path makes sound: a real keydown on a
// real <textarea> → controller → buffer pool → OfflineAudioContext render → RMS.
// No network: about:blank + an injected bundle of src/shared/sound/typing.ts.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
const bundle = readFileSync(process.argv[2], 'utf8')
const watchdog = setTimeout(() => { console.error('watchdog'); process.exit(2) }, 60000)
const browser = await chromium.launch()
const page = await browser.newPage()
await page.route('**/*', (r) => (r.request().url().startsWith('about:') ? r.continue() : r.abort()))
await page.setContent('<textarea id="t"></textarea><input id="p" type="password"><input id="s" type="search">')
await page.addScriptTag({ content: bundle })
await page.evaluate(() => {
  const ctx = new OfflineAudioContext(1, 48000 * 2, 48000)
  ctx.resume = () => Promise.resolve()
  const engine = LCT.createTypingEngine({ createContext: () => ctx })
  const prefs = { version: 1, interface: 'subtle', volume: 0.35, material: 'mech', typing: true, typingMaterial: 'follow', typingVolume: 0.5, alerts: true, alertTypes: {}, background: 'critical' }
  window.__log = []
  window.__ctx = ctx
  LCT.installTypingSounds({ getPrefs: () => prefs, isDesktop: () => true, engine, isHidden: () => false, note: (k, w) => window.__log.push(`${k}:${w}`) })
})
await page.focus('#t')
await page.keyboard.type('hi there', { delay: 60 })
await page.keyboard.press('Backspace')
await page.keyboard.press('Enter')
await page.focus('#p')
await page.keyboard.type('secret', { delay: 60 })
await page.focus('#s')
await page.keyboard.type('ab', { delay: 60 })
await page.keyboard.press('Enter')
const out = await page.evaluate(async () => {
  const buf = await window.__ctx.startRendering()
  const d = buf.getChannelData(0)
  let sum = 0, peak = 0
  for (const x of d) { sum += x * x; peak = Math.max(peak, Math.abs(x)) }
  return { log: window.__log, rms: Math.sqrt(sum / d.length), peakDb: 20 * Math.log10(peak) }
})
console.log(JSON.stringify(out, null, 1))
clearTimeout(watchdog)
await browser.close()
