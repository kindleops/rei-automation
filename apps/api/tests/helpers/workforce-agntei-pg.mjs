// Disposable-PostgreSQL world for the Workforce × Agntei proofs (docs/WORKFORCE-AGNTEI.md). AGENT_PG_TEST_DB_URL
// must name a LOCAL scratch server (agent-pg-harness refuses anything else).
//
// ONE template database per process carries the REAL chain: S3 (+ opaque ids) → research → R2 runtime → the
// Action Gateway prerequisites + #26 + the follow-up lifecycle + #27 (the extension registry) → the Workforce
// foundation → PROPOSED_20261022110000_workforce_agntei. Each world() is CREATE DATABASE … TEMPLATE (fast) with:
//   owner   postgres            the org owner's SQL editor (principals, grants, binds, controls) and the runtime worker
//   api     agent_api           the Workforce API / engine store (least privilege)
//   gw      AS lc_action_gateway with lc_org — the Action MCP's ONLY data path (exactly what PostgREST does)
// The provider is simulated: nothing here can reach a network.
import fs from 'node:fs'
import crypto from 'node:crypto'
import pg from 'pg'

import { freshDb, runSqlFile, applyInTransaction, SQL, urlFor, ADMIN_URL } from '../pg/agent-pg-harness.mjs'
import { pgSupabase, isoPool } from './pg-supabase.mjs'
import { MIG, FIX, GATEWAY_MIGRATION, GATEWAY_BASELINE, PEPPER } from './action-gateway-pg.mjs'
import { createActionGateway, createPostgrestActionStore, createGatewayReads, createGatewayServices, mintAgentCredential } from '../../src/lib/domain/action-gateway/index.js'
import { createWorkforcePgStore } from '../../src/lib/workforce/store/index.js'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { seedEmployeesFor } from '../../src/lib/workforce/org/seed.js'
import { WORKFORCE_CAPABILITIES } from '../../src/lib/workforce/agntei/tools.js'
import { checkAutomationHold } from '../../src/lib/domain/holds/automation-hold.js'

export const ORG = '00000000-0000-4000-8000-00000000a001' // the LeadCommand org (the Workforce foundation's)
export const ORG_B = '00000000-0000-4000-8000-0000000000b2'
export const OWNER = '11111111-1111-4111-8111-111111111111' // the CEO user (owner)
export const OPERATOR = '33333333-3333-4333-8333-333333333333'
export const OWNER_B = '22222222-2222-4222-8222-222222222222'
export const AGNTEI_MIGRATION = MIG('PROPOSED_20261022110000_workforce_agntei.sql')
const T2_MIGRATION = MIG('PROPOSED_20261020100000_action_gateway_t2.sql')
const T2_BASELINE = new URL('../../../../mcp/leadcommand-action-mcp/migrations/test/action_gateway_t2_baseline.sql', import.meta.url).pathname
const ON = { WORKFORCE_ENABLED: '1' }

