/**
 * scoped-canary-case-j-proof.mjs
 *
 * Case J of the scoped-canary claim matrix:
 *   "a scoped_canary claim is DENIED whenever queue_execution_mode is anything
 *    other than 'scoped_canary_only', consuming no authorization and locking
 *    no row."
 *
 * WHY THIS IS NOT A NORMAL TEST
 *   Every other case (A-I, K-N) was proven against the real database inside a
 *   transaction ended by a terminal RAISE, so nothing persisted. J cannot be
 *   proven that way: it requires queue_execution_mode to hold a value OTHER
 *   than 'scoped_canary_only', and that key lives in public.system_control,
 *   which staging and production SHARE (one Supabase project, and the table has
 *   no environment column). Writing it -- even inside a transaction that rolls
 *   back -- would briefly move live containment. So J is proven in a throwaway
 *   Postgres instead.
 *
 * WHY THE RESULT IS STILL ABOUT PRODUCTION CODE
 *   The harness does not reimplement anything. It applies the real migrations
 *   and then REFUSES TO PROCEED unless md5(prosrc) of the claim function and of
 *   all five helpers it calls is identical to the recorded production hashes.
 *   If the function ever drifts, this script fails instead of quietly proving a
 *   property of a lookalike.
 *
 * RUNNING IT (intentionally not wired into CI: pglite is not a repo dependency)
 *   mkdir -p /tmp/pglite && cd /tmp/pglite && npm init -y && npm i @electric-sql/pglite
 *   PGLITE_PATH=/tmp/pglite/node_modules/@electric-sql/pglite \
 *     node apps/api/scripts/scoped-canary-case-j-proof.mjs
 */

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(__dirname, "..", "supabase", "migrations");

// Resolved explicitly rather than by bare specifier: pglite lives OUTSIDE this
// repo on purpose, and ESM import() ignores NODE_PATH.
let PGlite;
{
  const candidates = [];
  if (process.env.PGLITE_PATH) candidates.push(process.env.PGLITE_PATH);
  for (const dir of (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, "@electric-sql", "pglite"));
  }
  candidates.push("@electric-sql/pglite");

  for (const candidate of candidates) {
    try {
      const specifier = candidate.startsWith("@") ? candidate : pathToFileURL(path.join(candidate, "dist", "index.js")).href;
      ({ PGlite } = await import(specifier));
      break;
    } catch {
      /* try the next candidate */
    }
  }
  if (!PGlite) {
    console.error(
      "@electric-sql/pglite not found. Install it out-of-tree (see header), then set\n" +
        "  PGLITE_PATH=/tmp/pglite/node_modules/@electric-sql/pglite\n" +
        "It is deliberately NOT a repo dependency: this harness must never become a CI gate\n" +
        "that silently installs a database engine.",
    );
    process.exit(2);
  }
}

/**
 * Ordered because these migrations build on each other: the lockdown creates
 * the authorization/lock tables, containment defines the claim function and its
 * helpers, and the last three amend them.
 */
const MIGRATION_ORDER = [
  "20260625180000_queue_execution_mode_lockdown.sql",
  "20260625200000_queue_atomic_claim_containment.sql",
  "20260625203000_queue_verify_dispatch_token_cast.sql",
  "20260626210000_queue_processor_mode_on_alias.sql",
  "20260731231500_scoped_canary_authorization_atomic_consume.sql",
  "20260906120000_scoped_canary_null_campaign.sql",
  "20260906120100_scoped_canary_authorization_nullable_campaign.sql",
];

/**
 * md5(prosrc) as observed in production on 2026-09-06, AFTER both new
 * migrations were applied. Equality is the whole basis for trusting this
 * harness, so a mismatch is fatal rather than a warning.
 */
const PRODUCTION_PROSRC_MD5 = Object.freeze({
  queue_atomic_claim_send_row: "e98dd63b4a2ddb8e1be63b1a5406dcf8",
  queue_emergency_stop_active: "e575523b8966d9b7df19a30417915701",
  queue_execution_mode_normalized: "9ea3c7535a91f7d923e4317d4ad1c06e",
  queue_processor_mode_normalized: "2c2597a1f61704c6387e2e3ac4e46e0f",
  queue_system_control_text: "de18923849a8252ef1cc63702abd3fa4",
  queue_write_claim_audit: "9dc76330b1217f429f41eb9918e551ec",
});

