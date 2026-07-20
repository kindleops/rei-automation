// P3-2 §3A: historically reconstructable backtest protocol.
// A feature may enter a historical backtest ONLY if every dependency class is
// reconstructable at the historical as-of. Current-state fields must never be
// backdated. Violations REJECT the record (loudly), never silently pass.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toMs } from '../lib/timeSafety.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ELIGIBILITY_CSV = join(HERE, '..', '..', '..', 'docs', 'seller-engine', 'phase3',
  'SELLER_HISTORICAL_FEATURE_ELIGIBILITY.csv');

export const CLASSES = Object.freeze({
  RECONSTRUCTABLE: 'historically_reconstructable',
  EVENT_HISTORY: 'reconstructable_only_with_event_history',
  CURRENT_STATE: 'current_state_only',
  UNKNOWN: 'unknown',
  PROHIBITED: 'prohibited_from_historical_backtest',
});

export function loadEligibility() {
  const text = readFileSync(ELIGIBILITY_CSV, 'utf8');
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',');
  const rows = lines.map((l) => {
    const parts = l.match(/("([^"]|"")*"|[^,]*)/g).filter((x, i, a) => x !== '' || a[i - 1] === ',').slice(0, cols.length);
    // simple split fallback (our CSV has no embedded commas in key columns)
    const cells = l.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? '').replace(/^"|"$/g, '')]));
  });
  const byFeature = new Map();
  for (const r of rows) {
    (byFeature.get(r.feature_id) ?? byFeature.set(r.feature_id, []).get(r.feature_id)).push(r);
  }
  return byFeature;
}

// A feature is historically eligible iff ALL of its dependencies are
// RECONSTRUCTABLE (document/event-dated) or EVENT_HISTORY when event history
// is supplied. CURRENT_STATE / UNKNOWN / PROHIBITED disqualify.
export function eligibleFeatureIds({ withEventHistory = false } = {}) {
  const byFeature = loadEligibility();
  const ok = [];
  for (const [fid, deps] of byFeature) {
    const good = deps.every((d) => d.eligibility_class === CLASSES.RECONSTRUCTABLE
      || (withEventHistory && d.eligibility_class === CLASSES.EVENT_HISTORY));
    if (good) ok.push(fid);
  }
  return new Set(ok);
}

export class VintageLeakageError extends Error {}

// Validate a historical scoring row: every feature present must be eligible,
// and its evidence must be dated at-or-before the historical as-of.
export function validateHistoricalFeatureRow(features, historicalAsOf, { withEventHistory = false } = {}) {
  const allowed = eligibleFeatureIds({ withEventHistory });
  const cut = toMs(historicalAsOf);
  const rejected = [];
  for (const f of features) {
    if (f.value_state !== 'known') continue;
    if (!allowed.has(f.feature_id)) {
      rejected.push({ feature_id: f.feature_id, reason: 'not_historically_eligible' });
      continue;
    }
    for (const ev of f.source_evidence ?? []) {
      const d = ev.date ?? ev.recording_date ?? ev.filing_date ?? ev.sale_date ?? null;
      if (d !== null && toMs(d) !== null && toMs(d) > cut) {
        rejected.push({ feature_id: f.feature_id, reason: `evidence_after_as_of:${d}` });
      }
    }
  }
  if (rejected.length) {
    const err = new VintageLeakageError(
      `historical backtest rejects record: ${rejected.length} ineligible/leaking feature(s): `
      + rejected.slice(0, 5).map((r) => `${r.feature_id}(${r.reason})`).join(', '));
    err.rejected = rejected;
    throw err;
  }
  return { accepted: features.filter((f) => allowed.has(f.feature_id) || f.value_state !== 'known').length };
}

// Vintage-pair construction: score vintage batch B_t, label vintage batch
// B_{t+h} (or recorder joins). Both sides carry batch lineage; scoring reads
// ONLY B_t rows; labels read ONLY later-vintage transfer evidence.
export function buildVintagePair({ scoreBatch, labelBatch }) {
  const scoreMax = toMs(scoreBatch.scraped_at_max);
  const labelMin = toMs(labelBatch.scraped_at_min);
  if (scoreMax === null || labelMin === null) throw new VintageLeakageError('vintage pair requires dated batches');
  if (labelMin <= scoreMax) {
    throw new VintageLeakageError(
      `label vintage must strictly follow score vintage (label_min ${labelBatch.scraped_at_min} <= score_max ${scoreBatch.scraped_at_max})`);
  }
  return {
    pair_id: `${scoreBatch.id}__${labelBatch.id}`,
    score_batch: scoreBatch.id, label_batch: labelBatch.id,
    as_of: scoreBatch.scraped_at_max,
    observed_through: labelBatch.scraped_at_max,
    horizon_days_available: Math.floor((toMs(labelBatch.scraped_at_max) - scoreMax) / 86_400_000),
  };
}
