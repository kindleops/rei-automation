import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKFILL_STATUS,
  SCORING_VERSION,
  applyPause,
  applyStart,
  buildBackfillRow,
  computeBackoffMs,
  evaluateLoad,
  insideSendingWindow,
  isTransientError,
  paceDelayMs,
  parseState,
  resolveConfig,
  runBackfillTick,
  shouldSkipExisting,
} from '@/lib/acquisition/scoringBackfill.js';
import { CURRENT_ENGINE_VERSION, evaluateDecisionFreshness, DECISION_STATUS } from '@/lib/acquisition/decisionAuthority.js';
import { averageRanks, buildRankComparison, spearman, topFractionOverlap } from '@/lib/acquisition/scoringRankComparison.js';
import { handleScoringBackfill } from '@/app/api/internal/acquisition/scoring-backfill/route.js';

// 2026-10-04T08:00Z = 04:00 ET / 01:00 PT — every US zone is outside 08:00-21:00.
const NIGHT = new Date('2026-10-04T08:00:00.000Z');
// 2026-10-04T18:00Z = 14:00 ET — inside the window.
const DAY = new Date('2026-10-04T18:00:00.000Z');

const QUIET_CONFIG = { sleep_between_chunks_ms: 0, checkpoint_every: 5, batch_size: 10, concurrency: 2, max_per_minute: 600 };

function makeStore({ ids = [], existing = {}, probe = null, scoreImpl = null, window = { start: '08:00', end: '21:00' }, state = null } = {}) {
  const universe = [...ids].sort();
  const scores = new Map(Object.entries(existing));
  const calls = { writeState: [], scoreOne: [], upserts: 0, pages: [] };
  let saved = state ? JSON.stringify(state) : null;
  return {
    calls,
    scores,
    get state() { return saved ? JSON.parse(saved) : null; },
    async readState() { return saved; },
    async writeState(s) { calls.writeState.push(s); saved = JSON.stringify(s); },
    async readContactWindow() { return window; },
    async probeLoad() { return probe ?? { ok: true, latency_ms: 20, active_backends: 1, long_running: 0, lock_waits: 0 }; },
    async loadPropertyPage({ afterPropertyId, limit }) {
      calls.pages.push(afterPropertyId);
      return universe.filter((id) => !afterPropertyId || id > afterPropertyId).slice(0, limit);
    },
    async loadExistingScores(list) {
      return list.filter((id) => scores.has(id)).map((id) => ({ property_id: id, ...scores.get(id) }));
    },
    async scoreOne(id, { dryRun }) {
      calls.scoreOne.push(id);
      const r = scoreImpl ? await scoreImpl(id) : { ok: true };
      if (r.ok && !dryRun) {
        calls.upserts += 1;
        scores.set(id, { scoring_version: SCORING_VERSION, engine_version: CURRENT_ENGINE_VERSION }); // upsert by property_id
      }
      return { ...r, row_bytes: 100 };
    },
  };
}

function runningState(extra = {}) {
  return applyStart(parseState(null, NIGHT), { now: NIGHT, runId: 'run-1', config: QUIET_CONFIG, ...extra });
}

const noSleep = async () => {};
const ids = (n) => Array.from({ length: n }, (_, i) => `p${String(i).padStart(4, '0')}`);

/* ── Checkpointing ─────────────────────────────────────────────────────── */

test('checkpoint: cursor is persisted after every chunk and a new tick resumes there', async () => {
  const store = makeStore({ ids: ids(12), state: runningState() });
  let t = NIGHT.valueOf();
  const clock = () => new Date(t);
  // Budget so tight the tick stops after the first chunk.
  const first = await runBackfillTick({ sleep: noSleep, store, clock: () => { t += 400; return clock(); }, configOverrides: { tick_budget_ms: 1_000 } });
  assert.equal(first.stopped_because, 'tick_budget');
  assert.equal(store.state.cursor_property_id, 'p0004', 'cursor = last id of the completed chunk');
  assert.equal(store.calls.scoreOne.length, 5);

  t = NIGHT.valueOf();
  const second = await runBackfillTick({ sleep: noSleep, store, clock: () => new Date(t) });
  assert.equal(store.calls.pages[store.calls.pages.length - 2], 'p0004', 'second tick pages from the saved cursor');
  assert.equal(second.stopped_because, 'universe_exhausted');
  assert.equal(store.state.status, BACKFILL_STATUS.COMPLETED);
  assert.deepEqual(new Set(store.calls.scoreOne).size, 12, 'every property scored exactly once across ticks');
  assert.equal(store.calls.scoreOne.length, 12);
});