/**
 * send_queue and system_control predate the migrations above, so the harness
 * has to supply them. send_queue is reproduced with production's full column
 * list because plpgsql resolves every column the body names when it first
 * compiles the function -- a trimmed table would fail at call time, not here.
 */
const SYSTEM_CONTROL_DDL = `
  CREATE TABLE public.system_control (
    key text PRIMARY KEY,
    value text,
    updated_at timestamptz DEFAULT now()
  );`;

const SEND_QUEUE_COLUMNS = [
  "id uuid", "queue_key text", "queue_status text", "scheduled_for timestamptz",
  "send_priority integer", "is_locked boolean", "locked_at timestamptz", "lock_token text",
  "retry_count integer", "max_retries integer", "next_retry_at timestamptz", "message_body text",
  "phone_number_id uuid", "to_phone_number varchar", "from_phone_number varchar", "metadata jsonb",
  "created_at timestamptz", "updated_at timestamptz", "property_address text", "queue_id text",
  "queue_sequence integer", "property_type text", "owner_type text", "scheduled_for_local timestamptz",
  "scheduled_for_utc timestamptz", "timezone text", "contact_window text", "sent_at timestamptz",
  "delivered_at timestamptz", "failed_reason text", "delivery_confirmed text", "master_owner_id text",
  "prospect_id text", "property_id text", "market_id text", "sms_agent_id text",
  "textgrid_number_id text", "template_id text", "touch_number integer", "dnc_check text",
  "current_stage text", "message_type text", "use_case_template text", "message_text text",
  "personalization_tags_used jsonb", "character_count integer", "provider_message_id text",
  "local_send_date date", "local_send_hour integer", "paused_reason text",
  "last_guard_checked_at timestamptz", "dedupe_key text", "seller_first_name text",
  "seller_display_name text", "thread_key text", "template_source text", "priority text",
  "risk text", "sms_eligible boolean", "routing_allowed boolean", "safety_status text",
  "type text", "detected_intent text", "stage_before text", "stage_after text",
  "textgrid_message_id text", "selected_template_id text", "market text", "textgrid_number text",
  "guard_status text", "guard_reason text", "selected_agent_id text", "risk_level text",
  "ai_confidence double precision", "estimated_cost double precision", "approved_at timestamptz",
  "held_at timestamptz", "language text", "owner_id text", "blocked_reason text",
  "blocked_reasons text", "source text", "property_address_state text", "routing_tier integer",
  "routing_reason text", "rendered_message text", "source_event_id text", "inbound_message_id text",
  "template_selected text", "property_address_city text", "property_address_zip text",
  "seller_status text", "pipeline_stage text", "agent_name text", "template_key text",
  "campaign_id uuid", "campaign_target_id uuid", "campaign_send_window_id uuid", "phone_id text",
  "logical_communication_id uuid",
];

async function boot() {
  const db = await PGlite.create();
  await db.exec(`
    DO $roles$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $roles$;
    ${SYSTEM_CONTROL_DDL}
    CREATE TABLE public.send_queue (${SEND_QUEUE_COLUMNS.join(", ")}, PRIMARY KEY (id));
  `);

  for (const file of MIGRATION_ORDER) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"));
  }
  return db;
}

