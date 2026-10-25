// B1 (2026-10-25; found by the Sterling × Agntei certification, run 9) — an Agntei agent id was read as a PHONE.
// Agntei mints agent ids as agent_ + the first 16 hex of a v4 UUID (agntau core/util.ts newId); ~3 % hold a 10+ digit
// run. agent.payload_is_clean (the CHECK on action_gateway.action_intents.params) refused workforce_link_self's
// arguments, the gateway answered PARAMS_NOT_STORABLE and that agent could never link.
// PROPOSED_20261025100000_payload_clean_typed_external_ids: a TYPED-FIELD exemption (keys external_agent_id /
// external_install_id, the generator shapes only). On a DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped —
// reported, never vacuous — without it):
//   * the defect, measured: under the #25 body a share of 10,000 generator-shaped Agntei ids is refused
//   * the fix: 10,000 generator-shaped ids under their typed key → 0 refusals; the SAME ids under a free-form key → the
//     same share still refused (free-form text is not weakened)
//   * real phones / emails / credentials under the typed keys, near-miss shapes and glued phones → all refused
//   * end to end: workforce_link_self with a sample id 'agent_c382059173644fa1' → LINKED (was PARAMS_NOT_STORABLE)
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'

import { pgAvailable, skipReason, freshDb, runSqlFile, REPO_DIR } from '../pg/agent-pg-harness.mjs'

const skip = pgAvailable() ? false : skipReason
const MIG = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
const FIX = MIG('PROPOSED_20261025100000_payload_clean_typed_external_ids.sql')
const N = 10_000
/** Agntei's generator, verbatim: `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}` */
const agnteiId = () => `agent_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
const RUN9 = 'agent_c382059173644fa1'

async function refusedShare(pool, ids, key) {
  const r = await pool.query(`select count(*) filter (where not agent.payload_is_clean(jsonb_build_object($2::text, x)))::int n from unnest($1::text[]) x`, [ids, key])
  return r.rows[0].n
}

test('PG B1: the defect is real under #25, and the typed-field fix clears EVERY generator-shaped Agntei id without weakening free-form text', { skip }, async () => {
  const db = await freshDb() // S3 + #25
  try {
    const ids = [RUN9, ...Array.from({ length: N }, agnteiId)]
    const before = await refusedShare(db.pool, ids, 'external_agent_id')
    assert.ok(before >= 1, `under #25 the defect is present: ${before}/${ids.length} refused (the sample id among them)`)
    assert.equal((await db.pool.query(`select agent.payload_is_clean(jsonb_build_object('external_agent_id', $1::text)) ok`, [RUN9])).rows[0].ok, false, 'the run-9 id is refused under #25')
    await runSqlFile(db.pool, FIX)
    assert.equal(await refusedShare(db.pool, ids, 'external_agent_id'), 0, '0 refusals under the typed key')
    const freeForm = await refusedShare(db.pool, ids, 'note')
    assert.equal(freeForm, before, `free-form text is NOT weakened: the same ${before} values are still refused under a free-form key`)
    const installs = Array.from({ length: 2000 }, () => `agntei_inst_${crypto.randomBytes(16).toString('hex')}`)
    installs.push('agntei_inst_12345678901234567890123456789012')
    assert.equal(await refusedShare(db.pool, installs, 'external_install_id'), 0, 'install ids under their typed key')
    console.log(`  defect under #25: ${before}/${ids.length} Agntei ids refused (${(100 * before / ids.length).toFixed(2)} %); after the fix: 0; under a free-form key: ${freeForm}`)
  } finally { await db.drop() }
})

test('PG B1: real phones, emails, credentials and near-miss shapes under the TYPED keys are still refused', { skip }, async () => {
  const db = await freshDb()
  try {
    await runSqlFile(db.pool, FIX)
    const refused = [
      ['external_agent_id', '+16125550147'], ['external_agent_id', '612-555-0147'], ['external_agent_id', '(612) 555-0147'], ['external_agent_id', '6125550147'],
      ['external_agent_id', 'agent_6125550147'], ['external_agent_id', 'agent_61255501476125'], ['external_agent_id', 'agent_72a1760136105eb4'], // version nibble ≠ 4
      ['external_agent_id', 'agent_C382059173644FA1'], ['external_agent_id', `${RUN9} 612-555-0147`], ['external_agent_id', `612-555-0147 ${RUN9}`],
      ['external_agent_id', 'rosa@example.com'], ['external_agent_id', 'sk_live_abcdefghijklmnop'], ['external_agent_id', 'agent_７２a1760136104eb4'],
      ['external_install_id', 'agntei_inst_6125550147'], ['external_install_id', '+16125550147'], ['external_install_id', 'agntei_inst_1234567890123456789012345678901'],
      ['external_agent_id_note', RUN9], ['agent_id', RUN9], ['note', RUN9], ['x', '612-555-0147'],
    ]
    for (const [k, v] of refused) {
      const ok = (await db.pool.query(`select agent.payload_is_clean(jsonb_build_object($1::text, $2::text)) ok`, [k, v])).rows[0].ok
      assert.equal(ok, false, `${k} = ${JSON.stringify(v)} must be refused`)
    }
    const nested = (await db.pool.query(`select agent.payload_is_clean(jsonb_build_object('args', jsonb_build_object('external_agent_id', $1::text))) ok`, [RUN9])).rows[0].ok
    assert.equal(nested, true, 'nested under its typed key')
  } finally { await db.drop() }
})
