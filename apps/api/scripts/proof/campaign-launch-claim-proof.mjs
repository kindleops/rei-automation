#!/usr/bin/env node
// CAMPAIGN COMPOSER 2.0 — one launch per campaign, proven in Postgres.
//
// Schema: scripts/proof/fixtures/campaign-launch-proof-schema.sql — the EXACT
// production definitions (tables, constraints, unique indexes, the lifecycle
// edge set, idempotency_* and campaign_transition_status, verbatim from
// pg_get_functiondef) — plus PROPOSED_20261002190000_campaign_launch_claim.sql.
// Synthetic rows only; no production data.
//
// Engines (never production):
//   default        PGlite (in-process Postgres 17): statements are serialised by
//                  the engine — proves the SQL semantics of every interleaving.
//   real Postgres  CAMPAIGN_LAUNCH_PROOF_DB_URL=postgres://… — EVERY racer gets its
//                  own dedicated connection, so claims, row locks and advisory
//                  locks contend for real. Loopback hosts are allowed; any other
//                  host must equal CAMPAIGN_LAUNCH_PROOF_ALLOW_HOST (a throwaway
//                  Supabase branch), and the production ref is always refused.
//
//   node --import ./tests/register-aliases.mjs scripts/proof/campaign-launch-claim-proof.mjs
//
// The REAL server path runs (launchComposedCampaign + campaign-launch-claim.js)
// through a supabase-shaped adapter over SQL; lifecycle transitions go through
// the production campaign_transition_status; target materialisation and queue
// fill are SQL side effects, and every ATTEMPT is recorded in proof_effects.
//
// INVARIANTS (run twice: with the PROPOSED functions, and without — the
// production ledger alone, i.e. production today)
//   1. N parallel launches, distinct keys, N connections -> 1 launch, 1 build, 1 fill, 100 queue rows, status active
//   2. retries of the winner's key                       -> idempotent, nothing re-runs
//   3. a different key after the launch                   -> already_launched
//   4. a launch racing a reschedule (separate connections) -> exactly one of them moves the campaign
//   5. a stale claim taken over                           -> one winner; the zombie's finish is fenced (PROPOSED only)
//   6. a refused launch releases                          -> the next launch runs once
//   7. a client timed out and retries the same key from another process mid-launch -> in progress, then the recorded result
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { launchComposedCampaign, _resetComposerFlights } from '@/lib/domain/campaigns/campaign-composer.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.resolve(here, '../../supabase/migrations')
const N = Math.max(24, Number(process.env.RACERS || 24))
const BATCH = 100
const PROD_REF = 'lcppdrmrdfblstpcbgpf'

