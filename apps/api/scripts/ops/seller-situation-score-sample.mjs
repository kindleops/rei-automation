#!/usr/bin/env node
/**
 * READ-ONLY. Scores a list of property ids with seller_situation_v2 (raw_facts_v1)
 * and writes one JSON line per property to --out. Never writes to the database.
 *   cd apps/api && SUPABASE_DB_URL=... node scripts/ops/seller-situation-score-sample.mjs --ids=<file> --out=<file.jsonl>
 * Ids file: one property_id per line, or a CSV with a property_id column.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

register('./tests/alias-loader.mjs', pathToFileURL('./'));
const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };

const { loadSellerRawFacts, scoreSellerSituation, encodeSellerSituationRow, rowBytes } = await import('../../src/lib/acquisition/seller-situation/index.js');
const pg = (await import('pg')).default;
const url = String(process.env.SUPABASE_DB_URL || '').trim();
if (!url) throw new Error('SUPABASE_DB_URL is required');
const client = new pg.Client({ connectionString: url, statement_timeout: 30_000, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("SET statement_timeout='30s'");
await client.query('SET default_transaction_read_only = on');

const raw = fs.readFileSync(arg('ids'), 'utf8').split(/\r?\n/).filter(Boolean);
let ids = raw;
if (raw[0].includes(',')) {
  const header = raw[0].split(',');
  const col = header.indexOf('property_id');
  ids = raw.slice(1).map((l) => l.split(',')[col]);
}
ids = [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
const batch = Number(arg('batch', 200));
const now = arg('now', new Date().toISOString());
const out = fs.createWriteStream(arg('out'));
const t0 = Date.now();
let loadMs = 0; let scoreMs = 0; let n = 0; let bytes = 0; let missing = 0;
for (let i = 0; i < ids.length; i += batch) {
  const chunk = ids.slice(i, i + batch);
  const a = Date.now();
  const facts = await loadSellerRawFacts(chunk, client);
  loadMs += Date.now() - a;
  const b = Date.now();
  for (const id of chunk) {
    const rf = facts.get(id);
    if (!rf) { missing += 1; continue; }
    const r = scoreSellerSituation(rf, { now });
    const row = encodeSellerSituationRow(r, { featuresAsOf: rf.facts.as_of_date ?? null });
    bytes += rowBytes(row);
    n += 1;
    out.write(`${JSON.stringify({ ...r, evidence: undefined, ev: r.evidence.map((e) => e.code), has_features: rf.has_features, row_bytes: rowBytes(row) })}\n`);
  }
  scoreMs += Date.now() - b;
}
out.end();
await client.end();
console.log(JSON.stringify({ ids: ids.length, scored: n, missing, wall_ms: Date.now() - t0, load_ms: loadMs, score_ms: scoreMs, ms_per_property: +((Date.now() - t0) / Math.max(1, n)).toFixed(3), avg_row_bytes: Math.round(bytes / Math.max(1, n)) }));
