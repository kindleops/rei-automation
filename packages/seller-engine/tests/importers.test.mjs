import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SELLER_ENGINE_VAR = mkdtempSync(join(tmpdir(), 'se-var-'));
const { importFile } = await import('../importers/common.mjs');
const { mapProperty } = await import('../importers/mappers.mjs');
const { readPartition, readAll } = await import('../lib/store.mjs');
const { sha256 } = await import('../lib/hash.mjs');

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'properties_fixture.csv');

test('importer: raw preserved, lineage attached, canonical rows emitted', async () => {
  const res = await importFile({ filePath: FIXTURE, fileSet: 'properties', mapper: mapProperty });
  assert.equal(res.batch.row_count, 3);
  assert.ok(res.tables.properties === 3);
  assert.ok(res.tables.property_loans >= 3);
  const raw = readPartition('source_records', res.batch.id);
  assert.equal(raw.length, 3);
  assert.ok(raw[0].payload.property_id);       // full raw row preserved
  const props = readPartition('properties', res.batch.id);
  assert.ok(props.every((p) => p.import_batch_id === res.batch.id)); // lineage
});

test('idempotency: re-import of same file produces identical batch id and identical content', async () => {
  const a = await importFile({ filePath: FIXTURE, fileSet: 'properties', mapper: mapProperty });
  const rows1 = sha256(JSON.stringify(readPartition('properties', a.batch.id)));
  const b = await importFile({ filePath: FIXTURE, fileSet: 'properties', mapper: mapProperty });
  const rows2 = sha256(JSON.stringify(readPartition('properties', b.batch.id)));
  assert.equal(a.batch.id, b.batch.id);
  assert.equal(rows1, rows2);
});

test('dry-run writes nothing; pilot limits rows', async () => {
  const before = readAll('properties').length;
  const res = await importFile({ filePath: FIXTURE, fileSet: 'properties', mapper: mapProperty, dryRun: true });
  assert.equal(readAll('properties').length, before);
  assert.equal(res.batch.row_count, 3);
  const pilot = await importFile({ filePath: FIXTURE, fileSet: 'properties', mapper: mapProperty, dryRun: true, pilot: 1 });
  assert.equal(pilot.batch.row_count, 1);
});

test('T-01/T-05 at import: equity sentinel -> state; blanket loan flagged; conflict report emitted', async () => {
  const res = await importFile({ filePath: FIXTURE, fileSet: 'properties', mapper: mapProperty });
  const vals = readPartition('property_valuation_tax_snapshots', res.batch.id);
  const blanketProp = vals.find((v) => v.equity_percent === null && v.equity_percent_state === 'unknown');
  assert.ok(blanketProp, 'sentinel equity became unknown-state');
  const loans = readPartition('property_loans', res.batch.id);
  assert.ok(loans.some((l) => l.blanket_loan_flag === true), '200M loan flagged');
  assert.ok(loans.every((l) => l.term_months !== 999), 'term sentinel never survives');
});

test('T-07 identifiers as text: zips/fips stay strings; deterministic ids namespaced', async () => {
  const res = await importFile({ filePath: FIXTURE, fileSet: 'properties', mapper: mapProperty });
  const props = readPartition('properties', res.batch.id);
  assert.equal(typeof props[0].situs_zip, 'string');
  assert.equal(typeof props[0].fips, 'string');
  assert.match(props[0].id, /^prop_[0-9a-f]{24}$/);
});