/* ── engine ─────────────────────────────────────────────────────────────── */
async function engine() {
  const url = process.env.CAMPAIGN_LAUNCH_PROOF_DB_URL
  if (url) {
    const u = new URL(url)
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)
    if (url.includes(PROD_REF)) { console.error('refusing: production project ref in the URL'); process.exit(2) }
    if (!loopback && u.hostname !== process.env.CAMPAIGN_LAUNCH_PROOF_ALLOW_HOST) { console.error(`refusing host ${u.hostname} (set CAMPAIGN_LAUNCH_PROOF_ALLOW_HOST for a throwaway branch)`); process.exit(2) }
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: url, max: N + 8, ssl: loopback ? false : { rejectUnauthorized: false } })
    const pids = new Set()
    return {
      name: `postgres ${u.hostname} (one dedicated connection per racer)`,
      parallel: true,
      exec: (sql) => pool.query(sql),
      query: (sql, params) => pool.query(sql, params),
      async connection() {
        const client = await pool.connect()
        const pid = (await client.query('select pg_backend_pid() p')).rows[0].p
        pids.add(pid)
        return { query: (sql, params) => client.query(sql, params), release: () => client.release(), pid }
      },
      pids,
      close: () => pool.end(),
    }
  }
  const mod = await import(process.env.PGLITE_MODULE || '/tmp/pglite-t/node_modules/@electric-sql/pglite/dist/index.js')
  const db = new mod.PGlite()
  const conn = { query: (sql, params) => db.query(sql, params), release: () => {}, pid: 0 }
  await db.exec(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`)
  return { name: 'pglite (serialised engine)', parallel: false, exec: (sql) => db.exec(sql), query: conn.query, connection: async () => conn, pids: new Set([0]), close: () => db.close() }
}

async function schema(db, { withProposed }) {
  await db.exec(await fs.readFile(path.join(here, 'fixtures/campaign-launch-proof-schema.sql'), 'utf8'))
  if (withProposed) await db.exec(await fs.readFile(path.join(MIG, 'PROPOSED_20261002190000_campaign_launch_claim.sql'), 'utf8'))
}

/* ── a supabase-shaped adapter over one connection ──────────────────────── */
const RPC_ARGS = {
  campaign_launch_claim: ['p_campaign_id::uuid', 'p_launch_key', 'p_claim_token::uuid', 'p_lease_ms::int'],
  campaign_launch_finish: ['p_campaign_id::uuid', 'p_claim_token::uuid', 'p_outcome', 'p_result::jsonb', 'p_error'],
  idempotency_begin: ['p_scope', 'p_key', 'p_claim_token::uuid', 'p_summary', 'p_metadata::jsonb', 'p_lease_ms::int', 'p_payload_hash'],
  idempotency_complete: ['p_scope', 'p_key', 'p_summary', 'p_metadata::jsonb', 'p_skip_content_fields::boolean'],
  idempotency_fail: ['p_scope', 'p_key', 'p_error', 'p_metadata::jsonb', 'p_skip_content_fields::boolean'],
}
function adapter(conn, { functions }) {
  return {
    async rpc(name, args) {
      const spec = RPC_ARGS[name]
      if (!spec || (!functions && name.startsWith('campaign_launch_'))) return { data: null, error: { code: '42883', message: `function public.${name} does not exist` } }
      const params = spec.map((s) => { const v = args[s.split('::')[0]]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v ?? null })
      const sql = `select public.${name}(${spec.map((s, i) => `$${i + 1}${s.includes('::') ? `::${s.split('::')[1]}` : ''}`).join(', ')}) as r`
      try { const res = await conn.query(sql, params); return { data: res.rows[0].r, error: null } } catch (e) { return { data: null, error: { message: e.message, code: e.code } } }
    },
    from(table) {
      const where = []
      const api = {
        select() { return api },
        eq(col, val) { where.push([col, val]); return api },
        async maybeSingle() {
          const res = await conn.query(`select * from public.${table} where ${where.map((w, i) => `${w[0]} = $${i + 1}`).join(' and ')} limit 1`, where.map((w) => w[1]))
          return { data: res.rows[0] ?? null, error: null }
        },
      }
      return api
    },
  }
}

/* ── the flow's side effects, through the production lifecycle function ── */
async function transition(conn, id, to, reason, scheduledFor = null) {
  try {
    await conn.query('select status from public.campaign_transition_status($1, $2, $3, $4)', [id, to, reason, scheduledFor])
    return true
  } catch (e) {
    if (/illegal_campaign_transition/.test(e.message)) return false
    throw e
  }
}
function flowDeps(conn, { functions, hangBuildMs = 0, blocked = false, actor = 'composer' } = {}) {
  return {
    supabase: adapter(conn, { functions }),
    nowMs: Date.parse('2026-10-02T15:00:00Z'),
    loadCampaignStatus: async (_s, id) => (await conn.query('select id, status, total_cap from public.campaigns where id = $1', [id])).rows[0] ?? null,
    buildCampaignTargets: async (id) => {
      await conn.query(`insert into public.proof_effects (campaign_id, effect, actor) values ($1, 'build', $2)`, [id, actor])
      await conn.query(`insert into public.campaign_targets (campaign_id, campaign_key, to_phone_number, target_status, touch_number)
        select $1::uuid, $2::text || ':' || g, '+1555' || lpad(g::text, 7, '0'), 'ready', 1 from generate_series(1, 737) g
        on conflict do nothing`, [id, id])
      if (hangBuildMs) await new Promise((r) => setTimeout(r, hangBuildMs))
      return { ok: true, success: true, build_summary: { ready: 737 } }
    },
    evaluateCampaignLaunchReadiness: async () => (blocked
      ? { launch_readiness: 'blocked', blockers: ['No sendable number'], launch_ready_recipient_count: 737 }
      : { launch_readiness: 'ready', blockers: [], warnings: [], launch_ready_recipient_count: 737 }),
    applyCampaignLifecycleAction: async (id, input) => {
      if (input.action === 'activate') {
        if (!(await transition(conn, id, 'activating', 'operator:composer_launch'))) return { ok: false, error: 'illegal_campaign_transition' }
        await conn.query(`insert into public.proof_effects (campaign_id, effect, actor) values ($1, 'fill', $2)`, [id, actor])
        await conn.query(`insert into public.send_queue (campaign_id, campaign_target_id, queue_key, dedupe_key, queue_status, message_body, to_phone_number)
          select t.campaign_id, t.id, 'q:' || t.campaign_key, 'campaign:' || t.campaign_key, 'scheduled', 'synthetic', t.to_phone_number
          from public.campaign_targets t where t.campaign_id = $1::uuid order by t.campaign_key limit $2::int
          on conflict do nothing`, [id, BATCH])
        await conn.query('update public.campaigns set last_activation_idempotency_key = $2 where id = $1', [id, input.activation_idempotency_key])
        if (!(await transition(conn, id, 'active', 'operator:composer_launch'))) return { ok: false, error: 'illegal_campaign_transition' }
        return { ok: true, to: 'active', inserted: BATCH }
      }
      if (!(await transition(conn, id, 'scheduled', 'operator:composer_launch', input.scheduled_for))) return { ok: false, error: 'illegal_campaign_transition' }
      return { ok: true, to: 'scheduled', inserted: 0 }
    },
    recordCampaignEvent: async () => {},
  }
}

/* ── assertions ─────────────────────────────────────────────────────────── */
const results = []
const check = (suite, name, ok, detail) => { results.push({ suite, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${suite}] ${name}${detail ? `  — ${detail}` : ''}`) }
async function counts(db, id) {
  const one = async (sql) => (await db.query(sql, [id])).rows[0]
  const e = await one(`select count(*) filter (where effect = 'build') b, count(*) filter (where effect = 'fill') f from public.proof_effects where campaign_id = $1`)
  const q = await one('select count(*) c, count(distinct campaign_target_id) d from public.send_queue where campaign_id = $1')
  const t = await one('select count(*) c from public.campaign_targets where campaign_id = $1')
  const s = await one('select status, activation_attempt_count a, last_activation_idempotency_key k from public.campaigns where id = $1')
  return { builds: Number(e.b), fills: Number(e.f), queue: Number(q.c), queueDistinct: Number(q.d), targets: Number(t.c), status: s.status, activations: Number(s.a), key: s.k }
}
const newCampaign = async (db) => { const id = crypto.randomUUID(); await db.query(`insert into public.campaigns (id, name, status, total_cap) values ($1, 'proof', 'built', 1000)`, [id]); return id }
const body = (id, key, mode = 'now') => ({ campaign_id: id, launch_key: key, start: mode === 'now' ? { mode: 'now' } : { mode: 'at', at: '2026-10-03T14:00:00Z' }, expected_eligible: 737 })

