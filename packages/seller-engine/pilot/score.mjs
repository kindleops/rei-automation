#!/usr/bin/env node
// Pilot scoring: assemble bundles from staged pilot batches, run the LOCKED
// deterministic V1 (no logic changes here — this is a consumer), persist
// feature/score/explanation snapshots to the pilot DB, emit coverage and
// distribution CSVs, and freeze the prospective shadow cohort.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deterministicId } from '../lib/hash.mjs';
import { readPartition } from '../lib/store.mjs';
import { computeFeatures } from '../features/engine.mjs';
import { scoreDeterministicV1, loadV1Config } from '../scores/deterministicV1.mjs';
import { scoreV12Baseline, loadV12Config } from '../scores/v12Baseline.mjs';
import { createShadowCohort } from '../shadow/createShadowCohort.mjs';
import { assembleBundles } from './bundles.mjs';
import { TABLES } from './tables.mjs';
import { truncateStages, mergeAll, ensureStageTables } from './load.mjs';
import { copyIn, csvCell, PILOT_DIR } from './pg.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = JSON.parse(readFileSync(join(PILOT_DIR, 'state.json'), 'utf8'));
const FLUSH_AT = 10000;

const enc = (table, row) => Object.keys(TABLES[table].cols).map((c) => csvCell(row[c])).join(',');

