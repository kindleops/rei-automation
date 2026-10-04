import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * MULTI-INBOX visual QA (brief §32) — READ ONLY. Prepared, NOT run: the lead
 * schedules it when the owner is off the machine.
 *
 * Every non-GET to /api or Supabase is aborted, so nothing can archive, mark
 * read, snooze or send. The pane layout is seeded through localStorage (the
 * Multi-Inbox store), never by clicking actions. Conversations are opened only
 * with the network guard on (an open's read write is aborted by the guard).
 * It counts the /api/cockpit/inbox/live requests per configuration so the
 * 1/2/3/4-pane request load is measured on real data.
 *
 *   node /Users/ryankindle/.claude/jobs/c39b0175/tmp/with-lock.mjs capture \
 *     node scripts/proof/desktop/multi-inbox-capture.mjs --themes=dark,light \
 *     --out=/Users/ryankindle/.claude/jobs/c39b0175/tmp/multi-inbox
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/multi-inbox'))
const THEMES = arg('themes', 'dark').split(',')

// §32 matrix: [width, height, count, lenses for panes 2..4]
const MATRIX = [
  [1440, 900, 1, []],
  [1440, 900, 2, ['new_replies']],
  [1440, 900, 4, ['new_replies', 'needs_review', 'follow_up']],
  [1920, 1080, 1, []],
  [1920, 1080, 2, ['new_replies']],
  [1920, 1080, 3, ['new_replies', 'needs_review']],
  [3840, 1600, 2, ['new_replies']],
  [3840, 1600, 3, ['new_replies', 'needs_review']],
  [3840, 1600, 4, ['new_replies', 'needs_review', 'follow_up']],
  [5120, 1440, 4, ['new_replies', 'needs_review', 'all_conversations']],
]

const seed = (count, lenses) => ({
  version: 1,
  count,
  panes: [
    { id: 'pane-1', label: null, query: { lens: 'priority', stage: 'all_stages', advanced: { outOfStateOwner: 'all' }, sort: 'newest' } },
    ...[0, 1, 2].map((i) => ({ id: `pane-${i + 2}`, label: null, query: { lens: lenses[i] ?? 'new_replies', stage: 'all_stages', advanced: { outOfStateOwner: 'all' }, sort: 'newest' } })),
  ],
  sizes: {},
})

await fs.mkdir(OUT, { recursive: true })
const report = []
const browser = await chromium.launch()
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 20 * 60_000)
for (const theme of THEMES) {
  for (const [W, H, count, lenses] of MATRIX) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } })
    await ctx.addInitScript(({ t, state }) => {
      try {
        const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
        localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
        for (const k of Object.keys(localStorage)) if (k.startsWith('lc.inbox.multi.v1:')) localStorage.removeItem(k)
        localStorage.setItem('lc.inbox.multi.v1:main', JSON.stringify(state))
      } catch { /* ignore */ }
    }, { t: theme, state: seed(count, lenses) })
    const page = await ctx.newPage()
    const errors = []
    let liveReads = 0
    let aborted = 0
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
    await page.route('**/*', (r) => {
      const req = r.request()
      const u = new URL(req.url())
      if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { aborted += 1; return r.abort() }
      if (u.pathname === '/api/cockpit/inbox/live') liveReads += 1
      return r.continue()
    })
    await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('.ixl', { timeout: 90000 }).catch(() => console.log('note: ledger not found'))
    // The store is keyed by the shell's instance id, so the seed may not match: set the
    // layout through the Inbox's own palette commands (a client event — no network write).
    await page.evaluate(({ count, lenses }) => {
      const fire = (detail) => window.dispatchEvent(new CustomEvent('nexus:command-action', { detail: { kind: 'inbox_multi', ...detail } }))
      fire({ op: 'set_count', count })
      lenses.forEach((view, i) => fire({ op: 'set_view', pane: i + 2, view }))
    }, { count, lenses })
    await page.waitForTimeout(6000)
    const name = `${theme}-${W}x${H}-${count}pane`
    await page.screenshot({ path: path.join(OUT, `${name}.png`) })
    report.push({ name, liveReadsFirst6s: liveReads, abortedWrites: aborted, panes: await page.locator('.ixm-pane').count(), errors })
    if (count >= 2 && W === 1920 && theme === THEMES[0]) {
      // two different searches + one conversation open (guarded: its read write is aborted)
      await page.locator('[data-ixm-pane="1"] input[type="search"], [data-ixm-pane="1"] input').first().fill('st').catch(() => {})
      await page.waitForTimeout(2500)
      await page.screenshot({ path: path.join(OUT, `${name}-search.png`) })
      await page.locator('[data-ixm-pane="1"] .ixl-row').first().click().catch(() => {})
      await page.waitForTimeout(2500)
      await page.screenshot({ path: path.join(OUT, `${name}-conversation.png`) })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(800)
      await page.screenshot({ path: path.join(OUT, `${name}-closed.png`) })
    }
    await ctx.close()
  }
}
clearTimeout(watchdog)
await browser.close()
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report.map((r) => [r.name, r.liveReadsFirst6s, r.panes, r.abortedWrites, r.errors.length])))
