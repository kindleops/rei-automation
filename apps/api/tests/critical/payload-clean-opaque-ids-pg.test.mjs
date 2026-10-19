// rc-8.5.21 — agent.payload_is_clean (the CHECK on every agent jsonb column) must never reject a random
// id, and must still reject every real phone number and email. On a DISPOSABLE PostgreSQL 17
// (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it):
//   * the defect: under the S3 body a measurable share of 10,000 random v4 UUIDs under a neutral key
//     (the recovery sweep's finding doc key 'conv.<uuid>') is refused as a "phone" (finding_doc_check,
//     SQLSTATE 23514 — operations-pg failed ~1 run in 5)
//   * PROPOSED_20261019120000_payload_clean_opaque_ids: 10,000 random UUIDs and opaque ids (bare,
//     upper-case, prefixed, hex digests, base64url, in arrays, as finding docs) → 0 rejections
//   * seeded phones (every separator style, glued to or beside an id) and emails → all rejected
//   * the rollback restores the S3 function body byte-for-byte
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { pgAvailable, skipReason, freshDb, runSqlFile, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import path from 'node:path'

const skip = pgAvailable() ? false : skipReason
const ROLLBACK = path.join(REPO_DIR, 'supabase/migrations/PROPOSED_20261019120000_payload_clean_opaque_ids_rollback.sql')
const N = 10_000

const b = (n, enc = 'hex') => crypto.randomBytes(n).toString(enc)
const ID_SHAPES = [
  (u) => ({ finding_type: 'recovery.candidate', key: `conv.${u}`, source_id: 'public.inbox_thread_state' }),
  (u) => ({ note: u }),
  (u) => ({ note: u.toUpperCase() }),
  (u) => ({ finding_id: `fnd_${u}`, citation: `inbox_thread_state:${u}` }),
  (u) => ({ refs: [`apr_${u}`, `mjob_${u}`, u] }),
  () => ({ digest: b(16), sha1: b(20), sha256: b(32), object_id: b(12) }),
  () => ({ opaque: b(12, 'base64url'), run_ref: `run_${b(16)}` }),
  (u) => ({ items: [{ subject: u, detail: { conversation: `conv.${u}` } }] }),
]
/** 10,000 docs, each carrying at least one random id; deterministic shape rotation, random ids. */
function randomIdDocs() {
  return Array.from({ length: N }, (_, i) => ID_SHAPES[i % ID_SHAPES.length](crypto.randomUUID()))
}

const U = '84512937-4021-4abc-8123-456789012345'
const SEEDED_CONTACTS = [
  '612-555-0147', '(612) 555-0147', '+1 612 555 0147', '6125550147', '612.555.0147', '+16125550147', '1-612-555-0147',
  '612 555 0147', 'conv.6125550147', 'tel6125550147', 'a6125550147b', '+44 20 7946 0958',
  `${U} 612-555-0147`, `6125550147-${U}`, `call 612 555 0147 re fnd_${U}`, `${U}, (612) 555-0147`,
  'rosa@example.com', 'x rosa.m+1@mail.example.org y', `${U} rosa@example.com`,
]

async function rejectedCount(pool, docs) {
  const r = await pool.query(`select count(*)::int n from jsonb_array_elements($1::jsonb) e where not agent.payload_is_clean(e)`, [JSON.stringify(docs)])
  return r.rows[0].n
}

test('PG payload_is_clean: the S3 body refuses random UUIDs under a neutral key (the defect, measured)', { skip }, async () => {
  const db = await freshDb({ opaqueIds: false })
  try {
    const docs = Array.from({ length: N }, () => ({ finding_type: 'recovery.candidate', key: `conv.${crypto.randomUUID()}`, source_id: 'public.inbox_thread_state' }))
    const n = await rejectedCount(db.pool, docs)
    // P(a v4 UUID reads as a phone) ≈ 9 %: 10,000 draws below 300 are essentially impossible
    assert.ok(n > 300, `the defect is present on the S3 body (${n} / ${N} rejected)`)
  } finally {
    await db.drop()
  }
})

test(`PG payload_is_clean (opaque ids fix): ${N} random UUIDs and ids → 0 rejections; every seeded phone and email is still rejected`, { skip }, async () => {
  const db = await freshDb()
  try {
    const marker = (await db.pool.query(`select obj_description('agent.payload_string_violation(text,text,integer)'::regprocedure, 'pg_proc') c`)).rows[0].c
    assert.equal(marker, 'payload_clean_opaque_ids@1', 'the harness applies the fix after S3, as production will')
    const docs = randomIdDocs()
    assert.equal(await rejectedCount(db.pool, docs), 0, 'no random id is ever a phone')
    const missed = []
    for (const s of SEEDED_CONTACTS) {
      for (const doc of [{ note: s }, { key: s }, { refs: [s] }, { detail: { text_value: s } }]) {
        const clean = (await db.pool.query('select agent.payload_is_clean($1::jsonb) c', [JSON.stringify(doc)])).rows[0].c
        if (clean) missed.push(JSON.stringify(doc))
      }
    }
    assert.deepEqual(missed, [], 'every seeded phone and email is still refused')
    // a bare 10-15 digit number and a raw property id are refused exactly as before
    assert.equal((await db.pool.query(`select agent.payload_is_clean('{"n": 6125550147}') c`)).rows[0].c, false)
    assert.equal((await db.pool.query(`select agent.payload_is_clean('{"property_id": "2124415662"}') c`)).rows[0].c, false)
  } finally {
    await db.drop()
  }
})

test('PG payload_is_clean (opaque ids fix): the rollback restores the S3 body byte-for-byte; re-apply is clean', { skip }, async () => {
  const db = await freshDb({ opaqueIds: false })
  try {
    const def = async () => (await db.pool.query(`select pg_get_functiondef('agent.payload_string_violation(text,text,integer)'::regprocedure) d`)).rows[0].d
    const acl = async () => (await db.pool.query(`select proacl::text a from pg_proc where oid = 'agent.payload_string_violation(text,text,integer)'::regprocedure`)).rows[0].a
    const s3 = await def()
    const s3Acl = await acl()
    await runSqlFile(db.pool, SQL.payloadOpaqueIds)
    assert.notEqual(await def(), s3)
    assert.equal(await acl(), s3Acl, 'grants unchanged by the fix')
    await runSqlFile(db.pool, ROLLBACK)
    assert.equal(await def(), s3, 'byte-for-byte S3 body')
    assert.equal(await acl(), s3Acl, 'grants unchanged by the rollback')
    assert.equal((await db.pool.query(`select obj_description('agent.payload_string_violation(text,text,integer)'::regprocedure, 'pg_proc') c`)).rows[0].c, null)
    await runSqlFile(db.pool, SQL.payloadOpaqueIds)
    assert.equal(await rejectedCount(db.pool, randomIdDocs().slice(0, 1000)), 0)
  } finally {
    await db.drop()
  }
})
