#!/usr/bin/env node
// Multi-PROCESS concurrency proof for the agent S3 Postgres store.
//
// Runs against a REAL, DISPOSABLE Postgres with the S3 schema applied (never
// production — loopback hosts only, fail-closed, same guard as
// durable-state-concurrency-proof.mjs):
//   AGENT_S3_PROOF_DB_URL=postgres://… node scripts/proof/agent-s3-pg-concurrency-proof.mjs
//   AGENT_S3_PROOF_PARALLEL=24 (default 12) AGENT_S3_PROOF_APPENDS=20 (default)
//
// N OS processes, each with its own pg pool + its own store instance, append
// events to ONE shared run and to their own run, concurrently. Invariants:
//   1 the global cursor (event_id) is gapless 1..total and unique
//   2 every run's seq is gapless 1..n
//   3 the shared run holds exactly 1 + N×K events (no lost / duplicated append)
//   4 store_head.event_id == max(event_id); generation == number of commits
//   5 a fresh store opened afterwards replays the shared run identically to the DB
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const URL_ = String(process.env.AGENT_S3_PROOF_DB_URL || '').trim()
if (!URL_) { console.error('AGENT_S3_PROOF_DB_URL is required (a disposable local Postgres with the S3 schema applied).'); process.exit(2) }
const host = new URL(URL_).hostname
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) { console.error(`host "${host}" is not a local scratch database. Refusing.`); process.exit(2) }

const here = fileURLToPath(import.meta.url)
const N = Math.max(2, Number(process.env.AGENT_S3_PROOF_PARALLEL || 12))
const K = Math.max(1, Number(process.env.AGENT_S3_PROOF_APPENDS || 20))

async function child(sharedRunId, index) {
  const { createPgAgentStore } = await import('../../src/lib/agent/runtime/pg-store.js')
  const { createRunService } = await import('../../src/lib/agent/runtime/run-service.js')
  const { appendEventTx } = await import('../../src/lib/agent/runtime/event-log.js')
  const pool = new pg.Pool({ connectionString: URL_, max: 2 })
  const store = createPgAgentStore({ pool })
  await store.open()
  const own = await createRunService({ store }).createRun({ kind: 'research', depth: 'quick', operator_id: `proc${index}`, property_count: 1 })
  for (let k = 0; k < K; k += 1) {
    await store.transaction((tx) => {
      appendEventTx(tx, { run_id: sharedRunId, type: 'decision', payload: { summary: `p${index}-${k}`, criterion: 'proof' } })
      appendEventTx(tx, { run_id: own.id, type: 'decision', payload: { summary: `own-${k}`, criterion: 'proof' } })
    })
  }
  await pool.end()
}

if (process.argv[2] === '--child') {
  await child(process.argv[3], Number(process.argv[4]))
  process.exit(0)
}

const { createPgAgentStore } = await import('../../src/lib/agent/runtime/pg-store.js')
const { createRunService } = await import('../../src/lib/agent/runtime/run-service.js')
const pool = new pg.Pool({ connectionString: URL_, max: 2 })
const store = createPgAgentStore({ pool })
await store.open()
const shared = await createRunService({ store }).createRun({ kind: 'task', operator_id: 'proof', title: 'shared' })
const genBefore = Number((await pool.query('select generation from agent.store_head')).rows[0].generation)
const evBefore = Number((await pool.query('select coalesce(max(event_id),0) m from agent.run_event')).rows[0].m)

const t0 = Date.now()
const codes = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve) => {
  const p = spawn(process.execPath, [here, '--child', shared.id, String(i)], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env })
  p.on('exit', (code) => resolve(code))
})))
const failures = []
const check = (ok, msg) => { if (!ok) failures.push(msg); console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`) }
check(codes.every((c) => c === 0), `${N} writer processes exited 0`)

const rows = (await pool.query('select event_id, run_id, seq from agent.run_event where event_id > $1 order by event_id', [evBefore])).rows
check(rows.every((r, i) => Number(r.event_id) === evBefore + i + 1), `1 global cursor gapless + unique over ${rows.length} new events`)
const byRun = new Map()
for (const r of (await pool.query('select run_id, seq from agent.run_event order by event_id')).rows) { if (!byRun.has(r.run_id)) byRun.set(r.run_id, []); byRun.get(r.run_id).push(r.seq) }
check([...byRun.values()].every((s) => s.every((x, i) => x === i + 1)), `2 per-run seq gapless for ${byRun.size} runs`)
check(byRun.get(shared.id).length === 1 + N * K, `3 shared run holds 1 + ${N}×${K} = ${1 + N * K} events (got ${byRun.get(shared.id).length})`)
const head = (await pool.query('select generation, event_id from agent.store_head')).rows[0]
const maxId = Number((await pool.query('select max(event_id) m from agent.run_event')).rows[0].m)
check(Number(head.event_id) === maxId, `4a store_head.event_id (${head.event_id}) == max(event_id) (${maxId})`)
check(Number(head.generation) - genBefore === N * (K + 1), `4b generation advanced by exactly ${N * (K + 1)} commits (${Number(head.generation) - genBefore})`)
const fresh = createPgAgentStore({ pool })
await fresh.open()
const replay = fresh.read().events.filter((e) => e.run_id === shared.id).map((e) => [e.event_id, e.seq])
const db = (await pool.query('select event_id, seq from agent.run_event where run_id = $1 order by event_id', [shared.id])).rows.map((r) => [Number(r.event_id), r.seq])
check(JSON.stringify(replay) === JSON.stringify(db), '5 a fresh store replays the shared run identically to the DB')
console.log(`${N} processes × ${K} commits in ${Date.now() - t0} ms`)
await pool.end()
process.exit(failures.length ? 1 : 0)
