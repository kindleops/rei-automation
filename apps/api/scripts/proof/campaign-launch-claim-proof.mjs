#!/usr/bin/env node
// CAMPAIGN COMPOSER 2.0 — one launch per campaign, proven in Postgres.
//
// Engines (never production):
//   default        PGlite (in-process Postgres 17). Statements are serialised by
//                  the engine, so this proves the SQL SEMANTICS of every
//                  interleaving below, not lock behaviour under true parallelism.
//   real Postgres  CAMPAIGN_LAUNCH_PROOF_DB_URL=postgres://localhost/... (loopback
//                  only) — every racer gets its own pooled connection, so the
//                  same invariants run under genuine concurrency.
//
//   node --import ./tests/register-aliases.mjs scripts/proof/campaign-launch-claim-proof.mjs
//   PGLITE_MODULE=/tmp/pglite-t/node_modules/@electric-sql/pglite/dist/index.js (default)
//
// Loads: the production ledger (20260831000000, idempotency section) and
// PROPOSED_20261002190000_campaign_launch_claim.sql, plus a minimal campaigns /
// campaign_targets / send_queue model. Then drives the REAL server code path
// (launchComposedCampaign + campaign-launch-claim.js) through a supabase-shaped
// adapter over SQL, with prepare (target materialisation) and the lifecycle
// (queue fill + status) as SQL side effects counted at the end.
//
// INVARIANTS
//   1. N parallel launches, distinct launch keys          -> 1 launch, 1 materialisation, queue rows = batch
//   2. retries of the winner's key after it finished      -> idempotent, same result, no new rows
//   3. retries of a loser's key                           -> already_launched, no new rows
//   4. a launch racing a reschedule/pause on the same row -> exactly one of them wins the transition
//   5. a stale claim reclaimed after the holder hung      -> the zombie's finish is fenced; no second launch
//   6. a refused launch (blocked readiness) releases      -> a later launch can claim
//   7. ledger row purged after a launch                   -> the campaign state still refuses a second launch
//   8. fallback path (no PROPOSED function)               -> the production ledger alone still gives 1 launch
//   9. a timed-out client retries the same key mid-launch -> launch_in_progress, then the recorded result
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { launchComposedCampaign, _resetComposerFlights } from '@/lib/domain/campaigns/campaign-composer.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.resolve(here, '../../supabase/migrations')
const N = Number(process.env.RACERS || 24)
const BATCH = 100

/* ── engine ─────────────────────────────────────────────────────────────── */
async function engine() {
  const url = process.env.CAMPAIGN_LAUNCH_PROOF_DB_URL
  if (url) {
    const host = new URL(url).hostname
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) { console.error('refusing non-local DB'); process.exit(2) }
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: url, max: N + 4 })
    return { name: 'postgres (parallel connections)', query: (sql, params) => pool.query(sql, params), exec: (sql) => pool.query(sql), close: () => pool.end() }
  }
  const mod = await import(process.env.PGLITE_MODULE || '/tmp/pglite-t/node_modules/@electric-sql/pglite/dist/index.js')
  const db = new mod.PGlite()
  return { name: 'pglite (serialised engine)', query: (sql, params) => db.query(sql, params), exec: (sql) => db.exec(sql), close: () => db.close() }
}

async function schema(db, { withProposed = true } = {}) {
  await db.exec(`
    DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE public.campaigns (id uuid PRIMARY KEY, status text NOT NULL, scheduled_for timestamptz, activated_at timestamptz);
    CREATE TABLE public.campaign_targets (id bigserial PRIMARY KEY, campaign_id uuid, build_run text, n int);
    CREATE TABLE public.send_queue (id bigserial PRIMARY KEY, campaign_id uuid, target_n int, UNIQUE (campaign_id, target_n));
    CREATE TABLE public.transitions (id bigserial PRIMARY KEY, campaign_id uuid, from_status text, to_status text, actor text);
  `)
  const durable = await fs.readFile(path.join(MIG, '20260831000000_durable_run_locks_and_idempotency_ledger.sql'), 'utf8')
  const lines = durable.split('\n')
  const from = lines.findIndex((l) => l.startsWith('CREATE TABLE IF NOT EXISTS public.idempotency_ledger'))
  const to = lines.findIndex((l) => l.startsWith('-- ── idempotency_purge_expired'))
  await db.exec(lines.slice(from, to).join('\n'))
  if (withProposed) await db.exec(await fs.readFile(path.join(MIG, 'PROPOSED_20261002190000_campaign_launch_claim.sql'), 'utf8'))
}

