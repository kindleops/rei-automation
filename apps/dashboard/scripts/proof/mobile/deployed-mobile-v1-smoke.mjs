#!/usr/bin/env node
/**
 * DEPLOYED MOBILE V1 SMOKE — proves the SERVED build, not a local dev server.
 *
 * Every mobile matrix in this repo drives localhost. That proves the source is
 * right and says nothing about what a handset receives, which is exactly the
 * gap that let a verified branch sit unpromoted while the phone kept rendering
 * the previous release.
 *
 * So this asks one question: is the frontend this origin is serving RIGHT NOW a
 * build that contains the mobile V1 work? It looks for evidence that cannot
 * exist in the old bundle — the asset line that replaced the inbox media frame,
 * the canonical launcher/search/notification/Q surfaces, the rebuilt Comps,
 * Analytics, Email and Entity Graph compositions — rather than trusting a green
 * deployment.
 *
 * Build identity is checked twice on purpose. `/api/version` reports the
 * CONTAINER's commit; the dashboard bundle carries its own inlined
 * VITE_COMMIT_SHA. They disagree precisely when the worker deployed but the
 * browser is still being handed old assets, which is the failure this exists to
 * catch.
 *
 * Usage:
 *   node scripts/proof/mobile/deployed-mobile-v1-smoke.mjs --base https://... [--sha 05947021]
 * Exits non-zero on failure.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'https://ops.leadcommand.ai').replace(/\/$/, '')
const EXPECT_SHA = arg('sha', null)
const LABEL = arg('label', 'deployed')
const OUT = path.resolve(process.cwd(), '.screenshots/deployed-mobile-v1', LABEL)

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  <- ${detail}`}`)
  return ok
}

await fs.mkdir(OUT, { recursive: true })
console.log(`DEPLOYED MOBILE V1 SMOKE  ${BASE}`)

// ── 1. build identity, server side ─────────────────────────────────────────
console.log('\n[build identity]')
let version = {}
try {
  const res = await fetch(`${BASE}/api/version`)
  version = await res.json()
  console.log(`  api: env=${version.env} provider=${version.provider} sha=${String(version.git_sha).slice(0, 12)} deployment=${version.deployment_id}`)
  check('the API reports a build', res.ok && Boolean(version.git_sha), `http ${res.status}`)
  check('the provider is cloudflare', version.provider === 'cloudflare', `provider=${version.provider}`)
  if (EXPECT_SHA) {
    check('the API is serving the promoted commit',
      String(version.git_sha || '').startsWith(EXPECT_SHA), `serving ${version.git_sha}`)
  }
} catch (error) {
  check('the API reports a build', false, String(error?.message || error).slice(0, 120))
}

// ── 2. cache contract + the FRONTEND's own commit ───────────────────────────
// A worker can deploy while the browser is still handed the previous bundle.
// The only honest answer comes from the bytes this origin serves.
console.log('\n[served assets]')
const htmlRes = await fetch(`${BASE}/`, { cache: 'no-store' })
const html = await htmlRes.text()
const htmlCache = htmlRes.headers.get('cache-control') || ''
check('index.html is not cacheable', /no-store|no-cache/.test(htmlCache), `cache-control: ${htmlCache}`)

const swRes = await fetch(`${BASE}/sw.js`, { cache: 'no-store' })
check('sw.js is not cacheable', /no-store|no-cache/.test(swRes.headers.get('cache-control') || ''),
  `cache-control: ${swRes.headers.get('cache-control')}`)

const entry = (html.match(/\/assets\/main-[A-Za-z0-9_-]+\.js/) || [])[0]
check('index.html names a hashed entry bundle', Boolean(entry), 'no /assets/main-*.js reference')
let bundleSha = null
if (entry) {
  const assetRes = await fetch(`${BASE}${entry}`, { cache: 'no-store' })
  const assetCache = assetRes.headers.get('cache-control') || ''
  check('hashed assets are immutable', /immutable|max-age=\d{5,}/.test(assetCache), `cache-control: ${assetCache}`)
  const body = await assetRes.text()
  bundleSha = (body.match(/\b[0-9a-f]{40}\b/g) || []).find((sha) => !EXPECT_SHA || sha.startsWith(EXPECT_SHA))
    || (body.match(/\b[0-9a-f]{40}\b/g) || [])[0] || null
  console.log(`  entry: ${entry}  inlined sha: ${bundleSha ? bundleSha.slice(0, 12) : 'none found'}`)
  if (EXPECT_SHA) {
    check('the FRONTEND bundle carries the promoted commit',
      Boolean(bundleSha && bundleSha.startsWith(EXPECT_SHA)),
      `bundle reports ${bundleSha || 'nothing'}`)
  }
}

const browser = await chromium.launch()
const newPhone = (viewport, theme) => browser.newContext({
  viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: IPHONE_UA,
  ...(theme ? {} : {}),
})

/** Theme is an operator setting in localStorage; seed it before the app boots. */
const seedTheme = (context, theme) => context.addInitScript((t) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), nexusTheme: t }))
  } catch { /* first run has no settings */ }
}, theme)

