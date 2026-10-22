#!/usr/bin/env node
// LeadCommand Workforce Phase A — THE FIRST DEMONSTRATION, end to end, on a DISPOSABLE local PostgreSQL.
//
//   node --import ./tests/register-aliases.mjs scripts/workforce/demo-opportunity-triage.mjs --admin-url=postgres://postgres@127.0.0.1:54930/postgres \
//        [--runs=3] [--out=<path>/DEMO-REPORT.md] [--keep]
//
// (the admin URL may also come from AGENT_PG_TEST_DB_URL, the disposable-PG variable the PG tests use)
//
// It REFUSES any database target that is not loopback / a unix socket (scripts/db/db-target-guard.mjs, the
// guard run-migration-test uses; a production-like host is refused always). Per run it:
//   a. creates a FRESH database and applies the real schema chain (tests/pg/agent-pg-harness.mjs
//      freshDb({ workforce: true }): S3 persistence + opaque-id payload fix → research_ro → R2 intel_runtime →
//      workforce_foundation), then the real Workforce seed (psql, owner = a synthetic named operator);
//   b. seeds SYNTHETIC, production-shaped domain inputs for 24 opportunities (Dallas + Minneapolis, plus the
//      Hartford never-revive record): contactable / suppressed / held / closed, a $6M ask, missing MAO,
//      stale and thin comps, no Decision Engine row. They reach the capabilities ONLY through the injected
//      read `services` seam (the same names and signatures lib/ai/workforce-runtime-wiring.js binds), wrapped
//      in a spy that records every call and refuses any method that is not a read;
//   c. arms ONLY the workforce kinds + property.research in agent.runtime_limits of THIS database (property.
//      research runs a synthetic handler: no network, no model), and submits the CEO directive through the
//      real POST /command route handler as a named owner;
//   d. drives the real runtime tick (runRuntimeTick) until the mission completes or a bound is hit, with a
//      crash-recovery segment (a dispatcher dies holding a runtime lease AND an assignment lease; both are
//      reaped and the work continues; the dead writer's late finish is refused);
//   e. the CEO approves the $6M escalation through the real resolve route (recorded in Workforce only);
//   f. writes the report: directive, mission, plan, assignments by status, ranked top 10, escalations,
//      refusals, pending, the COO messages verbatim, costs and the proof checks.
// Nothing here reaches production, a provider, a seller or the network. The database is dropped at the end
// unless --keep is given.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { assertDisposableTarget, sanitizedPgEnv } from '../../../../scripts/db/db-target-guard.mjs'
import { createWorkforcePgStore } from '../../src/lib/workforce/store/index.js'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createMissionPgReads } from '../../src/lib/agent/missions/mission-reads.js'
import { encodePropertyRef, decodePropertyRef } from '../../src/lib/agent/missions/mission-codec.js'
import { createUserRateLimiter, resolveRateLimits } from '../../src/lib/agent/security/rate-limit.js'
import { buildWorkforceHandlers } from '../../src/lib/workforce/engine/handlers.js'
import { enqueueWorkforceJob } from '../../src/lib/workforce/engine/dispatch.js'
import { isTerminalSuccess, isCoreAssignment, verifyReportHonesty } from '../../src/lib/workforce/engine/report.js'
import { handleAssignmentResolve, handleCommandPost, handleEmployeeUpsert, handleMissionGet, handleReports } from '../../src/lib/workforce/routes.js'
import { DISPATCH_KIND, WORKFORCE_ORG_ID } from '../../src/lib/workforce/config.js'
import { makeScore, HARTFORD, MAXWELL } from '../../tests/helpers/workforce-fixtures.mjs'
import { contactViolation } from '../../tests/helpers/workforce-fake-store.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DIRECTIVE = 'Find the ten most promising active acquisition opportunities in our current markets and get them moving.'
/** the named owner (synthetic): the CEO of the disposable org */
export const DEMO_OWNER = 'd0d0d0d0-0000-4000-8000-00000000ce00'
const ORG = WORKFORCE_ORG_ID
const ENV = Object.freeze({ AGENT_ENABLED: '1', WORKFORCE_ENABLED: '1' })
const DAY = 86_400_000
const HOUR = 3_600_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex')

/** the domain services the capabilities may call: READS only (the wiring's names) */
export const READ_SERVICES = Object.freeze(['listDealContexts', 'getDealContextByProperty', 'getPipelineCommandOverview', 'loadThreadContext', 'getDealDecision', 'loadAcquisitionScore', 'listActiveHolds', 'checkHold', 'checkSuppression', 'storedActionState', 'researchEnabled', 'closeCalibration'])

// ── b. the SYNTHETIC book (production-shaped; every row is marked synthetic in the report) ──────────────
const hex = (n, w) => n.toString(16).padStart(w, '0')
const uuid = (n, p) => `${hex(n, 8)}-${p.repeat(4)}-4${hex(n, 3)}-8${hex(n, 3)}-${hex(n, 12)}`

/**
 * 24 opportunities. `kind` names what the row exercises (it never reaches the engine).
 * flags: held (a listed automation hold), heldLate (a hold placed after the pool was read: only checkHold sees it),
 * suppressed (the contact is suppressed on the row), suppressedLate (only the suppression lookup says so),
 * closed (universal_status closed_lost).
 */
