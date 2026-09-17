/**
 * Closing Desk read data-layer.
 *
 * Reads the canonical cockpit endpoints, which read `public.closing_cases` —
 * the real transaction grain (see apps/api/src/app/api/cockpit/closing-desk).
 *
 * FAILURE POLICY (changed): this module used to answer a failed or unreachable
 * read with `degradedFixture()`, which returned SYNTHETIC CLOSINGS carrying
 * invented addresses, prices and blockers, distinguished only by a `mode` flag
 * and a diagnostics string. An operator looking at a board of deals has no way
 * to know they are fake. A failed read now returns `mode: 'error'` with ZERO
 * cases and a stated reason. Fixtures remain reachable ONLY via ?demo=1.
 */
import { callBackend } from '../../lib/api/backendClient'
import type { ClosingDeskModel, ClosingDeskSummary, ClosingDataSource } from './closing-desk.types'
import { projectClosingCaseFromCase, type RawClosingCaseRow } from './closing-projection'
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
  ok?: boolean
  data?: RawClosingCaseRow[] | null
  total?: number
  counts?: { active?: number; terminated?: number; corpus?: number | null }
  error?: string
  message?: string
}

interface SummaryMetric {
  value?: number | null
  source?: string
  note?: string
}

interface SummaryEnvelope {
  ok?: boolean
  data?: Record<string, SummaryMetric> | null
  error?: string
  message?: string
}

/**
 * callBackend reports ok:true for ANY parsed response, including an HTTP 500,
 * and hands back the whole response body as `data`. So the transport-level
 * `ok` proves only that JSON came back — the envelope's own `ok` is the one
 * that says whether the server could answer.
 */
function readEnvelope<T extends { ok?: boolean; error?: string; message?: string }>(
  result: { ok: boolean; data?: unknown; error?: string; message?: string },
): { ok: true; body: T } | { ok: false; reason: string } {
  if (!result.ok) {
    return { ok: false, reason: result.message || result.error || 'transport_failed' }
  }
  const body = result.data as T | undefined
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'The server returned no readable response body.' }
  }
  if (body.ok === false) {
    return { ok: false, reason: body.error || body.message || 'The server reported a failure.' }
  }
  return { ok: true, body }
}

/** Server metric key → client summary key. */
const SUMMARY_KEYS: ReadonlyArray<[string, keyof ClosingDeskSummary]> = [
  ['under_contract', 'underContract'],
  ['closings_this_week', 'closingsThisWeek'],
  ['clear_to_close', 'clearToClose'],
  ['title_blocked', 'titleBlocked'],
  ['seller_action_required', 'sellerActionRequired'],
  ['buyer_action_required', 'buyerActionRequired'],
  ['emd_overdue', 'emdOverdue'],
  ['expected_revenue', 'expectedRevenue'],
  ['confirmed_revenue_this_month', 'confirmedRevenueThisMonth'],
]

/**
 * Only real numbers survive. `Number(null)`, `Number('')` and `Number([])` are
 * all 0, which is exactly how an absent authority turns into a confident zero.
 */
