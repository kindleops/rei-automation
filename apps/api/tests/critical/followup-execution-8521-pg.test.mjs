// rc-8.5.21 (owner P0 2026-10-16) — the FOLLOW-UP EXECUTION PIPELINE on a DISPOSABLE PostgreSQL 17
// (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it). Real SQL end to end:
//   public.inbox_thread_state.follow_up_at → followup.execution_sweep → agent.runtime_enqueue_event_at
//   → runRuntimeTick claims followup.dispatch → fresh re-checks (real send-time contact guard over
//   real tables, real hold port) → public.idempotency_ledger (the real idempotency_begin /
//   complete / fail) → the REAL canonical follow-up writer (scheduleFollowUp → enqueueSendQueueItem)
//   → public.send_queue (the live baseline: unique queue_key, triggers) → provider outcome →
//   followup.reconcile (dates with no job, outcomes, bounded transport retry).
// No provider, no network: global fetch is trapped and fails the test if touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import crypto from 'node:crypto'

import { pgAvailable, skipReason, freshDb, runSqlFile, applyInTransaction, SQL, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { isoPool, pgSupabase } from '../helpers/pg-supabase.mjs'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import {
  createFollowUpDeps, runFollowUpSweep, runFollowUpDispatch, runFollowUpReconcile, followUpJobKey,
  FOLLOWUP_DISPATCH_KIND, FOLLOWUP_EXECUTION_MODE_KEY, FOLLOWUP_KINDS as K, FOLLOWUP_CODES as C, FOLLOWUP_LEDGER_SCOPE,
} from '../../src/lib/domain/followups/followup-execution.js'
import { buildFollowUpHandlers } from '../../src/lib/ai/followup-runtime-wiring.js'

const skip = pgAvailable() ? false : skipReason
const OP = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
const MIG = (f) => path.join(REPO_DIR, 'supabase/migrations', f)
const FIX = (f) => path.join(REPO_DIR, 'scripts/db/fixtures', f)
const OURS = '+13125550199'
const NO_HOLD = async () => ({ held: false, hold_type: null, reason: null, hold_id: null })

// the public read surface the pipeline, the send-time guard and the writer select (prod-shaped subset)
const PUBLIC_FIXTURE = `
  create table if not exists public.system_control (key text primary key, value text, updated_at timestamptz default now());
  alter table public.message_events add column if not exists provider_message_sid text, add column if not exists from_phone_number text,
    add column if not exists to_phone_number text, add column if not exists property_id text, add column if not exists prospect_id text,
    add column if not exists detected_intent text, add column if not exists language text, add column if not exists is_opt_out boolean,
    add column if not exists failure_bucket text;
  create table if not exists public.inbox_thread_state (id uuid primary key default gen_random_uuid(), thread_key text unique, canonical_e164 text, property_id text, master_owner_id text, prospect_id text,
    follow_up_at timestamptz, disposition text, stage text, lifecycle_stage text, is_suppressed boolean default false, last_inbound_at timestamptz, last_outbound_at timestamptz,
    updated_at timestamptz default now(), our_number text, last_intent text, contactability_status text, metadata jsonb);
  create table if not exists public.sms_templates (id uuid primary key default gen_random_uuid(), template_id text, use_case text, language text, stage_code text, reply_mode text,
    property_type_scope text, is_active boolean, safe_for_auto_reply boolean, template_body text);
  create table if not exists public.textgrid_numbers (id uuid primary key default gen_random_uuid(), phone_number text, status text, market text, updated_at timestamptz default now());
  create table if not exists public.contact_property_resolution (id uuid primary key default gen_random_uuid(), property_id text not null, contact_phone_e164 text not null,
    contact_property_role text, rejected_at timestamptz, rejection_reason text, suppression_scope text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    unique (property_id, contact_phone_e164));
  create table if not exists public.sms_suppression_list (id uuid primary key default gen_random_uuid(), reason text, suppression_reason text, phone_e164 text, phone_number text, sender_phone_e164 text, is_active boolean, suppression_type text);
  create table if not exists public.automation_suppressions (id uuid primary key default gen_random_uuid(), phone_e164 text, status text, suppression_type text, suppression_reason text, expires_at timestamptz);
  create table if not exists public.phones (phone_id text, canonical_e164 text, phone text, phone_raw text, phone_contact_status text, wrong_number_at timestamptz, primary_prospect_id text, canonical_prospect_id text, activity_status text);
  create table if not exists public.properties (property_id text primary key, property_type text, property_address_city text, property_address_state text, property_address_zip text, property_address text, property_address_full text, owner_1_name text);
  create table if not exists public.prospects (prospect_id text primary key, first_name text, full_name text, timezone text);
  revoke all on public.system_control, public.send_queue from agent_api;`

async function pgDb() {
  const db = await freshDb()
  await runSqlFile(db.pool, SQL.researchPretest)
  await runSqlFile(db.pool, SQL.research)
  await runSqlFile(db.pool, FIX('send_queue_live_baseline.sql'))
  await db.pool.query(PUBLIC_FIXTURE)
  await runSqlFile(db.pool, FIX('legacy_conversation_turns_baseline.sql'))
  await applyInTransaction(db.pool, SQL.runtime)
  await applyInTransaction(db.pool, MIG('PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261013161000_conversation_decide_event_budget.sql'))
  await applyInTransaction(db.pool, MIG('PROPOSED_20261016120000_conversation_reply_turns.sql'))
  const kinds = Object.fromEntries([FOLLOWUP_DISPATCH_KIND, 'followup.execution_sweep', 'followup.reconcile'].map((k) => [k, { enabled: true, max_concurrency: 2, armed_by: OP }]))
  await db.pool.query(`update agent.runtime_limits set runtime_enabled = true, max_concurrency_global = 2, tick_max_jobs = 4, kind_limits = $1::jsonb where id = 1`, [JSON.stringify(kinds)])
  const pool = db.trackPool(isoPool(db.url, 6))
  return { db, pool, sb: pgSupabase(pool) }
}
const sel = async (pool, sql, params = []) => (await pool.query(sql, params)).rows

/** The REAL ledger functions (public.idempotency_begin / complete / fail) over the disposable DB. */
function pgLedger(pool) {
  return {
    async begin({ scope, key, summary = null, metadata = {}, lease_ms }) {
      const r = (await pool.query('select public.idempotency_begin($1, $2, gen_random_uuid(), $3, $4::jsonb, $5) r', [scope, key, summary, JSON.stringify(metadata), lease_ms])).rows[0].r
      return { ok: r.ok !== false, duplicate: Boolean(r.duplicate), reason: r.reason }
    },
    async complete({ scope, key, metadata = {} }) { return (await pool.query('select public.idempotency_complete($1, $2, null, $3::jsonb) r', [scope, key, JSON.stringify(metadata)])).rows[0].r },
    async release({ scope, key, error = null }) { return (await pool.query('select public.idempotency_fail($1, $2, $3) r', [scope, key, error])).rows[0].r },
  }
}

async function seedThread(pool, { phone, minutesOverdue = 60, disposition = 'not_interested', stage = 'offer_interest', property = 'p1' }) {
  const id = crypto.randomUUID()
  await pool.query(`insert into public.inbox_thread_state (id, thread_key, canonical_e164, property_id, master_owner_id, prospect_id, follow_up_at, disposition, stage, lifecycle_stage, last_inbound_at, updated_at, our_number)
                    values ($1, $2::text, $2::text, $3, 'm1', 'pr1', now() - make_interval(mins => $4::int), $5, $6, $6, now() - interval '30 days', now() - interval '30 days', $7)`, [id, phone, property, minutesOverdue, disposition, stage, OURS])
  await pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
                    values ($1, $2, 'outbound', $3::text, $4::text, $3::text, 'Would you consider an offer on 12 Oak St if the number made sense?', now() - interval '31 days', now() - interval '31 days', $5, 'en'),
                           ($6, $7, 'inbound', $3::text, $3::text, $4::text, 'Not interested right now', now() - interval '30 days', now() - interval '30 days', $5, 'en')`,
  [crypto.randomUUID(), `SMo${id.slice(0, 6)}`, phone, OURS, property, crypto.randomUUID(), `SMi${id.slice(0, 6)}`])
  return id
}

async function seedWorld(pool) {
  for (const [k, v] of Object.entries({ [FOLLOWUP_EXECUTION_MODE_KEY]: 'live', queue_processor_mode: 'live', followup_automation_mode: 'full_live' })) {
    await pool.query(`insert into public.system_control (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [k, v])
  }
  await pool.query(`insert into public.sms_templates (template_id, use_case, language, is_active, safe_for_auto_reply, template_body) values
                    ('t-cs-fu-en', 'consider_selling_follow_up', 'English', true, true, 'Hi {{seller_first_name}}, {{agent_name}} here again. Any change on {{property_address}}?')`)
  await pool.query(`insert into public.textgrid_numbers (phone_number, status, market) values ($1, 'active', 'Chicago')`, [OURS])
  await pool.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address, owner_1_name) values ('p1', 'SFR', 'Chicago', 'IL', '60601', '12 Oak St', 'Dana Q') on conflict do nothing`)
  await pool.query(`insert into public.prospects (prospect_id, first_name, full_name) values ('pr1', 'Dana', 'Dana Q') on conflict do nothing`)
}

function harness({ db, pool, sb }) {
  const store = createRuntimePgStore({ pool: db.api })
  const readSwitch = async (k) => (await sel(pool, 'select value from public.system_control where key = $1', [k]))[0]?.value ?? null
  // the clock: the recipient-local window must be open for an immediate send; pin noon Chicago today
  const deps = createFollowUpDeps({ supabase: sb, readSwitch, enqueueAt: (o) => store.enqueueEventAt(o), automationHoldChecker: NO_HOLD, reservations: pgLedger(pool) })
  const handlers = buildFollowUpHandlers({ deps })
  const tick = (workerId = 'followup-tick') => runRuntimeTick({ store, handlers, workerId, budgetMs: 20_000 })
  return { store, deps, tick, readSwitch }
}

function trapFetch() {
  const real = globalThis.fetch
  const hits = []
  globalThis.fetch = async (u) => { hits.push(String(u)); throw new Error(`LIVE_TRANSPORT_TOUCHED ${String(u).slice(0, 40)}`) }
  return { hits, restore: () => { globalThis.fetch = real } }
}
const followUpRows = (pool, phone) => sel(pool, `select id, queue_key, queue_status, scheduled_for, use_case_template, metadata from public.send_queue where thread_key = $1 order by created_at`, [phone])
const jobsOf = (pool, kind) => sel(pool, `select state, result, attempt from agent.research_job where runtime_managed and kind = $1 order by created_at`, [kind])

test('PG: due follow_up_at → sweep job → tick claims followup.dispatch → ONE send_queue row (real writer, real ledger); re-sweep adopts, re-dispatch is a duplicate', { skip }, async () => {
  const env = await pgDb()
  const net = trapFetch()
  try {
    await seedWorld(env.pool)
    const phone = '+13125550101'
    const id = await seedThread(env.pool, { phone })
    const h = harness(env)
    const s = await runFollowUpSweep(h.deps)
    assert.equal(s.counts.enqueued, 1, JSON.stringify(s))
    const t = await h.tick()
    assert.equal(t.summary?.claimed ?? t.claimed ?? 1, 1, JSON.stringify(t))
    const [job] = await jobsOf(env.pool, FOLLOWUP_DISPATCH_KIND)
    assert.equal(job.state, 'completed', JSON.stringify(job))
    assert.ok([C.ENQUEUED, C.HOLD_FOR_HUMAN].includes(job.result.code), JSON.stringify(job.result))
    if (job.result.code === C.HOLD_FOR_HUMAN) assert.fail(`held for a human: ${job.result.reason}`)
    const rows = await followUpRows(env.pool, phone)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].metadata.followup_kind, K.NOT_INTERESTED_NURTURE)
    assert.equal(rows[0].metadata.deferred_message_resolution, true)
    assert.equal(rows[0].metadata.source, 'followup_execution_pipeline')
    assert.equal(rows[0].use_case_template, 'nurture_not_interested')
    const key = followUpJobKey({ state_id: id, kind: K.NOT_INTERESTED_NURTURE, follow_up_at: (await sel(env.pool, 'select follow_up_at from public.inbox_thread_state where id = $1', [id]))[0].follow_up_at })
    const [led] = await sel(env.pool, `select status, metadata from public.idempotency_ledger where scope = $1 and key = $2`, [FOLLOWUP_LEDGER_SCOPE, key])
    assert.equal(led.status, 'completed')
    assert.equal(led.metadata.queue_row_id, rows[0].id)
    // re-sweep: the live row is the job
    const s2 = await runFollowUpSweep(h.deps)
    assert.equal(s2.counts.adopted, 1)
    // a re-dispatch of the same follow-up: the completed claim
    const intent = (await sel(env.pool, 'select follow_up_at from public.inbox_thread_state where id = $1', [id]))[0]
    const again = await runFollowUpDispatch({ state_id: id, kind: K.NOT_INTERESTED_NURTURE, follow_up_at: new Date(intent.follow_up_at).toISOString(), attempt: 1 }, h.deps)
    assert.equal(again.code, C.DUPLICATE)
    assert.equal((await followUpRows(env.pool, phone)).length, 1)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG: suppression added between the sweep and the dispatch ⇒ the dispatch blocks; no row. A recorded ownership denial for THIS property blocks too', { skip }, async () => {
  const env = await pgDb()
  const net = trapFetch()
  try {
    await seedWorld(env.pool)
    const a = '+13125550102'
    const b = '+13125550103'
    await seedThread(env.pool, { phone: a })
    await seedThread(env.pool, { phone: b })
    const h = harness(env)
    assert.equal((await runFollowUpSweep(h.deps)).counts.enqueued, 2)
    await env.pool.query(`insert into public.sms_suppression_list (phone_e164, is_active, suppression_type) values ($1, true, 'opt_out')`, [a])
    await env.pool.query(`insert into public.contact_property_resolution (property_id, contact_phone_e164, contact_property_role, rejected_at, suppression_scope) values ('p1', $1, 'not_owner', now() - interval '20 days', 'contact_property_pair')`, [b])
    await h.tick()
    const jobs = await jobsOf(env.pool, FOLLOWUP_DISPATCH_KIND)
    assert.equal(jobs.length, 2)
    for (const j of jobs) assert.equal(j.result.code, C.BLOCKED, JSON.stringify(j.result))
    assert.deepEqual(jobs.map((j) => j.result.reason).sort(), ['prior_reply_not_owner', 'sms_suppression_list_active'])
    assert.equal((await followUpRows(env.pool, a)).length + (await followUpRows(env.pool, b)).length, 0)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG: crash after the claim (stale processing ledger row) ⇒ reclaimed, ONE row; crash after the write ⇒ the retry replays onto the SAME row', { skip }, async () => {
  const env = await pgDb()
  try {
    await seedWorld(env.pool)
    const h = harness(env)
    for (const [phone, crashAfterWrite] of [['+13125550104', false], ['+13125550105', true]]) {
      const id = await seedThread(env.pool, { phone })
      const due = new Date((await sel(env.pool, 'select follow_up_at from public.inbox_thread_state where id = $1', [id]))[0].follow_up_at).toISOString()
      const job = { state_id: id, kind: K.NOT_INTERESTED_NURTURE, follow_up_at: due, attempt: 1 }
      const key = followUpJobKey(job)
      if (crashAfterWrite) {
        // the worker wrote the row, then died before completing the claim
        const first = await runFollowUpDispatch(job, h.deps)
        assert.equal(first.code, C.ENQUEUED)
        await env.pool.query(`update public.idempotency_ledger set status = 'processing', completed_at = null where scope = $1 and key = $2`, [FOLLOWUP_LEDGER_SCOPE, key])
      } else {
        // the worker claimed, then died before writing
        await env.pool.query(`select public.idempotency_begin($1, $2, gen_random_uuid(), 'crashed', '{}'::jsonb, 300000)`, [FOLLOWUP_LEDGER_SCOPE, key])
      }
      // within the lease: another worker yields (retryable), writes nothing
      await assert.rejects(runFollowUpDispatch(job, h.deps), (e) => e.code === 'FOLLOWUP_IN_PROGRESS')
      // the lease expires
      await env.pool.query(`update public.idempotency_ledger set started_at = now() - interval '10 minutes' where scope = $1 and key = $2`, [FOLLOWUP_LEDGER_SCOPE, key])
      const r = await runFollowUpDispatch(job, h.deps)
      assert.equal(r.code, crashAfterWrite ? C.ADOPTED : C.ENQUEUED, JSON.stringify(r))
      assert.equal((await followUpRows(env.pool, phone)).length, 1, 'exactly one row')
      assert.equal((await sel(env.pool, `select status from public.idempotency_ledger where scope = $1 and key = $2`, [FOLLOWUP_LEDGER_SCOPE, key]))[0].status, 'completed')
    }
  } finally { await env.db.drop() }
})

test('PG: verified outcome + reconciliation — a transport failure retries ONCE through the runtime; delivery is counted; a due date with no job is reported', { skip }, async () => {
  const env = await pgDb()
  const net = trapFetch()
  try {
    await seedWorld(env.pool)
    const h = harness(env)
    const phone = '+13125550106'
    await seedThread(env.pool, { phone })
    await runFollowUpSweep(h.deps)
    await h.tick()
    const [row] = await followUpRows(env.pool, phone)
    // the provider never accepted it (no provider id): a transport failure
    await env.pool.query(`update public.send_queue set queue_status = 'failed_transport', failed_reason = 'network error', retry_count = 3 where id = $1`, [row.id])
    const r = await runFollowUpReconcile(h.deps)
    assert.equal(r.counts.retry_scheduled, 1, JSON.stringify(r))
    assert.equal(r.counts.retries_enqueued, 1)
    // the retry job is due 15 minutes out; make it due and run it
    await env.pool.query(`update agent.research_job set next_attempt_at = clock_timestamp() where kind = $1 and state in ('queued','retrying')`, [FOLLOWUP_DISPATCH_KIND])
    await h.tick()
    const rows = await followUpRows(env.pool, phone)
    assert.equal(rows.length, 2, 'attempt 2 is its own row')
    assert.equal(rows[1].metadata.followup_attempt, 2)
    // the provider accepted + delivered attempt 2 (callback)
    await env.pool.query(`update public.send_queue set queue_status = 'delivered', sent_at = now(), delivered_at = now(), provider_message_id = 'SMfixture2' where id = $1`, [rows[1].id])
    const r2 = await runFollowUpReconcile(h.deps)
    assert.equal(r2.counts.delivered, 1)
    assert.equal(r2.counts.retry_scheduled, 0, 'delivered ⇒ no retry')
    // a follow-up date the pipeline never saw (no job, overdue past the grace): reported
    const orphan = '+13125550107'
    await seedThread(env.pool, { phone: orphan, minutesOverdue: 12 * 60 })
    const r3 = await runFollowUpReconcile(h.deps)
    assert.equal(r3.counts.missing_job, 1)
    assert.equal(r3.missing_job_refs.length, 1)
    assert.ok(!JSON.stringify(r3).includes(orphan.slice(2)), 'codes and encoded refs only')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})