export function syntheticBook(now) {
  const rows = []
  const add = (i, market, kind, o = {}) => {
    const property_id = o.property_id || String(9_800_000_000 + i)
    const inboundHoursAgo = o.inboundHoursAgo ?? (i % 5) * 9 + 3
    rows.push({
      i, kind, market, property_id, property_ref: encodePropertyRef(property_id),
      thread_key: o.thread_key || `+1${market === 'Dallas' ? '214' : '612'}555${String(1000 + i).slice(-4)}`, // 555 numbers: synthetic
      conversation_id: o.conversation_id || uuid(i, 'c'), opportunity_id: o.opportunity_id || uuid(i, 'b'),
      stage: o.stage || 'asking_price', status: o.status || 'active',
      seller_spoke_last: o.seller_spoke_last ?? (i % 2 === 0), intent: o.intent ?? (i % 3 === 0 ? 'asks_offer' : 'seller_interested'),
      last_inbound_at: new Date(now - inboundHoursAgo * HOUR).toISOString(), last_outbound_at: new Date(now - (inboundHoursAgo + 1) * HOUR).toISOString(),
      score: o.score === undefined ? makeScore({ property_id, now }) : o.score, ask: o.ask === undefined ? 190_000 : o.ask,
      action_state: o.action_state || 'waiting_on_seller', verified_stage: o.stage || 'asking_price',
      held: o.held === true, heldLate: o.heldLate === true, suppressed: o.suppressed === true, suppressedLate: o.suppressedLate === true,
    })
  }
  const sc = (i, o) => makeScore({ property_id: String(9_800_000_000 + i), now, ...o })
  // Dallas (12)
  add(1, 'Dallas', 'contactable · seller asked for a number · CFO-supported', { seller_spoke_last: true, intent: 'asks_offer', action_state: 'offer_ready' })
  add(2, 'Dallas', 'contactable · waiting on seller', { seller_spoke_last: false })
  add(3, 'Dallas', 'no Decision Engine row (research)', { score: null })
  add(4, 'Dallas', 'stale decision row (research)', { score: sc(4, { computedDaysAgo: 45 }) })
  add(5, 'Dallas', 'ask far above MAO (CFO challenge)', { ask: 320_000 })
  add(6, 'Dallas', '$6M ask, at or above the $5M executive threshold (CEO escalation)', { score: sc(6, { value: 6_500_000, offer: 4_200_000, mao: 4_500_000, repairs: 200_000, fee: 150_000 }), ask: 6_000_000 })
  add(7, 'Dallas', 'automation hold (excluded before ranking)', { held: true })
  add(8, 'Dallas', 'suppressed contact (excluded before ranking)', { suppressed: true })
  add(9, 'Dallas', 'no authoritative MAO', { score: sc(9, { mao: null }) })
  add(10, 'Dallas', 'seller waiting on us (needs a person)', { seller_spoke_last: true, action_state: 'needs_attention' })
  add(11, 'Dallas', 'contactable · CFO-supported · offer-ready', { seller_spoke_last: true, intent: 'seller_interested', action_state: 'offer_ready' })
  add(12, 'Dallas', 'thin comp evidence (research)', { score: sc(12, { comps: 3 }) })
  // Minneapolis (11)
  add(13, 'Minneapolis', 'contactable · seller asked for a number · CFO-supported', { seller_spoke_last: true, intent: 'asks_offer', action_state: 'offer_ready' })
  add(14, 'Minneapolis', 'contactable · waiting on seller', { seller_spoke_last: false })
  add(15, 'Minneapolis', 'no Decision Engine row (research)', { score: null })
  add(16, 'Minneapolis', 'stale comps, 18 months (research)', { score: sc(16, { compAgeMonths: 18 }) })
  add(17, 'Minneapolis', 'suppressed after the pool was read (contact not permitted)', { suppressedLate: true })
  add(18, 'Minneapolis', 'hold placed after the pool was read (authority refusal)', { heldLate: true })
  add(19, 'Minneapolis', 'no authoritative MAO', { score: sc(19, { mao: null }) })
  add(20, 'Minneapolis', 'closed lost (excluded before ranking)', { status: 'closed_lost' })
  add(21, 'Minneapolis', 'contactable · stage before price', { stage: 'offer_interest', seller_spoke_last: false })
  add(22, 'Minneapolis', 'contactable · low engine confidence', { score: sc(22, { confidence: 0.41 }) })
  add(23, 'Minneapolis', 'contactable · seller waiting on us', { seller_spoke_last: true, action_state: 'needs_attention' })
  // the Hartford never-revive record (static exclusion; its real ids, synthetic everything else)
  add(24, 'Hartford', 'Hartford never-revive record (static exclusion)', { property_id: HARTFORD.property_id, opportunity_id: HARTFORD.opportunity_id, conversation_id: HARTFORD.conversation_id, thread_key: '+18605550124' })
  return rows
}

/** The synthetic close-rate calibration: Dallas only (so EV is known for some, unknown for the rest). */
const CALIBRATION = Object.freeze({ Dallas: { calibrated: true, p_close: 0.18, sample: 64, risk_haircut: 0.1, source: 'synthetic_demo_calibration' } })

/** The read services over the synthetic book, behind a spy (every call recorded; a non-read refused). */
export function syntheticServices(book, { now }) {
  const by = new Map(book.map((x) => [x.property_id, x]))
  const byThread = new Map(book.map((x) => [x.thread_key, x]))
  const calls = {}
  const probed = new Set()
  const row = (x) => ({
    property_id: x.property_id, thread_key: x.thread_key, market: x.market, universal_stage: x.stage, universal_status: x.status,
    suppression_status: x.suppressed ? 'suppressed' : null, latest_message_direction: x.seller_spoke_last ? 'inbound' : 'outbound', last_intent: x.intent,
    opportunity_id: x.opportunity_id, inbox_thread_id: x.conversation_id, last_inbound_at: x.last_inbound_at, last_outbound_at: x.last_outbound_at,
    acquisition_decision: x.score ? { computed_at: x.score.computed_at } : null, canonical_e164: x.thread_key, best_phone: x.thread_key,
    owner_name: `Synthetic Owner ${x.i}`, thread_state_data: { id: x.conversation_id, is_suppressed: x.suppressed },
  })
  const impl = {
    async listDealContexts(p = {}) { return { rows: book.filter((x) => !p.market || x.market === p.market).map(row), total: book.length } },
    async getDealContextByProperty(id) { const x = by.get(String(id)); return x ? row(x) : null },
    async getPipelineCommandOverview() { return { generatedAt: new Date(now).toISOString(), totals: { opportunities: book.length }, stages: [], stalled: { by: {} } } },
    async loadThreadContext({ thread_key }) {
      const x = byThread.get(thread_key)
      if (!x) return { thread_key, context: { selected_thread: { message_events: [] } } }
      return { thread_key, context: { selected_thread: { message_events: [
        { direction: 'inbound', event_timestamp: x.last_inbound_at, message_body: 'synthetic inbound: call me at 214-555-0199', from_phone_number: x.thread_key },
        { direction: 'outbound', event_timestamp: x.last_outbound_at, message_body: 'synthetic outbound', to_phone_number: x.thread_key },
      ] } } }
    },
    async getDealDecision({ propertyId }) {
      const x = by.get(String(propertyId))
      if (!x) return null
      return { decision: x.score ? { status: 'available', tier: x.score.decision_tier, confidence: x.score.confidence, computedAt: x.score.computed_at } : { status: 'not_run' }, offer: { negotiation: { ask: x.ask } }, contact: { phone: x.thread_key } }
    },
    async loadAcquisitionScore({ property_id }) { return by.get(String(property_id))?.score ?? null },
    async listActiveHolds() { return { ok: true, holds: book.filter((x) => x.held).map((x) => ({ id: uuid(9000 + x.i, 'd'), hold_key: `hold:${x.i}`, hold_type: 'operator_hold', property_id: x.property_id, released_at: null, blocked_capabilities: [] })) } },
    async checkHold({ propertyId }) { const x = by.get(String(propertyId)); return x?.held || x?.heldLate ? { held: true, hold_type: 'operator_hold', fail_closed: false } : { held: false } },
    async checkSuppression({ thread_key }) { const x = byThread.get(thread_key); return { suppressed: Boolean(x?.suppressed || x?.suppressedLate), lookup_error: null } },
    async storedActionState({ property_ref }) {
      const x = book.find((o) => o.property_ref === property_ref)
      if (!x) return null
      return { state: x.action_state, owner: x.action_state === 'needs_attention' ? 'none' : 'seller', verified_stage: x.verified_stage, stage_verified: true, next_action: 'synthetic', reasons: ['synthetic'], lost: false, pending_approvals: [], last_inbound_at: x.last_inbound_at, last_outbound_at: x.last_outbound_at }
    },
    researchEnabled: () => true,
    async closeCalibration({ market }) { return CALIBRATION[market] || null },
  }
  const spy = new Proxy({}, {
    get(_t, k) {
      if (typeof k !== 'string') return undefined
      if (!READ_SERVICES.includes(k)) { probed.add(k); return undefined } // absent: an optional read the wiring does not bind, or a writer (never reachable)
      const f = impl[k]
      return (...a) => { calls[k] = (calls[k] || 0) + 1; return f(...a) }
    },
    has: (_t, k) => READ_SERVICES.includes(k),
  })
  return { services: spy, calls, probed }
}

