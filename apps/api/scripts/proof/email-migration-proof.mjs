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
const upsert = (key, lineage) =>
  query("emailproof",
    `select (public.seller_logical_communication_get_or_create(` +
    `'lck_v2:campaign_touch:${key.repeat(64)}','lck_v2','campaign_touch',` +
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
const noChannel = psql(["-d", "emailproof", "-tAc",
  `select public.seller_logical_communication_get_or_create(` +
  `'lck_v2:campaign_touch:${"c".repeat(64)}','lck_v2','campaign_touch',` +
  `'{"campaign_target_id":"${TARGET}","touch_number":"9"}'::jsonb)`]);
check(
  "a channel-less caller is refused, not defaulted to sms",
  noChannel.status !== 0 && /channel/.test(noChannel.stderr || ""),
  (noChannel.stderr || "").split("\n")[0]
);

check(
  "the same key with a different channel is an identity conflict",
  query("emailproof",
    `select (public.seller_logical_communication_get_or_create(` +
    `'lck_v2:campaign_touch:${"a".repeat(64)}','lck_v2','campaign_touch',` +
    `'{"channel":"email","to_email":"x@y.com","campaign_target_id":"${TARGET}","touch_number":"3"}'::jsonb)` +
    `)->'conflicting_fields'`) === '["channel"]'
);

const bothRecipients = psql(["-d", "emailproof", "-tAc",
  `insert into public.seller_logical_communications ` +
  `(logical_key, logical_key_version, communication_type, channel, to_phone_number, to_email, campaign_target_id, touch_number) ` +
  `values ('lck_v2:campaign_touch:${"d".repeat(64)}','lck_v2','campaign_touch','email','+13125550100','x@y.com','${TARGET}',5)`]);
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

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nPASS");
process.exit(failures.length ? 1 : 0);
