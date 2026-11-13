// Disposable-PostgreSQL harness for the FOLLOW-UP LIFECYCLE proofs (owner P0 2026-10-17).
// AGENT_PG_TEST_DB_URL must name a LOCAL scratch server (agent-pg-harness refuses anything else).
// Each lifecycleDb() is a brand-new database with: the shim, the live send_queue baseline (its triggers),
// the operations + automation-holds public baselines, the P0 automation-hold registry migration, and the
// PROPOSED follow-up lifecycle migration — then a prod-shaped read surface for the send-time guard, the
// renderer and the dispatcher. The provider is SIMULATED: global fetch is trapped (any network call
// fails the test) and TextGrid credential variables are trapped (any read fails the test).
import path from 'node:path'
import crypto from 'node:crypto'

import { freshDb, runSqlFile, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { isoPool, pgSupabase } from './pg-supabase.mjs'
import { createFollowUpLifecycleDeps, withLifecycleHelpers, runFollowUpMaterialization } from '../../src/lib/domain/followups/followup-lifecycle.js'
import { resolveAutomationHold, HOLD_CAPABILITIES } from '../../src/lib/domain/holds/automation-hold.js'
import { normalizeSendQueueRow } from '../../src/lib/supabase/sms-engine.js'
import { processSendQueueItem } from '../../src/lib/domain/queue/process-send-queue.js'
import { loadSendTimeContactFacts, evaluateSendTimeContactGuard } from '../../src/lib/domain/queue/send-time-contact-guard.js'
import { createMemoryS11Store } from './s11-memory-store.mjs'

export const OURS = '+13125550199'
export const FALLBACK_SENDER = '+13125550188'
export const OP = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
const MIG = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
const FIX = (f) => path.join(REPO_DIR, 'scripts/db/fixtures', f)
export const LIFECYCLE_MIGRATION = MIG('PROPOSED_20261017120000_followup_intent_lifecycle.sql')

// the read surface the send-time guard, the nurture render context, the resolver and the dispatcher read
// (prod-shaped subset; send_queue / message_events / inbox_thread_state come from the baselines)
export const LIFECYCLE_PUBLIC_FIXTURE = `
  alter table public.message_events add column if not exists provider_message_sid text, add column if not exists from_phone_number text,
    add column if not exists to_phone_number text, add column if not exists property_id text, add column if not exists prospect_id text,
    add column if not exists failure_bucket text, add column if not exists master_owner_id text;
  alter table public.inbox_thread_state add column if not exists our_number text, add column if not exists lifecycle_stage text;
  create table if not exists public.sms_templates (id uuid primary key default gen_random_uuid(), template_id text, use_case text, language text, stage_code text, reply_mode text,
    property_type_scope text, allowed_property_groups text[], prohibited_property_groups text[], is_active boolean, safe_for_auto_reply boolean, template_body text,
    quarantine_state text default 'active', minimal_fallback boolean, fallback_rank integer);
  create table if not exists public.textgrid_numbers (id uuid primary key default gen_random_uuid());
  alter table public.textgrid_numbers add column if not exists phone_number text, add column if not exists status text, add column if not exists market text,
    add column if not exists health_state text, add column if not exists daily_limit integer default 800, add column if not exists messages_sent_today integer default 0,
    add column if not exists last_used_at timestamptz, add column if not exists updated_at timestamptz default now();
  create table if not exists public.contact_property_resolution (id uuid primary key default gen_random_uuid(), property_id text not null, contact_phone_e164 text not null,
    contact_property_role text, rejected_at timestamptz, rejection_reason text, suppression_scope text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    unique (property_id, contact_phone_e164));
  create table if not exists public.sms_suppression_list (id uuid primary key default gen_random_uuid());
  alter table public.sms_suppression_list add column if not exists reason text, add column if not exists suppression_reason text, add column if not exists phone_e164 text,
    add column if not exists phone_number text, add column if not exists sender_phone_e164 text, add column if not exists is_active boolean, add column if not exists suppression_type text;
  create table if not exists public.automation_suppressions (id uuid primary key default gen_random_uuid(), phone_e164 text, status text, suppression_type text, suppression_reason text, expires_at timestamptz);
  create table if not exists public.phones (phone_id text, canonical_e164 text, phone text, phone_raw text, phone_contact_status text, wrong_number_at timestamptz, primary_prospect_id text, canonical_prospect_id text, activity_status text);
  create table if not exists public.properties (property_id text primary key, property_type text, property_class text, units_count integer, property_address_city text, property_address_state text,
    property_address_zip text, property_address text, property_address_full text, owner_1_name text, owner_name text, timezone text, owner_address_state text);
  -- the owner's MAILING state (recipient evidence the lifecycle, the feeder and the runner read; prod:
  -- properties.owner_address_state). Seeded NULL (no mailing on file) so the property-only / unknown-zone
  -- cases stay what they say; a test sets it to exercise mailing evidence.
  alter table public.properties add column if not exists owner_address_state text;
  create table if not exists public.prospects (prospect_id text primary key, first_name text, full_name text, timezone text);
  create table if not exists public.v_template_performance (template_id text);`

export async function lifecycleDb({ applyLifecycle = true } = {}) {
  const db = await freshDb()
  await runSqlFile(db.pool, FIX('send_queue_live_baseline.sql'))
  await runSqlFile(db.pool, FIX('operations_public_baseline.sql'))
  await runSqlFile(db.pool, FIX('automation_holds_public_baseline.sql'))
  await db.pool.query(LIFECYCLE_PUBLIC_FIXTURE)
  await runSqlFile(db.pool, MIG('PROPOSED_20261016200000_automation_holds_registry.sql'))
  if (applyLifecycle) await runSqlFile(db.pool, LIFECYCLE_MIGRATION)
  const pool = db.trackPool(isoPool(db.url, 8))
  return { db, pool, sb: pgSupabase(pool) }
}

export const sel = async (pool, sql, params = []) => (await pool.query(sql, params)).rows

/**
 * The REAL §11 logical-communication ledger (apps/api/supabase/migrations 20260904090000 + 20260904190000:
 * seller_logical_communications, seller_communication_attempts, the get-or-create / allocate RPCs) on the
 * disposable DB, for tests that dispatch through createSellerCommunicationStore instead of the memory mirror.
 */
export async function applyS11Ledger(pool) {
  const S11 = (f) => path.join(REPO_DIR, 'apps/api/supabase/migrations', f)
  await pool.query('create table if not exists public.acquisition_opportunities (id uuid primary key default gen_random_uuid())')
  await runSqlFile(pool, S11('20260904090000_seller_logical_communications_and_attempts.sql'))
  await runSqlFile(pool, S11('20260904190000_send_queue_logical_binding_and_operator_actions.sql'))
}

/**
 * The REAL queue global execution lock (apps/api/supabase/migrations 20260625180000: the singleton lock
 * table + queue_acquire / queue_release_global_execution_lock) and the REAL atomic row claim
 * (20260625200000 + 20260731231500), so a test can drive the WHOLE runner (runSendQueue fails closed
 * with lock_function_unavailable / atomic_claim_function_unavailable without them). The migration seeds
 * queue_execution_mode 'stopped' when absent; the test world runs 'normal'.
 */
export async function applyQueueExecutionLock(pool) {
  const Q = (f) => path.join(REPO_DIR, 'apps/api/supabase/migrations', f)
  await runSqlFile(pool, Q('20260625180000_queue_execution_mode_lockdown.sql'))
  // the REAL atomic row claim (queue_atomic_claim_send_row), latest definition last
  await runSqlFile(pool, Q('20260625200000_queue_atomic_claim_containment.sql'))
  await runSqlFile(pool, Q('20260625203000_queue_verify_dispatch_token_cast.sql'))
  await runSqlFile(pool, Q('20260731231500_scoped_canary_authorization_atomic_consume.sql'))
  await pool.query(`insert into public.system_control (key, value) values ('queue_execution_mode', 'normal') on conflict (key) do update set value = excluded.value`)
}

export async function setSwitches(pool, values = {}) {
  for (const [k, v] of Object.entries(values)) {
    if (v == null) await pool.query('delete from public.system_control where key = $1', [k])
    else await pool.query('insert into public.system_control (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, v])
  }
}

/** The world: live switches, an approved nurture template family, a healthy sender, a placed property. */
export async function seedWorld(pool, { mode = 'live', templates = true, propertyGeo = true } = {}) {
  await setSwitches(pool, { followup_execution_mode: mode, queue_processor_mode: 'live', followup_automation_mode: 'full_live' })
  if (templates) {
    await pool.query(`insert into public.sms_templates (template_id, use_case, language, is_active, safe_for_auto_reply, template_body) values
      ('t-csfu-en-1', 'consider_selling_follow_up', 'English', true, true, 'Hi {{seller_first_name}}, {{agent_name}} here again. Any change of plans on {{property_address}}?'),
      ('t-notready-en-1', 'not_ready', 'English', true, true, 'Hi {{seller_first_name}}, checking back on {{property_address}}. Is selling something you would consider now?'),
      ('t-own-en-1', 'ownership_check', 'English', true, true, 'Hi {{seller_first_name}}, {{agent_name}} here. Do you still own {{property_address}}?')`)
  }
  await pool.query(`insert into public.textgrid_numbers (phone_number, status, market, health_state) values ($1, 'active', 'Chicago', 'healthy'), ($2, 'active', 'Chicago', 'healthy')`, [OURS, FALLBACK_SENDER])
  await pool.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address, owner_1_name, owner_address_state)
                    values ('p1', 'SFR', 'Chicago', 'IL', '60601', '12 Oak St', 'Dana Q', null), ('p-nogeo', 'SFR', null, null, null, '9 Elm St', 'Dana Q', null),
                           ('251027062', 'SFR', 'Philadelphia', 'PA', '19104', '3746 Baltimore Ave', 'M Owner', null) on conflict do nothing`)
  await pool.query(`insert into public.prospects (prospect_id, first_name, full_name) values ('pr1', 'Dana', 'Dana Q') on conflict do nothing`)
  void propertyGeo
}

/** One conversation: our question, the seller's "not interested" reply, a delivered prior row (name + persona source). */
export async function seedThread(pool, { phone, property = 'p1', inboundBody = 'Not interested right now', inboundMinutesAgo = 60 * 24, disposition = 'not_interested' } = {}) {
  const sid = crypto.randomUUID()
  const inboundId = crypto.randomUUID()
  await pool.query(`insert into public.inbox_thread_state (thread_key, canonical_e164, property_id, master_owner_id, prospect_id, disposition, stage, lifecycle_stage, last_inbound_at, our_number)
                    values ($1::text, $1::text, $2, 'm1', 'pr1', $3, 'offer_interest', 'offer_interest', now() - make_interval(mins => $4::int), $5)
                    on conflict (thread_key) do update set property_id = excluded.property_id, last_inbound_at = excluded.last_inbound_at`, [phone, property, disposition, inboundMinutesAgo, OURS])
  await pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
                    values ($1, $2, 'outbound', $3::text, $4::text, $3::text, 'Hi Dana, this is Helen. Would you consider an offer on 12 Oak St?', now() - make_interval(mins => $6::int + 60), now() - make_interval(mins => $6::int + 60), $5, 'en'),
                           ($7, $8, 'inbound', $3::text, $3::text, $4::text, $9::text, now() - make_interval(mins => $6::int), now() - make_interval(mins => $6::int), $5, 'en')`,
  [crypto.randomUUID(), `SMo${sid.slice(0, 8)}`, phone, OURS, property, inboundMinutesAgo, inboundId, `SMi${sid.slice(0, 8)}`, inboundBody])
  await pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, use_case_template, agent_name, seller_first_name,
                      property_id, property_address, created_at, sent_at, delivered_at, type, metadata)
                    values ($1, 'delivered', 'Hi Dana, this is Helen. Would you consider an offer on 12 Oak St?', $2::text, $3::text, $2::text, 'consider_selling', 'Helen', 'Dana', $4, '12 Oak St',
                      now() - interval '40 days', now() - interval '40 days', now() - interval '40 days', 'outbound', '{}'::jsonb)`, [`seed:${sid}`, phone, OURS, property])
  return { inboundId }
}

/** The REAL writer in lifecycle mode (seller-followup-scheduler.scheduleFollowUp), due pinned to `dueAt`. */
export async function planNurture(sb, phone, { dueAt = new Date(Date.now() - 60_000).toISOString(), inboundId = null, property = 'p1', intent = 'not_interested', extra = {} } = {}) {
  const { scheduleFollowUp } = await import('../../src/lib/domain/seller-flow/seller-followup-scheduler.js')
  return scheduleFollowUp(intent, phone, { source: 'seller_inbound_orchestrator', inbound_message_event_id: inboundId, master_owner_id: 'm1', property_id: property, prospect_id: 'pr1', scheduled_for_at: dueAt, skip_email_lane: true, ...extra }, sb)
}

/** The REAL automation-hold registry (automation_hold_for over the disposable DB), both capabilities. */
export function registryHoldCheck(sb) {
  return async (scope) => {
    for (const capability of [HOLD_CAPABILITIES.FOLLOW_UP, HOLD_CAPABILITIES.OUTBOUND_SEND]) {
      const r = await resolveAutomationHold(scope, { capability, supabase: sb })
      if (r?.held !== false) return { held: true, fail_closed: r?.fail_closed === true, hold_type: r?.fail_closed ? 'lookup_error' : (r?.holds?.[0]?.hold_type || 'hold'), reason: r?.reason || null, hold_ids: r?.hold_ids || [] }
    }
    return { held: false }
  }
}

/**
 * The wall clock, or — when Chicago is outside 09:00–19:00 local — the next 12:00 Chicago. Materialization
 * and dispatch take this as their clock so a scenario never depends on the hour the suite runs (the DB's
 * own now() still drives due / lease / lead times, which only move forward).
 */
export function lawfulNowIso(real = Date.now()) {
  const hourIn = (ms) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)))
  if (hourIn(real) >= 9 && hourIn(real) < 19) return new Date(real).toISOString()
  let t = real
  for (let i = 0; i < 48 && hourIn(t) !== 12; i += 1) t += 3_600_000
  return new Date(t).toISOString()
}
const CLOCK = lawfulNowIso()

export async function materializerDeps(env, overrides = {}) {
  const base = createFollowUpLifecycleDeps({ supabase: env.sb, holdCheck: registryHoldCheck(env.sb), now: () => CLOCK, ...overrides })
  return withLifecycleHelpers({ ...base, ...overrides })
}
export async function materialize(env, overrides = {}) {
  return runFollowUpMaterialization(await materializerDeps(env, overrides))
}

/** Network + credential traps: the provider is simulated; touching a real transport fails the test. */
export function trapTransport() {
  const real = globalThis.fetch
  const hits = []
  globalThis.fetch = async (u) => { hits.push(String(u)); throw new Error(`LIVE_TRANSPORT_TOUCHED ${String(u).slice(0, 40)}`) }
  const CRED = /^(TEXTGRID_|TWILIO_)/
  const saved = {}
  for (const k of Object.keys(process.env)) if (CRED.test(k)) { saved[k] = process.env[k]; delete process.env[k] }
  const realEnv = process.env
  const credReads = []
  process.env = new Proxy(realEnv, { get(t, k) { if (typeof k === 'string' && CRED.test(k) && /(SID|TOKEN|SECRET|KEY|PASSWORD|AUTH)/.test(k)) credReads.push(k); return t[k] } })
  return {
    hits, credReads,
    restore() { globalThis.fetch = real; process.env = realEnv; for (const [k, v] of Object.entries(saved)) process.env[k] = v },
  }
}

/** A simulated TextGrid: accepts (default), or per-call behaviour. Never a network call. */
export function simProvider(script = []) {
  const sent = []
  let n = 0
  const send = async (msg) => {
    const step = script[n++] || 'accept'
    sent.push({ ...msg, step })
    if (step === 'accept') return { ok: true, sid: `SMsim${sent.length}`, provider_message_id: `SMsim${sent.length}`, status: 'queued' }
    if (step === 'timeout') { const e = new Error('ETIMEDOUT provider timeout'); e.code = 'ETIMEDOUT'; throw e }
    if (step === 'transport_500') return { ok: false, status: 503, error: 'service_unavailable', retryable: true, reason: 'provider_5xx' }
    // the connection was refused before any request bytes existed: provably not transmitted
    if (step === 'connect_refused') { const e = new Error('connect ECONNREFUSED 127.0.0.1:443'); e.code = 'ECONNREFUSED'; e.network_phase = 'connect'; e.may_have_transmitted = false; throw e }
    throw new Error(`unknown sim step ${step}`)
  }
  return { send, sent, accepted: () => sent.filter((s) => s.step === 'accept').length }
}

/** The atomic claim (CAS on status + lock), as the queue runner's claim does. */
export async function claimRow(pool, id, token = crypto.randomUUID()) {
  const r = await pool.query(`update public.send_queue set queue_status = 'processing', is_locked = true, locked_at = now(), lock_token = $2, updated_at = now()
                               where id = $1 and queue_status in ('queued','pending','approved','ready','scheduled') and coalesce(is_locked, false) = false returning *`, [id, token])
  return r.rows[0] ? { row: r.rows[0], token } : null
}

/** The REAL queue runner item path over the disposable DB, a simulated provider, persisted updates. */
export async function dispatchRow(env, claimed, { provider, now = CLOCK, store = createMemoryS11Store(), extraDeps = {} } = {}) {
  return processSendQueueItem(normalizeSendQueueRow({ ...claimed.row }), { ...itemDeps(env, { provider, now, store }), claimedLockToken: claimed.token, ...extraDeps })
}

/**
 * The item-path deps (disposable DB, simulated provider, persisted updates) — shared by dispatchRow (one
 * pre-claimed row) and by tests that drive the WHOLE runner (runSendQueue: materialization → loader →
 * preclaim → claim → item path), which passes these deps through to processSendQueueItem.
 */
export function itemDeps(env, { provider, now = CLOCK, store = createMemoryS11Store() } = {}) {
  const { pool, sb } = env
  const persist = async (id, payload, lock = null) => {
    const cols = Object.keys(payload)
    const types = new Map((await pool.query(`select column_name, udt_name from information_schema.columns where table_schema = 'public' and table_name = 'send_queue'`)).rows.map((r) => [r.column_name, r.udt_name]))
    const keep = cols.filter((c) => types.has(c))
    if (!keep.length) return null
    const vals = keep.map((c) => (types.get(c) === 'jsonb' && payload[c] != null ? JSON.stringify(payload[c]) : payload[c]))
    const sql = `update public.send_queue set ${keep.map((c, i) => `"${c}" = $${i + 2}`).join(', ')} where id = $1${lock ? ` and lock_token = $${keep.length + 2}` : ''} returning *`
    const r = await pool.query(sql, lock ? [id, ...vals, lock] : [id, ...vals])
    return r.rows[0] || null
  }
  return {
    now, supabase: sb,
    getSystemValue: async (k) => (await sel(pool, 'select value from public.system_control where key = $1', [k]))[0]?.value ?? (k === 'queue_execution_mode' ? 'normal' : null),
    readAiConversationSwitch: async () => null,
    loadOutboundNumberByPhone: async (p) => {
      const r = (await sel(pool, 'select * from public.textgrid_numbers where phone_number = $1', [p]))[0]
      return r ? { id: r.id, phone_number: r.phone_number, status: r.status, health_state: r.health_state, daily_limit: r.daily_limit, messages_sent_today: r.messages_sent_today } : null
    },
    loadCampaignStatus: async () => 'active',
    updateQueueRow: async (id, payload) => ({ ok: true, id, payload, row: await persist(id, payload) }),
    updateSendQueueRowWithLock: async (id, lock, payload) => { const r = await persist(id, payload, lock); return r ? normalizeSendQueueRow(r) : null },
    sendTextgridSMS: provider.send,
    // the REAL send-time contact guard over the disposable DB, its hold fact from the REAL registry
    runSendTimeContactGuard: async (row) => {
      const hc = registryHoldCheck(sb)
      const facts = await loadSendTimeContactFacts(sb, row, { automationHoldChecker: async (a) => { const r = await hc({ thread_key: a.threadKey, property_id: a.propertyId, master_owner_id: a.masterOwnerId }); return { held: r.held === true, hold_type: r.held ? r.hold_type : null, reason: r.reason || null, hold_id: r.hold_ids?.[0] || null } } })
      return evaluateSendTimeContactGuard(row, facts)
    },
    followUpHoldCheck: registryHoldCheck(sb),
    verifyDispatchAuthorization: async () => ({ ok: true, reason: 'dispatch_authorized', claim_mode: 'lifecycle_claim_stand_in' }),
    store,
    info: () => {}, warn: () => {},
  }
}

export const intentsOf = (pool, phone) => sel(pool, `select * from public.followup_intents where thread_key = $1 order by created_at`, [phone])
export const rowsOf = (pool, phone) => sel(pool, `select * from public.send_queue where thread_key = $1 and type = 'followup' order by created_at`, [phone])
export const eventsOf = (pool, intentId) => sel(pool, `select from_state, to_state, reason, actor from public.followup_intent_events where intent_id = $1 order by id`, [intentId])
export const followUpAt = async (pool, phone) => (await sel(pool, 'select follow_up_at from public.inbox_thread_state where thread_key = $1', [phone]))[0]?.follow_up_at ?? null
/** No claimable row may ever have an empty body (any writer, any path). */
export const claimableEmptyBodies = (pool) => sel(pool, `select id, queue_status from public.send_queue where queue_status in ('queued','pending','approved','ready','scheduled') and btrim(coalesce(message_body, '')) = ''`)
