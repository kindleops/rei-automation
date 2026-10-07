#!/usr/bin/env node
/**
 * Campaign audience re-projection backfill — operator CLI (owner runs it, off-peak).
 * Needs PROPOSED_20261007180000_ctg_person_property_reprojection.sql applied.
 * Loop + safety rules: src/lib/domain/campaigns/campaign-graph-reprojection.js.
 *
 *   cd apps/api
 *   SUPABASE_DB_URL=... node scripts/ops/campaign-graph-reproject-backfill.mjs plan [--sets=person,property,scores]
 *   SUPABASE_DB_URL=... CTG_REPROJECT_ENABLED=true node scripts/ops/campaign-graph-reproject-backfill.mjs run --confirm \
 *       [--sets=person,property,scores] [--market=Minneapolis] [--batch=400] [--pause-ms=1500] \
 *       [--max-minutes=120] [--fresh] [--cursor=/tmp/ctg-reproject.cursor.json]
 *   node scripts/ops/campaign-graph-reproject-backfill.mjs status [--cursor=...]
 *
 * Per batch: one short transaction (statement_timeout 30s, lock_timeout 2s), the
 * projection advisory lock (skips while reconcile/incremental hold it), load shedding,
 * cursor saved after every batch. Refuses to run 09:15–11:59Z. Ctrl-C is safe: rerun
 * `run` (without --fresh) to resume.
 */
import fs from 'node:fs'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./tests/alias-loader.mjs', pathToFileURL('./'))

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (hit) return hit.split('=').slice(1).join('=')
  return process.argv.includes(`--${name}`) ? true : fallback
}
const command = process.argv[2]
const cursorPath = String(arg('cursor', '/tmp/ctg-reproject.cursor.json'))

const R = await import('../../src/lib/domain/campaigns/campaign-graph-reprojection.js')

const readCursor = () => {
  try { return JSON.parse(fs.readFileSync(cursorPath, 'utf8')) } catch { return null }
}

async function pgClient() {
  const pg = (await import('pg')).default
  const url = String(process.env.SUPABASE_DB_URL || '').trim()
  if (!url) throw new Error('SUPABASE_DB_URL is required')
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, application_name: 'ctg-reproject-backfill' })
  await client.connect()
  await client.query("SET statement_timeout = '30s'")
  await client.query("SET lock_timeout = '2s'")
  return client
}

if (command === 'status') {
  console.log(JSON.stringify({ cursor_file: cursorPath, state: readCursor() }, null, 2))
  process.exit(0)
}

const sets = R.normalizeReprojectionSets(arg('sets', R.DEFAULT_REPROJECTION_SETS.join(',')))
const client = await pgClient()
try {
  if (command === 'plan') {
    const { rows: [est] } = await client.query(
      "SELECT reltuples::bigint AS rows FROM pg_class WHERE oid = 'public.campaign_target_graph'::regclass")
    const { rows: fn } = await client.query(
      "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'campaign_target_graph_reproject_batch'")
    const batch = Number(arg('batch', 400))
    const pause = Number(arg('pause-ms', 1500))
    console.log(JSON.stringify({
      sets,
      graph_rows_estimate: Number(est.rows),
      migration_applied: fn[0].n > 0,
      eta: R.estimateReprojectionMinutes({ rows: Number(est.rows), batchSize: batch, pauseMs: pause }),
      saved_cursor: readCursor(),
      blocked_now: R.inBlockedWindow(new Date()),
    }, null, 2))
  } else if (command === 'run') {
    if (String(process.env.CTG_REPROJECT_ENABLED || '').trim().toLowerCase() !== 'true') {
      throw new Error('refused: CTG_REPROJECT_ENABLED must be "true"')
    }
    if (!arg('confirm')) throw new Error('refused: run needs --confirm')
    let stopping = false
    process.on('SIGINT', () => { stopping = true; console.error('stopping after this batch…') })
    const result = await R.runGraphReprojection({
      sets,
      market: arg('market', null) || null,
      batchSize: Number(arg('batch', 400)),
      pauseMs: Number(arg('pause-ms', 1500)),
      maxMinutes: Number(arg('max-minutes', 120)),
      state: arg('fresh') ? null : readCursor(),
      saveState: async (state) => fs.writeFileSync(cursorPath, JSON.stringify(state, null, 2)),
      log: (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry })),
      call: async ({ after, limit, sets: s, market }) => {
        const { rows } = await client.query(
          'SELECT * FROM public.campaign_target_graph_reproject_batch($1, $2, $3::text[], $4)',
          [after, limit, s, market])
        return rows[0]
      },
      shouldStop: () => stopping,
    })
    console.log(JSON.stringify({ result }, null, 2))
  } else {
    throw new Error('usage: plan | run --confirm | status')
  }
} finally {
  await client.end()
}