function metricValue(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function projectSummary(raw: Record<string, SummaryMetric>): ClosingDeskSummary {
  const values: Record<string, number | null> = {}
  const sources: Record<string, ClosingDataSource> = {}
  const notes: Record<string, string> = {}

  for (const [serverKey, clientKey] of SUMMARY_KEYS) {
    const metric = raw[serverKey] ?? {}
    const value = metricValue(metric.value)
    // A metric the server calls 'absent' stays null even if a value is present,
    // and a metric with no value is null regardless of what the source says.
    values[clientKey] = metric.source === 'absent' ? null : value
    sources[clientKey] = values[clientKey] === null ? 'absent' : 'closing_cases'
    if (metric.note) notes[clientKey] = metric.note
  }

  return {
    underContract: values.underContract,
    closingsThisWeek: values.closingsThisWeek,
    clearToClose: values.clearToClose,
    titleBlocked: values.titleBlocked,
    sellerActionRequired: values.sellerActionRequired,
    buyerActionRequired: values.buyerActionRequired,
    emdOverdue: values.emdOverdue,
    expectedRevenue: values.expectedRevenue,
    confirmedRevenueThisMonth: values.confirmedRevenueThisMonth,
    metricSources: sources,
    metricNotes: notes,
  }
}

export async function fetchClosingDeskModel(
  options: FetchClosingDeskOptions = {},
): Promise<ClosingDeskModel> {
  if (options.fixture) return buildClosingDeskFixtureModel()

  const search = new URLSearchParams()
  search.set('limit', String(options.limit ?? 200))
  if (options.offset) search.set('offset', String(options.offset))
  if (options.market) search.set('market', options.market)

  // The summary scans the whole table while cases returns a page, so they are
  // requested together and read independently — a summary failure must not
  // blank the board, and a cases failure must not fabricate a summary.
  let casesResult: Awaited<ReturnType<typeof callBackend>>
  let summaryResult: Awaited<ReturnType<typeof callBackend>> | null = null
  try {
    ;[casesResult, summaryResult] = await Promise.all([
      callBackend(`${BASE}/cases?${search.toString()}`, { signal: options.signal }),
      callBackend(`${BASE}/summary`, { signal: options.signal }).catch(() => null),
    ])
  } catch (err) {
    return errorModel(
      `Closing Desk is unreachable (${err instanceof Error ? err.message : 'network error'}).`,
    )
  }

  const cases = readEnvelope<CasesEnvelope>(casesResult)
  if (!cases.ok) {
    return errorModel(`Closing cases could not be read: ${cases.reason}`)
  }

  const summary = summaryResult ? readEnvelope<SummaryEnvelope>(summaryResult) : null
  const summaryModel =
    summary?.ok && summary.body.data
      ? projectSummary(summary.body.data)
      : null

  const rows = Array.isArray(cases.body.data) ? cases.body.data : []
  const projected = rows.map(projectClosingCaseFromCase)

  const diagnostics: string[] = []
  if (!summaryModel) {
    diagnostics.push(
      `Portfolio metrics are unavailable (${summary && !summary.ok ? summary.reason : 'the summary endpoint did not respond'}). Case rows below are unaffected.`,
    )
  }

  const terminated = cases.body.counts?.terminated ?? 0
  if (terminated > 0) {
    diagnostics.push(
      `${terminated} terminated case${terminated === 1 ? '' : 's'} (cancelled, declined, or voided) ${terminated === 1 ? 'is' : 'are'} preserved as history and excluded from active work.`,
    )
  }

  if (projected.length === 0) {
    diagnostics.push('No deals are currently in the closing lifecycle (Stages 6–10).')
  }

  const degraded = [...new Set(projected.flatMap((c) => c.provenance.degraded))]

  return {
    mode: 'live',
    summary:
      summaryModel ??
      ({
        underContract: null,
        closingsThisWeek: null,
        clearToClose: null,
        titleBlocked: null,
        sellerActionRequired: null,
        buyerActionRequired: null,
        emdOverdue: null,
        expectedRevenue: null,
        confirmedRevenueThisMonth: null,
        metricSources: Object.fromEntries(SUMMARY_KEYS.map(([, k]) => [k, 'absent' as ClosingDataSource])),
        metricNotes: {},
      } satisfies ClosingDeskSummary),
    cases: projected,
    total: cases.body.total ?? projected.length,
    provenance: {
      fullyBacked: degraded.length === 0 && summaryModel !== null,
      fields: { source: 'closing_cases' },
      degraded,
    },
    diagnostics,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * A read failure. No cases, no fabricated metrics, and a stated reason — the
 * operator is told the desk is blind rather than shown an empty or fake desk.
 */
function errorModel(reason: string): ClosingDeskModel {
  return {
    mode: 'error',
    summary: {
      underContract: null,
      closingsThisWeek: null,
      clearToClose: null,
      titleBlocked: null,
      sellerActionRequired: null,
      buyerActionRequired: null,
      emdOverdue: null,
      expectedRevenue: null,
      confirmedRevenueThisMonth: null,
      metricSources: Object.fromEntries(SUMMARY_KEYS.map(([, k]) => [k, 'absent' as ClosingDataSource])),
      metricNotes: Object.fromEntries(SUMMARY_KEYS.map(([, k]) => [k, reason])),
    },
    cases: [],
    total: 0,
    provenance: { fullyBacked: false, fields: {}, degraded: [reason] },
    diagnostics: [reason],
    generatedAt: new Date().toISOString(),
  }
}