test('checkpoint: a crash mid-chunk loses at most that chunk and the rerun does not duplicate', async () => {
  let crash = true;
  const store = makeStore({
    ids: ids(10),
    state: runningState(),
    scoreImpl: async (id) => {
      if (crash && id === 'p0007') throw Object.assign(new Error('process killed'), { fatal: true });
      return { ok: true };
    },
  });
  // Simulate a hard crash: the tick throws out of scoreOne -> treated as failure,
  // but we model process death by throwing from writeState after chunk 1.
  const realWrite = store.writeState.bind(store);
  let writes = 0;
  store.writeState = async (s) => {
    writes += 1;
    await realWrite(s);
    if (writes === 1 && crash) throw new Error('container restarted');
  };
  await assert.rejects(runBackfillTick({ sleep: noSleep, store, clock: () => NIGHT }), /container restarted/);
  assert.equal(store.state.cursor_property_id, 'p0004');
  crash = false;
  store.writeState = realWrite;
  await runBackfillTick({ sleep: noSleep, store, clock: () => NIGHT });
  assert.equal(store.scores.size, 10);
  assert.equal(store.calls.upserts, 10, 'upsert count equals universe: nothing double-written');
});

test('state: start resumes the cursor by default, --fresh restarts, pause stops ticks', async () => {
  const s0 = { ...runningState(), cursor_property_id: 'p0500', totals: { scored: 500, skipped_existing: 0, failed: 0, transient_failed: 0 } };
  const paused = applyPause(s0, { now: NIGHT });
  assert.equal(paused.status, BACKFILL_STATUS.PAUSED);
  const resumed = applyStart(paused, { now: NIGHT, runId: 'run-2' });
  assert.equal(resumed.cursor_property_id, 'p0500');
  assert.equal(resumed.run_id, 'run-1');
  const fresh = applyStart(paused, { now: NIGHT, runId: 'run-2', resume: false });
  assert.equal(fresh.cursor_property_id, null);
  assert.equal(fresh.totals.scored, 0);

  const store = makeStore({ ids: ids(3), state: paused });
  const r = await runBackfillTick({ sleep: noSleep, store, clock: () => NIGHT });
  assert.equal(r.stopped_because, 'status_paused');
  assert.equal(store.calls.scoreOne.length, 0);
});

test('state: unparseable state fails closed as paused', () => {
  const s = parseState('{not json', NIGHT);
  assert.equal(s.status, BACKFILL_STATUS.PAUSED);
});

/* ── Backoff ───────────────────────────────────────────────────────────── */

test('backoff: hot DB load pauses before scoring and arms exponential backoff', async () => {
  const store = makeStore({ ids: ids(5), state: runningState(), probe: { ok: true, latency_ms: 30, active_backends: 40, long_running: 3, lock_waits: 0 } });
  const r = await runBackfillTick({ sleep: noSleep, store, clock: () => NIGHT });
  assert.equal(r.stopped_because, 'db_load');
  assert.match(r.gate.reason, /active_backends/);
  assert.match(r.gate.reason, /long_running_queries/);
  assert.equal(store.calls.scoreOne.length, 0);
  assert.equal(store.state.backoff.consecutive, 1);
  assert.equal(new Date(store.state.backoff.until).valueOf(), NIGHT.valueOf() + 60_000);

  const again = await runBackfillTick({ sleep: noSleep, store, clock: () => new Date(NIGHT.valueOf() + 30_000) });
  assert.equal(again.stopped_because, 'backoff_active');
});

