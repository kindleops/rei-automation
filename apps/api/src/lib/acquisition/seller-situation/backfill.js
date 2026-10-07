// ─── seller-situation/backfill.js ───────────────────────────────────────────
// Nationwide seller_situation_v2 scoring run (§8–9). Policy only; every side
// effect goes through an injected `store` (see backfillStore.js), so this is
// unit-tested with no network.
//
// Reuses the canonical backfill's guards (lib/acquisition/scoringBackfill.js):
// sending-window pause, DB load probe, exponential backoff, transient-error
// classification and max-rate pacing. Differences, all deliberate:
//   * BATCHED: one raw-facts load (2 keyed queries) and ONE upsert per chunk,
//     never one request per property.
//   * MARKET ORDERED: phases = active campaign markets first (frozen into the
//     state at start so a resume never reorders), then `nationwide` (every
//     other property, including market = null).
//   * Resumable cursor per phase; a crash loses at most one chunk of
//     idempotent work. Never restarts from zero unless --fresh.
//   * Failed ids are logged separately (store.logFailures), not just counted.
//   * Measures ms/property, row bytes/property and table growth.
//   * dryRun = compute everything, write NOTHING (no score, no state, no log).

import {
  DEFAULT_CONFIG as CANONICAL_DEFAULTS,
  insideSendingWindow,
  evaluateLoad,
  computeBackoffMs,
  isTransientError,
  paceDelayMs,
} from '../scoringBackfill.js';
import { scoreSellerSituation, SCORE_VERSION, INPUT_MODEL_VERSION, WEIGHTS_VERSION } from './model.js';
import { encodeSellerSituationRow, rowBytes } from './codec.js';

export const STATE_KEY = 'seller_situation_scoring_backfill';
export const RUN_VERSION = `${SCORE_VERSION}/${INPUT_MODEL_VERSION}/${WEIGHTS_VERSION}`;
/** Always-first markets (owner brief §8); live campaign markets are added at start. */
export const BASELINE_ACTIVE_MARKETS = Object.freeze(['Dallas, TX', 'Houston, TX', 'Minneapolis, MN', 'Tampa, FL']);

export const STATUS = Object.freeze({ STOPPED: 'stopped', RUNNING: 'running', PAUSED: 'paused', COMPLETED: 'completed' });

export const DEFAULT_CONFIG = Object.freeze({
  ...CANONICAL_DEFAULTS,
  batch_size: 200, // ids per keyset page = per raw-facts load = per upsert
  sleep_between_chunks_ms: 2_000,
  max_per_minute: 3_000, // ≈ 15 chunks/min ceiling; the engine-free scorer is ~2 ms/property
  tick_budget_ms: 240_000,
  rescore_existing: false,
});

function clean(v) { return String(v ?? '').trim(); }
function toInt(v, d, lo, hi) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : d; }

export function resolveConfig(o = {}) {
  const x = o && typeof o === 'object' ? o : {};
  return {
    ...DEFAULT_CONFIG,
    ...x,
    batch_size: toInt(x.batch_size, DEFAULT_CONFIG.batch_size, 1, 500),
    sleep_between_chunks_ms: toInt(x.sleep_between_chunks_ms, DEFAULT_CONFIG.sleep_between_chunks_ms, 0, 600_000),
    max_per_minute: toInt(x.max_per_minute, DEFAULT_CONFIG.max_per_minute, 1, 20_000),
    tick_budget_ms: toInt(x.tick_budget_ms, DEFAULT_CONFIG.tick_budget_ms, 1_000, 3_600_000),
    rescore_existing: x.rescore_existing === true,
    respect_contact_window: x.respect_contact_window !== false,
  };
}

/** Phases: each active market in order, then everything else. */
export function buildPhases(activeMarkets = []) {
  const seen = new Set();
  const markets = [...BASELINE_ACTIVE_MARKETS, ...activeMarkets].map(clean).filter((m) => m && !seen.has(m) && seen.add(m));
  return [...markets.map((market) => ({ kind: 'market', market })), { kind: 'nationwide', exclude_markets: markets }];
}

export function initialState(now = new Date()) {
  return {
    status: STATUS.STOPPED,
    run_version: RUN_VERSION,
    run_id: null,
    phases: null,
    phase_index: 0,
    cursor_property_id: null,
    started_at: null,
    completed_at: null,
    updated_at: now.toISOString(),
    totals: { scored: 0, skipped_existing: 0, failed: 0, transient_failed: 0, row_bytes: 0 },
    backoff: { until: null, reason: null, consecutive: 0 },
    table_bytes_at_start: null,
    last_tick: null,
    recent_failures: [],
    config: {},
  };
}

