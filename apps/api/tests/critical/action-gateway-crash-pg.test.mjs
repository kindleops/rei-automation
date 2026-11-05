// Action Gateway phase 1, RECOVERY proofs with a REAL crash (SIGKILL of a separate process) on a DISPOSABLE
// PostgreSQL 17: exactly-once side effects or a visible failure.
//   A  killed AFTER the lease claim, BEFORE the domain write: nothing written; the lease expires; recovery
//      re-claims (attempt 2) and executes ONCE; the agent's retry replays the recorded outcome
//   B  killed WHILE the domain write is in flight inside PostgreSQL: the write commits whole with its
//      outcome (or not at all, then recovery re-executes); either way exactly one hold, never two
//   C  an intent whose recorded recovery mode is report_unknown, or whose attempts are exhausted, is NOT
//      re-executed: recovery records outcome_unknown (visible), never a silent retry
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { gatewayDb, seedWorld, registerAgent, seedThread, makeGateway, sel, audits, intentRow, outcomeRow, ORG, PEPPER } from '../helpers/action-gateway-pg.mjs'
import { credentialDigest } from '../../src/lib/domain/action-gateway/index.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null)
const CHILD = ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', '--import', './tests/register-aliases.mjs', 'tests/helpers/action-gateway-crash-child.mjs']
const childEnv = { ...process.env, NODE_ENV: 'test' }
const intentOf = async (owner, key) => (await sel(owner, `select * from action_gateway.action_intents where client_key = $1`, [key]))[0]
const holds = async (owner) => (await sel(owner, `select count(*)::int n from public.automation_holds`))[0].n
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)) } return false }

test('PG gateway RECOVERY (REAL SIGKILL, before the domain write): the lease expires, recovery re-executes EXACTLY ONCE (attempt 2), and the agent\'s retry replays the recorded outcome', { skip }, async () => {
  const env = await gatewayDb()
  try {
    await seedWorld(env.owner)
    const cred = await registerAgent(env.owner, { grants: [['holds.set_thread_hold', 2]] })
    const t = await seedThread(env.owner)
    const child = spawnSync(process.execPath, [...CHILD, env.url, ORG, cred, t.thread_id, 'before_domain_write', 'crash-a-00001'], { encoding: 'utf8', env: childEnv, timeout: 60_000 })
    assert.equal(child.signal, 'SIGKILL', `child: ${child.status} ${child.stdout} ${String(child.stderr).slice(-1200)}`)
    assert.match(child.stdout, /CLAIMED_BEFORE_DOMAIN_WRITE/)
    const crashed = await intentOf(env.owner, 'crash-a-00001')
    assert.deepEqual([crashed.state, crashed.attempt, crashed.lease_owner], ['executing', 1, 'crash-child'])
    assert.equal(await holds(env.owner), 0, 'the crash left nothing written')
    const { gateway } = makeGateway(env)
    // while the dead worker's lease is live, nobody may take the intent over
    const early = await gateway.recover()
    assert.equal(early.scanned, 0)
    assert.ok(await until(async () => Date.parse((await intentRow(env.owner, crashed.intent_id)).lease_until) < Date.now() - 50))
    const rec = await gateway.recover()
    assert.equal(rec.scanned, 1)
    assert.equal(rec.results[0].state, 'succeeded', JSON.stringify(rec))
    const after = await intentRow(env.owner, crashed.intent_id)
    assert.deepEqual([after.state, after.attempt], ['succeeded', 2])
    assert.equal(await holds(env.owner), 1, 'exactly one hold')
    const ev = (await audits(env.owner, crashed.intent_id)).map((e) => e.event_type)
    assert.ok(ev.includes('claimed') && ev.includes('reclaimed') && ev.includes('recovered') && ev.includes('intent_succeeded'), ev.join(','))
    // the agent retries its request: the recorded outcome, no second hold, no third attempt
    const retry = await gateway.call({ credential: cred, tool: 'set_thread_hold', args: { client_request_id: 'crash-a-00001', thread_id: t.thread_id, reason_code: 'operator_review' } })
    assert.deepEqual([retry.status, retry.intent_id, retry.code], ['replayed', crashed.intent_id, 'HOLD_SET'])
    assert.equal(await holds(env.owner), 1)
    assert.equal((await intentRow(env.owner, crashed.intent_id)).attempt, 2)
  } finally { await env.db.drop() }
})

