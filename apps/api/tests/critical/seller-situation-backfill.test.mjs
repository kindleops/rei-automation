// Seller Situation v2 nationwide runner (§8–9): market order, resumable cursor, write refusal, gates, failure log.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runTick,
  buildPhases,
  applyStart,
  applyPause,
  parseState,
  initialState,
  shouldSkipExisting,
  estimateNationwide,
  STATUS,
  RUN_VERSION,
  BASELINE_ACTIVE_MARKETS,
} from '@/lib/acquisition/seller-situation/backfill.js';
import { createSellerSituationStore, upsertSql } from '@/lib/acquisition/seller-situation/backfillStore.js';
import { buildRawFactsFromRows, WEIGHTS_VERSION } from '@/lib/acquisition/seller-situation/index.js';

const NIGHT = new Date('2026-10-07T08:00:00Z'); // 04:00 ET / 01:00 PT — every US zone outside 08:00–21:00 ± 30m
const DAY = new Date('2026-10-07T17:00:00Z');

function universe() {
  const rows = [];
  for (const [market, n] of [['Dallas, TX', 5], ['Houston, TX', 3], ['Phoenix, AZ', 4], [null, 2]]) {
    for (let i = 0; i < n; i++) rows.push({ property_id: `${(market || 'zz').slice(0, 3)}-${i}`, market });
  }
  return rows;
}

function fakeStore({ rows = universe(), failRawFactsOnce = false, failUpsertOnce = false, probe = { ok: true, active_backends: 1, long_running: 0, lock_waits: 0, latency_ms: 5 }, missingIds = [] } = {}) {
  let state = null;
  const scores = new Map();
  const failures = [];
  const writes = { state: 0, upserts: 0, logs: 0 };
  let rawFail = failRawFactsOnce;
  let upFail = failUpsertOnce;
  return {
    scores, failures, writes,
    get state() { return state; },
    async readState() { return state ? JSON.stringify(state) : null; },
    async writeState(s) { writes.state += 1; state = JSON.parse(JSON.stringify(s)); },
    async readContactWindow() { return { start: '08:00', end: '21:00' }; },
    async probeLoad() { return probe; },
    async loadActiveMarkets() { return ['Houston, TX']; },
    async loadPropertyPage({ phase, afterPropertyId, limit }) {
      let list;
      if (phase.kind === 'ids') list = [...phase.ids].sort();
      else if (phase.kind === 'market') list = rows.filter((r) => r.market === phase.market).map((r) => r.property_id).sort();
      else list = rows.filter((r) => r.market === null || !phase.exclude_markets.includes(r.market)).map((r) => r.property_id).sort();
      return list.filter((id) => !afterPropertyId || id > afterPropertyId).slice(0, limit);
    },
    async loadRawFacts(ids) {
      if (rawFail) { rawFail = false; throw new Error('canceling statement due to statement timeout'); }
      const m = new Map();
      for (const id of ids) {
        if (missingIds.includes(id)) continue;
        m.set(id, buildRawFactsFromRows({ property: { property_id: id, tax_delinquent: id.endsWith('-0'), owner_location: 'Absentee Owner', equity_percent: 70, ownership_years: 12, estimated_value: 200_000, total_loan_balance: 20_000, year_built: 1960, tax_amt: 2_000, building_condition: 'Average' }, features: { property_id: id, as_of_date: '2026-08-07', phy_is_vacant: false, prt_total_properties: 1, fcl_any: false, life_probate: false, lien_active: false, eqt_ltv: 0.1 } }));
      }
      return m;
    },
    async loadExisting(ids) { return ids.filter((id) => scores.has(id)).map((id) => scores.get(id)); },
    async upsertRows(r) {
      if (upFail) { upFail = false; throw new Error('503 service unavailable'); }
      writes.upserts += 1;
      for (const row of r) scores.set(row.property_id, row);
    },
    async logFailures(f) { writes.logs += 1; failures.push(...f); },
  };
}

const startedState = (store, overrides = {}) => applyStart(initialState(NIGHT), { now: NIGHT, runId: 'run-1', activeMarkets: ['Houston, TX'], ...overrides });

test('phases: baseline active markets first (Dallas, Houston, Minneapolis, Tampa), live markets next, then nationwide excluding them', () => {
  const p = buildPhases(['Los Angeles, CA', 'Dallas, TX']);
  assert.deepEqual(p.slice(0, 5).map((x) => x.market), [...BASELINE_ACTIVE_MARKETS, 'Los Angeles, CA']);
  assert.equal(p.at(-1).kind, 'nationwide');
  assert.deepEqual(p.at(-1).exclude_markets, [...BASELINE_ACTIVE_MARKETS, 'Los Angeles, CA']);
});

