import type { PipelineViewState } from './pipeline-card-design.types'

/**
 * The request the board sends for a scope + search.
 *
 * Extracted from usePipelineOpportunities so the composition contract is
 * testable without rendering: the server evaluates scope AND query together,
 * which is what makes search corpus-wide instead of "load the first 500, then
 * filter in the browser".
 *
 * `q` is omitted entirely when empty rather than sent blank, so clearing a
 * search is the same request as never having searched — and `scope` is
 * untouched either way, which is why clearing returns the operator to the
 * scope they were in rather than resetting them to Active.
 */
export function buildPipelineQueryParams(
  viewState: Pick<PipelineViewState, 'scope' | 'filters' | 'sorts'>,
  query: string,
): Record<string, string> {
  const params: Record<string, string> = { scope: viewState.scope }
  if (viewState.filters.clauses.length > 0) params.filter_json = JSON.stringify(viewState.filters)
  if (viewState.sorts.length > 0) params.sorts = JSON.stringify(viewState.sorts)
  const trimmed = query.trim()
  if (trimmed) params.q = trimmed
  return params
}

/**
 * What the board may truthfully say about a result set.
 *
 * `total` is the server's exact count for scope AND query, so during a search
 * it is the MATCH count, not the scope count — displaying the latter as the
 * former is the specific defect this guards. When matches exceed one page the
 * shortfall must be disclosed rather than letting the page read as the whole
 * result.
 */
export function resolvePipelineResultTruth(input: {
  loaded: number
  total: number
  searchActive: boolean
}): { disclosesShortfall: boolean; describes: 'matches' | 'scope'; shortfall: number } {
  const shortfall = Math.max(0, input.total - input.loaded)
  return {
    disclosesShortfall: input.loaded > 0 && input.loaded < input.total,
    describes: input.searchActive ? 'matches' : 'scope',
    shortfall,
  }
}
