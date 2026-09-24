import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
// Read-only capture of the mobile Campaign Command index across phone sizes and
// themes. Every non-GET API call is aborted, so nothing here can write.
//   node scripts/proof/mobile/campaign-dashboard-capture.mjs --label=before
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.replace(`--${name}=`, '') : fallback
}
const list = (raw, fb) => (raw ? String(raw).split(',').map((v) => v.trim()).filter(Boolean) : fb)
const BASE = arg('base', 'http://localhost:5173')
const LABEL = arg('label', 'after')
const SIZES = { 375: 812, 390: 844, 393: 852, 430: 932 }
const WIDTHS = list(arg('width'), Object.keys(SIZES)).map(Number)
const THEMES = list(arg('theme'), ['dark', 'light', 'true-black', 'red-ops'])
const FILTER = arg('filter', '') // tab label to select before capture, e.g. Drafts
const OUT = path.resolve(arg('out', `artifacts/campaign-dashboard/${LABEL}`))
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
for (const width of WIDTHS) {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width, height: SIZES[width] ?? 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    const page = await ctx.newPage()
    await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort()))
    // The shell reads nexus-settings.nexusTheme (true_black / red_ops use underscores).
    await page.addInitScript((t) => {
      try {
        const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
        localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t.replace('-', '_') }))
      } catch {}
    }, theme)
    const errs = []
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 140)))
    await page.goto(`${BASE}/campaign-command`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await page.waitForSelector('[data-campaign-card], .cxc__hit', { timeout: 120000 })
    await page.waitForTimeout(Number(arg("wait", "3500")))
    if (FILTER) {
      await page.locator('[role="tab"]', { hasText: new RegExp(`^${FILTER}`) }).first().click()
      await page.waitForTimeout(700)
    }
    const SCROLL = Number(arg('scroll', '0'))
    if (SCROLL) {
      await page.evaluate((y) => { const el = document.querySelector('.cxi__scroll'); if (el) el.scrollTop = y }, SCROLL)
      await page.waitForTimeout(500)
    }
    const suffix = `${FILTER ? `-${FILTER.toLowerCase()}` : ''}${SCROLL ? `-s${SCROLL}` : ''}`
    await page.screenshot({ path: `${OUT}/${width}-${theme}${suffix}.png` })
    const m = await page.evaluate(() => {
      // color-mix() computes to `color(srgb r g b / a)` with 0-1 channels.
      const rgb = (v) => {
        const n = (v.match(/[\d.]+/g) || []).map(Number)
        return v.startsWith('color(') ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1] : n
      }
      const lum = ([r, g, b]) => {
        const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      // Blend a translucent colour over its opaque ground before measuring.
      const over = (fg, bg) => { const a = fg[3] ?? 1; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)) }
      const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return +((x + 0.05) / (y + 0.05)).toFixed(2) }
      const card = document.querySelector('[data-campaign-card]')
      const cardBg = rgb(getComputedStyle(card).backgroundColor)
      const pageBg = rgb(getComputedStyle(document.querySelector('.cxi')).backgroundColor)
      const ground = over(cardBg, pageBg)
      const probe = (sel) => { const el = card.querySelector(sel); return el ? contrast(over(rgb(getComputedStyle(el).color), ground), ground) : null }
      const neutral = (c) => Math.max(...c.slice(0, 3)) - Math.min(...c.slice(0, 3))
      const edge = getComputedStyle(card).borderTopColor
      return {
        appliedTheme: document.documentElement.getAttribute('data-nexus-theme'),
        overflow: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
        contrast: { name: probe('.cxc__name'), marker: probe('.cxc-marker__label'), meta: probe('.cxc-metric__label, .cxc-progress__of, .cxc-note, .cxc-setup__text') },
        // chroma of the surfaces content sits on: 0 = perfectly neutral
        chroma: { page: neutral(pageBg), card: neutral(ground) },
        tokens: {
          edgeDefined: !/rgba\(0, 0, 0, 0\)/.test(edge),
          cardDefined: cardBg.length >= 3,
          accentDefined: getComputedStyle(document.querySelector('.cxi')).getPropertyValue('--cx-accent').trim() !== '',
          bloomTop: +getComputedStyle(document.body, '::before').opacity,
        },
      }
    })
    console.log(JSON.stringify({ width, theme, filter: FILTER || null, ...m, errs }))
    await ctx.close()
  }
}
await browser.close()
