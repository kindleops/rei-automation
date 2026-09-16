#!/usr/bin/env node
/**
 * WORKFLOW-STUDIO-MOBILE-LOCK-1B §20 — realtime, observed rather than asserted.
 *
 * The studio already polls the canonical live-state endpoint every 4s while the
 * live overlay is on (WorkflowLiveModeV2), so there is no second realtime system
 * to build. What needed proving is that the thing it polls now tells the truth:
 * before the §9 fix the projection reported a waiting run as sitting on the NEXT
 * node, so an operator watching the canvas watched a lie update smoothly.
 *
 * This opens the surface on the test subject, advances the run from the BACKEND
 * worker, and asserts the canvas changes with no reload.
 *
 * Requires the test fixture to be active and parked. Run:
 *   node scripts/proof/mobile/workflow-realtime-qa.mjs
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const BASE = process.env.PROOF_BASE ?? 'http://localhost:5174'
const SUBJECT = 'wfproof:thread:0f7e1a00-runtime-proof-a'
const FIXTURE_A = '0f7e1a00-0000-4000-8000-000000000001'

const readSecret = async () => {
  for (const f of ['../api/.env.local', '../api/.env']) {
    try {
      const txt = await fs.readFile(path.resolve(process.cwd(), f), 'utf8')
      const m = txt.match(/^\s*(?:VITE_)?OPS_DASHBOARD_SECRET\s*=\s*(.+)$/m)
      if (m) return m[1].trim().replace(/^['"]|['"]$/g, '')
    } catch { /* next */ }
  }
  return null
}

const findings = []
const check = (name, ok, detail) => {
  if (!ok) findings.push({ name, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`)
}

const secret = await readSecret()
if (!secret) throw new Error('OPS_DASHBOARD_SECRET not found')

/** The canonical live state, as the page polls it. */
const liveState = async () => {
  const res = await fetch(`${BASE}/api/cockpit/workflows/${FIXTURE_A}/live`, {
    headers: { 'x-ops-dashboard-secret': secret },
  })
  if (!res.ok) throw new Error(`live state -> HTTP ${res.status}`)
  const body = await res.json()
  const tokens = body.data?.tokens ?? body.tokens ?? []
  return tokens.find((t) => t.subject_id === SUBJECT) ?? null
}

console.log('WORKFLOW REALTIME PROOF (§20)')

const before = await liveState()
check('the subject has a live token before advancing', Boolean(before), 'no token — is the fixture active and parked?')
if (!before) { console.log('\nSKIPPED: fixture not parked'); process.exit(1) }
console.log(`  before: step=${before.step_key} (${before.step_status}) next=${before.next_step_key} completed=${JSON.stringify(before.completed_node_keys)}`)

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
})
const page = await context.newPage()
try {
  await page.goto(`${BASE}/workflow-studio?thread_key=${encodeURIComponent(SUBJECT)}`,
    { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForTimeout(8000)

  // Turn the live overlay on — it is the explicit operator affordance that
  // starts the poll. Nothing here reloads the page after this point.
  const toggle = page.locator('.wfs2-mobile-hero__action').filter({ hasText: /live/i })
  check('the live-mode toggle is present', (await toggle.count()) > 0, 'cannot enable the overlay')
  if (await toggle.count()) {
    await toggle.first().click()
    await page.waitForTimeout(2500)
    const chip = await page.evaluate(() =>
      [...document.querySelectorAll('.wfs2-mobile-hero__chip')].map((e) => e.innerText.trim()))
    check('the live overlay is on and labelled live', chip.some((c) => /live overlay/i.test(c)),
      JSON.stringify(chip))
  }

  const navigations = []
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()) })

  /** The overlay as the DOM actually renders it. */
  const overlayState = () => page.evaluate(() => ({
    tokens: document.querySelectorAll('.wfs2-live__token-core').length,
    banner: document.querySelector('.wfs2-live__banner')?.innerText?.replace(/\s+/g, ' ').trim() ?? null,
  }))

  // Let the 4s poll paint the parked run.
  await page.waitForTimeout(9000)
  const domBefore = await overlayState()
  console.log(`  dom before: tokens=${domBefore.tokens} banner=${JSON.stringify(domBefore.banner)}`)
  check('the parked run is drawn on the canvas', domBefore.tokens >= 1,
    `${domBefore.tokens} tokens, banner ${domBefore.banner}`)

  // Advance the run from the BACKEND. The page is not touched.
  const { execFileSync } = await import('node:child_process')
  execFileSync('node', [
    '--import', './scripts/proof/register-aliases-live.mjs',
    'scripts/proof/workflow-runtime-proof.mjs', '--phase', 'scheduler',
  ], { cwd: path.resolve(process.cwd(), '../api'), stdio: 'ignore' })

  const after = await liveState()
  console.log(`  after:  step=${after?.step_key ?? '(run finished, no token)'} completed=${JSON.stringify(after?.completed_node_keys)}`)

  // Two poll cycles, then read the DOM again. No reload in between.
  await page.waitForTimeout(11_000)
  const domAfter = await overlayState()
  console.log(`  dom after:  tokens=${domAfter.tokens} banner=${JSON.stringify(domAfter.banner)}`)

  check('the page never reloaded', navigations.length === 0, `${navigations.length} navigation(s)`)

  // The canvas followed the backend with no reload. The fixture runs to
  // completion in one tick, so the truthful end state is NO token and the
  // engine's own empty banner — a completed run must not leave a phantom.
  check('the canvas followed the backend without a reload',
    domAfter.tokens !== domBefore.tokens,
    `tokens unchanged at ${domAfter.tokens}`)
  check('a finished run leaves no phantom token', domAfter.tokens === 0,
    `${domAfter.tokens} tokens still drawn`)
  check('the overlay states there is nothing running rather than going blank',
    /no active runs/i.test(domAfter.banner ?? ''), `banner: ${domAfter.banner}`)
} finally {
  await browser.close()
}

console.log(findings.length === 0 ? '\nREALTIME PROOF: all checks passed' : `\nREALTIME PROOF: ${findings.length} finding(s)`)
process.exit(findings.length === 0 ? 0 : 1)
