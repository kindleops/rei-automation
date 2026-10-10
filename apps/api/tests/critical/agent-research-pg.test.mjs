// Read-only research agent — Postgres proofs (PROPOSED_20261010130000_agent_research_ro):
// migration round-trip, grants, RLS, the serialized cap trigger (day / cycle /
// run / escalation / DB kill switch), 24-way concurrent reserves never crossing
// the day cap, append-only audit, actor binding, and the real JS store as agent_api
// storing an answer that passes agent.payload_is_clean. Needs AGENT_PG_TEST_DB_URL.
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

import { pgAvailable, skipReason, freshDb, runSqlFile, SQL } from '../pg/agent-pg-harness.mjs'
import { createResearchPgStore } from '../../src/lib/agent/research/research-store.js'
import { createResearchToolRegistry, toApiName } from '../../src/lib/agent/research/research-tools.js'
import { createModelResolver } from '../../src/lib/agent/research/models.js'
import { createAskService } from '../../src/lib/agent/research/ask-service.js'
import { OWNER, CAMPAIGN, makeTables, fakeDb, fakeServices, fakeProvider, toolUse, reply, answer } from '../helpers/agent-research-fake.mjs'

const skip = pgAvailable() ? false : skipReason
const ENV = { NODE_ENV: 'development', AGENT_ENABLED: '1', AGENT_LIVE_ROUTES: '1', AGENT_RESEARCH_ENABLED: '1', AGENT_MAX_MODE: 'read', AGENT_SPEND_GLOBAL_DAILY_USD: '10', AGENT_SPEND_USER_DAILY_USD: '10', AGENT_SPEND_CYCLE_USD: '150' }

async function researchDb() {
  const db = await freshDb()
  await runSqlFile(db.pool, SQL.researchPretest)
  await runSqlFile(db.pool, SQL.research)
  return db
}

async function newRun(api, id, op = OWNER) {
  await api.query(`insert into agent.research_run (run_id, org_id, operator_id, state, question_sha256, question_chars) values ($1, '00000000-0000-4000-8000-00000000a001', $2, 'running', repeat('a', 64), 1)`, [id, op])
}
const reserve = (api, run, usd, purpose = 'default', op = OWNER) => api.query(`insert into agent.spend_ledger (run_id, operator_id, model, purpose, day, cycle, reserved_usd, state) values ($1, $2, 'claude-haiku-5-5', $3, '2000-01-01', '2000-01', $4, 'reserved') returning reserve_id, day, cycle`, [run, op, purpose, usd])
const code = (re) => (e) => re.test(String(e.message))

test('PG research: round trip (pretest → apply → rollback → pretest → apply); the S3 schema is untouched by the research rollback', { skip }, async () => {
  const db = await researchDb()
  try {
    const n = async () => Number((await db.pool.query(`select count(*) from pg_tables where schemaname = 'agent'`)).rows[0].count)
    assert.equal(await n(), 18)
    await assert.rejects(runSqlFile(db.pool, SQL.researchPretest), code(/already exist/))
    await runSqlFile(db.pool, SQL.researchRollback)
    assert.equal(await n(), 14, 'only the 4 research tables went')
    assert.ok((await db.pool.query(`select to_regclass('agent.run') r`)).rows[0].r)
    await runSqlFile(db.pool, SQL.researchPretest)
    await runSqlFile(db.pool, SQL.research)
    assert.equal(await n(), 18)
    // the research rollback refuses while a run is in flight
    await newRun(db.pool, 'ask_inflight0001')
    await assert.rejects(runSqlFile(db.pool, SQL.researchRollback), code(/still running/))
  } finally {
    await db.drop()
  }
})

