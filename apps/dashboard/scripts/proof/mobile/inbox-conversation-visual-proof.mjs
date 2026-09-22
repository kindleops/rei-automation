/**
 * §11/§12/§13 — ORIENTATION, REAL THEMES, WIDTH MATRIX.
 *
 * READ ONLY. Opens a conversation and the dossier; writes nothing.
 *
 * THEMES ARE ASSERTED, NOT ASSUMED. The harness seeds
 * localStorage['nexus-settings'].nexusTheme and then reads back the rendered
 * `data-nexus-theme` attribute. An earlier matrix in this programme passed a
 * theme label on the command line, wrote a key nothing reads, and rendered dark
 * sixteen times -- so the label is treated as an input and the attribute as the
 * evidence.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, f) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${f}`).replace(`--${n}=`, '')
const BASE = arg('base', 'http://localhost:5174')
const WIDTHS = arg('width', '375,390,393,430').split(',').map(Number)
const THEMES = arg('theme', 'dark,light,red_ops,true_black').split(',')

const OUT = path.resolve('artifacts/inbox-conversation-final')
await fs.mkdir(OUT, { recursive: true })
const findings = []
const check = (cell, label, ok, detail = '') => {
  if (!ok) findings.push({ cell, label, detail })
  return ok
}

const seedTheme = (theme) => (t) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    const next = raw ? JSON.parse(raw) : {}
    next.nexusTheme = t
    localStorage.setItem('nexus-settings', JSON.stringify(next))
  } catch { /* ignore */ }
}

const openConversation = async (page, index = 2, attempt = 0) => {
  await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
  await page.waitForFunction(() => document.querySelectorAll('.nx-row25').length > 0,
    undefined, { timeout: 180_000, polling: 400 }).catch(() => {})
  await page.waitForTimeout(900)
  const box = await page.locator('.nx-row25').nth(index).boundingBox().catch(() => null)
  if (!box) return false
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
  /*
   * Wait for MESSAGES, not merely for the list element. Probing the moment the
   * container exists captured a baseline of 0 messages, and the orientation
   * checks then reported "msgs 0 -> 7" as if rotation had changed the thread.
   */
  await page.waitForFunction(() => {
    const n = document.querySelector('.nx-message-list')
    if (!n || document.querySelectorAll('.nx-chat-skeleton__bubble').length > 0) return false
    return n.querySelectorAll('.nx-msg').length > 0
  }, undefined, { timeout: 120_000, polling: 300 }).catch(() => {})
  /*
   * Retry once on a cold load. Against a dev server holding production-shaped
   * data an occasional load never mounts the conversation inside the window;
   * that is this harness's environment, not the product, and letting it score
   * as a theme or orientation failure buries the real signal.
   */
  const mounted = await page.evaluate(() => {
    const n = document.querySelector('.nx-message-list')
    return Boolean(n) && n.querySelectorAll('.nx-msg').length > 0
  })
  if (!mounted && attempt < 1) return openConversation(page, index, attempt + 1)
  return mounted
}

const probe = () => {
  const doc = document.documentElement
  const list = document.querySelector('.nx-message-list')
  const comp = document.querySelector('[class*="composer"]')
  const dock = document.querySelector('.nx-pinned-app-dock')
  const back = document.querySelector('.nx-mobile-command-dock__btn--back')
  const cr = comp?.getBoundingClientRect()
  const dr = dock?.getBoundingClientRect()
  const br = back?.getBoundingClientRect()
  const msgs = list ? list.querySelectorAll('.nx-msg').length : 0

  // Contrast-ish sanity: message text must not match its own bubble background.
  const bubble = document.querySelector('.nx-msg__bubble')
  const bs = bubble ? getComputedStyle(bubble) : null

  return {
    theme: doc.getAttribute('data-nexus-theme'),
    list: Boolean(list),
    msgs,
    composerVisible: cr ? cr.height > 0 && cr.bottom <= window.innerHeight + 1 : false,
    composerClearsDock: cr && dr ? cr.bottom <= dr.top + 1 : null,
    backPresent: Boolean(back),
    backInBar: br ? br.width > 44 && br.top >= 0 : null,
    bubbleColour: bs ? bs.color : null,
    bubbleBg: bs ? bs.backgroundColor : null,
    overflowX: Math.max(0, Math.round(doc.scrollWidth - doc.clientWidth)),
  }
}

const browser = await chromium.launch()