const TS = new Set([1184, 1114])
const types = { getTypeParser: (oid, format) => (TS.has(oid) ? (v) => (v == null ? v : String(v).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')) : pg.types.getTypeParser(oid, format)) }
const RUNTIME_PUBLIC_FIXTURE = `create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  create table if not exists public.send_queue (id bigserial primary key, queue_status text, scheduled_for timestamptz);
  revoke all on public.system_control, public.send_queue from agent_api;`
const CONVERSATION_FIXTURE = `
  alter table public.message_events add column if not exists detected_intent text, add column if not exists language text, add column if not exists is_opt_out boolean,
    add column if not exists event_timestamp timestamptz, add column if not exists received_at timestamptz;
  alter table public.send_queue add column if not exists use_case_template text, add column if not exists agent_name text, add column if not exists scheduled_for_utc timestamptz,
    add column if not exists from_phone_number text, add column if not exists sent_at timestamptz;
  create table if not exists public.deal_thread_state (thread_key text primary key, universal_status text, inbox_bucket text, universal_stage text, opt_out boolean);`

// the SAME cluster-wide bootstrap lock as action-gateway-pg.mjs (roles are cluster-global)
const BOOTSTRAP_LOCK = 0x4c43_4147
async function underBootstrapLock(fn) {
  const admin = new pg.Client({ connectionString: ADMIN_URL })
  await admin.connect()
  try {
    await admin.query('select pg_advisory_lock($1)', [BOOTSTRAP_LOCK])
    return await fn()
  } finally {
    await admin.query('select pg_advisory_unlock($1)', [BOOTSTRAP_LOCK]).catch(() => {})
    await admin.end().catch(() => {})
  }
}

let templatePromise = null
/** The template database (built once per process): the whole chain + the Agntei link. */
export function agnteiTemplate() {
  if (!templatePromise) templatePromise = underBootstrapLock(async () => {
    const db = await freshDb()
    try {
      const run = (f) => runSqlFile(db.pool, f)
      const tx = (f) => applyInTransaction(db.pool, f)
      // B1 (2026-10-25): typed Agntei identities are never phones (after #25, which freshDb applied)
      await run(MIG('PROPOSED_20261025100000_payload_clean_typed_external_ids.sql'))
      await run(SQL.researchPretest); await run(SQL.research)
      await run(FIX('send_queue_live_baseline.sql'))
      await db.pool.query(RUNTIME_PUBLIC_FIXTURE)
      await run(FIX('operations_public_baseline.sql'))
      await run(FIX('automation_holds_public_baseline.sql'))
      await tx(SQL.runtime)
      await tx(MIG('PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql'))
      await tx(MIG('PROPOSED_20261013161000_conversation_decide_event_budget.sql'))
      await tx(MIG('PROPOSED_20261013120000_agent_capabilities.sql'))
      await tx(MIG('PROPOSED_20261013160000_conversation_ai_shadow.sql'))
      await tx(MIG('PROPOSED_20261014120000_persistent_missions.sql'))
      await tx(MIG('PROPOSED_20261016140000_operations_action_center.sql'))
      await run(MIG('PROPOSED_20261017122000_conversation_turn_operator_items.sql'))
      await run(MIG('PROPOSED_20261016200000_automation_holds_registry.sql'))
      await run(MIG('PROPOSED_20261016200100_automation_hold_guards.sql'))
      await run(GATEWAY_BASELINE)
      await db.pool.query(CONVERSATION_FIXTURE)
      await tx(GATEWAY_MIGRATION)
      await run(MIG('PROPOSED_20261017120000_followup_intent_lifecycle.sql'))
      await run(T2_BASELINE)
      await tx(T2_MIGRATION)
      await tx(SQL.workforce)
      await tx(AGNTEI_MIGRATION)
      await db.pool.query('alter role agent_api login')
      const name = db.name
      for (const p of [db.api]) await p?.end().catch(() => {})
      await db.pool.end().catch(() => {})
      return name
    } catch (e) {
      await db.drop().catch(() => {})
      throw e
    }
  })
  return templatePromise
}

/** A fresh world: a database from the template, the three connections, the org's humans, the controls ON (T1). */
export async function agnteiWorld({ seedEmployees = true } = {}) {
  const template = await agnteiTemplate()
  const name = `wfa_${crypto.randomBytes(5).toString('hex')}`
  await underBootstrapLock(async () => {
    const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 })
    try { await admin.query(`create database ${name} template ${template}`) } finally { await admin.end() }
  })
  const pools = []
  const track = (p) => { p.on('error', () => {}); pools.push(p); return p }
  const url = urlFor(name)
  const owner = track(isoPool(url, 8))
  const api = track(new pg.Pool({ connectionString: urlFor(name, 'agent_api'), max: 8, types }))
  const env = {
    name, url, owner, api, track,
    store: createWorkforcePgStore({ pool: api }),
    runtime: createRuntimePgStore({ pool: api }),
    async drop() {
      for (const p of pools) await p.end().catch(() => {})
      const a = new pg.Pool({ connectionString: ADMIN_URL, max: 1 })
      await a.query(`drop database if exists ${name} with (force)`).catch(() => {})
      await a.end()
    },
  }
  await owner.query(`insert into agent.org (org_id, name) values ($1, 'tenant b') on conflict do nothing`, [ORG_B])
  await owner.query(`insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'owner', 'test'), ($1, $3, 'operator', 'test'), ($4, $5, 'owner', 'test') on conflict do nothing`,
    [ORG, OWNER, OPERATOR, ORG_B, OWNER_B])
  await setControls(owner, { action_gateway_enabled: 'true', action_gateway_tiers: 'T1' })
  if (seedEmployees) for (const e of seedEmployeesFor({ org_id: ORG, owner_user_id: OWNER })) await env.store.upsertEmployee({ org_id: ORG, employee: stripOrg(e), actor_user_id: OWNER })
  return env
}
const stripOrg = ({ org_id, ...e }) => e

export async function setControls(pool, values) {
  for (const [k, v] of Object.entries(values)) {
    if (v == null) await pool.query('delete from public.system_control where key = $1', [k])
    else await pool.query('insert into public.system_control (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, String(v)])
  }
}

/**
 * The owner's "Register an Agntei agent" path end to end: the CEO creates the pending_link employee (API store), the owner
 * mints + registers the principal (sponsor = the CEO user), grants the Workforce capabilities (T1 standing grants) and binds.
 * Returns { token, agent_id, employee_id }.
 */
export async function registerAgnteiAgent(env, { employee_id = 'emp_scout', agent_id = 'agt_scout', display_name = 'Scout', role_key = 'research_analyst', markets = [], org = ORG,
  owner = OWNER, grants = WORKFORCE_CAPABILITIES, bind = true, linkWindow = '24 hours', bindingValidUntil = null, expiresDays = 30, spendPerDay = 1 } = {}) {
  const dept = { research_analyst: 'data_intelligence', acquisition_agent: 'acquisitions', head_data_intelligence: 'data_intelligence' }[role_key] || 'data_intelligence'
  await env.store.upsertEmployee({ org_id: org, employee: { employee_id, kind: 'ai', role_key, department_key: dept, display_name, markets, origin: 'agntei' }, actor_user_id: owner })
  const { token, digest } = mintAgentCredential(PEPPER)
  await env.owner.query(`insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, read_scopes, created_by)
                         values ($1, $2, $3, $4, $5, now() + make_interval(days => $6), 1, '{}', $4)`, [agent_id, org, display_name, owner, digest, expiresDays])
  for (const capability of grants) await grant(env, { org, agent_id, capability, owner, spendPerDay })
  if (bind) await env.owner.query('select workforce.employee_bind_principal($1, $2, $3, $4, $5::interval, $6::timestamptz)', [org, employee_id, agent_id, owner, linkWindow, bindingValidUntil])
  return { token, agent_id, employee_id }
}
export async function grant(env, { org = ORG, agent_id, capability, owner = OWNER, spendPerDay = 1, expiresIn = '30 days', perHour = 200, perDay = 2000 }) {
  const r = await env.owner.query(`insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, granted_by, expires_at)
                                   values ($1, $2, $3, 1, '{}', '{}', $6, $7, $4, $5, now() + $8::interval) returning grant_id`, [org, agent_id, capability, spendPerDay, owner, perHour, perDay, expiresIn])
  return r.rows[0].grant_id
}

/** The gateway exactly as the Action MCP wires it, over a pool running AS lc_action_gateway in tenant `org`. */
export function wfGateway(env, { org = ORG, serviceEnv = ON, worker = 'wfa-gw', now } = {}) {
  const pool = env.track(new pg.Pool({ connectionString: env.url, max: 6, types, options: `-c role=lc_action_gateway -c request.jwt.claim.lc_org=${org}` }))
  const db = pgSupabase(pool)
  const store = createPostgrestActionStore({ db })
  const gateway = createActionGateway({ store, reads: createGatewayReads({ db }), services: createGatewayServices({ db, store, env: serviceEnv }), pepper: PEPPER, dataOrgId: org, worker, leaseSeconds: 30, ...(now ? { now } : {}) })
  return { gateway, store, pool, db }
}

/** One agent session: call(tool, args) with THIS agent's credential (the MCP connection's). */
export function agentSession(gw, token) {
  let n = 0
  return {
    call: (tool, args = {}) => gw.gateway.call({ credential: token, tool, args, transport: 'test' }),
    id: (p = 'k') => `${p}-${Date.now().toString(36)}-${(n += 1)}`,
  }
}

/** A mission (active) with one assignment per spec, written through the Workforce store (as the COO would). */
export async function missionWith(env, specs = [], { title = 'Agntei test mission', directive = 'Research the evidence for the top opportunities', key = crypto.randomUUID() } = {}) {
  const { mission } = await env.store.openMission({ org_id: ORG, title, directive, requested_by: OWNER, owner_employee_id: 'emp_coo', idempotency_key: key })
  await env.store.transitionMission({ org_id: ORG, mission_id: mission.mission_id, to: 'active' })
  const out = {}
  for (const s of specs) {
    const { assignment } = await env.store.createAssignment({ org_id: ORG, mission_id: mission.mission_id, step_key: s.step, capability_key: s.capability || 'research.property', assignee_employee_id: s.assignee,
      delegated_by_employee_id: 'emp_coo', depends_on: s.depends_on || [], input: s.input || {}, resource_type: s.resource_type ?? null, resource_key: s.resource_key ?? null, max_attempts: s.max_attempts ?? 3 })
    out[s.step] = assignment
  }
  return { mission, a: out }
}

/** Arm the runtime for these kinds (the R2 worker side, owner path) and complete a job through the REAL runtime functions. */
export async function armRuntime(env, kinds = ['property.research']) {
  await env.owner.query('update agent.runtime_limits set runtime_enabled = true, emergency_stop = false, emergency_stop_at = null, emergency_stop_reason = null, kind_limits = $1::jsonb where id = 1',
    [JSON.stringify(Object.fromEntries(kinds.map((k) => [k, { enabled: true, max_concurrency: 2, armed_by: OWNER }])))])
  await env.owner.query('update agent.research_limits set enabled = true where id = 1').catch(() => {})
}
export async function completeJob(env, job_id, result = { summary_present: true }, outcome = 'completed') {
  const claimed = (await env.api.query("select agent.runtime_claim('wfa-worker', 5) r")).rows[0].r.claimed || []
  const c = claimed.find((x) => x.job_id === job_id)
  if (!c) throw new Error(`job ${job_id} was not claimable (${JSON.stringify(claimed.map((x) => x.job_id))})`)
  for (const o of claimed.filter((x) => x.job_id !== job_id)) await env.api.query("select agent.runtime_finish($1, $2::uuid, 'cancelled', null, null)", [o.job_id, o.lease_token]).catch(() => {})
  const st = (await env.api.query('select agent.runtime_start($1, $2::uuid) r', [job_id, c.lease_token])).rows[0].r
  if (!st?.ok) throw new Error(`start refused: ${JSON.stringify(st)}`)
  const r = (await env.api.query('select agent.runtime_finish($1, $2::uuid, $3, $4::jsonb, $5::jsonb) r', [job_id, c.lease_token, outcome, JSON.stringify(result), outcome === 'completed' ? null : JSON.stringify({ code: 'TEST_FAILURE' })])).rows[0].r
  if (!r?.ok) throw new Error(`finish refused: ${JSON.stringify(r)}`)
  return r
}
export const jobsOf = async (env, kind = 'property.research') => (await env.owner.query('select job_id, state, idempotency_key, input from agent.research_job where kind = $1 order by created_at', [kind])).rows

/** The in-process engine's dispatch pass + the services the composition root binds (holds through the hold authority). */
export async function dispatchPass(env, { now = () => Date.now(), maxPerPass = 10 } = {}) {
  const { runDispatchPass } = await import('../../src/lib/workforce/engine/dispatch.js')
  const sb = pgSupabase(env.owner)
  const reads = { getJob: async (id) => (await env.owner.query('select job_id, state, result, last_error from agent.research_job where job_id = $1', [id])).rows[0] || null, jobSpend: async () => ({ committed_usd: 0 }) }
  const services = { checkHold: (scope) => checkAutomationHold({ ...scope, capability: 'ai_action' }, { supabase: sb }), researchEnabled: () => true }
  const ctx = { job: { job_id: `mjob_${crypto.randomUUID()}`, requested_by: OWNER }, step: async () => {}, remainingMs: () => 60_000, signal: null }
  return runDispatchPass({ store: env.store, runtimeStore: env.runtime, reads, services, env: ON, now, org_id: ORG, ctx, maxPerPass })
}

export const sel = async (pool, sql, params = []) => (await pool.query(sql, params)).rows
export const auditOf = (env, agent_id) => sel(env.owner, 'select event_type, action, code, detail from action_gateway.action_audit_events where agent_id = $1 order by event_id', [agent_id])
export { fs }
