// Pilot loaders: staged NDJSON partitions -> Postgres (small file sets), and a
// streaming direct loader for the multi-GB prospects file (the in-memory
// importer is structurally unable to hold it; runbook §5 anticipated this
// "pg sink" addition). Same mappers, same deterministic ids, same idempotency:
// stage tables are truncated per run and merges upsert on deterministic PKs.
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { csvRows } from '../lib/csv.mjs';
import { sha256, sha256File, deterministicId } from '../lib/hash.mjs';
import { readPartition } from '../lib/store.mjs';
import { mapProspect } from '../importers/mappers.mjs';
import { TABLES, stageDDL, mergeSQL, rejectSQL, orphanSQL } from './tables.mjs';
import { psql, copyIn, csvCell, pgArray, num, PILOT_DIR } from './pg.mjs';

const FLUSH_AT = 20000;

export function ensureStageTables() {
  psql('set search_path to seller_engine; ' + Object.keys(TABLES).map(stageDDL).join(' '));
}

function encodeRow(table, row) {
  const spec = TABLES[table];
  const derived = spec.derive ? spec.derive(row) : {};
  return Object.entries(spec.cols).map(([c, t]) => {
    let v = derived[c] !== undefined ? derived[c] : row[c];
    if (c === 'raw' && spec.raw) v = row;                     // full staged row satisfies raw-not-null
    if (t === 'arr') v = pgArray(Array.isArray(v) ? v : []);
    return csvCell(v);
  }).join(',');
}

async function flush(buffers) {
  for (const [table, lines] of Object.entries(buffers)) {
    if (!lines.length) continue;
    await copyIn(`seller_engine.stage_${table}`, Object.keys(TABLES[table].cols), lines);
    buffers[table] = [];
  }
}

export async function mergeAll(tables, batchId) {
  const stats = {};
  for (const table of tables) {
    const before = num(`select count(*) from seller_engine.${table}`);
    const stageTotal = num(`select count(*) from seller_engine.stage_${table}`);
    const stageDistinct = num(`select count(distinct ${TABLES[table].pk}) from seller_engine.stage_${table}`);
    const rej = rejectSQL(table, batchId);
    if (rej) psql(`set search_path to seller_engine; ${rej}`);
    const orph = orphanSQL(table);
    const orphans = orph ? num(`set search_path to seller_engine; ${orph}`) : 0;
    psql(`set search_path to seller_engine; ${mergeSQL(table)}`);
    const after = num(`select count(*) from seller_engine.${table}`);
    stats[table] = {
      stage_rows: stageTotal, stage_distinct: stageDistinct,
      duplicates_in_stage: stageTotal - stageDistinct,
      orphans_blocked: orphans,
      inserted: after - before,
      upserted_existing: stageDistinct - orphans - (after - before),
      canonical_total: after,
    };
  }
  return stats;
}

export function truncateStages(tables) {
  psql('set search_path to seller_engine; '
    + tables.map((t) => `truncate table stage_${t} restart identity;`).join(' '));
}

// ---- path A: staged NDJSON partitions (properties/liens/companies/contact_info)
export async function loadPartitions(batchId, tables) {
  truncateStages(tables);
  const buffers = Object.fromEntries(tables.map((t) => [t, []]));
  const loaded = {};
  for (const table of tables) {
    const rows = readPartition(table, batchId);
    loaded[table] = rows.length;
    for (const r of rows) {
      buffers[table].push(encodeRow(table, r));
      if (buffers[table].length >= FLUSH_AT) await flush(buffers);
    }
  }
  await flush(buffers);
  return { staged: loaded, merged: await mergeAll(tables, batchId) };
}