// ── §12/§13 THEME x WIDTH ──────────────────────────────────────────────────
for (const width of WIDTHS) {
  for (const theme of THEMES) {
    const cell = `${width}-${theme}`
    const ctx = await browser.newContext({
      viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    })
    await ctx.addInitScript(seedTheme(theme), theme)
    const page = await ctx.newPage()
    try {
      const opened = await openConversation(page)
      const m = await page.evaluate(probe)
      check(cell, 'conversation opened', opened && m.list, `list=${m.list}`)
      // The label is an input; the attribute is the evidence.
      check(cell, 'the requested theme is the one rendered', m.theme === theme, `asked ${theme}, got ${m.theme}`)
      check(cell, 'messages present', m.msgs > 0, `msgs=${m.msgs}`)
      check(cell, 'composer visible in viewport', m.composerVisible, '')
      check(cell, 'composer clears the dock', m.composerClearsDock !== false, '')
      check(cell, 'Back present and inline', m.backPresent && m.backInBar !== false, `present=${m.backPresent} inline=${m.backInBar}`)
      check(cell, 'bubble text is not its own background', m.bubbleColour !== m.bubbleBg, `${m.bubbleColour} on ${m.bubbleBg}`)
      check(cell, 'no horizontal overflow', m.overflowX === 0, `${m.overflowX}px`)

      if (width === 390) {
        await page.screenshot({ path: path.join(OUT, `conversation-${theme}.png`) })
        // Dossier in every theme.
        await page.locator('[aria-label="Open quick actions"]').first().click({ timeout: 30_000 }).catch(() => {})
        await page.getByRole('button', { name: /Offer \/ Deal/i }).first().click({ timeout: 30_000 }).catch(() => {})
        const sheet = await page.waitForFunction(() => document.querySelector('.nx-pis') !== null,
          undefined, { timeout: 25_000, polling: 200 }).then(() => true).catch(() => false)
        check(cell, 'Property Intelligence opens', sheet, '')
        if (sheet) {
          const s = await page.evaluate(() => {
            const el = document.querySelector('.nx-pis')
            const r = el.getBoundingClientRect()
            return {
              inViewport: r.left >= -1 && r.right <= window.innerWidth + 1,
              overflowX: Math.max(0, Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth)),
            }
          })
          check(cell, 'dossier fits the viewport', s.inViewport && s.overflowX === 0, `overflow=${s.overflowX}px`)
          await page.screenshot({ path: path.join(OUT, `dossier-${theme}.png`) })
        }
      }
    } catch (error) {
      findings.push({ cell, label: 'cell failed', detail: String(error?.message || error).slice(0, 110) })
    } finally { await ctx.close() }
  }
}

// ── §11 ORIENTATION ────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  })
  const page = await ctx.newPage()
  await openConversation(page)
  const before = await page.evaluate(probe)
  // A draft must survive rotation.
  await page.locator('[class*="composer"] textarea, [class*="composer"] input').first()
    .fill('orientation proof draft').catch(() => {})
  await page.waitForTimeout(400)

  await page.setViewportSize({ width: 844, height: 390 })
  await page.waitForFunction((n) => {
    const l = document.querySelector('.nx-message-list')
    return Boolean(l) && l.querySelectorAll('.nx-msg').length >= n
  }, before.msgs, { timeout: 30_000, polling: 300 }).catch(() => {})
  await page.waitForTimeout(1200)
  const land = await page.evaluate(probe)
  const landDraft = await page.evaluate(() =>
    (document.querySelector('[class*="composer"] textarea, [class*="composer"] input'))?.value ?? '')
  check('landscape', '§11 stays on the same conversation', land.list && land.msgs === before.msgs,
    `msgs ${before.msgs} -> ${land.msgs}`)
  check('landscape', '§11 no duplicate messages', land.msgs === before.msgs, '')
  check('landscape', '§11 composer usable', land.composerVisible, '')
  check('landscape', '§11 draft survives rotation', landDraft.includes('orientation proof'), `"${landDraft.slice(0, 24)}"`)
  check('landscape', '§11 mobile shell retained', land.backPresent, '')
  check('landscape', '§11 no horizontal overflow', land.overflowX === 0, `${land.overflowX}px`)
  await page.screenshot({ path: path.join(OUT, 'landscape.png') })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction((n) => {
    const l = document.querySelector('.nx-message-list')
    return Boolean(l) && l.querySelectorAll('.nx-msg').length >= n
  }, before.msgs, { timeout: 30_000, polling: 300 }).catch(() => {})
  await page.waitForTimeout(1200)
  const back = await page.evaluate(probe)
  const backDraft = await page.evaluate(() =>
    (document.querySelector('[class*="composer"] textarea, [class*="composer"] input'))?.value ?? '')
  check('portrait-return', '§11 same conversation after rotating back', back.list && back.msgs === before.msgs,
    `msgs ${before.msgs} -> ${back.msgs}`)
  check('portrait-return', '§11 draft still there', backDraft.includes('orientation proof'), `"${backDraft.slice(0, 24)}"`)
  check('portrait-return', '§11 no horizontal overflow', back.overflowX === 0, `${back.overflowX}px`)
  await ctx.close()
}

await browser.close()
console.log('─'.repeat(68))
if (findings.length === 0) console.log(`PASS — ${WIDTHS.length * THEMES.length} cells + orientation, 0 findings`)
else {
  console.log(`FAIL — ${findings.length} finding(s)`)
  const seen = new Map()
  for (const f of findings) {
    const k = `${f.label} :: ${f.detail}`
    seen.set(k, (seen.get(k) || 0) + 1)
  }
  for (const [k, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(`  x${n}  ${k}`)
  process.exitCode = 1
}
