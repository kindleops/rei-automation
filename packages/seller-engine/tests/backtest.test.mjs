import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liftAtK, compareScorers, stabilityProbe, calibrationBins } from '../backtest/harness.mjs';

test('liftAtK: perfect scorer gets max lift; UNAVAILABLE when no positives (never zero-performance)', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ score: i, label: i >= 190 ? 1 : 0 }));
  const r = liftAtK(rows, { fraction: 0.05 });
  assert.equal(r.state, 'ok');
  assert.equal(r.top_rate, 1);
  assert.equal(r.lift, Math.round((1 / 0.05) * 1000) / 1000);
  const empty = liftAtK(rows.map((x) => ({ ...x, label: 0 })), { fraction: 0.05 });
  assert.equal(empty.state, 'UNAVAILABLE');
  assert.match(empty.reason, /no positive/);
});

test('censored rows are excluded from denominators and reported', () => {
  const rows = [
    { property_id: 'a', as_of: '2026-01-01', labels: { sale_90d: 'positive' }, scores: { v1: 10 } },
    { property_id: 'b', as_of: '2026-01-01', labels: { sale_90d: 'negative' }, scores: { v1: 1 } },
    { property_id: 'c', as_of: '2026-01-01', labels: { sale_90d: 'censored' }, scores: { v1: 99 } },
  ];
  const rep = compareScorers({ rows, scorers: ['v1'], horizons: [90] });
  assert.equal(rep.sale_90d.eligible, 2);
  assert.equal(rep.sale_90d.censored_excluded, 1);
});

test('calibration: UNAVAILABLE on insufficient rows, bins otherwise', () => {
  const small = calibrationBins([{ score: 1, label: 0 }]);
  assert.equal(small.state, 'UNAVAILABLE');
  const rows = Array.from({ length: 200 }, (_, i) => ({ score: i / 200, label: i / 200 > Math.random() ? 1 : 0 }));
  assert.equal(calibrationBins(rows).state, 'ok');
});

test('T-15 stability probe: one-document delta stays within bound for a smooth scorer', () => {
  const scoreFn = (b) => ({ execution_priority: (b.liens?.length ?? 0) * 5 + (b.tax ? 20 : 0) });
  const r = stabilityProbe(scoreFn, { liens: [1, 2], tax: true },
    (b) => { b.liens.push(3); return b; }, { maxDelta: 10 });
  assert.equal(r.within_bound, true);
});
