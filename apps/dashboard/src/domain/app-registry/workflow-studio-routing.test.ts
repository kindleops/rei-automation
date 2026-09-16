import { describe, expect, it } from 'vitest'
import { NEXUS_APPS, MOBILE_APPS, canonicalizeRoutePath, getApp, resolveAppForRoute } from './app-registry'

/**
 * WORKFLOW-STUDIO-MOBILE-LOCK-1 §2/§40 — Workflow Studio routing, asserted as
 * behaviour.
 *
 * The critical suite carried a failing test for several phases
 * (`dashboard routing defaults to Workflow Studio V2`) which grepped
 * `app/routes.tsx` for the alias literals. The aliases moved into the route
 * registry in commit 6ef12bc9, so the test was asserting the location of a
 * string rather than what the router does — it stayed red while the behaviour
 * it cared about was correct the whole time.
 *
 * This is the same contract, executed: `canonicalizeRoutePath` is the function
 * the shell actually calls, so these assertions break if the routing behaviour
 * breaks, and survive the literals moving again.
 */

describe('Workflow Studio has one canonical route', () => {
  it('is registered as /workflow-studio', () => {
    const entry = getApp('workflow-studio')
    expect(entry, 'workflow-studio must be a registered app').toBeDefined()
    expect(entry?.route).toBe('/workflow-studio')
  })

  it('leaves the canonical route unchanged', () => {
    expect(canonicalizeRoutePath('/workflow-studio')).toBe('/workflow-studio')
  })

  /**
   * Both legacy paths are still part of the product contract: an existing
   * bookmark or deep link must land on the surface, not 404.
   */
  it('resolves both legacy aliases to the canonical route', () => {
    expect(canonicalizeRoutePath('/workflows-v2')).toBe('/workflow-studio')
    expect(canonicalizeRoutePath('/workflow-studio-v1')).toBe('/workflow-studio')
  })

  it('does not invent a Workflow Studio route for unrelated paths', () => {
    for (const path of ['/pipeline', '/inbox', '/campaign-command', '/nope']) {
      expect(canonicalizeRoutePath(path)).not.toBe('/workflow-studio')
    }
  })

  /** The registry is the single authority — no second alias table. */
  it('routes every alias to a registered app route', () => {
    const registered = new Set(NEXUS_APPS.map((app) => app.route))
    for (const alias of ['/workflows-v2', '/workflow-studio-v1', '/campaigns', '/dossier']) {
      const resolved = canonicalizeRoutePath(alias)
      expect(registered.has(resolved), `${alias} -> ${resolved} must be a registered route`).toBe(true)
    }
  })

  /** §40 — the mobile dock has to be able to reach the surface at all. */
  it('is reachable from the mobile app set', () => {
    expect(MOBILE_APPS.some((app) => app.id === 'workflow-studio')).toBe(true)
  })

  it('resolves the canonical route back to the Workflow Studio app', () => {
    expect(resolveAppForRoute('/workflow-studio').id).toBe('workflow-studio')
    expect(resolveAppForRoute(canonicalizeRoutePath('/workflows-v2')).id).toBe('workflow-studio')
  })

  it('sends the bare root to a real surface rather than nowhere', () => {
    const resolved = canonicalizeRoutePath('/')
    expect(NEXUS_APPS.some((app) => app.route === resolved)).toBe(true)
  })
})
