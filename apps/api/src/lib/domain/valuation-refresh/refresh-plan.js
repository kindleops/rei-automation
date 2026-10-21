// ─── VALUATION REFRESH PLAN (8.5.21-b, owner decision 2026-10-16 (1)) ─────────
// "Re-running valuations: YES … build a bounded refresh PLAN with estimated DB writes, processing cost
// and external research usage. Production valuation writes need separate approval."
//
// buildValuationRefreshPlan(dryRunResults, measurements) turns a DRY RUN (dry-run.js, the existing
// engine entry point, nothing written) into a phased, bounded plan:
//   phase 1  actionable now        active negotiations, offer requests, motivated plausible asks
//   phase 2  historical candidates recoverable conversations (recovery linkage)
//   phase 3  remaining live        INVESTIGATE / missing financials
// Per phase: properties, engine runs that WOULD write (a reused current row writes nothing), estimated
// rows + bytes (property_acquisition_scores upsert + acquisition_score_snapshots insert, measured
// average row sizes), processing time (measured median ms per property, serial), external research
// (the engine is internal-data only: 0 paid calls, $0) and the dry run's predicted outcome (tiers,
// offer-ready gained). Batches are bounded (≤ batch_size properties per approved run).
// Pure: no I/O. Applying any phase is a separate owner approval (VALUATION_REFRESH_WRITE_ENABLED stays off).
export const REFRESH_PLAN_VERSION = 'valuation-refresh-plan.v1'
export const REFRESH_PHASES = Object.freeze([
  Object.freeze({ phase: 1, name: 'actionable_now', classes: Object.freeze(['active_negotiation', 'offer_request', 'motivated_plausible_ask']) }),
  Object.freeze({ phase: 2, name: 'historical_candidates', classes: Object.freeze(['recoverable_conversation']) }),
  Object.freeze({ phase: 3, name: 'remaining_live_missing_financials', classes: Object.freeze(['investigate_missing_financials']) }),
])

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }

/**
 * @param {Array<{ ref, class, ok, ran, ms, before:{present,offer_ready}, after:{present,offer_ready,tier} }>} results  dry-run rows
 * @param {{ score_row_bytes:number, snapshot_row_bytes:number, median_ms?:number|null, batch_size?:number, measured_at?:string }} m
 */
export function buildValuationRefreshPlan(results = [], { score_row_bytes, snapshot_row_bytes, median_ms = null, batch_size = 50, measured_at = null } = {}) {
  const ms = num(median_ms) ?? (results.length ? results.map((r) => num(r.ms) || 0).sort((a, b) => a - b)[Math.floor(results.length / 2)] : 0)
  const phases = REFRESH_PHASES.map((p) => {
    const rows = results.filter((r) => p.classes.includes(r.class))
    const writing = rows.filter((r) => r.ok && r.ran)
    const tiers = {}
    for (const r of writing) tiers[r.after?.tier || 'none'] = (tiers[r.after?.tier || 'none'] || 0) + 1
    const bytes = writing.length * ((num(score_row_bytes) || 0) + (num(snapshot_row_bytes) || 0))
    return {
      phase: p.phase, name: p.name, classes: p.classes,
      properties: rows.length,
      engine_runs_that_write: writing.length,
      reused_current_no_write: rows.filter((r) => r.ok && r.ran === false).length,
      failed_in_dry_run: rows.filter((r) => !r.ok).length,
      batches: Math.ceil(writing.length / batch_size),
      estimated_db_writes: { property_acquisition_scores_upserts: writing.length, acquisition_score_snapshots_inserts: writing.length, rows: writing.length * 2, bytes, megabytes: Math.round((bytes / 1_048_576) * 10) / 10 },
      estimated_processing: { median_ms_per_property: ms, serial_minutes: Math.round(((writing.length * ms) / 60_000) * 10) / 10 },
      external_research: { paid_calls: 0, usd: 0, note: 'the Decision Engine reads internal tables only (comps, buyer purchases, property record)' },
      predicted_outcome: { valued_after: rows.filter((r) => r.after?.present).length, newly_valued: rows.filter((r) => r.after?.present && !r.before?.present).length, offer_ready_after: rows.filter((r) => r.after?.offer_ready).length, offer_ready_gained: rows.filter((r) => r.after?.offer_ready && !r.before?.offer_ready).length, tiers_after: tiers },
      refs: writing.map((r) => r.ref),
    }
  })
  const sum = (k) => phases.reduce((a, p) => a + (typeof k === 'function' ? k(p) : p[k]), 0)
  return {
    version: REFRESH_PLAN_VERSION,
    status: 'PROPOSED_NOT_APPROVED',
    write_flag: 'VALUATION_REFRESH_WRITE_ENABLED (off)',
    measured_at,
    measurements: { score_row_bytes, snapshot_row_bytes, median_ms_per_property: ms, batch_size },
    totals: {
      properties: sum('properties'),
      engine_runs_that_write: sum('engine_runs_that_write'),
      rows: sum((p) => p.estimated_db_writes.rows),
      megabytes: Math.round(sum((p) => p.estimated_db_writes.megabytes) * 10) / 10,
      serial_minutes: Math.round(sum((p) => p.estimated_processing.serial_minutes) * 10) / 10,
      paid_external_calls: 0,
      usd: 0,
      offer_ready_gained: sum((p) => p.predicted_outcome.offer_ready_gained),
    },
    phases,
  }
}