test('backoff: missing load probe (migration unapplied) fails closed', async () => {
  const store = makeStore({ ids: ids(5), state: runningState(), probe: { ok: false, error: 'function scoring_backfill_load_probe does not exist' } });
  const r = await runBackfillTick({ sleep: noSleep, store, clock: () => NIGHT });
  assert.equal(r.stopped_because, 'db_load');
  assert.equal(r.gate.reason, 'load_probe_unavailable');
  assert.equal(store.calls.scoreOne.length, 0);
});

test('backoff: statement timeouts do not advance the cursor and are retried after backoff', async () => {
  let timeouts = true;
  const store = makeStore({
    ids: ids(10),
    state: runningState(),
    scoreImpl: async (id) => (timeouts && id === 'p0002' ? { ok: false, error: 'canceling statement due to statement timeout' } : { ok: true }),
  });
  const r = await runBackfillTick({ sleep: noSleep, store, clock: () => NIGHT });
  assert.equal(r.stopped_because, 'transient_failures');
  assert.equal(store.state.cursor_property_id, null, 'cursor did not move past the failed chunk');
  assert.ok(store.state.backoff.until);
  timeouts = false;
  const later = new Date(NIGHT.valueOf() + 10 * 60_000);
  const r2 = await runBackfillTick({ sleep: noSleep, store, clock: () => later });
  assert.equal(r2.stopped_because, 'universe_exhausted');
  assert.equal(store.scores.size, 10);
  assert.equal(store.calls.upserts, 10, 'chunk-mates scored before the timeout were skipped on retry, not rewritten');
});

test('backoff: deterministic engine failures advance (no infinite retry), high ratio backs off', async () => {
  const store = makeStore({ ids: ids(5), state: runningState(), scoreImpl: async () => ({ ok: false, error: 'property_not_found' }) });
  const r = await runBackfillTick({ sleep: noSleep, store, clock: () => NIGHT });
  assert.equal(r.stopped_because, 'failure_ratio');
  assert.equal(store.state.cursor_property_id, 'p0004');
  assert.equal(store.state.totals.failed, 5);
});

test('backoff: exponential and capped; transient classifier', () => {
  const c = resolveConfig({});
  assert.equal(computeBackoffMs(0, c), 60_000);
  assert.equal(computeBackoffMs(3, c), 480_000);
  assert.equal(computeBackoffMs(20, c), 30 * 60_000);
  assert.ok(isTransientError('canceling statement due to statement timeout'));
  assert.ok(isTransientError('TypeError: fetch failed'));
  assert.ok(isTransientError('upstream 503'));
  assert.ok(!isTransientError('property_not_found'));
  assert.ok(!evaluateLoad({ ok: true, latency_ms: 5_000, active_backends: 1, long_running: 0, lock_waits: 0 }, c).ok);
  assert.ok(evaluateLoad({ ok: true, latency_ms: 50, active_backends: 1, long_running: 0, lock_waits: 0 }, c).ok);
});

test('sending window: any US zone inside the contact window pauses (no backoff armed)', async () => {
  assert.equal(insideSendingWindow({ now: NIGHT, window: { start: '08:00', end: '21:00' }, config: resolveConfig({}) }).inside, false);
  const w = insideSendingWindow({ now: DAY, window: { start: '08:00', end: '21:00' }, config: resolveConfig({}) });
  assert.equal(w.inside, true);
  // 02:00Z = 22:00 ET (outside) but 19:00 PT (inside) -> still paused.
  assert.equal(insideSendingWindow({ now: new Date('2026-10-04T02:00:00Z'), window: { start: '08:00', end: '21:00' }, config: resolveConfig({}) }).inside, true);

  const store = makeStore({ ids: ids(5), state: runningState() });
  const r = await runBackfillTick({ sleep: noSleep, store, clock: () => DAY });
  assert.equal(r.stopped_because, 'sending_window');
  assert.equal(store.calls.scoreOne.length, 0);
  assert.equal(store.state.backoff.until, null);
});