export function parseState(raw, now = new Date()) {
  if (!raw) return initialState(now);
  let p = raw;
  if (typeof raw === 'string') {
    try { p = JSON.parse(raw); } catch { return { ...initialState(now), status: STATUS.PAUSED, parse_error: true }; }
  }
  const base = initialState(now);
  return {
    ...base,
    ...p,
    totals: { ...base.totals, ...(p.totals || {}) },
    backoff: { ...base.backoff, ...(p.backoff || {}) },
    recent_failures: Array.isArray(p.recent_failures) ? p.recent_failures.slice(0, 25) : [],
  };
}

/** Start or resume. A new run_version (model change) never resumes an old cursor. */
export function applyStart(state, { now = new Date(), runId, activeMarkets = [], config = {}, fresh = false, tableBytes = null } = {}) {
  const resume = !fresh && state.run_version === RUN_VERSION && state.status !== STATUS.COMPLETED && Array.isArray(state.phases);
  return {
    ...state,
    status: STATUS.RUNNING,
    run_version: RUN_VERSION,
    run_id: resume && state.run_id ? state.run_id : runId,
    phases: resume ? state.phases : buildPhases(activeMarkets),
    phase_index: resume ? state.phase_index : 0,
    cursor_property_id: resume ? state.cursor_property_id : null,
    started_at: resume && state.started_at ? state.started_at : now.toISOString(),
    totals: resume ? state.totals : initialState(now).totals,
    table_bytes_at_start: resume ? state.table_bytes_at_start : tableBytes,
    completed_at: null,
    backoff: { until: null, reason: null, consecutive: 0 },
    config: { ...(state.config || {}), ...config },
    updated_at: now.toISOString(),
  };
}

export function applyPause(state, { now = new Date(), reason = 'operator_pause' } = {}) {
  return { ...state, status: STATUS.PAUSED, paused_reason: reason, updated_at: now.toISOString() };
}

/** Skip a property already scored under this exact run version on the same feature snapshot. */
export function shouldSkipExisting(existing, features_as_of, config = DEFAULT_CONFIG) {
  if (!existing || config.rescore_existing) return false;
  const same = clean(existing.score_version) === SCORE_VERSION
    && clean(existing.input_model_version) === INPUT_MODEL_VERSION
    && clean(existing.weights_version) === WEIGHTS_VERSION;
  if (!same) return false;
  return clean(existing.features_as_of).slice(0, 10) === clean(features_as_of).slice(0, 10);
}

