#!/usr/bin/env node
// Produces the pilot archive artifacts referenced by SELLER_PILOT_ARCHIVE_MANIFEST.md:
// a compressed schema dump, its sha256, engine/config/registry hash manifest,
// source-batch hash manifest, shadow manifests copy. No credentials written.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, statSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { sha256 } from '../lib/hash.mjs';
import { readAll } from '../lib/store.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = join(PKG, 'var', 'pilot', 'archive');
const STATE = JSON.parse(readFileSync(join(PKG, 'var', 'pilot', 'state.json'), 'utf8'));

function fileSha(path) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

async function main() {
  mkdirSync(ARCHIVE, { recursive: true });

  // 1. schema dump (custom format, compressed, exclude ephemeral stage data).
  // Redirect pg_dump stdout straight to a file descriptor — the dump is ~195MB
  // and must not be buffered through Node.
  const dumpPath = join(ARCHIVE, 'seller_engine_pilot.dump');
  const fd = openSync(dumpPath, 'w');
  const r = spawnSync('docker', ['exec', 'seller-pilot-pg', 'pg_dump', '-U', 'postgres', '-d', 'seller_pilot',
    '--schema=seller_engine', '--format=custom', '--compress=9', '--exclude-table-data=seller_engine.stage_*'],
    { stdio: ['ignore', fd, 'inherit'] });
  closeSync(fd);
  if (r.status !== 0) throw new Error(`pg_dump failed (status ${r.status})`);
  if (statSync(dumpPath).size === 0) throw new Error('pg_dump produced an empty file');
  const dumpSha = await fileSha(dumpPath);
  writeFileSync(`${dumpPath}.sha256`, `${dumpSha}  seller_engine_pilot.dump\n`);
  const dumpMb = Math.round(statSync(dumpPath).size / 1e6);

  // 2. engine/config/registry hash manifest
  const files = ['features/registry.mjs', 'features/engine.mjs', 'features/engineExtended.mjs',
    'scores/families.mjs', 'scores/deterministicV1.mjs', 'config/deterministic_v1.config.json',
    'scores/priorityContract.mjs', 'shadow/createShadowCohort.mjs'];
  const engineHashes = Object.fromEntries(files.map((f) => [f, sha256(readFileSync(join(PKG, f), 'utf8'))]));
  writeFileSync(join(ARCHIVE, 'engine_hashes.json'), JSON.stringify(engineHashes, null, 2));

  // 3. source-batch hash manifest — authoritative from state.batches (the
  // streaming prospects loader records its batch in the DB + state, not the
  // local staging partition, so readAll misses it). Enrich with source_path
  // from any staged import_batches row when present.
  const dbBatches = new Map(readAll('import_batches').map((b) => [b.id, b]));
  const batches = Object.entries(STATE.batches).map(([fileSet, b]) => ({
    file_set: fileSet, batch_id: b.id, file_sha256: b.sha ?? dbBatches.get(b.id)?.file_sha256 ?? null,
    source_rows: b.rows ?? dbBatches.get(b.id)?.row_count ?? null,
    source_path: dbBatches.get(b.id)?.source_path ?? (STATE.batches[fileSet]?.sidecar ? 'streaming' : null),
  }));
  writeFileSync(join(ARCHIVE, 'source_batches.json'), JSON.stringify(batches, null, 2));

  // 4. shadow manifests snapshot
  const shadow = STATE.stages.full_shadow ?? null;
  writeFileSync(join(ARCHIVE, 'shadow_manifest.json'), JSON.stringify(shadow, null, 2));

  const summary = {
    dump: { path: 'var/pilot/archive/seller_engine_pilot.dump', sha256: dumpSha, size_mb: dumpMb },
    engine_hashes: 'var/pilot/archive/engine_hashes.json',
    source_batches: batches.length,
    shadow: shadow ? { primary: shadow.primary?.name, sample: shadow.validation_sample?.name } : null,
    credentials_included: false,
  };
  STATE.stages.archive = { at: new Date().toISOString(), ...summary };
  writeFileSync(join(PKG, 'var', 'pilot', 'state.json'), JSON.stringify(STATE, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

await main();
