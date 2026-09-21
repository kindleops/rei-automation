/**
 * PRODUCTION ACCESS-CONTROL PROOF.
 *
 * Establishes, against the LIVE origin:
 *   1. unauthenticated browser  -> sign-in surface, never the operator console
 *   2. unauthenticated API      -> denied
 *   3. the DISCLOSED credential -> denied (rotation + worker strip)
 *   4. authenticated operator   -> app loads, /api works, survives refresh
 *   5. authenticated NON-operator -> denied (authorization, not just authn)
 *   6. logout                   -> access removed
 *
 * The operator session is minted with a one-time magic link via the admin API.
 * No password is read, set, or changed. The non-operator is a temporary account
 * created and DELETED inside this script, purely to prove the allowlist bites.
 *
 * READ ONLY against product data. Prints no secret values.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const BASE = 'https://ops.leadcommand.ai'
/* The service role key lives with the API, not the dashboard. Read both. */
const readEnv = async (rel) => fs.readFile(new URL(rel, import.meta.url), 'utf8').catch(() => '')
const env = (await readEnv('../../../.env.local')) + '\n' + (await readEnv('../../../../api/.env.local'))
const pick = (k) => (new RegExp(`^${k}=(.+)$`, 'm').exec(env)?.[1] ?? '').trim()
const SUPABASE_URL = pick('VITE_SUPABASE_URL')
const ANON = pick('VITE_SUPABASE_ANON_KEY')
const SERVICE = pick('SUPABASE_SERVICE_ROLE_KEY') || pick('VITE_SUPABASE_SERVICE_ROLE_KEY')
const OLD_SECRET = pick('VITE_OPS_DASHBOARD_SECRET')
const OPERATOR_EMAIL = process.argv.find((a) => a.startsWith('--operator='))?.split('=')[1]

