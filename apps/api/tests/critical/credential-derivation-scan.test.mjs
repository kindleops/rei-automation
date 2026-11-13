/**
 * "NO SILENT CREDENTIAL DERIVATION" scan (scripts/db/scan-credential-derivation.mjs,
 * rc-8.5.21-c). Owner directive 2026-10-16: no test, fixture, migration-test harness or
 * new script derives DB / service credentials from env files or SUPABASE_DB_URL /
 * DATABASE_URL / SERVICE_ROLE env vars, except the frozen inventory allowlist.
 * Pure file checks: these tests never connect anywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  RULE_IDS,
  scanSource,
  scopeOf,
  scanRepo,
  applyAllowlist,
  allowlistKeys,
  checkAllowlistIntegrity,
  readFrozenBaseline,
  findingKey,
  inventoryMarkdown,
  inventoryCounts,
  FROZEN_BASELINE_SHA256,
} from "../../../../scripts/db/scan-credential-derivation.mjs";
import { INVENTORY, CLASSES } from "../../../../scripts/db/credential-inventory.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const hits = (src, scope = "script", file = "apps/api/scripts/new-tool.mjs") => [...new Set(scanSource(file, src, scope).map((f) => f.rule))].sort();

// ── positive cases: every derivation shape is caught ────────────────────────

test("scan: dotenv loading in every spelling is caught", () => {
  for (const src of [
    'import dotenv from "dotenv"; dotenv.config({ path: ".env.local" })',
    "require('dotenv').config()",
    "node --env-file=.env.local scripts/x.mjs",
    "node --env-file-if-exists=.env scripts/x.mjs",
    "process.loadEnvFile('.env.local')",
    "const f = path.join(ROOT, 'apps/api/.env.local')",
    "fs.readFileSync('.env.production.local', 'utf8')",
    "const envFile = argValue('--env', '.env')",
    "source .env",
    ". apps/api/.env",
  ]) assert.deepEqual(hits(src), ["env-file"], src);
});

test("scan: reading a DB URL, a service-role key or /tmp/.dburl is caught (JS, shell, Python, Deno)", () => {
  const cases = [
    ["new pg.Client({ connectionString: process.env.DATABASE_URL })", "db-url-env"],
    ["const u = process.env.SUPABASE_DB_URL || ''", "db-url-env"],
    ["const u = process.env['SUPABASE_URL_NO_POOL']", "db-url-env"],
    ["const u = env.POSTGRES_URL_NON_POOLING", "db-url-env"],
    ["const u = process.env.DIRECT_URL", "db-url-env"],
    ["if (process.env.DATABASE_URL === undefined) x()", "db-url-env"],
    ['psql "$DATABASE_URL" -f x.sql', "db-url-env"],
    ["psql ${SUPABASE_DB_URL} -c 'select 1'", "db-url-env"],
    ["url = os.environ['DATABASE_URL']", "db-url-env"],
    ["url = os.getenv('SUPABASE_DB_URL')", "db-url-env"],
    ["const u = Deno.env.get('DATABASE_URL')", "db-url-env"],
    ["createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY)", "service-role-env"],
    ["const k = process.env.SUPABASE_SERVICE_KEY_SERVICE_ROLE", "service-role-env"],
    ["key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')", "service-role-env"],
    ["const url = fs.readFileSync('/tmp/.dburl', 'utf8')", "dburl-file"],
    ["--db-url-file /tmp/.dburl.ro", "dburl-file"],
    ['import { getSupabaseClient } from "../src/lib/supabase/client.js"', "runtime-credential-import"],
    ["const { getPgPool } = await import('@/lib/postgres/client.js')", "runtime-credential-import"],
    ['import { resolveDatabaseUrl } from "../../src/lib/postgres/resolve-database-url.js"', "runtime-credential-import"],
  ];
  for (const [src, rule] of cases) assert.deepEqual(hits(src), [rule], src);
});

test("scan: package.json script entries that load env files are caught per entry", () => {
  const pkg = JSON.stringify({ scripts: { ok: "node scripts/a.mjs", bad: "node --env-file=.env.local scripts/b.mjs", worse: "psql $DATABASE_URL -f x.sql" } });
  const f = scanSource("apps/api/package.json", pkg, "package-json");
  assert.deepEqual(f.map((x) => `${x.entry}:${x.rule}`).sort(), ["bad:env-file", "worse:db-url-env"]);
  assert.equal(findingKey(f.find((x) => x.entry === "bad")), "apps/api/package.json#scripts.bad env-file");
});

test("scan: tests, fixtures and migration harnesses are in scope too (runtime-import rule is scripts-only)", () => {
  assert.deepEqual(hits("const u = process.env.DATABASE_URL", "test", "apps/api/tests/critical/x.test.mjs"), ["db-url-env"]);
  assert.deepEqual(hits("dotenv.config()", "test", "supabase/migrations/PROPOSED_x_pretest.sql"), ["env-file"]);
  assert.deepEqual(hits('import { getSupabaseClient } from "../../src/lib/supabase/client.js"', "test", "apps/api/tests/critical/x.test.mjs"), []);
  const none = () => "";
  assert.equal(scopeOf("apps/api/scripts/x.mjs", none), "script");
  assert.equal(scopeOf("scripts/ops/x.mjs", none), "script");
  assert.equal(scopeOf("apps/dashboard/scripts/x.ts", none), "script");
  assert.equal(scopeOf("repro.mjs", none), "script");
  assert.equal(scopeOf("apps/api/scripts/x.sql", none), "script");
  assert.equal(scopeOf("apps/api/package.json", none), "package-json");
  assert.equal(scopeOf("package.json", none), "package-json");
  assert.equal(scopeOf("apps/api/tests/critical/a.test.mjs", none), "test");
  assert.equal(scopeOf("supabase/migrations/PROPOSED_x_posttest.sql", none), "test");
  assert.equal(scopeOf("apps/api/src/lib/supabase/client.js", none), false, "runtime code is out of scope");
  assert.equal(scopeOf("apps/api/scripts/README.md", none), false);
  assert.equal(scopeOf("node_modules/x/scripts/a.mjs", none), false);
});

// ── negative cases: not derivations ─────────────────────────────────────────

test("scan: placeholders, deletions, mentions and the loader's own variables are not derivations", () => {
  for (const src of [
    'process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";',
    "process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'harness'",
    "process.env.DATABASE_URL ??= 'postgres://localhost/x'",
    "delete process.env.SUPABASE_DB_URL;",
    "const env = { SUPABASE_SERVICE_ROLE_KEY: 'svc', DATABASE_URL: 'x' }",
    "// set DATABASE_URL=... before running",
    "const f = process.env.LC_RO_OPS_DIAG_DB_URL_FILE",
    "const f = process.env.LC_PROD_WRITE_DB_URL_FILE",
    "const p = process.env.AGENT_PG_TEST_DB_URL",
    "const t = process.env.TEXTGRID_AUTH_TOKEN",
    "import { connectReadOnlyDiagnostics } from '../../scripts/lib/prod-db-credentials.mjs'",
    "const x = myenv.DATABASE_URL",
    "const s = 'see process.environment docs'",
    "import { x } from '../src/lib/supabase/sms-engine.js'",
    "const n = config.envName",
  ]) assert.deepEqual(hits(src), [], src);
});

// ── the frozen allowlist ────────────────────────────────────────────────────

test("allowlist: applies only to the exact (path, rule) pairs the inventory declares", () => {
  const inv = [{ path: "apps/api/scripts/legacy.mjs", cls: "readonly", status: "legacy: allowlisted pending migration", allow: ["env-file"], note: "n" }];
  const f = [
    { file: "apps/api/scripts/legacy.mjs", rule: "env-file" },
    { file: "apps/api/scripts/legacy.mjs", rule: "service-role-env" },
    { file: "apps/api/scripts/new.mjs", rule: "env-file" },
    { file: "scripts/lib/prod-db-credentials.mjs", rule: "dburl-file" },
  ];
  assert.deepEqual(applyAllowlist(f, inv).map((x) => `${x.file} ${x.rule}`), ["apps/api/scripts/legacy.mjs service-role-env", "apps/api/scripts/new.mjs env-file"]);
});

test("allowlist: FROZEN — a new entry, a widened entry or an edited baseline fails; shrinking passes", () => {
  const baseline = readFrozenBaseline(REPO);
  assert.equal(baseline.sha256, FROZEN_BASELINE_SHA256, "the committed baseline matches the pinned digest");
  assert.deepEqual(checkAllowlistIntegrity({ baseline }), []);
  // shrink: drop an entry and narrow another — still fine
  const legacy = INVENTORY.filter((e) => e.allow.length);
  const shrunk = INVENTORY.filter((e) => e !== legacy[0]).map((e) => (e === legacy[1] ? { ...e, allow: e.allow.slice(0, 1) } : e));
  assert.deepEqual(checkAllowlistIntegrity({ inventory: shrunk, baseline }), []);
  // grow: a brand-new script
  const grown = [...INVENTORY, { path: "apps/api/scripts/brand-new.mjs", cls: "readonly", status: "legacy: allowlisted pending migration", allow: ["env-file"], note: "x" }];
  assert.match(checkAllowlistIntegrity({ inventory: grown, baseline }).join("\n"), /new allowlist entry "apps\/api\/scripts\/brand-new\.mjs env-file"/);
  // widen: an existing entry gains a rule
  const target = INVENTORY.find((e) => e.allow.length && !e.allow.includes("dburl-file"));
  const widened = INVENTORY.map((e) => (e === target ? { ...e, allow: [...e.allow, "dburl-file"] } : e));
  assert.match(checkAllowlistIntegrity({ inventory: widened, baseline }).join("\n"), new RegExp(`new allowlist entry "${target.path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} dburl-file"`));
  // editing the baseline to admit it changes the digest
  const edited = { ...baseline, raw: `${baseline.raw}apps/api/scripts/brand-new.mjs env-file\n` };
  edited.sha256 = crypto.createHash("sha256").update(edited.raw).digest("hex");
  edited.keys = new Set([...baseline.keys, "apps/api/scripts/brand-new.mjs env-file"]);
  assert.match(checkAllowlistIntegrity({ inventory: grown, baseline: edited }).join("\n"), /credential-derivation\.frozen\.txt was edited/);
  // malformed inventory rows
  assert.match(checkAllowlistIntegrity({ inventory: [...INVENTORY, { ...INVENTORY[0] }], baseline }).join("\n"), /twice/);
  assert.match(checkAllowlistIntegrity({ inventory: [{ path: "x", cls: "maybe", status: "s", allow: [], note: "n" }], baseline }).join("\n"), /unknown class/);
});

test("inventory: every entry is classified, notes exist, migrated entries allow nothing, counts are what the doc says", () => {
  for (const e of INVENTORY) {
    assert.ok(CLASSES[e.cls], e.path);
    assert.ok(e.note && e.status, e.path);
    for (const r of e.allow) assert.ok(RULE_IDS.includes(r), `${e.path}: ${r}`);
    if (/^migrated: loader/.test(e.status)) assert.deepEqual(e.allow, [], `${e.path} is migrated but still allowlisted`);
    if (e.purpose) assert.match(e.purpose, /^(ops_diag|entity_graph|market_intel|seller_intel|research_agent)$/, e.path);
  }
  const c = inventoryCounts();
  assert.equal(c.total, INVENTORY.length);
  const doc = fs.readFileSync(path.join(REPO, "docs/CREDENTIAL-SAFETY.md"), "utf8");
  assert.ok(doc.includes(inventoryMarkdown()), "docs/CREDENTIAL-SAFETY.md carries the current inventory table (regenerate with --inventory-md)");
  for (const [cls, n] of Object.entries(c.byClass)) assert.ok(doc.includes(`| ${CLASSES[cls]} | ${n} |`), `doc count for ${cls}`);
});

test("repository: clean under the frozen allowlist; every migrated script really uses the loader", () => {
  const r = scanRepo(REPO);
  assert.ok(r.scanned > 1500, `files in scope: ${r.scanned}`);
  assert.deepEqual(r.findings.map((f) => `${f.file}${f.entry ? `#${f.entry}` : `:${f.line}`} [${f.rule}]`), []);
  assert.deepEqual(r.integrity, []);
  assert.deepEqual(r.stale, [], "allowlisted pairs that no longer occur must be dropped from the inventory");
  for (const e of INVENTORY.filter((x) => /migrated/.test(x.status) && !x.path.includes("#"))) {
    const src = fs.readFileSync(path.join(REPO, e.path), "utf8");
    assert.match(src, /prod-db-credentials\.mjs|_ro-db\.mjs|_readonly\.mjs|openRepairPgClient/, `${e.path} goes through the loader`);
    assert.doesNotMatch(src, /\/tmp\/\.dburl/, `${e.path} no longer reads /tmp/.dburl`);
  }
});

test("CLI: a new script that derives credentials fails the scan (exit 1) in a scratch copy of the scanner", () => {
  // build a tiny scratch git repo with the scanner + inventory + baseline and one offending script
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-cred-scan-"));
  try {
    for (const f of ["scripts/db/scan-credential-derivation.mjs", "scripts/db/scan-test-prod-targets.mjs", "scripts/db/db-target-guard.mjs", "scripts/db/credential-inventory.mjs", "scripts/db/credential-derivation.frozen.txt"]) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
    }
    fs.mkdirSync(path.join(dir, "apps/api/scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "apps/api/scripts/clean.mjs"), "import { loadReadOnly } from '../../../scripts/lib/prod-db-credentials.mjs'\nawait loadReadOnly('ops_diag')\n");
    const git = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    git("init", "-q");
    git("add", "-A");
    const clean = spawnSync(process.execPath, [path.join(dir, "scripts/db/scan-credential-derivation.mjs")], { encoding: "utf8" });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    fs.writeFileSync(path.join(dir, "apps/api/scripts/bad.mjs"), "import pg from 'pg'\nconst c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL })\n");
    git("add", "-A");
    const bad = spawnSync(process.execPath, [path.join(dir, "scripts/db/scan-credential-derivation.mjs")], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /apps\/api\/scripts\/bad\.mjs:2: \[db-url-env\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
