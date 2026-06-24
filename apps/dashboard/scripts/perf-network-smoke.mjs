import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const OUT_DIR = path.resolve('scripts/perf-proof')
fs.mkdirSync(OUT_DIR, { recursive: true })

const dashboardUrl = process.env.DASHBOARD_URL || 'http://127.0.0.1:5173/'
const routes = [
  { name: 'inbox-cold', path: '/inbox' },
  { name: 'queue-warm', path: '/queue' },
  { name: 'templates-warm', path: '/templates' },
]

const violations = []
const summary = []

function classify(url) {
  if (url.includes('send_queue') && url.includes('limit=4000')) return 'send_queue_4000'
  if (url.includes('/rest/v1/send_queue') && url.includes('select=%2A')) return 'send_queue_select_star'
  if (url.includes('/rest/v1/sms_templates')) return 'sms_templates_direct'
  if (url.includes('/api/cockpit/ops/metrics')) return 'ops_metrics'
  if (url.includes('/api/cockpit/inbox/live')) return 'inbox_live'
  if (url.includes('runtime-identity')) return 'runtime_identity'
  return null
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()

const seen = new Map()

for (const route of routes) {
  seen.clear()
  const started = Date.now()
  const routePage = await context.newPage()
  routePage.on('requestfinished', async (req) => {
    const url = req.url()
    const key = classify(url)
    if (!key) return
    const prior = seen.get(key) || 0
    seen.set(key, prior + 1)
    if (prior >= 1 && ['ops_metrics', 'sms_templates_direct'].includes(key)) {
      violations.push(`duplicate ${key}: ${url}`)
    }
    if (key === 'send_queue_4000' || key === 'send_queue_select_star') {
      violations.push(`forbidden ${key}: ${url}`)
    }
    try {
      const timing = req.timing()
      const size = (await req.response())?.headers()['content-length'] || '?'
      summary.push({ route: route.name, key, ms: timing.responseEnd, size, url })
    } catch {
      summary.push({ route: route.name, key, url })
    }
  })

  await routePage.goto(`${dashboardUrl.replace(/\/$/, '')}${route.path}`, { waitUntil: 'networkidle', timeout: 120_000 })
  await routePage.waitForTimeout(1500)
  const shot = path.join(OUT_DIR, `${route.name}-network.png`)
  await routePage.screenshot({ path: shot, fullPage: false })
  console.log(`screenshot ${shot} elapsed ${Date.now() - started}ms keys`, [...seen.entries()])
  await routePage.close()
}

await page.close()
await browser.close()

const reportPath = path.join(OUT_DIR, 'network-summary.json')
fs.writeFileSync(reportPath, JSON.stringify({ violations, summary }, null, 2))
console.log('report', reportPath)
if (violations.length) {
  console.error('VIOLATIONS', violations)
  process.exit(1)
}