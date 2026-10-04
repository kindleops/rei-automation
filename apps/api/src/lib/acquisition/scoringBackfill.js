// ─── scoringBackfill.js ─────────────────────────────────────────────────────
// Overnight, throttled, resumable backfill of the canonical Acquisition
// Decision Engine (`property_acquisition_scores`) across ALL properties.
//
// WHY. Campaign Build still orders by the Podio-era
// `properties.final_acquisition_score` because the canonical engine has run
// for ~170 of ~170K properties. The legacy score is retired only after (a)
// coverage is complete and (b) scoringRankComparison.js proves the ranking.
// This module produces (a). It does NOT touch the legacy column.
//
// WHAT A BACKFILL ROW IS (and is not).
//   * Same engine, same `calculateAcquisitionDecision`, same upsert target
//     (`property_acquisition_scores`, conflict on property_id) -> reruns can
//     never duplicate a row.
//   * Stamped `scoring_version` + `scored_at` (PROPOSED migration) and
//     `evidence.backfill`.
//   * NOT monetary authority: no immutable snapshot is written and NO
//     decision-input stamp is recorded, so decisionAuthority.js reads every
//     backfill row as `fingerprint_absent_predates_freshness_contract` (STALE)
//     and recomputes with full evidence the moment an offer actually needs
//     economics. A backfill row ranks and targets; it never prices an offer.
//   * Compact evidence: `rejected_comps` (≈70% of today's ~82 KB/row) is
//     replaced by its count + reason census. Full-evidence rows at 170K would
//     add ~14 GB to a 23 GB database.
//   * Never overwrites a row the engine already produced at the current
//     engine version (operator / seller-flow runs keep their full evidence).
//
// SAFETY RAILS (all checked before EVERY chunk, not once per tick):
//   status   system_control.acquisition_scoring_backfill.status === 'running'
//   window   paused while ANY US timezone is inside the operator contact window
//            (system_control.queue_contact_window_start/end) +/- a margin,
//            so it only runs overnight when the send lane is quiet
//   load     paused when the DB probe reports too many active backends,
//            long-running queries, lock waits, or slow probe latency
//   errors   a chunk with transient failures (statement timeout, connection,
//            5xx) does NOT advance the cursor and arms exponential backoff
//   rate     max_per_minute ceiling + sleep between chunks + tick time budget
//
// Every side effect goes through an injected `store`, so the policy here is
// unit-tested with no network (tests/critical/acquisition-scoring-backfill.test.mjs).

import { CURRENT_ENGINE_VERSION } from './decisionAuthority.js';

export const BACKFILL_STATE_KEY = 'acquisition_scoring_backfill';
export const SCORING_VERSION = `ade@${CURRENT_ENGINE_VERSION}+backfill.1`;

export const BACKFILL_STATUS = Object.freeze({
  STOPPED: 'stopped',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
});

export const DEFAULT_CONFIG = Object.freeze({
  batch_size: 200, // ids loaded per keyset page
  checkpoint_every: 20, // cursor is persisted after every chunk of this many
  concurrency: 2, // properties scored in parallel inside a chunk
  sleep_between_chunks_ms: 3_000,
  max_per_minute: 120, // hard rate ceiling across a tick
  tick_budget_ms: 240_000, // */5 cron cadence; stays under the route's maxDuration (300 s)
  rescore_existing: false, // true => also rescore rows already at the current engine version
  // Sending-window guard
  respect_contact_window: true,
  window_margin_minutes: 30,
  window_timezones: [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Phoenix',
    'America/Los_Angeles',
  ],
  // Load guard
  max_active_backends: 12,
  max_long_running: 1, // queries running > long_running_seconds (excluding the probe)
  long_running_seconds: 20,
  max_lock_waits: 2,
  max_probe_latency_ms: 1_500,
  // Backoff
  backoff_base_ms: 60_000,
  backoff_max_ms: 30 * 60_000,
  max_failure_ratio: 0.25, // deterministic failures above this ratio in a chunk also back off
});

