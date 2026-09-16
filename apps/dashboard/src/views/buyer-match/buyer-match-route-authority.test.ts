import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDockDestination } from '../../domain/locator/property-locator'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(here, '../..')
const readRaw = (rel: string) => readFileSync(join(srcRoot, rel), 'utf8')

/**
 * Source with comments stripped.
 *
 * The prose in these files deliberately NAMES what it replaced —
 * "it previously served BuyerMatchView", "the old loadBuyer loader",
 * "referenceCommandCenterData is no longer the product" — so matching raw text
 * fails on documentation while the code is correct. The same trap
 * cloudflare-cron-scope.test.mjs records: "matching on prose would pass for the
 * wrong reason".
 *
 * Line-based on purpose: a regex block-comment stripper mispairs on `*\/`
 * inside a string literal. This only inspects how a line STARTS, which a
 * string literal cannot fake.
 */
const read = (rel: string) => {
  const out: string[] = []
  let inBlock = false
  for (const line of readRaw(rel).split('\n')) {
    const t = line.trim()
    if (inBlock) {
      if (t.endsWith('*/')) inBlock = false
      continue
    }
    if (t.startsWith('/*')) {
      if (!t.endsWith('*/')) inBlock = true
      continue
    }
    if (t.startsWith('//') || t.startsWith('*')) continue
    out.push(line.replace(/\s+\/\/.*$/, ''))
  }
  return out.join('\n')
}

/**
 * BUYER-MATCH-MOBILE-LOCK-1 §1/§2/§3/§20 — the production route serves the
 * canonical product.
 *
 * THE DEFECT. `/buyer-match` rendered `BuyerMatchView` -> `BuyerIntelPage`, fed
 * entirely by `referenceCommandCenterData` — hardcoded demo buyers and demo
 * properties with synthetic `minutesAgo()` activity — and ranked them by a
 * match score the page computed itself:
 *
 *   for (const buyer of buyers) for (const propId of store.propertyIds) { ... }
 *   matches.sort((a, b) => b.matchScore - a.matchScore)
 *
 * There was no property subject at all, while the canonical engine
 * (buyer_match_candidates over 26,390 buyer_entities_v2) sat behind a workspace
 * mounted only inside the Inbox.
 *
 * These assert the WIRING, which is what regressed. The behaviour of the
 * canonical projection is covered in buyer-match-truth.test.ts and end to end
 * by scripts/proof/mobile/buyer-match-mobile-qa.mjs.
 */

describe('the production Buyer Match route', () => {
  const routes = read('app/routes.tsx')

  it('is registered at /buyer-match and renders the subject-scoped page', () => {
    expect(routes).toMatch(/path: '\/buyer-match'/)
    expect(routes).toMatch(/BuyerMatchSubjectPage/)
  })

  /** The whole point: the demo product is off the production route. */
  it('does not render the demo Buyer Intel page', () => {
    expect(routes).not.toMatch(/BuyerMatchView/)
    expect(routes).not.toMatch(/BuyerIntelPage/)
  })

  /**
   * The demo loader hydrated `referenceCommandCenterData` on every visit to the
   * route. It must not be wired into routing any more. The dataset itself is
   * deliberately still in the tree — other reference surfaces import it.
   */
  it('does not hydrate the demo buyer model', () => {
    expect(routes).not.toMatch(/loadBuyer/)
  })

  it('reaches the canonical workspace, not a reimplementation', () => {
    const page = read('views/buyer-match/BuyerMatchSubjectPage.tsx')
    expect(page).toMatch(/modules\/inbox\/components\/BuyerMatchWorkspace/)
    expect(page).not.toMatch(/referenceCommandCenterData/)
    expect(page).not.toMatch(/buyer\.adapter/)
  })

  /**
   * §7 — no frontend loop may compute its own match percentage. The demo page
   * did exactly that; the mobile lens must only read what the engine returned.
   */
  it('computes no score of its own on the mobile lens', () => {
    const lens = read('views/buyer-match/mobile/BuyerMatchMobile.tsx')
    const presentation = read('views/buyer-match/buyer-match-presentation.ts')
    for (const source of [lens, presentation]) {
      expect(source).not.toMatch(/matchScore\s*=/)
      expect(source).not.toMatch(/\.sort\(\s*\(/)
    }
    // It ranks by nothing: the endpoint already orders by match_score desc.
    expect(lens).toMatch(/total_match_score|describeMatchGrade/)
  })

  /**
   * §12 — the selected property may have one visual; buyer cards may not. 25
   * cards with imagery would be 25 Street View requests, which is the fan-out
   * this codebase has already paid for on Inbox and the Pipeline board.
   */
  it('puts imagery on the property and never on a buyer card', () => {
    const page = read('views/buyer-match/BuyerMatchSubjectPage.tsx')
    const lens = read('views/buyer-match/mobile/BuyerMatchMobile.tsx')
    expect(page).toMatch(/EntityGraphPropertyVisual/)
    // The lens renders the visual it is HANDED, and builds none itself.
    expect(lens).not.toMatch(/EntityGraphPropertyVisual|buildStreetViewUrl|streetview/i)
    expect(lens).toMatch(/propertyVisual/)
  })
})

describe('the dock carries the property into Buyer Match', () => {
  const locator = {
    propertyId: '24613730',
    threadKey: null,
    masterOwnerId: null,
    prospectId: null,
    opportunityId: 'opp-1',
    address: '6340 W Monterey Way, Phoenix, Az 85033',
    setAt: Date.now(),
  }

  it('focuses /buyer-match on the located property', () => {
    expect(resolveDockDestination('/buyer-match', locator))
      .toBe('/buyer-match?property_id=24613730')
  })

  /**
   * §3 — without a property the dock must fall back to the plain path, where
   * the page shows the honest select-a-property state. Returning a focused URL
   * with an empty id would have produced a request for `property_id=`.
   */
  it('falls back to the plain path when there is no property', () => {
    expect(resolveDockDestination('/buyer-match', { ...locator, propertyId: null })).toBeNull()
    expect(resolveDockDestination('/buyer-match', null)).toBeNull()
  })

  it('leaves the other destinations untouched', () => {
    expect(resolveDockDestination('/queue', locator)).toBe('/queue?property_id=24613730')
    expect(resolveDockDestination('/pipeline', locator)).toBe('/pipeline?opp=opp-1')
    expect(resolveDockDestination('/campaign-command', locator)).toBeNull()
  })
})
