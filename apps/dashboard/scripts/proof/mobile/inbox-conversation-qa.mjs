/**
 * INBOX + CONVERSATION — MOBILE PROOF.
 *
 * READ ONLY. Loads the list, opens a thread, reads geometry and typography.
 * It never sends, schedules, replies or mutates. Opening a thread does mark it
 * read, which is ordinary operator behaviour and the only state it touches.
 *
 * WHAT IT MEASURES, AND WHY
 *   §3/§4 the card's four levels are actually ordered. The check that matters
 *         is `previewBeatsMoney`: the seller's message must render LARGER than
 *         the property value beside it. Before this pass the reply was 11.5px
 *         and "$297K" was 12px -- the message an operator opens the Inbox to
 *         read was the quietest thing on the row, and no assertion about
 *         "hierarchy" in the abstract would have caught it.
 *   §4    no chip truncated. A chip that renders "TIRED LANDLO" costs the same
 *         room as the full label and says less, so scrollWidth is compared
 *         against the painted box rather than trusting max-width.
 *   §3    the communication state survives a long property line. The state was
 *         flex-shrinkable and the asset line rigid, so "Outbound · Failed"
 *         clipped to "Out..." on multifamily rows.
 *   §6    nothing below the 11px floor anywhere in the list.
 *   §30   the conversation paints a VISIBLE skeleton while hydrating -- it was
 *         present in the DOM but 381x0 and transparent in every theme but one.
 *   §36   real geometry, not just scrollWidth.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, f) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${f}`).replace(`--${n}=`, '')
const BASE = arg('base', 'http://localhost:5174')
const WIDTHS = arg('width', '375,390,393,430').split(',').map(Number)
const THEMES = arg('theme', 'dark,light,red_ops,true_black').split(',')

const OUT = path.resolve('artifacts/inbox-conversation')
await fs.mkdir(OUT, { recursive: true })
const findings = []
const check = (cell, label, ok, detail = '') => { if (!ok) findings.push({ cell, label, detail }); return ok }

const readList = () => {
  const card = document.querySelector('.nx-row25')
  if (!card) return { present: false }
  const px = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : null)
  const q = (s) => card.querySelector(s)

  // Every chip on screen, and whether it can say its own name.
  const chips = [...document.querySelectorAll('.nx-row25 .nx-prop-flags__badge')]
    .filter((c) => c.getBoundingClientRect().width > 0)
    .map((c) => ({ text: c.textContent, clipped: c.scrollWidth > Math.ceil(c.getBoundingClientRect().width) }))

  // The communication state must not be the thing that gives way.
  const states = [...document.querySelectorAll('.nx-row25__footer .nx-card-state__label')]
    .filter((s) => s.getBoundingClientRect().width > 0)
    .map((s) => ({ text: s.textContent, clipped: s.scrollWidth > Math.ceil(s.getBoundingClientRect().width) }))

  const tiny = []
  for (const el of document.querySelectorAll('.nx-row25 *')) {
    if (!el.textContent?.trim() || el.children.length) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const size = parseFloat(getComputedStyle(el).fontSize)
    if (size && size < 11) tiny.push(`${size}px:${el.textContent.trim().slice(0, 14)}`)
  }

  const sizes = new Set()
  for (const el of document.querySelectorAll('.nx-row25 *')) {
    if (!el.textContent?.trim() || el.children.length) continue
    if (el.getBoundingClientRect().width === 0) continue
    sizes.add(getComputedStyle(el).fontSize)
  }

  return {
    present: true,
    rows: document.querySelectorAll('.nx-row25').length,
    name: px(q('.nx-row25__name')),
    preview: px(q('.nx-row25__preview')),
    money: px(q('.nx-card-assetline__value')),
    addr: px(q('.nx-row25__addr')),
    distinctSizes: sizes.size,
    chipsClipped: chips.filter((c) => c.clipped).map((c) => c.text),
    // PER CARD, not across the whole list -- the first version counted every
    // chip on screen (71) and read as a per-row violation.
    chipsPerCard: Math.max(0, ...[...document.querySelectorAll('.nx-row25')].map(
      (c) => c.querySelectorAll('.nx-prop-flags__visible .nx-prop-flags__badge').length)),
    statesClipped: states.filter((s) => s.clipped).map((s) => s.text),
    tiny: [...new Set(tiny)].slice(0, 5),
    overflow: Math.max(0, Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth)),
  }
}

const browser = await chromium.launch()
let cells = 0

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    const cell = `${width}-${theme}`
    const ctx = await browser.newContext({
      viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    })
    await ctx.addInitScript((t) => {
      try {
        /*
         * THE REAL KEY. Both proofs previously wrote localStorage['nexus.theme'],
         * which nothing reads: the app persists settings as JSON on
         * `nexus-settings` and applies `data-nexus-theme` from its nexusTheme
         * field (src/shared/settings.ts). Every "theme" cell was therefore
         * rendering the default dark, and a four-theme matrix was really one
         * theme run sixteen times. Caught by LOOKING at a light-theme capture
         * and seeing a dark screen -- no assertion in the matrix could have,
         * because every cell genuinely passed against dark.
         */
        const raw = localStorage.getItem('nexus-settings')
        const next = raw ? JSON.parse(raw) : {}
        next.nexusTheme = t
        localStorage.setItem('nexus-settings', JSON.stringify(next))
      } catch { /* ignore */ }
    }, theme)
    const page = await ctx.newPage()
    try {
      await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      // Settle on real rows, never a fixed sleep: the list takes ~15s here.
      await page.waitForFunction(() => document.querySelectorAll('.nx-row25').length > 0,
        undefined, { timeout: 90_000, polling: 500 }).catch(() => {})
      await page.waitForTimeout(2000)

      const m = await page.evaluate(readList)
      check(cell, 'the thread list renders rows', m.present && m.rows > 0, `rows=${m.rows}`)
      if (m.present) {
        check(cell, '§3 identity outranks everything', m.name > m.preview, `name=${m.name} preview=${m.preview}`)
        check(cell, '§3 THE MESSAGE BEATS THE MONEY', m.preview > m.money, `preview=${m.preview} money=${m.money}`)
        check(cell, '§3 property context sits below the message', m.addr < m.preview, `addr=${m.addr} preview=${m.preview}`)
        check(cell, '§4 at most two signal chips inline', m.chipsPerCard <= 2, `${m.chipsPerCard}`)
        check(cell, '§4 no chip truncates its own label', m.chipsClipped.length === 0, m.chipsClipped.join(', '))
        check(cell, '§3 the communication state is never clipped', m.statesClipped.length === 0, m.statesClipped.join(', '))
        check(cell, '§6 no card text below the 11px floor', m.tiny.length === 0, m.tiny.join(', '))
        check(cell, '§6 the card uses at most 5 type sizes', m.distinctSizes <= 5, `${m.distinctSizes}`)
        check(cell, '§36 no horizontal overflow', m.overflow === 0, `${m.overflow}px`)
      }

      if (width === 390) await page.screenshot({ path: path.join(OUT, `list-${theme}.png`) })

      // ── CONVERSATION ────────────────────────────────────────────────────
      const box = await page.locator('.nx-row25').first().boundingBox()
      if (box) {
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
        await page.waitForTimeout(2500)
        const c = await page.evaluate(() => {
          const sk = [...document.querySelectorAll('.nx-chat-skeleton__bubble')]
          const painted = sk.filter((b) => {
            const r = b.getBoundingClientRect()
            return r.height > 8 && r.width > 40
          })
          const back = document.querySelector('.nx-mobile-command-dock__btn--back')
          const bar = document.querySelector('.nx-mobile-command-dock__inner')
          const br = back?.getBoundingClientRect()
          const ar = bar?.getBoundingClientRect()
          const comp = document.querySelector('[class*="composer"]')?.getBoundingClientRect()
          const dock = document.querySelector('.nx-pinned-app-dock')?.getBoundingClientRect()
          return {
            skeletonNodes: sk.length,
            skeletonPainted: painted.length,
            backPresent: !!back,
            backInsideBar: br && ar ? br.bottom <= ar.bottom + 1 && br.width > 44 : null,
            composerClearsDock: comp && dock ? comp.bottom <= dock.top + 1 : null,
            bubbles: document.querySelectorAll('[class*="bubble"]:not([class*="skeleton"])').length,
          }
        })
        check(cell, '§3 Back is present in the conversation', c.backPresent, '')
        check(cell, '§19 Back renders inline, not stacked', c.backInsideBar !== false, 'label wrapped below the glyph')
        // Only assert the skeleton when the thread is still hydrating.
        if (c.skeletonNodes > 0) {
          check(cell, '§30 the loading skeleton is actually painted',
            c.skeletonPainted === c.skeletonNodes, `${c.skeletonPainted}/${c.skeletonNodes} visible`)
        }
        check(cell, '§19 the composer clears the dock', c.composerClearsDock !== false, '')
        if (width === 390) await page.screenshot({ path: path.join(OUT, `conversation-${theme}.png`) })
      }
      cells += 1
    } catch (error) {
      findings.push({ cell, label: 'cell failed', detail: String(error?.message || error).slice(0, 130) })
    } finally { await ctx.close() }
  }
}

await browser.close()
console.log('─'.repeat(72))
if (findings.length === 0) console.log(`PASS — ${cells} cells, 0 findings`)
else {
  console.log(`FAIL — ${findings.length} finding(s) across ${cells} cells`)
  const seen = new Map()
  for (const f of findings) {
    const k = `${f.label} :: ${f.detail}`
    seen.set(k, (seen.get(k) || 0) + 1)
  }
  for (const [k, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(`  x${n}  ${k}`)
  process.exitCode = 1
}