// ---- path B: streaming prospects loader (multi-GB safe)
export async function streamProspects(filePath, { onProgress = null } = {}) {
  const fileSha = await sha256File(filePath);
  const batchId = deterministicId('batch', 'prospects', fileSha);
  const tables = ['people', 'property_person_links', 'source_records'];
  truncateStages(tables.concat(['import_batches', 'unmapped_domain_values']));
  mkdirSync(PILOT_DIR, { recursive: true });
  const sidecarPath = join(PILOT_DIR, `links_${batchId}.ndjson`);
  const sidecar = createWriteStream(`${sidecarPath}.tmp`);

  const buffers = { people: [], property_person_links: [], source_records: [] };
  const conflicts = { renter_owner_collision: 0 };
  let header = null; let processed = 0; let scrapedMin = null; let scrapedMax = null;
  const runIds = new Set();
  let lastPersonTier = null;
  const ctx = {
    batchId,
    emit(table, row) {
      buffers[table].push(encodeRow(table, row));
      if (table === 'people') lastPersonTier = row.identity_tier ?? null;
      if (table === 'property_person_links') {
        sidecar.write(JSON.stringify({
          id: row.id, property_id: row.property_id, person_id: row.person_id,
          person_identity_tier: lastPersonTier,
          matching_type: row.matching_type, matching_flags: row.matching_flags,
          likely_owner_scalar: row.likely_owner_scalar,
          is_matching_property_as_owner: row.is_matching_property_as_owner,
          renter_flag: row.renter_flag, link_tier: row.link_tier,
          person_flags_raw: row.person_flags_raw?.slice(0, 400) ?? '',
          profile: row.profile,
        }) + '\n');
      }
    },
    conflict(kind) { conflicts[kind] = (conflicts[kind] ?? 0) + 1; },
    unmapped() {},
    id: deterministicId,
  };

  for await (const { rowNumber, record } of csvRows(filePath)) {
    header ??= Object.keys(record);
    processed += 1;
    if (record.run_id) runIds.add(record.run_id);
    if (record.scraped_at) {
      scrapedMin = scrapedMin === null || record.scraped_at < scrapedMin ? record.scraped_at : scrapedMin;
      scrapedMax = scrapedMax === null || record.scraped_at > scrapedMax ? record.scraped_at : scrapedMax;
    }
    // prospects rows are pathologically wide (this file is the 3 GB one); the
    // full raw is preserved on disk + the enriched fields ride the sidecar, so
    // source_records stores LINEAGE ONLY (row number + integrity sha + join
    // keys), not a duplicate of the giant payload. Reconciliation counts and
    // sha-integrity are unaffected.
    buffers.source_records.push(encodeRow('source_records', {
      id: deterministicId('src', batchId, rowNumber),
      import_batch_id: batchId, source_table: 'prospects', source_row_number: rowNumber,
      property_data_id: record.property_data_id ?? null,
      payload: { lineage_only: true, property_id: record.property_id ?? null,
        individual_key: record.individual_key ?? null, matching_type: record.matching_type ?? null },
      payload_sha256: sha256(JSON.stringify(record)),
      scraped_at: record.scraped_at ?? null,
    }));
    mapProspect(record, ctx);
    if (buffers.source_records.length >= FLUSH_AT) await flush(buffers);
    if (onProgress && processed % 100000 === 0) onProgress(processed);
  }
  await flush(buffers);
  sidecar.end();
  await new Promise((res) => sidecar.on('finish', res));
  const { renameSync } = await import('node:fs');
  renameSync(`${sidecarPath}.tmp`, sidecarPath);

  const batch = {
    id: batchId, vendor: 'dealmachine', file_set: 'prospects', source_path: filePath,
    run_ids: [...runIds], file_sha256: fileSha, row_count: processed,
    schema_fingerprint: header ? sha256([...header].sort().join('')).slice(0, 16) : null,
    scraped_at_min: scrapedMin, scraped_at_max: scrapedMax,
  };
  await copyIn('seller_engine.stage_import_batches', Object.keys(TABLES.import_batches.cols),
    [encodeRow('import_batches', batch)]);
  const merged = await mergeAll(['import_batches', 'people', 'property_person_links', 'source_records'], batchId);
  return { batchId, rows: processed, conflicts, merged, sidecarPath, batch };
}
