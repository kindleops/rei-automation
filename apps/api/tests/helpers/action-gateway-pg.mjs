// Disposable-PostgreSQL world for the Action Gateway proofs (owner directive 2026-10-19).
// AGENT_PG_TEST_DB_URL must name a LOCAL scratch server (agent-pg-harness refuses anything else).
//
// Each gatewayDb() is a brand-new database with the REAL prerequisite migrations (R2 runtime, capability
// approvals, conversation-AI shadow, persistent missions, operations + #24, the P0 hold registry), the
// read-inventory baseline and the PROPOSED gateway migration (link #26). Then three connections:
//   owner   postgres            seeds the world (principals, grants, controls) like an org owner would
//   gw      AS lc_action_gateway with the tenant claim request.jwt.claim.lc_org — exactly what PostgREST
//           does with the owner-minted role JWT; the gateway's ONLY data path (Supabase-shaped client)
//   api     agent_api           the operator approval decide path (capability plane, human identity)
// The provider is SIMULATED: no network call and no TextGrid credential read is possible (trapTransport).
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'

import { freshDb, runSqlFile, applyInTransaction, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { pgSupabase, isoPool } from './pg-supabase.mjs'
import { createActionGateway, createPostgrestActionStore, createGatewayReads, createGatewayServices, mintAgentCredential, agentActionApprovalCapability, createIntentApprovalReader } from '../../src/lib/domain/action-gateway/index.js'
import { createCapabilityRegistry } from '../../src/lib/agent/capabilities/registry.js'
import { createCapabilityApprovals } from '../../src/lib/agent/capabilities/approvals.js'
import { createPgCapabilityStore } from '../../src/lib/agent/capabilities/stores.js'

export const MIG = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
export const FIX = (f) => path.join(REPO_DIR, 'scripts/db/fixtures', f)
export const GATEWAY_MIGRATION = MIG('PROPOSED_20261019160000_action_gateway.sql')
export const GATEWAY_BASELINE = path.join(REPO_DIR, 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_baseline.sql')

export const ORG = '00000000-0000-4000-8000-0000000000c1'
export const ORG_B = '00000000-0000-4000-8000-0000000000c2'
export const OWNER = '2b3ee0ff-0000-4000-8000-0000000000c1'
export const OPERATOR = '2b3ee0ff-0000-4000-8000-0000000000c2'
export const OWNER_B = '2b3ee0ff-0000-4000-8000-0000000000d1'
export const PEPPER = 'action-gateway-test-pepper-0123456789abcdef-not-a-secret'
export const SELLER = '+13125550161'
export const SELLER_2 = '+13125550162'
export const OURS = '+13125550199'

const TS = new Set([1184, 1114])
const types = { getTypeParser: (oid, format) => (TS.has(oid) ? (v) => (v == null ? v : String(v).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')) : pg.types.getTypeParser(oid, format)) }

/** A pool that runs every statement AS lc_action_gateway in tenant `org` (PostgREST: SET ROLE + JWT claims). */
export function gatewayPool(url, org = ORG, max = 6) {
  const p = new pg.Pool({ connectionString: url, max, types, options: `-c role=lc_action_gateway -c request.jwt.claim.lc_org=${org}` })
  p.on('error', () => {})
  return p
}

const RUNTIME_PUBLIC_FIXTURE = `create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  create table if not exists public.send_queue (id bigserial primary key, queue_status text, scheduled_for timestamptz);
  revoke all on public.system_control, public.send_queue from agent_api;`

// the extra public read surface the canonical conversation loaders select (prod-shaped subset)
const CONVERSATION_FIXTURE = `
  alter table public.message_events add column if not exists detected_intent text, add column if not exists language text, add column if not exists is_opt_out boolean,
    add column if not exists event_timestamp timestamptz, add column if not exists received_at timestamptz;
  alter table public.send_queue add column if not exists use_case_template text, add column if not exists agent_name text, add column if not exists scheduled_for_utc timestamptz,
    add column if not exists from_phone_number text, add column if not exists sent_at timestamptz;
  create table if not exists public.deal_thread_state (thread_key text primary key, universal_status text, inbox_bucket text, universal_stage text, opt_out boolean);`

// Roles are CLUSTER-global and the setup creates them (the shim's anon / authenticated / service_role /
// authenticator, S3's agent_api, link #26's lc_action_gateway), each guarded by "if not exists" — which RACES when
// test files run in parallel against one cluster (two CREATE ROLE of the same name: pg_authid_rolname_index). Every
// database bootstrap therefore runs under ONE advisory lock taken in the ADMIN database (advisory locks are scoped to
// a database, so all test processes must lock in the same one). Idempotent and race-safe; alone it costs nothing.
const BOOTSTRAP_LOCK = 0x4c43_4147 // 'LCAG'
async function underBootstrapLock(fn) {
  const admin = new pg.Client({ connectionString: process.env.AGENT_PG_TEST_DB_URL })
  await admin.connect()
  try {
    await admin.query('select pg_advisory_lock($1)', [BOOTSTRAP_LOCK])
    return await fn()
  } finally {
    await admin.query('select pg_advisory_unlock($1)', [BOOTSTRAP_LOCK]).catch(() => {})
    await admin.end().catch(() => {})
  }
}

export async function gatewayDb(opts = {}) {
  return underBootstrapLock(() => bootstrapGatewayDb(opts))
}

async function bootstrapGatewayDb(opts) {
  const db = await freshDb()
  try {
    return await bootstrapInto(db, opts)
  } catch (e) {
    // a failed bootstrap never leaks its database or its open connections into the rest of the run
    await db.drop().catch(() => {})
    throw e
  }
}

async function bootstrapInto(db, { apply = true } = {}) {
  const run = (f) => runSqlFile(db.pool, f)
  const tx = (f) => applyInTransaction(db.pool, f)
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
  await run(GATEWAY_BASELINE)
  await db.pool.query(CONVERSATION_FIXTURE)
  if (apply) await tx(GATEWAY_MIGRATION)
  const owner = db.trackPool(isoPool(db.url, 6))
  return { db, owner, url: db.url }
}

export const sel = async (pool, sql, params = []) => (await pool.query(sql, params)).rows

/**
 * PHONE-PRECISE detector for test assertions (no false positives on ids). Removes what is provably not a phone first
 * (UUIDs, 32+ char hex hashes, ISO timestamps, pid_ codes), then matches NANP numbers (area code and exchange 2-9,
 * optional +1 / 1, separators space . - ( )) and E.164 (+ and 8-15 digits), each bounded by NON-alphanumerics, so a
 * digit run inside a longer token never counts and every real number shape does. Returns the first match or null.
 */
export const NANP_OR_E164 = /(?<![0-9A-Za-z])(?:(?:\+?1[\s.-]?)?\(?[2-9][0-9]{2}\)?[\s.-]?[2-9][0-9]{2}[\s.-]?[0-9]{4}|\+[1-9][0-9]{7,14})(?![0-9A-Za-z])/
export function findPhoneLike(text) {
  const t = String(text ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{32,128}\b/gi, '<hash>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\bpid_[g-p]+\b/g, '<pid>')
  return t.match(NANP_OR_E164)?.[0] ?? null
}

export async function setControls(pool, values) {
  for (const [k, v] of Object.entries(values)) {
    if (v == null) await pool.query('delete from public.system_control where key = $1', [k])
    else await pool.query('insert into public.system_control (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, String(v)])
  }
}

/** The org, its humans, the controls ON for T1+T2, the AI reply policy's shadow gate open (drafts). */
export async function seedWorld(owner, { tiers = 'T1,T2' } = {}) {
  await owner.query(`insert into agent.org (org_id, name) values ($1, 'gateway test org'), ($2, 'other tenant') on conflict do nothing`, [ORG, ORG_B])
  await owner.query(`insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'owner', 'test'), ($1, $3, 'operator', 'test'), ($4, $5, 'owner', 'test') on conflict do nothing`, [ORG, OWNER, OPERATOR, ORG_B, OWNER_B])
  await setControls(owner, { action_gateway_enabled: 'true', action_gateway_tiers: tiers })
  await owner.query(`update public.conversation_ai_reply_policy set shadow_enabled = true, kill_switch_engaged = false where id = 1`)
}

/** Register an agent (owner path) and grant capabilities; returns its credential (shown once). */
export async function registerAgent(owner, { agent_id = 'agt_alpha', org = ORG, sponsor = OPERATOR, created_by = OWNER, tier_ceiling = 2, read_scopes = [], grants = [], expiresDays = 30 } = {}) {
  const { token, digest } = mintAgentCredential(PEPPER)
  await owner.query(`insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, read_scopes, created_by)
                     values ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7, $8::text[], $9)`, [agent_id, org, `Agent ${agent_id}`, sponsor, digest, expiresDays, tier_ceiling, read_scopes, created_by])
  for (const g of grants) {
    const [capability, tier, o] = Array.isArray(g) ? g : [g, 1, {}]
    await grantStanding(owner, { org, agent_id, capability, tier, ...(o || {}) })
  }
  return token
}

/** An owner-approved STANDING GRANT (bounded: scope, caps, spend, envelope, validity). Returns its grant_id. */
export async function grantStanding(owner, { org = ORG, agent_id = 'agt_alpha', capability, tier = 1, scope = {}, envelope = {}, perHour = 60, perDay = 500, spendPerDay = 5,
  failuresPerHour = 5, capHitsPerHour = 5, validFrom = null, expiresIn = '30 days', version = 1, supersedes = null } = {}) {
  const r = await owner.query(`insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day,
                                 max_failures_per_hour, max_cap_hits_per_hour, granted_by, valid_from, expires_at, grant_version, supersedes_grant_id)
                               values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, coalesce($13::timestamptz, now()), coalesce($13::timestamptz, now()) + $14::interval, $15, $16) returning grant_id`,
  [org, agent_id, capability, tier, JSON.stringify(scope), JSON.stringify(envelope), perHour, perDay, spendPerDay, failuresPerHour, capHitsPerHour, org === ORG ? OWNER : OWNER_B, validFrom, expiresIn, version, supersedes])
  return r.rows[0].grant_id
}

/** A thread (inbox_thread_state.id is the agent-facing reference), its property, an inbound. */
export async function seedThread(owner, { phone = SELLER, property = 'p100', inboundBody = 'Yes I still own it, what would you offer?', minutesAgo = 3, id = crypto.randomUUID() } = {}) {
  await owner.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address) values ($1, 'SFR', 'Chicago', 'IL', '60601', '12 Oak St') on conflict do nothing`, [property])
  await owner.query(`insert into public.inbox_thread_state (id, thread_key, canonical_e164, property_id, our_number) values ($1, $2, $2, $3, $4)`, [id, phone, property, OURS])
  const out = crypto.randomUUID()
  const inb = crypto.randomUUID()
  await owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
                     values ($1, $3, 'outbound', $5::text, $6::text, $5::text, 'Hi, this is Helen. Do you still own the house on Oak St?', now() - interval '2 hours', now() - interval '2 hours', $7, 'en'),
                            ($2, $4, 'inbound', $5::text, $5::text, $6::text, $8, now() - make_interval(mins => $9::int), now() - make_interval(mins => $9::int), $7, 'en')`,
  [out, inb, `SMo${id.slice(0, 8)}`, `SMi${id.slice(0, 8)}`, phone, OURS, property, inboundBody, minutesAgo])
  await owner.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, use_case_template, agent_name, created_at, sent_at, metadata)
                     values ($1, 'sent', 'Hi, this is Helen. Do you still own the house on Oak St?', $2::text, $3::text, $2::text, 'ownership_check', 'Helen', now() - interval '2 hours', now() - interval '2 hours', '{}'::jsonb)`, [`seed-${id}`, phone, OURS])
  return { thread_id: id, phone, property, inbound_id: inb, inbound_sid: `SMi${id.slice(0, 8)}` }
}

/** The gateway, wired exactly as the Action MCP server wires it, over a pool running as lc_action_gateway. */
export function makeGateway(env, { org = ORG, provider = null, draft = null, worker = 'gw-test', leaseSeconds = 30, sleep, maxBusyRetries, now, onAudit, serviceEnv = {}, approvalDecideTtlMs, approvalGrantTtlMs, wrapStore = null, wrapServices = null } = {}) {
  const pool = env.db.trackPool(gatewayPool(env.url, org))
  const db = pgSupabase(pool)
  const base = createPostgrestActionStore({ db })
  const store = wrapStore ? wrapStore(base) : base
  const reads = createGatewayReads({ db })
  const realServices = createGatewayServices({ db, store, env: { AI_CONVERSATION_SHADOW_ENABLED: 'true', ...(provider ? { AI_CONVERSATION_DRAFT_MODEL_ENABLED: 'true' } : {}), ...serviceEnv }, provider, draft })
  const services = wrapServices ? wrapServices(realServices) : realServices
  const gateway = createActionGateway({ store, reads, services, pepper: PEPPER, dataOrgId: org, worker, leaseSeconds, ...(sleep ? { sleep } : {}), ...(maxBusyRetries != null ? { maxBusyRetries } : {}), ...(now ? { now } : {}), ...(onAudit ? { onAudit } : {}),
    ...(approvalDecideTtlMs ? { approvalDecideTtlMs } : {}), ...(approvalGrantTtlMs ? { approvalGrantTtlMs } : {}) })
  return { gateway, store, reads, services, pool, db }
}

/** The EXISTING operator approval path (capability approvals decide) for gateway intents, as agent_api. */
export function humanApprovals(env) {
  const registry = createCapabilityRegistry()
  registry.register(agentActionApprovalCapability)
  registry.seal()
  const store = createPgCapabilityStore({ pool: env.db.api })
  const reader = createIntentApprovalReader({ query: async (sql, params) => (await env.db.api.query(sql, params)).rows })
  const approvals = createCapabilityApprovals({ store, registry, services: { actionGateway: reader } })
  return {
    approvals,
    async decide(approval_id, { by = OWNER, decision = 'approve', payload_hash = null } = {}) {
      const a = await store.getApproval(ORG, approval_id)
      return approvals.decide({ org_id: ORG, identity: { verified: true, named: true, user_id: by, method: 'test' }, approval_id, decision, payload_hash: payload_hash ?? a?.payload_hash })
    },
  }
}

export const audits = (owner, intentId) => sel(owner, `select event_type, code, agent_id from action_gateway.action_audit_events where intent_id = $1 order by event_id`, [intentId])
export const intentRow = async (owner, intentId) => (await sel(owner, `select * from action_gateway.action_intents where intent_id = $1`, [intentId]))[0]
export const outcomeRow = async (owner, intentId) => (await sel(owner, `select * from action_gateway.action_outcomes where intent_id = $1`, [intentId]))[0]

/** Any network call or TextGrid credential read fails the test (the simulated provider is the only one). */
export function trapTransport() {
  const real = globalThis.fetch
  const hits = []
  globalThis.fetch = async (u) => { hits.push(String(u)); throw new Error(`LIVE_TRANSPORT_TOUCHED ${String(u).slice(0, 40)}`) }
  const saved = {}
  for (const k of Object.keys(process.env)) if (/^(TEXTGRID_|TWILIO_)/.test(k)) { saved[k] = process.env[k]; delete process.env[k] }
  return { hits, restore() { globalThis.fetch = real; for (const [k, v] of Object.entries(saved)) process.env[k] = v } }
}