test('rate: pacing never exceeds max_per_minute', () => {
  assert.equal(paceDelayMs({ processed: 0, startedMs: 0, nowMs: 0, maxPerMinute: 60 }), 0);
  assert.equal(paceDelayMs({ processed: 30, startedMs: 0, nowMs: 10_000, maxPerMinute: 60 }), 20_000);
  assert.equal(paceDelayMs({ processed: 30, startedMs: 0, nowMs: 40_000, maxPerMinute: 60 }), 0);
});

/* ── Idempotency ───────────────────────────────────────────────────────── */

test('idempotency: rows already at the scoring version or current engine version are skipped', async () => {
  const existing = {
    p0000: { scoring_version: SCORING_VERSION, engine_version: CURRENT_ENGINE_VERSION },
    p0001: { scoring_version: null, engine_version: CURRENT_ENGINE_VERSION }, // operator run, full evidence: keep
    p0002: { scoring_version: null, engine_version: '1.0.0' }, // old engine: rescore
  };
  const store = makeStore({ ids: ids(4), existing, state: runningState() });
  const r = await runBackfillTick({ sleep: noSleep, store, clock: () => NIGHT });
  assert.deepEqual(store.calls.scoreOne, ['p0002', 'p0003']);
  assert.equal(r.skipped_existing, 2);
  assert.ok(shouldSkipExisting(existing.p0001, resolveConfig({})));
  assert.ok(!shouldSkipExisting(existing.p0001, resolveConfig({ rescore_existing: true })));
});

test('idempotency: a full rerun after completion writes nothing new', async () => {
  const store = makeStore({ ids: ids(6), state: runningState() });
  await runBackfillTick({ sleep: noSleep, store, clock: () => NIGHT });
  assert.equal(store.calls.upserts, 6);
  await store.writeState(applyStart(parseState(store.state, NIGHT), { now: NIGHT, runId: 'run-2', resume: false }));
  const r = await runBackfillTick({ sleep: noSleep, store, clock: () => NIGHT });
  assert.equal(store.calls.upserts, 6);
  assert.equal(r.skipped_existing, 6);
});

test('dry run: computes but writes neither scores nor state, and ignores the window', async () => {
  const store = makeStore({ ids: ids(4) });
  store.writeState = async () => { throw new Error('must not write'); };
  const r = await runBackfillTick({ sleep: noSleep, store, dryRun: true, maxProperties: 3, clock: () => DAY });
  assert.equal(r.scored, 3);
  assert.equal(store.calls.upserts, 0);
  assert.equal(r.row_bytes.length, 3);
});

/* ── Versioning + monetary safety ──────────────────────────────────────── */

test('versioning: rows carry scoring_version/scored_at, compact evidence, no monetary lineage', () => {
  const row = buildBackfillRow({
    property_id: 'p1',
    aos_score: 71,
    computed_at: NIGHT.toISOString(),
    evidence: {
      engine: { name: 'acquisition_decision_engine', version: CURRENT_ENGINE_VERSION },
      immutable_snapshot_id: 'uuid-x',
      decision_inputs: { fingerprint: 'abc' },
      rejected_comps: [{ reasons: ['stale_sale', 'size_mismatch'] }, { reasons: ['stale_sale'] }],
      selected_comps: [{ id: 'c1', sale_price: 1, match_breakdown: { big: 1 }, feature_match_breakdown: { big: 1 } }],
    },
  }, { runId: 'run-1', now: NIGHT, v3Enabled: false });
  assert.equal(row.scoring_version, SCORING_VERSION);
  assert.equal(row.scored_at, NIGHT.toISOString());
  assert.equal(row.evidence.rejected_comps, undefined);
  assert.deepEqual(row.evidence.backfill.rejected_reason_census, { stale_sale: 2, size_mismatch: 1 });
  assert.equal(row.evidence.backfill.monetary_authority, false);
  assert.equal(row.evidence.immutable_snapshot_id, undefined);
  assert.deepEqual(row.evidence.selected_comps, [{ id: 'c1', sale_price: 1 }]);
  // The decision authority must treat a backfill row as not provably current,
  // so an offer path recomputes with full evidence.
  const f = evaluateDecisionFreshness({ score: row, stamp: { fingerprint: 'abc' }, now: NIGHT });
  assert.equal(f.status, DECISION_STATUS.STALE);
});

