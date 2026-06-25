import type { ClosingDeskModel } from '../../domain/closing-desk/closing-desk.types'

export type ClosingDeskSurfaceState = 'loading' | 'error' | 'demo' | 'zero' | 'degraded' | 'live'

const PROJECTION_MARKERS = /projection|podio|unreachable|api|incomplete|pending/i

export function resolveClosingDeskSurfaceState(
  model: ClosingDeskModel | null,
  opts: { fixtureQuery: boolean; loading: boolean; error: string | null },
): ClosingDeskSurfaceState {
  if (opts.loading) return 'loading'
  if (opts.error) return 'error'
  if (opts.fixtureQuery) return 'demo'
  if (!model) return 'degraded'

  const hasProjectionGap =
    (model.provenance.degraded?.length ?? 0) > 0 ||
    model.diagnostics.some((d) => PROJECTION_MARKERS.test(d))

  if (model.cases.length > 0) return 'live'
  if (model.mode !== 'live') return 'degraded'
  if (hasProjectionGap) return 'degraded'
  return 'zero'
}

/** Live routes must never render fixture-backed rows unless ?demo=1 is set. */
export function casesForDisplay<T extends { identity: { closingCaseId: string } }>(
  cases: T[],
  model: ClosingDeskModel | null,
  fixtureQuery: boolean,
): T[] {
  if (fixtureQuery) return cases
  if (!model || model.mode !== 'live') return []
  return cases
}