const settle = async (page, route, selector = '.nx-mobile-command-dock') => {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('#root > *', { timeout: 90_000 })
  await page.waitForSelector(selector, { timeout: 60_000 }).catch(() => undefined)
  await page.waitForTimeout(6000)
}

const shellFacts = () => {
  const doc = document.scrollingElement || document.documentElement
  const shown = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  return {
    mobileLayout: document.documentElement.classList.contains('is-mobile-layout'),
    landscapeFlag: document.documentElement.classList.contains('is-landscape-phone'),
    mobileOs: Boolean(document.querySelector('.nx-os.is-mobile-os')),
    topDock: shown('.nx-mobile-command-dock'),
    appDock: shown('.nx-pinned-app-dock'),
    desktopChrome: Boolean(document.querySelector('.nx-room-label')),
    overflow: Math.max(0, doc.scrollWidth - window.innerWidth),
    theme: document.documentElement.getAttribute('data-nexus-theme'),
  }
}

// ── 3. portrait, dark — the inbox card is the single clearest tell ──────────
console.log('\n[390x844 portrait / dark]')
{
  const context = await newPhone({ width: 390, height: 844 })
  await seedTheme(context, 'dark')
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)))

  await settle(page, '/inbox')
  const inbox = await page.evaluate(() => {
    const media = document.querySelector('.nx-row25__zone--media')
    return {
      rows: document.querySelectorAll('.nx-row25').length,
      assetLines: document.querySelectorAll('.nx-card-assetline').length,
      mediaDisplay: media ? getComputedStyle(media).display : 'absent',
      sample: [...document.querySelectorAll('.nx-card-assetline')].slice(0, 2)
        .map((el) => el.innerText.replace(/\s+/g, ' ')),
    }
  })
  const shell = await page.evaluate(shellFacts)
  await page.screenshot({ path: path.join(OUT, 'portrait-dark-inbox.png') })

  check('the mobile shell is mounted', shell.mobileLayout && shell.mobileOs, JSON.stringify(shell))
  check('both docks are painted', shell.topDock && shell.appDock, `top=${shell.topDock} app=${shell.appDock}`)
  check('no desktop chrome on a phone', !shell.desktopChrome)
  check('no horizontal overflow', shell.overflow <= 1, `+${shell.overflow}px`)
  check('the inbox list rendered', inbox.rows > 0, `${inbox.rows} rows`)
  // THE tell: the old bundle has the 88x66 media frame and no asset line.
  check('the obsolete inbox media frame is gone', inbox.mediaDisplay === 'none' || inbox.mediaDisplay === 'absent',
    `display: ${inbox.mediaDisplay}`)
  check('the property asset line replaced it', inbox.assetLines > 0 && inbox.assetLines === inbox.rows,
    `${inbox.assetLines} lines for ${inbox.rows} rows`)
  console.log(`  asset line reads: ${JSON.stringify(inbox.sample)}`)

  // ── launcher: one launcher, Property OS absent, appearance preserved
  await page.click('.nx-mobile-command-dock__btn[aria-label$="open applications"]').catch(() => undefined)
  await page.waitForSelector('.nx-app-launcher', { timeout: 30_000 }).catch(() => undefined)
  await page.waitForTimeout(2000)
  const launcher = await page.evaluate(() => {
    const root = document.querySelector('.nx-app-launcher')
    if (!root) return null
    const text = root.innerText
    return {
      apps: root.querySelectorAll('[class*="__app"], [class*="__tile"]').length,
      text: text.replace(/\s+/g, ' ').slice(0, 900),
      propertyOs: /Property Intelligence OS|Property OS/i.test(text),
      themeSwatches: root.querySelectorAll('[class*="theme"] button, button[class*="theme"]').length,
      accentSwatches: root.querySelectorAll('[class*="accent"] button, button[class*="accent"]').length,
      appearance: Boolean(root.querySelector('[class*="appearance"], [class*="Appearance"]'))
        || /appearance|theme|accent/i.test(text),
    }
  })
  await page.screenshot({ path: path.join(OUT, 'portrait-dark-launcher.png') })
  check('the canonical app launcher opens', Boolean(launcher), 'no .nx-app-launcher')
  if (launcher) {
    check('Property OS is absent from the mobile launcher', !launcher.propertyOs, launcher.text.slice(0, 200))
    check('appearance controls are preserved in the launcher', launcher.appearance)
    console.log(`  launcher: ${launcher.apps} app tiles, themes=${launcher.themeSwatches} accents=${launcher.accentSwatches}`)
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)

  // ── the three other canonical surfaces
  const surface = async (label, selector, clickSelector) => {
    await page.click(clickSelector).catch(() => undefined)
    const found = await page.waitForSelector(selector, { timeout: 30_000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(1500)
    check(label, found, `expected ${selector}`)
    await page.screenshot({ path: path.join(OUT, `portrait-dark-${label.replace(/\W+/g, '-')}.png`) })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
  }
  await surface('the canonical mobile global search opens', '.nx-mgs',
    '.nx-mobile-command-dock__btn[aria-label="Universal search"]')
  await surface('the mobile notification centre opens', '.nx-mnc',
    '.nx-mobile-command-dock__btn[aria-label="Notifications"]')
  /*
   * The Q surface now opens from the overflow, not from a glyph in the bar.
   * Queue, Tasks and Live Activity were three of six 38px controls whose 44px
   * hit areas overlapped their neighbours; they are secondary utilities and
   * moved behind one trailing overflow control. The surface is unchanged and
   * still reachable — this asserts the new path rather than the old one.
   */
  {
    await settle(page, '/inbox')
    await page.locator('.nx-mobile-command-dock__btn--overflow').click({ timeout: 20_000 }).catch(() => undefined)
    await page.waitForTimeout(1200)
    await page.locator('.nx-mobile-overflow__row', { hasText: /^Queue/ }).first()
      .click({ timeout: 20_000 }).catch(() => undefined)
    const found = await page.waitForSelector('.nx-mqs', { timeout: 30_000 })
      .then(() => true).catch(() => false)
    check('the mobile Q surface opens from the overflow', found, 'expected .nx-mqs')
    await page.screenshot({ path: path.join(OUT, 'portrait-dark-queue-via-overflow.png') })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
  }

  // ── the rebuilt application compositions
  const composition = async (label, route, selector) => {
    await settle(page, route)
    const found = await page.$(selector)
    const facts = await page.evaluate(shellFacts)
    check(label, Boolean(found), `expected ${selector}`)
    check(`${route} has no horizontal overflow`, facts.overflow <= 1, `+${facts.overflow}px`)
    await page.screenshot({ path: path.join(OUT, `portrait-dark${route.replace(/\//g, '-')}.png`) })
  }
  // Comps is subject-scoped: cold, it correctly renders "No Subject Selected".
  // Reaching it the way an operator does — open a thread, then switch app —
  // also proves the cross-app subject carrier survives on the deployed build.
  await settle(page, '/inbox')
  await page.locator('.nx-row25').first().click().catch(() => undefined)
  await page.waitForTimeout(4000)
  const carried = await page.evaluate(() => {
    try { return JSON.parse(sessionStorage.getItem('nexus:property-locator:v1') || 'null') } catch { return null }
  })
  check('opening a thread carries a subject across apps', Boolean(carried?.propertyId),
    `locator=${JSON.stringify(carried)}`)
  await composition('Comps has its mobile composition', '/comp-intelligence', '.ci-m')
  await composition('Analytics renders the geographic map', '/analytics', '.geo[data-analytics="geo-mobile"]')
  await composition('Email Command is mail-first', '/email-command', '.ecc__mstatus')
  await composition('Entity Graph states its relationship scope', '/entity-graph', '.egm-relscope')

  const fatal = errors.filter((e) => !/favicon|ResizeObserver/i.test(e))
  check('no fatal JavaScript errors in portrait', fatal.length === 0, fatal.slice(0, 2).join(' | '))
  await context.close()
}

// ── 4. portrait, light — themes must still work on the deployed build ───────
console.log('\n[390x844 portrait / light]')
{
  const context = await newPhone({ width: 390, height: 844 })
  await seedTheme(context, 'light')
  const page = await context.newPage()
  await settle(page, '/inbox')
  const facts = await page.evaluate(shellFacts)
  const light = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-nexus-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
    assetLines: document.querySelectorAll('.nx-card-assetline').length,
  }))
  await page.screenshot({ path: path.join(OUT, 'portrait-light-inbox.png') })
  check('the light theme applies on the deployed build', light.theme === 'light', `theme=${light.theme}`)
  check('the asset line renders in light too', light.assetLines > 0, `${light.assetLines}`)
  check('light has no horizontal overflow', facts.overflow <= 1, `+${facts.overflow}px`)
  console.log(`  theme=${light.theme} body background=${light.bg}`)
  await context.close()
}