test('PG research: grants — anon / authenticated nothing; agent_api no DELETE, no limits update, audit insert-only; RLS forced', { skip }, async () => {
  const db = await researchDb()
  try {
    const { rows } = await db.pool.query(`
      select t, r,
        has_table_privilege(r, 'agent.' || t, 'SELECT') s, has_table_privilege(r, 'agent.' || t, 'INSERT') i,
        has_table_privilege(r, 'agent.' || t, 'UPDATE') u, has_table_privilege(r, 'agent.' || t, 'DELETE') d, has_table_privilege(r, 'agent.' || t, 'TRUNCATE') tr
      from unnest(array['research_limits','research_run','research_audit','spend_ledger']) t, unnest(array['anon','authenticated','agent_api']) r order by 1, 2`)
    const m = Object.fromEntries(rows.map((x) => [`${x.t}:${x.r}`, `${x.s ? 'S' : '-'}${x.i ? 'I' : '-'}${x.u ? 'U' : '-'}${x.d ? 'D' : '-'}${x.tr ? 'T' : '-'}`]))
    assert.deepEqual(m, {
      'research_audit:agent_api': 'SI---', 'research_audit:anon': '-----', 'research_audit:authenticated': '-----',
      'research_limits:agent_api': 'S----', 'research_limits:anon': '-----', 'research_limits:authenticated': '-----',
      'research_run:agent_api': 'SIU--', 'research_run:anon': '-----', 'research_run:authenticated': '-----',
      'spend_ledger:agent_api': 'SIU--', 'spend_ledger:anon': '-----', 'spend_ledger:authenticated': '-----',
    })
    const rls = await db.pool.query(`select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'agent'::regnamespace and relname in ('research_limits','research_run','research_audit','spend_ledger')`)
    assert.ok(rls.rows.length === 4 && rls.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity))
    const fx = await db.pool.query(`select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') au from pg_proc p where pronamespace = 'agent'::regnamespace and proname in ('spend_ledger_guard','research_audit_guard','research_run_guard','research_limits_guard','spend_committed')`)
    assert.equal(fx.rows.length, 5)
    assert.ok(fx.rows.every((r) => !r.a && !r.au))
    // agent_api cannot raise its own limits or switch spend on
    await assert.rejects(db.api.query(`update agent.research_limits set enabled = true`), code(/permission denied/))
    // lower-only ceilings even for the owner path
    await assert.rejects(db.pool.query(`update agent.research_limits set day_usd = 10.01`), code(/check/i))
    await assert.rejects(db.pool.query(`update agent.research_limits set cycle_usd = 151`), code(/check/i))
    await assert.rejects(db.pool.query(`update agent.research_limits set escalation_calls_per_run = 3`), code(/check/i))
  } finally {
    await db.drop()
  }
})

test('PG research: the cap trigger — DB switch off by default; day / run / escalation caps; server time owns day + cycle', { skip }, async () => {
  const db = await researchDb()
  try {
    await newRun(db.api, 'ask_caps00000001')
    await assert.rejects(reserve(db.api, 'ask_caps00000001', 0.01), code(/AGENT_RESEARCH_DISABLED/), 'applied with spend OFF')
    await db.pool.query(`update agent.research_limits set enabled = true, updated_by = 'test'`)
    const r = await reserve(db.api, 'ask_caps00000001', 0.5)
    assert.notEqual(String(r.rows[0].day), '2000-01-01', 'the client day is ignored')
    assert.notEqual(r.rows[0].cycle, '2000-01')
    await assert.rejects(reserve(db.api, 'ask_caps00000001', 2.01), code(/AGENT_SPEND_CAP_RUN/))
    // escalation: ≤ 2 calls, ≤ $2
    await newRun(db.api, 'ask_esc000000001')
    await reserve(db.api, 'ask_esc000000001', 1.0, 'escalation')
    await assert.rejects(reserve(db.api, 'ask_esc000000001', 1.01, 'escalation'), code(/AGENT_ESCALATION_CAP_USD/))
    await reserve(db.api, 'ask_esc000000001', 0.9, 'escalation')
    await assert.rejects(reserve(db.api, 'ask_esc000000001', 0.01, 'escalation'), code(/AGENT_ESCALATION_CAP_(CALLS|USD)/))
    // day cap: fill to $10 across runs
    for (let i = 0; i < 4; i++) { await newRun(db.api, `ask_day0000000${i}`); await reserve(db.api, `ask_day0000000${i}`, 1.5) }
    const committed = Number((await db.api.query(`select sum(agent.spend_committed(state, reserved_usd, actual_usd)) s from agent.spend_ledger`)).rows[0].s)
    await newRun(db.api, 'ask_dayover00001')
    await assert.rejects(reserve(db.api, 'ask_dayover00001', +(10 - committed + 0.01).toFixed(4)), code(/AGENT_SPEND_CAP_DAY/))
    // cycle cap (owner lowers it): binds before the day cap
    await db.pool.query(`update agent.research_limits set cycle_usd = ${committed.toFixed(4)}`)
    await assert.rejects(reserve(db.api, 'ask_dayover00001', 0.01), code(/AGENT_SPEND_CAP_CYCLE/))
    // a reserve for another operator's run, or a finished run, is refused
    await db.pool.query(`update agent.research_limits set cycle_usd = 150`)
    await assert.rejects(reserve(db.api, 'ask_dayover00001', 0.01, 'default', '0b0b0b0b-0000-4000-8000-00000000b0b0'), code(/AGENT_SPEND_ACTOR_MISMATCH/))
    // the DB switch stops spend immediately, mid-run
    await db.pool.query(`update agent.research_limits set enabled = false`)
    await assert.rejects(reserve(db.api, 'ask_dayover00001', 0.01), code(/AGENT_RESEARCH_DISABLED/))
  } finally {
    await db.drop()
  }
})

