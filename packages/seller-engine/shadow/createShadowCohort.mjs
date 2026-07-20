#!/usr/bin/env node
// P3-2 §3B: prospective shadow validation — freeze everything needed to grade
// today's scores against future 30/90/180/365-day outcomes. Scoring and
// observation ONLY: no messages, no seller-operations changes.
import { mkdirSync, writeFileSync, existsSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../lib/hash.mjs';
import { VAR_DIR, readAll } from '../lib/store.mjs';
import { computeFeatures } from '../features/engine.mjs';
import { scoreDeterministicV1, loadV1Config } from '../scores/deterministicV1.mjs';
import { scoreV12Baseline, loadV12Config } from '../scores/v12Baseline.mjs';
import { formalizePriority } from '../scores/priorityContract.mjs';

// registry sha computed once (feature-registry code identity for the record)
export const REGISTRY_SHA = sha256(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'features', 'registry.mjs'), 'utf8'));

export function freezeShadowRecord(bundle, asOf, { registryHash = REGISTRY_SHA, buckets = null } = {}) {
  const canonicalInputHash = sha256(JSON.stringify({
    property: bundle.property, valuation: bundle.valuation, loans: bundle.loans,
    liens: bundle.liens, foreclosure: bundle.foreclosure, transactions: bundle.transactions,
    links: bundle.links, phones: bundle.phones, emails: bundle.emails,
  }));
  const feats = computeFeatures(bundle, asOf, { compSnapshot: bundle.compSnapshot ?? null });
  const v1 = scoreDeterministicV1(feats.features);
  const v12 = scoreV12Baseline(bundle);
  const raw = v1.execution_priority;
  const priority = formalizePriority(raw, bundle.property, buckets);
  const rec = {
    shadow_record_version: 'shadow-v2',
    property_id: bundle.property.id,
    scoring_timestamp: asOf,
    canonical_input_hash: canonicalInputHash,
    inputs_max_observed_at: feats.inputs_max_observed_at,
    feature_snapshot: feats.features,                 // all 87 features incl. blocked states
    feature_count: feats.features.length,
    score_families: v1.families,
    execution_priority_raw: raw,
    execution_priority_score_0_100: priority.execution_priority_score_0_100,
    execution_priority_percentile: priority.execution_priority_percentile,
    percentile_basis: priority.percentile_basis,
    cohort_key: priority.cohort_key,
    cohort_n: priority.cohort_n,
    deterministic_v1_score: raw,                      // == raw (retained name)
    execution_route: v1.route ?? v1.families?.execution_priority?.route ?? null,
    horizon_days: v1.horizon_days ?? null,
    v12_score: v12.priority,
    explanations: v1.explanations,
    ix19_dry_run: v1.ix19_dry_run,
    versions: {
      deterministic_v1: v1.engine_version_id,
      v12_baseline: v12.engine_version_id,
      v1_config_sha: loadV1Config().versionId,
      v12_config_sha: loadV12Config().versionId,
      registry_sha: registryHash,
      priority_contract: priority.contract_version,
    },
    record_hash: null, // filled below
  };
  return rec;
}

// Records are written synchronously in chunks; the cohort hash is folded
// incrementally so a full-corpus cohort never materializes one giant string
// (V8 caps single strings at ~2^29 chars) and the file is complete when this
// function returns (callers read it synchronously).
export function createShadowCohort({ bundles, asOf, cohortName, buckets = null, role = 'primary' }) {
  const dir = join(VAR_DIR, 'shadow', cohortName);
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, 'records.ndjson'), 'w');
  let size = 0;
  let hashAccum = [];
  let chunk = [];
  const ids = new Set();
  let dupes = 0;
  const flush = () => { if (chunk.length) { writeSync(fd, chunk.join('')); chunk = []; } };
  for (const b of bundles) {
    if (ids.has(b.property.id)) { dupes += 1; continue; }   // never emit a duplicate property
    ids.add(b.property.id);
    const r = freezeShadowRecord(b, asOf, { buckets });
    r.record_hash = sha256(JSON.stringify({ ...r, record_hash: null }));
    chunk.push(JSON.stringify(r) + '\n');
    hashAccum.push(r.record_hash);
    size += 1;
    if (chunk.length >= 1000) flush();
    if (hashAccum.length >= 5000) hashAccum = [sha256(hashAccum.join(''))];
  }
  flush();
  closeSync(fd);
  const manifest = {
    cohort: cohortName, role, created_at: new Date().toISOString(), as_of: asOf,
    size, duplicates_skipped: dupes,
    cohort_hash: sha256(hashAccum.join('')),
    registry_sha: REGISTRY_SHA,
    horizons_days: [30, 90, 180, 365],
    note: 'frozen baseline for prospective outcomes; scoring+observation only — no outreach effect',
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { manifest, dir };
}

// ------------------------------- CLI -------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const asOf = process.env.AS_OF ?? new Date().toISOString();
  const name = process.env.COHORT ?? `shadow_${asOf.slice(0, 10)}`;
  const limit = Number(process.env.LIMIT ?? 500);
  const props = readAll('properties').slice(0, limit);
  const idx = (t) => { const m = new Map(); for (const r of readAll(t)) (m.get(r.property_id) ?? m.set(r.property_id, []).get(r.property_id)).push(r); return m; };
  const vals = idx('property_valuation_tax_snapshots'); const loans = idx('property_loans');
  const liens = idx('property_liens'); const fcs = idx('property_foreclosure_events');
  const txns = idx('property_transactions'); const links = idx('property_person_links');
  const phones = idx('contact_phones'); const checks = idx('loan_checksums');
  const bundles = props.map((p) => ({
    property: p, valuation: (vals.get(p.id) ?? [])[0] ?? {}, loans: loans.get(p.id) ?? [],
    checksums: (checks.get(p.id) ?? [])[0] ?? null, liens: liens.get(p.id) ?? [],
    foreclosure: fcs.get(p.id) ?? [], transactions: (txns.get(p.id) ?? []),
    links: links.get(p.id) ?? [], phones: phones.get(p.id) ?? [], emails: [],
    batchScalarLiveness: null,
  }));
  const { manifest, dir } = createShadowCohort({ bundles, asOf, cohortName: name });
  console.log('shadow cohort frozen:', manifest.cohort, manifest.size, 'records ->', dir);
  console.log('cohort_hash:', manifest.cohort_hash);
}
