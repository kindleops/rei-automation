// rc-8.5.21 blind-eval RUN-13 — a conversation.turn job stopped by the AI spend guard. On a DISPOSABLE
// PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it): the REAL runtime
// (agent.runtime_reserve refuses the spend and parks the job budget_blocked), the REAL turn store
// (public.conversation_reply_turns), the REAL handler with the production job tracker
// (runtimeJobTracker → ctx.reserve). Global fetch is trapped: no model / provider call can happen.
//   the job stays budget_blocked (safe: no composition, no fallback, no send) AND
//   the turn is NOT left claimed: it is finalized with BUDGET_EXHAUSTED, re-opened (pending, version + 1,
//     close_reason budget_exhausted) and ONE new conversation.turn job is scheduled an hour out —
//     bounded: after MAX_BUDGET_RESCHEDULES the turn stays decided with that reason, no new job;
//   ONE immediate budget-notice job per block raises the operator work item (reason budget_exhausted)
//     under ITS OWN lease through the lease-bound writer (the parked job's lease is gone);
//   the supervisor surfaces it too (conversation_turn_budget: warn + an escalation with reason budget_exhausted).
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { e2eDb, seed, harness, sel, ENV, provider as fakeModelProvider } from '../helpers/conversation-e2e-pg.mjs'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { CONVERSATION_TURN_KIND, MAX_BUDGET_RESCHEDULES, decodeTurnJobInput } from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'
import { createConversationTurnHandler } from '../../src/lib/ai/conversation-turn-handler.js'
import { runtimeJobTracker } from '../../src/lib/ai/conversation-decide-handler.js'
import { evaluateSupervisor } from '../../src/lib/agent/operations/supervisor-checks.js'

const skip = pgAvailable() ? false : skipReason

