#!/usr/bin/env node
/**
 * email-migration-proof.mjs
 *
 * Applies the real §11 and EMAIL-1 migrations to a throwaway Postgres cluster
 * and interrogates the resulting schema.
 *
 * WHY THIS EXISTS.
 *   email-channel-migration-contract.test.mjs passed while the EMAIL-1 migration
 *   was still incomplete. Executing it is what found that three pre-existing
 *   partial unique indexes on seller_logical_communications are channel-blind,
 *   so adding channel to the logical key alone moved the cross-channel collision
 *   from the hash to the index rather than removing it.
 *
 *   A static contract proves a migration SAYS something. Only execution proves
 *   the database DOES it.
 *
 * SKIPS, RATHER THAN FAILS, WITHOUT A LOCAL POSTGRES. Reporting a red proof on a
 * machine that simply has no server installed would train everyone to ignore it.
 * The skip is loud and names what it could not check.
 *
 * RUNS AS ROOT, because CI containers do, and initdb refuses to. When uid is 0
 * this drops to an unprivileged account for every postgres command. Skipping
 * under root instead would mean the proof never runs in exactly the environment
 * that most needs it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");
const FIXTURES = path.resolve(__dirname, "email");
const PORT = process.env.EMAIL_PROOF_PG_PORT || "55433";

function findPgBin() {
  const explicit = process.env.PG_BIN_DIR;
  if (explicit && fs.existsSync(path.join(explicit, "initdb"))) return explicit;
  const roots = ["/usr/lib/postgresql", "/usr/local/pgsql"];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const versions = fs.readdirSync(root).sort().reverse();
    for (const version of versions) {
      const bin = path.join(root, version, "bin");
      if (fs.existsSync(path.join(bin, "initdb"))) return bin;
    }
  }
  return null;
}

function skip(reason) {
  console.log(`SKIP email-migration-proof: ${reason}`);
  console.log("  Not checked: that the EMAIL-1 migration applies, is idempotent,");
  console.log("  and that an SMS touch and an email touch on the same campaign");
  console.log("  target can coexist.");
  process.exit(0);
}

const PG_BIN = findPgBin();
if (!PG_BIN) skip("no local PostgreSQL installation found (set PG_BIN_DIR to override)");

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const PROOF_USER = process.env.EMAIL_PROOF_PG_USER || "pgproof";

/** initdb refuses to run as root, so borrow an unprivileged account when we are. */
function ensureUnprivilegedUser() {
  if (!IS_ROOT) return null;
  const exists = spawnSync("id", ["-u", PROOF_USER], { encoding: "utf8" }).status === 0;
  if (!exists) {
    const created = spawnSync("useradd", ["-m", PROOF_USER], { encoding: "utf8" });
    if (created.status !== 0) return null;
  }
  return PROOF_USER;
}

const RUN_AS = ensureUnprivilegedUser();
if (IS_ROOT && !RUN_AS) skip("running as root and could not create an unprivileged account for postgres");

// Under root the data and socket directories must belong to the account that
// will run the server, so they live in that account's home rather than in a
// tmpdir the agent may own.
const BASE_DIR = RUN_AS ? `/home/${RUN_AS}` : os.tmpdir();
const DATA_DIR = path.join(BASE_DIR, `email-proof-pg-${process.pid}`);
const SOCKET_DIR = path.join(BASE_DIR, `email-proof-sock-${process.pid}`);
fs.mkdirSync(SOCKET_DIR, { recursive: true });
if (RUN_AS) {
  spawnSync("chown", ["-R", RUN_AS, SOCKET_DIR], { encoding: "utf8" });
  spawnSync("chown", [RUN_AS, BASE_DIR], { encoding: "utf8" });
}
let started = false;

/** Shell-quote for the `su -c` hop. Paths and SQL both pass through here. */
function shq(value) {
  // POSIX single-quote escaping: close the quote, emit a literal quote, reopen.
  // Getting this wrong silently strips the quotes from the SQL passed through
  // `su -c`, which then fails as a syntax error rather than as a bad result.
  return "'" + String(value).split("'").join("'\\''") + "'";
}

