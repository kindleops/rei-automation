#!/usr/bin/env node
// P3-3 §4: folder-level batch classification + cross-batch overlap analysis.
// Consumes the proposed manifest (file-level hashes/fingerprints) and deep-scans
// each candidate folder's properties.csv for property-id sets, timestamps and
// duplicates. Emits var/reports/corpus_batch_report.json for the approval packet.
import { readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { csvRows } from '../lib/csv.mjs';
import { writeReport, VAR_DIR } from '../lib/store.mjs';

const CLASSES = ['completed_production_batch', 'partial_incomplete_batch', 'resumed_duplicate_path',
  'qa_corpus', 'byte_identical_duplicate', 'superseded_export', 'unknown_requires_review'];

export async function scanPropertiesFile(path) {
  const ids = new Set();
  let dup = 0; let rows = 0; let tsMin = null; let tsMax = null; const runs = new Set();
  let malformed = 0;
  for await (const { record } of csvRows(path)) {
    rows += 1;
    const pid = record.property_id;
    if (!pid) { malformed += 1; continue; }
    if (ids.has(pid)) dup += 1; else ids.add(pid);
    if (record.run_id) runs.add(record.run_id);
    const ts = record.scraped_at ?? '';
    if (ts) { tsMin = tsMin === null || ts < tsMin ? ts : tsMin; tsMax = tsMax === null || ts > tsMax ? ts : tsMax; }
  }
  return { ids, rows, duplicate_property_count: dup, malformed_ids: malformed,
    ts_min: tsMin, ts_max: tsMax, run_ids: [...runs] };
}

export async function buildBatchReport(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const all = [
    ...manifest.corpora.vendor_schema_drift_qa_corpus.files.map((f) => ({ ...f, qa: true })),
    ...manifest.corpora.corpus_v1_candidates.files.map((f) => ({ ...f, qa: false })),
  ];
  const folders = new Map();
  for (const f of all) {
    const dir = dirname(f.path);
    (folders.get(dir) ?? folders.set(dir, []).get(dir)).push(f);
  }
  // sha -> folders map for byte-identical detection
  const shaFolders = new Map();
  for (const [dir, files] of folders) {
    const key = files.map((f) => f.file_sha256).sort().join('|');
    (shaFolders.get(key) ?? shaFolders.set(key, []).get(key)).push(dir);
  }

  const batches = [];
  for (const [dir, files] of folders) {
    const sets = Object.fromEntries(files.map((f) => [f.file_set, f]));
    const props = sets.properties;
    const scan = props ? await scanPropertiesFile(props.path) : null;
    const shaKey = files.map((f) => f.file_sha256).sort().join('|');
    const twins = shaFolders.get(shaKey).filter((d) => d !== dir);
    const name = basename(dir);
    let cls;
    if (files.some((f) => f.qa)) cls = 'qa_corpus';
    else if (twins.length && dir > twins.sort()[0]) cls = 'byte_identical_duplicate';
    else if (/full_flat|^DM_2026|DM_ACCOUNT|DM_LIST|DM_FULL/.test(name)) cls = 'superseded_export';
    else if (!props || !sets.prospects) cls = 'partial_incomplete_batch';
    else if ((scan?.ids.size ?? 0) >= 5000 && sets.contact_info && sets.companies && sets.liens) cls = 'completed_production_batch';
    else if ((scan?.ids.size ?? 0) > 0 && (scan?.ids.size ?? 0) < 5000) cls = 'partial_incomplete_batch';
    else cls = 'unknown_requires_review';

    batches.push({
      folder: dir, name, classification: cls, twins,
      file_sets: Object.fromEntries(files.map((f) => [f.file_set,
        { bytes: f.bytes, sha256: f.file_sha256, schema_fingerprint: f.schema_fingerprint }])),
      unique_property_count: scan?.ids.size ?? null,
      property_row_count: scan?.rows ?? null,
      duplicate_property_count: scan?.duplicate_property_count ?? null,
      malformed_ids: scan?.malformed_ids ?? null,
      earliest_ts: scan?.ts_min ?? null, latest_ts: scan?.ts_max ?? null,
      run_ids: scan?.run_ids ?? [],
      _ids: scan?.ids ?? new Set(),
    });
  }

  // pairwise overlap among completed batches + qa
  const overlapTargets = batches.filter((b) => b._ids.size > 0);
  for (const b of overlapTargets) {
    b.overlap = {};
    for (const o of overlapTargets) {
      if (o.folder === b.folder) continue;
      let inter = 0;
      const [small, big] = b._ids.size < o._ids.size ? [b._ids, o._ids] : [o._ids, b._ids];
      for (const id of small) if (big.has(id)) inter += 1;
      b.overlap[o.name] = { shared: inter, pct_of_this: Math.round(1000 * inter / b._ids.size) / 10 };
    }
  }
  for (const b of batches) delete b._ids;

  const report = { generated_at: new Date().toISOString(), classes: CLASSES, batches };
  const path = writeReport('corpus_batch_report', report);
  return { report, path };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifestPath = process.argv[2] ?? join(VAR_DIR, 'reports', 'corpus_manifest_proposed.json');
  const { report, path } = await buildBatchReport(manifestPath);
  console.log('batch report ->', path);
  for (const b of report.batches.sort((a, z) => (z.unique_property_count ?? 0) - (a.unique_property_count ?? 0))) {
    console.log(`${(b.unique_property_count ?? 0).toString().padStart(6)} props | ${b.classification.padEnd(28)} | ${b.name}${b.twins.length ? ` (twin: ${b.twins.map((t) => basename(t)).join(',')})` : ''}`);
  }
}