export async function scorePilot({ freezeShadow = true } = {}) {
  const t0 = Date.now();
  const { cfg, versionId } = loadV1Config();
  const v12v = loadV12Config().versionId;
  const propsBatch = STATE.batches.properties;
  // as-of = the batch's own scrape ceiling: leakage guards then prove every
  // dated input predates it (T-10)
  const batchRow = readPartition('import_batches', propsBatch.id)[0] ?? {};
  const asOf = batchRow.scraped_at_max ?? new Date().toISOString();

  const { bundles, liveRate } = assembleBundles({
    batches: STATE.batches, sidecarPath: STATE.batches.prospects?.sidecar ?? null,
  });

  const snapTables = ['seller_engine_versions', 'seller_feature_snapshots', 'seller_score_snapshots', 'seller_score_explanations'];
  ensureStageTables();   // snapshot stage tables were added after init ran
  truncateStages(snapTables);
  const buffers = Object.fromEntries(snapTables.map((t) => [t, []]));
  const flush = async (force = false) => {
    for (const [t, lines] of Object.entries(buffers)) {
      if (lines.length && (force || lines.length >= FLUSH_AT)) {
        await copyIn(`seller_engine.stage_${t}`, Object.keys(TABLES[t].cols), lines);
        buffers[t] = [];
      }
    }
  };

  buffers.seller_engine_versions.push(
    enc('seller_engine_versions', { id: versionId, name: cfg.engine, semver: cfg.semver, config_sha256: versionId.split('cfg.')[1], weight_class: cfg.weight_class, notes: 'pilot scoring run (candidate lock)' }),
    enc('seller_engine_versions', { id: v12v, name: 'seller_engine_v12_baseline', semver: '12.1.0-exact-port', config_sha256: v12v.split('cfg.')[1] ?? '', weight_class: 'reconstructed_legacy', notes: 'quarantined comparison baseline' }),
  );

  const covCounts = new Map();   // feature_id -> {known, unknown, blocked, not_applicable}
  const famValues = new Map();   // family -> number[]
  const routes = new Map();
  const errors = [];
  let scored = 0;
  const shadowBundles = [];

  for (const b of bundles) {
    let feats;
    try { feats = computeFeatures(b, asOf); } catch (e) {
      errors.push({ property_id: b.property.id, error: String(e.message).slice(0, 200) });
      continue;
    }
    const v1 = scoreDeterministicV1(feats.features);
    const fsId = deterministicId('fsnap', b.property.id, asOf, versionId);
    buffers.seller_feature_snapshots.push(enc('seller_feature_snapshots', {
      id: fsId, property_id: b.property.id, as_of: asOf, engine_version_id: versionId,
      features: feats.features, inputs_max_observed_at: feats.inputs_max_observed_at,
    }));
    for (const [family, fam] of Object.entries(v1.families)) {
      const ssId = deterministicId('fam', fsId, family);
      buffers.seller_score_snapshots.push(enc('seller_score_snapshots', {
        id: ssId, feature_snapshot_id: fsId, engine_version_id: versionId,
        family, score: fam.score, score_state: fam.score_state, confidence: fam.confidence,
      }));
      (famValues.get(family) ?? famValues.set(family, []).get(family)).push(fam.score);
    }
    const epId = deterministicId('fam', fsId, 'execution_priority');
    v1.explanations.forEach((e, i) => {
      buffers.seller_score_explanations.push(enc('seller_score_explanations', {
        id: deterministicId('exp', epId, i), score_snapshot_id: epId,
        direction: e.direction, component: e.component,
        contribution: typeof e.contribution === 'number' ? e.contribution : null,
        evidence: e.evidence ?? {},
      }));
    });
    // v12 comparison row rides as an extra score family (documented)
    const v12 = scoreV12Baseline(b);
    buffers.seller_score_snapshots.push(enc('seller_score_snapshots', {
      id: deterministicId('fam', fsId, 'v12_baseline_priority'), feature_snapshot_id: fsId,
      engine_version_id: v12v, family: 'v12_baseline_priority',
      score: v12.priority, score_state: 'scored', confidence: null,
    }));
    for (const f of feats.features) {
      const c = covCounts.get(f.feature_id) ?? { known: 0, unknown: 0, blocked: 0, not_applicable: 0 };
      c[f.value_state] = (c[f.value_state] ?? 0) + 1;
      covCounts.set(f.feature_id, c);
    }
    routes.set(v1.route, (routes.get(v1.route) ?? 0) + 1);
    scored += 1;
    shadowBundles.push(b);
    if (scored % 2000 === 0) { await flush(); console.log(`scored ${scored}/${bundles.length}`); }
  }
  await flush(true);
  const merged = await mergeAll(snapTables, propsBatch.id);

  // ---- coverage CSV
  const covLines = ['feature_id,known,unknown,blocked,not_applicable,known_rate'];
  for (const [fid, c] of [...covCounts.entries()].sort()) {
    const total = c.known + c.unknown + c.blocked + c.not_applicable;
    covLines.push(`${fid},${c.known},${c.unknown},${c.blocked},${c.not_applicable},${(c.known / Math.max(total, 1)).toFixed(4)}`);
  }
  writeFileSync(join(PKG, 'SELLER_PILOT_FEATURE_COVERAGE.csv'), covLines.join('\n') + '\n');

  // ---- distribution CSV
  const q = (arr, p) => {
    const a = arr.filter((x) => x !== null && x !== undefined).sort((x, y) => x - y);
    if (!a.length) return '';
    return a[Math.min(a.length - 1, Math.floor(p * a.length))];
  };
  const distLines = ['family,n_scored,n_null,min,p25,median,p75,p90,p99,max,mean'];
  for (const [family, vals] of [...famValues.entries()].sort()) {
    const a = vals.filter((x) => x !== null && x !== undefined);
    const mean = a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : '';
    distLines.push([family, a.length, vals.length - a.length, q(vals, 0), q(vals, 0.25), q(vals, 0.5),
      q(vals, 0.75), q(vals, 0.9), q(vals, 0.99), q(vals, 0.999999), mean].join(','));
  }
  distLines.push('');
  distLines.push('route,count');
  for (const [r, n] of [...routes.entries()].sort((a2, b2) => b2[1] - a2[1])) distLines.push(`${r},${n}`);
  writeFileSync(join(PKG, 'SELLER_PILOT_SCORE_DISTRIBUTIONS.csv'), distLines.join('\n') + '\n');

  // ---- prospective shadow cohort (frozen)
  let shadow = null;
  if (freezeShadow) {
    shadow = createShadowCohort({
      bundles: shadowBundles, asOf,
      cohortName: `pilot_${propsBatch.id.slice(0, 18)}_${asOf.slice(0, 10)}`,
    });
  }

  const summary = {
    as_of: asOf, engine_version: versionId, scored, of: bundles.length,
    scoring_errors: errors.length, scalar_liveness: liveRate,
    snapshot_rows: Object.fromEntries(Object.entries(merged).map(([t, s]) => [t, s.canonical_total])),
    routes: Object.fromEntries(routes),
    shadow_cohort: shadow ? { name: shadow.manifest.cohort, size: shadow.manifest.size, hash: shadow.manifest.cohort_hash } : null,
    errors: errors.slice(0, 20),
    ms: Date.now() - t0,
  };
  STATE.stages.score = { at: new Date().toISOString(), ...summary };
  writeFileSync(join(PILOT_DIR, 'state.json'), JSON.stringify(STATE, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await scorePilot({ freezeShadow: !process.argv.includes('--no-shadow') });
}
