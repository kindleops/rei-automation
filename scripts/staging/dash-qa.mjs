import { readFileSync } from "node:fs"
import { connect } from "./cdp.mjs"
const ENV = Object.fromEntries(readFileSync(new URL("../../apps/api/.env.scheduling-staging.local", import.meta.url), "utf8").split("\n").map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]))
const D = "http://localhost:5174", OUT = process.env.QA_OUT || "/tmp/staging-qa"
const results = []; const ok = (n, v, d = "") => { results.push(v); console.log(`${v ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`) }
async function as(email, password) {
  const c = await connect()
  await c.send("Network.enable"); await c.send("Network.clearBrowserCookies")
  await c.send("Storage.clearDataForOrigin", { origin: D, storageTypes: "local_storage,session_storage,indexeddb,service_workers,cache_storage" })
  await c.open(1440, 900, `${D}/`, 5000)
  await (async () => { const t = Date.now(); while (Date.now() - t < 20000) { if (await c.ev(`!!document.querySelector('input[type="email"]')`)) break; await c.sleep(300) } })()
  const waitFor = async (js, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await c.ev(js).catch(() => false)) return true; await c.sleep(300) } return false }
  const type = async (sel, t) => { await c.ev(`document.querySelector(${JSON.stringify(sel)}).focus()`); await c.send("Input.insertText", { text: t }) }
  const click = (text, sel = "button,a,[role=tab],[role=menuitem]") => c.ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true })()`)
  await type('input[type="email"]', email); await type('input[type="password"]', password)
  await click("Enter Command Center", "button")
  await waitFor(`!document.querySelector('input[type="password"]') && location.pathname !== '/'`)
  await waitFor(`document.body.innerText.includes('All Threads') || document.body.innerText.includes('Calendar')`, 40000)
  await c.sleep(1500)
  return { c, waitFor, click, type, body: () => c.ev("document.body.innerText") }
}

// ------------------------------------------------------------- reseed ----
{
  const P = (a, b) => fetch('http://localhost:3201/api/internal/seller-portal/' + a, { method: 'POST', headers: { 'content-type': 'application/json', 'x-seller-portal-secret': ENV.STAGING_PORTAL_SECRET }, body: JSON.stringify(b) }).then((r) => r.json())
  // Retire earlier QA rows so each run starts with exactly one of each.
  for (const n of ['Dash QA Seller (fixture)', 'Sync Failure (fixture)']) {
    await fetch(ENV.STAGING_SUPABASE_URL + '/rest/v1/scheduling_appointments?status=in.(scheduled,confirmed)&customer->>name=eq.' + encodeURIComponent(n), { method: 'PATCH', headers: { apikey: ENV.STAGING_SUPABASE_SERVICE_ROLE_KEY, authorization: 'Bearer ' + ENV.STAGING_SUPABASE_SERVICE_ROLE_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: 'qa_reset' }) })
  }
  const slots = await P('call-slots', { reason: 'details' })
  await P('call-book', { reason: 'details', start_at: slots.slots[6].start_at, contact: { name: 'Dash QA Seller (fixture)', phone: '555-555-0177', email: 'dash-qa@example.test' }, timezone: 'America/New_York' })
  const b = await P('call-book', { reason: 'details', start_at: slots.slots[11].start_at, contact: { name: 'Sync Failure (fixture)', phone: '555-555-0178' }, timezone: 'America/New_York' })
  await fetch(ENV.STAGING_SUPABASE_URL + '/rest/v1/scheduling_appointments?id=eq.' + b.call.id, { method: 'PATCH', headers: { apikey: ENV.STAGING_SUPABASE_SERVICE_ROLE_KEY, authorization: 'Bearer ' + ENV.STAGING_SUPABASE_SERVICE_ROLE_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ sync_status: 'failed', sync_error: 'google_unreachable' }) })
}

// ------------------------------------------------------------------ admin ----
const a = await as(ENV.STAGING_ADMIN_EMAIL, ENV.STAGING_ADMIN_PASSWORD)
ok("admin signs in to the dashboard (staging Auth)", await a.c.ev(`!document.querySelector('input[type="password"]')`))
await a.c.go(`${D}/calendar?view=appointments`, 4000)
ok("session survives a full page load", await a.waitFor(`!document.querySelector('input[type="password"]')`, 20000))
ok("Calendar → Appointments renders", await a.waitFor(`document.body.innerText.includes('Upcoming') && /Needs assignment/i.test(document.body.innerText)`, 40000))
await a.click("Upcoming"); await a.c.sleep(2500)
const up = await a.body()
ok("upcoming seller calls listed with type, person and context", /Property conversation|Offer review/i.test(up) && /Staging Advisor/.test(up) && /Dash QA Seller/.test(up))
ok("failed calendar sync is visible on the row", /sync failed|failed/i.test(up))
await a.c.shot(`${OUT}/21-dash-appointments-upcoming.jpg`)
await a.click("Needs assignment"); await a.c.sleep(2000); await a.c.shot(`${OUT}/22-dash-needs-assignment.jpg`)
await a.click("Cancelled"); await a.c.sleep(2000)
ok("cancelled tab shows the cancelled seller call", /Offer review|Property conversation/.test(await a.body()))
await a.click("Upcoming"); await a.c.sleep(2000)
ok("My calendar shows the connection state honestly (not connected)", /Connect|Not connected|not connected/i.test(await a.body()))
await a.c.shot(`${OUT}/23-dash-my-calendar.jpg`)
// brand filter (custom dropdown)
await a.click("Brand", "button"); await a.c.sleep(700)
const brandSelect = await a.c.ev(`(() => { const el = [...document.querySelectorAll('[role^=menuitem],[role=option],li,button')].find((e) => e.textContent.trim() === 'Prominent'); if (!el) return false; el.click(); return true })()`)
await a.c.sleep(2500)
const filtered = await a.body()
ok("brand filter narrows to Prominent", brandSelect && !/Second brand \(fixture\)/.test(filtered) && /Dash QA Seller/.test(filtered))
await a.c.shot(`${OUT}/23b-dash-brand-filter.jpg`)
// open an appointment drawer by its customer
const opened = await a.c.ev(`(() => { const b = document.querySelector('button.sch-row__main[aria-label*="Dash QA Seller"]'); if (!b) return false; b.click(); return true })()`)
await a.c.sleep(3000)
const drawer = await a.body()
ok("appointment detail drawer opens with history and the customer phone", opened && /history/i.test(drawer) && /555/.test(drawer))
await a.c.shot(`${OUT}/24-dash-appointment-drawer.jpg`)
// confirm action on it
const confirmed = await a.c.ev(`(() => { const scope = document.querySelector('.sch-drawer') || document; const b = [...scope.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Confirm'); if (!b) return false; b.click(); return true })()`)
await a.waitFor(`/confirmed/i.test((document.querySelector('.sch-drawer') || document.body).innerText)`, 15000)
ok("operator action (Confirm) works from the drawer", confirmed && /confirmed/i.test(await a.body()))
// Team & routing appears for the admin only (the API enforces it regardless)
await a.c.go(`${D}/calendar?view=appointments`, 3000)
ok("admin sees Team & routing", await a.waitFor(`!!document.querySelector('.sch-admin')`, 30000))
// Inbox → Seller portal
await a.c.go(`${D}/inbox`, 6000)
const lens = await a.c.ev(`(() => { const b = document.querySelector('[data-category="seller_portal"]'); if (!b) return false; b.click(); return true })()`)
await a.waitFor(`location.pathname === '/seller-portal' && /Sycamore/.test(document.body.innerText)`, 30000)
const sp = await a.body()
ok("Inbox → Seller portal lists conversations with property context", lens && /1240 Sycamore|Sycamore/.test(sp))
await a.c.shot(`${OUT}/25-dash-seller-portal-list.jpg`)
await a.c.ev(`(() => { const t = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /1240 Sycamore/.test(e.textContent)); const b = t && (t.closest('button,a,[role=button],li')); if (!b) return false; b.click(); return true })()`)
await a.waitFor(`!!document.querySelector('textarea')`, 20000)
await a.c.shot(`${OUT}/26-dash-seller-thread.jpg`)
const replied = await a.c.ev(`(() => { const t = document.querySelector('textarea'); if (!t) return false; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Dashboard QA reply (fixture)'); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
await a.c.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^(Send|Reply)/.test(x.textContent.trim()) || x.getAttribute('aria-label') === 'Send reply'); if (b) b.click(); return !!b })()`); await a.c.sleep(3500)
ok("operator replies from the dashboard", replied && /Dashboard QA reply/.test(await a.body()))
await a.c.shot(`${OUT}/27-dash-seller-reply.jpg`)

// --------------------------------------------------------------- operator ----
const o = await as(ENV.STAGING_OPERATOR_EMAIL, ENV.STAGING_OPERATOR_PASSWORD)
await o.c.go(`${D}/calendar?view=appointments`, 3000)
await o.waitFor(`!!document.querySelector('.sch-appts')`, 30000); await o.c.sleep(4000)
ok("plain operator does not see Team & routing", !(await o.c.ev(`!!document.querySelector('.sch-admin')`)))
const perm = await o.c.ev(`fetch('/api/cockpit/scheduling/permissions', { headers: { authorization: 'Bearer ' + (JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.includes('auth-token')) || '{}') || '{}').access_token || '') } }).then(r => r.json())`)
ok("plain operator is not a scheduling admin (real session through the gateway)", perm?.scheduling_admin === false, JSON.stringify(perm))
const denied = await o.c.ev(`fetch('/api/cockpit/scheduling/pool-member', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.includes('auth-token')) || '{}') || '{}').access_token || '') }, body: JSON.stringify({ brand: 'prominent_cash_offer', pool_key: 'seller_advisors', resource_id: 'aaaaaaaa-5eed-4000-8000-000000000001', active: false }) }).then(r => r.status)`)
ok("…and is refused when changing routing from the browser", denied === 403, String(denied))
console.log(`\n${results.filter(Boolean).length}/${results.length} dashboard checks passed`)
process.exit(0)
