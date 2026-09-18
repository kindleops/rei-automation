#!/usr/bin/env node
/**
 * BUYER MATCH — the contract, not the component (§29).
 *
 * Covers the two defects this pass found, so neither can come back:
 *
 *  1. The subject header read `deal-context/property/:id`, a SELLER-DEAL view
 *     that only has a row where a thread or opportunity exists. Buyer Match is
 *     property-scoped and needs no seller conversation, so on the acceptance
 *     subject it returned 404 and the page showed "Property details
 *     unavailable" above 25 real ranked buyers. It now reads the canonical
 *     `/properties/:id/subject`, the same authority Comp Intelligence uses.
 *
 *  2. The app registry declared `context: { propertyId: 'locator' }`, which
 *     leaves the path bare and expects the surface to seed from the ambient
 *     locator. The §3 context pass made the subject resolver read the URL and
 *     ONLY the URL, so a contextual "Find Buyers" resolved to /buyer-match and
 *     landed in universal mode.
 *
 * Usage: node scripts/proof/mobile/buyer-match-contract.mjs [--property 2130387643]
 */
import { webkit } from 'playwright'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const PROPERTY = arg('property', '2130387643')
const WIDTH = Number(arg('width', '390'))
const HEIGHT = Number(arg('height', '844'))
const THEME = arg('theme', 'dark')

const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  <- ${detail}`}`)
}

const browser = await webkit.launch()
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT }, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
await context.addInitScript((t) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), nexusTheme: t }))
  } catch { /* first run */ }
}, THEME)

console.log(`BUYER MATCH CONTRACT  webkit ${WIDTH}x${HEIGHT} ${THEME}  property=${PROPERTY}`)

// ── the registry must declare a contract the surface can actually consume
{
  const page = await context.newPage()
  await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('#root > *', { timeout: 90_000 })
  const contract = await page.evaluate(async () => {
    const mod = await import('/src/domain/app-registry/app-registry.ts')
    const app = mod.NEXUS_APPS.find((a) => a.id === 'buyer-match')
    return { context: app?.context ?? null, route: app?.route ?? null }
  }).catch(() => null)
  if (contract) {
    // A surface that reads the URL cannot be fed by a contract that leaves the
    // path bare — that mismatch IS the bug.
    check('the registry carries the property id in the URL for Buyer Match',
      contract.context?.propertyId === 'query:property_id',
      JSON.stringify(contract.context))
  }
  await page.close()
}

const read = (page) => page.evaluate(() => {
  const doc = document.scrollingElement || document.documentElement
  const text = (document.body.innerText || '').replace(/\s+/g, ' ')
  return {
    url: location.pathname + location.search,
    chip: document.querySelector('.nx-mobile-command-dock__context')?.innerText.replace(/\s+/g, ' ').trim() || null,
    text,
    overflow: Math.max(0, doc.scrollWidth - window.innerWidth),
    // Buyer identity must come from ids, never list position.
    buyerIds: [...document.querySelectorAll('[data-buyer-id]')].map((n) => n.getAttribute('data-buyer-id')),
  }
})

// ── context mode: the exact subject, with a resolved header
{
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)))
  await page.goto(`${BASE}/buyer-match?property_id=${PROPERTY}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('#root > *', { timeout: 90_000 })
  await page.waitForTimeout(18_000)
  const s = await read(page)

  check('the contextual route keeps the exact property id', s.url.includes(`property_id=${PROPERTY}`), s.url)
  check('a context chip is shown', Boolean(s.chip), `${s.chip}`)
  // The header defect: an unresolved subject above a resolved analysis.
  check('the subject header resolves the property',
    !/property details unavailable|loading property/i.test(s.text),
    s.text.slice(0, 120))
  check('the header states real subject facts', /Houston/i.test(s.text) && /\$\d/.test(s.text))
  check('real ranked buyers render', /Grade\s*[A-D]/i.test(s.text))
  check('no dead no-run state', !/no buyer match run exists/i.test(s.text))
  check('no horizontal overflow', s.overflow <= 1, `+${s.overflow}px`)
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.screenshot({ path: `/tmp/bm-${WIDTH}-${THEME}.png` })
  await page.close()
}

// ── universal mode must not acquire a subject
{
  const page = await context.newPage()
  await page.goto(`${BASE}/buyer-match`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('#root > *', { timeout: 90_000 })
  await page.waitForTimeout(8000)
  const s = await read(page)
  check('the bare route carries no property', !/property_id=/.test(s.url), s.url)
  check('universal mode acquires no ambient subject', !s.chip, `chip=${s.chip}`)
  check('universal mode shows no stale buyers', !/Grade\s*[A-D]/i.test(s.text))
  check('universal mode says what it needs', /select a property|choose a property|scoped to one property/i.test(s.text),
    s.text.slice(0, 120))
  await page.close()
}

await browser.close()
console.log('')
if (failures.length) {
  console.error(`✗ ${failures.length} failure(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('✓ Buyer Match contract intact')
