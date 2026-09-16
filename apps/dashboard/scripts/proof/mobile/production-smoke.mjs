#!/usr/bin/env node
/**
 * PRODUCTION CHECKPOINT 1 — production smoke.
 *
 * Narrow by design (§11): this is not another certification matrix. It asks
 * whether the deployed checkpoint is HEALTHY on production, at a mobile
 * viewport first.
 *
 * Auth: the dashboard is gated by Supabase Auth client-side. This harness never
 * types a credential. If it lands on a sign-in wall it says so explicitly and
 * marks the content checks BLOCKED rather than passing them vacuously — a smoke
 * test that silently skips is worse than no smoke test.
 *
 * Usage:
 *   node scripts/proof/mobile/production-smoke.mjs
 *   node scripts/proof/mobile/production-smoke.mjs --base https://ops.leadcommand.ai
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'https://ops.leadcommand.ai')
const EXPECT_SHA = arg('sha', null)
const OUT = path.resolve(process.cwd(), '.screenshots/production-smoke')

const findings = []
const blocked = []
const check = (name, ok, detail) => {
  if (!ok) findings.push({ name, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`)
  return ok
}
const note = (name, detail) => {
  blocked.push({ name, detail })
  console.log(`  BLOCKED  ${name}  <- ${detail}`)
}

/** Routes this checkpoint shipped. Shell-level reachability only. */
const ROUTES = [
  ['/inbox', 'Inbox'],
  ['/pipeline', 'Pipeline'],
  ['/entity-graph', 'Entity Graph'],
  ['/campaign-command', 'Campaign Command'],
  ['/workflow-studio', 'Workflow Studio'],
  ['/workflows-v2', 'legacy alias -> Workflow Studio'],
]

await fs.mkdir(OUT, { recursive: true })

console.log(`PRODUCTION SMOKE  ${BASE}`)

// ── deployed SHA, server side
const versionRes = await fetch(`${BASE}/api/version`)
const version = await versionRes.json()
console.log(`  provider=${version.provider} env=${version.env} sha=${version.git_sha?.slice(0, 8)} deployment=${version.deployment_id}`)
check('production reports a version', versionRes.ok && Boolean(version.git_sha), `http ${versionRes.status}`)
check('production env is production', version.env === 'production', `env=${version.env}`)
check('provider is cloudflare', version.provider === 'cloudflare', `provider=${version.provider}`)
if (EXPECT_SHA) {
  check('production is serving the expected SHA',
    version.git_sha?.startsWith(EXPECT_SHA), `serving ${version.git_sha} expected ${EXPECT_SHA}`)
  check('build_sha matches the running env', version.build_sha_matches_env === true,
    `build_sha_matches_env=${version.build_sha_matches_env}`)
}

const browser = await chromium.launch()

