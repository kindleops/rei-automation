// Local NDJSON staging store under packages/seller-engine/var/ (gitignored).
// Rows mirror the draft canonical DDL 1:1 so Phase 4 DB loading is mechanical.
// Idempotency: rows are keyed by deterministic id; rewriting a batch replaces
// that batch's partition file atomically.
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VAR_DIR = process.env.SELLER_ENGINE_VAR
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'var');

export function partitionPath(table, batchId) {
  return join(VAR_DIR, 'staging', table, `${batchId}.ndjson`);
}

export function writePartition(table, batchId, rows) {
  const path = partitionPath(table, batchId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  renameSync(tmp, path); // atomic replace = idempotent re-import
  return { path, rows: rows.length };
}

export function readPartition(table, batchId) {
  const path = partitionPath(table, batchId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function readAll(table) {
  const dir = join(VAR_DIR, 'staging', table);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ndjson'))) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line) out.push(JSON.parse(line));
    }
  }
  return out;
}

export function writeReport(name, obj) {
  const path = join(VAR_DIR, 'reports', `${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return path;
}
