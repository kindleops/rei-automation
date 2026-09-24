import { chromium } from 'playwright'
// Read-only control audit of the mobile Campaign index. Taps every control
// class on the index and checks where it lands; audits every interactive
// element for a handler, a >=40px target and nothing on top of it.
// Non-GET requests are aborted — nothing tapped here can write.
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const writes = []
await p.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (writes.push(r.request().url()), r.abort())))
await p.addInitScript(() => { try { sessionStorage.clear() } catch {} })
const findings = []
const note = (ok, what) => { if (!ok) findings.push(what) }
const home = async () => {
  await p.goto('http://localhost:5173/campaign-command', { waitUntil: 'domcontentloaded', timeout: 180000 })
  await p.waitForSelector('[data-campaign-card]', { timeout: 120000 }); await p.waitForTimeout(1500)
}
await home()

const audit = await p.evaluate(() => {
  const out = []
  for (const el of document.querySelectorAll('.cxi button, .cxi [role="tab"]')) {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue
    const key = Object.keys(el).find((k) => k.startsWith('__reactProps'))
    const handled = Boolean(key && el[key].onClick)
    const after = getComputedStyle(el, '::after')
    const ax = after.content !== 'none' ? Math.max(0, -parseFloat(after.left || '0')) : 0
    const ay = after.content !== 'none' ? Math.max(0, -parseFloat(after.top || '0')) : 0
    const w = r.width + 2 * ax, h = r.height + 2 * ay
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    const covered = top && !(el === top || el.contains(top))
    out.push({ label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30), handled, w: Math.round(w), h: Math.round(h), covered })
  }
  return out
})
for (const c of audit) {
  note(c.handled, `DEAD: ${c.label}`)
  note(Math.min(c.w, c.h) >= 40, `SMALL ${c.w}x${c.h}: ${c.label}`)
  note(!c.covered, `COVERED: ${c.label}`)
}

// New campaign opens the existing builder, and closing it returns to the index.
await p.locator('[aria-label="New campaign"]').click()
note(await p.waitForSelector('.cmp-studio--mobile', { timeout: 30000 }).then(() => true, () => false), 'New campaign did not open the builder')
await p.locator('[aria-label="Close builder"]').click(); await p.waitForTimeout(600)
note(await p.locator('.cxi').count() === 1, 'builder close did not return to the index')

// Draft "Continue" opens the builder in edit mode on that campaign.
await p.locator('.cxi__seg-tab', { hasText: /^Drafts/ }).click(); await p.waitForTimeout(400)
const draftName = await p.locator('[data-kind="draft"] .cxc__name').first().textContent()
await p.locator('[data-kind="draft"] .cxc__pill').first().click()
note(await p.waitForSelector('.cmp-studio--mobile', { timeout: 30000 }).then(() => true, () => false), 'Continue did not open the builder')
await p.waitForFunction((n) => [...document.querySelectorAll('.cmp-studio--mobile input')].some((i) => i.value === n), draftName.trim(), { timeout: 20000 }).catch(() => {})
// The name lives in the builder's title and in its name input's value.
const builderTitle = await p.locator('.cmp-studio--mobile').first().evaluate((el) =>
  `${el.textContent} ${[...el.querySelectorAll('input')].map((i) => i.value).join(' ')}`)
note(builderTitle.includes(draftName.trim()), `builder opened on another campaign (wanted ${draftName})`)
await p.locator('[aria-label="Close builder"]').click(); await p.waitForTimeout(600)
note(/^Drafts/.test(await p.locator('.cxi__seg-tab[aria-selected="true"]').textContent()), 'builder close lost the Drafts tab')

// Ready "Schedule" and hold "Review targeting" open that campaign's detail.
for (const [sel, what] of [['[data-kind="ready"] .cxc__pill', 'Schedule'], ['[data-kind="hold"] .cxc__action', 'Review targeting']]) {
  const card = p.locator(sel).first()
  if (!(await card.count())) continue
  const name = await p.locator(sel.split(' ')[0]).first().locator('.cxc__name').textContent()
  await card.click()
  const opened = await p.waitForSelector('.cdm2', { timeout: 30000 }).then(() => true, () => false)
  note(opened, `${what} did not open detail`)
  const detailTitle = opened ? await p.locator('.cdm2').first().textContent() : ''
  note(detailTitle.includes(name.trim()), `${what} opened the wrong campaign`)
  await p.locator('.cdb2 button').first().click(); await p.waitForSelector('.cxi', { timeout: 30000 }); await p.waitForTimeout(500)
}

// A card opens exactly one detail (no double navigation).
await p.locator('.cxi__seg-tab').first().click(); await p.waitForTimeout(300)
const urlBefore = p.url()
await p.locator('.cxc__hit').first().click(); await p.waitForSelector('.cdm2', { timeout: 30000 })
const histLen = await p.evaluate(() => history.length)
await p.locator('.cdb2 button').first().click(); await p.waitForSelector('.cxi', { timeout: 30000 })
note(p.url() === urlBefore, `URL after round trip ${p.url()}`)

note(writes.length === 0, `writes attempted: ${writes.join(', ')}`)
console.log(JSON.stringify({ controls: audit.length, histLen }))
console.log(findings.length ? `FINDINGS:\n  ${findings.join('\n  ')}` : 'ALL CONTROLS PASS')
await b.close()
