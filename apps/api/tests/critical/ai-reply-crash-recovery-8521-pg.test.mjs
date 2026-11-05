// rc-8.5.21 (independent evaluation, crash recovery) — an AI reply is NEVER lost or stranded silently by a
// worker crash. On a DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous —
// without it) carrying the AI turn runtime, the hold registry, the follow-up lifecycle and the REAL §11
// ledger (competing-sources-pg.mjs). Every crash is a REAL SIGKILL of a child process running the real code
// path. After each crash the system either completes EXACTLY ONCE (one provider acceptance, simulated) or
// ends in a VISIBLE held state (manual review), never zero-with-no-trace and never twice:
//   1. after the provenance record, before the queue insert ⇒ the retried job finishes the enqueue ⇒ sent once
//   2. after the queue insert, before the turn records the outcome (before any claim) ⇒ the recovery never
//      enqueues a second row; the turn ends dispatched; the runner claims the ONE row ⇒ sent once
//   3a. after the claim, before the §11 seam ⇒ the lease reaper re-dispatches once ⇒ sent once
//   3b. inside the provider call (ambiguous) ⇒ held for manual review (visible), zero second sends
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import { pgAvailable, skipReason, API_DIR } from '../pg/agent-pg-harness.mjs'
import { combinedDb, registryHoldResolver } from '../helpers/competing-sources-pg.mjs'
import { seed, harness, SELLER, OURS } from '../helpers/conversation-e2e-pg.mjs'
import { seedWorld, claimRow, itemDeps, simProvider, trapTransport, sel } from '../helpers/followup-lifecycle-pg.mjs'
import { createSellerCommunicationStore } from '../../src/lib/domain/communications/seller-communication-store.js'
import { lookupAiGeneratedMessageByQueueKey, recordAiRowProviderOutcome } from '../../src/lib/domain/messages/ai-generated-message.js'
import { loadNewerInboundsForRow } from '../../src/lib/domain/queue/ai-conversation-row-gate.js'
import { processSendQueueItem } from '../../src/lib/domain/queue/process-send-queue.js'
import { normalizeSendQueueRow, reconcileCanonicalQueueLifecycle } from '../../src/lib/supabase/sms-engine.js'
import { LEASE_MANUAL_REVIEW_REASON } from '../../src/lib/domain/queue/processing-lease-recovery.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { __setSenderContinuityResolverForTests } from '../../src/lib/domain/delivery/sender-continuity.js'

__setSenderContinuityResolverForTests(null)
const skip = pgAvailable() ? false : skipReason

async function world() {
  const env = await combinedDb()
  __setAutomationHoldResolverForTests(registryHoldResolver(env.sb))
  const ids = await seed(env.pool)
  await seedWorld(env.pool)
  return { env, ids, h: harness(env) }
}
const aiRows = (env) => sel(env.pool, `select * from public.send_queue where message_origin = 'ai_generated'`)
const turnOf = async (env) => (await sel(env.pool, `select dispatch_state, dispatch_attempts, result->>'send_status' s from public.conversation_reply_turns`))[0]
const attemptsOf = (env, id) => sel(env.pool, 'select * from public.seller_communication_attempts where queue_row_id = $1', [String(id)])
function child(env, args) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', '--import', './tests/register-aliases.mjs', 'tests/helpers/ai-reply-crash-child.mjs', ...args],
    { cwd: API_DIR, env: process.env, encoding: 'utf8', timeout: 120_000 })
  assert.equal(r.signal, 'SIGKILL', `child: ${r.status} ${r.stdout} ${String(r.stderr).slice(-1500)}`)
  return r.stdout
}
const expireTurnLeases = async (env) => {
  await env.pool.query(`update agent.research_job set lease_until = clock_timestamp() - interval '1 second' where state in ('claimed','running')`)
  await env.pool.query(`update public.conversation_reply_turns set dispatch_lease_until = clock_timestamp() - interval '1 second', lease_until = least(lease_until, clock_timestamp() - interval '1 second')`)
}
const expireRowLease = (env, id) => env.pool.query(`update public.send_queue set locked_at = now() - interval '11 minutes', metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('processing_timeout_at', (now() - interval '1 minute')::text) where id = $1`, [id])
function aiDeps(env, h, provider) {
  return {
    ...itemDeps(env, { provider, now: new Date().toISOString(), store: createSellerCommunicationStore({ supabase: env.sb }) }),
    readAiConversationSwitch: h.readSwitch,
    loadAiGeneratedMessage: (k) => lookupAiGeneratedMessageByQueueKey(env.sb, k),
    loadNewerInbounds: (r) => loadNewerInboundsForRow(env.sb, r),
    recordAiRowProviderOutcome: (sb, r, o) => recordAiRowProviderOutcome(env.sb, r, o),
  }
}
async function runnerSends(env, h, provider) {
  for (const row of await aiRows(env)) {
    const c = await claimRow(env.pool, row.id)
    if (c) await processSendQueueItem(normalizeSendQueueRow({ ...c.row }), { ...aiDeps(env, h, provider), claimedLockToken: c.token })
  }
}
async function assertSentOnce(env, provider, label) {
  assert.equal(provider.accepted(), 1, `${label}: exactly one provider acceptance (${provider.sent.length} calls)`)
  assert.ok(JSON.stringify(provider.sent[0]).includes(OURS.slice(-10)) && JSON.stringify(provider.sent[0]).includes(SELLER.slice(-10)))
  const rows = await aiRows(env)
  assert.equal(rows.length, 1, `${label}: one AI row`)
  assert.ok(['sent', 'delivered'].includes(rows[0].queue_status), `${label}: the row is sent: ${rows[0].queue_status}`)
  assert.equal(await claimRow(env.pool, rows[0].id), null, `${label}: never claimable again`)
}