/** property.research: a SYNTHETIC handler on the real runtime (no network, no model): it completes with a finding. */
export function syntheticResearchHandler(log) {
  return Object.freeze({
    kind: 'property.research',
    async run(ctx) {
      await ctx.step('synthetic_research', { progress: { step: 'synthetic_research', steps_done: 0, steps_total: 1 } })
      const pr = String(ctx.job.input?.property_ref || '')
      let finding_id = null
      try { finding_id = await ctx.recordFinding({ finding_type: 'research.synthetic_property', key: pr, value: { synthetic: true, coverage_share: 0.7, comps_refreshed: 6 }, source_id: 'synthetic_demo', confidence: 0.5 }) } catch (e) { log(`  (synthetic finding not recorded: ${e?.reason || e?.message})`) }
      return { result: { mission: 'property_research', property_ref: pr, synthetic: true, coverage_share: 0.7, comps_refreshed: 6, gaps: [], sends: 0, finding_recorded: Boolean(finding_id) } }
    },
  })
}

// ── a. the disposable database ───────────────────────────────────────────────────────────────────────
function applySeed(db, harness) {
  const src = fs.readFileSync(harness.SQL.workforceSeed, 'utf8')
  const r = spawnSync('psql', [db.url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', `owner_id=${DEMO_OWNER}`, '-f', harness.SQL.workforceSeed], { encoding: 'utf8', env: sanitizedPgEnv(process.env) })
  if (!r.error && r.status === 0) return { via: 'psql' }
  if (!r.error) throw new Error(`workforce seed failed: ${(r.stderr || '').slice(0, 400)}`)
  // no psql binary: the same file with the psql variable bound (the file's own BEGIN / COMMIT wrap it)
  return db.pool.query(src.replace(/^\\set .*$/m, '').replace(/:'owner_id'/g, `'${DEMO_OWNER}'`)).then(() => ({ via: 'pg (psql unavailable)' }))
}

async function publicWrites(pool) {
  await sleep(1100) // cumulative stats flush at most once a second per backend
  await pool.query('select pg_stat_clear_snapshot()')
  const { rows } = await pool.query(`select relname, n_tup_ins::int ins, n_tup_upd::int upd, n_tup_del::int del from pg_stat_user_tables where schemaname = 'public' order by relname`)
  return Object.fromEntries(rows.map((r) => [r.relname, { ins: r.ins, upd: r.upd, del: r.del }]))
}
const sendQueueRows = async (pool) => Number((await pool.query('select count(*)::int n from public.send_queue')).rows[0].n)

// ── the demo ─────────────────────────────────────────────────────────────────────────────────────────
/**
 * @param {{ adminUrl: string, log?: Function, keep?: boolean, maxWallMs?: number, crash?: boolean }} o
 * @returns {Promise<{ ok: boolean, report: object, markdown: string, fingerprint: string, structure: object, checks: object[] }>}
 */
export async function runOpportunityTriageDemo({ adminUrl, log = () => {}, keep = false, maxWallMs = 420_000, crash = true } = {}) {
  assertDisposableTarget(adminUrl) // loopback / unix socket only; a production-like target is refused always
  process.env.AGENT_PG_TEST_DB_URL = adminUrl // the harness reads it (and re-checks loopback) at import
  const harness = await import('../../tests/pg/agent-pg-harness.mjs')
  if (!harness.pgAvailable()) throw new Error('no disposable PostgreSQL')
  const t0 = Date.now()
  const NOW = t0
  const db = await harness.freshDb({ workforce: true })
  log(`database ${db.name} created; schema chain applied (S3 + opaque ids → research_ro → R2 runtime → workforce foundation)`)
  const pools = []
  try {
    // owner membership (the membership sync's row) → the real seed
    await db.pool.query(`insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'owner', 'workforce-demo') on conflict do nothing`, [ORG, DEMO_OWNER])
    const seed = await applySeed(db, harness)
    log(`workforce seed applied via ${seed.via}`)
    const api = db.api // agent_api: least privilege, no BYPASSRLS — what the API and the runtime use
    const wf = createWorkforcePgStore({ pool: api })
    const rt = createRuntimePgStore({ pool: api })
    const reads = createMissionPgReads({ pool: api })
    await rt.assertLeastPrivilege()

    const book = syntheticBook(NOW)
    const { services, calls, probed } = syntheticServices(book, { now: NOW })
    const svc = { store: wf, runtimeStore: rt, reads, membership: (o, u) => reads.membership(o, u) }
    const limiter = createUserRateLimiter({ limits: resolveRateLimits({}) })
    const routeOpts = { env: ENV, auth: () => ({ ok: true }), identity: { authenticate: async () => ({ ok: true, identity: { user_id: DEMO_OWNER, verified: true, named: true } }) }, limiter, getServices: async () => svc }
    const post = (p, body) => new Request(`http://workforce-demo.local/api/cockpit/workforce${p}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    const get = (p) => new Request(`http://workforce-demo.local/api/cockpit/workforce${p}`)

    // the CEO staffs one acquisition agent per market (POST /employees, CEO only)
    for (const [id, name, code, market] of [['emp_acq_dallas_01', 'Acquisitions Dallas', 'ACQ-01', 'Dallas'], ['emp_acq_minneapolis_01', 'Acquisitions Minneapolis', 'ACQ-02', 'Minneapolis']]) {
      const r = await handleEmployeeUpsert(post('/employees', { employee: { employee_id: id, role_key: 'acquisition_agent', display_name: name, employee_code: code, markets: [market], manager_employee_id: 'emp_head_acquisitions' } }), routeOpts)
      if (r.status !== 200) throw new Error(`employee ${id}: ${r.status} ${await r.text()}`)
    }

    // c. arm ONLY the workforce kinds + property.research on THIS database (the owner path)
    const kinds = { 'workforce.coo_plan': 1, 'workforce.dispatch': 1, 'workforce.mission_review': 1, 'property.research': 2 }
    await db.pool.query(`update agent.runtime_limits set runtime_enabled = true, emergency_stop = false, emergency_stop_at = null, max_concurrency_global = 4, tick_max_jobs = 5,
        lease_seconds = 15, backoff_base_seconds = 5, kind_limits = $1::jsonb where id = 1`,
    [JSON.stringify(Object.fromEntries(Object.entries(kinds).map(([k, n]) => [k, { enabled: true, max_concurrency: n, armed_by: DEMO_OWNER }])))])
    const armed = (await db.pool.query('select runtime_enabled, emergency_stop, kind_limits from agent.runtime_limits where id = 1')).rows[0]

    const before = { public_writes: await publicWrites(db.pool), send_queue: await sendQueueRows(db.pool) }
    const privileges = (await db.pool.query(`select has_table_privilege('agent_api', 'public.send_queue', 'insert') ins, has_table_privilege('agent_api', 'public.send_queue', 'update') upd, has_table_privilege('agent_api', 'public.system_control', 'update') ctl`)).rows[0]

    // the directive, through the real POST /command handler, as the named owner
    const cmd = await handleCommandPost(post('/command', { content: DIRECTIVE, client_request_id: 'workforce-demo-directive-0001' }), routeOpts)
    const cmdBody = await cmd.json()
    if (cmd.status !== 201 || !cmdBody.data?.mission) throw new Error(`POST /command: ${cmd.status} ${JSON.stringify(cmdBody).slice(0, 300)}`)
    const mission_id = cmdBody.data.mission.mission_id
    log(`directive submitted → mission ${mission_id} (HTTP ${cmd.status})`)

    // d. the real runtime tick, in a loop
    const research = syntheticResearchHandler(log)
    const handlers = { ...buildWorkforceHandlers({ store: wf, runtimeStore: rt, reads, services, env: ENV, now: () => Date.now(), org_id: ORG }), 'property.research': research }
    const tickLog = []
    const crashState = { done: !crash, job_id: null, job_token: null, assignment_id: null, step_key: null, lease_token: null, at: null }
    let nudges = 0
    let reviewFailure = null
    let mission = null
    let ticks = 0
    let idle = 0
    while (Date.now() - t0 < maxWallMs) {
      const t = await runRuntimeTick({ store: rt, handlers, workerId: 'wf-demo-tick', budgetMs: 25_000, now: () => Date.now() })
      ticks += 1
      tickLog.push({ tick: ticks, claimed: t.claimed, blocked: t.blocked, reaped: t.reaped, jobs: t.jobs.map((j) => ({ kind: j.kind, outcome: j.outcome, attempt: j.attempt })), errors: t.errors })
      mission = await wf.getMission({ org_id: ORG, mission_id })
      if (['completed', 'failed', 'cancelled'].includes(mission.status)) break
      // a review that cannot be written ends the run (it would never complete): record why
      if (t.jobs.some((j) => j.kind === 'workforce.mission_review' && j.outcome !== 'completed')) {
        const dead = (await db.pool.query(`select state, attempt, last_error from agent.research_job where kind = 'workforce.mission_review' and state in ('dead_letter', 'failed') limit 1`)).rows[0]
        if (dead) { reviewFailure = dead; break }
      }
      // the crash: once the candidates are planned, a dispatcher claims a runtime job AND an assignment, then dies
      if (!crashState.done && mission.plan_version >= 2) {
        await enqueueWorkforceJob(rt, { kind: DISPATCH_KIND, key: ['demo-crash', mission_id], input: { reason: 'demo_crash' }, requested_by: DEMO_OWNER })
        const c = await rt.claim({ worker: 'wf-demo-crashed-worker', limit: 1, kinds: [DISPATCH_KIND] })
        const job = c?.claimed?.[0]
        if (job) {
          await rt.start({ job_id: job.job_id, token: job.lease_token })
          const [a] = await wf.claimAssignments({ org_id: ORG, owner: `wf-dispatch:${job.job_id}`.slice(0, 80), limit: 1, lease_seconds: 15 })
          if (a) {
            await wf.progressAssignment({ org_id: ORG, assignment_id: a.assignment_id, lease_token: a.lease_token, patch: { status: 'running' } })
            Object.assign(crashState, { done: true, job_id: job.job_id, job_token: job.lease_token, assignment_id: a.assignment_id, step_key: a.step_key, lease_token: a.lease_token, at: new Date().toISOString() })
            log(`crash: worker died holding runtime job ${job.job_id} and assignment ${a.step_key}`)
          } else {
            await rt.finish({ job_id: job.job_id, token: job.lease_token, outcome: 'release' })
          }
        }
      }
      if (t.claimed === 0) {
        idle += 1
        // nothing due: stand in for the 60 s workforce-dispatch schedule with an operator "run now" (the real enqueue)
        await enqueueWorkforceJob(rt, { kind: DISPATCH_KIND, key: ['demo-nudge', mission_id, ++nudges], input: { reason: 'demo_nudge' }, requested_by: DEMO_OWNER })
        if (idle > 1) await sleep(1000) // a backoff is running (a reaped lease, a retry): wait in real time
      } else idle = 0
    }
    const wallMs = Date.now() - t0
    if (reviewFailure) {
      const { buildMissionReport } = await import('../../src/lib/workforce/engine/report.js')
      const { payloadViolation } = await import('../../src/lib/workforce/store/payload-guard.js')
      const local = buildMissionReport({ mission, assignments: await wf.listAssignments({ org_id: ORG, mission_id, limit: 1000 }), employees: await wf.listEmployees({ org_id: ORG }) })
      reviewFailure.diagnosis = { bytes: Buffer.byteLength(JSON.stringify(local)), sections: Object.fromEntries(Object.entries(local).map(([k, v]) => [k, Buffer.byteLength(JSON.stringify(v ?? null))])), payload_violation: payloadViolation(JSON.parse(JSON.stringify(local))) }
      log(`mission_review failed: ${JSON.stringify(reviewFailure)}`)
    }
    log(`mission ${mission?.status} after ${ticks} ticks, ${Math.round(wallMs / 1000)} s (nudges ${nudges})`)

    // the dead worker wakes up: its late writes are refused (never a silent double finish)
    const late = { assignment: null, job: null }
    if (crashState.assignment_id) {
      try { await wf.finishAssignment({ org_id: ORG, assignment_id: crashState.assignment_id, lease_token: crashState.lease_token, status: 'completed', outcome_class: 'verified', output: {} }); late.assignment = 'ACCEPTED' } catch (e) { late.assignment = e?.code || 'refused' }
      const r = await rt.finish({ job_id: crashState.job_id, token: crashState.job_token, outcome: 'completed', result: {} }).catch((e) => ({ ok: false, reason: e?.code }))
      late.job = r?.ok ? 'ACCEPTED' : `refused${r?.reason ? `:${r.reason}` : ''}`
    }

    // e. the CEO decides the $6M escalation (recorded in Workforce only)
    const jobsBeforeDecision = Number((await db.pool.query('select count(*)::int n from agent.research_job')).rows[0].n)
    const allBefore = await wf.listAssignments({ org_id: ORG, mission_id, limit: 1000 })
    const p6 = book.find((x) => x.i === 6)
    const esc6 = allBefore.find((a) => a.input?.task === 'escalation' && a.input?.property_ref === p6.property_ref)
    let decision = null
    if (esc6) {
      const r = await handleAssignmentResolve(post(`/assignments/${esc6.assignment_id}/resolve`, { decision: 'approve', note: 'Synthetic demo: cleared for internal review only.' }), esc6.assignment_id, routeOpts)
      const b = await r.json()
      const replay = await handleAssignmentResolve(post(`/assignments/${esc6.assignment_id}/resolve`, { decision: 'approve' }), esc6.assignment_id, routeOpts)
      const rb = await replay.json()
      decision = { status: r.status, outcome: b.data?.outcome ?? null, assignment_status: b.data?.assignment?.status ?? null, coo: b.data?.messages?.[0]?.content ?? null, replay_status: replay.status, replayed: rb.data?.replayed === true, replay_messages: rb.data?.messages?.length ?? null }
    }
    const jobsAfterDecision = Number((await db.pool.query('select count(*)::int n from agent.research_job')).rows[0].n)

    // the API reads the CEO would see
    const mg = await handleMissionGet(get(`/missions/${mission_id}`), mission_id, routeOpts)
    const reportsRes = await handleReports(get('/reports'), routeOpts)

    const after = { public_writes: await publicWrites(db.pool), send_queue: await sendQueueRows(db.pool) }

    // f. collect
    mission = await wf.getMission({ org_id: ORG, mission_id })
    const all = await wf.listAssignments({ org_id: ORG, mission_id, limit: 1000 })
    const events = []
    for (let after_id = 0; ;) { const page = await wf.listEvents({ org_id: ORG, after_event_id: after_id, limit: 500 }); events.push(...page); if (page.length < 500) break; after_id = page[page.length - 1].event_id }
    const messages = (await wf.listExecMessages({ org_id: ORG, limit: 200 })).reverse()
    const facts = await wf.listMemoryFacts({ org_id: ORG, scope: 'mission', scope_key: mission_id })
    const jobs = (await db.pool.query(`select job_id, kind, state, attempt, requested_by, trigger_kind from agent.research_job order by created_at, job_id`)).rows
    const crashEvents = crashState.job_id ? await rt.jobEvents(crashState.job_id) : []
    const spend = (await db.pool.query(`select count(*)::int n, coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)), 0)::float usd from agent.spend_ledger`)).rows[0]
    const findings = Number((await db.pool.query(`select count(*)::int n from agent.finding where finding_type = 'research.synthetic_property'`)).rows[0].n)
    const claims = await wf.listResourceClaims({ org_id: ORG, active: true })

    const report = mission.report || {}
    const byId = new Map(all.map((a) => [a.assignment_id, a]))
    const opps = all.find((a) => a.step_key === 'opps')
    const pid = (ref) => (ref ? String(decodePropertyRef(ref)) : null)
    const bookBy = new Map(book.map((x) => [x.property_ref, x]))
    const label = (ref) => { const x = bookBy.get(ref); return x ? `#${x.i} ${x.market} · ${x.kind}` : ref }

    // ── the proof checks ──
    const checks = []
    const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail }); return ok }
    check('the mission completed', mission.status === 'completed', `status ${mission.status}, plan_version ${mission.plan_version}`)
    check('every report "completed" item maps to a completed (verified/partial) assignment', (report.completed || []).every((c) => isTerminalSuccess(byId.get(c.assignment_id))), `${(report.completed || []).length} items`)
    check('verifyReportHonesty finds no problem', verifyReportHonesty(report, all).length === 0, verifyReportHonesty(report, all).join(', ') || 'none')
    check('every core assignment is terminal', all.filter(isCoreAssignment).every((a) => ['completed', 'failed', 'cancelled'].includes(a.status)))
    const pubDelta = Object.entries(after.public_writes).map(([t, v]) => [t, v.ins - (before.public_writes[t]?.ins || 0) + v.upd - (before.public_writes[t]?.upd || 0) + v.del - (before.public_writes[t]?.del || 0)]).filter(([, n]) => n !== 0)
    check('no public.* table was written (send_queue, system_control: pg_stat inserts/updates/deletes unchanged)', pubDelta.length === 0, pubDelta.length ? JSON.stringify(pubDelta) : `${Object.keys(after.public_writes).join(', ')}: 0 writes`)
    check('public.send_queue has the same row count before and after (0)', before.send_queue === after.send_queue && after.send_queue === 0, `${before.send_queue} → ${after.send_queue}`)
    check('agent_api (the store and runtime role) cannot write public.send_queue / system_control', !privileges.ins && !privileges.upd && !privileges.ctl, JSON.stringify(privileges))
    check('the services spy saw reads only: every call is one of the wiring\'s read services; anything else is not even reachable', Object.keys(calls).every((k) => READ_SERVICES.includes(k)), `calls ${JSON.stringify(calls)}; probed but absent (not bound): ${[...probed].join(', ') || 'none'}`)
    const excludedRefs = book.filter((x) => x.held || x.heldLate || x.suppressed || x.suppressedLate || x.status === 'closed_lost' || x.market === 'Hartford').map((x) => x.property_ref)
    const rankStep = all.find((a) => a.step_key === 'rank')
    const rankedRefs = new Set([...(rankStep?.output?.ranked || []).map((r) => r.property_ref), ...(report.ranked || []).map((r) => r.refs?.property_ref)])
    check('held, suppressed, closed and excluded opportunities are never ranked', excludedRefs.every((r) => !rankedRefs.has(r)), `${excludedRefs.length} checked`)
    const blob = JSON.stringify(all)
    check('Hartford / Maxwell ids appear in no assignment', ![HARTFORD.opportunity_id, HARTFORD.conversation_id, MAXWELL.opportunity_id, MAXWELL.conversation_id].some((id) => blob.includes(id)))
    check('no contact value is stored (assignments, events, messages, plan, report)', contactViolation([all.map((a) => [a.input, a.output, a.evidence]), events.map((e) => e.payload), messages.map((m) => [m.content, m.refs]), mission.plan, mission.report]) === null)
    const wfJobs = jobs.filter((j) => j.kind.startsWith('workforce.') || j.kind === 'property.research')
    check('every Workforce and research job is accountable to the named owner', wfJobs.every((j) => j.requested_by === DEMO_OWNER), `${wfJobs.length} jobs`)
    check('no job of any other kind exists (nothing outside Workforce + research ran)', jobs.every((j) => j.kind.startsWith('workforce.') || j.kind === 'property.research'), [...new Set(jobs.map((j) => j.kind))].join(', '))
    const esc = (report.escalations || []).find((e) => e.refs?.property_ref === p6.property_ref)
    check('the $6M opportunity escalated to the CEO queue (an assignment, not a silent block)', Boolean(esc && esc6 && esc6.assignee_employee_id === 'emp_ceo'), esc ? esc.reasons.join(', ') : 'missing')
    if (crash) {
      const ca = byId.get(crashState.assignment_id)
      const reapedEv = events.find((e) => e.assignment_id === crashState.assignment_id && e.type === 'wf.assignment.transitioned' && e.payload?.reason === 'lease_expired')
      check('crash: the dead worker\'s assignment lease expired, was reaped and the step completed', Boolean(ca && reapedEv && ca.status === 'completed' && ca.attempt >= 1), ca ? `${crashState.step_key}: ${ca.status}, attempt ${ca.attempt}` : 'no crash happened')
      const types = crashEvents.map((e) => e.type)
      check('crash: the dead worker\'s runtime job lease expired, was reaped and the job ran again', types.includes('job.lease_expired') && types.filter((t) => t === 'job.claimed').length >= 2, types.join(' → '))
      check('crash: the dead worker\'s late finishes are refused (assignment LEASE_LOST, job refused)', late.assignment === 'LEASE_LOST' && /^refused/.test(late.job || ''), JSON.stringify(late))
      const keys = all.map((a) => a.step_key)
      check('crash: no step was duplicated', new Set(keys).size === keys.length)
    }
    check('resource claims were released when the mission completed', claims.length === 0, `${claims.length} active`)
    check('the ranking was remembered as an interpretation with source refs', facts.length === 1 && facts[0].epistemic === 'interpretation' && facts[0].source_refs.length >= 1)
    if (decision) {
      check('CEO approve: recorded (200), the item completed, the COO acknowledged, nothing else started', decision.status === 200 && decision.assignment_status === 'completed' && Boolean(decision.coo) && jobsAfterDecision === jobsBeforeDecision, `runtime jobs ${jobsBeforeDecision} → ${jobsAfterDecision}`)
      check('CEO approve: the outcome says nothing was sent, offered or staged; every external effect false', /Nothing was sent, no offer was made and no stage changed\.$/.test(decision.outcome?.message || '') && Object.entries(decision.outcome?.effects || {}).every(([k, v]) => (k === 'recorded_in_workforce' ? v === true : v === false)))
      check('CEO approve: a replay is idempotent (200, replayed, no new message)', decision.replay_status === 200 && decision.replayed && decision.replay_messages === 0)
    }
    check('the API answers the mission and the reports (GET /missions/[id], GET /reports)', mg.status === 200 && reportsRes.status === 200)

    // ── the structure (deterministic across runs: no ids, no times) ──
    const countBy = (xs, f) => xs.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m }, {})
    const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))
    const structure = {
      intent: mission.plan?.intent, plan_steps: mission.plan?.steps?.length ?? null, plan_version: mission.plan_version, status: mission.status,
      assignments_by_status: sortObj(countBy(all, (a) => `${a.status}${a.outcome_class ? `:${a.outcome_class}` : ''}`)),
      assignments_by_capability: sortObj(countBy(all, (a) => a.capability_key)),
      excluded_at_pool: opps?.output?.excluded ?? null, eligible: opps?.output?.eligible ?? null, pool: opps?.output?.candidates?.length ?? null,
      ranked: (report.ranked || []).map((r) => [r.rank, pid(r.refs?.property_ref), r.cfo_verdict, r.ev?.status, r.next_action || r.next_action_status]),
      escalations: [...new Set((report.escalations || []).map((e) => `${pid(e.refs?.property_ref)}:${(e.reasons || []).join('+')}`))].sort(),
      refused: (report.refused || []).map((x) => `${x.step}:${(x.reasons || []).join('+')}`).sort(),
      pending: (report.pending || []).map((x) => `${x.step}:${x.reason}`).sort(),
      unknowns: (report.unknowns || []).length,
      coo_messages: messages.filter((m) => m.author === 'coo').length,
      memory_facts: facts.length,
      ceo_decision: decision ? [decision.status, decision.assignment_status, decision.replayed] : null,
      checks: checks.map((c) => [c.name, c.ok]),
    }
    const fingerprint = sha(structure).slice(0, 16)

    const out = {
      directive: DIRECTIVE, mission_id, mission, all, events, messages, facts, jobs, spend, findings, report, book, calls, ticks, nudges, wallMs, tickLog,
      crashState, crashEvents, late, decision, reviewFailure, armed, seed, before, after, privileges, structure, fingerprint, checks, db: db.name, label, pid, opps,
    }
    const markdown = renderReport(out)
    return { ok: checks.every((c) => c.ok), report: out, markdown, fingerprint, structure, checks }
  } finally {
    for (const p of pools) await p.end().catch(() => {})
    if (!keep) await db.drop().catch(() => {})
  }
}