test('run: scores active markets before nationwide, every property exactly once, completes', async () => {
  const store = fakeStore();
  await store.writeState(startedState(store));
  const order = [];
  const orig = store.upsertRows.bind(store);
  store.upsertRows = async (rows) => { order.push(...rows.map((r) => r.property_id)); return orig(rows); };
  const s = await runTick({ store, clock: () => NIGHT, sleep: async () => {}, configOverrides: { batch_size: 2 } });
  assert.equal(s.stopped_because, 'universe_exhausted');
  assert.equal(store.state.status, STATUS.COMPLETED);
  assert.equal(store.scores.size, 14);
  assert.deepEqual(order.slice(0, 8).map((id) => id.slice(0, 3)), ['Dal', 'Dal', 'Dal', 'Dal', 'Dal', 'Hou', 'Hou', 'Hou']);
  assert.equal(new Set(order).size, order.length, 'no property scored twice');
  const row = store.scores.get('Dal-0');
  assert.equal(row.score_version, 'seller_situation_v2');
  assert.equal(row.input_model_version, 'raw_facts_v1');
  assert.equal(row.weights_version, WEIGHTS_VERSION);
  assert.equal(row.features_as_of, '2026-08-07');
});

test('batched: one raw-facts load and one upsert per chunk (never per property)', async () => {
  const store = fakeStore();
  await store.writeState(startedState(store));
  let loads = 0;
  const orig = store.loadRawFacts.bind(store);
  store.loadRawFacts = async (ids) => { loads += 1; return orig(ids); };
  const s = await runTick({ store, clock: () => NIGHT, sleep: async () => {}, configOverrides: { batch_size: 200 } });
  assert.equal(s.scored, 14);
  assert.equal(loads, store.writes.upserts);
  assert.ok(loads <= 4, `${loads} loads for 4 phases`);
});

test('resumable: a capped tick persists the cursor; the next tick continues, never restarts from zero', async () => {
  const store = fakeStore();
  await store.writeState(startedState(store));
  const a = await runTick({ store, clock: () => NIGHT, sleep: async () => {}, maxProperties: 4, configOverrides: { batch_size: 2 } });
  assert.equal(a.stopped_because, 'max_properties');
  assert.equal(store.scores.size, 4);
  const cursor = store.state.cursor_property_id;
  assert.ok(cursor);
  const b = await runTick({ store, clock: () => NIGHT, sleep: async () => {}, configOverrides: { batch_size: 2 } });
  assert.equal(b.scored, 10);
  assert.equal(store.scores.size, 14);
  // resume after pause keeps the cursor; a model change (new run_version) or --fresh does not
  const paused = applyPause(parseState(JSON.stringify({ ...store.state, status: 'running', phase_index: 1, cursor_property_id: 'Hou-1' })));
  const resumed = applyStart(paused, { now: NIGHT, runId: 'run-2' });
  assert.equal(resumed.cursor_property_id, 'Hou-1');
  assert.equal(resumed.run_id, 'run-1');
  assert.equal(applyStart(paused, { now: NIGHT, runId: 'run-2', fresh: true }).cursor_property_id, null);
  assert.equal(applyStart({ ...paused, run_version: 'old' }, { now: NIGHT, runId: 'run-2' }).cursor_property_id, null);
});

test('idempotent: rerunning skips rows already at this exact version + feature snapshot', async () => {
  const store = fakeStore();
  await store.writeState(startedState(store));
  await runTick({ store, clock: () => NIGHT, sleep: async () => {} });
  await store.writeState(applyStart(store.state, { now: NIGHT, runId: 'run-3', fresh: true, activeMarkets: [] }));
  const again = await runTick({ store, clock: () => NIGHT, sleep: async () => {} });
  assert.equal(again.scored, 0);
  assert.equal(again.skipped_existing, 14);
  const ex = { score_version: 'seller_situation_v2', input_model_version: 'raw_facts_v1', weights_version: WEIGHTS_VERSION, features_as_of: '2026-08-07' };
  assert.equal(shouldSkipExisting(ex, '2026-08-07'), true);
  assert.equal(shouldSkipExisting(ex, '2026-11-01'), false, 'features rebuilt => rescore');
  assert.equal(shouldSkipExisting({ ...ex, weights_version: 'old' }, '2026-08-07'), false);
});