test('PG crash 1 (REAL SIGKILL): after the provenance record, before the queue insert ⇒ the retried job finishes the enqueue; the runner sends it ONCE', { skip }, async () => {
  const { env, h } = await world()
  const net = trapTransport()
  try {
    await h.route()
    await h.makeDue()
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', '--import', './tests/register-aliases.mjs', 'tests/helpers/r3-sigkill-child.mjs', env.db.url, env.db.apiUrl], { cwd: API_DIR, env: process.env, encoding: 'utf8', timeout: 120_000 })
    assert.equal(r.signal, 'SIGKILL', String(r.stderr).slice(-800))
    assert.equal((await aiRows(env)).length, 0, 'no row yet')
    assert.equal((await sel(env.pool, 'select count(*)::int n from public.ai_generated_messages'))[0].n, 1, 'the record is durable')
    await expireTurnLeases(env)
    await h.tick()
    await h.makeDue()
    assert.equal((await h.tick()).jobs?.[0]?.outcome, 'completed')
    assert.equal((await turnOf(env)).dispatch_state, 'dispatched')
    const provider = simProvider()
    await runnerSends(env, h, provider)
    await assertSentOnce(env, provider, 'crash1')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG crash 2 (REAL SIGKILL): after the queue insert, before the turn records the outcome (and before any claim) ⇒ no second row, the turn ends dispatched, the ONE row is sent ONCE', { skip }, async () => {
  const { env, h } = await world()
  const net = trapTransport()
  try {
    await h.route()
    await h.makeDue()
    assert.match(child(env, ['after_queue_insert', env.db.url, env.db.apiUrl]), /KILL_AFTER_QUEUE_INSERT/)
    assert.equal((await aiRows(env)).length, 1, 'the row was committed before the kill')
    const t0 = await turnOf(env)
    assert.notEqual(t0.dispatch_state, 'dispatched', 'a killed dispatch is never recorded as dispatched')
    await expireTurnLeases(env)
    await h.tick()
    await h.makeDue()
    await h.tick()
    assert.equal((await aiRows(env)).length, 1, 'the recovery never enqueues a second row (send_queue backstop / existing record + row)')
    const t1 = await turnOf(env)
    assert.equal(t1.dispatch_state, 'dispatched', `the turn is not stranded: ${JSON.stringify(t1)}`)
    const provider = simProvider()
    await runnerSends(env, h, provider)
    await assertSentOnce(env, provider, 'crash2')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG crash 3a (REAL SIGKILL): after the runner\'s claim, before the §11 seam ⇒ the lease reaper re-dispatches EXACTLY ONCE ⇒ sent ONCE', { skip }, async () => {
  const { env, h } = await world()
  const net = trapTransport()
  try {
    await h.route(); await h.makeDue(); await h.tick()
    const [row] = await aiRows(env)
    const claimed = await claimRow(env.pool, row.id)
    assert.match(child(env, ['before_seam', env.db.url, env.db.apiUrl, row.id, claimed.token]), /KILL_BEFORE_SEAM/)
    assert.equal((await sel(env.pool, 'select queue_status from public.send_queue where id = $1', [row.id]))[0].queue_status, 'processing', 'the dead runner left it claimed')
    assert.equal((await attemptsOf(env, row.id)).length, 0, 'no §11 attempt: provably unsent')
    await expireRowLease(env, row.id)
    const rec = await reconcileCanonicalQueueLifecycle({ supabase: env.sb, queue_emergency_stop_at: '', queue_processor_mode: 'live', caller_route: 'test' })
    assert.equal(rec.ok, true)
    assert.equal((await sel(env.pool, 'select queue_status from public.send_queue where id = $1', [row.id]))[0].queue_status, 'queued', 'recovered, never stranded')
    const provider = simProvider()
    await runnerSends(env, h, provider)
    await assertSentOnce(env, provider, 'crash3a')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG crash 3b (REAL SIGKILL): inside the provider call (ambiguous) ⇒ HELD for manual review, visible; zero second sends', { skip }, async () => {
  const { env, h } = await world()
  const net = trapTransport()
  try {
    await h.route(); await h.makeDue(); await h.tick()
    const [row] = await aiRows(env)
    const claimed = await claimRow(env.pool, row.id)
    assert.match(child(env, ['in_provider', env.db.url, env.db.apiUrl, row.id, claimed.token]), /KILL_IN_PROVIDER/)
    const attempts = await attemptsOf(env, row.id)
    assert.equal(attempts.length, 1)
    assert.ok(attempts[0].provider_request_started_at, 'the marker was committed before the network call')
    await expireRowLease(env, row.id)
    await reconcileCanonicalQueueLifecycle({ supabase: env.sb, queue_emergency_stop_at: '', queue_processor_mode: 'live', caller_route: 'test' })
    const after = (await sel(env.pool, 'select queue_status, failed_reason from public.send_queue where id = $1', [row.id]))[0]
    assert.deepEqual([after.queue_status, after.failed_reason], ['expired', LEASE_MANUAL_REVIEW_REASON], 'held visibly for a person (never re-sent)')
    const provider = simProvider()
    await runnerSends(env, h, provider)
    assert.equal(provider.sent.length, 0, 'zero second sends')
    assert.equal(await claimRow(env.pool, row.id), null)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})
