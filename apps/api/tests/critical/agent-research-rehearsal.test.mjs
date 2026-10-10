// The production rehearsal runner must never commit: both migrations carry their own
// begin; … commit; — a naive BEGIN; \i … ROLLBACK; wrapper would commit at the file's commit;.
// The runner strips exactly that outer pair and refuses any other transaction control.
// With AGENT_PG_TEST_DB_URL it also proves end-to-end that a full rehearsal leaves nothing behind.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripOuterTransaction, rehearse } from '../../scripts/agent/agent-release-rehearsal.mjs'
import { pgAvailable, skipReason, freshDb } from '../pg/agent-pg-harness.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const mig = (f) => fs.readFileSync(path.join(REPO, 'supabase/migrations', f), 'utf8')

test('rehearsal: both migrations have exactly one outer begin/commit, which the runner strips', () => {
  for (const f of ['PROPOSED_20261010120000_agent_s3_persistence.sql', 'PROPOSED_20261010130000_agent_research_ro.sql']) {
    const inner = stripOuterTransaction(mig(f), f)
    assert.ok(!/^\s*(begin|commit)\s*;\s*$/im.test(inner), f)
  }
  assert.throws(() => stripOuterTransaction('begin;\nselect 1;\ncommit;\nselect 2;\ncommit;', 'x'), /another transaction-control/)
  assert.throws(() => stripOuterTransaction('select 1;', 'x'), /expected exactly one outer/)
  assert.throws(() => stripOuterTransaction('begin;\nrollback;\nselect 1;\ncommit;', 'x'), /another transaction-control/)
})

test('rehearsal (PG): full S3 + research apply, owner membership, verify — then nothing remains', { skip: pgAvailable() ? false : skipReason }, async () => {
  const db = await freshDb({ apply: false })
  try {
    const lines = []
    const r = await rehearse({ url: db.url, owner: 'a2ee0ffe-6f27-475b-a795-ee617c9472c6', log: (l) => lines.push(l) })
    assert.equal(r.ok, true, lines.join('\n'))
    assert.ok(r.checks.length >= 20)
    assert.equal(r.after.no_run, true)
    assert.equal(r.after.no_ledger, true)
    assert.equal(r.after.no_schema, true)
    const left = await db.pool.query(`select count(*)::int n from pg_namespace where nspname = 'agent'`)
    assert.equal(left.rows[0].n, 0)
  } finally {
    await db.drop()
  }
})