async function withConnections(db, n, fn) {
  const conns = await Promise.all(Array.from({ length: n }, () => db.connection()))
  try { return await fn(conns) } finally { for (const c of conns) c.release() }
}

async function suite(db, withProposed) {
  const label = withProposed ? 'PROPOSED functions' : 'production ledger only'
  const functions = withProposed
  await schema(db, { withProposed })

  // 1-3. N parallel launches from N connections
  {
    _resetComposerFlights()
    const id = await newCampaign(db)
    const out = await withConnections(db, N, (conns) => Promise.all(conns.map((c, i) => launchComposedCampaign(body(id, `k${i}`), flowDeps(c, { functions, actor: `racer${i}` })).catch((e) => ({ ok: false, error: `threw:${e.message}` })))))
    const wins = out.filter((r) => r.ok && !r.idempotent)
    const c = await counts(db, id)
    const losers = {}
    for (const r of out.filter((x) => !x.ok)) losers[r.error] = (losers[r.error] || 0) + 1
    check(label, `1 ${N} parallel launches (${N} connections) -> one launch`, wins.length === 1 && c.builds === 1 && c.fills === 1 && c.queue === BATCH && c.queueDistinct === BATCH && c.status === 'active' && c.activations === 1,
      `wins=${wins.length} builds=${c.builds} fills=${c.fills} queue=${c.queue} distinct=${c.queueDistinct} targets=${c.targets} status=${c.status} activation_attempts=${c.activations} losers=${JSON.stringify(losers)}`)
    const winnerKey = `k${out.findIndex((r) => r.ok && !r.idempotent)}`
    _resetComposerFlights()
    const retries = await withConnections(db, 8, (conns) => Promise.all(conns.map((cn) => launchComposedCampaign(body(id, winnerKey), flowDeps(cn, { functions })))))
    const other = await withConnections(db, 1, ([cn]) => launchComposedCampaign(body(id, 'other-tab'), flowDeps(cn, { functions })))
    const c2 = await counts(db, id)
    check(label, '2 8 parallel retries of the winner key -> idempotent, nothing re-runs', retries.every((r) => r.ok && r.idempotent) && c2.builds === 1 && c2.fills === 1 && c2.queue === BATCH, `idempotent=${retries.filter((r) => r.idempotent).length}/8 builds=${c2.builds} fills=${c2.fills}`)
    check(label, '3 another key after the launch -> refused', other.ok === false && ['already_launched', 'campaign_not_launchable'].includes(other.error), other.error)
  }

  // 4. launch vs reschedule on separate connections, repeated
  {
    let both = 0; let neither = 0; let composer = 0; let rescheduler = 0
    for (let round = 0; round < 10; round += 1) {
      _resetComposerFlights()
      const id = await newCampaign(db)
      const [launchRes, schedOk] = await withConnections(db, 2, ([a, b]) => Promise.all([
        launchComposedCampaign(body(id, `race${round}`, 'at'), flowDeps(a, { functions })),
        transition(b, id, 'scheduled', 'operator:reschedule', '2026-10-04T15:00:00Z'),
      ]))
      const c = await counts(db, id)
      const moved = (launchRes.ok ? 1 : 0) + (schedOk ? 1 : 0)
      if (moved === 2) both += 1
      else if (moved === 0) neither += 1
      else if (launchRes.ok) composer += 1
      else rescheduler += 1
      if (c.status !== 'scheduled') neither += 100
    }
    check(label, '4 launch racing a reschedule x10 -> exactly one moves the campaign each time', both === 0 && neither === 0, `composer won ${composer}, reschedule won ${rescheduler}, both ${both}, neither ${neither}`)
  }

  // 5. stale claim takeover (PROPOSED functions: fenced finish)
  if (withProposed) {
    const id = await newCampaign(db)
    const token = crypto.randomUUID()
    const res = await withConnections(db, 6, async (conns) => {
      const first = await adapter(conns[0], { functions }).rpc('campaign_launch_claim', { p_campaign_id: id, p_launch_key: 'zombie', p_claim_token: token, p_lease_ms: 1 })
      await new Promise((r) => setTimeout(r, 2500))
      // five rescuers race to take over the claim (stale under their 1 s lease view; fresh to each other)
      const rescuers = await Promise.all(conns.slice(1).map((cn, i) => adapter(cn, { functions }).rpc('campaign_launch_claim', { p_campaign_id: id, p_launch_key: `rescuer${i}`, p_claim_token: crypto.randomUUID(), p_lease_ms: 1000 })))
      const zombie = await adapter(conns[0], { functions }).rpc('campaign_launch_finish', { p_campaign_id: id, p_claim_token: token, p_outcome: 'completed', p_result: { zombie: true }, p_error: null })
      return { first, rescuers, zombie }
    })
    const takeovers = res.rescuers.filter((r) => r.data?.claimed === true).length
    check(label, '5 stale claim: 5 rescuers race -> exactly one takes over; the zombie finish is fenced', res.first.data.claimed === true && takeovers === 1 && res.zombie.data.fenced === true,
      `takeovers=${takeovers}/5 others=${JSON.stringify(res.rescuers.filter((r) => !r.data?.claimed).map((r) => r.data?.reason))} zombie_fenced=${res.zombie.data.fenced}`)
  } else {
    const id = await newCampaign(db)
    const sb = (c) => adapter(c, { functions })
    const r = await withConnections(db, 6, async (conns) => {
      const first = await sb(conns[0]).rpc('idempotency_begin', { p_scope: 'campaign_launch', p_key: id, p_claim_token: crypto.randomUUID(), p_summary: 'x', p_metadata: {}, p_lease_ms: 1, p_payload_hash: null })
      await new Promise((rr) => setTimeout(rr, 2500))
      const rescuers = await Promise.all(conns.slice(1).map((cn) => sb(cn).rpc('idempotency_begin', { p_scope: 'campaign_launch', p_key: id, p_claim_token: crypto.randomUUID(), p_summary: 'x', p_metadata: {}, p_lease_ms: 1000, p_payload_hash: null })))
      return { first, rescuers }
    })
    const rows = Number((await db.query(`select count(*) c from public.idempotency_ledger where scope = 'campaign_launch' and key = $1`, [id])).rows[0].c)
    const reclaims = r.rescuers.filter((x) => x.data?.duplicate === false).length
    check(label, '5 stale claim takeover (ledger) -> exactly one reclaim, one row; finish NOT fenced (documented gap)', r.first.data.duplicate === false && reclaims === 1 && rows === 1, `reclaims=${reclaims}/5 rows=${rows}`)
  }

  // 6. refused launch releases
  {
    _resetComposerFlights()
    const id = await newCampaign(db)
    const [refused, ok] = await withConnections(db, 2, async ([a, b]) => [
      await launchComposedCampaign(body(id, 'r1'), flowDeps(a, { functions, blocked: true })),
      await launchComposedCampaign(body(id, 'r2'), flowDeps(b, { functions })),
    ])
    const c = await counts(db, id)
    check(label, '6 a refused launch releases; the next launches once', refused.error === 'launch_blocked' && ok.ok && c.fills === 1 && c.queue === BATCH, `refused=${refused.error} next=${ok.ok} fills=${c.fills}`)
  }

  // 7. timed-out client retries the same key from another process mid-launch
  {
    _resetComposerFlights()
    const id = await newCampaign(db)
    const r = await withConnections(db, 3, async ([a, b, c3]) => {
      const slow = launchComposedCampaign(body(id, 'same'), flowDeps(a, { functions, hangBuildMs: 1500 }))
      await new Promise((rr) => setTimeout(rr, 300))
      _resetComposerFlights()
      const during = await launchComposedCampaign(body(id, 'same'), flowDeps(b, { functions }))
      const first = await slow
      _resetComposerFlights()
      const after = await launchComposedCampaign(body(id, 'same'), flowDeps(c3, { functions }))
      return { during, first, after }
    })
    const c = await counts(db, id)
    check(label, '7 retry after timeout (same key, other process) -> in progress, then recorded result', r.first.ok && r.during.error === 'launch_in_progress' && r.after.ok && r.after.idempotent && c.builds === 1 && c.fills === 1,
      `during=${r.during.error ?? 'ok'} after=${r.after.idempotent ? 'idempotent' : r.after.error} builds=${c.builds} fills=${c.fills}`)
  }
}

const db = await engine()
console.log(`engine: ${db.name}; racers: ${N}`)
try {
  await suite(db, true)
  await suite(db, false)
} finally {
  if (db.parallel) console.log(`distinct backend connections used: ${db.pids.size}`)
  await db.close()
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} invariants hold on ${db.name}`)
process.exit(failed.length ? 1 : 0)