/* ── a supabase-shaped adapter over SQL (only what the code path calls) ── */
const RPC_ARGS = {
  campaign_launch_claim: ['p_campaign_id::uuid', 'p_launch_key', 'p_claim_token::uuid', 'p_lease_ms::int'],
  campaign_launch_finish: ['p_campaign_id::uuid', 'p_claim_token::uuid', 'p_outcome', 'p_result::jsonb', 'p_error'],
  idempotency_begin: ['p_scope', 'p_key', 'p_claim_token::uuid', 'p_summary', 'p_metadata::jsonb', 'p_lease_ms::int', 'p_payload_hash'],
  idempotency_complete: ['p_scope', 'p_key', 'p_summary', 'p_metadata::jsonb', 'p_skip_content_fields::boolean'],
  idempotency_fail: ['p_scope', 'p_key', 'p_error', 'p_metadata::jsonb', 'p_skip_content_fields::boolean'],
}
function adapter(db, { functions = true } = {}) {
  return {
    async rpc(name, args) {
      const spec = RPC_ARGS[name]
      if (!spec || (!functions && name.startsWith('campaign_launch_'))) return { data: null, error: { code: '42883', message: `function public.${name} does not exist` } }
      const params = spec.map((s) => { const v = args[s.split('::')[0]]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v ?? null })
      const sql = `select public.${name}(${spec.map((s, i) => `$${i + 1}${s.includes('::') ? `::${s.split('::')[1]}` : ''}`).join(', ')}) as r`
      try { const res = await db.query(sql, params); return { data: res.rows[0].r, error: null } } catch (e) { return { data: null, error: { message: e.message, code: e.code } } }
    },
    from(table) {
      const q = { table, where: [] }
      const api = {
        select() { return api },
        eq(col, val) { q.where.push([col, val]); return api },
        async maybeSingle() {
          const res = await db.query(`select * from public.${q.table} where ${q.where.map((w, i) => `${w[0]} = $${i + 1}`).join(' and ')} limit 1`, q.where.map((w) => w[1]))
          return { data: res.rows[0] ?? null, error: null }
        },
      }
      return api
    },
  }
}

/* ── side effects of the real flow, as SQL ──────────────────────────────── */
// The lifecycle's own state machine: an edge-checked conditional UPDATE.
const EDGES = { draft: ['built', 'scheduled', 'archived'], built: ['scheduled', 'activating', 'active', 'draft', 'archived'], scheduled: ['active', 'draft', 'paused', 'archived'], active: ['paused'], paused: ['active', 'scheduled'] }
async function transition(db, id, to, actor) {
  const allowedFrom = Object.entries(EDGES).filter(([, tos]) => tos.includes(to)).map(([f]) => f)
  const res = await db.query(`update public.campaigns set status = $2 where id = $1 and status = any($3::text[]) returning status`, [id, to, allowedFrom])
  if (res.rows.length) await db.query('insert into public.transitions (campaign_id, from_status, to_status, actor) values ($1, null, $2, $3)', [id, to, actor])
  return res.rows.length === 1
}
function flowDeps(db, opts = {}) {
  return {
    supabase: adapter(db, opts),
    nowMs: Date.parse('2026-10-02T15:00:00Z'),
    loadCampaignStatus: async (_s, id) => (await db.query('select id, status, 1000 as total_cap from public.campaigns where id = $1', [id])).rows[0] ?? null,
    buildCampaignTargets: async (id) => {
      const run = crypto.randomUUID()
      await db.query(`insert into public.campaign_targets (campaign_id, build_run, n) select $1, $2, g from generate_series(1, 737) g`, [id, run])
      if (opts.hangBuildMs) await new Promise((r) => setTimeout(r, opts.hangBuildMs))
      return { ok: true, success: true, build_summary: { ready: 737 } }
    },
    evaluateCampaignLaunchReadiness: async () => (opts.blocked
      ? { launch_readiness: 'blocked', blockers: ['No sendable number'], launch_ready_recipient_count: 737 }
      : { launch_readiness: 'ready', blockers: [], warnings: [], launch_ready_recipient_count: 737 }),
    applyCampaignLifecycleAction: async (id, input) => {
      if (input.action === 'activate') {
        if (!(await transition(db, id, 'active', 'composer'))) return { ok: false, error: 'illegal_campaign_transition' }
        await db.query(`insert into public.send_queue (campaign_id, target_n) select $1, g from generate_series(1, $2::int) g on conflict do nothing`, [id, BATCH])
        return { ok: true, to: 'active', inserted: BATCH }
      }
      if (!(await transition(db, id, 'scheduled', 'composer'))) return { ok: false, error: 'illegal_campaign_transition' }
      return { ok: true, to: 'scheduled', inserted: 0 }
    },
    recordCampaignEvent: async () => {},
  }
}