// ── 5. landscape — the phone must keep the mobile shell ─────────────────────
console.log('\n[844x390 landscape / dark]')
{
  const context = await newPhone({ width: 844, height: 390 })
  await seedTheme(context, 'dark')
  for (const route of ['/inbox', '/analytics', '/entity-graph', '/email-command']) {
    const page = await context.newPage()
    await settle(page, route)
    const facts = await page.evaluate(shellFacts)
    check(`landscape ${route}: the mobile shell still owns the screen`,
      facts.mobileLayout && facts.mobileOs && facts.landscapeFlag,
      JSON.stringify(facts))
    check(`landscape ${route}: no desktop command-center chrome`, !facts.desktopChrome)
    check(`landscape ${route}: no horizontal overflow`, facts.overflow <= 1, `+${facts.overflow}px`)
    await page.screenshot({ path: path.join(OUT, `landscape${route.replace(/\//g, '-')}.png`) })
    await page.close()
  }
  await context.close()
}

await browser.close()

console.log(`\nscreenshots: ${OUT}`)
if (failures.length) {
  console.error(`\n✗ ${failures.length} failure(s) against the DEPLOYED build at ${BASE}:`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\n✓ ${BASE} is serving mobile V1${EXPECT_SHA ? ` (${EXPECT_SHA})` : ''}`)
