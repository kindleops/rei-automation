import { describe, expect, it } from 'vitest'
import { buildPipelineQueryParams, resolvePipelineResultTruth } from './pipeline-query-params'
import type { PipelineViewState } from './pipeline-card-design.types'

/**
 * PIPELINE-MOBILE-LOCK-1B §1–§4 — Pipeline search is corpus-wide.
 *
 * The defect: typing filtered only the hydrated board. Scope `all` holds 768
 * opportunities against a 500-row response cap (MAX_LIMIT in
 * opportunity-service.js), so any match among the remaining 268 was
 * unreachable. Measured against the API on 2026-09-15:
 *
 *   "Shirley A Frauli" / property 250991336 / opportunity 1d2a75e1-…
 *   absent from the loaded 500, q=Frauli -> 1 row
 *
 * The server already evaluated scope AND query in one predicate
 * (applyFilters); nothing in the UI sent `q`. These tests pin the request
 * contract and the result-count claim. The "does it actually reach past row
 * 500" proof is behavioural and lives in
 * scripts/proof/mobile/pipeline-mobile-qa.mjs, which drives a real 375/390/430
 * viewport — a unit test cannot prove a network round trip.
 */

const viewState = (over: Partial<PipelineViewState> = {}): PipelineViewState => ({
  scope: 'active',
  groupBy: 'stage',
  filters: { logic: 'and', clauses: [] },
  sorts: [],
  ...over,
} as PipelineViewState)

describe('the search request reaches the server', () => {
  it('sends the query as `q` so the server evaluates it, not the browser', () => {
    expect(buildPipelineQueryParams(viewState(), 'Frauli')).toEqual({ scope: 'active', q: 'Frauli' })
  })

  it('trims, because a trailing space is not a different search', () => {
    expect(buildPipelineQueryParams(viewState(), '  Frauli  ').q).toBe('Frauli')
  })

  /**
   * An empty `q` must be ABSENT, not blank: `q=` would be a filter the server
   * evaluates, and clearing a search has to produce byte-identical requests to
   * never having searched.
   */
  it('omits q entirely when the box is empty', () => {
    for (const empty of ['', '   ', '\t']) {
      expect(buildPipelineQueryParams(viewState(), empty)).not.toHaveProperty('q')
    }
  })
})

describe('scope and query compose on the server', () => {
  it('always carries the scope alongside the query', () => {
    for (const scope of ['active', 'needs_attention', 'all', 'dead', 'suppressed', 'closed'] as const) {
      const params = buildPipelineQueryParams(viewState({ scope }), 'Frauli')
      expect(params.scope, scope).toBe(scope)
      expect(params.q, scope).toBe('Frauli')
    }
  })

  /**
   * The regression this prevents: clearing search must not reset the operator
   * to Active. Scope lives in view state and the query does not touch it, so
   * the only difference between "searching in Dead" and "cleared in Dead" is
   * the presence of `q`.
   */
  it('clearing the search preserves the scope it ran inside', () => {
    const inDead = viewState({ scope: 'dead' })
    expect(buildPipelineQueryParams(inDead, 'Frauli')).toEqual({ scope: 'dead', q: 'Frauli' })
    expect(buildPipelineQueryParams(inDead, '')).toEqual({ scope: 'dead' })
  })

  it('keeps filters and sorts composed with the query rather than replacing them', () => {
    const state = viewState({
      scope: 'all',
      sorts: [{ field: 'last_activity_at', direction: 'desc', nulls: 'last' }],
      filters: { logic: 'and', clauses: [{ field: 'market', op: 'eq', value: 'Houston' }] },
    } as Partial<PipelineViewState>)
    const params = buildPipelineQueryParams(state, 'Frauli')
    expect(params).toMatchObject({ scope: 'all', q: 'Frauli' })
    expect(params.sorts).toContain('last_activity_at')
    expect(params.filter_json).toContain('Houston')
  })
})

describe('the displayed count describes the right set', () => {
  /**
   * `total` comes back from the same query as the rows, so during a search it
   * is the match count. Presenting a scope count as a search result is the
   * specific §3 violation.
   */
  it('reports matches during a search and the scope otherwise', () => {
    expect(resolvePipelineResultTruth({ loaded: 1, total: 1, searchActive: true }).describes).toBe('matches')
    expect(resolvePipelineResultTruth({ loaded: 264, total: 264, searchActive: false }).describes).toBe('scope')
  })

  it('says nothing about a shortfall when the whole set is loaded', () => {
    for (const total of [1, 156, 264, 348, 476, 500]) {
      const truth = resolvePipelineResultTruth({ loaded: total, total, searchActive: false })
      expect(truth.disclosesShortfall, String(total)).toBe(false)
      expect(truth.shortfall, String(total)).toBe(0)
    }
  })

  /** scope `all`: 768 against a 500 cap. The 268 unloaded must be disclosed. */
  it('discloses the shortfall when the set exceeds one page', () => {
    const truth = resolvePipelineResultTruth({ loaded: 500, total: 768, searchActive: false })
    expect(truth.disclosesShortfall).toBe(true)
    expect(truth.shortfall).toBe(268)
  })

  it('discloses a shortfall for an over-large search result too', () => {
    const truth = resolvePipelineResultTruth({ loaded: 500, total: 640, searchActive: true })
    expect(truth.disclosesShortfall).toBe(true)
    expect(truth.describes).toBe('matches')
    expect(truth.shortfall).toBe(140)
  })

  /** An empty result is not a shortfall — it is an answer. */
  it('does not claim a shortfall for zero matches', () => {
    expect(resolvePipelineResultTruth({ loaded: 0, total: 0, searchActive: true }).disclosesShortfall).toBe(false)
  })
})