/* ── assertions ─────────────────────────────────────────────────────────── */
const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }
async function counts(db, id) {
  const one = async (sql) => Number((await db.query(sql, [id])).rows[0].c)
  return {
    builds: await one('select count(distinct build_run) c from public.campaign_targets where campaign_id = $1'),
    queue: await one('select count(*) c from public.send_queue where campaign_id = $1'),
    transitions: await one(`select count(*) c from public.transitions where campaign_id = $1 and actor = 'composer'`),
  }
}
const newCampaign = async (db, status = 'built') => { const id = crypto.randomUUID(); await db.query('insert into public.campaigns (id, status) values ($1, $2)', [id, status]); return id }
const launchBody = (id, key, mode = 'now') => ({ campaign_id: id, launch_key: key, start: mode === 'now' ? { mode: 'now' } : { mode: 'at', at: '2026-10-03T14:00:00Z' }, expected_eligible: 737 })

const db = await engine()
console.log(`engine: ${db.name}; racers: ${N}`)
try {
  await schema(db)

  // 1. N parallel launches with distinct launch keys (two tabs, two servers…)
  {
    _resetComposerFlights()
    const id = await newCampaign(db)
    const deps = Array.from({ length: N }, () => flowDeps(db))
    const out = await Promise.all(deps.map((d, i) => launchComposedCampaign(launchBody(id, `k${i}`), d).catch((e) => ({ ok: false, error: e.message }))))
    const wins = out.filter((r) => r.ok && !r.idempotent)
    const c = await counts(db, id)
    check('1 N parallel launches -> exactly one launch', wins.length === 1 && c.builds === 1 && c.queue === BATCH && c.transitions === 1,
      `wins=${wins.length} builds=${c.builds} queue=${c.queue} transitions=${c.transitions} losers=${[...new Set(out.filter((r) => !r.ok).map((r) => r.error))].join(',')}`)

    // 2/3. retries after the winner finished
    const winnerKey = `k${out.findIndex((r) => r.ok && !r.idempotent)}`
    const retries = await Promise.all(Array.from({ length: 6 }, () => launchComposedCampaign(launchBody(id, winnerKey), flowDeps(db))))
    const loser = await launchComposedCampaign(launchBody(id, 'late-other-tab'), flowDeps(db))
    const c2 = await counts(db, id)
    check('2 retries of the winner key -> idempotent, same result', retries.every((r) => r.ok && r.idempotent && r.eligible === 737) && c2.queue === BATCH && c2.builds === 1, `queue=${c2.queue}`)
    check('3 another key after launch -> already_launched', loser.ok === false && loser.error === 'already_launched', loser.error)
  }

  // 4. launch racing a reschedule / pause from another path
  {
    _resetComposerFlights()
    const id = await newCampaign(db)
    const [launchRes, schedOk] = await Promise.all([
      launchComposedCampaign(launchBody(id, 'race', 'at'), flowDeps(db)),
      transition(db, id, 'scheduled', 'other-operator'),
    ])
    const c = await counts(db, id)
    const otherWon = schedOk === true
    const composerWon = launchRes.ok === true
    check('4 launch vs reschedule -> exactly one transition wins', (otherWon !== composerWon) || (otherWon && !composerWon),
      `other=${otherWon} composer=${composerWon}/${launchRes.error ?? 'ok'} composer_transitions=${c.transitions}`)
    const pauseOk = await transition(db, id, 'paused', 'other-operator')
    const after = await launchComposedCampaign(launchBody(id, 'after-pause'), flowDeps(db))
    check('4b paused/scheduled campaign is not launchable again', after.ok === false && ['campaign_not_launchable', 'already_launched'].includes(after.error), `${after.error} (pause applied=${pauseOk})`)
  }

  // 5. stale claim: holder hangs past its lease, a reclaimer runs, the zombie is fenced
  {
    _resetComposerFlights()
    const id = await newCampaign(db)
    const token = crypto.randomUUID()
    const sb = adapter(db)
    const first = await sb.rpc('campaign_launch_claim', { p_campaign_id: id, p_launch_key: 'zombie', p_claim_token: token, p_lease_ms: 1 })
    await new Promise((r) => setTimeout(r, 20))
    // a reclaimer with a 1 ms lease view treats the zombie's claim as stale
    const reclaim = await sb.rpc('campaign_launch_claim', { p_campaign_id: id, p_launch_key: 'rescuer', p_claim_token: crypto.randomUUID(), p_lease_ms: 1 })
    const zombieFinish = await sb.rpc('campaign_launch_finish', { p_campaign_id: id, p_claim_token: token, p_outcome: 'completed', p_result: { zombie: true }, p_error: null })
    check('5 stale claim reclaimed; the zombie finish is fenced', first.data.claimed === true && reclaim.data.claimed === true && zombieFinish.data.fenced === true,
      `first=${first.data.reason} reclaim=${reclaim.data.reason} zombie_fenced=${zombieFinish.data.fenced}`)
    // the rescuer launches; once the campaign has moved on, nobody else can
    await transition(db, id, 'active', 'composer')
    const third = await sb.rpc('campaign_launch_claim', { p_campaign_id: id, p_launch_key: 'third', p_claim_token: crypto.randomUUID(), p_lease_ms: 1 })
    check('5b after the transition, even a stale-lease claimant is refused', third.data.claimed === false && third.data.reason === 'campaign_not_launchable', third.data.reason)
  }

  // 6. refused launch releases the claim
  {
    _resetComposerFlights()
    const id = await newCampaign(db)
    const refused = await launchComposedCampaign(launchBody(id, 'r1'), flowDeps(db, { blocked: true }))
    const ok = await launchComposedCampaign(launchBody(id, 'r2'), flowDeps(db))
    const c = await counts(db, id)
    check('6 a refused launch releases; the next one launches once', refused.error === 'launch_blocked' && ok.ok === true && c.queue === BATCH && c.transitions === 1, `refused=${refused.error} next=${ok.ok}`)
  }

  // 7. ledger row purged (30-day retention) after the launch
  {
    _resetComposerFlights()
    const id = await newCampaign(db)
    await launchComposedCampaign(launchBody(id, 'p1'), flowDeps(db))
    await db.query(`delete from public.idempotency_ledger where scope = 'campaign_launch' and key = $1`, [id])
    const again = await launchComposedCampaign(launchBody(id, 'p2'), flowDeps(db))
    const c = await counts(db, id)
    check('7 ledger purged -> campaign state still refuses', again.ok === false && again.error === 'campaign_not_launchable' && c.queue === BATCH, again.error)
  }

  // 9. a client timed out and retries the SAME key while the first is still running
  {
    _resetComposerFlights()
    const id = await newCampaign(db)
    const slow = launchComposedCampaign(launchBody(id, 'same'), flowDeps(db, { hangBuildMs: 150 }))
    await new Promise((r) => setTimeout(r, 30))
    _resetComposerFlights() // the retry lands on another server process: no shared memory
    const during = await launchComposedCampaign(launchBody(id, 'same'), flowDeps(db))
    const first = await slow
    const after = await launchComposedCampaign(launchBody(id, 'same'), flowDeps(db))
    const c = await counts(db, id)
    check('9 timeout retry of the same key -> in progress, then the recorded result', first.ok && during.error === 'launch_in_progress' && after.ok && after.idempotent && c.queue === BATCH && c.builds === 1,
      `during=${during.error ?? 'ok'} after=${after.idempotent ? 'idempotent' : after.error} queue=${c.queue} builds=${c.builds}`)
  }

  // 8. production today: no PROPOSED functions, ledger only
  {
    await schema(db, { withProposed: false })
    _resetComposerFlights()
    const id = await newCampaign(db)
    const out = await Promise.all(Array.from({ length: N }, (_, i) => launchComposedCampaign(launchBody(id, `f${i}`), flowDeps(db, { functions: false }))))
    const c = await counts(db, id)
    const wins = out.filter((r) => r.ok && !r.idempotent)
    check('8 fallback (production ledger only) -> exactly one launch', wins.length === 1 && c.builds === 1 && c.queue === BATCH && c.transitions === 1,
      `wins=${wins.length} builds=${c.builds} queue=${c.queue} losers=${[...new Set(out.filter((r) => !r.ok).map((r) => r.error))].join(',')}`)
  }
} finally {
  await db.close()
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} invariants hold on ${db.name}`)
process.exit(failed.length ? 1 : 0)