function clean(value) {
  return String(value ?? '').trim();
}

function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function resolveConfig(overrides = {}) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const d = DEFAULT_CONFIG;
  return {
    ...d,
    ...o,
    batch_size: toInt(o.batch_size, d.batch_size, 1, 500),
    checkpoint_every: toInt(o.checkpoint_every, d.checkpoint_every, 1, 200),
    concurrency: toInt(o.concurrency, d.concurrency, 1, 4),
    sleep_between_chunks_ms: toInt(o.sleep_between_chunks_ms, d.sleep_between_chunks_ms, 0, 600_000),
    max_per_minute: toInt(o.max_per_minute, d.max_per_minute, 1, 600),
    tick_budget_ms: toInt(o.tick_budget_ms, d.tick_budget_ms, 1_000, 280_000),
    rescore_existing: o.rescore_existing === true,
    respect_contact_window: o.respect_contact_window !== false,
    window_timezones: Array.isArray(o.window_timezones) && o.window_timezones.length
      ? o.window_timezones.map(clean).filter(Boolean)
      : d.window_timezones,
  };
}

/* ── State ──────────────────────────────────────────────────────────────── */

export function initialState(now = new Date()) {
  return {
    status: BACKFILL_STATUS.STOPPED,
    scoring_version: SCORING_VERSION,
    run_id: null,
    cursor_property_id: null,
    started_at: null,
    updated_at: now.toISOString(),
    completed_at: null,
    totals: { scored: 0, skipped_existing: 0, failed: 0, transient_failed: 0 },
    backoff: { until: null, reason: null, consecutive: 0 },
    last_tick: null,
    recent_failures: [],
    config: {},
  };
}

export function parseState(raw, now = new Date()) {
  if (!raw) return initialState(now);
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...initialState(now), status: BACKFILL_STATUS.PAUSED, parse_error: true };
    }
  }
  const base = initialState(now);
  return {
    ...base,
    ...parsed,
    totals: { ...base.totals, ...(parsed.totals || {}) },
    backoff: { ...base.backoff, ...(parsed.backoff || {}) },
    recent_failures: Array.isArray(parsed.recent_failures) ? parsed.recent_failures.slice(0, 25) : [],
  };
}

/** start: begins a NEW run from the beginning unless `resume` keeps the cursor. */
export function applyStart(state, { now = new Date(), runId, config = {}, resume = true } = {}) {
  const keepCursor = resume && state.scoring_version === SCORING_VERSION && state.status !== BACKFILL_STATUS.COMPLETED;
  return {
    ...state,
    status: BACKFILL_STATUS.RUNNING,
    scoring_version: SCORING_VERSION,
    run_id: keepCursor && state.run_id ? state.run_id : runId,
    cursor_property_id: keepCursor ? state.cursor_property_id : null,
    started_at: keepCursor && state.started_at ? state.started_at : now.toISOString(),
    totals: keepCursor ? state.totals : initialState(now).totals,
    completed_at: null,
    backoff: { until: null, reason: null, consecutive: 0 },
    config: { ...(state.config || {}), ...config },
    updated_at: now.toISOString(),
  };
}

export function applyPause(state, { now = new Date(), reason = 'operator_pause' } = {}) {
  return { ...state, status: BACKFILL_STATUS.PAUSED, paused_reason: reason, updated_at: now.toISOString() };
}

/* ── Gates ──────────────────────────────────────────────────────────────── */

function hhmmToMinutes(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clean(value));
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

