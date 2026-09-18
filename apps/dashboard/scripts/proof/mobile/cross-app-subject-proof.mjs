/**
 * FINAL-FRONTEND-LOCK-1 §6/§7/§35 — cross-app subject context proof.
 *
 * READ ONLY (§36). Seeds the subject the same way the product does — the
 * sessionStorage property locator, which is the real cross-app carrier — then
 * navigates and READS. It never sends, never mutates a seller, never writes.
 *
 * THE INVARIANT: with subject A selected, every subject-scoped app shows A.
 * Switch to B and every one shows B, or an honest no-state. Never A. Never a
 * different subject merely because it has data.
 *
 * Subject-scoped vs global is not a guess — it is read from the app registry's
 * own `context` contract (see app-registry.ts).
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const BASE = arg('base', 'http://localhost:5174')
const WIDTH = Number(arg('width', '390'))

const OUT = path.resolve('artifacts/cross-app-subject')
await fs.mkdir(OUT, { recursive: true })

/** Two real production subjects. Distinct seller, address, market and property. */
const A = {
  tag: 'A',
  propertyId: '278477219',
  threadKey: '+12063359131',
  masterOwnerId: 'mo_90f09be6cb70e4cc7689d893',
  prospectId: null,
  opportunityId: 'd003334f-fe26-4dc8-b4f0-247c0af9e5b0',
  address: '5115 Michigan Ave, Kansas City, Mo 64130',
  seller: 'Tice',
  cityToken: 'Kansas City',
  stateToken: 'Mo 64130',
}
const B = {
  tag: 'B',
  propertyId: '225438557',
  threadKey: '+12039942149',
  masterOwnerId: 'mo_75446183f13829d83d34302f',
  prospectId: null,
  opportunityId: '9b690ce3-ff88-400b-b56e-69e9bd0055b0',
  address: '81 Sefton Dr, New Britain, Ct 06053',
  seller: 'Larson',
  cityToken: 'New Britain',
  stateToken: 'Ct 06053',
}

/**
 * Subject-scoped surfaces, straight from the registry `context` contract.
 * `carrier` records HOW the subject reaches the surface, because a locator-fed
 * view and a path-fed view fail in different ways.
 */
const SCOPED = [
  /**
   * `textPositive: false` means TEXT PRESENCE IS THE WRONG INSTRUMENT here, not
   * that the surface is exempt from the invariant. Every surface is still held
   * to the leakage rule (§35) — it must never show the other subject instead.
   *
   *   /map          draws pins to a canvas; the selected address is never text,
   *                 so "Live Map 1" is a rendered pin the DOM cannot spell.
   *   /inbox        is a VIRTUALIZED list: only rows inside the render window
   *                 exist in the DOM, so the selected thread's name is present
   *                 or absent depending on scroll position — it passed in some
   *                 runs and failed in others, which makes it a coin flip, and
   *                 a flaky positive assertion is worse than none.
   *   /conversation shares that list.
   *
   * Their subject wiring is covered by the dedicated certified app harnesses;
   * what this system proof adds for them is the cross-app leakage check.
   */
  { route: '/inbox', name: 'Inbox', carrier: 'locator(threadKey+propertyId)', textPositive: false },
  { route: '/conversation', name: 'Conversation', carrier: 'locator(threadKey)', textPositive: false },
  { route: '/comp-intelligence', name: 'Comp Intelligence', carrier: 'locator(propertyId)', textPositive: true },
  { route: '/map', name: 'Map', carrier: 'locator(propertyId)', textPositive: false },
  // Buyer Match's registry contract is `query:property_id`, NOT the ambient
  // locator — its subject resolver reads the URL and only the URL. The bare
  // route is therefore expected to reach honest no-state, which is what this
  // run asserts; the label said `locator` and had drifted from the contract.
  { route: '/buyer-match', name: 'Buyer Match', carrier: 'query(property_id)', textPositive: true },
  { route: (s) => `/entity-graph/property/${s.propertyId}`, name: 'Entity Graph', carrier: 'path(propertyId)', textPositive: true },
  { route: (s) => `/pipeline?opp=${s.opportunityId}`, name: 'Pipeline', carrier: 'query(opportunityId)', textPositive: true },
]

/** Global surfaces: they legitimately ignore the subject. Recorded, not asserted against. */
const GLOBAL = ['/queue', '/campaign-command', '/workflow-studio', '/closing-desk', '/calendar', '/analytics', '/email-command', '/properties']

const LOCATOR_KEY = 'nexus:property-locator:v1'

/**
 * ONE definition of "the surface stated a no-state", used by both the settle
 * condition and the assertion. They were separate patterns and disagreed: the
 * wait accepted the Map's "No visible pins" and the assertion did not, so /map
 * was reported as failing to state anything while it was stating exactly that.
 */