// ── the report ───────────────────────────────────────────────────────────────────────────────────────
const usd = (v) => (v == null ? 'unknown' : `$${Math.round(Number(v)).toLocaleString('en-US')}`)
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const decodeText = (t) => String(t ?? '').replace(/pid_[g-p]{1,20}/g, (m) => String(decodePropertyRef(m)))

export function renderReport(r, runs = null) {
  const L = []
  const { mission, all, report, label, pid } = r
  const st = r.structure
  L.push('# Workforce Phase A — first demonstration: opportunity triage', '')
  L.push(`Generated ${new Date().toISOString()} on a disposable local PostgreSQL 17 database (\`${r.db}\`, dropped afterwards).`, '')
  L.push('## What is real and what is synthetic', '')
  L.push('| Layer | In this run |', '|---|---|')
  L.push('| PostgreSQL schema | REAL: S3 persistence + opaque-id payload fix, research_ro, R2 intel_runtime, workforce_foundation (PROPOSED files, the harness chain) + the real Workforce seed |')
  L.push('| Workforce store | REAL: createWorkforcePgStore over agent_api (SECURITY DEFINER writers, guards, state graphs, payload CHECKs) |')
  L.push('| R2 runtime | REAL: createRuntimePgStore + agent.runtime_* functions, leases, reaper, kind limits; runRuntimeTick drives every job |')
  L.push('| Workforce engine | REAL: coo_plan / dispatch / mission_review handlers, authority engine, COO, CFO review, ranking, report |')
  L.push('| API | REAL route handlers: POST /employees, POST /command, POST /assignments/[id]/resolve, GET /missions/[id], GET /reports (a fake request with a named owner session; dashboard auth stubbed) |')
  L.push('| Domain inputs | SYNTHETIC: 24 production-shaped opportunities (deal contexts, Decision Engine rows, conversations, holds, suppression, action states, a Dallas close-rate calibration) through the injected read-only `services` seam, behind a call spy |')
  L.push('| property.research | SYNTHETIC handler on the REAL runtime kind: no network, no model; it records a synthetic finding |')
  L.push('| Time | REAL wall clock. The 60 s dispatch schedule is stood in for by an operator "run now" enqueue when the runtime is idle |', '')
  L.push('## The directive', '', `> ${r.directive}`, '')
  L.push(`Mission \`${r.mission_id}\`: **${mission.title}**, status **${mission.status}**, plan_version ${mission.plan_version} (two recorded expansions), ${st.plan_steps} plan steps, ${all.length} assignments. ${r.ticks} runtime ticks, ${Math.round(r.wallMs / 1000)} s wall, ${r.nudges} idle nudges.`, '')
  L.push('## Assignments by status', '', '| status:outcome | n |', '|---|---|', ...Object.entries(st.assignments_by_status).map(([k, v]) => `| ${k} | ${v} |`), '')
  L.push('| capability | n |', '|---|---|', ...Object.entries(st.assignments_by_capability).map(([k, v]) => `| ${k} | ${v} |`), '')
  const ex = r.opps?.output?.excluded || {}
  L.push(`Pool: ${r.opps?.output?.scanned ?? '?'} scanned, ${r.opps?.output?.eligible ?? '?'} eligible, ${st.pool} taken (2N). Excluded before ranking: ${Object.entries(ex).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '')
  L.push('## Ranked top 10', '', '| # | property | market · what it exercises (synthetic) | contact | pressure | deal quality | CFO | EV | next action |', '|---|---|---|---|---|---|---|---|---|')
  for (const x of report.ranked || []) {
    const c = x.components || {}
    const v = (k) => (c[k]?.status === 'known' ? c[k].value : 'unknown')
    L.push(`| ${x.rank} | ${pid(x.refs?.property_ref)} | ${esc(label(x.refs?.property_ref))} | ${v('contact_identity')} | ${v('pressure')} | ${v('deal_quality')} | ${x.cfo_verdict ?? 'none'} | ${x.ev?.status === 'known' ? usd(x.ev.value) : `unknown (${(x.ev?.missing || []).join(', ')})`} | ${x.next_action ?? x.next_action_status} |`)
  }
  L.push('', 'Refs per row: the property id (Deal Intelligence), the opportunity and conversation ids are in the mission report (`ranked[].refs`); every number above is copied from the rank step\'s output.', '')
  L.push('## Escalations (the CEO queue)', '')
  for (const e of report.escalations || []) L.push(`- ${e.step} · property ${pid(e.refs?.property_ref)} (${esc(label(e.refs?.property_ref))}): ${e.reasons.join(', ')} → CEO item \`${e.ceo_assignment_id ?? 'n/a'}\``)
  const queue = all.filter((a) => a.assignee_employee_id === 'emp_ceo')
  L.push('', `CEO queue items: ${queue.length} (${Object.entries(queue.reduce((m, a) => ({ ...m, [`${a.input?.task}:${a.status}`]: (m[`${a.input?.task}:${a.status}`] || 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ')}).`, '')
  if (r.decision) {
    L.push(`CEO decision on the $6M escalation (POST /assignments/[id]/resolve, approve): HTTP ${r.decision.status}, item ${r.decision.assignment_status}; replay HTTP ${r.decision.replay_status}, replayed ${r.decision.replayed}, new messages ${r.decision.replay_messages}.`, '')
    L.push(`> ${r.decision.outcome?.message}`, '')
    L.push(`Effects: ${Object.entries(r.decision.outcome?.effects || {}).map(([k, v]) => `${k}=${v}`).join(', ')}.`, '')
  }
  L.push('## Refusals', '')
  for (const x of report.refused || []) L.push(`- ${x.step} · property ${pid(x.refs?.property_ref)} (${esc(label(x.refs?.property_ref))}): ${(x.reasons || []).join(', ')}`)
  const rk = all.find((a) => a.step_key === 'rank')
  for (const x of rk?.output?.excluded || []) L.push(`- ranking excluded property ${pid(x.property_ref)} (${esc(label(x.property_ref))}): ${x.reason}`)
  L.push(`- excluded before any step (never planned): ${r.book.filter((x) => x.held || x.suppressed || x.status === 'closed_lost' || x.market === 'Hartford').map((x) => `#${x.i} ${x.kind}`).join('; ')}`, '')
  L.push('## Pending (not done, with the reason)', '')
  L.push('As of the mission report (written by mission_review). "Now" is the assignment after the run, e.g. after the CEO decision.', '')
  for (const x of report.pending || []) {
    const nowA = all.find((a) => a.assignment_id === x.assignment_id)
    const changed = nowA && nowA.status !== x.status ? ` · now ${nowA.status}${nowA.output?.decision ? ` (CEO decision: ${nowA.output.decision})` : ''}` : ''
    L.push(`- ${x.step} (${x.capability}, task ${nowA?.input?.task ?? 'n/a'}) · ${x.status}: ${x.reason}${x.refs?.property_ref ? ` · property ${pid(x.refs.property_ref)}` : ''}${changed}`)
  }
  L.push('', `Unknowns recorded: ${(report.unknowns || []).length} (${[...new Set((report.unknowns || []).map((u) => String(u.reason).split(':')[0]))].join(', ')}).`, '')
  L.push('## The COO messages (verbatim)', '')
  for (const m of r.messages) L.push(`- **${m.author.toUpperCase()}**: ${decodeText(m.content)}`)
  L.push('', '## Costs', '')
  L.push(`Report costs: status ${report.costs?.status}, total ${usd(report.costs?.total_usd)} over ${(report.costs?.by_job || []).length} research jobs (inline reads cost nothing). agent.spend_ledger rows: ${r.spend.n}, committed ${usd(r.spend.usd)}: the synthetic research handler makes no model call. Synthetic findings recorded: ${r.findings}.`, '')
  L.push('## Runtime jobs', '', '| kind | state | n |', '|---|---|---|')
  const jk = r.jobs.reduce((m, j) => ({ ...m, [`${j.kind}|${j.state}`]: (m[`${j.kind}|${j.state}`] || 0) + 1 }), {})
  for (const [k, v] of Object.entries(jk).sort()) L.push(`| ${k.split('|')[0]} | ${k.split('|')[1]} | ${v} |`)
  L.push('', `Armed on this database only: ${Object.keys(r.armed.kind_limits).join(', ')} (runtime_enabled ${r.armed.runtime_enabled}, emergency_stop ${r.armed.emergency_stop}).`, '')
  if (r.crashState?.assignment_id) {
    L.push('## Crash recovery', '')
    L.push(`At ${r.crashState.at} a worker claimed runtime job \`${r.crashState.job_id}\` and assignment \`${r.crashState.step_key}\`, set it running, and died (no finish, no heartbeat).`)
    L.push(`Runtime job events: ${r.crashEvents.map((e) => e.type).join(' → ')}.`)
    const ca = all.find((a) => a.assignment_id === r.crashState.assignment_id)
    L.push(`The assignment: ${ca?.status}, attempt ${ca?.attempt} (the dead attempt counted). The dead worker's late writes: assignment ${r.late.assignment}, job ${r.late.job}.`, '')
  }
  L.push('## Proof checks', '', '| check | result | detail |', '|---|---|---|')
  for (const c of r.checks) L.push(`| ${esc(c.name)} | ${c.ok ? 'PASS' : 'FAIL'} | ${esc(c.detail)} |`)
  L.push('', `Domain service calls (spy): ${Object.entries(r.calls).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '')
  L.push('## Determinism', '')
  if (runs) {
    L.push(`${runs.length} runs, each on a fresh database. Structural fingerprints (no ids, no times): ${runs.map((x) => `\`${x.fingerprint}\``).join(', ')}: ${new Set(runs.map((x) => x.fingerprint)).size === 1 ? '**identical**' : '**DIFFERENT**'}.`)
    L.push('', '| run | mission | ticks | wall s | checks |', '|---|---|---|---|---|', ...runs.map((x, i) => `| ${i + 1} | ${x.status} | ${x.ticks} | ${Math.round(x.wallMs / 1000)} | ${x.passed}/${x.total} |`))
  } else L.push(`Structural fingerprint: \`${r.fingerprint}\`.`)
  L.push('', '<details><summary>Structure (the fingerprinted object)</summary>', '', '```json', JSON.stringify(st, null, 1), '```', '</details>', '')
  return L.join('\n')
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : process.argv.includes(`--${n}`) ? true : d }
  const adminUrl = String(arg('admin-url', process.env.AGENT_PG_TEST_DB_URL || '') || '')
  if (!adminUrl) { console.error('usage: --admin-url=postgres://postgres@127.0.0.1:<port>/postgres (a DISPOSABLE local server)'); process.exit(2) }
  assertDisposableTarget(adminUrl)
  const runs = Math.min(Math.max(Number(arg('runs', 1)) || 1, 1), 5)
  const outPath = path.resolve(String(arg('out', path.join(os.tmpdir(), 'workforce-demo', 'DEMO-REPORT.md'))))
  const results = []
  for (let i = 0; i < runs; i += 1) {
    console.log(`\n── run ${i + 1}/${runs}`)
    const r = await runOpportunityTriageDemo({ adminUrl, log: (s) => console.log(`  ${s}`), keep: arg('keep') === true })
    console.log(`  fingerprint ${r.fingerprint}; checks ${r.checks.filter((c) => c.ok).length}/${r.checks.length}`)
    for (const c of r.checks.filter((x) => !x.ok)) console.log(`  FAIL ${c.name}: ${c.detail}`)
    results.push(r)
  }
  const last = results[results.length - 1]
  const summary = results.map((r) => ({ fingerprint: r.fingerprint, status: r.report.mission.status, ticks: r.report.ticks, wallMs: r.report.wallMs, passed: r.checks.filter((c) => c.ok).length, total: r.checks.length }))
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, renderReport(last.report, summary))
  fs.writeFileSync(outPath.replace(/\.md$/, '.json'), JSON.stringify({ runs: summary, structure: last.structure, checks: last.checks }, null, 1))
  console.log(`\nreport → ${outPath}`)
  console.log(last.markdown.split('\n').filter((l) => /^(#|\| \d+ \||- \*\*COO)/.test(l)).slice(0, 40).join('\n'))
  const same = new Set(summary.map((s) => s.fingerprint)).size === 1
  console.log(`\n${runs} run(s): fingerprints ${same ? 'identical' : 'DIFFER'}; all checks ${results.every((r) => r.ok) ? 'PASS' : 'FAIL'}`)
  process.exit(results.every((r) => r.ok) && same ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e?.stack || e); process.exit(1) })
}
export { here as DEMO_DIR }
