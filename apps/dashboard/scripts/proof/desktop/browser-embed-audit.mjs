import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * LeadCommand Browser 1.0 — EMBEDDING AUDIT + deep-link verifier (READ ONLY).
 *
 *   --in=<json>   [{ id, url, tokens?: string[], mode: 'frame' | 'top' }]
 *   --out=<dir>   evidence dir (results.json + screenshots)
 *
 * mode 'top'   : top-level navigation; records status/final URL/title and whether any
 *                verification token (e.g. the parcel id) appears in the rendered text.
 * mode 'frame' : serves a localhost test page that iframes the URL under several sandbox
 *                configurations and classifies: EMBEDS / BLOCKED / AUTH / UNKNOWN.
 *
 * Every non-GET request is aborted (no writes to provider systems). No logins.
 */
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d
const IN = arg('in')
const OUT = arg('out')
const ONLY = arg('only', '')
await fs.mkdir(OUT, { recursive: true })
let items = JSON.parse(await fs.readFile(IN, 'utf8'))
if (ONLY) items = items.filter((i) => ONLY.split(',').includes(i.id))

const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 1_500_000)

const SANDBOXES = [
  { key: 'none', attr: '' },
  { key: 'scripts', attr: 'allow-scripts' },
  { key: 'scripts+same-origin', attr: 'allow-scripts allow-same-origin' },
  { key: 'full', attr: 'allow-scripts allow-same-origin allow-forms allow-popups' },
]

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const target = u.searchParams.get('u') || 'about:blank'
  const sb = u.searchParams.get('sb')
  const sandbox = sb === null ? '' : ` sandbox="${esc(sb)}"`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><title>embed-test</title><body style="margin:0"><iframe id="f" src="${esc(target)}"${sandbox} style="border:0;width:1280px;height:860px" referrerpolicy="no-referrer"></iframe></body>`)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
const browser = await chromium.launch()
const CHALLENGE = /just a moment|attention required|access denied|verify you are human|captcha|are you a robot|pardon our interruption|request unsuccessful/i
const AUTHWORDS = /\b(sign in|log in|login)\b/i

async function guard(ctx) {
  await ctx.route('**/*', (r) => (['GET', 'HEAD', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort()))
}

async function top(it) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } })
  await guard(ctx)
  const page = await ctx.newPage()
  let status = null
  let finalUrl = null
  let err = null
  try {
    const resp = await page.goto(it.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    status = resp?.status() ?? null
    await page.waitForTimeout(it.wait ?? 7000)
  } catch (e) { err = String(e.message).split('\n')[0] }
  finalUrl = page.url()
  const title = await page.title().catch(() => null)
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
  const lower = text.toLowerCase()
  const tokens = (it.tokens || []).map((t) => [t, lower.includes(String(t).toLowerCase())])
  const challenge = CHALLENGE.test(title || '') || CHALLENGE.test(text.slice(0, 600))
  await page.screenshot({ path: path.join(OUT, `top-${it.id}.png`) }).catch(() => {})
  await ctx.close()
  return { id: it.id, mode: 'top', url: it.url, status, finalUrl, title, textLen: text.length, tokens, challenge, err }
}

async function frameOnce(it, sb) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1300, height: 900 } })
  await guard(ctx)
  const page = await ctx.newPage()
  const consoleMsgs = []
  page.on('console', (m) => { const t = m.text(); if (/frame|refused|ancestor|X-Frame/i.test(t)) consoleMsgs.push(t.slice(0, 300)) })
  let frameStatus = null
  page.on('response', (r) => { if (r.frame() !== page.mainFrame() && r.request().isNavigationRequest() && frameStatus === null) frameStatus = r.status() })
  const q = new URLSearchParams({ u: it.url })
  if (sb.attr !== null) q.set('sb', sb.attr)
  let err = null
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(it.wait ?? 8000)
  } catch (e) { err = String(e.message).split('\n')[0] }
  const child = page.frames().find((f) => f !== page.mainFrame())
  const childUrl = child?.url() ?? null
  let title = null
  let text = ''
  let hasPassword = false
  let hasForm = false
  if (child && !/^chrome-error:/.test(childUrl || '')) {
    title = await child.title().catch(() => null)
    text = await child.evaluate(() => document.body?.innerText || '').catch(() => '')
    hasPassword = await child.evaluate(() => !!document.querySelector('input[type=password]')).catch(() => false)
    hasForm = await child.evaluate(() => !!document.querySelector('form, input[type=search], input[type=text]')).catch(() => false)
  }
  const blockedByConsole = consoleMsgs.some((m) => /X-Frame-Options|frame-ancestors|Refused to (display|frame)/i.test(m))
  const errored = /^chrome-error:/.test(childUrl || '')
  const challenge = CHALLENGE.test(title || '') || CHALLENGE.test(text.slice(0, 600))
  const auth = hasPassword || (AUTHWORDS.test(title || '') && text.length < 3000)
  let verdict
  if (blockedByConsole || (errored && frameStatus && frameStatus < 400)) verdict = 'BLOCKED'
  else if (errored) verdict = 'UNKNOWN' // network-level failure
  else if (challenge) verdict = 'AUTH'
  else if (auth) verdict = 'AUTH'
  else if (text.trim().length >= 40) verdict = 'EMBEDS'
  else verdict = 'UNKNOWN'
  if (sb.key === 'full') await page.screenshot({ path: path.join(OUT, `frame-${it.id}.png`) }).catch(() => {})
  await ctx.close()
  return { sandbox: sb.key, verdict, frameStatus, childUrl, title, textLen: text.length, hasForm, hasPassword, console: consoleMsgs.slice(0, 3), err }
}

async function frame(it) {
  const runs = []
  // Full-permission run first; only probe narrower sandboxes if it embeds.
  const full = await frameOnce(it, SANDBOXES[3])
  runs.push(full)
  if (full.verdict === 'EMBEDS') {
    for (const sb of SANDBOXES.slice(0, 3)) runs.push(await frameOnce(it, sb))
  }
  const ok = runs.filter((r) => r.verdict === 'EMBEDS' && r.textLen >= Math.min(200, full.textLen * 0.5))
  const order = ['none', 'scripts', 'scripts+same-origin', 'full']
  const minimal = ok.sort((a, b) => order.indexOf(a.sandbox) - order.indexOf(b.sandbox))[0]?.sandbox ?? null
  return { id: it.id, mode: 'frame', url: it.url, verdict: full.verdict, minimal_sandbox: minimal, hasForm: full.hasForm, runs }
}

const results = []
for (const it of items) {
  const r = it.mode === 'top' ? await top(it) : await frame(it)
  results.push(r)
  console.log(JSON.stringify({ id: r.id, mode: r.mode, verdict: r.verdict, minimal: r.minimal_sandbox, status: r.status ?? r.runs?.[0]?.frameStatus, title: r.title ?? r.runs?.[0]?.title, tokens: r.tokens, challenge: r.challenge, final: r.finalUrl ?? r.runs?.[0]?.childUrl, console: r.runs?.[0]?.console?.[0] }))
}
const prev = await fs.readFile(path.join(OUT, 'results.json'), 'utf8').then(JSON.parse).catch(() => [])
const merged = [...prev.filter((p) => !results.some((r) => r.id === p.id && r.mode === p.mode)), ...results]
await fs.writeFile(path.join(OUT, 'results.json'), JSON.stringify(merged, null, 1))
await browser.close()
server.close()
clearTimeout(watchdog)