function localMinutes(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/**
 * True when ANY configured timezone is inside [start - margin, end + margin).
 * The send lane works in seller-local time, so the backfill may only run when
 * every continental US zone is outside the window.
 */
export function insideSendingWindow({ now = new Date(), window = {}, config = DEFAULT_CONFIG } = {}) {
  const margin = Number(config.window_margin_minutes) || 0;
  const start = hhmmToMinutes(window.start, 8 * 60) - margin;
  const end = hhmmToMinutes(window.end, 21 * 60) + margin;
  const zones = [];
  for (const tz of config.window_timezones || DEFAULT_CONFIG.window_timezones) {
    const t = localMinutes(now, tz);
    if (t >= start && t < end) zones.push(tz);
  }
  return { inside: zones.length > 0, zones };
}

export function evaluateLoad(probe, config = DEFAULT_CONFIG) {
  if (!probe || probe.ok === false) {
    return { ok: false, reason: 'load_probe_unavailable', detail: probe?.error ?? null };
  }
  const reasons = [];
  if (Number(probe.active_backends) > config.max_active_backends) reasons.push('active_backends');
  if (Number(probe.long_running) > config.max_long_running) reasons.push('long_running_queries');
  if (Number(probe.lock_waits) > config.max_lock_waits) reasons.push('lock_waits');
  if (Number(probe.latency_ms) > config.max_probe_latency_ms) reasons.push('probe_latency');
  return reasons.length
    ? { ok: false, reason: `db_load:${reasons.join(',')}`, detail: probe }
    : { ok: true, reason: null, detail: probe };
}

export function computeBackoffMs(consecutive, config = DEFAULT_CONFIG) {
  const n = Math.max(0, Number(consecutive) || 0);
  return Math.min(config.backoff_max_ms, config.backoff_base_ms * 2 ** n);
}

/** Infra faults retry the same ids later; engine verdicts advance past them. */
export function isTransientError(message) {
  const m = clean(message).toLowerCase();
  if (!m) return false;
  return [
    'statement timeout',
    'canceling statement',
    '57014',
    'timeout',
    'econnreset',
    'econnrefused',
    'etimedout',
    'fetch failed',
    'socket hang up',
    'too many connections',
    'connection terminated',
    'remaining connection slots',
    '502',
    '503',
    '504',
    'bad gateway',
    'service unavailable',
  ].some((needle) => m.includes(needle));
}

/* ── Idempotency ────────────────────────────────────────────────────────── */

/**
 * A property is skipped when a row already exists at the target scoring
 * version, or (unless rescore_existing) when the engine already produced it at
 * the current engine version through the operator / seller flow.
 */
export function shouldSkipExisting(existing, config = DEFAULT_CONFIG) {
  if (!existing) return false;
  if (clean(existing.scoring_version) === SCORING_VERSION) return true;
  if (!config.rescore_existing && clean(existing.engine_version) === CURRENT_ENGINE_VERSION) return true;
  return false;
}

/* ── Evidence compaction ────────────────────────────────────────────────── */

export function compactBackfillEvidence(evidence, { runId = null, now = new Date(), v3Enabled = null } = {}) {
  const ev = evidence && typeof evidence === 'object' ? { ...evidence } : {};
  const rejected = Array.isArray(ev.rejected_comps) ? ev.rejected_comps : [];
  const reasonCensus = {};
  for (const comp of rejected) {
    const reasons = Array.isArray(comp?.reasons)
      ? comp.reasons
      : comp?.reason
        ? [comp.reason]
        : Array.isArray(comp?.rejection_reasons)
          ? comp.rejection_reasons
          : ['unspecified'];
    for (const r of reasons) {
      const k = clean(typeof r === 'string' ? r : r?.code || r?.reason) || 'unspecified';
      reasonCensus[k] = (reasonCensus[k] || 0) + 1;
    }
  }
  delete ev.rejected_comps;
  // Per-comp feature breakdowns are ~10 KB each and duplicated under two keys
  // (match_breakdown / feature_match_breakdown). Ranking needs the comp, its
  // price, weight and adjustments — not the per-feature trace, which the full
  // run regenerates whenever an offer actually needs economics.
  if (Array.isArray(ev.selected_comps)) {
    ev.selected_comps = ev.selected_comps.map((comp) => {
      if (!comp || typeof comp !== 'object') return comp;
      const { match_breakdown: _m, feature_match_breakdown: _f, ...rest } = comp;
      return rest;
    });
  }
  // No snapshot is written for a backfill row, so it must not carry an id
  // that looks like monetary lineage.
  delete ev.immutable_snapshot_id;
  delete ev.decision_inputs;
  ev.backfill = {
    scoring_version: SCORING_VERSION,
    run_id: runId,
    evidence_mode: 'compact',
    monetary_authority: false,
    rejected_comp_count: rejected.length,
    rejected_reason_census: reasonCensus,
    dropped: ['rejected_comps', 'selected_comps[].match_breakdown', 'selected_comps[].feature_match_breakdown'],
    v3_enabled: v3Enabled,
    scored_at: now.toISOString(),
  };
  return ev;
}

export function buildBackfillRow(row, { runId = null, now = new Date(), v3Enabled = null } = {}) {
  return {
    ...row,
    evidence: compactBackfillEvidence(row.evidence, { runId, now, v3Enabled }),
    scoring_version: SCORING_VERSION,
    scored_at: now.toISOString(),
  };
}

/* ── Tick ───────────────────────────────────────────────────────────────── */

/** ms to wait so `processed` items since `startedMs` stay <= maxPerMinute. */
export function paceDelayMs({ processed, startedMs, nowMs, maxPerMinute }) {
  if (!processed || !maxPerMinute) return 0;
  const earliestMs = startedMs + (processed / maxPerMinute) * 60_000;
  return Math.max(0, Math.ceil(earliestMs - nowMs));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker()));
  return results;
}

