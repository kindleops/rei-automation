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
    const parts = read('views/buyer-match/workspace/BuyerMatchParts.tsx')
    const card = parts.slice(parts.indexOf('export function BuyerCard'))
    const hero = parts.slice(parts.indexOf('export function SubjectHero'), parts.indexOf('export function MatchHero'))
    // One Street View request, for the subject — none per buyer card.
    expect(hero).toMatch(/staticStreetViewUrl/)
    expect(card).not.toMatch(/staticStreetViewUrl|streetview|<img/i)
  })

  /**
   * The observed-behaviour workspace tiers and explains on the SERVER
   * (buyer-match-workspace-service). The surface may re-order what came back
   * (operator sorts) but never assigns a tier, a score or a reason.
   */
  /**
   * 2026-09-28: opened from the app switcher with a property in the global
   * bar's chip, Buyer Match said "Select a property". The page must be scoped
   * to exactly what the chip shows (URL first, then the selected context).
   */
  /**
   * 2026-09-28: on the installed PWA the document has no scroll, and the new
   * surface rendered one screen and froze. The root must own its own scroll,
   * absolute against the shared app root (never a viewport-unit height).
   */
  it('owns its own vertical scroll on mobile', () => {
    const css = read('views/buyer-match/workspace/buyer-match-surface.css')
    const root = css.slice(css.indexOf('\n.bmx {'), css.indexOf('}', css.indexOf('\n.bmx {')))
    expect(root).toMatch(/position:\s*absolute/)
    expect(root).toMatch(/inset:\s*0/)
    expect(root).toMatch(/overflow-y:\s*auto/)
    expect(root).not.toMatch(/\d+(dvh|vh|lvh|svh)/)
  })

  it('follows the property the global context chip shows', () => {
    const page = read('views/buyer-match/BuyerMatchSubjectPage.tsx')
    expect(page).toMatch(/readSelectedContext\(\)/)
    expect(page).toMatch(/resolveBuyerMatchSubject\(\)[\s\S]*readSelectedContext\(\)/)
    expect(page).toMatch(/PROPERTY_LOCATOR_EVENT, onLocator/)
  })

  it('never tiers, scores or explains a buyer in the browser', () => {
    const surface = read('views/buyer-match/workspace/BuyerMatchSurface.tsx')
    const parts = read('views/buyer-match/workspace/BuyerMatchParts.tsx')
    for (const source of [surface, parts]) {
      expect(source).not.toMatch(/tier\s*[:=]\s*['"](strong|moderate|exploratory)/)
      expect(source).not.toMatch(/matchScore\s*=|classifyBuyer|evidenceLines/)
    }
    expect(surface).toMatch(/fetchBuyerMatchWorkspace/)
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
