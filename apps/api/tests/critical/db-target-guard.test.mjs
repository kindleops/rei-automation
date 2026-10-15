/**
 * MIGRATION TEST RUNNER — REFUSES PRODUCTION (rc-8.5.15.1, owner boundary 2026-10-15).
 *
 * 2026-10-14: a "chain pretest" ran against production and committed a migration
 * through an included rollback file's `commit;`. scripts/db/run-migration-test.mjs
 * (and every harness that uses scripts/db/db-target-guard.mjs) refuses any target
 * that is production-like or not a loopback / unix-socket database, BEFORE any
 * connection is opened. These tests never connect anywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertDisposableTarget,
  isProductionLikeHost,
  parseConnTarget,
  sanitizedPgEnv,
  PRODUCTION_PROJECT_REF,
  UnsafeDbTargetError,
} from "../../../../scripts/db/db-target-guard.mjs";
import { resolveAdminTarget, runMigrationTest, assertSnapshotFile } from "../../../../scripts/db/run-migration-test.mjs";

const REF = PRODUCTION_PROJECT_REF;
const PROD_LIKE = [
  // the exact production pooler + direct host (built from the guard's own constant)
  `postgresql://postgres.${REF}:secret@aws-1-us-west-2.pooler.supabase.com:6543/postgres`,
  `postgresql://postgres:secret@db.${REF}.supabase.co:5432/postgres`,
  // any Supabase-hosted project, pooler or direct
  "postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
  "postgres://postgres:pw@db.abcdefghijklmnopqrst.supabase.co/postgres",
  // the ref anywhere (database name, query string, user)
  `postgresql://postgres@127.0.0.1:5432/${REF}`,
  `postgresql://postgres@localhost/postgres?application_name=${REF}`,
  // a host smuggled through ?host= / multi-host / conninfo
  "postgresql://postgres@/postgres?host=db.abcdefghijklmnopqrst.supabase.co",
  "postgresql://postgres@127.0.0.1:5432,aws-1-us-west-2.pooler.supabase.com:6543/postgres",
  "host=aws-1-us-west-2.pooler.supabase.com port=6543 user=postgres dbname=postgres",
  `host=127.0.0.1 user=postgres.${REF} dbname=postgres`,
  // pooler-style user without any host hint
  "postgresql://postgres.abcdefghijklmnopqrst:pw@127.0.0.1:6543/postgres",
];
const NOT_LOCAL = [
  "postgresql://postgres:pw@10.0.0.5:5432/postgres",
  "postgresql://postgres:pw@my-staging-db.internal:5432/postgres",
  "postgresql://postgres:pw@ec2-1-2-3-4.compute.amazonaws.com/postgres",
  "service=prod",
  "postgresql://postgres@/postgres?service=prod",
  "",
];
const LOCAL = [
  "postgres://postgres:postgres@127.0.0.1:5432/proofdb",
  "postgresql://postgres@localhost:55437/postgres",
  "postgresql://postgres@[::1]:5432/postgres",
  "postgresql://postgres@/postgres?host=%2Ftmp%2Flcmt-abc&port=5432",
  "host=/tmp/lcmt-abc port=5432 user=postgres dbname=lc_mt_x",
];

test("guard: every production-like target is refused, whatever the env says", () => {
  for (const url of PROD_LIKE) {
    assert.throws(() => assertDisposableTarget(url, { env: {} }), UnsafeDbTargetError, url.replace(/:[^:@/]*@/, ":***@"));
    // declaring the host "disposable" never unlocks a production-like target
    const host = parseSafeHost(url);
    if (host) assert.throws(() => assertDisposableTarget(url, { env: { LC_DISPOSABLE_DB_HOST: host } }), UnsafeDbTargetError);
  }
  assert.equal(isProductionLikeHost(`db.${REF}.supabase.co`), true);
  assert.equal(isProductionLikeHost("aws-1-us-west-2.pooler.supabase.com"), true);
  assert.equal(isProductionLikeHost("127.0.0.1"), false);
});

function parseSafeHost(url) {
  try { return parseConnTarget(url).hosts.find((h) => !h.startsWith("/")) || null; } catch { return null; }
}

test("guard: a non-loopback host is refused unless LC_DISPOSABLE_DB_HOST names exactly it", () => {
  for (const url of NOT_LOCAL) assert.throws(() => assertDisposableTarget(url, { env: {} }), UnsafeDbTargetError, url);
  // CI service container reached by name: allowed only when declared
  assert.throws(() => assertDisposableTarget("postgres://postgres:postgres@postgres:5432/proofdb", { env: {} }), UnsafeDbTargetError);
  assert.equal(assertDisposableTarget("postgres://postgres:postgres@postgres:5432/proofdb", { env: { LC_DISPOSABLE_DB_HOST: "postgres" } }).local, false);
  assert.throws(() => assertDisposableTarget("postgres://postgres:postgres@postgres2:5432/proofdb", { env: { LC_DISPOSABLE_DB_HOST: "postgres" } }), UnsafeDbTargetError);
});

test("guard: loopback and unix-socket targets are accepted; a missing host falls back to PGHOST, which is checked too", () => {
  for (const url of LOCAL) assert.equal(assertDisposableTarget(url, { env: {} }).local, true, url);
  assert.equal(assertDisposableTarget("postgresql://postgres@/postgres", { env: {} }).local, true, "default socket");
  assert.throws(() => assertDisposableTarget("postgresql://postgres@/postgres", { env: { PGHOST: "aws-1-us-west-2.pooler.supabase.com" } }), UnsafeDbTargetError);
});

test("runner: resolveAdminTarget refuses a production URL from the flag AND from the environment, and refuses no target at all", () => {
  const prod = PROD_LIKE[0];
  assert.throws(() => resolveAdminTarget({ adminUrl: prod, env: {} }), /refused/);
  assert.throws(() => resolveAdminTarget({ env: { LC_MIGRATION_TEST_ADMIN_URL: prod } }), /refused/);
  assert.throws(() => resolveAdminTarget({ env: {} }), /no disposable server/);
  assert.throws(() => resolveAdminTarget({ adminUrl: LOCAL[0], pgBin: "/x", env: {} }), /not both/);
  assert.deepEqual(resolveAdminTarget({ adminUrl: LOCAL[0], env: {} }), { mode: "url", url: LOCAL[0] });
  assert.deepEqual(resolveAdminTarget({ pgBin: "/opt/pg/bin", env: {} }), { mode: "cluster", bin: "/opt/pg/bin" });
});

test("runner: runMigrationTest throws on a production admin URL before linting, creating or connecting", () => {
  const t = { id: "x", apply: ["supabase/migrations/PROPOSED_20261015120000_repeat_asking_price_question_kind.sql"] };
  for (const url of PROD_LIKE) assert.throws(() => runMigrationTest(t, { adminUrl: url, log: () => {} }), UnsafeDbTargetError);
});

test("runner: a fixture that fails the lint is never executed (the 10-14 chain pretest shape)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-mt-lint-"));
  const pretest = path.join(dir, "chain_pretest.sql");
  fs.writeFileSync(pretest, "\\set ON_ERROR_STOP on\nbegin;\n\\ir PROPOSED_20261013120000_agent_capabilities_rollback.sql\nselect 1;\nrollback;\n");
  // a closed port: if the runner tried to connect, this would fail differently
  const r = runMigrationTest({ id: "chain", pretest, apply: [] }, { adminUrl: "postgresql://postgres@127.0.0.1:1/postgres", log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /fixture lint failed; nothing executed/);
  assert.match(r.error, /\[include\]/);
  assert.deepEqual(r.steps, []);
});

test("runner: a child psql never inherits libpq redirects or production secrets", () => {
  const env = sanitizedPgEnv({ PGHOST: "aws-1-us-west-2.pooler.supabase.com", PGUSER: "postgres.x", PGPASSWORD: "p", PGSERVICE: "prod", SUPABASE_DB_URL: "postgres://prod", SUPABASE_SERVICE_ROLE_KEY: "k", DATABASE_URL: "postgres://prod", PATH: "/usr/bin" });
  for (const k of ["PGHOST", "PGUSER", "PGPASSWORD", "PGSERVICE", "SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL"]) assert.equal(env[k], undefined, k);
  assert.equal(env.PATH, "/usr/bin");
  assert.match(env.PGSERVICEFILE, /^\/nonexistent\//);
  assert.match(env.PGPASSFILE, /^\/nonexistent\//);
});

test("runner: a production-shaped snapshot must be schema-only and free of includes / transaction control", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-mt-snap-"));
  const w = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };
  assert.doesNotThrow(() => assertSnapshotFile(w("ok.sql", "SET statement_timeout = 0;\nCREATE TABLE public.t (id int);\nCREATE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN 1;\nEND;\n$$;\n")));
  assert.throws(() => assertSnapshotFile(w("data.sql", "CREATE TABLE public.t (id int);\n--\n-- Data for Name: t; Type: TABLE DATA\n--\nCOPY public.t (id) FROM stdin;\n1\n\\.\n")), /schema-only/);
  assert.throws(() => assertSnapshotFile(w("tx.sql", "CREATE TABLE public.t (id int);\nCOMMIT;\n")), /transaction control/);
  assert.throws(() => assertSnapshotFile(w("inc.sql", "\\ir other.sql\n")), /includes/);
});