/* ── Route control plane ───────────────────────────────────────────────── */

test('route: start refuses until the migration columns exist; status is always readable', async () => {
  const store = makeStore({ ids: ids(2) });
  store.hasVersionColumns = async () => false;
  const prev = process.env.ACQUISITION_SCORING_BACKFILL_ENABLED;
  process.env.ACQUISITION_SCORING_BACKFILL_ENABLED = 'true';
  try {
    const start = await handleScoringBackfill('start', {}, { store, now: NIGHT });
    assert.equal(start.status, 409);
    const status = await handleScoringBackfill('status', {}, { store, now: NIGHT });
    assert.equal(status.body.state.status, BACKFILL_STATUS.STOPPED);
    store.hasVersionColumns = async () => true;
    const ok = await handleScoringBackfill('start', { config: { max_per_minute: 60 } }, { store, now: NIGHT });
    assert.equal(ok.body.state.status, BACKFILL_STATUS.RUNNING);
    assert.equal(store.state.config.max_per_minute, 60);
    const paused = await handleScoringBackfill('pause', {}, { store, now: NIGHT });
    assert.equal(paused.body.state.status, BACKFILL_STATUS.PAUSED);
  } finally {
    if (prev === undefined) delete process.env.ACQUISITION_SCORING_BACKFILL_ENABLED;
    else process.env.ACQUISITION_SCORING_BACKFILL_ENABLED = prev;
  }
});

test('route: env ceiling off => tick and start are no-ops', async () => {
  const store = makeStore({ ids: ids(2), state: runningState() });
  const prev = process.env.ACQUISITION_SCORING_BACKFILL_ENABLED;
  delete process.env.ACQUISITION_SCORING_BACKFILL_ENABLED;
  try {
    const tick = await handleScoringBackfill('tick', {}, { store, now: NIGHT, withRunLock: async ({ fn }) => fn() });
    assert.equal(tick.body.skipped, true);
    assert.equal(store.calls.scoreOne.length, 0);
  } finally {
    if (prev !== undefined) process.env.ACQUISITION_SCORING_BACKFILL_ENABLED = prev;
  }
});

/* ── Rank comparison ───────────────────────────────────────────────────── */

test('rank comparison: spearman with ties, top-decile overlap, by market', () => {
  assert.deepEqual(averageRanks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  const same = Array.from({ length: 20 }, (_, i) => ({ property_id: `a${i}`, legacy: i, canonical: i * 2 }));
  assert.equal(Math.round(spearman(same) * 1000) / 1000, 1);
  const reversed = same.map((p) => ({ ...p, canonical: -p.legacy }));
  assert.equal(Math.round(spearman(reversed) * 1000) / 1000, -1);
  assert.equal(topFractionOverlap(same, 0.1).share, 1);
  assert.equal(topFractionOverlap(reversed, 0.1).share, 0);

  const rows = [
    ...same.map((p) => ({ ...p, market: 'Dallas, TX' })),
    ...reversed.map((p) => ({ ...p, property_id: `b${p.property_id}`, market: 'Houston, TX' })),
    { property_id: 'x', market: 'Dallas, TX', legacy: null, canonical: 50 },
    { property_id: 'y', market: 'Dallas, TX', legacy: 5, canonical: null },
  ];
  const report = buildRankComparison(rows, { minN: 10 });
  assert.equal(report.coverage.both, 40);
  assert.equal(report.coverage.canonical_only, 1);
  assert.equal(report.coverage.legacy_only, 1);
  const dallas = report.markets.find((m) => m.market === 'Dallas, TX');
  const houston = report.markets.find((m) => m.market === 'Houston, TX');
  assert.equal(dallas.spearman, 1);
  assert.equal(houston.spearman, -1);
  assert.equal(report.verdict_inputs.sufficient_overlap_for_decision, false);
});