/**
 * Every child gets a hard timeout and an explicitly supplied stdin. A proof that
 * can hang is worse than one that fails, because a hang is what makes people
 * stop running it.
 */
const CHILD_TIMEOUT_MS = Number(process.env.EMAIL_PROOF_TIMEOUT_MS || 60_000);

function runTool(tool, args, { discardOutput = false, ...opts } = {}) {
  const binary = path.join(PG_BIN, tool);
  const settings = { encoding: "utf8", timeout: CHILD_TIMEOUT_MS, input: "", ...opts };

  // pg_ctl start leaves a DAEMON holding whatever stdout/stderr it inherited, so
  // a piped spawnSync waits for EOF on those pipes long after pg_ctl itself has
  // exited. Detaching the server's output is the difference between this script
  // finishing and this script hanging forever.
  if (!RUN_AS) {
    return spawnSync(binary, args, discardOutput ? { ...settings, stdio: "ignore" } : settings);
  }
  const command = [binary, ...args].map(shq).join(" ")
    + (discardOutput ? " </dev/null >/dev/null 2>&1" : "");
  return spawnSync("su", ["-s", "/bin/sh", RUN_AS, "-c", command], settings);
}

const pg = (tool, args, opts = {}) => {
  const result = runTool(tool, args, opts);
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${tool} timed out after ${CHILD_TIMEOUT_MS}ms`);
  }
  if (result.status !== 0) {
    throw new Error(`${tool} failed: ${(result.stderr || result.stdout || "").split("\n").filter(Boolean).slice(-2).join(" ")}`);
  }
  return result.stdout;
};

const psql = (args) =>
  runTool("psql", ["-h", SOCKET_DIR, "-p", PORT, "-U", "postgres", ...args]);

function stop() {
  if (started) {
    try { runTool("pg_ctl", ["-D", DATA_DIR, "-m", "immediate", "stop"], { discardOutput: true }); } catch { /* already down */ }
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(SOCKET_DIR, { recursive: true, force: true });
}
process.on("exit", stop);

try {
  pg("initdb", ["-D", DATA_DIR, "-A", "trust", "-U", "postgres"], { discardOutput: true });
  pg("pg_ctl", [
    "-D", DATA_DIR,
    "-l", path.join(BASE_DIR, `email-proof-${process.pid}.log`),
    "-o", `-p ${PORT} -k ${SOCKET_DIR} -c listen_addresses=`,
    "-w", "start",
  ], { discardOutput: true });
  started = true;
} catch (error) {
  // A cluster we cannot start (running as root on some distros, a busy port) is
  // an environment limitation, not a failing migration.
  skip(`could not start a throwaway cluster: ${String(error.message).split("\n")[0]}`);
}

const failures = [];
const check = (label, condition, detail = "") => {
  if (condition) console.log(`  ok    ${label}`);
  else { console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); failures.push(label); }
};

/**
 * Pipe the file in on stdin rather than passing -f. Under `su` the repository may
 * not be readable by the unprivileged account, and a permission error would be
 * reported as a failing migration.
 */
const runFile = (db, file) =>
  runTool("psql", ["-h", SOCKET_DIR, "-p", PORT, "-U", "postgres", "-d", db, "-q", "-v", "ON_ERROR_STOP=1"],
    { input: fs.readFileSync(file, "utf8") });

const query = (db, sql) => psql(["-d", db, "-tAc", sql]).stdout.trim();

psql(["-c", "create database emailproof;"]);

console.log("email-migration-proof");

const prereq = runFile("emailproof", path.join(FIXTURES, "00-prereq-schema.sql"));
check("prerequisite schema applies", prereq.status === 0, prereq.stderr?.trim());

const s11 = runFile("emailproof", path.join(MIGRATIONS, "20260904090000_seller_logical_communications_and_attempts.sql"));
check("the §11 migration applies", s11.status === 0, s11.stderr?.trim());

const EMAIL1 = path.join(MIGRATIONS, "20260908120000_email_channel_canonical_domain.sql");
const first = runFile("emailproof", EMAIL1);
check("the EMAIL-1 migration applies", first.status === 0, first.stderr?.trim());

const second = runFile("emailproof", EMAIL1);
check("the EMAIL-1 migration is idempotent", second.status === 0, second.stderr?.trim());

// ── the provider event ledger ──────────────────────────────────────────────

const LEDGER = path.join(MIGRATIONS, "20260908150000_email_provider_event_ledger.sql");
const ledgerApply = runFile("emailproof", LEDGER);
check("the event-ledger migration applies", ledgerApply.status === 0, ledgerApply.stderr?.trim());
check("the event-ledger migration is idempotent", runFile("emailproof", LEDGER).status === 0);

check(
  "an event cannot claim a processing status the reconciler cannot produce",
  psql(["-d", "emailproof", "-tAc",
    "insert into public.email_events (event_key, direction, event_type, processing_status) " +
    "values ('k1','outbound','delivered','definitely_delivered')"]).status !== 0
);

check(
  "telemetry counters increment ATOMICALLY, in one statement",
  (() => {
    psql(["-d", "emailproof", "-tAc",
      "insert into public.email_queue (queue_key, queue_status, to_email, subject, email_body, provider_message_id) " +
      "values ('tq1','sent','a@b.com','s','b','<pm-1@brevo>')"]);
    for (let i = 0; i < 3; i += 1) {
      psql(["-d", "emailproof", "-tAc",
        "select public.email_queue_record_telemetry('<pm-1@brevo>','opened', now())"]);
    }
    return query("emailproof", "select open_count from public.email_queue where queue_key='tq1'") === "3";
  })()
);

check(
  "the telemetry function CANNOT touch delivery state",
  (() => {
    psql(["-d", "emailproof", "-tAc",
      "select public.email_queue_record_telemetry('<pm-1@brevo>','clicked', now())"]);
    const row = query("emailproof",
      "select coalesce(delivered_at_event::text,'null') || '/' || coalesce(provider_outcome,'null') " +
      "from public.email_queue where queue_key='tq1'");
    return row === "null/null";
  })(),
  "a telemetry write that could set delivered_at would let a scanner mark a message delivered"
);

check(
  "a non-telemetry event through the telemetry function changes nothing",
  query("emailproof",
    "select (public.email_queue_record_telemetry('<pm-1@brevo>','delivered', now()))->>'reason'")
    === "not_a_telemetry_event"
);

check(
  "an attempt can be resolved from a provider message id",
  /provider_message_id/.test(query("emailproof",
    "select indexdef from pg_indexes where indexname='seller_communication_attempts_provider_message_idx'"))
);

// ── channel is required, with no default to fall back on ───────────────────
check(
  "channel is NOT NULL with no default",
  query("emailproof",
    "select is_nullable || '/' || coalesce(column_default,'none') from information_schema.columns " +
    "where table_name='seller_logical_communications' and column_name='channel'") === "NO/none"
);

// ── THE finding: every anchor uniqueness index must carry channel ──────────
for (const index of [
  "uq_seller_logical_communications_decision_action",
  "uq_seller_logical_communications_campaign_touch",
  "uq_seller_logical_communications_offer_action",
]) {
  const def = query("emailproof", `select indexdef from pg_indexes where indexname='${index}'`);
  check(`${index} includes channel`, /\bchannel\b/.test(def), def || "index missing");
}

// ── the behaviour that matters most, end to end ────────────────────────────
const TARGET = "11111111-1111-4111-8111-111111111111";

// logical_key is constrained to ^lck_v[0-9]+:[a-z_]+:[0-9a-f]{64}$. A fixture
// using a non-hex filler character is rejected by that CHECK rather than by the
// thing under test, which reads as a failure of the migration. Assert the shape
// here so the fixtures cannot lie about what they are proving.
const keyOf = (filler) => {
  const hash = String(filler).repeat(64);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`fixture key filler is not hex: ${filler}`);
  return `lck_v2:campaign_touch:${hash}`;
};
const upsert = (key, lineage) =>
  query("emailproof",
    `select (public.seller_logical_communication_get_or_create(` +
    `'${keyOf(key)}','lck_v2','campaign_touch',` +
    `'${JSON.stringify(lineage)}'::jsonb))->>'ok'`);

check(
  "an SMS campaign touch is created",
  upsert("a", { channel: "sms", to_phone_number: "+13125550100", campaign_target_id: TARGET, touch_number: "3" }) === "true"
);
check(
  "the SAME campaign touch on EMAIL coexists with it",
  upsert("b", { channel: "email", to_email: "seller@example.com", campaign_target_id: TARGET, touch_number: "3" }) === "true",
  "this is the cross-channel collision; a failure here means it is back"
);
check(
  "both rows survive, one per channel",
  query("emailproof",
    `select string_agg(channel, ',' order by channel) from public.seller_logical_communications ` +
    `where campaign_target_id='${TARGET}'`) === "email,sms"
);

// ── refusals ───────────────────────────────────────────────────────────────
// ── EXPAND: an old SMS caller that names no channel still works ────────────
//
// This is the whole point of the expand step. A caller compiled before lck_v2
// cannot name a channel, and refusing it would break the live SMS seam for the
// duration of the deploy.
const oldCaller = query("emailproof",
  `select (public.seller_logical_communication_get_or_create(` +
  `'${keyOf("c")}','lck_v2','campaign_touch',` +
  `'{"to_phone_number":"+13125550111","campaign_target_id":"${TARGET}","touch_number":"9"}'::jsonb))->>'ok'`);
check("EXPAND: a pre-deploy caller with no channel is accepted", oldCaller === "true");

check(
  "EXPAND: the coercion is stamped, not silent",
  query("emailproof",
    `select channel || '/' || channel_source from public.seller_logical_communications ` +
    `where touch_number = 9`) === "sms/expand_default_sms",
  "an unstamped coercion is indistinguishable from a caller that said sms"
);

check(
  "EXPAND: a caller that DOES name its channel is stamped as the source",
  query("emailproof",
    `select distinct channel_source from public.seller_logical_communications ` +
    `where touch_number = 3`) === "caller"
);

check(
  "the same key with a different channel is an identity conflict",
  query("emailproof",
    `select (public.seller_logical_communication_get_or_create(` +
    `'${keyOf("a")}','lck_v2','campaign_touch',` +
    `'{"channel":"email","to_email":"x@y.com","campaign_target_id":"${TARGET}","touch_number":"3"}'::jsonb)` +
    `)->'conflicting_fields'`) === '["channel"]'
);

const bothRecipients = psql(["-d", "emailproof", "-tAc",
  `insert into public.seller_logical_communications ` +
  `(logical_key, logical_key_version, communication_type, channel, to_phone_number, to_email, campaign_target_id, touch_number) ` +
  `values ('${keyOf("d")}','lck_v2','campaign_touch','email','+13125550100','x@y.com','${TARGET}',5)`]);
check("a row cannot carry both a phone and an email recipient", bothRecipients.status !== 0);

// ── suppression and queue ──────────────────────────────────────────────────
const expiringUnsub = psql(["-d", "emailproof", "-tAc",
  "insert into public.email_suppression (email_address, reason, expires_at) values ('a@b.com','unsubscribed', now())"]);
check("only a soft bounce may carry an expiry", expiringUnsub.status !== 0);

psql(["-d", "emailproof", "-tAc",
  "insert into public.email_queue (queue_key, queue_status, to_email, subject, email_body, dedupe_key) values ('q1','queued','a@b.com','s','b','dk-1')"]);
const dupLive = psql(["-d", "emailproof", "-tAc",
  "insert into public.email_queue (queue_key, queue_status, to_email, subject, email_body, dedupe_key) values ('q2','queued','a@b.com','s','b','dk-1')"]);
check("two LIVE queue rows cannot share a dedupe key", dupLive.status !== 0);
const dupSent = psql(["-d", "emailproof", "-tAc",
  "insert into public.email_queue (queue_key, queue_status, to_email, subject, email_body, dedupe_key) values ('q3','sent','a@b.com','s','b','dk-1')"]);
check("a settled queue row may reuse a dedupe key", dupSent.status === 0, dupSent.stderr?.trim());

// ── the contact governor can finally be addressed by email ─────────────────
for (let i = 0; i < 2; i += 1) {
  psql(["-d", "emailproof", "-tAc",
    "insert into public.contact_outreach_state (podio_master_owner_id, to_email, channel, last_email_at, last_outbound_at) " +
    "values ('own-1','bob@example.com','email', now(), now()) " +
    "on conflict (podio_master_owner_id, to_email) do update set last_email_at = excluded.last_email_at"]);
}
check(
  "contact_outreach_state upserts by email into ONE row",
  query("emailproof", "select count(*) from public.contact_outreach_state where podio_master_owner_id='own-1'") === "1"
);

// ── CONTRACT: the guard refuses while the tolerance is still in use ────────
//
// The expand-default row written moments ago is inside any sane quiet window, so
// contracting NOW must be refused. A contract step that proceeds over its own
// guard would start refusing live sends from callers that are still deploying.
const CONTRACT = path.join(MIGRATIONS, "20260908140000_email_channel_contract_strict.sql");

const contractTooSoon = runFile("emailproof", CONTRACT);
check(
  "CONTRACT: refuses while a caller is still relying on the tolerance",
  contractTooSoon.status !== 0 && /refusing to contract/i.test(contractTooSoon.stderr || ""),
  (contractTooSoon.stderr || "").split("\n").find((line) => line.includes("ERROR")) || "no refusal"
);

check(
  "CONTRACT: the refusal left the expand RPC in place",
  query("emailproof",
    `select (public.seller_logical_communication_get_or_create(` +
    `'${keyOf("3")}','lck_v2','campaign_touch',` +
    `'{"to_phone_number":"+13125550112","campaign_target_id":"${TARGET}","touch_number":"11"}'::jsonb))->>'ok'`) === "true",
  "a failed contract must not half-apply"
);

// ── DEPLOY: every caller now names its channel. Age the evidence so the guard
// sees a quiet window, exactly as real elapsed time would.
psql(["-d", "emailproof", "-tAc",
  "update public.seller_logical_communications set created_at = now() - interval '4 hours' " +
  "where channel_source = 'expand_default_sms'"]);

const contracted = runFile("emailproof", CONTRACT);
check("CONTRACT: applies once the tolerance has gone quiet", contracted.status === 0,
  (contracted.stderr || "").split("\n").filter(Boolean).slice(-1)[0]);

check(
  "CONTRACT: a channel-less caller is now REFUSED, with a named reason",
  query("emailproof",
    `select (public.seller_logical_communication_get_or_create(` +
    `'${keyOf("1")}','lck_v2','campaign_touch',` +
    `'{"to_phone_number":"+13125550113","campaign_target_id":"${TARGET}","touch_number":"12"}'::jsonb))->>'reason'`)
    === "missing_communication_channel"
);

check(
  "CONTRACT: a caller that names its channel still works",
  query("emailproof",
    `select (public.seller_logical_communication_get_or_create(` +
    `'${keyOf("2")}','lck_v2','campaign_touch',` +
    `'{"channel":"email","to_email":"post@contract.com","campaign_target_id":"${TARGET}","touch_number":"13"}'::jsonb))->>'ok'`)
    === "true"
);

check(
  "CONTRACT: historical expand_default_sms rows stay valid, not invalidated",
  Number(query("emailproof",
    "select count(*) from public.seller_logical_communications where channel_source = 'expand_default_sms'")) > 0
);

check(
  "CONTRACT: is idempotent once the window is quiet",
  runFile("emailproof", CONTRACT).status === 0
);

// ── EMAIL-3: inbound replies and reply aliases ─────────────────────────────
//
// The same reason this file exists applies here. The EMAIL-1 static contract
// passed against a migration that had never run, and executing it is what found
// three channel-blind indexes nobody had noticed. Every claim below is one the
// SQL makes; only Postgres can say whether it is true.

const INBOUND = path.join(MIGRATIONS, "20260908160000_email_inbound_and_reply_aliases.sql");
const inbound_first = runFile("emailproof", INBOUND);
check("EMAIL-3: the inbound migration applies", inbound_first.status === 0, inbound_first.stderr?.trim());
check("EMAIL-3: the inbound migration is idempotent", runFile("emailproof", INBOUND).status === 0);

for (const table of [
  "email_reply_aliases", "email_inbound_events", "email_inbound_messages", "email_inbound_attachments",
]) {
  check(
    `EMAIL-3: ${table} exists`,
    query("emailproof", `select to_regclass('public.${table}') is not null`) === "t"
  );
  // Every one of these tables holds seller correspondence. RLS off would make it
  // readable by anon through PostgREST, which is the whole database's worth of
  // seller replies behind one publishable key.
  check(
    `EMAIL-3: ${table} has row level security enabled`,
    query("emailproof", `select relrowsecurity from pg_class where relname = '${table}'`) === "t"
  );
}

// ── ONE ACTIVE ALIAS PER CONVERSATION ──────────────────────────────────────
// This is the property that makes thread fragmentation impossible. It is
// enforced by a partial unique index, and a partial unique index is exactly the
// kind of thing that looks right in a diff and is wrong in the database.

const alias_opp = "11111111-1111-4111-8111-111111111111";
psql(["-d", "emailproof", "-c",
  `insert into public.email_reply_aliases (token, reply_domain, opportunity_id, master_owner_id, property_id)
   values ('r1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'reply.example.net', null, 'owner-p1', 'prop-p1');`]);

const second_active = psql(["-d", "emailproof", "-c",
  `insert into public.email_reply_aliases (token, reply_domain, master_owner_id, property_id)
   values ('r1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'reply.example.net', 'owner-p1', 'prop-p1');`]);
check(
  "EMAIL-3: a conversation cannot hold TWO active aliases",
  second_active.status !== 0,
  "a second active alias for the same owner and property was accepted"
);

psql(["-d", "emailproof", "-c",
  `update public.email_reply_aliases set is_active = false, revoked_at = now()
   where token = 'r1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';`]);
const after_revoke = psql(["-d", "emailproof", "-c",
  `insert into public.email_reply_aliases (token, reply_domain, master_owner_id, property_id)
   values ('r1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'reply.example.net', 'owner-p1', 'prop-p1');`]);
check(
  "EMAIL-3: a REVOKED alias frees the conversation for a new one",
  after_revoke.status === 0,
  after_revoke.stderr?.trim()
);

const duplicate_token = psql(["-d", "emailproof", "-c",
  `insert into public.email_reply_aliases (token, reply_domain, master_owner_id, property_id)
   values ('r1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'reply.example.net', 'owner-other', 'prop-other');`]);
check(
  "EMAIL-3: a token is unique across ALL conversations, active or not",
  duplicate_token.status !== 0,
  "two conversations were allowed to share a reply token"
);

const bad_token_shape = psql(["-d", "emailproof", "-c",
  `insert into public.email_reply_aliases (token, reply_domain, master_owner_id)
   values ('not-a-token', 'reply.example.net', 'owner-shape');`]);
check("EMAIL-3: a malformed token is refused by CHECK", bad_token_shape.status !== 0);

const anchorless = psql(["-d", "emailproof", "-c",
  `insert into public.email_reply_aliases (token, reply_domain, property_id)
   values ('r1.cccccccccccccccccccccccccccccccc', 'reply.example.net', 'prop-only');`]);
check(
  "EMAIL-3: an alias with no conversation anchor is refused",
  anchorless.status !== 0,
  "an alias that could never be resolved was accepted"
);

// ── THE RECEIPT LEDGER: idempotency is an index, not a read-then-write ─────

psql(["-d", "emailproof", "-c",
  `insert into public.email_inbound_events (event_key, provider, trust_class, received_at)
   values ('brevo_in:proof-1', 'brevo', 'authenticated_provider_callback', now());`]);
const replayed = psql(["-d", "emailproof", "-c",
  `insert into public.email_inbound_events (event_key, provider, trust_class, received_at)
   values ('brevo_in:proof-1', 'brevo', 'authenticated_provider_callback', now());`]);
check(
  "EMAIL-3: the SAME provider callback cannot be received twice",
  replayed.status !== 0,
  "a replayed callback would have created a second seller message"
);

const other_event = psql(["-d", "emailproof", "-c",
  `insert into public.email_inbound_events (event_key, provider, trust_class, received_at)
   values ('brevo_in:proof-2', 'brevo', 'authenticated_provider_callback', now());`]);
check("EMAIL-3: a DIFFERENT callback is still accepted", other_event.status === 0,
  other_event.stderr?.trim());

// ── ATTACHMENTS: one file per message, and never called clean by default ───

// The insert and the read are separate statements on purpose: psql prints the
// command tag alongside a RETURNING value, and gluing them together produced an
// id that looked valid and was not -- which then made the duplicate-attachment
// check pass for the wrong reason. A proof that passes for the wrong reason is
// worse than one that fails.
const message_insert = psql(["-d", "emailproof", "-c",
  `insert into public.email_inbound_messages (inbound_event_id, from_email, received_at, message_class)
   select id, 'seller@example.org', now(), 'human_reply'
   from public.email_inbound_events where event_key = 'brevo_in:proof-1';`]);
check("EMAIL-3: an inbound message can be recorded against its receipt",
  message_insert.status === 0, message_insert.stderr?.trim());

const message_id = query("emailproof",
  "select id from public.email_inbound_messages where from_email = 'seller@example.org' limit 1");
check("EMAIL-3: the recorded message has a readable id", /^[0-9a-f-]{36}$/.test(message_id), message_id);

const DIGEST = "a".repeat(64);
const attach = (digest) => psql(["-d", "emailproof", "-c",
  `insert into public.email_inbound_attachments
     (inbound_message_id, inbound_event_id, content_sha256, byte_size, content_type, filename)
   select '${message_id}', id, '${digest}', 1234, 'application/octet-stream', 'deed.pdf'
   from public.email_inbound_events where event_key = 'brevo_in:proof-1';`]);

const first_attach = attach(DIGEST);
check("EMAIL-3: an attachment can be recorded", first_attach.status === 0, first_attach.stderr?.trim());
check(
  "EMAIL-3: the same file on the same message is stored ONCE",
  attach(DIGEST).status !== 0,
  "re-delivery of a callback would have duplicated its files"
);
check("EMAIL-3: a different file on the same message is accepted", attach("b".repeat(64)).status === 0);

check(
  "EMAIL-3: an attachment defaults to unscanned, never to clean",
  query("emailproof",
    `select bool_and(scan_status = 'unscanned') from public.email_inbound_attachments`) === "t"
);
check(
  "EMAIL-3: an attachment defaults to pending storage, never to stored",
  query("emailproof",
    `select bool_and(storage_status = 'pending') from public.email_inbound_attachments`) === "t"
);

const bad_digest = psql(["-d", "emailproof", "-c",
  `insert into public.email_inbound_attachments
     (inbound_message_id, inbound_event_id, content_sha256, byte_size, content_type, filename)
   select '${message_id}', id, 'not-a-digest', 1, 'application/octet-stream', 'x.pdf'
   from public.email_inbound_events where event_key = 'brevo_in:proof-1';`]);
check("EMAIL-3: a malformed content digest is refused by CHECK", bad_digest.status !== 0);

const bad_scan = psql(["-d", "emailproof", "-c",
  `update public.email_inbound_attachments set scan_status = 'definitely_fine';`]);
check("EMAIL-3: an invented scan status is refused by CHECK", bad_scan.status !== 0);

// ── THE RECEIPT OUTLIVES WHAT IT PRODUCED ─────────────────────────────────
// A message may be deleted; the evidence that a callback arrived may not, or a
// replay would be re-ingested as new.

const drop_event = psql(["-d", "emailproof", "-c",
  `delete from public.email_inbound_events where event_key = 'brevo_in:proof-1';`]);
check(
  "EMAIL-3: a receipt with attachments cannot be deleted out from under them",
  drop_event.status !== 0,
  "deleting a receipt would let its callback be re-ingested as new"
);

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nPASS");
process.exit(failures.length ? 1 : 0);