test('PG RUN-13: the AI budget refuses the turn\'s model call ⇒ job budget_blocked, turn released + re-scheduled with reason budget_exhausted (bounded), ONE operator work item per block via the lease-bound writer (notice job), supervisor escalation; zero model calls, zero sends', { skip }, async () => {
  const env = await e2eDb()
  const real = globalThis.fetch
  const hits = []
  globalThis.fetch = async (u) => { hits.push(String(u)); throw new Error(`LIVE_TRANSPORT_TOUCHED ${String(u).slice(0, 40)}`) }
  try {
    await seed(env.pool)
    const h = harness(env)
    const dispatched = []
    const items = []
    // a LOCAL fake model provider (never a network / API call): it counts every createMessage
    const model = fakeModelProvider()
    let modelCalls = 0
    const countingModel = { ...model, createMessage: async (...a) => { modelCalls += 1; return model.createMessage(...a) } }
    // the production composition: the canonical decider spends through THIS job (ctx.reserve)
    const handler = createConversationTurnHandler({
      env: ENV, store: h.turnStore, supabase: env.sb, runtimeStore: h.store, trackerFor: runtimeJobTracker, provider: countingModel,
      dispatch: async (x) => { dispatched.push(x); throw new Error('DISPATCH_MUST_NOT_RUN') },
      operatorItems: { syncWorkItems: async (a) => { items.push(a); return { ok: true } } },
    })
    const tick = () => runRuntimeTick({ store: h.store, handlers: { [CONVERSATION_TURN_KIND]: handler }, workerId: 'budget-tick', budgetMs: 20_000 })
    const routed = await h.route()
    assert.equal(routed.code, 'TURN_OPENED', JSON.stringify(routed))

    const blocks = []
    for (let i = 0; i <= MAX_BUDGET_RESCHEDULES; i += 1) {
      await h.makeDue()
      const t = await tick()
      blocks.push(t.jobs?.[0]?.outcome)
      assert.equal(t.jobs?.[0]?.outcome, 'budget_blocked', `tick ${i}: ${JSON.stringify(t)}`)
      const turn = (await sel(env.pool, `select turn_id, state, version, close_reason, due_at > now() + interval '50 minutes' later, result from public.conversation_reply_turns`))[0]
      const jobs = await sel(env.pool, `select job_id, state, input, last_error, next_attempt_at > now() + interval '50 minutes' later from agent.research_job where kind = $1 order by created_at`, [CONVERSATION_TURN_KIND])
      const parked = jobs.filter((j) => j.state === 'budget_blocked')
      assert.equal(parked.length, i + 1, 'every blocked job stays parked budget_blocked (safe, visible)')
      assert.ok(parked.every((j) => j.last_error?.code), JSON.stringify(parked.map((j) => j.last_error)))
      const queued = jobs.filter((j) => ['queued', 'retrying'].includes(j.state))
      const notices = queued.filter((j) => decodeTurnJobInput(j.input)?.budget_notice)
      const turnJobs = queued.filter((j) => !decodeTurnJobInput(j.input)?.budget_notice)
      // the budget NOTICE: ONE immediate job (its own lease) per block
      assert.equal(notices.length, 1, JSON.stringify(queued.map((j) => j.input)))
      assert.equal(notices[0].later, false, 'the notice is due now, not an hour out')
      if (i < MAX_BUDGET_RESCHEDULES) {
        // released (never left claimed) and re-scheduled ONCE, an hour out, with the durable reason
        assert.deepEqual([turn.state, turn.version, turn.close_reason, turn.later], ['pending', i + 2, 'budget_exhausted', true], JSON.stringify(turn))
        assert.equal(turnJobs.length, 1, JSON.stringify(jobs.map((j) => j.state)))
        assert.equal(turnJobs[0].later, true)
        assert.deepEqual(decodeTurnJobInput(turnJobs[0].input), { turn_id: turn.turn_id, version: i + 2, budget_blocks: i + 1 })
        assert.deepEqual(decodeTurnJobInput(notices[0].input), { turn_id: turn.turn_id, version: i + 1, budget_blocks: i + 1, budget_notice: 'rescheduled' })
      } else {
        // the bound: the turn stays decided with the reason, no new TURN job (an owner raises the budget + requeues)
        assert.equal(turn.state, 'decided', JSON.stringify(turn))
        assert.equal(turn.result?.code, 'BUDGET_EXHAUSTED')
        assert.equal(turn.result?.send_status, 'not_sent_budget_exhausted')
        assert.equal(turnJobs.length, 0)
        assert.equal(jobs.filter((j) => ['claimed', 'running'].includes(j.state)).length, 0)
        assert.deepEqual(decodeTurnJobInput(notices[0].input), { turn_id: turn.turn_id, version: i + 1, budget_blocks: i, budget_notice: 'closed' })
      }
      // the notice job runs at once (the re-scheduled turn job is an hour out): under ITS OWN lease it raises
      // the operator work item through the lease-bound writer, never claims the turn, never spends
      const before = items.length
      const turnBefore = (await sel(env.pool, `select state, version, claim_token from public.conversation_reply_turns`))[0]
      const nt = await tick()
      assert.equal(nt.jobs?.length, 1, JSON.stringify(nt))
      assert.equal(nt.jobs[0].outcome, 'completed', JSON.stringify(nt))
      const doneNotice = (await sel(env.pool, `select state, result from agent.research_job where job_id = $1`, [notices[0].job_id]))[0]
      assert.equal(doneNotice.state, 'completed')
      assert.equal(doneNotice.result?.code ?? doneNotice.result?.result?.code, 'TURN_BUDGET_NOTICE_RAISED', JSON.stringify(doneNotice))
      assert.equal(items.length, before + 1, 'one lease-bound work-item write')
      const w = items[items.length - 1]
      assert.equal(w.job_id, notices[0].job_id, 'written under the NOTICE job\'s lease')
      assert.ok(w.token, 'a lease token rides the write')
      assert.equal(w.items.length, 1)
      const item = w.items[0]
      assert.equal(item.dedupe_key, `conversation:turn_budget_exhausted:${turn.turn_id}`)
      assert.equal(item.subject_id, turn.turn_id)
      assert.equal(item.detail.reason, 'budget_exhausted')
      assert.equal(item.detail.turn_state, i < MAX_BUDGET_RESCHEDULES ? 'rescheduled' : 'decided_budget_exhausted')
      assert.equal(item.escalated, true)
      // the item passes the REAL payload-cleanliness predicate the writer's table enforces
      const clean = (await sel(env.pool, `select agent.payload_is_clean($1::jsonb) d, agent.payload_is_clean(jsonb_build_object('title', $2::text)) t`, [JSON.stringify(item.detail), item.title]))[0]
      assert.deepEqual([clean.d, clean.t], [true, true])
      assert.deepEqual((await sel(env.pool, `select state, version, claim_token from public.conversation_reply_turns`))[0], turnBefore, 'the notice never touches the turn')
    }
    assert.equal(blocks.length, MAX_BUDGET_RESCHEDULES + 1)
    // safe: nothing composed, nothing reserved, nothing queued, nothing sent, no model call
    assert.equal(dispatched.length, 0)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where message_origin = 'ai_generated'`))[0].n, 0)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.ai_generated_messages`))[0].n, 0)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.idempotency_ledger where scope = 'inbound_reply'`))[0].n, 0)
    assert.deepEqual(hits, [], 'no model / provider network call')
    assert.equal(modelCalls, 0, 'the spend guard refused BEFORE any model call')

    // the operator surface: the supervisor over the runtime's 24 h job list
    const jobs = await sel(env.pool, `select job_id, kind, state, last_error from agent.research_job`)
    assert.equal(jobs.filter((j) => j.state === 'completed').length, MAX_BUDGET_RESCHEDULES + 1, 'every notice job completed')
    const ev = evaluateSupervisor({ snapshot: { unavailable: 'X' }, runtime: { jobs } })
    const c = ev.checks.find((x) => x.id === 'conversation_turn_budget')
    assert.equal(c.status, 'warn')
    assert.equal(c.value.budget_blocked_24h, MAX_BUDGET_RESCHEDULES + 1)
    assert.equal(c.value.reason, 'budget_exhausted')
    const issue = ev.issues.find((x) => x.dedupe_key === 'supervisor:conversation_turn_budget_exhausted')
    assert.ok(issue && issue.escalate === true && issue.remediation.reason === 'budget_exhausted', JSON.stringify(issue))
    assert.equal(ev.all_clear, false)
    // and nothing budget-blocked ⇒ ok
    const ok = evaluateSupervisor({ snapshot: { unavailable: 'X' }, runtime: { jobs: jobs.map((j) => ({ ...j, state: 'completed' })) } }).checks.find((x) => x.id === 'conversation_turn_budget')
    assert.equal(ok.status, 'ok')
  } finally { globalThis.fetch = real; await env.db.drop() }
})

// ── the same contract on the in-process turn-store mirror (no PG needed) ──
import { runDueTurn, turnJobInput, turnBudgetNoticeInput, isBudgetBlock, BUDGET_RESCHEDULE_MS } from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'
import { createMemoryTurnStore } from '../../src/lib/domain/conversation-ai/turns/turn-store.js'
import { RuntimeStop } from '../../src/lib/agent/runtime/runtime-tick.js'

test('RUN-13 (memory store): a budget stop during the decision releases the claim (pending, v+1, budget_exhausted), schedules ONE job an hour out + ONE immediate notice job, rethrows the stop; the bound closes the turn with the reason (and is noticed)', async () => {
  let clock = Date.parse('2026-10-18T15:00:00.000Z')
  const store = createMemoryTurnStore({ now: () => clock })
  const opened = await store.open({ thread_key: '+13125550101', inbound_id: 'in-1', inbound_at: new Date(clock - 60_000).toISOString(), due_at: new Date(clock - 1_000).toISOString() })
  const enqueued = []
  const enqueueAt = async (o) => { enqueued.push(o); return { ok: true } }
  const budgetStop = () => Object.assign(new Error('JOB_STOP'), { code: 'JOB_STOP', abortJob: true, cause: new RuntimeStop('budget_blocked') })
  assert.equal(isBudgetBlock(budgetStop()), true)
  assert.equal(isBudgetBlock(new RuntimeStop('lease_lost')), false)
  let ref = { turn_id: opened.turn_id, version: 1 }
  for (let n = 0; n <= MAX_BUDGET_RESCHEDULES; n += 1) {
    const err = await runDueTurn({ ...ref, store, worker: 'w', decideTurn: async () => { throw budgetStop() }, enqueueAt, now: new Date(clock).toISOString() }).then(() => null, (e) => e)
    assert.ok(err && isBudgetBlock(err), 'the stop propagates: the runtime still parks / reports the job budget_blocked')
    const x = store.turns.get(opened.turn_id)
    if (n < MAX_BUDGET_RESCHEDULES) {
      assert.equal(err.budget_turn.code, 'TURN_BUDGET_RESCHEDULED')
      assert.deepEqual([x.state, x.version, x.close_reason, x.claim_token], ['pending', n + 2, 'budget_exhausted', null])
      assert.ok(Date.parse(x.due_at) - clock >= BUDGET_RESCHEDULE_MS)
      // per block: the re-scheduled turn job (an hour out) + ONE immediate budget-notice job
      const turnJobs = enqueued.filter((o) => !decodeTurnJobInput(o.input)?.budget_notice)
      const notices = enqueued.filter((o) => decodeTurnJobInput(o.input)?.budget_notice)
      assert.equal(turnJobs.length, n + 1)
      assert.equal(notices.length, n + 1)
      assert.deepEqual(turnJobs[n].input, turnJobInput({ turn_id: opened.turn_id, version: n + 2, budget_blocks: n + 1 }))
      assert.deepEqual(notices[n].input, turnBudgetNoticeInput({ turn_id: opened.turn_id, version: n + 1, budget_blocks: n + 1, state: 'rescheduled' }))
      assert.equal(Date.parse(notices[n].not_before), clock, 'the notice is due at once')
      assert.equal(err.budget_turn.notice.ok, true)
      ref = decodeTurnJobInput(turnJobs[n].input)
      clock = Date.parse(x.due_at) + 1_000
    } else {
      assert.equal(err.budget_turn.code, 'TURN_BUDGET_EXHAUSTED_CLOSED')
      assert.deepEqual([x.state, x.result?.code, x.reserved_inbound_ids], ['decided', 'BUDGET_EXHAUSTED', null])
      assert.equal(enqueued.filter((o) => !decodeTurnJobInput(o.input)?.budget_notice).length, MAX_BUDGET_RESCHEDULES, 'no turn job beyond the bound')
      const last = enqueued[enqueued.length - 1]
      assert.deepEqual(decodeTurnJobInput(last.input), { turn_id: opened.turn_id, version: n + 1, budget_blocks: n, budget_notice: 'closed' }, 'the closure is noticed too')
    }
  }
  // any other decision failure is untouched (no finalize, no reschedule)
  const other = await store.open({ thread_key: '+13125550102', inbound_id: 'in-2', inbound_at: new Date(clock - 60_000).toISOString(), due_at: new Date(clock - 1_000).toISOString() })
  const e2 = await runDueTurn({ turn_id: other.turn_id, version: 1, store, worker: 'w', decideTurn: async () => { throw new Error('BOOM') }, enqueueAt, now: new Date(clock).toISOString() }).then(() => null, (e) => e)
  assert.equal(e2.message, 'BOOM')
  assert.equal(store.turns.get(other.turn_id).state, 'claimed')
})

// ── the notice job itself, through the REAL handler (no turn store / decider touched) ──
import { budgetExhaustedTurnWorkItem } from '../../src/lib/ai/conversation-turn-handler.js'

test('RUN-13 (handler): a budget-notice job raises ONE work item (reason budget_exhausted) under its own lease and never claims, decides or spends; a refused write throws', async () => {
  const turn_id = '6d6458f3-fdcc-4bac-a70a-c82172bc93bd'
  const writes = []
  const untouchable = new Proxy({}, { get: (_t, k) => { if (k === 'then') return undefined; throw new Error(`TURN_STORE_TOUCHED ${String(k)}`) } })
  const mk = (ok) => createConversationTurnHandler({ env: {}, store: untouchable, decide: async () => { throw new Error('DECIDE_MUST_NOT_RUN') }, dispatch: null, runtimeStore: {}, supabase: {},
    operatorItems: { syncWorkItems: async (a) => { writes.push(a); return ok ? { ok: true, inserted: 1 } : { ok: false, reason: 'lease_lost' } } } })
  const ctx = { job: { job_id: 'job-notice-1', input: turnBudgetNoticeInput({ turn_id, version: 2, budget_blocks: 1, state: 'rescheduled' }) }, lease: { job_id: 'job-notice-1', token: 'tok-1' }, step: async () => {}, yield: () => { throw new Error('NO_YIELD') } }
  const out = await mk(true).run(ctx)
  assert.equal(out.result.code, 'TURN_BUDGET_NOTICE_RAISED')
  assert.equal(writes.length, 1)
  assert.deepEqual([writes[0].job_id, writes[0].token, writes[0].close_missing], ['job-notice-1', 'tok-1', false])
  assert.deepEqual(writes[0].items, [budgetExhaustedTurnWorkItem({ turn_id, version: 2, budget_blocks: 1, state: 'rescheduled' })])
  assert.equal(writes[0].items[0].detail.reason, 'budget_exhausted')
  await assert.rejects(mk(false).run(ctx), (e) => e.code === 'OPERATOR_ITEM_REFUSED')
})
