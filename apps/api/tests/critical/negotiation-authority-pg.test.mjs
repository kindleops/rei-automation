// 8.5.19 — the PROPOSED negotiation + feedback tables on a DISPOSABLE local PostgreSQL.
// Skipped unless AGENT_PG_TEST_DB_URL points at a loopback scratch server (never production:
// the harness refuses any non-local host). Proves the JS row builders and the table CHECKs /
// triggers agree, and that the tables are immutable.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'

import { ADMIN_URL, pgAvailable, skipReason, urlFor, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { buildEnvelopeRow, scopeOf, underwritingHash } from '../../src/lib/domain/negotiation/envelope.js'
import { buildLedgerEventRow } from '../../src/lib/domain/negotiation/ledger.js'
import { buildFeedbackRow } from '../../src/lib/domain/operator-feedback/feedback.js'
import { buildEvalSet } from '../../src/lib/domain/operator-feedback/eval-set.js'

const MIG = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
const NEG = MIG('PROPOSED_20261015190000_negotiation_authority.sql')
const FB = MIG('PROPOSED_20261015191000_ai_operator_feedback.sql')
const available = (() => { try { return pgAvailable() } catch { return false } })()

async function freshDb() {
  const name = `neg819_${crypto.randomBytes(5).toString('hex')}`
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 })
  await admin.query(`create database ${name}`)
  await admin.end()
  const pool = new pg.Pool({ connectionString: urlFor(name), max: 4 })
  pool.on('error', () => {})
  await pool.query(fs.readFileSync(SQL.shim, 'utf8'))
  for (const f of [NEG, FB]) {
    const c = await pool.connect()
    try { await c.query('begin'); await c.query(fs.readFileSync(f, 'utf8')); await c.query('commit') } finally { c.release() }
  }
  return { pool, async drop() { await pool.end(); const a = new pg.Pool({ connectionString: ADMIN_URL, max: 1 }); await a.query(`drop database if exists ${name} with (force)`); await a.end() } }
}

const insert = (pool, table, row) => {
  const cols = Object.keys(row)
  const vals = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' && !Array.isArray(row[c]) ? JSON.stringify(row[c]) : Array.isArray(row[c]) && c === 'justification' ? JSON.stringify(row[c]) : row[c]))
  return pool.query(`insert into public.${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`, vals)
}

test('JS builders ↔ table CHECKs agree; envelope bound + immutability enforced by the database', { skip: available ? false : skipReason }, async () => {
  const db = await freshDb()
  try {
    const now = Date.now()
    const scope = scopeOf({ thread_key: '+15555550123', property_id: '227876842' })
    const econ = { class: 'NEGOTIATE', evidence: { valuation_snapshot_id: 'snap-1' }, metrics: { mao: 150000, realistic_value: { mid: 200000 } } }
    const grant = { max_price: 150000, opening_price: 130000, max_moves: 3, closing_window_min_days: 7, closing_window_max_days: 30, earnest_money_min: 500, earnest_money_max: 2000, as_is: true, closing_costs_paid_by: 'buyer', valid_from: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 7 * 864e5).toISOString() }
    const envRow = buildEnvelopeRow({ grant, scope, version: 1, approval_id: 'apr_00000000-0000-4000-8000-000000000001', granted_by: 'op-1', underwriting: { basis: {} }, underwriting_hash: underwritingHash(econ), now })
    const env = (await insert(db.pool, 'negotiation_envelopes', envRow)).rows[0]
    assert.equal(Number(env.max_price), 150000)
    await assert.rejects(() => db.pool.query('update public.negotiation_envelopes set max_price = 1'), /append-only/)
    await assert.rejects(() => db.pool.query('delete from public.negotiation_envelopes'), /append-only/)

    const ask = buildLedgerEventRow({ scope, seq: 1, event_type: 'seller_ask', actor: 'seller', amount: 170000, authority: 'seller_stated', source_message_id: 'm1', now })
    await insert(db.pool, 'negotiation_offer_events', ask)
    const over = buildLedgerEventRow({ scope, seq: 2, event_type: 'our_offer', actor: 'engine', amount: 150001, authority: 'within_envelope', envelope_id: env.envelope_id, quote_type: 'FORMAL_OFFER', now })
    await assert.rejects(() => insert(db.pool, 'negotiation_offer_events', over), /above the envelope max/)
    const ok = buildLedgerEventRow({ scope, seq: 2, event_type: 'our_offer', actor: 'engine', amount: 130000, authority: 'within_envelope', envelope_id: env.envelope_id, quote_type: 'FORMAL_OFFER', justification: ['open at opening'], now })
    await insert(db.pool, 'negotiation_offer_events', ok)
    await assert.rejects(() => db.pool.query('update public.negotiation_offer_events set amount = 1'), /append-only/)
    await assert.rejects(() => db.pool.query('truncate public.negotiation_offer_events'), /append-only/)
    const other = scopeOf({ thread_key: '+15555550199', property_id: '227876842' })
    const foreign = buildLedgerEventRow({ scope: other, seq: 1, event_type: 'our_offer', actor: 'engine', amount: 100000, authority: 'within_envelope', envelope_id: env.envelope_id, now })
    await assert.rejects(() => insert(db.pool, 'negotiation_offer_events', foreign), /scope mismatch/)

    const fb = buildFeedbackRow({ kind: 'draft_edited', ai_message_id: 'aim-1', thread_key: '+15555550123', operator_id: 'op-1', draft_text: 'What number do you have in mind?', final_text: 'What price would work for you?', note: 'softer', labels: { expected_next_action: 'get_asking_price' } })
    const stored = (await insert(db.pool, 'ai_operator_feedback', fb)).rows[0]
    assert.equal(stored.kind, 'draft_edited')
    await assert.rejects(() => db.pool.query('delete from public.ai_operator_feedback'), /append-only/)
    const set = buildEvalSet({ name: 'seller_s3', version: 1, feedback: [{ ...stored }], seed: 's', created_by: 'op-1' })
    await insert(db.pool, 'ai_eval_sets', set)
    await assert.rejects(() => insert(db.pool, 'ai_eval_sets', set), /duplicate key/)
  } finally {
    await db.drop()
  }
})
