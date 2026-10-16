/**
 * THE PRODUCTION CREDENTIAL LOADER (scripts/lib/prod-db-credentials.mjs, rc-8.5.21-c).
 *
 * Owner directive 2026-10-16: diagnostics use database-role-enforced read-only
 * credentials; BEGIN READ ONLY is not a substitute; writes need an explicit approval,
 * a dedicated URL file and an interactive confirmation; nothing is derived from
 * apps/api/.env*, SUPABASE_DB_URL, DATABASE_URL or /tmp/.dburl.
 *
 * DISPOSABLE DATABASE ONLY. The database half needs one of
 *   LC_PG_BIN=<dir with initdb/pg_ctl/postgres>   a fresh unix-socket-only cluster
 *   LC_MIGRATION_TEST_ADMIN_URL=<loopback url>      a CI service container
 * (the run-migration-test.mjs conventions; both go through assertDisposableTarget) and
 * is skipped otherwise. There is no production connection anywhere in this file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

import {
  READONLY_PURPOSES,
  readOnlyUrlFileEnv,
  loadReadOnly,
  PROD_WRITE_URL_FILE_ENV,
  READONLY_SENTINELS,
  CredentialRefusedError,
  readUrlFile,
  judgeReadOnly,
  connectReadOnlyDiagnostics,
  openReadOnlyPool,
  resolveReadOnlyUrl,
  parseProdWriteRef,
  resolveProdWriteUrl,
  connectProdWrite,
  psqlEnv,
  describeTarget,
} from "../../../../scripts/lib/prod-db-credentials.mjs";
import { readOnlyRestClient, REST_TYPES } from "../../../../scripts/lib/pg-readonly-rest.mjs";
import { assertDisposableTarget } from "../../../../scripts/db/db-target-guard.mjs";
import { startCluster } from "../../../../scripts/db/run-migration-test.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const LOADER = path.join(REPO, "scripts/lib/prod-db-credentials.mjs");
const RO_ENV = "LC_RO_OPS_DIAG_DB_URL_FILE";
const refused = (re) => (e) => e instanceof CredentialRefusedError && e.code === "LC_CREDENTIAL_REFUSED" && (!re || re.test(e.message));

// ── URL files (no database) ─────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-cred-test-"));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
function urlFile(name, content, mode = 0o600) {
  const f = path.join(tmpDir, name);
  fs.writeFileSync(f, content);
  fs.chmodSync(f, mode);
  return f;
}
const FAKE = "postgresql://lc_reader:s3cret@db.example.invalid:5432/postgres";

test("url file: one 0600 file with one postgres:// URL is accepted; the target is described without the password", () => {
  const f = urlFile("ok.url", `# diagnostics role\n${FAKE}\n`);
  const r = readUrlFile({ env: { [RO_ENV]: f }, envName: RO_ENV });
  assert.equal(r.url, FAKE);
  assert.equal(r.target, "lc_reader@db.example.invalid:5432/postgres");
  assert.doesNotMatch(r.target, /s3cret/);
  assert.equal(describeTarget("postgresql://u@/db?host=/tmp/sock&port=5432"), "u@/tmp/sock:5432/db");
});

test("url file: every unsafe source is refused before it is read", () => {
  const env = (v, extra = {}) => ({ [RO_ENV]: v, ...extra });
  const read = (e) => () => readUrlFile({ env: e, envName: RO_ENV });
  assert.throws(read({}), refused(/is not set/));
  assert.throws(read(env(FAKE)), refused(/FILE PATH, not an inline/));
  assert.throws(read(env("host=db user=x password=y")), refused(/FILE PATH/));
  assert.throws(read(env("relative/url.txt")), refused(/absolute path/));
  // /tmp/.dburl is refused by NAME (this test never opens it)
  assert.throws(read(env("/tmp/.dburl")), refused(/\/tmp\/\.dburl/));
  assert.throws(read(env("/private/tmp/.dburl")), refused(/\/tmp\/\.dburl/));
  // dotenv files, directly or through a symlink
  const envLocal = urlFile(".env.local", `${FAKE}\n`);
  assert.throws(read(env(envLocal)), refused(/dotenv file/));
  const link = path.join(tmpDir, "innocent.url");
  fs.symlinkSync(envLocal, link);
  assert.throws(read(env(link)), refused(/resolves to a dotenv file/));
  assert.throws(read(env(path.join(REPO, "apps/api/.env.local"))), refused(/dotenv file/));
  // permissions and shape
  assert.throws(read(env(urlFile("world.url", FAKE, 0o644))), refused(/mode 0644/));
  assert.throws(read(env(urlFile("group.url", FAKE, 0o640))), refused(/mode 0640/));
  assert.throws(read(env(urlFile("two.url", `${FAKE}\n${FAKE}\n`))), refused(/exactly one/));
  assert.throws(read(env(urlFile("conninfo.url", "host=x user=y"))), refused(/postgres:\/\//));
  assert.throws(read(env(path.join(tmpDir, "missing.url"))), refused(/not found/));
  assert.throws(read(env(tmpDir)), refused(/regular file/));
  // an inline URL variable is refused even when the file is fine
  assert.throws(read(env(urlFile("ok2.url", FAKE), { LC_RO_OPS_DIAG_DB_URL: FAKE })), refused(/never taken from the environment/));
});

test("url file: ambient DATABASE_URL / SUPABASE_DB_URL / service-role keys are never a fallback", () => {
  const ambient = { DATABASE_URL: FAKE, SUPABASE_DB_URL: FAKE, SUPABASE_URL_NO_POOL: FAKE, SUPABASE_SERVICE_ROLE_KEY: "svc", POSTGRES_URL: FAKE };
  assert.throws(() => readUrlFile({ env: ambient, envName: RO_ENV }), refused(/LC_RO_OPS_DIAG_DB_URL_FILE is not set/));
  assert.throws(() => readUrlFile({ env: ambient, envName: PROD_WRITE_URL_FILE_ENV }), refused(/LC_PROD_WRITE_DB_URL_FILE is not set/));
});

test("purposes: every read-only door needs a registered purpose; each purpose has its own credential file; BYPASSRLS is allowlisted nowhere yet", async () => {
  assert.deepEqual(Object.keys(READONLY_PURPOSES).sort(), ["entity_graph", "market_intel", "ops_diag", "research_agent", "seller_intel"]);
  for (const [k, v] of Object.entries(READONLY_PURPOSES)) {
    assert.equal(readOnlyUrlFileEnv(k), `LC_RO_${k.toUpperCase()}_DB_URL_FILE`);
    assert.equal(v.allowBypassRls, false, `${k}: no purpose is allowlisted for BYPASSRLS until the owner says so`);
    assert.ok(Object.isFrozen(v));
  }
  assert.ok(Object.isFrozen(READONLY_PURPOSES));
  assert.throws(() => readOnlyUrlFileEnv(), refused(/PURPOSE is required.*no default diagnostics role/));
  assert.throws(() => readOnlyUrlFileEnv("lc_readonly"), refused(/unknown read-only purpose/));
  assert.throws(() => readOnlyUrlFileEnv("__proto__"), refused(/unknown read-only purpose/));
  const f = urlFile("eg.url", FAKE);
  // a file configured for one purpose never satisfies another
  await assert.rejects(connectReadOnlyDiagnostics({ purpose: "ops_diag", env: { LC_RO_ENTITY_GRAPH_DB_URL_FILE: f }, pg }), refused(/LC_RO_OPS_DIAG_DB_URL_FILE is not set/));
  await assert.rejects(connectReadOnlyDiagnostics({ env: { [RO_ENV]: f }, pg }), refused(/PURPOSE is required/));
  await assert.rejects(loadReadOnly("nope", { env: { [RO_ENV]: f }, pg }), refused(/unknown read-only purpose/));
  await assert.rejects(openReadOnlyPool({ env: { [RO_ENV]: f }, pg }), refused(/PURPOSE is required/));
  await assert.rejects(resolveReadOnlyUrl({ purpose: "ops_diag", env: { [RO_ENV]: f, LC_RO_OPS_DIAG_DB_URL: FAKE }, pg }), refused(/never taken from the environment/));
  assert.throws(() => readOnlyRestClient({}), /purpose is required/);
});

test("loader source: it reads no dotenv file, no DB-URL / service-role env var and not /tmp/.dburl", () => {
  const src = fs.readFileSync(LOADER, "utf8");
  assert.doesNotMatch(src, /process\.env\.(DATABASE_URL|SUPABASE_DB_URL|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_URL_NO_POOL)\b/);
  assert.doesNotMatch(src, /process\.env\[['"](DATABASE_URL|SUPABASE_DB_URL|SUPABASE_SERVICE_ROLE_KEY)/);
  assert.doesNotMatch(src, /from ['"]dotenv['"]|require\(['"]dotenv['"]\)|loadEnvFile|--env-file/);
  assert.doesNotMatch(src, /readFileSync\(\s*['"]\/tmp\/\.dburl/);
  // the only env names it reads are its own two URL-file variables (+ CI / LC_PSQL)
  const reads = new Set([...src.matchAll(/(?<![.\w])env\.([A-Z_]+)|process\.env\.([A-Z_]+)|env\[([A-Z_]+)\]/g)].map((m) => m[1] || m[2] || m[3]));
  for (const k of reads) assert.ok(["CI", "LC_PSQL", "PROD_WRITE_URL_FILE_ENV"].includes(k), `unexpected env read ${k}`);
});

test("judgeReadOnly: superuser, BYPASSRLS, SET ROLE escalation, sentinel writes, missing sentinels and CREATE are all refusals", () => {
  const base = { current_user: "ro", roles: [{ role: "ro" }], sentinels: [{ table: "public.send_queue", required: true, present: true, writable_by: [] }], public_create_by: [] };
  assert.deepEqual(judgeReadOnly(base), { ok: true, role: "ro", reasons: [] });
  const bad = (patch) => judgeReadOnly({ ...base, ...patch });
  assert.match(bad({ roles: [{ role: "ro", super: true }] }).reasons[0], /superuser/);
  assert.match(bad({ roles: [{ role: "ro", bypassrls: true }] }).reasons[0], /BYPASSRLS/);
  assert.match(bad({ roles: [{ role: "ro" }, { role: "writer", bypassrls: true }] }).reasons[0], /via SET ROLE writer/);
  // a purpose allowlisted for BYPASSRLS tolerates it on the LOGIN role only
  const bypassSelf = { ...base, roles: [{ role: "ro", bypassrls: true }] };
  assert.match(judgeReadOnly(bypassSelf, { purpose: "ops_diag" }).reasons[0], /purpose ops_diag is not allowlisted for BYPASSRLS/);
  assert.equal(judgeReadOnly(bypassSelf, { allowBypassRls: true, purpose: "x" }).ok, true);
  assert.equal(judgeReadOnly({ ...base, roles: [{ role: "ro" }, { role: "other", bypassrls: true }] }, { allowBypassRls: true }).ok, false, "never via SET ROLE");
  assert.equal(judgeReadOnly({ ...bypassSelf, roles: [{ role: "ro", bypassrls: true, super: true }] }, { allowBypassRls: true }).ok, false, "superuser is never tolerated");
  assert.match(bad({ sentinels: [{ table: "public.send_queue", required: true, present: true, writable_by: ["ro"] }] }).reasons[0], /send_queue is writable/);
  assert.match(bad({ sentinels: [{ table: "public.sms_templates", required: true, present: false }] }).reasons[0], /missing/);
  assert.equal(bad({ sentinels: [{ table: "agent.runtime_limits", required: false, present: false }] }).ok, true);
  assert.match(bad({ public_create_by: ["ro"] }).reasons[0], /CREATE/);
  assert.deepEqual(READONLY_SENTINELS.map((s) => `${s.table}:${s.required}`), ["public.send_queue:true", "public.sms_templates:true", "public.system_control:true", "agent.runtime_limits:false"]);
});

// ── the write door (no database) ────────────────────────────────────────────

const tty = (answer, isTTY = true) => ({ isTTY, asked: [], question(p) { this.asked.push(p); return Promise.resolve(answer); } });

test("write door: --prod-write=<approval-ref> is mandatory and must be a real reference", () => {
  assert.throws(() => parseProdWriteRef([]), refused(/--prod-write=<approval-ref>/));
  assert.throws(() => parseProdWriteRef(["--apply"]), refused(/--prod-write=<approval-ref>/));
  for (const g of ["yes", "true", "1", "YES", "ok", ""]) assert.throws(() => parseProdWriteRef([`--prod-write=${g}`]), refused(/not an approval reference/), g);
  assert.throws(() => parseProdWriteRef(["--prod-write"]), refused(/not an approval reference/));
  assert.throws(() => parseProdWriteRef(["--prod-write=a b"]), refused());
  assert.equal(parseProdWriteRef(["--prod-write=owner-2026-10-16-persona"]), "owner-2026-10-16-persona");
  assert.equal(parseProdWriteRef(["--prod-write", "STATUS.md#8.5.21-c"]), "STATUS.md#8.5.21-c");
});

test("write door: refuses non-TTY, CI, a missing URL file and a wrong confirmation — and never falls back to ambient URLs", async () => {
  const f = urlFile("write.url", FAKE);
  const argv = ["--prod-write=owner-2026-10-16-test"];
  const env = { [PROD_WRITE_URL_FILE_ENV]: f };
  await assert.rejects(resolveProdWriteUrl({ argv, env, tty: tty("owner-2026-10-16-test", false) }), refused(/interactive terminal/));
  await assert.rejects(resolveProdWriteUrl({ argv, env, tty: null }), refused(/interactive terminal/));
  await assert.rejects(resolveProdWriteUrl({ argv, env: { ...env, CI: "true" }, tty: tty("owner-2026-10-16-test") }), refused(/under CI/));
  await assert.rejects(resolveProdWriteUrl({ argv, env: { DATABASE_URL: FAKE, SUPABASE_DB_URL: FAKE }, tty: tty("owner-2026-10-16-test") }), refused(/LC_PROD_WRITE_DB_URL_FILE is not set/));
  await assert.rejects(resolveProdWriteUrl({ argv, env: { [PROD_WRITE_URL_FILE_ENV]: "/tmp/.dburl" }, tty: tty("owner-2026-10-16-test") }), refused(/\/tmp\/\.dburl/));
  const wrong = tty("yes");
  await assert.rejects(resolveProdWriteUrl({ argv, env, tty: wrong }), refused(/did not match/));
  assert.match(wrong.asked[0], /PRODUCTION WRITE/);
  assert.doesNotMatch(wrong.asked[0], /s3cret/, "the prompt never shows the password");
  const ok = await resolveProdWriteUrl({ argv, env, tty: tty("owner-2026-10-16-test") });
  assert.deepEqual({ ref: ok.approvalRef, target: ok.target }, { ref: "owner-2026-10-16-test", target: "lc_reader@db.example.invalid:5432/postgres" });
});

test("write door: the CLI refuses a piped (non-TTY) psql-write before reading any URL file", () => {
  const r = spawnSync(process.execPath, [LOADER, "psql-write", "--prod-write=owner-2026-10-16-test", "-c", "select 1"], {
    encoding: "utf8",
    input: "owner-2026-10-16-test\n",
    env: { PATH: process.env.PATH, [PROD_WRITE_URL_FILE_ENV]: urlFile("cli-write.url", FAKE) },
  });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /interactive terminal/);
});

test("psqlEnv: libpq parts go in PG* env (no password in argv); inherited PG* and credential vars are dropped", () => {
  const e = psqlEnv("postgresql://lc_reader:p%40ss@db.example.invalid:6543/postgres?sslmode=require", {
    env: { PATH: "/bin", PGHOST: "evil", PGPASSWORD: "old", DATABASE_URL: FAKE, SUPABASE_DB_URL: FAKE, SUPABASE_SERVICE_ROLE_KEY: "svc" },
    readOnly: true,
  });
  assert.deepEqual(
    { h: e.PGHOST, p: e.PGPORT, u: e.PGUSER, d: e.PGDATABASE, pw: e.PGPASSWORD, ssl: e.PGSSLMODE, o: e.PGOPTIONS },
    { h: "db.example.invalid", p: "6543", u: "lc_reader", d: "postgres", pw: "p@ss", ssl: "require", o: "-c default_transaction_read_only=on" },
  );
  for (const k of ["DATABASE_URL", "SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY"]) assert.equal(e[k], undefined, k);
  assert.match(e.PGPASSFILE, /nonexistent/);
});

// ── the read-only REST-shaped builder (no database) ─────────────────────────

test("read-only rest builder: supabase-js chains become parameterised SELECTs; writes, rpc and unsupported shapes throw", async () => {
  const seen = [];
  const sb = readOnlyRestClient({ connect: async () => ({ query: async (text, values) => { seen.push({ text, values }); return { rows: text.includes("count(*)") ? [{ n: 3 }] : [{ id: 1 }] }; }, end: async () => {} }) });
  const r = await sb.from("send_queue").select("id,queue_status", { count: "exact" }).eq("market", "Dallas, TX").in("queue_status", ["queued", "scheduled"]).or("guard_reason.is.null,guard_reason.eq.no_sender").gte("created_at", "2026-10-01").order("id", { ascending: false }).range(10, 19);
  assert.deepEqual(r, { data: [{ id: 1 }], error: null, count: 3 });
  assert.equal(seen[1].text, 'select "id", "queue_status" from public."send_queue" where "market" = $1 and "queue_status" = any($2) and ("guard_reason" is null or "guard_reason" = $3) and "created_at" >= $4 order by "id" desc limit 10 offset 10');
  assert.deepEqual(seen[1].values, ["Dallas, TX", ["queued", "scheduled"], "no_sender", "2026-10-01"]);
  const head = await sb.from("message_events").select("id", { count: "exact", head: true }).eq("direction", "inbound");
  assert.deepEqual(head, { data: null, error: null, count: 3 });
  const before = seen.length;
  assert.throws(() => sb.from("send_queue").select("id,md_queue_key:metadata->>queue_key,agent.schema_name"), /unsupported select term/);
  assert.throws(() => sb.from("send_queue").select("id, owner:owners(name)"), /unsupported select term/);
  assert.equal(seen.length, before, "nothing was sent for a refused shape");
  const json = sb.from("send_queue").select("id,md_k:metadata->>k").toSql().rows;
  assert.equal(json, 'select "id", "metadata"->>\'k\' as "md_k" from public."send_queue"');
  for (const m of ["insert", "update", "upsert", "delete"]) assert.throws(() => sb.from("send_queue")[m]({}), /refused/);
  assert.throws(() => sb.rpc("anything"), /refused/);
  assert.throws(() => sb.from("send_queue; drop table x"), /unsupported/);
  assert.throws(() => sb.from("send_queue").eq("a or 1=1", 1), /unsupported/);
  const one = await sb.from("system_control").select("value").eq("key", "k").maybeSingle();
  assert.deepEqual(one, { data: { id: 1 }, error: null, count: null });
  assert.equal(REST_TYPES.getTypeParser(20, "text")("42"), 42);
  assert.equal(REST_TYPES.getTypeParser(1184, "text")("2026-10-16 12:00:00+00"), "2026-10-16T12:00:00.000Z");
  await sb.close();
});

// ── the disposable database ─────────────────────────────────────────────────

const PG_BIN = String(process.env.LC_PG_BIN || "").trim();
const ADMIN = String(process.env.LC_MIGRATION_TEST_ADMIN_URL || "").trim();
const dbSkip = PG_BIN || ADMIN ? false : "needs LC_PG_BIN (fresh disposable cluster) or LC_MIGRATION_TEST_ADMIN_URL (loopback scratch server)";

test("disposable PG17: the loader refuses every writable role, accepts the read-only role, and the database itself rejects writes", { skip: dbSkip }, async (t) => {
  let cluster = null;
  let adminUrl = ADMIN;
  if (!adminUrl) {
    cluster = startCluster({ bin: PG_BIN, log: () => {} });
    adminUrl = cluster.url;
  }
  assertDisposableTarget(adminUrl);
  // no libpq default may redirect a connection (pg reads PGHOST/PGUSER/PGPASSWORD… as fallbacks)
  for (const k of Object.keys(process.env)) if (/^PG/.test(k)) delete process.env[k];

  const sfx = crypto.randomBytes(4).toString("hex");
  const db = `lc_cred_${sfx}`;
  const pw = crypto.randomBytes(12).toString("hex");
  const R = Object.fromEntries(["ro", "rw", "bypass", "super", "wall", "setrole", "create", "trunc", "agentw"].map((k) => [k, `lc_t_${k}_${sfx}`]));
  const parts = /^(postgres(?:ql)?:\/\/)(?:([^@/]*)@)?([^/?#]*)(?:\/[^?#]*)?(\?[^#]*)?$/i.exec(adminUrl);
  const urlFor = (role, database = db) => `${parts[1]}${role}:${pw}@${parts[3]}/${database}${parts[4] || ""}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const adminDb = new pg.Client({ connectionString: `${parts[1]}${parts[2] ? `${parts[2]}@` : ""}${parts[3]}/${db}${parts[4] || ""}` });
  try {
    await admin.query(`create database ${db}`);
    for (const r of Object.values(R)) await admin.query(`create role ${r} login password '${pw}'`);
    await admin.query(`alter role ${R.bypass} bypassrls`);
    await admin.query(`alter role ${R.super} superuser`);
    await admin.query(`grant pg_write_all_data to ${R.wall}`);
    await adminDb.connect();
    await adminDb.query(`
      create schema agent;
      create table public.send_queue (id bigserial primary key, queue_status text);
      create table public.sms_templates (id bigserial primary key, body text);
      create table public.system_control (key text primary key, value text);
      create table agent.runtime_limits (kind text primary key, max_n int);
      create table public.properties (id bigserial primary key, note text);
      insert into public.send_queue (queue_status) values ('queued');
      revoke create on schema public from public;
    `);
    for (const r of Object.values(R)) {
      await adminDb.query(`grant connect on database ${db} to ${r}; grant usage on schema public, agent to ${r}; grant select on all tables in schema public, agent to ${r}`);
    }
    await adminDb.query(`grant insert, update, delete on public.send_queue, public.sms_templates, public.system_control to ${R.rw}; grant usage on all sequences in schema public to ${R.rw}`);
    await adminDb.query(`grant truncate on public.send_queue to ${R.trunc}`);
    await adminDb.query(`grant insert on agent.runtime_limits to ${R.agentw}`);
    await adminDb.query(`grant create on schema public to ${R.create}`);
    // a NOINHERIT member of the writer: its own privileges look read-only, SET ROLE is not
    await adminDb.query(`alter role ${R.setrole} noinherit; grant ${R.rw} to ${R.setrole}`);

    const envFor = (role, database) => ({ [RO_ENV]: urlFile(`${role}-${database || db}.url`, urlFor(role, database)) });

    await t.test("writable credentials are refused at connect time, with the reason", async () => {
      const expect = {
        rw: /send_queue is writable.*lc_t_rw_/,
        bypass: /lc_t_bypass_\w+ has BYPASSRLS and purpose ops_diag is not allowlisted for BYPASSRLS/,
        super: /superuser/,
        wall: /send_queue is writable/,
        setrole: /via SET ROLE lc_t_rw_|writable \(INSERT\/UPDATE\/DELETE\/TRUNCATE\) by lc_t_rw_/,
        create: /schema public grants CREATE/,
        trunc: /send_queue is writable/,
        agentw: /agent\.runtime_limits is writable/,
      };
      for (const [k, re] of Object.entries(expect)) {
        await assert.rejects(connectReadOnlyDiagnostics({ purpose: "ops_diag", env: envFor(R[k]), pg }), refused(re), k);
        await assert.rejects(openReadOnlyPool({ purpose: "ops_diag", env: envFor(R[k]), pg }), refused(re), `${k} (pool)`);
        await assert.rejects(resolveReadOnlyUrl({ purpose: "ops_diag", env: envFor(R[k]), pg }), refused(re), `${k} (psql door)`);
      }
    });

    await t.test("BEGIN READ ONLY does not rescue a writable credential", async () => {
      // the writer under a read-only transaction can still not get through the loader…
      await assert.rejects(connectReadOnlyDiagnostics({ purpose: "ops_diag", env: envFor(R.rw), pg }), refused(/BEGIN READ ONLY does not make a writable credential acceptable/));
      // …because it IS writable: a session setting is all that stands in the way
      const c = new pg.Client({ connectionString: urlFor(R.rw) });
      await c.connect();
      await c.query("begin read only");
      await assert.rejects(c.query("insert into public.send_queue (queue_status) values ('x')"), (e) => e.code === "25006");
      await c.query("rollback");
      await c.query("insert into public.send_queue (queue_status) values ('x')");
      await c.query("delete from public.send_queue where queue_status = 'x'");
      await c.end();
    });

    await t.test("the read-only role is accepted (client, pool, psql door)", async () => {
      const c = await connectReadOnlyDiagnostics({ purpose: "ops_diag", env: envFor(R.ro), pg, applicationName: "lc-cred-test" });
      assert.equal(c.lcCredential.kind, "readonly");
      assert.equal(c.lcCredential.purpose, "ops_diag");
      assert.equal(c.lcCredential.role, R.ro);
      assert.doesNotMatch(c.lcCredential.target, new RegExp(pw));
      assert.equal((await c.query("select count(*)::int n from public.send_queue")).rows[0].n, 1);
      assert.equal((await c.query("show default_transaction_read_only")).rows[0].default_transaction_read_only, "on");
      await c.end();
      const pool = await openReadOnlyPool({ purpose: "ops_diag", env: envFor(R.ro), pg, max: 2 });
      const r = await pool.query("select current_user::text u, current_setting('default_transaction_read_only') ro");
      assert.deepEqual(r.rows[0], { u: R.ro, ro: "on" });
      await pool.end();
      assert.equal((await resolveReadOnlyUrl({ purpose: "ops_diag", env: envFor(R.ro), pg })).role, R.ro);
      const viaLoad = await loadReadOnly("ops_diag", { env: envFor(R.ro), pg });
      assert.equal(viaLoad.lcCredential.role, R.ro);
      await viaLoad.end();
    });

    await t.test("a required sentinel missing ⇒ cannot verify ⇒ refused; an optional one missing is fine", async () => {
      await assert.rejects(connectReadOnlyDiagnostics({ purpose: "ops_diag", env: envFor(R.ro), pg, sentinels: [...READONLY_SENTINELS, { table: "public.no_such_table", required: true }] }), refused(/no_such_table is missing/));
      const c = await connectReadOnlyDiagnostics({ purpose: "ops_diag", env: envFor(R.ro), pg, sentinels: [...READONLY_SENTINELS, { table: "agent.no_such_table", required: false }] });
      await c.end();
      await admin.query(`create database ${db}_bare`);
      try {
        await assert.rejects(connectReadOnlyDiagnostics({ purpose: "ops_diag", env: envFor(R.ro, `${db}_bare`), pg }), refused(/send_queue is missing/));
      } finally {
        await admin.query(`drop database if exists ${db}_bare with (force)`);
      }
    });

    await t.test("writes as the read-only role fail AT THE DATABASE (permission denied, not a read-only transaction)", async () => {
      const c = await connectReadOnlyDiagnostics({ purpose: "ops_diag", env: envFor(R.ro), pg });
      // take the session guard away: what remains is the role
      await c.query("set default_transaction_read_only = off");
      await c.query("begin read write");
      await c.query("rollback");
      const denied = (e) => e.code === "42501";
      for (const sql of [
        "insert into public.send_queue (queue_status) values ('x')",
        "update public.send_queue set queue_status = 'x'",
        "delete from public.send_queue",
        "truncate public.send_queue",
        "insert into public.sms_templates (body) values ('x')",
        "update public.system_control set value = 'x'",
        "insert into agent.runtime_limits values ('k', 1)",
        "insert into public.properties (note) values ('not a sentinel either')",
        "create table public.lc_t_new (id int)",
      ]) {
        await c.query("begin read write");
        await assert.rejects(c.query(sql), denied, sql);
        await c.query("rollback");
      }
      await assert.rejects(c.query(`set role ${R.rw}`), denied);
      await c.end();
      const check = await adminDb.query("select (select count(*)::int from public.send_queue) sq, (select count(*)::int from public.sms_templates) st, to_regclass('public.lc_t_new') is null as no_new");
      assert.deepEqual(check.rows[0], { sq: 1, st: 0, no_new: true });
    });

    await t.test("read-only rest builder over the verified read-only role: reads work, the role refuses writes", async () => {
      const sb = readOnlyRestClient({ connect: () => connectReadOnlyDiagnostics({ purpose: "ops_diag", env: envFor(R.ro), pg, types: REST_TYPES }) });
      const { data, error } = await sb.from("send_queue").select("id,queue_status").eq("queue_status", "queued").order("id").limit(5);
      assert.equal(error, null);
      assert.deepEqual(data.map((r) => [typeof r.id, r.queue_status]), [["number", "queued"]]);
      const { count } = await sb.from("send_queue").select("id", { count: "exact", head: true }).or("queue_status.is.null,queue_status.eq.queued");
      assert.equal(count, 1);
      await sb.close();
      const rw = readOnlyRestClient({ connect: () => connectReadOnlyDiagnostics({ purpose: "ops_diag", env: envFor(R.rw), pg }) });
      await assert.rejects(rw.from("send_queue").select("id").run().then((r) => { if (r.error) throw r.error; return r; }), (e) => /not role-enforced read-only/.test(e.message));
      await rw.close().catch(() => {});
    });

    await t.test("psql door: the read-only role through the CLI cannot write either", { skip: spawnSync("psql", ["--version"]).status === 0 ? false : "psql not on PATH" }, () => {
      const env = { PATH: process.env.PATH, ...envFor(R.ro) };
      const ok = spawnSync(process.execPath, [LOADER, "psql", "ops_diag", "-At", "-c", "select current_user"], { encoding: "utf8", env });
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(ok.stdout.trim(), R.ro);
      const no = spawnSync(process.execPath, [LOADER, "psql", "ops_diag", "-v", "ON_ERROR_STOP=1", "-c", "set default_transaction_read_only = off", "-c", "insert into public.send_queue (queue_status) values ('x')"], { encoding: "utf8", env });
      assert.notEqual(no.status, 0);
      assert.match(no.stderr, /permission denied/);
      const rw = spawnSync(process.execPath, [LOADER, "psql", "ops_diag", "-c", "select 1"], { encoding: "utf8", env: { PATH: process.env.PATH, ...envFor(R.rw) } });
      assert.equal(rw.status, 3);
      assert.match(rw.stderr, /not role-enforced read-only/);
    });

    await t.test("write door: with every gate satisfied it connects as the write role and records the approval", async () => {
      const env = { [PROD_WRITE_URL_FILE_ENV]: urlFile("rw-write.url", urlFor(R.rw)) };
      const logs = [];
      const c = await connectProdWrite({ argv: ["--prod-write=owner-2026-10-16-test"], env, tty: tty("owner-2026-10-16-test"), pg, log: (m) => logs.push(m) });
      assert.deepEqual({ kind: c.lcCredential.kind, role: c.lcCredential.role, ref: c.lcCredential.approvalRef }, { kind: "prod-write", role: R.rw, ref: "owner-2026-10-16-test" });
      assert.match(logs[0], /approval=owner-2026-10-16-test/);
      assert.doesNotMatch(logs[0], new RegExp(pw));
      await c.end();
      await assert.rejects(connectProdWrite({ argv: [], env, tty: tty("x"), pg }), refused(/--prod-write/));
    });
  } finally {
    await adminDb.end().catch(() => {});
    await admin.query(`drop database if exists ${db} with (force)`).catch(() => {});
    for (const r of Object.values(R)) await admin.query(`drop role if exists ${r}`).catch(() => {});
    await admin.end().catch(() => {});
    if (cluster) cluster.stop();
  }
});