test('dry run writes NOTHING: no state, no score, no failure log — and never moves the saved cursor', async () => {
  const store = fakeStore({ missingIds: ['Dal-1'] });
  const saved = { ...startedState(store), cursor_property_id: 'Dal-3' };
  await store.writeState(saved);
  const before = { ...store.writes };
  const s = await runTick({ store, dryRun: true, clock: () => DAY, sleep: async () => {}, dryRunPhases: [{ kind: 'ids', ids: ['Dal-0', 'Dal-1', 'Hou-0'] }] });
  assert.equal(s.scored, 2);
  assert.equal(s.failed, 1);
  assert.deepEqual(store.writes, before);
  assert.equal(store.state.cursor_property_id, 'Dal-3');
  assert.ok(s.metrics.row_bytes.mean > 0 && s.metrics.row_bytes.mean < 15_000);
});

test('the pg store refuses writes unless built with writes:true, and sets a read-only session', async () => {
  const sqls = [];
  const client = { async query(sql) { sqls.push(sql); return { rows: [{ ok: true, value: null }] }; } };
  const store = createSellerSituationStore({ client, writes: false });
  await assert.rejects(() => store.upsertRows([{ property_id: 'x' }]), /write_refused/);
  await assert.rejects(() => store.writeState({}), /write_refused/);
  await assert.rejects(() => store.logFailures([{ property_id: 'x' }]), /write_refused/);
  await store.readContactWindow();
  assert.ok(sqls.some((q) => /default_transaction_read_only = on/.test(q)));
  assert.match(upsertSql(), /on conflict \(property_id\) do update/);
  assert.match(upsertSql(), /jsonb_to_recordset/);
});

test('gates: inside the contact window the run pauses without backoff; DB load arms backoff', async () => {
  const day = fakeStore();
  await day.writeState(startedState(day));
  const a = await runTick({ store: day, clock: () => DAY, sleep: async () => {} });
  assert.equal(a.stopped_because, 'sending_window');
  assert.equal(day.scores.size, 0);
  assert.equal(day.state.backoff.until, null);
  const busy = fakeStore({ probe: { ok: true, active_backends: 40, long_running: 3, lock_waits: 0, latency_ms: 5 } });
  await busy.writeState(startedState(busy));
  const b = await runTick({ store: busy, clock: () => NIGHT, sleep: async () => {} });
  assert.equal(b.stopped_because, 'db_load');
  assert.ok(busy.state.backoff.until);
  const unavailable = fakeStore({ probe: { ok: false, error: 'x' } });
  await unavailable.writeState(startedState(unavailable));
  assert.equal((await runTick({ store: unavailable, clock: () => NIGHT, sleep: async () => {} })).stopped_because, 'db_load', 'fails closed');
});

test('transient load / upsert failures do not advance the cursor; deterministic failures are logged by id', async () => {
  const store = fakeStore({ failRawFactsOnce: true, missingIds: ['Dal-2'] });
  await store.writeState(startedState(store));
  const a = await runTick({ store, clock: () => NIGHT, sleep: async () => {} });
  assert.equal(a.stopped_because, 'load_failed');
  assert.equal(store.state.cursor_property_id, null);
  assert.ok(store.state.backoff.until);
  // backoff blocks the next tick until it expires
  assert.equal((await runTick({ store, clock: () => NIGHT, sleep: async () => {} })).stopped_because, 'backoff_active');
  const later = new Date(NIGHT.valueOf() + 3 * 60 * 60_000);
  const b = await runTick({ store, clock: () => later, sleep: async () => {} });
  assert.equal(b.stopped_because, 'universe_exhausted');
  assert.equal(store.scores.size, 13);
  assert.deepEqual(store.failures.map((f) => [f.property_id, f.error, f.run_version]), [['Dal-2', 'no_source_rows', RUN_VERSION]]);

  const up = fakeStore({ failUpsertOnce: true });
  await up.writeState(startedState(up));
  const c = await runTick({ store: up, clock: () => NIGHT, sleep: async () => {} });
  assert.equal(c.stopped_because, 'upsert_failed');
  assert.equal(up.state.cursor_property_id, null, 'chunk will be retried');
});

test('estimate: duration + growth from measured ms/property and bytes/row', () => {
  const e = estimateNationwide({ msPerProperty: 2, rowBytesMean: 1126, universe: 176_610 });
  assert.ok(e.total_hours_continuous > 0 && e.total_hours_continuous < 3);
  assert.ok(e.db_growth_mb_est > 200 && e.db_growth_mb_est < 600);
});
