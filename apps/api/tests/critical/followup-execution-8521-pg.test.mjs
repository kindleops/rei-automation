// The FOLLOW-UP LIFECYCLE driven by the AGENT RUNTIME on a DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL;
// skipped — reported, never vacuous — without it). Real SQL: agent.runtime_enqueue_event_at → the real
// runtime tick claims followup.execution_sweep / followup.reconcile → the lifecycle (claim lease, the real
// guard, the real hold registry, the real resolver over sms_templates, the canonical writer, the bind
// trigger) → ONE nonempty send_queue row → the real queue item path with a SIMULATED provider. The
// reconcile job is REPORT-ONLY by default; { apply: true } adopts legacy body-less rows and bare dates.
// Live transport and TextGrid credentials are trapped.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import crypto from 'node:crypto'

import { pgAvailable, skipReason, runSqlFile, applyInTransaction, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { FOLLOWUP_SWEEP_KIND, FOLLOWUP_RECONCILE_KIND, FOLLOWUP_DISPATCH_KIND, createFollowUpDeps } from '../../src/lib/domain/followups/followup-execution.js'
import { buildFollowUpHandlers } from '../../src/lib/ai/followup-runtime-wiring.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { lawfulNowIso, lifecycleDb, seedWorld, seedThread, planNurture, trapTransport, simProvider, claimRow, dispatchRow, intentsOf, rowsOf, sel, setSwitches, registryHoldCheck, OP } from '../helpers/followup-lifecycle-pg.mjs'

__setAutomationHoldResolverForTests(null)
const skip = pgAvailable() ? false : skipReason
const MIG = (f) => path.join(REPO_DIR, 'supabase/migrations', f)

async function runtimeDb() {
  const env = await lifecycleDb()
  await runSqlFile(env.db.pool, SQL.researchPretest)
  await runSqlFile(env.db.pool, SQL.research)
  await runSqlFile(env.db.pool, path.join(REPO_DIR, 'scripts/db/fixtures/legacy_conversation_turns_baseline.sql'))
  await applyInTransaction(env.db.pool, SQL.runtime)
  await applyInTransaction(env.db.pool, MIG('PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql'))
  await applyInTransaction(env.db.pool, MIG('PROPOSED_20261013161000_conversation_decide_event_budget.sql'))
  await applyInTransaction(env.db.pool, MIG('PROPOSED_20261016120000_conversation_reply_turns.sql'))
  const kinds = Object.fromEntries([FOLLOWUP_SWEEP_KIND, FOLLOWUP_RECONCILE_KIND, FOLLOWUP_DISPATCH_KIND].map((k) => [k, { enabled: true, max_concurrency: 2, armed_by: OP }]))
  await env.db.pool.query(`update agent.runtime_limits set runtime_enabled = true, max_concurrency_global = 2, tick_max_jobs = 4, kind_limits = $1::jsonb where id = 1`, [JSON.stringify(kinds)])
  return env
}

async function harness(env) {
  const store = createRuntimePgStore({ pool: env.db.api })
  const readSwitch = async (k) => (await sel(env.pool, 'select value from public.system_control where key = $1', [k]))[0]?.value ?? null
  const clock = lawfulNowIso()
  const deps = await createFollowUpDeps({ supabase: env.sb, readSwitch, now: () => clock })
  const handlers = buildFollowUpHandlers({ deps: { ...deps, holdCheck: registryHoldCheck(env.sb) } })
  const tick = (workerId = 'followup-tick') => runRuntimeTick({ store, handlers, workerId, budgetMs: 20_000 })
  const enqueue = (kind, input = {}) => store.enqueueEventAt({ kind, event_key: `${kind}:${crypto.randomUUID()}`, input, priority: 60, not_before: new Date().toISOString() })
  return { store, tick, enqueue, deps }
}
const jobsOf = (pool, kind) => sel(pool, `select state, result, attempt from agent.research_job where runtime_managed and kind = $1 order by created_at`, [kind])

test('PG runtime: the sweep JOB materializes due intents (one nonempty row each); a replayed sweep writes nothing; the row sends ONCE through the simulated provider', { skip }, async () => {
  const env = await runtimeDb()
  const net = trapTransport()
  try {
    await seedWorld(env.pool)
    const phones = ['+13125550301', '+13125550302']
    for (const p of phones) { const { inboundId } = await seedThread(env.pool, { phone: p }); assert.equal((await planNurture(env.sb, p, { inboundId })).lifecycle, true) }
    const h = await harness(env)
    await h.enqueue(FOLLOWUP_SWEEP_KIND)
    const t = await h.tick()
    assert.equal(t.jobs?.[0]?.outcome, 'completed', JSON.stringify(t))
    const [job] = await jobsOf(env.pool, FOLLOWUP_SWEEP_KIND)
    assert.equal(job.result.code, 'SWEPT', JSON.stringify(job.result))
    assert.equal(job.result.counts.materialized, 2)
    for (const p of phones) {
      const rows = await rowsOf(env.pool, p)
      assert.equal(rows.length, 1)
      assert.ok(rows[0].message_body.trim().length > 10)
      assert.equal((await intentsOf(env.pool, p))[0].state, 'ready')
    }
    await h.enqueue(FOLLOWUP_SWEEP_KIND)
    await h.tick()
    const jobs = await jobsOf(env.pool, FOLLOWUP_SWEEP_KIND)
    assert.equal(jobs[1].result.counts.claimed, 0, 'a replayed pass claims nothing')
    for (const p of phones) assert.equal((await rowsOf(env.pool, p)).length, 1)
    const provider = simProvider()
    const [row] = await rowsOf(env.pool, phones[0])
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider })
    assert.equal(provider.accepted(), 1)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG runtime: the reconcile JOB is report-only by default; { apply: true } adopts a legacy body-less row and a bare follow_up_at into intents, which then materialize nonempty', { skip }, async () => {
  const env = await runtimeDb()
  try {
    // the legacy state, written while the lifecycle was OFF (exactly what production holds today)
    await seedWorld(env.pool, { mode: null })
    const legacy = '+13125550311'; const bare = '+13125550312'
    const { inboundId } = await seedThread(env.pool, { phone: legacy })
    await seedThread(env.pool, { phone: bare })
    const off = await planNurture(env.sb, legacy, { inboundId })
    assert.equal(off.lifecycle, undefined)
    const [legacyRow] = await rowsOf(env.pool, legacy)
    assert.equal(legacyRow.message_body, '', 'the legacy writer leaves a body-less row')
    await env.pool.query(`update public.inbox_thread_state set follow_up_at = now() - interval '1 hour', disposition = 'not_interested' where thread_key = $1`, [bare])
    await setSwitches(env.pool, { followup_execution_mode: 'live' })
    const h = await harness(env)
    await h.enqueue(FOLLOWUP_RECONCILE_KIND)
    await h.tick()
    let [job] = await jobsOf(env.pool, FOLLOWUP_RECONCILE_KIND)
    assert.equal(job.result.code, 'RECONCILED')
    assert.equal(job.result.applied, false)
    assert.ok(job.result.counts.legacy_deferred_rows >= 1 && job.result.counts.unbacked_follow_up_at >= 1, JSON.stringify(job.result.counts))
    assert.equal((await sel(env.pool, 'select count(*)::int n from public.followup_intents'))[0].n, 0, 'report-only: nothing written')
    await h.enqueue(FOLLOWUP_RECONCILE_KIND, { apply: true })
    await h.tick()
    job = (await jobsOf(env.pool, FOLLOWUP_RECONCILE_KIND))[1]
    assert.equal(job.result.applied, true, JSON.stringify(job.result))
    assert.deepEqual([job.result.counts.adopted_rows, job.result.counts.adopted_dates], [1, 1], JSON.stringify(job.result.counts))
    assert.equal((await sel(env.pool, 'select queue_status, guard_reason from public.send_queue where id = $1', [legacyRow.id]))[0].guard_reason, 'superseded_by_followup_intent')
    for (const p of [legacy, bare]) assert.equal((await intentsOf(env.pool, p))[0].state, 'planned')
    await h.enqueue(FOLLOWUP_SWEEP_KIND)
    await h.tick()
    for (const p of [legacy, bare]) {
      const live = (await rowsOf(env.pool, p)).filter((r) => r.queue_status === 'scheduled')
      assert.equal(live.length, 1, `${p}: ${JSON.stringify((await intentsOf(env.pool, p)).map((i) => [i.state, i.reason]))}`)
      assert.ok(live[0].message_body.trim().length > 10)
    }
  } finally { await env.db.drop() }
})
