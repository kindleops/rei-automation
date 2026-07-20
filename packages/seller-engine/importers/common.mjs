// Shared staging-importer engine: streaming, idempotent (deterministic ids +
// atomic partition replace), resumable (checkpoint by row offset), dry-run and
// pilot modes, raw preservation + lineage on every row, conflict reporting.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { csvRows } from '../lib/csv.mjs';
import { sha256, sha256File, deterministicId } from '../lib/hash.mjs';
import { writePartition, writeReport, VAR_DIR } from '../lib/store.mjs';

export async function importFile({ filePath, fileSet, mapper, batchId = null,
  dryRun = false, pilot = null, resume = false }) {
  const fileSha = await sha256File(filePath);
  batchId ??= deterministicId('batch', fileSet, fileSha); // same file => same batch => idempotent
  const ckptPath = join(VAR_DIR, 'checkpoints', `${batchId}.json`);
  let startRow = 0;
  if (resume && existsSync(ckptPath)) startRow = JSON.parse(readFileSync(ckptPath, 'utf8')).nextRow ?? 0;

  const tables = {};            // table -> rows
  const rawRows = [];
  const conflicts = [];
  const unmapped = new Map();   // domain_key|raw_value -> count
  let header = null;
  let processed = 0;
  let scrapedMin = null; let scrapedMax = null;
  const runIds = new Set();

  const ctx = {
    batchId,
    emit(table, row) { (tables[table] ??= []).push(row); },
    conflict(kind, detail) { if (conflicts.length < 5000) conflicts.push({ kind, ...detail }); },
    unmapped(domain, value) {
      const k = `${domain}\0${value}`;
      unmapped.set(k, (unmapped.get(k) ?? 0) + 1);
    },
    id: deterministicId,
  };

  for await (const { rowNumber, record } of csvRows(filePath)) {
    header ??= Object.keys(record);
    if (rowNumber <= startRow) continue;
    if (pilot !== null && processed >= pilot) break;
    processed += 1;
    if (record.run_id) runIds.add(record.run_id);
    if (record.scraped_at) {
      scrapedMin = scrapedMin === null || record.scraped_at < scrapedMin ? record.scraped_at : scrapedMin;
      scrapedMax = scrapedMax === null || record.scraped_at > scrapedMax ? record.scraped_at : scrapedMax;
    }
    const payloadSha = sha256(JSON.stringify(record));
    rawRows.push({
      id: deterministicId('src', batchId, rowNumber),
      import_batch_id: batchId, source_table: fileSet, source_row_number: rowNumber,
      property_data_id: record.property_data_id ?? null,
      payload_sha256: payloadSha, scraped_at: record.scraped_at ?? null,
      // payload stored separately only in full mode to keep partitions light:
      payload: record,
    });
    mapper(record, ctx, rowNumber);
    if (!dryRun && processed % 5000 === 0) {
      mkdirSync(dirname(ckptPath), { recursive: true });
      writeFileSync(ckptPath, JSON.stringify({ nextRow: rowNumber }));
    }
  }

  const batch = {
    id: batchId, vendor: 'dealmachine', file_set: fileSet, source_path: filePath,
    run_ids: [...runIds], file_sha256: fileSha, row_count: processed,
    schema_fingerprint: header ? sha256([...header].sort().join('')).slice(0, 16) : null,
    scraped_at_min: scrapedMin, scraped_at_max: scrapedMax,
    loaded_at: new Date().toISOString(), dry_run: dryRun, pilot,
  };

  const summary = {
    batch, tables: Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length])),
    raw_rows: rawRows.length, conflicts: conflicts.length,
    unmapped_domain_values: unmapped.size,
  };

  if (!dryRun) {
    writePartition('import_batches', batchId, [batch]);
    writePartition('source_records', batchId, rawRows);
    for (const [t, rows] of Object.entries(tables)) writePartition(t, batchId, rows);
    writePartition('unmapped_domain_values', batchId,
      [...unmapped.entries()].map(([k, n]) => {
        const [domain_key, raw_value] = k.split('\0');
        return { id: deterministicId('unm', domain_key, raw_value), domain_key, raw_value, occurrence_count: n, first_seen_batch: batchId, status: 'pending' };
      }));
    writeReport(`import_${fileSet}_${batchId}`, { summary, conflicts: conflicts.slice(0, 200) });
    if (existsSync(ckptPath)) writeFileSync(ckptPath, JSON.stringify({ done: true }));
  }
  return { ...summary, conflicts_detail: conflicts };
}
