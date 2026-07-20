#!/usr/bin/env node
// Evaluate a frozen shadow cohort against outcome events observed AFTER the
// cohort's scoring timestamp. Reproducibility first: re-verifies record hashes
// before grading; any drift fails the evaluation.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../lib/hash.mjs';
import { VAR_DIR } from '../lib/store.mjs';
import { labelState } from '../lib/timeSafety.mjs';
import { liftAtK, TOP_FRACTIONS } from '../backtest/harness.mjs';

export function loadCohort(cohortName) {
  const dir = join(VAR_DIR, 'shadow', cohortName);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const records = readFileSync(join(dir, 'records.ndjson'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  return { manifest, records };
}

export function verifyCohortIntegrity({ manifest, records }) {
  const problems = [];
  for (const r of records) {
    const h = sha256(JSON.stringify({ ...r, record_hash: null }));
    if (h !== r.record_hash) problems.push({ property_id: r.property_id, reason: 'record_hash_mismatch' });
  }
  const ch = sha256(records.map((r) => r.record_hash).join(''));
  if (ch !== manifest.cohort_hash) problems.push({ reason: 'cohort_hash_mismatch' });
  return { intact: problems.length === 0, problems };
}

// outcomes: canonical event rows (see outcomes/CONTRACT.md); only events with
// event_ts AFTER the cohort as_of may grade it.
export function evaluateShadowCohort({ manifest, records }, outcomes, { observedThrough }) {
  const integrity = verifyCohortIntegrity({ manifest, records });
  if (!integrity.intact) return { state: 'FAILED_INTEGRITY', integrity };
  const byProp = new Map();
  for (const o of outcomes) {
    if (o.family !== 'verified_sale') continue;
    const cur = byProp.get(o.property_id);
    if (!cur || o.event_ts < cur.event_ts) byProp.set(o.property_id, o);
  }
  const report = { cohort: manifest.cohort, as_of: manifest.as_of, evaluated_at: new Date().toISOString(), horizons: {} };
  for (const h of manifest.horizons_days) {
    const rows = records.map((r) => {
      const ev = byProp.get(r.property_id) ?? null;
      const st = labelState(ev?.event_ts ?? null, manifest.as_of, h, observedThrough);
      return { st, v1: r.deterministic_v1_score ?? 0, v12: r.v12_score ?? 0 };
    });
    const eligible = rows.filter((r) => r.st === 'positive' || r.st === 'negative');
    const censored = rows.length - eligible.length;
    const mk = (key) => Object.fromEntries(TOP_FRACTIONS.map((fr) => [String(fr),
      liftAtK(eligible.map((r) => ({ score: r[key], label: r.st === 'positive' ? 1 : 0 })), { fraction: fr })]));
    report.horizons[`${h}d`] = {
      eligible: eligible.length, censored,
      positives: eligible.filter((r) => r.st === 'positive').length,
      deterministic_v1: mk('v1'), v12_baseline: mk('v12'),
    };
  }
  return { state: 'ok', integrity, report };
}
