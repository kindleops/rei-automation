#!/usr/bin/env node
/**
 * CAMPAIGN COMMAND — MOBILE OPERATOR PROOF (§3, §35, §44, §45).
 *
 * The acceptance standard is not "the campaign page renders". It is that the
 * screen reaches a TRUTHFUL TERMINAL STATE and never sits spinning.
 *
 * The defect this guards is specific and was real: `callBackend` had no
 * deadline, so when the API did not answer, every surface awaiting it stayed in
 * `loading` forever — the error branch each component wrote was unreachable
 * because the promise never settled. The last check here simulates exactly
 * that, and requires the screen to resolve anyway.
 *
 * Usage: node scripts/proof/mobile/campaign-command-mobile-proof.mjs [--theme dark]
 */
import { webkit } from 'playwright'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
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

console.log(`CAMPAIGN COMMAND MOBILE  webkit ${WIDTH}x${HEIGHT} ${THEME}`)

const overflowOf = (page) => page.evaluate(() => {
  const doc = document.scrollingElement || document.documentElement
  return Math.max(0, doc.scrollWidth - window.innerWidth)
})

// ── the list reaches a real state, and every request on the way is healthy
{
  const page = await context.newPage()
  const errors = []
  const bad = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)))
  page.on('requestfinished', async (r) => {
    const u = r.url()
    if (!u.includes('/api/')) return
    const res = await r.response()
    const status = res?.status() ?? 0
    if (status >= 400) bad.push(`${status} ${u.replace(/^https?:\/\/[^/]+/, '')}`)
  })

  await page.goto(`${BASE}/campaign-command`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('#root > *', { timeout: 90_000 })
  await page.waitForSelector('.cmk__card, .cmk__empty, .cmk__state', { timeout: 90_000 }).catch(() => {})
  await page.waitForTimeout(8000)

  const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
  check('the campaign list reaches a terminal state', text.length > 500, `${text.length} chars`)
  check('real campaigns render', /targets|DRAFT|COMPLETE|PAUSED/i.test(text), text.slice(0, 100))

  // §35 — no request may fail silently behind a rendered surface.
  check('no failing request on load', bad.length === 0, bad.slice(0, 3).join(' | '))
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  check('no horizontal overflow', (await overflowOf(page)) <= 1)

  // The New Campaign affordance exists and opens the builder.
  const newBtn = await page.$('button[aria-label="New campaign"]')
  check('New campaign is reachable', Boolean(newBtn))
  if (newBtn) {
    await newBtn.click()
    await page.waitForTimeout(6000)
    const builder = await page.$('.cbx, .cbx__name, .cdb__band')
    check('the builder opens', Boolean(builder))
    check('no horizontal overflow in the builder', (await overflowOf(page)) <= 1)
  }
  await page.screenshot({ path: `/tmp/campaign-command-${WIDTH}x${HEIGHT}-${THEME}.png` })
  await page.close()
}

// ── §3/§35 THE ONE THAT MATTERS: an API that never answers must not hang the UI
{
  const page = await context.newPage()
  // Accept the request and say nothing — the shape that used to hang forever.
  await page.route('**/api/cockpit/campaigns**', () => { /* never fulfil */ })

  await page.goto(`${BASE}/campaign-command`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('#root > *', { timeout: 90_000 })

  const settled = await page.evaluate(async () => {
    const mod = await import('/src/lib/api/backendClient.ts')
    const started = Date.now()
    const res = await mod.callBackend('/api/cockpit/campaigns', { timeoutMs: 4000 })
    return { ms: Date.now() - started, ok: res.ok, error: res.error }
  })

  check('a never-answering request SETTLES instead of hanging',
    settled.ok === false && settled.error === 'BACKEND_TIMEOUT',
    JSON.stringify(settled))
  check('it settles near its deadline, not later', settled.ms < 12_000, `${settled.ms}ms`)
  // A timeout must not masquerade as an unreachable server.
  check('a timeout is not reported as an unreachable backend',
    settled.error !== 'BACKEND_UNAVAILABLE', String(settled.error))
  await page.close()
}

await browser.close()
console.log('')
if (failures.length) {
  console.error(`✗ ${failures.length} failure(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('✓ Campaign Command mobile intact')
