#!/usr/bin/env node
// Repairs STATE.stages.score (the shadow-write RangeError aborted before it
// saved) and freezes the prospective shadow cohort as a deterministic
// systematic sample (memory-safe streaming). Scoring snapshots are already in
// the pilot DB from score.mjs; this does NOT re-merge them.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { num, PILOT_DIR } from './pg.mjs';
import { readPartition } from '../lib/store.mjs';
import { loadV1Config } from '../scores/deterministicV1.mjs';
import { assembleBundles } from './bundles.mjs';
import { createShadowCohort } from '../shadow/createShadowCohort.mjs';

const STATE = JSON.parse(readFileSync(join(PILOT_DIR, 'state.json'), 'utf8'));
const SAMPLE_EVERY = 6;   // ~1-in-6 systematic sample => ~3,300 frozen records

async function main() {
  const propsBatch = STATE.batches.properties;
  const batchRow = readPartition('import_batches', propsBatch.id)[0] ?? {};
  const asOf = batchRow.scraped_at_max ?? new Date().toISOString();
  const { versionId } = loadV1Config();

  // repair score stage from the DB (scoring already persisted)
  const scored = num('select count(distinct property_id) from seller_engine.seller_feature_snapshots');
  const routeCsv = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'SELLER_PILOT_SCORE_DISTRIBUTIONS.csv'), 'utf8');
  const routes = {};
  let inRoutes = false;
  for (const line of routeCsv.split('\n')) {
    if (line.startsWith('route,count')) { inRoutes = true; continue; }
    if (inRoutes && line.includes(',')) { const [r, n] = line.split(','); routes[r] = Number(n); }
  }

  // freeze shadow: systematic sample of the assembled bundles
  const { bundles, liveRate } = assembleBundles({
    batches: STATE.batches, sidecarPath: STATE.batches.prospects?.sidecar ?? null,
  });
  const seen = new Set();
  const sample = bundles.filter((b, i) => {
    if (seen.has(b.property.id)) return false;          // dedup the 86 in-file dupes
    seen.add(b.property.id);
    return i % SAMPLE_EVERY === 0;
  });
  const shadow = createShadowCohort({
    bundles: sample, asOf,
    cohortName: `pilot_${propsBatch.id.slice(0, 18)}_${asOf.slice(0, 10)}`,
  });

  STATE.stages.score = {
    at: new Date().toISOString(), as_of: asOf, engine_version: versionId,
    scored, of: bundles.length, scalar_liveness: liveRate, routes,
    snapshot_rows: {
      seller_feature_snapshots: num('select count(*) from seller_engine.seller_feature_snapshots'),
      seller_score_snapshots: num('select count(*) from seller_engine.seller_score_snapshots'),
      seller_score_explanations: num('select count(*) from seller_engine.seller_score_explanations'),
    },
    shadow_cohort: { name: shadow.manifest.cohort, size: shadow.manifest.size,
      hash: shadow.manifest.cohort_hash, sampling: `systematic 1-in-${SAMPLE_EVERY}`, dir: shadow.dir },
  };
  writeFileSync(join(PILOT_DIR, 'state.json'), JSON.stringify(STATE, null, 2));
  console.log(JSON.stringify({ scored, shadow_size: shadow.manifest.size, shadow_hash: shadow.manifest.cohort_hash, routes }, null, 2));
}

await main();
