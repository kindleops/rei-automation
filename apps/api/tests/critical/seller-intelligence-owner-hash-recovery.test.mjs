import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FILE10_SOURCE_FOLDER,
  RECOVERY_MEASURED,
  RECOVERY_OUTCOME,
  recoverOwnerHash,
  summariseRecovery,
  buildOwnerHashRecoverySql,
} from '../../src/lib/domain/seller-intelligence/owner-hash-recovery.js';

const MODULE_PATH = new URL(
  '../../src/lib/domain/seller-intelligence/owner-hash-recovery.js',
  import.meta.url,
);

/** Comments describe the absence of writes; only executable text is evidence of it. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

test('a single stored key is recovered verbatim, never transformed', () => {
  const hash = '00007768001cc8f55a578616f6471c9aa86e176f96c56be943edec8ded511229';
  const out = recoverOwnerHash([hash]);
  assert.equal(out.outcome, RECOVERY_OUTCOME.RECOVERED);
  assert.equal(out.owner_hash, hash, 'returned byte-for-byte');
});

test('duplicate sightings of the same key are still unambiguous', () => {
  const out = recoverOwnerHash(['abc', 'abc', ' abc ']);
  assert.equal(out.outcome, RECOVERY_OUTCOME.RECOVERED);
  assert.equal(out.candidate_count, 1);
});

test('AMBIGUITY IS REFUSED — no tiebreak, no majority vote', () => {
  const out = recoverOwnerHash(['hash-a', 'hash-b', 'hash-b', 'hash-b']);
  assert.equal(out.outcome, RECOVERY_OUTCOME.AMBIGUOUS);
  assert.equal(out.owner_hash, null, 'the common value is NOT chosen');
});

test('no stored key means refusal, never a computed one', () => {
  for (const input of [[], [null], [''], ['   '], undefined]) {
    const out = recoverOwnerHash(input);
    assert.equal(out.outcome, RECOVERY_OUTCOME.ABSENT);
    assert.equal(out.owner_hash, null);
  }
});

test('the module carries NO hashing or derivation primitive (§14)', () => {
  const src = stripComments(readFileSync(MODULE_PATH, 'utf8'));
  // A name/address hash under this field name is expressly prohibited, so the
  // capability must be absent from the file, not merely unused.
  for (const forbidden of ['createHash', 'sha256', 'md5', 'digest(']) {
    assert.ok(!src.includes(forbidden), `must not contain ${forbidden}`);
  }
});

test('the module has no write path (§19)', () => {
  const code = stripComments(readFileSync(MODULE_PATH, 'utf8')).toLowerCase();
  for (const forbidden of ['insert into', 'update ', 'upsert', 'delete from', 'on conflict']) {
    assert.ok(!code.includes(forbidden), `must not contain "${forbidden}"`);
  }
});

test('the recovery SQL is a single read, scoped to properties missing a hash', () => {
  const sql = buildOwnerHashRecoverySql({ limit: 500 });
  assert.ok(sql.trimStart().startsWith('select'), 'a SELECT and nothing else');
  assert.ok(sql.includes('p.owner_hash is null'), 'only properties lacking a key');
  assert.ok(sql.includes(`'${FILE10_SOURCE_FOLDER}'`));
  assert.ok(sql.includes('limit 500'));
  assert.ok(!/insert|update|delete|create|alter/i.test(sql), 'no mutation verb');
});

test('the source folder is quoted safely', () => {
  const sql = buildOwnerHashRecoverySql({ sourceFolder: "O'Brien'; drop table x; --" });
  assert.ok(sql.includes("'O''Brien''; drop table x; --'"), 'quotes are doubled');
});

test('the summary reports expected SILENT errors, not just coverage', () => {
  const results = [
    ...Array.from({ length: 100 }, () => ({ outcome: RECOVERY_OUTCOME.RECOVERED })),
    { outcome: RECOVERY_OUTCOME.AMBIGUOUS },
    { outcome: RECOVERY_OUTCOME.ABSENT },
  ];
  const s = summariseRecovery(results);
  assert.equal(s.recovered, 100);
  assert.equal(s.ambiguous, 1);
  assert.equal(s.absent, 1);
  assert.equal(s.writes_performed, 0);
  // 11 wrong out of 2,453 unambiguous => ~0.45%, so ~0 expected in 100.
  assert.ok(s.measured_silent_error_rate > 0.004 && s.measured_silent_error_rate < 0.005);
  assert.equal(s.expected_silent_errors, 0);
});

test('the measured limits are recorded honestly, including the 11 wrong', () => {
  assert.equal(RECOVERY_MEASURED.unambiguous_wrong, 11, 'the silent-error count is not rounded away');
  assert.equal(RECOVERY_MEASURED.cohort_reachable, 157);
  assert.equal(RECOVERY_MEASURED.cohort_total, 6808);
  // 157/6,808 = 2.31% — this is a subset repair, and the numbers must say so.
  assert.ok(RECOVERY_MEASURED.cohort_reachable / RECOVERY_MEASURED.cohort_total < 0.03);
});