test('PG research: ledger transitions — reserved → settled / released / unknown; reserve amount immutable; unknown stays counted', { skip }, async () => {
  const db = await researchDb()
  try {
    await db.pool.query(`update agent.research_limits set enabled = true`)
    await newRun(db.api, 'ask_ledger000001')
    const a = (await reserve(db.api, 'ask_ledger000001', 0.2)).rows[0].reserve_id
    const b = (await reserve(db.api, 'ask_ledger000001', 0.2)).rows[0].reserve_id
    const c = (await reserve(db.api, 'ask_ledger000001', 0.2)).rows[0].reserve_id
    await db.api.query(`update agent.spend_ledger set state = 'settled', actual_usd = 0.013 where reserve_id = $1`, [a])
    await db.api.query(`update agent.spend_ledger set state = 'released' where reserve_id = $1`, [b])
    await db.api.query(`update agent.spend_ledger set state = 'unknown' where reserve_id = $1`, [c])
    await assert.rejects(db.api.query(`update agent.spend_ledger set reserved_usd = 0.01 where reserve_id = $1`, [a]), code(/AGENT_SPEND_IMMUTABLE/))
    await assert.rejects(db.api.query(`update agent.spend_ledger set state = 'reserved', actual_usd = null where reserve_id = $1`, [a]), code(/AGENT_SPEND_TRANSITION|check/i))
    await assert.rejects(db.api.query(`delete from agent.spend_ledger where reserve_id = $1`, [a]), code(/permission denied/))
    const s = Number((await db.api.query(`select sum(agent.spend_committed(state, reserved_usd, actual_usd)) s from agent.spend_ledger`)).rows[0].s)
    assert.equal(s, 0.213, 'settled actual + unknown at its reserve; released counts 0')
  } finally {
    await db.drop()
  }
})

test('PG research: 24 concurrent reserves as agent_api never cross the day cap (serialized trigger)', { skip }, async () => {
  const db = await researchDb()
  try {
    await db.pool.query(`update agent.research_limits set enabled = true, day_usd = 10`)
    for (let i = 0; i < 24; i++) await newRun(db.api, `ask_conc${String(i).padStart(8, '0')}`)
    const pools = Array.from({ length: 24 }, () => db.newPool(1))
    const results = await Promise.allSettled(pools.map((p, i) => reserve(p, `ask_conc${String(i).padStart(8, '0')}`, 0.5)))
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const capped = results.filter((r) => r.status === 'rejected' && /AGENT_SPEND_CAP_DAY/.test(r.reason.message)).length
    assert.equal(ok, 20)
    assert.equal(capped, 4)
    const total = Number((await db.pool.query(`select sum(reserved_usd) s from agent.spend_ledger`)).rows[0].s)
    assert.equal(total, 10)
  } finally {
    await db.drop()
  }
})

