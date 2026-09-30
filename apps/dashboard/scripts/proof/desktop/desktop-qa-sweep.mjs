import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * DESKTOP QA SWEEP — every app × size × theme, one app per window (READ ONLY:
 * non-GET /api aborted). Waits for real readiness instead of a fixed sleep,
 * then measures what a reviewer would catch by eye: sideways overflow inside
 * the pane, content spilling past the pane edge, stuck "Loading…", garbage
 * text (NaN / undefined / [object Object]), sub-10px text, crash boundaries,
 * page errors and any attempted write.
 *
 *   node scripts/proof/desktop/desktop-qa-sweep.mjs
 *   node scripts/proof/desktop/desktop-qa-sweep.mjs --sizes=1440x900 --themes=dark --routes=pipeline,inbox
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/desktop-qa'))
const SIZES = arg('sizes', '1280x800,1440x900,1920x1080,5120x1440').split(',').map((s) => s.split('x').map(Number))
const THEMES = arg('themes', 'dark,light').split(',')
const ROUTES = arg('routes', 'home,inbox,email-command,deal-intelligence,entity-graph,comp-intelligence,buyer-match,map,pipeline,queue,campaign-command,workflow-studio,closing-desk,calendar,analytics,settings').split(',')
const SCALE = Number(arg('scale', 1))
await fs.mkdir(OUT, { recursive: true })

const NOISE = /ResizeObserver loop|Download the React DevTools|favicon|net::ERR_ABORTED|Failed to load resource/i

async function settle(page, route) {
  await page.waitForSelector('.dsk-pane__body', { timeout: 60000 })
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {})
  if (route === 'map') {
    await page.waitForSelector('.dsk-pane__body canvas', { timeout: 45000 }).catch(() => {})
    await page.waitForTimeout(5000)
    return
  }
  // a pane still saying "Loading…" is not ready yet — give it a bounded chance
  await page.waitForFunction(() => {
    const body = document.querySelector('.dsk-pane__body')
    if (!body) return false
    return ![...body.querySelectorAll('*')].some((el) => el.children.length === 0 && /^\s*Loading\b/i.test(el.textContent || '') && el.getClientRects().length)
  }, null, { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1800)
}

function measure() {
  const body = document.querySelector('.dsk-pane__body')
  const pr = body?.getBoundingClientRect()
  const visible = (el) => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05 }
  const leaves = body ? [...body.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent || '').trim()) : []
  const garbage = []; const stuck = []; const tiny = new Set(); const spill = []
  for (const el of leaves) {
    if (!visible(el)) continue
    const t = (el.textContent || '').trim()
    if (/\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b|^null$/.test(t)) garbage.push(t.slice(0, 60))
    if (/^Loading\b/i.test(t)) stuck.push(t.slice(0, 40))
    const fs = parseFloat(getComputedStyle(el).fontSize)
    if (fs && fs < 10) tiny.add(`${fs}px:${t.slice(0, 24)}`)
    const r = el.getBoundingClientRect()
    if (pr && r.right > pr.right + 2 && r.left < pr.right) {
      // clipped by a scroller is fine — only flag spill that is actually painted past the pane
      let clipped = false
      for (let a = el.parentElement; a && a !== body; a = a.parentElement) {
        const cs = getComputedStyle(a)
        if (/(auto|scroll|hidden|clip)/.test(cs.overflowX) && a.getBoundingClientRect().right <= pr.right + 2) { clipped = true; break }
      }
      if (!clipped) spill.push(`${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]}:${t.slice(0, 24)}`)
    }
  }
  const text = body?.textContent || ''
  return {
    docOverflowX: document.documentElement.scrollWidth - innerWidth,
    paneOverflowX: body ? body.scrollWidth - body.clientWidth : null,
    garbage: garbage.slice(0, 6),
    stuckLoading: stuck.slice(0, 4),
    tinyText: [...tiny].slice(0, 6),
    spill: spill.slice(0, 6),
    crashed: /crashed|Something went wrong/i.test(text),
    title: document.querySelector('.dsk-pane__body h1, .dsk-pane__body h2')?.textContent?.trim().slice(0, 60) || null,
  }
}

const browser = await chromium.launch()
const summary = []
for (const theme of THEMES) {
  for (const [W, H] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE })
    await ctx.addInitScript((t) => {
      try {
        localStorage.removeItem('nexus.desktop.split')
        localStorage.setItem('nexus.desktop.ultrawide.seeded', '1') // one app per window here; splits are their own proof
        const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
        localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      } catch { /* ignore */ }
    }, theme)
    const page = await ctx.newPage()
    const errors = []; const blocked = []
    page.on('pageerror', (e) => errors.push(`${new URL(page.url()).pathname} :: ${String(e.message).slice(0, 180)}`))
    page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(`${new URL(page.url()).pathname} :: console ${m.text().slice(0, 180)}`) })
    await page.route('**/api/**', (r) => { const m = r.request().method(); if (['GET', 'OPTIONS', 'HEAD'].includes(m)) return r.continue(); blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort() })
    const R = {}
    const tag = `${theme}-${W}x${H}`
    for (const route of ROUTES) {
      try {
        await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
        await settle(page, route)
        R[route] = await page.evaluate(measure)
        await page.screenshot({ path: `${OUT}/${tag}-${route}.png` })
        const m = R[route]
        const flags = [
          m.docOverflowX > 0 && `doc+${m.docOverflowX}`,
          m.paneOverflowX > 1 && `pane+${m.paneOverflowX}`,
          m.garbage.length && `garbage:${m.garbage.join('|')}`,
          m.stuckLoading.length && `loading:${m.stuckLoading.join('|')}`,
          m.spill.length && `spill:${m.spill.length}`,
          m.crashed && 'CRASHED',
        ].filter(Boolean)
        summary.push({ tag, route, flags })
        console.log(tag, route.padEnd(18), flags.length ? flags.join('  ') : 'ok')
      } catch (e) {
        summary.push({ tag, route, flags: [`FAIL ${String(e.message).slice(0, 100)}`] })
        console.log(tag, route.padEnd(18), 'FAIL', String(e.message).slice(0, 100))
      }
    }
    R.errors = errors; R.blocked = blocked
    await fs.writeFile(`${OUT}/${tag}-results.json`, JSON.stringify(R, null, 2))
    if (errors.length) console.log(tag, 'errors:', errors.length, errors.slice(0, 4))
    if (blocked.length) console.log(tag, 'BLOCKED WRITES:', blocked)
    await ctx.close()
  }
}
await fs.writeFile(`${OUT}/summary.json`, JSON.stringify(summary, null, 2))
const bad = summary.filter((s) => s.flags.length)
console.log(`\n${summary.length} captures, ${bad.length} flagged`)
await browser.close()
