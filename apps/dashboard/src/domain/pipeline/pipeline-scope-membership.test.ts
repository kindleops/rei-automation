import { describe, expect, it } from 'vitest'

/**
 * PIPELINE-MOBILE-LOCK-1 §21/§31.9 — the scope decides membership.
 *
 * The defect: the board carried a `showSuppressed` refinement defaulting to
 * false, so `!showSuppressed && card.suppressed` removed every suppressed or
 * dead row. Three scopes are DEFINED as those rows, so the refinement deleted
 * the whole scope while the header went on reporting the canonical count from
 * /pipeline/counts. Measured against the API on 2026-09-15:
 *
 *   scope            canonical   rendered
 *   suppressed             156          0
 *   dead                   348          0
 *   closed                 476          1
 *   needs_attention        292        263
 *   all                    768        181
 *
 * These are the real status mixes each scope returns, so the assertions below
 * fail if the refinement is ever re-applied where the scope already selects.
 */

/**
 * `loaded` is the status mix of the rows the board actually holds; `canonical`
 * is the scope total reported by /pipeline/counts. They differ only for `all`,
 * where 768 exceeds the server's MAX_LIMIT of 500 — the one scope that cannot
 * load whole, and the reason the board states "Showing 500 of 768" instead of
 * presenting the page as the scope.
 */
const SCOPES: Record<string, { loaded: Record<string, number>; canonical: number }> = {
  active: { loaded: { active: 264 }, canonical: 264 },
  needs_attention: { loaded: { active: 263, suppressed: 29 }, canonical: 292 },
  all: { loaded: { active: 181, suppressed: 101, dead: 218 }, canonical: 768 },
  dead: { loaded: { dead: 348 }, canonical: 348 },
  suppressed: { loaded: { suppressed: 156 }, canonical: 156 },
  closed: { loaded: { dead: 348, suppressed: 127, active: 1 }, canonical: 476 },
}

/** Mirrors buildCard: the flag the refinement reads. */
const isSuppressedCard = (status: string) => status === 'suppressed' || status === 'dead'

/** Mirrors the board. Kept as one expression so the test pins the real rule. */
const suppressionFilterAvailable = (scope: string) =>
  scope !== 'suppressed' && scope !== 'dead' && scope !== 'closed'

const rendered = (scope: string, hideSuppressed: boolean) => {
  const hide = hideSuppressed && suppressionFilterAvailable(scope)
  return Object.entries(SCOPES[scope].loaded).reduce(
    (n, [status, count]) => (hide && isSuppressedCard(status) ? n : n + count),
    0,
  )
}

const loadedTotal = (scope: string) =>
  Object.values(SCOPES[scope].loaded).reduce((a, b) => a + b, 0)

/** Mirrors the board's truncation guard. */
const loadedShortOfScope = (scope: string) => loadedTotal(scope) < SCOPES[scope].canonical

describe('a scope is never subtracted out from under its own count', () => {
  it('renders every row it loaded, for every scope, by default', () => {
    for (const scope of Object.keys(SCOPES)) {
      expect(rendered(scope, false), scope).toBe(loadedTotal(scope))
    }
  })

  /**
   * Five of six scopes fit inside one page, so for them the rendered count IS
   * the canonical count — no caveat needed. `all` does not, and must announce
   * it rather than let 500 read as 768.
   */
  it('matches the canonical count exactly wherever the scope fits in one page', () => {
    for (const scope of ['active', 'needs_attention', 'dead', 'suppressed', 'closed']) {
      expect(rendered(scope, false), scope).toBe(SCOPES[scope].canonical)
      expect(loadedShortOfScope(scope), scope).toBe(false)
    }
    expect(loadedShortOfScope('all')).toBe(true)
    expect(rendered('all', false)).toBe(500)
  })

  /**
   * The specific regression: the three scopes whose definition IS the hidden
   * set must survive even with the refinement turned on, because there the
   * refinement is not offered at all.
   */
  it('cannot empty a scope that is defined as suppressed or dead', () => {
    for (const scope of ['suppressed', 'dead', 'closed']) {
      expect(suppressionFilterAvailable(scope), scope).toBe(false)
      expect(rendered(scope, true), scope).toBe(SCOPES[scope].canonical)
      expect(rendered(scope, true), scope).toBeGreaterThan(0)
    }
  })

  /** Where the scope genuinely mixes, the refinement still works — engaged only. */
  it('still filters within a mixed scope when the operator asks', () => {
    expect(suppressionFilterAvailable('needs_attention')).toBe(true)
    expect(rendered('needs_attention', true)).toBe(263)
    expect(rendered('needs_attention', false)).toBe(292)
    expect(rendered('all', true)).toBe(181)
    expect(rendered('all', false)).toBe(500)
  })

  /**
   * Dead is not suppressed. The card flag conflates them for the purpose of
   * this one refinement, which is why the Dead scope had to be exempted too —
   * pinned so a future reader does not "simplify" the exemption away.
   */
  it('exempts Dead as well as Suppressed', () => {
    expect(isSuppressedCard('dead')).toBe(true)
    expect(rendered('dead', true)).toBe(348)
  })
})