async function assertFidelity(db) {
  const names = Object.keys(PRODUCTION_PROSRC_MD5);
  const { rows } = await db.query(
    `SELECT p.proname, md5(p.prosrc) AS m
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    [names],
  );
  const local = Object.fromEntries(rows.map((r) => [r.proname, r.m]));
  for (const name of names) {
    assert.equal(
      local[name],
      PRODUCTION_PROSRC_MD5[name],
      `FIDELITY FAILURE: ${name} differs from production. This harness proves ` +
        `nothing until the difference is understood.`,
    );
  }
  console.log(`fidelity: ${names.length}/${names.length} functions byte-identical to production`);
}

const RUN_ID = "canary-case-j";
const TOKEN_HASH = "case-j-token-hash";
const ROW_ID = "11111111-1111-4111-8111-111111111111";
const AUTH_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Rebuilt before every case so the cases cannot contaminate each other. Note
 * that the execution LOCK is set correctly for this canary run and the
 * authorization is valid, unexpired and allowlists the row: the execution mode
 * is the only thing that varies, so a denial can only be attributed to it.
 */
async function seed(db, mode) {
  await db.exec(`
    DELETE FROM public.queue_claim_audit;
    DELETE FROM public.queue_canary_authorizations;
    DELETE FROM public.send_queue;
    DELETE FROM public.queue_global_execution_lock;
    DELETE FROM public.system_control;
  `);
  // Held OFF for every case, including the control, so the scoped seam is never
  // riding on the global processor being enabled.
  await db.query(`INSERT INTO public.system_control(key, value) VALUES ('queue_processor_mode', 'off')`);
  if (mode !== null) {
    await db.query(`INSERT INTO public.system_control(key, value) VALUES ('queue_execution_mode', $1)`, [mode]);
  }
  await db.query(
    `INSERT INTO public.queue_global_execution_lock
       (id, owner_type, canary_run_id, lock_token, lock_owner, heartbeat_at, acquired_at)
     VALUES (1, 'scoped_canary', $1, gen_random_uuid(), 'case-j-proof', now(), now())`,
    [RUN_ID],
  );
  await db.query(
    `INSERT INTO public.send_queue
       (id, queue_status, campaign_id, is_locked, lock_token, to_phone_number, from_phone_number, message_body, metadata)
     VALUES ($1, 'queued', NULL, false, NULL, '+15550000001', '+15550000002', 'case-j body', '{}'::jsonb)`,
    [ROW_ID],
  );
  await db.query(
    `INSERT INTO public.queue_canary_authorizations
       (id, canary_run_id, campaign_id, queue_row_ids, authorization_token_hash,
        expires_at, created_at, metadata, claimed_row_ids)
     VALUES ($1, $2, NULL, $3::jsonb, $4, now() + interval '1 hour', now(), '{}'::jsonb, '[]'::jsonb)`,
    [AUTH_ID, RUN_ID, JSON.stringify([ROW_ID]), TOKEN_HASH],
  );
}

async function runCase(db, mode) {
  await seed(db, mode);
  const normalized = (await db.query(`SELECT public.queue_execution_mode_normalized() AS m`)).rows[0].m;
  const result = (
    await db.query(
      `SELECT public.queue_atomic_claim_send_row($1::uuid, 'scoped_canary', NULL::uuid, $2::text, $3::text, NULL::uuid) AS res`,
      [ROW_ID, RUN_ID, TOKEN_HASH],
    )
  ).rows[0].res;
  const auth = (await db.query(`SELECT consumed_at FROM public.queue_canary_authorizations WHERE id = $1`, [AUTH_ID])).rows[0];
  const row = (await db.query(`SELECT queue_status, is_locked, lock_token FROM public.send_queue WHERE id = $1`, [ROW_ID])).rows[0];
  return {
    normalized_mode: normalized,
    claimed: result.claimed,
    reason: result.reason,
    auth_consumed: auth.consumed_at !== null,
    row_locked: row.is_locked === true || row.lock_token !== null,
    row_status: row.queue_status,
  };
}

// 'live_limited' is included because it is a real mode this system uses, and
// an absent key is included because a missing control must not read as
// permission. Both are expected to normalize to 'stopped'.
const DENY_MODES = ["normal", "stopped", "paused", "live_limited", null];

const db = await boot();
try {
  await assertFidelity(db);

  const table = [];
  for (const mode of DENY_MODES) {
    const r = await runCase(db, mode);
    table.push({ case: `J mode=${mode === null ? "<absent>" : mode}`, ...r });
    assert.equal(r.claimed, false, `mode=${mode} must not claim`);
    assert.equal(r.reason, "queue_execution_mode_not_scoped_canary_only", `mode=${mode} wrong reason`);
    assert.equal(r.auth_consumed, false, `mode=${mode} must not consume the authorization`);
    assert.equal(r.row_locked, false, `mode=${mode} must not lock the row`);
    assert.equal(r.row_status, "queued", `mode=${mode} must leave the row queued`);
  }

  // Without this the whole matrix would also pass against a harness that can
  // never claim anything.
  const control = await runCase(db, "scoped_canary_only");
  table.push({ case: "CONTROL mode=scoped_canary_only", ...control });
  assert.equal(control.claimed, true, "control must claim, or the harness proves nothing");
  assert.equal(control.reason, "claimed");

  console.table(table);
  console.log("CASE J: PASS");
} finally {
  await db.close();
}