/**
 * Gate check before a chunk. Returns null when clear, else a pause verdict.
 * `store` provides readControlWindow() and probeLoad().
 */
export async function checkGates({ store, config, now, ignoreWindow = false }) {
  if (config.respect_contact_window && !ignoreWindow) {
    const window = await store.readContactWindow();
    const w = insideSendingWindow({ now, window, config });
    if (w.inside) return { gate: 'sending_window', reason: `inside_contact_window:${w.zones.join('|')}`, backoff: false };
  }
  const load = evaluateLoad(await store.probeLoad(), config);
  if (!load.ok) return { gate: 'db_load', reason: load.reason, detail: load.detail, backoff: true };
  return null;
}

/**
 * One cron tick. Processes chunks until the time budget, the rate ceiling, a
 * gate, or the end of the property universe. Persists the cursor after every
 * chunk, so a crash at any point loses at most one chunk of (idempotent) work.
 *
 * @param {object} p
 * @param {object} p.store   injected side effects (see scoringBackfillStore.js)
 * @param {boolean} [p.dryRun]  compute without writing scores or state
 * @param {number}  [p.maxProperties]  cap for dry runs / smoke ticks
 */
export async function runBackfillTick({
  store,
  dryRun = false,
  maxProperties = null,
  ignoreWindow = false,
  configOverrides = null,
  clock = () => new Date(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const tickStarted = clock();
  let state = parseState(await store.readState(), tickStarted);
  const config = resolveConfig({ ...(state.config || {}), ...(configOverrides || {}) });
  const summary = {
    ok: true,
    dry_run: dryRun,
    started_at: tickStarted.toISOString(),
    status_before: state.status,
    stopped_because: null,
    chunks: 0,
    scored: 0,
    skipped_existing: 0,
    failed: 0,
    transient_failed: 0,
    per_property_ms: [],
    row_bytes: [],
    cursor_before: state.cursor_property_id,
    cursor_after: state.cursor_property_id,
    gate: null,
  };

  if (!dryRun && state.status !== BACKFILL_STATUS.RUNNING) {
    summary.stopped_because = `status_${state.status}`;
    return summary;
  }
  if (!dryRun && state.backoff?.until && new Date(state.backoff.until) > tickStarted) {
    summary.stopped_because = 'backoff_active';
    summary.gate = { reason: state.backoff.reason, until: state.backoff.until };
    return summary;
  }

  const saveState = async (next) => {
    state = { ...next, updated_at: clock().toISOString() };
    if (!dryRun) await store.writeState(state);
  };

  const armBackoff = async (reason) => {
    const consecutive = (state.backoff?.consecutive || 0) + 1;
    const until = new Date(clock().valueOf() + computeBackoffMs(consecutive - 1, config)).toISOString();
    await saveState({ ...state, backoff: { until, reason, consecutive } });
    summary.gate = { reason, until };
  };

  let processedThisTick = 0;
  let cursor = state.cursor_property_id;
  const deadline = tickStarted.valueOf() + config.tick_budget_ms;
  const cap = maxProperties ?? Number.POSITIVE_INFINITY;

  outer: while (true) {
    const page = await store.loadPropertyPage({ afterPropertyId: cursor, limit: config.batch_size });
    if (!page.length) {
      if (!dryRun) {
        await saveState({ ...state, status: BACKFILL_STATUS.COMPLETED, completed_at: clock().toISOString() });
      }
      summary.stopped_because = 'universe_exhausted';
      break;
    }

    for (let offset = 0; offset < page.length; offset += config.checkpoint_every) {
      if (processedThisTick >= cap) { summary.stopped_because = 'max_properties'; break outer; }
      // Max-rate pacing: never exceed max_per_minute measured from tick start.
      const waitMs = paceDelayMs({ processed: processedThisTick, startedMs: tickStarted.valueOf(), nowMs: clock().valueOf(), maxPerMinute: config.max_per_minute });
      if (waitMs > 0) {
        if (clock().valueOf() + waitMs >= deadline) { summary.stopped_because = 'rate_ceiling'; break outer; }
        if (!dryRun) await sleep(waitMs);
      }
      const now = clock();
      if (now.valueOf() >= deadline) { summary.stopped_because = 'tick_budget'; break outer; }

      const gate = await checkGates({ store, config, now, ignoreWindow: ignoreWindow || dryRun });
      if (gate) {
        summary.stopped_because = gate.gate;
        summary.gate = { reason: gate.reason };
        if (gate.backoff && !dryRun) await armBackoff(gate.reason);
        break outer;
      }

      const remaining = cap - processedThisTick;
      const chunkIds = page.slice(offset, offset + Math.min(config.checkpoint_every, remaining));
      const existing = await store.loadExistingScores(chunkIds);
      const existingById = new Map(existing.map((r) => [clean(r.property_id), r]));

      const results = await mapWithConcurrency(chunkIds, config.concurrency, async (propertyId) => {
        if (shouldSkipExisting(existingById.get(clean(propertyId)), config)) {
          return { property_id: propertyId, skipped: true };
        }
        const t0 = Date.now();
        try {
          const r = await store.scoreOne(propertyId, { dryRun, runId: state.run_id, now: clock() });
          return { property_id: propertyId, ok: Boolean(r?.ok), error: r?.error ?? null, ms: Date.now() - t0, bytes: r?.row_bytes ?? null };
        } catch (error) {
          return { property_id: propertyId, ok: false, error: clean(error?.message) || 'score_threw', ms: Date.now() - t0 };
        }
      });

      const transient = results.filter((r) => !r.skipped && !r.ok && isTransientError(r.error));
      const failed = results.filter((r) => !r.skipped && !r.ok && !isTransientError(r.error));
      const scored = results.filter((r) => r.ok);
      const skipped = results.filter((r) => r.skipped);
      summary.chunks += 1;
      summary.scored += scored.length;
      summary.skipped_existing += skipped.length;
      summary.failed += failed.length;
      summary.transient_failed += transient.length;
      for (const r of results) {
        if (Number.isFinite(r.ms)) summary.per_property_ms.push(r.ms);
        if (Number.isFinite(r.bytes)) summary.row_bytes.push(r.bytes);
      }
      processedThisTick += chunkIds.length;

      const totals = {
        scored: state.totals.scored + scored.length,
        skipped_existing: state.totals.skipped_existing + skipped.length,
        failed: state.totals.failed + failed.length,
        transient_failed: state.totals.transient_failed + transient.length,
      };
      const recent_failures = [
        ...[...transient, ...failed].map((r) => ({ property_id: r.property_id, error: r.error, transient: isTransientError(r.error) })),
        ...state.recent_failures,
      ].slice(0, 25);

      if (transient.length) {
        // Do NOT advance: the same ids are retried after backoff. Work already
        // done in this chunk was upserted and is skipped next time.
        await saveState({ ...state, totals, recent_failures });
        if (!dryRun) await armBackoff(`transient_failures:${transient.length}`);
        summary.stopped_because = 'transient_failures';
        break outer;
      }

      cursor = chunkIds[chunkIds.length - 1];
      summary.cursor_after = cursor;
      const nonSkipped = chunkIds.length - skipped.length;
      const failureRatio = nonSkipped ? failed.length / nonSkipped : 0;
      await saveState({
        ...state,
        cursor_property_id: dryRun ? state.cursor_property_id : cursor,
        totals,
        recent_failures,
        backoff: failureRatio > config.max_failure_ratio ? state.backoff : { until: null, reason: null, consecutive: 0 },
      });
      if (failureRatio > config.max_failure_ratio) {
        if (!dryRun) await armBackoff(`failure_ratio:${failureRatio.toFixed(2)}`);
        summary.stopped_because = 'failure_ratio';
        break outer;
      }

      if (config.sleep_between_chunks_ms > 0 && !dryRun) await sleep(config.sleep_between_chunks_ms);
    }
    // A short page means the universe ends here; the next iteration confirms it
    // with an empty page and marks the run completed.
  }

  summary.status_after = state.status;
  summary.finished_at = clock().toISOString();
  if (!dryRun) {
    await store.writeState({
      ...state,
      last_tick: {
        at: summary.finished_at,
        scored: summary.scored,
        skipped_existing: summary.skipped_existing,
        failed: summary.failed,
        transient_failed: summary.transient_failed,
        stopped_because: summary.stopped_because,
        gate: summary.gate,
      },
    });
  }
  return summary;
}

/** Runtime estimate from a measured dry run. */
export function estimateRuntime({ perPropertyMs = [], universe = 0, config = DEFAULT_CONFIG, windowHoursPerNight = 7 } = {}) {
  const sorted = [...perPropertyMs].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const chunkWallMs = (mean * config.checkpoint_every) / config.concurrency + config.sleep_between_chunks_ms;
  // */5 cron: a tick works tick_budget_ms out of every 300 s.
  const duty = Math.min(1, config.tick_budget_ms / 300_000);
  const perMinute = Math.min(config.max_per_minute, (60_000 / chunkWallMs) * config.checkpoint_every) * duty;
  const minutes = universe / perMinute;
  return {
    per_property_ms: { median, p90, mean: Math.round(mean) },
    batch_of_200_wall_seconds: Math.round(((mean * 200) / config.concurrency + (200 / config.checkpoint_every) * config.sleep_between_chunks_ms) / 1000),
    cron_duty_cycle: duty,
    effective_per_minute: Math.round(perMinute),
    total_hours_continuous: Math.round((minutes / 60) * 10) / 10,
    nights_at_window_hours: Math.ceil(minutes / 60 / windowHoursPerNight),
    window_hours_per_night: windowHoursPerNight,
  };
}

export default {
  BACKFILL_STATE_KEY,
  BACKFILL_STATUS,
  DEFAULT_CONFIG,
  SCORING_VERSION,
  applyPause,
  applyStart,
  buildBackfillRow,
  checkGates,
  compactBackfillEvidence,
  computeBackoffMs,
  estimateRuntime,
  evaluateLoad,
  insideSendingWindow,
  isTransientError,
  parseState,
  resolveConfig,
  runBackfillTick,
  shouldSkipExisting,
};
