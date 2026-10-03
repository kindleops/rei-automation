import { chromium } from 'playwright'
/**
 * HOME 2.0 server persistence smoke — local → server upload (WRITES ONE THROWAWAY ROW).
 *
 * A throwaway operator id is stamped (as the Worker would) on /api/cockpit/home/layouts
 * only; every other non-GET to /api and Supabase is aborted. The board boots with a
 * seeded local-only layout, sees an empty server, uploads it; we then read it back as
 * that operator and delete it.
 *   node scripts/proof/desktop/home-board-server-smoke.mjs
 */
const BASE = 'http://localhost:5173'
const OP = `smoke-home2-upload-${Date.now()}`
const LID = `l_smokeup${Date.now().toString(36)}`
const layout = { id: LID, name: 'zz upload smoke (throwaway)', isDefault: true, profile: 'desktop', schemaVersion: 1, revision: 3, preset: 'minimal', primaryFamily: 'standard', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  widgets: [{ id: 'w_smokeup1', type: 'home.brief', ownerApp: 'home', size: 'wide', geometry: { standard: { x: 0, y: 0, w: 8, h: 3 } }, config: {}, configVersion: 1, context: { mode: 'global', subject: null }, refreshMs: null, locked: false, stack: null }] }
const wd = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 180_000)
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript((l) => { for (const k of ['local']) localStorage.setItem(`lc.home.board.v1:${k}`, JSON.stringify({ v: 1, activeId: l.id, layouts: [l], synced: [] })) }, layout)
const page = await ctx.newPage()
const writes = []
const responses = []
page.on('response', async (res) => { const u = new URL(res.url()); if (u.pathname === '/api/cockpit/home/layouts' && res.request().method() !== 'GET') responses.push(`${res.status()} ${(await res.text().catch(() => '')).slice(0, 160)}`) })
await page.route('**/*', (r) => {
  const q = r.request(); const u = new URL(q.url()); const m = q.method()
  if (u.pathname === '/api/cockpit/home/layouts') {
    if (m !== 'GET') { const body = q.postData() || ''; writes.push(`${m} ${(body.match(/"layout_id":"([^"]+)"/) || [])[1] ?? ''}`) }
    return r.continue({ headers: { ...q.headers(), 'x-ops-user-id': OP } })
  }
  if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(m)) return r.abort()
  return r.continue()
})
await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.hb .hb-w', { timeout: 90000 })
// the board keys local layouts by the signed-in operator; seed whichever key it booted on, then reload
const seeded = await page.evaluate((l) => {
  const keys = Object.keys(localStorage).filter((k) => k.startsWith('lc.home.board.v1:'))
  for (const k of keys) localStorage.setItem(k, JSON.stringify({ v: 1, activeId: l.id, layouts: [l], synced: [] }))
  return keys
}, layout)
// the first boot may already have uploaded a starter layout for this throwaway operator: clear it
for (const l of (await (await fetch(`${BASE}/api/cockpit/home/layouts`, { headers: { 'x-ops-user-id': OP } })).json()).layouts ?? []) await fetch(`${BASE}/api/cockpit/home/layouts?layout_id=${l.layout_id}`, { method: 'DELETE', headers: { 'x-ops-user-id': OP } })
writes.length = 0
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.hb .hb-w', { timeout: 90000 })
await page.waitForTimeout(6000)
const note = await page.evaluate(() => document.querySelector('.hb-bar__note')?.textContent ?? null)
const read = async () => (await (await fetch(`${BASE}/api/cockpit/home/layouts`, { headers: { 'x-ops-user-id': OP } })).json())
let server = await read()
for (let i = 0; i < 20 && !server.layouts?.some((l) => l.layout_id === LID); i += 1) { await page.waitForTimeout(1000); server = await read() }
const row = server.layouts?.find((l) => l.layout_id === LID)
for (const l of server.layouts ?? []) if (l.layout_id !== LID) await fetch(`${BASE}/api/cockpit/home/layouts?layout_id=${l.layout_id}`, { method: 'DELETE', headers: { 'x-ops-user-id': OP } })
const del = await (await fetch(`${BASE}/api/cockpit/home/layouts?layout_id=${LID}`, { method: 'DELETE', headers: { 'x-ops-user-id': OP } })).json()
const after = await read()
console.log(JSON.stringify({ responses, operator: OP, seededKeys: seeded, serverBefore: server.layouts?.map((l) => `${l.layout_id}@${l.revision}`), writes, localOnlyNote: note, uploaded: Boolean(row), revision: row?.revision ?? null, widgets: row?.widget_instances?.length ?? null, deleted: del.ok === true, remaining: after.layouts?.length ?? null }))
clearTimeout(wd)
await browser.close()