const results = []
const record = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`)
}

const admin = (p, init = {}) => fetch(`${SUPABASE_URL}${p}`, {
  ...init,
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
})

/** Mints a session for an existing account without touching its password. */
async function sessionFor(email) {
  const gen = await admin('/auth/v1/admin/generate_link', {
    method: 'POST', body: JSON.stringify({ type: 'magiclink', email }),
  })
  if (!gen.ok) throw new Error(`generate_link ${gen.status}`)
  const { hashed_token } = await gen.json()
  const ver = await fetch(`${SUPABASE_URL}/auth/v1/verify?token=${hashed_token}&type=magiclink`, {
    headers: { apikey: ANON }, redirect: 'manual',
  })
  const loc = ver.headers.get('location') || ''
  const frag = loc.includes('#') ? new URLSearchParams(loc.split('#')[1]) : null
  const token = frag?.get('access_token')
  if (!token) throw new Error(`no access_token (status ${ver.status})`)
  // The refresh token matters: the app persists and auto-refreshes, so a
  // half-seeded session would test something the operator never experiences.
  return { access_token: token, refresh_token: frag?.get('refresh_token') ?? '' }
}

const apiStatus = (pathname, headers = {}) =>
  fetch(`${BASE}/api/${pathname}`, { headers }).then((r) => r.status)

console.log('\n== 2/3. API DENIAL ==')
record('unauthenticated API is denied',
  (await apiStatus('cockpit/metrics/war-room')) === 401, 'no credentials')
record('unauthenticated API is denied (second route)',
  (await apiStatus('cockpit/inbox/counts')) === 401, '')
const oldStatus = await apiStatus('cockpit/metrics/war-room', { 'x-ops-dashboard-secret': OLD_SECRET })
record('the DISCLOSED credential no longer authorizes', oldStatus === 401, `http=${oldStatus}`)
const oldStatus2 = await apiStatus('internal/dashboard/ops/map', { 'x-ops-dashboard-secret': OLD_SECRET })
record('disclosed credential dead on the internal dashboard lane too', oldStatus2 === 401, `http=${oldStatus2}`)

console.log('\n== 5. AUTHORIZATION (authenticated but NOT an operator) ==')
const tempEmail = `zz-authproof-${Date.now()}@example.com`
let tempId = null
try {
  const created = await admin('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email: tempEmail, password: crypto.randomUUID() + 'Aa1!', email_confirm: true }),
  })
  tempId = (await created.json())?.id ?? null
  const tempToken = await sessionFor(tempEmail)
  const st = await apiStatus('cockpit/metrics/war-room', { Authorization: `Bearer ${tempToken}` })
  record('a valid session that is NOT on the allowlist is refused', st === 403, `http=${st} (expect 403)`)
} catch (e) {
  record('non-operator check ran', false, String(e.message).slice(0, 90))
} finally {
  if (tempId) {
    await admin(`/auth/v1/admin/users/${tempId}`, { method: 'DELETE' })
    const gone = await admin(`/auth/v1/admin/users/${tempId}`)
    record('temporary test account deleted', gone.status === 404, `lookup=${gone.status}`)
  }
}

console.log('\n== 4. AUTHENTICATED OPERATOR ==')
let opToken = null
if (OPERATOR_EMAIL) {
  try {
    opToken = await sessionFor(OPERATOR_EMAIL)
    const st = await apiStatus('cockpit/metrics/war-room', { Authorization: `Bearer ${opToken.access_token}` })
    record('an allowlisted operator session reaches the API', st === 200, `http=${st}`)
    const st2 = await apiStatus('cockpit/pipeline/opportunities?limit=1', { Authorization: `Bearer ${opToken.access_token}` })
    record('operator session works across routes', st2 === 200, `http=${st2}`)
  } catch (e) {
    record('operator session minted', false, String(e.message).slice(0, 90))
  }
}

console.log('\n== 1/4/6. BROWSER ==')
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
const OUT = path.resolve('artifacts/production-auth')
await fs.mkdir(OUT, { recursive: true })

await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
await page.waitForTimeout(6000)
const anon = await page.evaluate(() => ({
  text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
  hasPassword: !!document.querySelector('input[type="password"]'),
  dock: !!document.querySelector('.nx-pinned-app-dock'),
}))
await page.screenshot({ path: path.join(OUT, 'unauthenticated.png') })
record('unauthenticated browser does NOT render the operator console',
  !anon.dock, anon.dock ? 'app dock present' : 'no operator chrome')
record('unauthenticated browser gets a sign-in surface',
  anon.hasPassword || /sign in|log in|password|email/i.test(anon.text), anon.text.slice(0, 80))

if (opToken) {
  // Seed the session exactly as supabase-js persists it, full shape.
  const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
  await ctx.addInitScript(([ref, sess]) => {
    localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(sess))
  }, [projectRef, {
    access_token: opToken.access_token,
    refresh_token: opToken.refresh_token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: null,
  }])

  const p2 = await ctx.newPage()
  await p2.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await p2.waitForTimeout(9000)
  const authed = await p2.evaluate(() => ({
    dock: !!document.querySelector('.nx-pinned-app-dock'),
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
  }))
  await p2.screenshot({ path: path.join(OUT, 'authenticated.png') })
  record('authenticated operator loads the console', authed.dock, authed.text.slice(0, 80))

  await p2.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 })
  await p2.waitForTimeout(8000)
  const afterReload = await p2.evaluate(() => !!document.querySelector('.nx-pinned-app-dock'))
  record('session survives a refresh', afterReload, '')

  await p2.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
  await p2.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await p2.waitForTimeout(7000)
  const afterLogout = await p2.evaluate(() => !!document.querySelector('.nx-pinned-app-dock'))
  await p2.screenshot({ path: path.join(OUT, 'after-logout.png') })
  record('clearing the session removes console access', !afterLogout, '')
}

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log('\n' + '-'.repeat(70))
console.log(failed.length === 0
  ? `PASS -- ${results.length} checks, 0 failures`
  : `FAIL -- ${failed.length}/${results.length} failed`)
process.exitCode = failed.length ? 1 : 0
