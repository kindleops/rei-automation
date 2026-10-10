#!/usr/bin/env node
/**
 * Entity Graph · eg_property_facts FULL BACKFILL (operator, local → prod).
 *
 * Writes every property's facts row with the SAME code the API refresh job
 * uses (entity-graph-facts.js computeFacts + entity-graph-facts-refresh.js
 * factsBaseColumns / factRecords / factsUpsertSql), so it needs no deploy:
 * run it from an rc-8.5.5 checkout against prod after the migration is applied.
 *
 * Run from apps/api (the alias loader resolves "@/" against the cwd):
 *   cd apps/api
 *   node ../../scripts/entity-graph/backfill-eg-property-facts.mjs --dry-run --batch 500 --max-batches 1
 *   node ../../scripts/entity-graph/backfill-eg-property-facts.mjs                 # full run (resumes automatically)
 *
 * DATABASE_URL: env, else /tmp/.dburl. Never printed. Output carries counts,
 * timings and property_id cursors only — no names, phones or addresses.
 *
 * Safety:
 *   - ONE connection, statements strictly serial (application_name eg_facts_backfill).
 *   - ≤ 2,000 properties per batch; each batch is ONE transaction with
 *     SET LOCAL statement_timeout (default 30 s) — a batch either lands whole or not at all.
 *   - Sleeps between batches (default 1.5 s).
 *   - Load gate BEFORE EVERY BATCH (pg_stat_activity): stops when active client
 *     backends > --max-active (default 15), any query has run > --long-secs
 *     (default 60 s, ours excluded), or > --max-lock-waits sessions wait on a lock (default 3).
 *     A stop is resumable: rerun the same command.
 *   - Hard deadline --stop-at HH:MM UTC (default 11:00): no batch starts after it.
 *   - A batch slower than --max-batch-ms (default 90 s) stops the run (resumable).
 *   - Holds the refresh job's advisory lock, so the API refresh cannot run concurrently.
 *   - Resumable: cursor + run timestamp in --state (default /tmp/eg-facts-backfill.state.json).
 *     All rows of one run share refreshed_at = the run timestamp; the API only
 *     reads the table once this script writes the eg_refresh_log 'ok' row at the
 *     very end (after the row count equals the property universe).
 *   - After the ok row: VACUUM (ANALYZE) eg_property_facts (planner stats + visibility map for index-only counts).
 *   - --dry-run: read-only session, no lock, no writes, needs no migration;
 *     prints per-batch and per-input timings to size the window.
 */
import fs from 'node:fs'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./tests/alias-loader.mjs', pathToFileURL('./'))

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}
const OPT = {
  dryRun: process.argv.includes('--dry-run'),
  batch: Math.min(2000, Math.max(1, Number(arg('batch', 2000)))),
  sleepMs: Number(arg('sleep-ms', 1500)),
  stmtTimeoutMs: Number(arg('stmt-timeout-ms', 30_000)),
  maxActive: Number(arg('max-active', 15)),
  longSecs: Number(arg('long-secs', 60)),
  maxLockWaits: Number(arg('max-lock-waits', 3)),
  maxBatchMs: Number(arg('max-batch-ms', 90_000)),
  maxBatches: Number(arg('max-batches', Infinity)),
  stopAt: String(arg('stop-at', '11:00')),
  state: String(arg('state', '/tmp/eg-facts-backfill.state.json')),
  maxStateAgeH: Number(arg('max-state-age-h', 12)),
}
if (!process.cwd().endsWith('/apps/api')) { console.error('run from apps/api (the alias loader resolves "@/" against the cwd)'); process.exit(2) }

const pg = (await import('pg')).default
const { computeFacts, COMPUTED_FACTS } = await import('@/lib/domain/entity-graph/entity-graph-facts.js')
const { factsTableColumns, FACTS_TABLE_NAME } = await import('@/lib/domain/entity-graph/entity-graph-facts-ddl.js')
const { FACTS_REFRESH_LOCK_KEY, factsBaseColumns, factRecords, factsUpsertSql } = await import('@/lib/domain/entity-graph/entity-graph-facts-refresh.js')

const url = process.env.DATABASE_URL || fs.readFileSync('/tmp/.dburl', 'utf8').trim()
const client = new pg.Client({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false }, application_name: 'eg_facts_backfill' })
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (c) => `"${c}"`

const deadline = (() => {
  const [h, m] = OPT.stopAt.split(':').map(Number)
  const d = new Date()
  d.setUTCHours(h, m || 0, 0, 0)
  if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1) // the next occurrence
  return d
})()

