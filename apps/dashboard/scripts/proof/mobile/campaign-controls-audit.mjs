import { chromium } from 'playwright'
// Read-only audit of every interactive control on the mobile Campaign surfaces.
// Flags: DEAD (no React click/submit/change handler), SMALL (< 40px in a dimension,
// not counting ::after extensions), COVERED (something else is on top at its centre).
// All non-GET API calls are aborted, so nothing tapped here can write.
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
await p.route('**/api/**', (route) => (['GET', 'OPTIONS'].includes(route.request().method()) ? route.continue() : route.abort()))
const errs = []; p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))

async function audit(label, rootSel) {
  const rows = await p.evaluate((rootSel) => {
    const roots = [...document.querySelectorAll(rootSel)]
    const out = []
    for (const root of roots) {
      for (const el of root.querySelectorAll('button, a, [role="button"], [role="tab"], input, select, textarea, label')) {
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) continue
        const key = Object.keys(el).find((k) => k.startsWith('__reactProps'))
        const props = key ? el[key] : {}
        const tag = el.tagName.toLowerCase()
        const handled = Boolean(
          props.onClick || props.onPointerDown || props.onPointerUp || props.onTouchEnd || props.onMouseDown ||
          props.onChange || props.onInput || props.onKeyDown ||
          (tag === 'a' && el.getAttribute('href')) ||
          (tag === 'button' && el.getAttribute('type') === 'submit' && el.closest('form')) ||
          (tag === 'label' && (el.querySelector('input,select,textarea') || el.getAttribute('for'))),
        )
        if (tag === 'label' && !el.querySelector('input,select,textarea') && !el.getAttribute('for')) continue
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2
        const inViewport = cy > 0 && cy < window.innerHeight
        const top = inViewport ? document.elementFromPoint(cx, cy) : null
        out.push({
          text: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 36),
          tag,
          dead: !handled && !el.disabled,
          disabled: Boolean(el.disabled),
          w: Math.round(r.width), h: Math.round(r.height),
          covered: inViewport && top ? !(el === top || el.contains(top) || top.contains(el)) : null,
        })
      }
    }
    return out
  }, rootSel)
  const flagged = rows.filter((r) => r.dead || r.covered || Math.min(r.w, r.h) < 40)
  console.log(`\n[${label}] ${rows.length} controls${flagged.length ? '' : ' — all handled, ≥40px, uncovered'}`)
  for (const r of flagged) {
    const flags = [r.dead && 'DEAD', r.covered && 'COVERED', Math.min(r.w, r.h) < 40 && `SMALL ${r.w}×${r.h}`].filter(Boolean).join(' ')
    console.log(`   ${flags.padEnd(22)} <${r.tag}> "${r.text}"`)
  }
}

await p.goto('http://localhost:5173/campaign-command', { waitUntil: 'domcontentloaded', timeout: 180000 })
await p.waitForSelector('.cxc__hit', { timeout: 120000 }); await p.waitForTimeout(2000)
await audit('index', '.cxi')
await p.locator('[aria-label="Search campaigns"]').first().click(); await p.waitForTimeout(600)
await audit('index + search sheet', '.cxi__search')
await p.locator('[aria-label="Search campaigns"]').first().click(); await p.waitForTimeout(400)

await p.locator('.cxc__hit').filter({ hasText: /Miami - Test Campaign/ }).first().click()
await p.waitForSelector('.cdm2', { timeout: 60000 }); await p.waitForTimeout(3500)
await audit('detail: bar + hero + tabs', '.cdb2, .cdh, .cst')
const tabs = (await p.locator('.cst__tab').allTextContents()).map((s) => s.trim())
for (const [i, t] of tabs.entries()) {
  await p.locator('.cst__tab').nth(i).click(); await p.waitForTimeout(5000)
  await audit(`section: ${t}`, '.cdm2__section')
}
await audit('dock', '.cad')
await p.locator('.cad__more').click(); await p.waitForTimeout(800)
await audit('more sheet', '.cad-sheet')
await p.locator('.cad-sheet__cancel').click(); await p.waitForTimeout(500)
if (errs.length) console.log('\npage errors:', errs)
await b.close()
