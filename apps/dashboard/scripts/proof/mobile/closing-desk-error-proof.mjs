/**
 * CLOSING-DESK-MOBILE-LOCK-1 §8 — failure must not become demo data.
 *
 * READ ONLY, and it never touches the server: the closing-desk requests are
 * failed in the BROWSER via route interception, so production state is
 * untouched. Nothing is mutated and no closing is written.
 *
 * The defect this pins: the adapter used to answer a failed read with
 * degradedFixture(), rendering synthetic closings with invented addresses,
 * prices and blockers — indistinguishable to an operator from real deals.
 */
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'https://ops.leadcommand.ai'
const findings = []
const check = (cell, n, ok, d) => { if (!ok) findings.push({ cell, n, d }) }

const browser = await chromium.launch()

for (const mode of ['transport_failure', 'http_500']) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })

  // Fail ONLY the closing-desk reads. Everything else loads normally, so the
  // shell renders and we observe the desk's own failure behaviour.
  await context.route('**/api/cockpit/closing-desk/**', async (route) => {
    if (mode === 'transport_failure') return route.abort('failed')
    /**
     * An HTTP 500 that still parses as JSON is the harder case: callBackend
     * reports ok:true for ANY parsed response, so a transport-level check
     * alone would treat this as a successful read.
     */
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'closing_cases_fetch_failed', data: null }),
    })
  })

  const page = await context.newPage()
  await page.goto(`${BASE}/closing-desk`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('.cd-command-header', { timeout: 60_000 })
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="cd-loading"]'),
    undefined, { timeout: 45_000 },
  ).catch(() => {})
  await page.waitForTimeout(1500)

  const p = await page.evaluate(() => {
    const body = (document.body.innerText || '').replace(/\s+/g, ' ')
    return {
      cards: document.querySelectorAll('[data-testid="cd-card"]').length,
      rows: document.querySelectorAll('[data-testid="cd-table-row"]').length,
      errorState: !!document.querySelector('[data-testid="cd-error"]'),
      demoBanner: !!document.querySelector('[data-testid="cd-env-demo"]'),
      pill: document.querySelector('.cd-status-pill')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      pulseRevenue: [...document.querySelectorAll('.cd-pulse-metric')]
        .map((el) => ({
          l: el.querySelector('.cd-pulse-metric__label')?.textContent?.trim(),
          v: el.querySelector('.cd-pulse-metric__value')?.textContent?.trim(),
        }))
        .find((m) => /revenue/i.test(m.l ?? ''))?.v ?? null,
      kpis: [...document.querySelectorAll('[data-testid^="cd-metric-"]')].map((el) => ({
        key: el.getAttribute('data-testid').replace('cd-metric-', ''),
        value: el.querySelector('[class*="value"]')?.textContent?.trim() ?? null,
      })),
      /** Fixture markers from closing-fixtures.ts. */
      fixtureLeak: ['TC — Demo', 'Demo Title', 'DEMO DATA'].filter((n) => body.includes(n)),
      /** Any dollar figure at all would be fabricated — there is no data. */
      moneyOnScreen: (body.match(/\$[\d,]+/g) ?? []).filter((m) => m !== '$0').slice(0, 5),
      statesFailure: /unavailable|could not|failed|unreachable|error/i.test(body),
      body: body.slice(0, 400),
    }
  })

  check(mode, '§8 a failed read renders ZERO closing cases', p.cards === 0 && p.rows === 0,
    `cards=${p.cards} rows=${p.rows}`)
  check(mode, '§8 no fixture/demo data after failure', p.fixtureLeak.length === 0, p.fixtureLeak.join(','))
  check(mode, '§8 no demo banner after failure', !p.demoBanner, 'demo banner shown')
  check(mode, '§8 no fabricated money after failure', p.moneyOnScreen.length === 0, p.moneyOnScreen.join(','))
  check(mode, '§8 the failure is STATED, not shown as a healthy empty desk', p.statesFailure, `pill=${p.pill}`)
  check(mode, '§8 unavailable revenue is not rendered as $0', p.pulseRevenue !== '$0', `ui=${p.pulseRevenue}`)

  console.log(`\n${mode}`)
  console.log(`  pill=${JSON.stringify(p.pill)} cards=${p.cards} rows=${p.rows} errorState=${p.errorState} demo=${p.demoBanner}`)
  console.log(`  revenue=${JSON.stringify(p.pulseRevenue)}  kpis=${p.kpis.map((k) => `${k.key}=${k.value}`).join(' ')}`)
  console.log(`  statesFailure=${p.statesFailure}  fixtureLeak=${JSON.stringify(p.fixtureLeak)}  money=${JSON.stringify(p.moneyOnScreen)}`)
  console.log(`  body: ${p.body.slice(0, 220)}`)

  await context.close()
}

await browser.close()

console.log('\n' + '─'.repeat(72))
if (findings.length === 0) {
  console.log('PASS — failure never becomes demo data')
} else {
  console.log(`FAIL — ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  [${f.cell}] ${f.n}\n      ${f.d}`)
}
process.exit(findings.length === 0 ? 0 : 1)