const LOAD_SQL = `
  select count(*) filter (where state = 'active')::int as active,
         count(*) filter (where state = 'active' and now() - query_start > make_interval(secs => $1))::int as long_running,
         count(*) filter (where wait_event_type = 'Lock')::int as lock_waits,
         coalesce(max(extract(epoch from now() - query_start)) filter (where state = 'active'), 0)::int as longest_secs
    from pg_stat_activity
   where backend_type = 'client backend' and pid <> pg_backend_pid()
     and coalesce(application_name, '') <> 'eg_facts_backfill'`

async function loadGate() {
  const r = (await client.query(LOAD_SQL, [OPT.longSecs])).rows[0]
  const reasons = []
  if (r.active > OPT.maxActive) reasons.push(`active ${r.active} > ${OPT.maxActive}`)
  if (r.long_running > 0) reasons.push(`${r.long_running} queries running > ${OPT.longSecs}s (longest ${r.longest_secs}s)`)
  if (r.lock_waits > OPT.maxLockWaits) reasons.push(`lock waits ${r.lock_waits} > ${OPT.maxLockWaits}`)
  return { ...r, ok: reasons.length === 0, reasons }
}

const readState = () => { try { return JSON.parse(fs.readFileSync(OPT.state, 'utf8')) } catch { return null } }
const writeState = (s) => fs.writeFileSync(OPT.state, JSON.stringify(s, null, 2))

