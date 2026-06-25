import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE_URL = process.env.NEXUS_URL || 'http://127.0.0.1:5173'
const outDir = path.resolve('proof/inbox')
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await context.newPage()
const countsAt = []
const networkTimings = []
let bootStart = Date.now()

page.on('response', async (res) => {
  const url = res.url()
  if (url.includes('/api/cockpit/inbox/counts')) {
    try {
      const body = await res.json()
      countsAt.push({
        ms: Date.now() - bootStart,
        status: res.status(),
        counts: body?.counts ?? body?.data?.counts ?? null,
      })
    } catch {
      countsAt.push({ ms: Date.now() - bootStart, status: res.status(), counts: null })
    }
  }
  if (
    url.includes('/api/cockpit/inbox/thread-messages')
    || url.includes('/api/cockpit/inbox/thread-dossier')
    || url.includes('/api/cockpit/deal-context')
    || url.includes('/api/cockpit/inbox/thread-state')
  ) {
    networkTimings.push({
      endpoint: url.split('?')[0].split('/').slice(-2).join('/'),
      status: res.status(),
      atMs: Date.now() - bootStart,
      durationMs: null,
    })
  }
})

bootStart = Date.now()
await page.goto(`${BASE_URL}/inbox`, { waitUntil: 'domcontentloaded', timeout: 60_000 })

await page.waitForFunction(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')].map((n) => n.textContent || '')
  const joined = tabs.join(' ')
  return /\d/.test(joined) && !/ALL THREADS\s*0/i.test(joined)
}, null, { timeout: 45_000 })

const sidebarCounts = await page.evaluate(() =>
  [...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent?.trim()).filter(Boolean),
)

const rowLocator = page.locator('[data-thread-id], .nx-thread-card-rebuilt, .nx-thread-row')
await page.waitForFunction(() => document.querySelectorAll('[data-thread-id], .nx-thread-card-rebuilt').length >= 10, null, { timeout: 45_000 })
const rowCount = await rowLocator.count()
const threadLatencies = []

for (let i = 0; i < Math.min(10, rowCount); i += 1) {
  const t0 = Date.now()
  await rowLocator.nth(i).click({ timeout: 5000 })
  await page.waitForSelector('.nx-chat-container, .nx-thread-pane, .nx-composer, h2', { timeout: 5000 }).catch(() => null)
  const shellMs = Date.now() - t0
  await page.waitForTimeout(200)
  const messagesVisible = await page.locator('.nx-message, .nx-chat-message, [class*="message"]').count() > 0
  threadLatencies.push({
    thread: i + 1,
    selectionMs: Date.now() - t0,
    shellMs,
    messagesVisible,
    label: await rowLocator.nth(i).innerText().then((t) => t.replace(/\s+/g, ' ').trim().slice(0, 80)).catch(() => ''),
  })
}

const threadState400 = networkTimings.filter((entry) => entry.endpoint === 'inbox/thread-state' && entry.status === 400)
const result = {
  bootMs: Date.now() - bootStart,
  sidebarCounts,
  countsResponses: countsAt,
  threadLatencies,
  networkTimings,
  threadState400Count: threadState400.length,
  status: rowCount >= 10 && threadState400.length === 0 ? 'PASS' : 'FAIL',
}

fs.writeFileSync(path.join(outDir, 'final-browser-proof.json'), JSON.stringify(result, null, 2))
await page.screenshot({ path: path.join(outDir, 'final-08-browser-proof.png'), fullPage: false })
await context.close()
await browser.close()

console.log(JSON.stringify(result, null, 2))
process.exit(result.status === 'PASS' ? 0 : 1)