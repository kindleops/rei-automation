/**
 * ONE SHARED, RESUMABLE RE-PROJECTION OF THE CAMPAIGN AUDIENCE (campaign_target_graph).
 *
 * The graph's person columns (prospect_id, demographics, age bucket, names, person
 * flags), property columns (building condition, beds, year built, loan balance…)
 * and canonical scores are derived from seller.owner / public.prospects /
 * public.properties / property_acquisition_scores by SQL in
 * PROPOSED_20261007180000_ctg_person_property_reprojection.sql. This module is the
 * driver loop the operator script runs off-peak: keyset by graph_id, small batches,
 * a pause after every batch (never more than ~50% duty cycle), a durable cursor so
 * any stop resumes exactly where it was, and the same advisory lock and load
 * shedding as the nightly reconcile / daytime incremental jobs (the SQL returns
 * `skipped: locked|busy` and the SAME cursor; the loop simply waits and retries).
 *
 * Column sets are parameters, so one backfill serves every under-projected column
 * family instead of one job per family:
 *   person   prospect_id, canonical_prospect_id, seller names, language, gender,
 *            marital_status, education_model, occupation_group, income,
 *            net_asset_value, buying_power, age_bucket, matching_flags_text
 *   property units_count, building_condition, building_quality, rehab_level,
 *            property_flags_text, beds, baths, building_sqft, year_built, lot_sqft,
 *            total_loan_balance, ownership_years, tax_delinquent_year,
 *            estimated_repair_cost
 *   scores   aos_score, decision_tier, acquisition_confidence,
 *            transaction_probability_365, best_strategy, scores_computed_at
 *   contact  the full enrich (phone type, outreach recency, suppression,
 *            eligibility) — implies the three above; heavier, night window only.
 * A row is written only when a requested column actually changes, so a rerun over
 * finished ranges is read-only.
 *
 * Every dependency is injected (call, sleep, now, saveState) — no network in tests.
 */

export const REPROJECTION_SETS = Object.freeze(['person', 'property', 'scores', 'contact'])
export const DEFAULT_REPROJECTION_SETS = Object.freeze(['person', 'property', 'scores'])

/** UTC minutes-of-day windows the backfill refuses to run in (heavy-read hours). */
export const DEFAULT_BLOCKED_UTC_WINDOWS = Object.freeze([{ from: 9 * 60 + 15, to: 12 * 60 }])

const RETRYABLE_SQLSTATES = new Set(['55P03', '57014', '40001', '40P01'])

export function normalizeReprojectionSets(value = DEFAULT_REPROJECTION_SETS) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',')
  const sets = [...new Set(raw.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))]
  if (!sets.length) throw new Error('reprojection: at least one column set is required')
  const unknown = sets.filter((set) => !REPROJECTION_SETS.includes(set))
  if (unknown.length) throw new Error(`reprojection: unknown column set(s) ${unknown.join(', ')} (allowed: ${REPROJECTION_SETS.join(', ')})`)
  return sets
}

export function inBlockedWindow(date, windows = DEFAULT_BLOCKED_UTC_WINDOWS) {
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  return windows.some((window) => minute >= window.from && minute < window.to)
}

/** Rough duration for planning: batches × (work + pause). */
export function estimateReprojectionMinutes({ rows, batchSize = 400, workMs = 1200, pauseMs = 1500 } = {}) {
  const batches = Math.ceil(Math.max(0, Number(rows) || 0) / Math.max(1, batchSize))
  return { batches, minutes: Math.round((batches * (workMs + Math.max(pauseMs, workMs))) / 60000) }
}

/**
 * Run (or resume) the re-projection.
 *   call({ after, limit, sets, market }) -> { rows_scanned, rows_updated, next_after_graph_id, has_more, skipped, elapsed_ms }
 *   state  { after, sets, rows_scanned, rows_updated, batches, done } (from saveState / a cursor file)
 * Returns the final state plus `stop_reason`.
 */
export async function runGraphReprojection({
  call,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date(),
  saveState = async () => {},
  log = () => {},
  shouldStop = () => false,
  state = null,
  sets = DEFAULT_REPROJECTION_SETS,
  market = null,
  batchSize = 400,
  minBatchSize = 50,
  pauseMs = 1500,
  maxMinutes = 120,
  maxBatches = Infinity,
  maxConsecutiveSkips = 40,
  maxRetries = 5,
  blockedWindows = DEFAULT_BLOCKED_UTC_WINDOWS,
} = {}) {
  if (typeof call !== 'function') throw new Error('reprojection: call is required')
  const wanted = normalizeReprojectionSets(sets)
  const resumed = state && !state.done ? state : null
  if (resumed && JSON.stringify(normalizeReprojectionSets(resumed.sets || wanted)) !== JSON.stringify(wanted)) {
    throw new Error(`reprojection: saved cursor is for sets ${resumed.sets}, not ${wanted.join(',')} — start fresh or pass the same sets`)
  }
  const current = {
    after: resumed?.after ?? null,
    sets: wanted,
    market: market || null,
    rows_scanned: Number(resumed?.rows_scanned || 0),
    rows_updated: Number(resumed?.rows_updated || 0),
    batches: Number(resumed?.batches || 0),
    skips: Number(resumed?.skips || 0),
    done: false,
    started_at: resumed?.started_at || now().toISOString(),
  }
  const deadline = now().getTime() + Math.max(1, maxMinutes) * 60000
  let limit = Math.max(minBatchSize, Math.min(1000, batchSize))
  let consecutiveSkips = 0
  let retries = 0
  let ran = 0

  const stop = async (reason) => {
    current.updated_at = now().toISOString()
    await saveState({ ...current })
    log({ event: 'stop', reason, ...current })
    return { ...current, stop_reason: reason }
  }

  while (true) {
    if (shouldStop()) return stop('operator_stop')
    if (inBlockedWindow(now(), blockedWindows)) return stop('blocked_window')
    if (now().getTime() >= deadline) return stop('max_minutes')
    if (ran >= maxBatches) return stop('max_batches')

    let result
    try {
      result = await call({ after: current.after, limit, sets: wanted, market: current.market })
    } catch (error) {
      const code = String(error?.code || '')
      if (RETRYABLE_SQLSTATES.has(code) && retries < maxRetries) {
        retries += 1
        limit = Math.max(minBatchSize, Math.floor(limit / 2))
        log({ event: 'retry', code, limit, retries })
        await sleep(pauseMs * 2 * retries)
        continue
      }
      await stop(`error:${code || 'unknown'}`)
      throw error
    }
    retries = 0

    if (result?.skipped) {
      consecutiveSkips += 1
      current.skips += 1
      if (consecutiveSkips >= maxConsecutiveSkips) return stop(`skipped:${result.skipped}`)
      await sleep(pauseMs * 4)
      continue
    }
    consecutiveSkips = 0
    ran += 1
    current.batches += 1
    current.rows_scanned += Number(result?.rows_scanned || 0)
    current.rows_updated += Number(result?.rows_updated || 0)
    current.after = result?.next_after_graph_id ?? current.after
    if (!result?.has_more) {
      current.done = true
      current.finished_at = now().toISOString()
      return stop('done')
    }
    current.updated_at = now().toISOString()
    await saveState({ ...current })
    if (current.batches % 25 === 0) log({ event: 'progress', ...current, limit })
    // Duty cycle ≤ 50%: never pause less than the batch took.
    await sleep(Math.max(pauseMs, Number(result?.elapsed_ms || 0)))
  }
}
