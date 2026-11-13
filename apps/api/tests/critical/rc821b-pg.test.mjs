// 8.5.21-b — PostgreSQL proofs on a DISPOSABLE local PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped —
// reported, never vacuous — without it):
//   1. the PROPOSED dead-deal correction SQL is a DRY RUN by default (raises, changes nothing), applies
//      only to rows still in their planned state when the owner flips v_commit, audits every row, and
//      its rollback restores the snapshot exactly;
//   2. the supervisor's research / valuation snapshot text runs on the operations fixture schema.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { pgAvailable, skipReason, freshDb, runSqlFile, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { normalizeConversationFacts } from '../../src/lib/agent/operations/conversation-facts.js'
import { buildNotInterestedCorrectionPlan, renderCorrectionSql } from '../../src/lib/agent/operations/dead-deal-correction.js'
import { createOperationsSqlSource } from '../../src/lib/agent/operations/operations-source.js'
import { waiting, uuid, T0, D, at } from '../helpers/operations-fixtures.mjs'

const skip = pgAvailable() ? false : skipReason
const BASELINE = path.join(REPO_DIR, 'scripts/db/fixtures/operations_public_baseline.sql')
const RV_BASELINE = path.join(REPO_DIR, 'scripts/db/fixtures/research_valuation_public_baseline.sql')

test('dead-deal correction SQL: dry run by default; owner-flipped apply is guarded + audited; rollback restores exactly', { skip }, async () => {
  const db = await freshDb({ apply: false })
  try {
    await runSqlFile(db.pool, BASELINE)
    // the production columns the correction writes (information_schema, read-only, 2026-10-16)
    await db.pool.query(`alter table public.acquisition_opportunities add column if not exists version integer not null default 1, add column if not exists last_updated_source text not null default 'system';
      alter table public.acquisition_opportunity_history add column if not exists idempotency_key text unique, add column if not exists metadata jsonb not null default '{}'::jsonb`)
    const ids = [uuid(), uuid(), uuid()]
    for (const id of ids) await db.pool.query(`insert into public.acquisition_opportunities (id, primary_property_id, acquisition_stage, opportunity_status, next_action, next_action_due, stage_entered_at) values ($1, 'p', 'closed', 'dead', null, null, $2)`, [id, at(T0 - 10 * D)])
    const facts = ids.map((id) => normalizeConversationFacts(waiting({ opportunity_id: id, opp_stage: 'closed', opp_status: 'dead', opp_stage_entered_at: at(T0 - 10 * D), opp_last_activity_at: at(T0 - 10 * D), last_meaningful_intent: 'not_interested', inbound_intents: ['not_interested'], last_inbound_at: at(T0 - 2 * D), last_meaningful_at: at(T0 - 2 * D), seller_stage: 'offer_interest' })))
    const plan = buildNotInterestedCorrectionPlan(facts, { now: T0 })
    assert.equal(plan.count, 3)
    const sql = renderCorrectionSql(plan, { tag: '20261016' })
    const before = (await db.pool.query('select id, opportunity_status, acquisition_stage, next_action from public.acquisition_opportunities order by id')).rows
    // 1 dry run: raises, nothing changes, no audit table survives
    const c = await db.pool.connect()
    try {
      await c.query('begin')
      await assert.rejects(c.query(sql.apply_sql), /DRY RUN: 3 rows would change/)
      await c.query('rollback')
    } finally { c.release() }
    assert.deepEqual((await db.pool.query('select id, opportunity_status, acquisition_stage, next_action from public.acquisition_opportunities order by id')).rows, before)
    assert.equal((await db.pool.query("select to_regclass('public._state_correction_not_interested_20261016') r")).rows[0].r, null)
    // an operator changes one row after the plan was made ⇒ that row is skipped, never forced
    await db.pool.query("update public.acquisition_opportunities set opportunity_status = 'active', acquisition_stage = 'asking_price' where id = $1", [ids[2]])
    // 2 the owner flips v_commit (simulated here, on a disposable database only)
    const commit = sql.apply_sql.replace('v_commit boolean := false;', 'v_commit boolean := true;')
    await db.pool.query(`begin; ${commit} commit;`)
    const after = (await db.pool.query('select id, opportunity_status, acquisition_stage, next_action, next_action_due from public.acquisition_opportunities order by id')).rows
    const byId = Object.fromEntries(after.map((r) => [r.id, r]))
    for (const id of ids.slice(0, 2)) assert.deepEqual([byId[id].opportunity_status, byId[id].acquisition_stage, byId[id].next_action], ['nurture', 'offer_interest', 'not_interested_30d_follow_up'])
    assert.equal(new Date(byId[ids[0]].next_action_due).toISOString(), at(T0 - 2 * D + 30 * D))
    assert.deepEqual([byId[ids[2]].opportunity_status, byId[ids[2]].acquisition_stage], ['active', 'asking_price'], 'the changed row was left alone')
    const audit = (await db.pool.query('select count(*)::int n, count(applied_after)::int applied from public._state_correction_not_interested_20261016')).rows[0]
    assert.deepEqual(audit, { n: 3, applied: 2 })
    const hist = (await db.pool.query("select count(*)::int n from public.acquisition_opportunity_history where source = 'dead-deal-correction.v1'")).rows[0].n
    assert.equal(hist, 4, 'status + stage history per applied row')
    // 3 rollback restores the snapshot for rows still in the corrected state
    await db.pool.query(`begin; ${sql.rollback_sql} commit;`)
    const restored = Object.fromEntries((await db.pool.query('select id, opportunity_status, acquisition_stage, next_action, next_action_due from public.acquisition_opportunities')).rows.map((r) => [r.id, r]))
    for (const id of ids.slice(0, 2)) assert.deepEqual([restored[id].opportunity_status, restored[id].acquisition_stage, restored[id].next_action, restored[id].next_action_due], ['dead', 'closed', null, null])
    const v = (await db.pool.query('select version, last_updated_source from public.acquisition_opportunities where id = $1', [ids[0]])).rows[0]
    assert.deepEqual(v, { version: 3, last_updated_source: 'system' }, 'versions only move forward; the source is restored')
    assert.equal(restored[ids[2]].opportunity_status, 'active')
  } finally {
    await db.drop()
  }
})