let exitCode = 0
let locked = false
try {
  await client.connect()
  await client.query(`set statement_timeout = ${Math.trunc(OPT.stmtTimeoutMs)}`)
  await client.query(`set lock_timeout = '5s'`)
  if (OPT.dryRun) await client.query('set default_transaction_read_only = on')

  const columns = factsTableColumns()
  const baseCols = factsBaseColumns(columns)
  const allComputed = COMPUTED_FACTS.map((f) => f.col)
  const upsert = factsUpsertSql(columns)
  const universe = Number((await client.query('select count(*)::int as n from public.v_entity_graph_properties')).rows[0].n)

  let state
  if (OPT.dryRun) {
    state = { runAt: new Date().toISOString(), afterId: String(arg('after', '')), rows: 0, batches: 0, logId: null }
  } else {
    const present = (await client.query(`select to_regclass('public.${FACTS_TABLE_NAME}') is not null as t, to_regclass('public.eg_refresh_log') is not null as l`)).rows[0]
    if (!present.t || !present.l) throw new Error('read model not applied — apply PROPOSED_20261009180000_eg_property_facts.sql first')
    locked = (await client.query('select pg_try_advisory_lock($1) as ok', [FACTS_REFRESH_LOCK_KEY])).rows[0].ok
    if (!locked) throw new Error('another refresh holds the eg_property_facts lock')
    state = readState()
    if (state && (Date.now() - Date.parse(state.runAt)) / 3.6e6 > OPT.maxStateAgeH) {
      throw new Error(`state ${OPT.state} is from ${state.runAt} (> ${OPT.maxStateAgeH} h): facts would be computed "as of" a stale now. Move the state file aside to start a fresh run.`)
    }
    if (!state) {
      const runAt = new Date().toISOString()
      const ins = await client.query(
        `insert into public.eg_refresh_log (name, mode, status, started_at, detail) values ($1, 'full', 'running', $2, $3::jsonb) returning id`,
        [FACTS_TABLE_NAME, runAt, JSON.stringify({ source: 'scripts/entity-graph/backfill-eg-property-facts.mjs', batch: OPT.batch })],
      )
      state = { runAt, afterId: '', rows: 0, batches: 0, logId: Number(ins.rows[0].id) }
      writeState(state)
      log({ phase: 'start', universe, runAt, logId: state.logId, batch: OPT.batch, deadline: deadline.toISOString() })
    } else {
      log({ phase: 'resume', universe, runAt: state.runAt, logId: state.logId, afterId: state.afterId, rows: state.rows })
    }
  }
  const runAt = new Date(state.runAt)
  const timings = new Map()
  const query = async (sql, params) => {
    const t = Date.now()
    const r = await client.query({ text: sql, values: params })
    const key = sql.replace(/\s+/g, ' ').trim().slice(0, 60)
    timings.set(key, (timings.get(key) || 0) + (Date.now() - t))
    return r
  }

  let done = false
  for (let n = 0; n < OPT.maxBatches; n++) {
    if (Date.now() >= deadline.getTime()) { log({ phase: 'stop', reason: `deadline ${deadline.toISOString()}`, afterId: state.afterId, rows: state.rows }); exitCode = 3; break }
    const gate = await loadGate()
    if (!gate.ok) { log({ phase: 'stop', reason: 'prod load high', ...gate, afterId: state.afterId, rows: state.rows }); exitCode = 4; break }

    const t0 = Date.now()
    timings.clear()
    await client.query('begin')
    let wrote = 0
    let lastId = state.afterId
    let fetched = 0
    try {
      await client.query(`set local statement_timeout = ${Math.trunc(OPT.stmtTimeoutMs)}`)
      const base = await query(`select ${baseCols.map(q).join(', ')} from public.v_entity_graph_properties where "property_id" > $1 order by "property_id" limit ${OPT.batch}`, [state.afterId])
      fetched = base.rows.length
      if (fetched) {
        const facts = await computeFacts(base.rows, allComputed, { query, timeoutMs: OPT.stmtTimeoutMs, now: runAt, keyedMax: OPT.batch, chunk: OPT.batch })
        const records = factRecords(base.rows, facts, runAt, columns)
        lastId = String(base.rows[base.rows.length - 1].property_id)
        if (!OPT.dryRun) {
          await client.query(upsert, [JSON.stringify(records)])
          await client.query(`update public.eg_refresh_log set rows = $2, detail = detail || $3::jsonb where id = $1`, [state.logId, state.rows + records.length, JSON.stringify({ afterId: lastId, batches: state.batches + 1 })])
        }
        wrote = records.length
      }
      await client.query(OPT.dryRun ? 'rollback' : 'commit')
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    }
    const ms = Date.now() - t0
    state = { ...state, afterId: lastId, rows: state.rows + wrote, batches: state.batches + 1 }
    if (!OPT.dryRun) writeState(state)
    const perBatch = ms
    const left = Math.max(0, universe - state.rows)
    log({
      phase: OPT.dryRun ? 'dry_batch' : 'batch', n: state.batches, rows: state.rows, universe, pct: Math.round((state.rows / Math.max(1, universe)) * 1000) / 10,
      ms, afterId: state.afterId, active: gate.active, etaMin: Math.round(((left / OPT.batch) * (perBatch + OPT.sleepMs)) / 60000),
      ...(OPT.dryRun ? { slowest: [...timings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6) } : {}),
    })
    if (fetched < OPT.batch) { done = true; break }
    if (ms > OPT.maxBatchMs) { log({ phase: 'stop', reason: `batch took ${ms} ms > ${OPT.maxBatchMs}`, afterId: state.afterId }); exitCode = 5; break }
    await sleep(OPT.sleepMs)
  }

  if (done && !OPT.dryRun) {
    // a property gone from the source since an earlier run; then the universe check; then (only then) the ok row
    await client.query('begin')
    try {
      await client.query(`set local statement_timeout = '60s'`)
      const del = await client.query(`delete from public.${FACTS_TABLE_NAME} where refreshed_at < $1`, [runAt])
      const counts = (await client.query(`select (select count(*)::int from public.${FACTS_TABLE_NAME}) as facts, (select count(*)::int from public.v_entity_graph_properties) as universe, (select count(*)::int from public.${FACTS_TABLE_NAME} where refreshed_at <> $1) as other_run`, [runAt])).rows[0]
      if (counts.facts !== counts.universe || counts.other_run !== 0) {
        throw new Error(`universe check failed: facts ${counts.facts} vs universe ${counts.universe}, rows from another run ${counts.other_run} — NOT marking ok (rerun to top up: move the state file aside)`)
      }
      await client.query(`update public.eg_refresh_log set status = 'ok', finished_at = now(), rows = $2, detail = detail || $3::jsonb where id = $1`, [state.logId, counts.facts, JSON.stringify({ deleted: del.rowCount, ms_wall: Date.now() - Date.parse(state.runAt) })])
      await client.query('commit')
      log({ phase: 'done', facts: counts.facts, universe: counts.universe, deleted: del.rowCount, logId: state.logId })
      fs.renameSync(OPT.state, `${OPT.state}.done-${Date.now()}`)
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    }
    // planner statistics + visibility map: the page's exact count(*) and the keyset reads become index-only scans
    const tv = Date.now()
    await client.query(`set statement_timeout = '180s'`)
    await client.query(`vacuum (analyze) public.${FACTS_TABLE_NAME}`)
    log({ phase: 'vacuum_analyze', ms: Date.now() - tv })
  } else if (done) {
    log({ phase: 'dry_done', rows: state.rows, universe })
  }
} catch (error) {
  log({ phase: 'error', message: String(error?.message || error).slice(0, 400) })
  exitCode = exitCode || 1
} finally {
  if (locked) await client.query('select pg_advisory_unlock($1)', [FACTS_REFRESH_LOCK_KEY]).catch(() => {})
  await client.end().catch(() => {})
}
process.exit(exitCode)