test('PG gateway RECOVERY (REAL SIGKILL, inside the in-flight domain write): the write and its outcome commit together or not at all: exactly one hold either way, and recovery / retry never adds a second', { skip }, async () => {
  const env = await gatewayDb()
  const lock = await env.owner.connect()
  try {
    await seedWorld(env.owner)
    const cred = await registerAgent(env.owner, { grants: [['holds.set_thread_hold', 2]] })
    const t = await seedThread(env.owner)
    // hold the thread row so the child's domain write blocks INSIDE PostgreSQL
    await lock.query('begin')
    await lock.query('select 1 from public.inbox_thread_state where id = $1 for update', [t.thread_id])
    const child = spawn(process.execPath, [...CHILD, env.url, ORG, cred, t.thread_id, 'in_domain_write', 'crash-b-00001'], { env: childEnv })
    let out = ''
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
    child.stdout.on('data', (d) => { out += String(d); if (/IN_DOMAIN_WRITE/.test(out)) setTimeout(() => child.kill('SIGKILL'), 700) })
    const ex = await exited
    assert.equal(ex.signal, 'SIGKILL', `child exit ${JSON.stringify(ex)} ${out}`)
    await lock.query('commit') // release: the orphaned backend's statement either completes whole or never did
    await until(async () => !['executing'].includes((await intentOf(env.owner, 'crash-b-00001'))?.state) || Date.parse((await intentOf(env.owner, 'crash-b-00001'))?.lease_until) < Date.now(), 8000)
    const i = await intentOf(env.owner, 'crash-b-00001')
    const { gateway } = makeGateway(env)
    if (i.state === 'executing') {
      assert.equal(await holds(env.owner), 0, 'an executing intent has no committed write')
      assert.ok(await until(async () => Date.parse((await intentRow(env.owner, i.intent_id)).lease_until) < Date.now() - 50))
      const rec = await gateway.recover()
      assert.equal(rec.results[0]?.state, 'succeeded', JSON.stringify(rec))
    } else {
      assert.equal(i.state, 'succeeded', 'the in-flight write committed whole with its outcome')
      assert.equal((await outcomeRow(env.owner, i.intent_id)).code, 'HOLD_SET')
      assert.equal((await gateway.recover()).scanned, 0, 'nothing to recover')
    }
    assert.equal(await holds(env.owner), 1, 'exactly one hold')
    const retry = await gateway.call({ credential: cred, tool: 'set_thread_hold', args: { client_request_id: 'crash-b-00001', thread_id: t.thread_id, reason_code: 'operator_review' } })
    assert.equal(retry.status, 'replayed')
    assert.equal(await holds(env.owner), 1)
  } finally { lock.release(); await env.db.drop() }
})

test('PG gateway RECOVERY: an expired lease of a report_unknown intent, or of an intent out of attempts, becomes a VISIBLE outcome_unknown (never re-executed)', { skip }, async () => {
  const env = await gatewayDb()
  try {
    await seedWorld(env.owner)
    const cred = await registerAgent(env.owner, { grants: [['holds.set_thread_hold', 2]] })
    const t = await seedThread(env.owner)
    const { gateway, store } = makeGateway(env)
    const grant = (await sel(env.owner, `select grant_id from action_gateway.capability_grants where agent_id = 'agt_alpha'`))[0]
    const digest = credentialDigest(PEPPER, cred)
    const mk = async (key, recovery, max_attempts) => {
      const o = await store.openIntent({ agent_id: 'agt_alpha', action: 'set_thread_hold', capability: 'holds.set_thread_hold', tier: 2, resource_type: 'thread', resource_id: `${t.thread_id}`.replace(/.$/, key.slice(-1)),
        client_key: key, idempotency_key: key.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a').slice(0, 64), params: { thread_id: t.thread_id, reason_code: 'other' }, params_hash: 'f'.repeat(64), correlation_id: crypto.randomUUID(), recovery, max_attempts })
      await store.authorize(o.intent.intent_id, digest, { grant_id: grant.grant_id, policy_id: 'set_thread_hold.policy', policy_version: 'v1' })
      const c = await store.claim(o.intent.intent_id, 'dead-worker', 1)
      assert.equal(c.ok, true, JSON.stringify(c))
      return o.intent.intent_id
    }
    const unknownMode = await mk('unknown-mode-1', 'report_unknown', 3)
    const exhausted = await mk('exhausted-ab-2', 'reexecute', 1)
    await new Promise((r) => setTimeout(r, 1300))
    const rec = await gateway.recover()
    assert.equal(rec.scanned, 2)
    for (const [id, code] of [[unknownMode, 'LEASE_EXPIRED_OUTCOME_UNKNOWN'], [exhausted, 'ATTEMPTS_EXHAUSTED']]) {
      const o = await outcomeRow(env.owner, id)
      assert.deepEqual([o.status, o.code], ['outcome_unknown', code])
      assert.equal((await intentRow(env.owner, id)).state, 'outcome_unknown')
    }
    assert.equal(await holds(env.owner), 0, 'nothing re-executed')
  } finally { await env.db.drop() }
})
