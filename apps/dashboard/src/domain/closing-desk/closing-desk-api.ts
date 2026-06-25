/**
 * Closing Desk read data-layer.
 *
 * Calls the canonical cockpit endpoint (which reads Supabase
 * acquisition_opportunities — see apps/api/src/app/api/cockpit/closing-desk),
 * projects rows into ClosingCase aggregates, and computes the header summary.
 *
 * DEGRADED BEHAVIOR: on transport failure or when live data is unavailable, it
 * returns a fixture model that is UNMISTAKABLY flagged `mode: 'fixture'` with
 * diagnostics. It never silently substitutes mock data for live data.
 */
import { callBackend } from '../../lib/api/backendClient'
import type { ClosingDeskModel } from './closing-desk.types'
import { projectClosingCase, type RawOpportunityRow } from './closing-projection'
import { computeClosingSummary } from './closing-summary'
import { buildClosingDeskFixtureModel } from './closing-fixtures'

const BASE = '/api/cockpit/closing-desk'

export interface FetchClosingDeskOptions {
  /** Force fixtures (Storybook/demo). Live is the default. */
  fixture?: boolean
  limit?: number
  offset?: number
  market?: string
  signal?: AbortSignal
}

interface CasesEnvelope {
  ok: boolean
  data?: RawOpportunityRow[]
  total?: number
  error?: string
  message?: string
}

export async function fetchClosingDeskModel(
  options: FetchClosingDeskOptions = {},
): Promise<ClosingDeskModel> {
  if (options.fixture) return buildClosingDeskFixtureModel()

  const search = new URLSearchParams()
  search.set('limit', String(options.limit ?? 200))
  if (options.offset) search.set('offset', String(options.offset))
  if (options.market) search.set('market', options.market)

  let envelope: CasesEnvelope
  try {
    const result = await callBackend(`${BASE}/cases?${search.toString()}`, { signal: options.signal })
    if (!result.ok) {
      return degradedFixture(`Closing Desk API returned an error: ${result.message || result.error || 'unknown'}`)
    }
    envelope = result.data as CasesEnvelope
  } catch (err) {
    return degradedFixture(
      `Closing Desk API is unreachable (${err instanceof Error ? err.message : 'network error'}).`,
    )
  }

  const rows = Array.isArray(envelope?.data) ? envelope.data : []
  if (rows.length === 0) {
    // Genuinely empty live result — NOT a fixture. Render an honest empty state.
    return {
      mode: 'live',
      summary: computeClosingSummary([]),
      cases: [],
      total: envelope?.total ?? 0,
      provenance: { fullyBacked: false, fields: {}, degraded: [] },
      diagnostics: ['No deals are currently in the closing lifecycle (Stages 6–10).'],
      generatedAt: new Date().toISOString(),
    }
  }

  const cases = rows.map(projectClosingCase)
  return {
    mode: 'live',
    summary: computeClosingSummary(cases),
    cases,
    total: envelope.total ?? cases.length,
    provenance: {
      fullyBacked: false,
      fields: { source: 'acquisition_opportunities' },
      degraded: [
        'Live data is sourced from Supabase acquisition_opportunities only. Deep title/escrow/disposition/funding/revenue state is pending the Podio → Supabase projection (see AUDIT.md).',
      ],
    },
    diagnostics: [],
    generatedAt: new Date().toISOString(),
  }
}

function degradedFixture(reason: string): ClosingDeskModel {
  const model = buildClosingDeskFixtureModel()
  return {
    ...model,
    diagnostics: [reason, ...model.diagnostics],
  }
}
