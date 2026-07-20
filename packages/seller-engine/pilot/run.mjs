#!/usr/bin/env node
// Pilot orchestrator (NON-PRODUCTION; local unix-socket Postgres only).
//   node pilot/run.mjs init                 — cluster + draft-DDL validation
//   node pilot/run.mjs import --dir <dir>   — properties/liens/companies/contact_info
//   node pilot/run.mjs prospects --dir <dir>— streaming prospects load
//   node pilot/run.mjs verify               — re-apply DDL check + counts snapshot
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importFile } from '../importers/common.mjs';
import { mapProperty, mapLien, mapCompany, mapContact } from '../importers/mappers.mjs';
import { ensureCluster, psqlFile, psql, num, PILOT_DIR } from './pg.mjs';
import { ensureStageTables, loadPartitions, streamProspects } from './load.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(PKG, '..', '..');
const STATE_PATH = join(PILOT_DIR, 'state.json');
const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : { stages: {}, batches: {} };
const save = () => { mkdirSync(PILOT_DIR, { recursive: true }); writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); };
const mark = (stage, data) => { state.stages[stage] = { at: new Date().toISOString(), ...data }; save(); };

const FILE_SETS = {
  properties: { mapper: mapProperty,
    tables: ['import_batches', 'source_records', 'properties', 'property_valuation_tax_snapshots',
      'property_ownerships', 'ownership_classifications', 'property_loans', 'loan_checksums',
      'property_transactions', 'property_foreclosure_events', 'unmapped_domain_values'] },
  liens: { mapper: mapLien, tables: ['import_batches', 'source_records', 'property_liens', 'lien_parties', 'unmapped_domain_values'] },
  companies: { mapper: mapCompany, tables: ['import_batches', 'source_records', 'companies', 'property_company_links', 'unmapped_domain_values'] },
  contact_info: { mapper: mapContact, tables: ['import_batches', 'source_records', 'people', 'contact_phones', 'contact_emails', 'unmapped_domain_values'] },
};

const args = {};
const argv = process.argv.slice(2);
const cmd = argv[0];
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}

async function init() {
  const t0 = Date.now();
  ensureCluster();
  const schemaExists = psql("select 1 from information_schema.schemata where schema_name='seller_engine'", { allowFail: true }).includes('1');
  const results = { first_apply: null, reapply_findings: null };
  const ddl1 = join(REPO, 'supabase', 'migrations-draft', 'seller-engine', '0001_seller_engine_canonical.sql');
  const ddl2 = join(REPO, 'supabase', 'migrations-draft', 'seller-engine', '0002_pilot_supplement.sql');
  if (!schemaExists) {
    const r1 = psqlFile(ddl1);
    if (!r1.ok) throw new Error(`0001 failed on clean database:\n${r1.err}`);
    results.first_apply = 'clean';
  } else {
    const r1b = psqlFile(ddl1);
    results.reapply_findings = r1b.ok ? 'unexpected_clean_reapply'
      : `expected already-exists errors (draft uses bare create table): ${(r1b.err.match(/already exists/g) ?? []).length} objects`;
  }
  const r2 = psqlFile(ddl2);
  if (!r2.ok) throw new Error(`0002 failed:\n${r2.err}`);
  ensureStageTables();
  const tableCount = num("select count(*) from information_schema.tables where table_schema='seller_engine' and table_name not like 'stage\\_%' and table_name <> 'pilot_load_rejects'");
  mark('init', { ...results, canonical_tables: tableCount, ms: Date.now() - t0 });
  console.log(`init ok: ${tableCount} canonical tables; ${JSON.stringify(results)}`);
}

async function importSmallSets(dir) {
  for (const [fileSet, spec] of Object.entries(FILE_SETS)) {
    const t0 = Date.now();
    const filePath = join(dir, `${fileSet}.csv`);
    if (!existsSync(filePath)) { console.log(`skip ${fileSet}: missing`); continue; }
    const res = await importFile({ filePath, fileSet, mapper: spec.mapper });
    const load = await loadPartitions(res.batch.id, spec.tables);
    state.batches[fileSet] = { id: res.batch.id, rows: res.batch.row_count, sha: res.batch.file_sha256, conflicts: res.conflicts };
    mark(`import_${fileSet}`, { batch: res.batch.id, source_rows: res.batch.row_count, load: load.merged, ms: Date.now() - t0 });
    console.log(`${fileSet}: ${res.batch.row_count} rows -> ${JSON.stringify(Object.fromEntries(Object.entries(load.merged).map(([t, s]) => [t, s.canonical_total])))}`);
  }
}

async function prospects(dir) {
  const t0 = Date.now();
  const res = await streamProspects(join(dir, 'prospects.csv'), {
    onProgress: (n) => console.log(`prospects: ${n} rows…`),
  });
  state.batches.prospects = { id: res.batchId, rows: res.rows, conflicts: res.conflicts, sidecar: res.sidecarPath, sha: res.batch.file_sha256 };
  mark('import_prospects', { batch: res.batchId, source_rows: res.rows, conflicts: res.conflicts, load: res.merged, ms: Date.now() - t0 });
  console.log(`prospects: ${res.rows} rows; conflicts ${JSON.stringify(res.conflicts)}; ${JSON.stringify(Object.fromEntries(Object.entries(res.merged).map(([t, s]) => [t, s.canonical_total])))}`);
}

const commands = {
  init,
  import: () => importSmallSets(args.dir),
  prospects: () => prospects(args.dir),
  verify: async () => {
    const counts = {};
    for (const t of ['properties', 'people', 'property_person_links', 'contact_phones', 'contact_emails',
      'companies', 'property_company_links', 'property_loans', 'property_transactions', 'property_liens',
      'lien_parties', 'property_foreclosure_events', 'property_valuation_tax_snapshots', 'source_records']) {
      counts[t] = num(`select count(*) from seller_engine.${t}`);
    }
    console.log(JSON.stringify(counts, null, 2));
    return counts;
  },
};

if (!commands[cmd]) { console.error(`usage: run.mjs <${Object.keys(commands).join('|')}> [--dir …]`); process.exit(1); }
await commands[cmd]();