test('research / valuation snapshot text runs read-only on the operations fixture schema (counts, null negotiation tables)', { skip }, async () => {
  const db = await freshDb({ apply: false })
  try {
    await runSqlFile(db.pool, BASELINE)
    await runSqlFile(db.pool, RV_BASELINE)
    const o1 = uuid()
    await db.pool.query(`insert into public.acquisition_opportunities (id, primary_property_id, primary_thread_key, acquisition_stage, opportunity_status) values ($1, 'p1', 't1', 'offer', 'active'), ($2, 'p2', 't2', 'asking_price', 'nurture')`, [o1, uuid()])
    await db.pool.query(`insert into public.property_acquisition_scores (property_id, decision_tier, computed_at) values ('p1', 'AUTO_RANGE_OFFER', now() - interval '1 day')`)
    await db.pool.query(`insert into public.seller_offers (offer_id, opportunity_id, thread_key, purchase_price, status, sent_at) values ('o1', $1, 't1', 100000, 'sent', now() - interval '5 days')`, [o1])
    const c = await db.pool.connect()
    try {
      await c.query('begin read only')
      const source = createOperationsSqlSource({ query: async (sql, params) => (await c.query(sql, params)).rows })
      const r = await source.researchValuationSnapshot({})
      assert.deepEqual([r.valuation.live, r.valuation.offer_ready, r.valuation.missing], [2, 1, 1])
      assert.deepEqual([r.offers.sent_30d, r.offers.overdue_no_reply_72h, r.offers.overdue_opportunity_ids], [1, 1, [o1]])
      assert.equal(r.negotiations.envelopes, null, 'no negotiation tables ⇒ null (unavailable), never 0')
      await c.query('rollback')
    } finally { c.release() }
  } finally {
    await db.drop()
  }
})
