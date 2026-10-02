import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * R8.2 §5 residue FIXES — read-only proof. Non-GET to /api or Supabase is
 * aborted. Never clicks an app control. The SystemToast / LCConfirm /
 * lcPrompt frames are raised by importing the shared LC module from the dev
 * server (the same module instance the app uses) and calling lcToast /
 * lcConfirm / lcPrompt with the exact production copy; each ask is then
 * dismissed with Escape (which resolves "no"). No action handler runs.
 *
 *   node scripts/proof/desktop/r82-residue-fixed-capture.mjs --themes=dark,light --out=/tmp/residue-fixed
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/r82-residue-fixed'))
const THEMES = arg('themes', 'dark,light').split(',')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
const SETTLE = Number(arg('settle', '9000'))
const only = arg('only', '')

// [name, route, kind]
const SHOTS = [
  ['entity-graph', '/entity-graph', 'settle'],
  ['email-command-loading', '/email-command', 'early'],
  ['email-command', '/email-command', 'settle'],
  ['closing-desk-loading', '/closing-desk', 'early'],
  ['workflow-studio-loading', '/workflow-studio', 'early'],
  ['calendar-loading', '/calendar', 'early'],
  ['map-loading', '/map', 'early'],
  ['toast', '/campaign-command', 'toast'],
  ['confirm-convert-live', '/campaign-command', 'confirm-live'],
  ['confirm-delete-draft', '/campaign-command', 'confirm-delete'],
  ['confirm-send-override', '/inbox', 'confirm-override'],
  ['prompt-rename', '/campaign-command', 'prompt'],
]

await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 1_200_000)
const browser = await chromium.launch()
const summary = []
const LC = '/src/shared/lc/index.ts'

for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  await ctx.addInitScript((t) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  await ctx.route('**/*', (r) => {
    const req = r.request()
    const u = new URL(req.url())
    if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      summary.push({ blocked: `${req.method()} ${u.pathname}` })
      return r.abort()
    }
    return r.continue()
  })
  for (const [name, route, kind] of SHOTS) {
    if (only && !only.split(',').includes(name)) continue
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)))
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 90000 })
      if (kind === 'early') {
        // first frame where the pane's own loading plane is up (or the app is in)
        const hit = await page.waitForSelector('.lc-pane-loading', { timeout: 30000 }).then(() => true).catch(() => false)
        summary.push({ theme, name, paneLoadingSeen: hit })
        if (!hit) await page.waitForTimeout(SETTLE)
      } else {
        await page.waitForTimeout(SETTLE)
      }
      if (kind === 'toast') {
        await page.evaluate(async (lc) => {
          const m = await import(lc)
          m.lcToast({ title: 'Campaign duplicated', detail: 'New draft created from "Dallas — Absentee".', severity: 'success' })
          m.lcToast({ title: 'Batch blocked', detail: 'Outside the send window · 0 ready targets', severity: 'warning' })
          m.lcToast({ title: 'Couldn’t pause Dallas — Absentee', detail: 'It’s still sending. Try again.', severity: 'critical' })
        }, LC)
        await page.waitForTimeout(900)
      }
      if (kind.startsWith('confirm') || kind === 'prompt') {
        await page.evaluate(async ([lc, k]) => {
          const m = await import(lc)
          const name = 'Dallas — Absentee'
          if (k === 'confirm-live') {
            void m.lcConfirm({
              title: `Convert "${name}" to a LIVE campaign?`,
              effects: [
                { text: 'This will purge test queue rows, hydrate the real send path, and schedule the next valid sending window.', kind: 'stops' },
                { text: 'Targets, pacing, caps, and templates are preserved.', kind: 'keeps' },
              ],
              confirmLabel: 'Convert to live',
              nativeText: 'x',
            })
          } else if (k === 'confirm-delete') {
            void m.lcConfirm({ title: `Delete draft "${name}"?`, effects: [{ text: 'This cannot be undone.', kind: 'danger' }], confirmLabel: 'Delete draft', tone: 'danger', nativeText: 'x' })
          } else if (k === 'confirm-override') {
            void m.lcConfirm({ title: 'Retry anyway?', effects: [{ text: 'Recent delivery issue detected.', kind: 'stops' }], confirmLabel: 'Retry anyway', nativeText: 'x' })
          } else {
            void m.lcPrompt({ title: 'Rename campaign', label: 'Campaign name', initialValue: name, confirmLabel: 'Rename', nativeText: 'x' })
          }
        }, [LC, kind])
        await page.waitForTimeout(700)
      }
      await page.screenshot({ path: path.join(OUT, `${theme}-${name}.png`) })
      if (kind.startsWith('confirm') || kind === 'prompt') await page.keyboard.press('Escape')
      summary.push({ theme, name, errors: errors.slice(0, 3) })
    } catch (e) {
      summary.push({ theme, name, fail: String(e.message).slice(0, 160) })
    }
    await page.close()
  }
  await ctx.close()
}
await browser.close()
clearTimeout(watchdog)
console.log(JSON.stringify(summary, null, 1))