const HONEST_NO_STATE = /no subject|select a|not available|nothing|empty|no deals|no match|no visible pins|no mapped pins/i

/**
 * Playwright's addInitScript(fn, arg) passes exactly ONE argument. An earlier
 * version took (subject, key) and was called with both, so `key` arrived
 * undefined and the locator was written to the literal key "undefined". No
 * subject was ever seeded, every surface showed its default thread, and the
 * harness reported that as cross-app subject leakage on nine routes.
 */
const seedLocator = ({ subject, key }) => {
  try {
    window.sessionStorage.setItem(key, JSON.stringify({
      propertyId: subject.propertyId,
      threadKey: subject.threadKey,
      masterOwnerId: subject.masterOwnerId,
      prospectId: subject.prospectId,
      opportunityId: subject.opportunityId,
      address: subject.address,
      setAt: Date.now(),
    }))
  } catch {}
}

const findings = []
const observations = []
const browser = await chromium.launch()

/**
 * One context per subject phase. A fresh context would also clear the locator,
 * which is the point of sessionStorage — so the subject is re-seeded via an
 * init script that runs before every navigation in the phase.
 */
async function phase(subject, other, label) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    timezoneId: 'America/Phoenix',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  await context.addInitScript(seedLocator, { subject, key: LOCATOR_KEY })
  const page = await context.newPage()

  console.log(`\n── ${label}: subject ${subject.tag} (${subject.seller} — ${subject.address})`)

  for (const s of SCOPED) {
    const route = typeof s.route === 'function' ? s.route(subject) : s.route
    const check = (n, ok, d) => { if (!ok) findings.push({ phase: label, route, n, d }); return ok }
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      await page.waitForSelector('#root > *', { timeout: 45_000 })
    } catch (e) {
      check('§35 subject-scoped route loads', false, String(e).slice(0, 110))
      continue
    }

    /**
     * Settle on a STATED OUTCOME, not on text-length stability.
     *
     * Length stability alone measured the inbox mid-load: the bucket rail
     * renders "Priority 0 / New Replies 0" with a briefly constant length
     * before the counts arrive, so two equal samples looked settled and the
     * harness reported that subject B never reached /inbox. It does — Priority
     * 49, New Replies 142 — about 3s later.
     *
     * So wait until the subject is visible OR the surface states a no-state.
     * A timeout still fails the assertion below, so this waits for an answer
     * without deciding what the answer is.
     */
    await page.waitForFunction(({ seller, city, pid, honestSrc }) => {
      const CHROME = '.nx-pinned-app-dock, .nx-mobile-command-dock, .nx-topbar, [class*="launcher"],'
        + ' script, style, noscript, template'
      const clone = document.body.cloneNode(true)
      for (const n of clone.querySelectorAll(CHROME)) n.remove()
      const txt = ((clone.textContent || '').replace(/\s+/g, ' ')).toLowerCase()
      if (!txt.trim()) return false
      const self = txt.includes(seller.toLowerCase()) || txt.includes(city.toLowerCase()) || txt.includes(pid)
      const honest = new RegExp(honestSrc, 'i').test(txt)
      return self || honest
    }, { seller: subject.seller, city: subject.cityToken, pid: subject.propertyId, honestSrc: HONEST_NO_STATE.source }, { timeout: 45_000 })
      .catch(() => {})
    await page.waitForTimeout(1200)

    const p = await page.evaluate(() => {
      /**
       * script/style MUST be stripped. textContent on a clone includes inline
       * <script> source, and the service-worker registration inline script
       * contains identifier-looking strings — enough to make a subject-presence
       * test match text no operator can see.
       */
      const CHROME = '.nx-pinned-app-dock, .nx-mobile-command-dock, .nx-topbar,'
        + ' [class*="app-launcher"], [class*="launcher"], [class*="more-sheet"], [class*="search-overlay"],'
        + ' script, style, noscript, template'
      const clone = document.body.cloneNode(true)
      for (const n of clone.querySelectorAll(CHROME)) n.remove()
      return {
        app: (clone.textContent || '').replace(/\s+/g, ' ').trim(),
        locator: (() => { try { return window.sessionStorage.getItem('nexus:property-locator:v1') } catch { return null } })(),
      }
    })

    const norm = (v) => v.toLowerCase()
    const app = norm(p.app)
    const hasSelf = app.includes(norm(subject.seller)) || app.includes(norm(subject.cityToken)) || app.includes(norm(subject.propertyId))
    const otherHits = [other.seller, other.cityToken, other.stateToken, other.propertyId, other.threadKey]
      .filter((t) => app.includes(norm(t)))

    const honest = HONEST_NO_STATE.test(p.app)

    /**
     * §35 THE ASSERTION, stated correctly.
     *
     * "The other subject's name appears anywhere on the surface" is NOT
     * leakage: /inbox renders a list of every thread, so B's seller legitimately
     * appears while A is the open one. Asserting bare absence reported leakage
     * on the inbox in all three phases while the subject was in fact correct.
     *
     * The defect is showing the WRONG subject: the other subject present while
     * this one is absent. A surface that shows this subject is correct even if
     * the other appears elsewhere in a list, and an honest no-state is
     * acceptable — substituting another subject because it has data is not.
     */
    check(`§35 surface scoped to ${subject.tag} does not show ${other.tag} instead`,
      !(otherHits.length > 0 && !hasSelf),
      `shows ${other.tag} (${otherHits.join(', ')}) and does NOT show ${subject.tag}`)

    if (s.textPositive) {
      check(`§6 subject ${subject.tag} reached the surface, or it states no-state`,
        hasSelf || honest,
        `neither ${subject.tag} nor an honest no-state; head="${p.app.slice(0, 110)}"`)
    }
    observations.push({
      phase: label, route, name: s.name, carrier: s.carrier,
      textPositiveAsserted: !!s.textPositive,
      hasSelf, otherHits, honest, chars: p.app.length,
    })

    /**
     * The label must agree with the assertion. An earlier version printed
     * 'LEAK' whenever the other subject appeared at all, so Inbox, Conversation
     * and Pipeline were labelled LEAK in a run that passed — those are LISTS,
     * and a list holding other subjects alongside the selected one is correct.
     */
    const suffix = s.textPositive ? '' : ' [leak-only]'
    const verdict = otherHits.length > 0 && !hasSelf
      ? `WRONG SUBJECT (shows ${other.tag})`
      : hasSelf
        ? `shows ${subject.tag}${otherHits.length ? ' (list also holds ' + other.tag + ')' : ''}`
        : honest ? 'honest no-state' : 'neutral'
    console.log(`   ${s.name.padEnd(19)} ${route.slice(0, 44).padEnd(45)} ${verdict}${suffix}`)

    /**
     * Guard the harness: if the locator is absent the subject was never seeded
     * and every verdict above is vacuous.
     */
    if (check('the subject locator is present (harness guard)', !!p.locator, 'locator missing — seeding failed')) {
      let seeded = null
      try { seeded = JSON.parse(p.locator) } catch {}
      check('the locator holds THIS subject', seeded?.propertyId === subject.propertyId,
        `locator propertyId=${seeded?.propertyId} wanted=${subject.propertyId}`)
    }
  }

  // §6 global surfaces must not claim a subject they do not read.
  for (const route of GLOBAL) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {})
    await page.waitForSelector('#root > *', { timeout: 45_000 }).catch(() => {})
    await page.waitForTimeout(3500)
    const p = await page.evaluate(() => {
      const CHROME = '.nx-pinned-app-dock, .nx-mobile-command-dock, .nx-topbar,'
        + ' [class*="app-launcher"], [class*="launcher"], [class*="more-sheet"], [class*="search-overlay"],'
        + ' script, style, noscript, template'
      const clone = document.body.cloneNode(true)
      for (const n of clone.querySelectorAll(CHROME)) n.remove()
      return (clone.textContent || '').replace(/\s+/g, ' ').trim()
    })
    const lower = p.toLowerCase()
    /**
     * Recorded, never asserted. A global surface is a list of ALL work — Queue
     * rows and Calendar events for every seller in the system — so another
     * subject's name appearing there is correct behaviour, not leakage. The
     * earlier version asserted absence and flagged Queue and Calendar for
     * faithfully doing their job.
     */
    const hits = [other.seller, other.cityToken].filter((t) => lower.includes(t.toLowerCase()))
    observations.push({ phase: label, route, name: route, carrier: 'global', alsoMentions: hits })
  }
  console.log(`   (global surfaces checked: ${GLOBAL.length})`)

  await context.close()
}

await phase(A, B, 'A')
await phase(B, A, 'B')
await phase(A, B, 'A-return')

await browser.close()
await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify({ A, B, SCOPED: SCOPED.map((s) => s.name), GLOBAL, observations, findings }, null, 2))

console.log('\n' + '─'.repeat(74))
console.log('SUBJECT-SCOPED (registry context contract):')
for (const s of SCOPED) console.log(`   ${s.name.padEnd(19)} ${s.carrier}`)
console.log(`GLOBAL (read no subject): ${GLOBAL.join(' ')}`)
console.log('─'.repeat(74))
if (findings.length === 0) {
  console.log('PASS — A -> B -> A with no stale subject leakage')
} else {
  console.log(`FAIL — ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  [${f.phase}] ${f.route}  ${f.n}\n      ${f.d}`)
}
process.exit(findings.length === 0 ? 0 : 1)
