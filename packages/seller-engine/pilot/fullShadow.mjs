#!/usr/bin/env node
// Freezes the COMPLETE prospective shadow cohort (all 19,909 canonical pilot
// properties) as the primary evaluation cohort, plus a systematic 1-in-6
// validation sample derived from the frozen full records (no re-scoring). The
// chunked synchronous writer removed the original memory limit. Cohort
// percentiles use buckets built from the already-persisted DB scores.
import { readFileSync, writeFileSync, mkdirSync, createReadStream, openSync, writeSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../lib/hash.mjs';
import { VAR_DIR } from '../lib/store.mjs';
import { num, psql, PILOT_DIR } from './pg.mjs';
import { assembleBundles } from './bundles.mjs';
import { buildCohortBuckets } from '../scores/priorityContract.mjs';
import { createShadowCohort, REGISTRY_SHA } from '../shadow/createShadowCohort.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = JSON.parse(readFileSync(join(PILOT_DIR, 'state.json'), 'utf8'));
const SAMPLE_EVERY = 6;

function cohortBucketsFromDB() {
  // raw execution priority per property + its cohort dimensions
  const rows = psql(`select p.asset_class, p.situs_state, ss.score
    from seller_engine.seller_score_snapshots ss
    join seller_engine.seller_feature_snapshots fs on fs.id = ss.feature_snapshot_id
    join seller_engine.properties p on p.id = fs.property_id
    where ss.family = 'execution_priority'`)
    .split('\n').filter(Boolean).map((l) => {
      const [asset_class, situs_state, raw] = l.split('|');
      return { asset_class: asset_class || 'unknown', situs_state: situs_state || 'unknown', raw: Number(raw) || 0 };
    });
  return { buckets: buildCohortBuckets(rows), n: rows.length };
}

async function main() {
  const propsBatch = STATE.batches.properties;
  const asOf = (STATE.stages.score?.as_of)
    ?? (readFileSync(join(PILOT_DIR, 'state.json'), 'utf8'), new Date().toISOString());
  const { buckets, n: bucketN } = cohortBucketsFromDB();

  const { bundles } = assembleBundles({
    batches: STATE.batches, sidecarPath: STATE.batches.prospects?.sidecar ?? null,
  });

  // ---- primary: full cohort (dedup handled inside createShadowCohort).
  // Skip the ~7-min re-score if an identical frozen cohort already exists.
  const fullName = `pilot_full_${propsBatch.id.slice(0, 18)}_${asOf.slice(0, 10)}`;
  const fullDir = join(VAR_DIR, 'shadow', fullName);
  const manifestPath = join(fullDir, 'manifest.json');
  let full;
  const existing = (() => { try { return JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return null; } })();
  if (existing && existing.size === 19909) {
    console.log(`reusing frozen full cohort (${existing.size} records, hash ${existing.cohort_hash.slice(0, 12)})`);
    full = { manifest: existing, dir: fullDir };
  } else {
    full = createShadowCohort({ bundles, asOf, cohortName: fullName, buckets, role: 'primary' });
  }

  // ---- single streaming pass over the frozen full records: derive the
  // validation sample AND verify every gate (files are >512MB → never slurp)
  const sampleName = `pilot_sample_${propsBatch.id.slice(0, 18)}_${asOf.slice(0, 10)}`;
  const sampleDir = join(VAR_DIR, 'shadow', sampleName);
  mkdirSync(sampleDir, { recursive: true });
  const sampleFd = openSync(join(sampleDir, 'records.ndjson'), 'w');
  let sampleHashAccum = []; let sampleSize = 0;
  const ids = new Set(); let dupeIds = 0; let hashFails = 0; let featCountFails = 0;
  let reproFold = []; let recCount = 0; let idx = 0;
  const rl = createInterface({ input: createReadStream(join(full.dir, 'records.ndjson')), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    recCount += 1;
    if (ids.has(r.property_id)) dupeIds += 1; else ids.add(r.property_id);
    if (sha256(JSON.stringify({ ...r, record_hash: null })) !== r.record_hash) hashFails += 1;
    if (r.feature_count !== 87) featCountFails += 1;
    reproFold.push(r.record_hash);
    if (reproFold.length >= 5000) reproFold = [sha256(reproFold.join(''))];
    if (idx % SAMPLE_EVERY === 0) {
      writeSync(sampleFd, line + '\n');
      sampleHashAccum.push(r.record_hash); sampleSize += 1;
      if (sampleHashAccum.length >= 5000) sampleHashAccum = [sha256(sampleHashAccum.join(''))];
    }
    idx += 1;
  }
  closeSync(sampleFd);
  const reproCohortHash = sha256(reproFold.join(''));
  const canonProps = num('select count(*) from seller_engine.properties');

  const sampleManifest = {
    cohort: sampleName, role: 'validation_sample', derived_from: fullName,
    created_at: new Date().toISOString(), as_of: asOf, size: sampleSize,
    sampling: `systematic 1-in-${SAMPLE_EVERY} of the frozen full cohort (no re-scoring)`,
    cohort_hash: sha256(sampleHashAccum.join('')), registry_sha: REGISTRY_SHA,
    horizons_days: [30, 90, 180, 365],
  };
  writeFileSync(join(sampleDir, 'manifest.json'), JSON.stringify(sampleManifest, null, 2));

  const verify = {
    exactly_19909: recCount === canonProps && recCount === 19909,
    record_count: recCount, distinct_property_ids: ids.size,
    duplicate_property_ids: dupeIds,
    all_record_hashes_valid: hashFails === 0, record_hash_failures: hashFails,
    all_87_features_present: featCountFails === 0, feature_count_failures: featCountFails,
    cohort_hash_reproducible: reproCohortHash === full.manifest.cohort_hash,
    manifest_cohort_hash: full.manifest.cohort_hash, recomputed_cohort_hash: reproCohortHash,
    cohort_bucket_source_rows: bucketN,
  };

  STATE.stages.full_shadow = {
    at: new Date().toISOString(),
    primary: { name: fullName, size: recCount, hash: full.manifest.cohort_hash, dir: full.dir },
    validation_sample: { name: sampleName, size: sampleSize, hash: sampleManifest.cohort_hash, dir: sampleDir },
    verify,
  };
  writeFileSync(join(PILOT_DIR, 'state.json'), JSON.stringify(STATE, null, 2));
  console.log(JSON.stringify({ primary: fullName, primary_size: recCount, primary_hash: full.manifest.cohort_hash,
    sample_size: sampleSize, sample_hash: sampleManifest.cohort_hash, verify }, null, 2));
}

await main();
