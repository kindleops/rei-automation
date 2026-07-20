#!/usr/bin/env node
// Corpus-manifest CLI (P2-4).
//   node corpus/manifest.mjs discover [--root <dir>]... [--out <file>]
//   node corpus/manifest.mjs propose  [--root <dir>]... [--out <file>] [--deep]
//   node corpus/manifest.mjs finalize --manifest <file> --approve "<name>"
// Discovers scraper export candidates, verifies completion evidence, hashes
// files, counts rows, fingerprints schemas, detects drift and duplicate
// property identities, and produces a PROPOSED manifest. Finalizing requires an
// explicit --approve acknowledgement (never automatic). The OD-13 June raw
// captures are force-quarantined into vendor_schema_drift_qa_corpus.
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { csvRows, readCsvHeader } from '../lib/csv.mjs';
import { sha256File, sha256 } from '../lib/hash.mjs';
import { writeReport } from '../lib/store.mjs';

const FILE_SETS = ['properties', 'liens', 'companies', 'contact_info', 'prospects'];
// The OD-13 drift-QA corpus: the June capture trio + enriched Jul-2 root files.
const QA_CORPUS_MARKERS = [/capture_complete_9756/i, /before_elite_enrichment/i];
const QA_ROOT_HINT = /DM-Scraper$/;

export function classifyFile(path) {
  const name = basename(path).toLowerCase();
  const set = FILE_SETS.find((s) => name.startsWith(s));
  const isQa = QA_CORPUS_MARKERS.some((re) => re.test(name));
  return { fileSet: set ?? null, qaMarker: isQa };
}

export function discover(roots) {
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (!/node_modules|venv|__pycache__|\.git/.test(e.name)) stack.push(p);
        } else if (e.name.endsWith('.csv')) {
          const { fileSet, qaMarker } = classifyFile(p);
          candidates.push({
            path: p, bytes: statSync(p).size, mtime: statSync(p).mtime.toISOString(),
            file_set: fileSet, qa_marker: qaMarker,
            in_qa_root: QA_ROOT_HINT.test(dir),
          });
        }
      }
    }
  }
  return candidates;
}

export function completionEvidence(root) {
  const evidence = {};
  const ckpt = join(root, '_internal', 'checkpoint_property_ids.txt');
  if (existsSync(ckpt)) {
    evidence.checkpoint_property_ids = readFileSync(ckpt, 'utf8').split('\n').filter(Boolean).length;
  }
  for (const f of (existsSync(root) ? readdirSync(root) : [])) {
    if (/capture_complete/.test(f)) (evidence.complete_markers ??= []).push(f);
  }
  return evidence;
}

export async function profileFile(path, { deep = false } = {}) {
  const header = await readCsvHeader(path);
  const fingerprint = sha256([...header].sort().join('')).slice(0, 16);
  const out = {
    header_count: header.length, schema_fingerprint: fingerprint,
    file_sha256: await sha256File(path),
  };
  if (deep) {
    let rows = 0; const propIds = new Map(); const runIds = new Set(); const malformed = [];
    const idCol = header.includes('property_id') ? 'property_id' : null;
    for await (const { record, width } of csvRows(path)) {
      rows += 1;
      if (width !== header.length && malformed.length < 20) malformed.push(rows);
      if (record.run_id) runIds.add(record.run_id);
      if (idCol) {
        const pid = record[idCol];
        if (!pid) { if (malformed.length < 20) malformed.push(`missing_id@${rows}`); }
        else propIds.set(pid, (propIds.get(pid) ?? 0) + 1);
      }
    }
    out.row_count = rows;
    out.run_ids = [...runIds];
    out.distinct_property_ids = propIds.size;
    out.duplicate_property_ids_in_file = [...propIds.values()].filter((n) => n > 1).length;
    out.malformed_samples = malformed;
  }
  return out;
}

export async function propose(roots, { deep = false } = {}) {
  const candidates = discover(roots);
  const filesets = candidates.filter((c) => c.file_set);
  const profiled = [];
  for (const c of filesets) {
    profiled.push({ ...c, ...(await profileFile(c.path, { deep })) });
  }
  // cross-file duplicate property identity report (deep mode)
  const drift = {};
  for (const p of profiled) {
    (drift[p.file_set] ??= new Set()).add(p.schema_fingerprint);
  }
  let qa = profiled.filter((p) => p.qa_marker || p.in_qa_root);
  // sha-level quarantine: byte-identical copies of QA-corpus files (e.g. the
  // DM_COMPLETE_9756 duplicates under exports/) must never enter Corpus V1
  const qaShas = new Set(qa.map((p) => p.file_sha256));
  const v1candidates = [];
  for (const p of profiled) {
    if (p.qa_marker || p.in_qa_root) continue;
    if (qaShas.has(p.file_sha256)) qa.push({ ...p, quarantine_reason: 'sha_match_qa_corpus' });
    else v1candidates.push(p);
  }
  return {
    generated_at: new Date().toISOString(),
    status: 'proposed',
    roots,
    corpora: {
      vendor_schema_drift_qa_corpus: {
        note: 'OD-13 June raw captures + enriched root trio. NEVER silently enters Corpus V1 (P2-4).',
        completion_evidence: roots.map((r) => ({ root: r, ...completionEvidence(r) })),
        files: qa,
      },
      corpus_v1_candidates: {
        note: 'Final completed enriched production batches only. Requires explicit selection + --approve to finalize. Final two seller batches pending — DO NOT freeze until complete.',
        files: v1candidates,
        selection: [],           // filled at finalize time
      },
    },
    schema_drift: Object.fromEntries(Object.entries(drift).map(([k, v]) => [k, [...v]])),
    unclassified_csv_count: candidates.length - filesets.length,
  };
}

export function finalize(manifest, approveName) {
  if (!approveName) throw new Error('finalize requires --approve "<corpus name>" (explicit approval, P2-4)');
  if (manifest.corpora.corpus_v1_candidates.selection.length === 0) {
    throw new Error('refusing to finalize: no files explicitly selected into corpus_v1_candidates.selection');
  }
  return { ...manifest, status: 'approved', approved_as: approveName, approved_at: new Date().toISOString() };
}

// ------------------------------- CLI -------------------------------
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith('--')) {
      const k = rest[i].slice(2);
      const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
      (args[k] ??= []).push(v);
    }
  }
  const roots = args.root ?? ['/Users/ryankindle/Desktop/Desktop - Ryan’s MacBook Pro (2)/Projects/DM-Scraper'];
  if (cmd === 'discover') {
    console.log(JSON.stringify(discover(roots), null, 2));
  } else if (cmd === 'propose') {
    const m = await propose(roots, { deep: Boolean(args.deep) });
    const out = args.out?.[0] ?? writeReport('corpus_manifest_proposed', m);
    if (args.out?.[0]) writeFileSync(args.out[0], JSON.stringify(m, null, 2));
    console.log(`proposed manifest -> ${out}`);
    console.log(`QA-corpus files: ${m.corpora.vendor_schema_drift_qa_corpus.files.length}; V1 candidates: ${m.corpora.corpus_v1_candidates.files.length}; drift:`, m.schema_drift);
  } else if (cmd === 'finalize') {
    const m = JSON.parse(readFileSync(args.manifest[0], 'utf8'));
    const f = finalize(m, args.approve?.[0]);
    writeFileSync(args.manifest[0], JSON.stringify(f, null, 2));
    console.log(`finalized as ${f.approved_as}`);
  } else {
    console.log('usage: manifest.mjs discover|propose|finalize [--root DIR] [--deep] [--manifest FILE --approve NAME]');
  }
}