export async function checkGates({ store, config, now, ignoreWindow = false }) {
  if (config.respect_contact_window && !ignoreWindow) {
    const w = insideSendingWindow({ now, window: await store.readContactWindow(), config });
    if (w.inside) return { gate: 'sending_window', reason: `inside_contact_window:${w.zones.join('|')}`, backoff: false };
  }
  const load = evaluateLoad(await store.probeLoad(), config);
  if (!load.ok) return { gate: 'db_load', reason: load.reason, backoff: true };
  return null;
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/**
 * One tick: chunks until budget / rate / gate / end of the universe.
 * Score-and-write is per CHUNK: loadRawFacts(ids) → score in memory → upsertRows(rows).
 */
export async function runTick({
  store,
  dryRun = false,
  maxProperties = null,
  ignoreWindow = false,
  configOverrides = null,
  dryRunPhases = null,
  ignoreLoadInDryRun = false,
  clock = () => new Date(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const started = clock();
  let state = parseState(await store.readState(), started);
  if (dryRun) {
    // A dry run never touches the persisted cursor: it walks its own phases from the top.
    state = { ...initialState(started), status: STATUS.RUNNING, phases: dryRunPhases ?? state.phases ?? buildPhases(await store.loadActiveMarkets()) };
  }
  const config = resolveConfig({ ...(state.config || {}), ...(configOverrides || {}) });
  const summary = {
    ok: true, dry_run: dryRun, run_version: RUN_VERSION, started_at: started.toISOString(), status_before: state.status,
    stopped_because: null, chunks: 0, scored: 0, skipped_existing: 0, failed: 0, transient_failed: 0,
    ms_per_chunk: [], load_ms_per_chunk: [], write_ms_per_chunk: [], row_bytes: [], tiers: {}, situations: {}, phases_visited: [],
    sample_rows: [], gate: null,
  };
  if (!dryRun && state.status !== STATUS.RUNNING) { summary.stopped_because = `status_${state.status}`; return summary; }
  if (!dryRun && state.backoff?.until && new Date(state.backoff.until) > started) {
    summary.stopped_because = 'backoff_active'; summary.gate = { reason: state.backoff.reason, until: state.backoff.until }; return summary;
  }
  const save = async (next) => { state = { ...next, updated_at: clock().toISOString() }; if (!dryRun) await store.writeState(state); };
  const armBackoff = async (reason) => {
    const consecutive = (state.backoff?.consecutive || 0) + 1;
    const until = new Date(clock().valueOf() + computeBackoffMs(consecutive - 1, config)).toISOString();
    await save({ ...state, backoff: { until, reason, consecutive } });
    summary.gate = { reason, until };
  };

  const deadline = started.valueOf() + config.tick_budget_ms;
  const cap = maxProperties ?? Number.POSITIVE_INFINITY;
  let processed = 0;

  while (true) {
    const phase = state.phases?.[state.phase_index];
    if (!phase) {
      if (!dryRun) await save({ ...state, status: STATUS.COMPLETED, completed_at: clock().toISOString() });
      summary.stopped_because = 'universe_exhausted';
      break;
    }
    if (!summary.phases_visited.includes(phase.market ?? phase.kind)) summary.phases_visited.push(phase.market ?? phase.kind);
    if (processed >= cap) { summary.stopped_because = 'max_properties'; break; }
    const wait = paceDelayMs({ processed, startedMs: started.valueOf(), nowMs: clock().valueOf(), maxPerMinute: config.max_per_minute });
    if (wait > 0) {
      if (clock().valueOf() + wait >= deadline) { summary.stopped_because = 'rate_ceiling'; break; }
      if (!dryRun) await sleep(wait);
    }
    const now = clock();
    if (now.valueOf() >= deadline) { summary.stopped_because = 'tick_budget'; break; }
    const gate = await checkGates({ store, config, now, ignoreWindow: ignoreWindow || dryRun });
    if (gate && dryRun && ignoreLoadInDryRun && gate.gate === 'db_load') {
      // Read-only measurement may proceed past a busy-DB gate; the verdict is recorded, never ignored silently.
      summary.gates_observed = [...(summary.gates_observed || []), gate.reason].slice(-10);
    } else if (gate) {
      summary.stopped_because = gate.gate; summary.gate = { reason: gate.reason };
      if (gate.backoff && !dryRun) await armBackoff(gate.reason);
      break;
    }

    const limit = Math.min(config.batch_size, cap - processed);
    const ids = await store.loadPropertyPage({ phase, afterPropertyId: state.cursor_property_id, limit });
    if (!ids.length) {
      await save({ ...state, phase_index: state.phase_index + 1, cursor_property_id: null });
      continue;
    }
    const c0 = Date.now();
    let facts;
    let existing;
    try {
      [facts, existing] = await Promise.all([store.loadRawFacts(ids), store.loadExisting(ids)]);
    } catch (error) {
      const msg = clean(error?.message) || 'load_failed';
      summary.transient_failed += ids.length;
      await save({ ...state, recent_failures: [{ property_id: ids[0], error: msg, transient: isTransientError(msg), chunk: ids.length }, ...state.recent_failures].slice(0, 25) });
      if (!dryRun) await armBackoff(`load_failed:${isTransientError(msg) ? 'transient' : 'error'}`);
      summary.stopped_because = 'load_failed';
      break;
    }
    const loadMs = Date.now() - c0;
    const existingById = new Map((existing || []).map((r) => [clean(r.property_id), r]));
    const rows = [];
    const failed = [];
    let skipped = 0;
    for (const id of ids) {
      const rf = facts.get(id);
      if (!rf) { failed.push({ property_id: id, error: 'no_source_rows', transient: false }); continue; }
      if (shouldSkipExisting(existingById.get(id), rf.facts?.as_of_date, config)) { skipped += 1; continue; }
      try {
        const result = scoreSellerSituation(rf, { now });
        const row = encodeSellerSituationRow(result, { runId: state.run_id, featuresAsOf: rf.facts?.as_of_date ? clean(rf.facts.as_of_date).slice(0, 10) : null });
        rows.push(row);
        const b = rowBytes(row);
        summary.row_bytes.push(b);
        summary.tiers[row.opportunity_tier] = (summary.tiers[row.opportunity_tier] || 0) + 1;
        summary.situations[row.seller_situation] = (summary.situations[row.seller_situation] || 0) + 1;
        if (summary.sample_rows.length < 3) summary.sample_rows.push(row);
      } catch (error) {
        failed.push({ property_id: id, error: clean(error?.message) || 'score_threw', transient: false });
      }
    }
    const w0 = Date.now();
    if (rows.length && !dryRun) {
      try {
        await store.upsertRows(rows);
      } catch (error) {
        const msg = clean(error?.message) || 'upsert_failed';
        summary.transient_failed += rows.length;
        await save({ ...state, recent_failures: [{ property_id: rows[0].property_id, error: msg, transient: isTransientError(msg), chunk: rows.length }, ...state.recent_failures].slice(0, 25) });
        await armBackoff(`upsert_failed:${isTransientError(msg) ? 'transient' : 'error'}`);
        summary.stopped_because = 'upsert_failed';
        break; // cursor NOT advanced: the same chunk is retried after backoff (upsert is idempotent)
      }
    }
    const writeMs = Date.now() - w0;
    if (failed.length && !dryRun) await store.logFailures(failed.map((f) => ({ ...f, run_id: state.run_id, run_version: RUN_VERSION })));
    summary.chunks += 1;
    summary.scored += rows.length;
    summary.skipped_existing += skipped;
    summary.failed += failed.length;
    summary.ms_per_chunk.push(Date.now() - c0);
    summary.load_ms_per_chunk.push(loadMs);
    summary.write_ms_per_chunk.push(writeMs);
    processed += ids.length;
    const totals = {
      scored: state.totals.scored + rows.length,
      skipped_existing: state.totals.skipped_existing + skipped,
      failed: state.totals.failed + failed.length,
      transient_failed: state.totals.transient_failed,
      row_bytes: state.totals.row_bytes + rows.reduce((a, r) => a + rowBytes(r), 0),
    };
    await save({
      ...state,
      cursor_property_id: ids[ids.length - 1],
      totals,
      recent_failures: [...failed, ...state.recent_failures].slice(0, 25),
      backoff: { until: null, reason: null, consecutive: 0 },
    });
    if (ids.length < limit) {
      await save({ ...state, phase_index: state.phase_index + 1, cursor_property_id: null });
    }
    if (config.sleep_between_chunks_ms > 0 && !dryRun) await sleep(config.sleep_between_chunks_ms);
  }

  summary.status_after = state.status;
  summary.finished_at = clock().toISOString();
  summary.cursor_after = { phase_index: state.phase_index, phase: state.phases?.[state.phase_index]?.market ?? state.phases?.[state.phase_index]?.kind ?? null, property_id: state.cursor_property_id };
  const bytes = [...summary.row_bytes].sort((a, b) => a - b);
  const total = summary.scored + summary.skipped_existing + summary.failed;
  summary.metrics = {
    properties: total,
    ms_per_property: total ? +(summary.ms_per_chunk.reduce((a, b) => a + b, 0) / total).toFixed(3) : null,
    load_ms_per_property: total ? +(summary.load_ms_per_chunk.reduce((a, b) => a + b, 0) / total).toFixed(3) : null,
    row_bytes: { mean: bytes.length ? Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length) : null, p50: percentile(bytes, 0.5), p95: percentile(bytes, 0.95), max: bytes[bytes.length - 1] ?? null },
  };
  delete summary.row_bytes;
  if (!dryRun) {
    await store.writeState({ ...state, last_tick: { at: summary.finished_at, scored: summary.scored, failed: summary.failed, stopped_because: summary.stopped_because, gate: summary.gate } });
  }
  return summary;
}

/**
 * Duration + growth estimate from a measured dry run.
 * windowHoursPerNight: hours/night every continental zone is outside the 8am–9pm
 * contact window ± margin (≈ 05:30Z–11:30Z ⇒ 6 h).
 */
export function estimateNationwide({ msPerProperty, rowBytesMean, universe, config = DEFAULT_CONFIG, windowHoursPerNight = 6, writeMsPerChunk = 400, pgRowOverheadFactor = 1.6, indexBytesPerRow = 180 }) {
  if (!msPerProperty || !universe) return null;
  const chunk = config.batch_size;
  const chunkWallMs = msPerProperty * chunk + writeMsPerChunk + config.sleep_between_chunks_ms;
  const perMinuteRaw = (60_000 / chunkWallMs) * chunk;
  const perMinute = Math.min(config.max_per_minute, perMinuteRaw);
  const minutes = universe / perMinute;
  const heapBytes = rowBytesMean * pgRowOverheadFactor * universe;
  const idxBytes = indexBytesPerRow * universe;
  return {
    universe,
    chunk_wall_ms: Math.round(chunkWallMs),
    effective_per_minute: Math.round(perMinute),
    total_hours_continuous: +(minutes / 60).toFixed(2),
    nights: Math.ceil(minutes / 60 / windowHoursPerNight),
    window_hours_per_night: windowHoursPerNight,
    db_growth_bytes_est: Math.round(heapBytes + idxBytes),
    db_growth_mb_est: +((heapBytes + idxBytes) / 1048576).toFixed(1),
    assumptions: { pgRowOverheadFactor, indexBytesPerRow, writeMsPerChunk },
  };
}