test('PG research: audit is append-only and actor-bound; a terminal run never reopens; named operators only', { skip }, async () => {
  const db = await researchDb()
  try {
    await newRun(db.api, 'ask_audit0000001')
    await db.api.query(`insert into agent.research_audit (run_id, actor_user_id, kind, name, doc) values ('ask_audit0000001', $1, 'run_start', 'research.ask', '{}')`, [OWNER])
    await assert.rejects(db.api.query(`insert into agent.research_audit (run_id, actor_user_id, kind) values ('ask_audit0000001', 'someone-else', 'tool_call')`), code(/AGENT_AUDIT_ACTOR_MISMATCH/))
    await assert.rejects(db.api.query(`update agent.research_audit set outcome = 'x'`), code(/permission denied|APPEND_ONLY/))
    await assert.rejects(db.api.query(`delete from agent.research_audit`), code(/permission denied|APPEND_ONLY/))
    await assert.rejects(db.api.query(`insert into agent.research_audit (run_id, actor_user_id, kind, doc) values ('ask_audit0000001', $1, 'tool_call', '{"note":"call 612-555-0147"}')`, [OWNER]), code(/check/i), 'payload_is_clean on audit docs')
    await db.api.query(`update agent.research_run set state = 'completed', ended_at = now(), outcome = 'completed' where run_id = 'ask_audit0000001'`)
    await assert.rejects(db.api.query(`update agent.research_run set state = 'running', ended_at = null where run_id = 'ask_audit0000001'`), code(/AGENT_RUN_TERMINAL/))
    await assert.rejects(newRun(db.api, 'ask_shared000001', 'service_role'), code(/research_run_operator_named/))
    await assert.rejects(newRun(db.api, 'ask_shared000002', 'system:cron'), code(/research_run_operator_named/))
  } finally {
    await db.drop()
  }
})

test('PG research: the real store as agent_api — a full ask persists runs, audit, settled ledger and a payload_is_clean answer', { skip }, async () => {
  const db = await researchDb()
  try {
    await db.pool.query(`update agent.research_limits set enabled = true`)
    const store = createResearchPgStore({ pool: db.api })
    assert.equal(await store.assertLeastPrivilege(), true)
    await assert.rejects(createResearchPgStore({ pool: db.pool }).assertLeastPrivilege(), { code: 'AGENT_STORE_ROLE_PRIVILEGED' })
    const provider = fakeProvider([
      reply([toolUse(toApiName('campaign.audience_top'), { campaign_id: CAMPAIGN, limit: 3 })]),
      answer(`HOT LEADS (${CAMPAIGN}) as of 2026-10-10 09:37:11: property 2124415662 leads (aos 90, 1,850 ft², 1½ baths); 2124358658 second. Phone on file ends 47.`),
    ])
    const ask = createAskService({ store, registry: createResearchToolRegistry(), provider, resolver: createModelResolver({ provider, env: ENV }), createServices: () => fakeServices(fakeDb(makeTables())), env: ENV })
    const { run_id, done } = await ask.ask({ operator_id: OWNER, identity: { verified: true, named: true, user_id: OWNER, method: 'supabase_jwt' }, question: 'Investigate HOT LEADS', context: { campaign_id: CAMPAIGN } })
    const r = await done
    assert.equal(r.state, 'completed', JSON.stringify(r))
    assert.equal(r.persist_error, undefined)
    const s = await ask.status(run_id, OWNER)
    assert.match(s.answer.answer_md, /2124415662 leads/)
    assert.match(s.answer.answer_md, /2026-10-10 09:37:11/)
    assert.match(s.answer.answer_md, new RegExp(CAMPAIGN))
    assert.ok(s.answer.property_ids.includes('2124415662'))
    assert.equal(s.calls.length, 2)
    const ledger = (await db.pool.query(`select state, reserved_usd, actual_usd from agent.spend_ledger where run_id = $1`, [run_id])).rows
    assert.equal(ledger.length, 2)
    assert.ok(ledger.every((l) => l.state === 'settled' && Number(l.actual_usd) <= Number(l.reserved_usd)))
    const raw = (await db.pool.query(`select answer::text a from agent.research_run where run_id = $1`, [run_id])).rows[0].a
    assert.ok(!/2124415662/.test(raw), 'ids are encoded at rest')
    assert.equal(Number((await db.pool.query(`select count(*) from agent.research_audit where run_id = $1`, [run_id])).rows[0].count), s.audit.length)
    assert.equal(await store.runsToday(OWNER), 1)
  } finally {
    await db.drop()
  }
})

void pg