/** One viewport pass. */
const pass = async (label, viewport, isMobile) => {
  console.log(`\n${label}  ${viewport.width}x${viewport.height}`)
  const context = await browser.newContext({
    viewport, isMobile, hasTouch: isMobile,
    ...(isMobile ? {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      deviceScaleFactor: 2,
    } : {}),
  })

  const consoleErrors = []
  const failedRequests = []
  const mapRequests = []
  const page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 180)) })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 180)}`))
  page.on('request', (r) => {
    const u = r.url()
    if (u.includes('maps.googleapis.com') || u.includes('streetview')) mapRequests.push(u.slice(0, 140))
  })
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().replace(BASE, '').slice(0, 150)}`)
  })

  await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForTimeout(9000)

  const shell = await page.evaluate(() => ({
    title: document.title,
    rootChildren: document.querySelector('#root')?.children.length ?? 0,
    hasOsShell: Boolean(document.querySelector('.nx-os, .nx-premium-inbox, .nx-fullscreen-app-shell')),
    bottomDock: Boolean(document.querySelector('.nx-pinned-app-dock')),
    topDock: Boolean(document.querySelector('.nx-mobile-command-dock')),
    // A sign-in wall is a legitimate state, not a failure — but it must be named.
    looksSignedOut: /sign in|log in|continue with|authenticate/i.test(document.body.innerText)
      && (document.body.innerText.length < 2000),
    bodyChars: document.body.innerText.length,
    theme: document.documentElement.getAttribute('data-nexus-theme'),
  }))

  check(`${label}: app shell mounted`, shell.rootChildren > 0, `#root has ${shell.rootChildren} children`)
  check(`${label}: no broken chunks or assets`,
    !failedRequests.some((r) => /\.(js|css)\b/.test(r)), failedRequests.filter((r) => /\.(js|css)\b/.test(r)).join(' | '))

  const fatal = consoleErrors.filter((e) => !/favicon|ResizeObserver loop|Failed to load resource/i.test(e))
  check(`${label}: no fatal JavaScript errors`, fatal.length === 0, fatal.slice(0, 3).join(' | '))

  await page.screenshot({ path: path.join(OUT, `${label.replace(/\W+/g, '-')}-inbox.png`) })

  if (shell.looksSignedOut) {
    note(`${label}: authenticated content`, 'production is showing a sign-in wall; content checks need an operator session')
  } else {
    check(`${label}: operating shell present`, shell.hasOsShell, JSON.stringify(shell))
    if (isMobile) {
      check(`${label}: mobile dock present`, shell.bottomDock || shell.topDock,
        `bottom=${shell.bottomDock} top=${shell.topDock}`)
    }
  }

  // §11 canonical routing — shell level, works signed out or in.
  const routeResults = []
  for (const [route, name] of ROUTES) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForTimeout(3500)
    const r = await page.evaluate(() => ({
      path: location.pathname,
      mounted: (document.querySelector('#root')?.children.length ?? 0) > 0,
    }))
    routeResults.push({ route, name, ...r })
  }
  console.log(`  routes: ${routeResults.map((r) => `${r.route}->${r.path}${r.mounted ? '' : ' (NOT MOUNTED)'}`).join('  ')}`)
  check(`${label}: every shipped route mounts`, routeResults.every((r) => r.mounted),
    routeResults.filter((r) => !r.mounted).map((r) => r.route).join(', '))
  // The alias contract is that the canonical SURFACE resolves, not that the URL
  // is rewritten. `canonicalizeRoutePath` maps the alias for navigation targets
  // and the shell renders the canonical view; a direct URL hit keeps its path.
  // Asserting a redirect was this harness assuming a contract that never
  // existed, and it failed against correct behaviour.
  for (const aliasRoute of ['/workflows-v2', '/workflow-studio-v1']) {
    await page.goto(`${BASE}${aliasRoute}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForTimeout(6000)
    const resolved = await page.evaluate(() => ({
      studio: Boolean(document.querySelector('.wfs2, .wfs2--mobile-studio')),
      shell: document.querySelector('.nx-fullscreen-app-shell')?.className ?? '',
    }))
    check(`${label}: ${aliasRoute} resolves to the Workflow Studio surface`,
      resolved.studio && /is-view-workflow_studio/.test(resolved.shell),
      `studio=${resolved.studio} shell=${resolved.shell}`)
  }

  // §21 Street View regression on the high-frequency surfaces.
  check(`${label}: no Street View / Maps requests on Inbox+Pipeline`, mapRequests.length === 0,
    mapRequests.slice(0, 3).join(' | '))

  // §18 no systematic 500s. A 423 is a safety refusal, not an outage.
  const fives = failedRequests.filter((r) => /^5\d\d /.test(r))
  const fourTwoThrees = failedRequests.filter((r) => /^423 /.test(r))
  check(`${label}: no API 500s`, fives.length === 0, fives.slice(0, 4).join(' | '))
  if (fourTwoThrees.length) console.log(`  (423 safety refusals, not outages: ${fourTwoThrees.length})`)
  const auth4xx = failedRequests.filter((r) => /^40[13] /.test(r))
  if (auth4xx.length) console.log(`  (auth-gated 401/403, expected when signed out: ${auth4xx.length})`)

  await context.close()
  return { shell, consoleErrors: fatal, failedRequests, mapRequests }
}

/**
 * §12-§17 content smoke, mobile only. Read-only throughout: nothing is sent,
 * no seller state is mutated, no campaign is activated, no cohort is built.
 */
const contentSmoke = async () => {
  console.log('\ncontent smoke  390x844 (read-only)')
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  const maps = []
  const fails = []
  const page = await context.newPage()
  page.on('request', (r) => {
    const u = r.url()
    if (u.includes('maps.googleapis.com') || u.includes('streetview')) maps.push(u.slice(0, 120))
  })
  page.on('response', (r) => {
    if (r.status() >= 400) fails.push(`${r.status()} ${r.url().replace(BASE, '').slice(0, 130)}`)
  })

  const open = async (route, waitMs = 9000) => {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForTimeout(waitMs)
  }
  const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel)
  const text = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText?.replace(/\s+/g, ' ').trim() ?? null, sel)

  // ── §12 INBOX
  await open('/inbox')
  // `.nx-row25` is the real production inbox card. An earlier guess
  // (`.nx-inbox-card`) matched nothing and produced a FALSE FAILURE against a
  // perfectly healthy Inbox — 25 cards, real sellers, inbox/live 200.
  const inboxRows = await count('.nx-row25')
  check('§12 Inbox: real cards load', inboxRows > 0, `${inboxRows} cards`)
  const inboxSearch = await count('button[aria-label*="earch" i], input[aria-label*="earch" i]')
  check('§12 Inbox: search control reachable', inboxSearch > 0, `${inboxSearch} search controls`)
  const inboxFilter = await count('.nx-cat-nav__item')
  check('§12 Inbox: category/filter control present', inboxFilter > 0, `${inboxFilter}`)
  await page.screenshot({ path: path.join(OUT, 'content-inbox.png') })

  // open a real thread, read-only
  const firstCard = page.locator('.nx-row25').first()
  if (await firstCard.count()) {
    await firstCard.click({ timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(6000)
    const threadOpen = await page.evaluate(() =>
      Boolean(document.querySelector('[class*="thread"], [class*="composer"], [class*="conversation"]')))
    check('§12 Inbox: a real thread opens', threadOpen, 'no thread surface after tapping a card')
    await page.screenshot({ path: path.join(OUT, 'content-inbox-thread.png') })
  } else {
    check('§12 Inbox: a card was available to open', false, 'no card to tap')
  }

  // ── §13 PIPELINE
  await open('/pipeline')
  const plmRows = await count('.plm-row:not(.is-skeleton), [class*="pipeline"][class*="card"]:not([class*="skeleton"])')
  check('§13 Pipeline: cards load', plmRows > 0, `${plmRows} rows`)
  const spine = await text('.plm-spine, [class*="stage-spine"], [class*="stage-rail"]')
  check('§13 Pipeline: stage counts render', Boolean(spine) && /\d/.test(spine ?? ''), `spine: ${spine}`)
  await page.screenshot({ path: path.join(OUT, 'content-pipeline.png') })

  // ── §14 ENTITY GRAPH
  await open('/entity-graph')
  const egMounted = await page.evaluate(() => (document.querySelector('#root')?.children.length ?? 0) > 0)
  const egContent = await page.evaluate(() => document.body.innerText.length)
  check('§14 Entity Graph: loads with content', egMounted && egContent > 500, `mounted=${egMounted} chars=${egContent}`)
  const egFatal = await page.evaluate(() => /something went wrong|failed to load|error boundary/i.test(document.body.innerText))
  check('§14 Entity Graph: no fatal graph/filter error', !egFatal, 'error text present')
  await page.screenshot({ path: path.join(OUT, 'content-entity-graph.png') })

  // ── §15 CAMPAIGN COMMAND
  const t0 = Date.now()
  await open('/campaign-command', 12_000)
  const cmkRows = await count('.cmk__row:not(.is-skeleton)')
  const campaignMs = Date.now() - t0
  check('§15 Campaign Command: list loads', cmkRows > 0, `${cmkRows} rows`)
  check('§15 Campaign Command: latency is reasonable', campaignMs < 25_000, `${campaignMs}ms`)
  console.log(`  campaign list render: ${campaignMs}ms, ${cmkRows} rows`)
  const quarantineTone = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.cmk__row')]
    const hit = rows.find((r) => /186 properties/i.test(r.innerText))
    return hit ? hit.innerText.replace(/\s+/g, ' ').trim().slice(0, 160) : null
  })
  check('§15 the quarantined campaign is present and truthful',
    Boolean(quarantineTone) && /blocked|quarantin/i.test(quarantineTone ?? ''),
    `row text: ${quarantineTone}`)
  console.log(`  df0671fa row: ${quarantineTone}`)
  await page.screenshot({ path: path.join(OUT, 'content-campaign.png') })

  // ── §16 WORKFLOW STUDIO
  await open('/workflow-studio', 11_000)
  const wfRows = await count('.wfs2-nav__row')
  const dockBtns = await count('.wfs2-mobile-dock__btn')
  const demoChip = await count('.wfs2-mobile-hero__chip.is-demo')
  const liveChip = await count('.wfs2-mobile-hero__chip.is-live')
  const openSheets = await count('.wfs2-mobile-sheet')
  check('§16 Workflow Studio: canonical route loads', await page.evaluate(() => location.pathname) === '/workflow-studio',
    await page.evaluate(() => location.pathname))
  check('§16 Workflow Studio: mobile dock reachable', dockBtns >= 4, `${dockBtns} dock buttons`)
  check('§16 Workflow Studio: no sheet auto-opens on load', openSheets === 0, `${openSheets} sheets open`)
  check('§16 Workflow Studio: no fabricated live overlay on load', liveChip === 0 && demoChip === 0,
    `live=${liveChip} demo=${demoChip}`)
  await page.screenshot({ path: path.join(OUT, 'content-workflow-studio.png') })

  // catalog + truthful labels, via the Flows sheet
  const flows = page.locator('button[aria-label="Flows — Switch flow"]')
  if (await flows.count()) {
    await flows.first().click()
    await page.waitForTimeout(4000)
    const rows = await page.evaluate(() => [...document.querySelectorAll('.wfs2-nav__row')].map((r) => ({
      name: r.querySelector('.wfs2-nav__row-copy strong')?.innerText.trim() ?? null,
      status: r.querySelector('.wfs2-nav__row-status')?.innerText.trim() ?? null,
      activation: r.querySelector('.wfs2-nav__row-activation')?.innerText.trim() ?? null,
    })))
    check('§16 Workflow Studio: catalog loads', rows.length > 0, `${rows.length} rows`)
    const armed = rows.filter((r) => r.activation === 'armed').map((r) => r.name)
    check('§16 no production workflow is broadly armed',
      armed.every((n) => /^TEST|^Test WF/.test(n ?? '')), `armed: ${armed.join(', ')}`)
    const silent = rows.filter((r) => !r.activation).map((r) => r.name)
    check('§16 every workflow states its operational truth', silent.length === 0, silent.slice(0, 4).join(', '))
    console.log(`  workflow catalog: ${rows.length} rows; armed: ${JSON.stringify(armed)}`)
    await page.screenshot({ path: path.join(OUT, 'content-workflow-flows.png') })
  } else {
    check('§16 Workflow Studio: flows control present', false, 'no flows dock button')
  }

  // ── §21 Street View on the high-frequency surfaces
  check('§21 no Street View across the content pass', maps.length === 0, `${maps.length} requests: ${maps.slice(0, 2).join(' | ')}`)

  // ── §18 API health across the pass
  const fives = fails.filter((r) => /^5\d\d /.test(r))
  const fourTwoThrees = fails.filter((r) => /^423 /.test(r))
  check('§18 no API 500s across the content pass', fives.length === 0, fives.slice(0, 5).join(' | '))
  if (fourTwoThrees.length) console.log(`  (423 safety refusals, not outages: ${fourTwoThrees.length})`)

  await context.close()
  return { maps, fails, campaignMs }
}

const mobile = await pass('mobile-390', { width: 390, height: 844 }, true)
const desktop = await pass('desktop-1440', { width: 1440, height: 900 }, false)
const content = process.argv.includes('--content') ? await contentSmoke() : null

await browser.close()

await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify({ version, mobile, desktop, content, findings, blocked }, null, 2))

console.log('')
console.log(findings.length === 0 ? 'SMOKE: all executed checks passed' : `SMOKE: ${findings.length} finding(s)`)
for (const f of findings) console.log(`  FAIL ${f.name}: ${f.detail}`)
if (blocked.length) {
  console.log(`BLOCKED (not passed, not failed): ${blocked.length}`)
  for (const b of blocked) console.log(`  ${b.name}: ${b.detail}`)
}
process.exit(findings.length === 0 ? 0 : 1)
