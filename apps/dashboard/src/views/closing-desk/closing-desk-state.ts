import type { ClosingDeskModel } from '../../domain/closing-desk/closing-desk.types'
import { resolveRenderableCases } from './closing-desk-utils'

export type { ClosingCase } from '../../domain/closing-desk/closing-desk.types'
export { resolveRenderableCases, resolveDisplaySummary, groupCasesByLane } from './closing-desk-utils'

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

  const renderable = resolveRenderableCases(model.cases, { fixtureQuery: false, modelMode: model.mode })
  if (renderable.length > 0) return 'live'

  const hasProjectionGap =
    model.mode !== 'live' ||
    (model.provenance.degraded?.length ?? 0) > 0 ||
    model.diagnostics.some((d) => PROJECTION_MARKERS.test(d))

  if (hasProjectionGap) return 'degraded'
  return 'zero'
}

/** @deprecated Use resolveRenderableCases */
export function casesForDisplay<T extends { identity: { closingCaseId: string } }>(
  cases: T[],
  model: ClosingDeskModel | null,
  fixtureQuery: boolean,
): T[] {
  return resolveRenderableCases(cases as never, {
    fixtureQuery,
    modelMode: model?.mode ?? null,
  }) as unknown as T[]
}