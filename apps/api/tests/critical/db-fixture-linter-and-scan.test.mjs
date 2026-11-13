/**
 * MIGRATION FIXTURE LINTER + "NO PRODUCTION TARGET IN TEST HARNESSES" SCAN
 * (rc-8.5.15.1, after the 2026-10-14 incident).
 *
 * The incident pattern: a pretest opened BEGIN, \ir-included apply files and a
 * rollback file that ends in its own `commit;` — the inner COMMIT committed the
 * outer transaction in production. The linter rejects every way a fixture can
 * end, nest or escape its transaction, or pull in another file; the scan keeps
 * production identifiers and secrets out of test harnesses. Both also run as CI
 * steps (.github/workflows/*.yml). These tests never connect anywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lintFixtureSource, classifyFile, lintFiles, listCandidateFiles } from "../../../../scripts/db/lint-migration-fixtures.mjs";
import { scanSource, scanRepo, inScope, ALLOWLIST } from "../../../../scripts/db/scan-test-prod-targets.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const rules = (r) => r.violations.map((v) => v.rule);
const lint = (src, name = "supabase/migrations/PROPOSED_x_pretest.sql") => lintFixtureSource(name, src);

// ── the 2026-10-14 pattern ───────────────────────────────────────────────────

test("linter: catches the exact 10-14 chain pretest — a pretest \\ir-including a rollback that ends in commit;", () => {
  const chain = [
    "-- RC 8.5.15 CHAIN PRETEST — one transaction, ends in ROLLBACK, writes nothing outside it.",
    "\\set ON_ERROR_STOP on",
    "begin;",
    "\\ir /abs/path/supabase/migrations/PROPOSED_20261012140000_intel_runtime.sql",
    "\\ir /abs/path/supabase/migrations/PROPOSED_20261013120000_agent_capabilities.sql",
    "do $$ begin raise notice 'chain: all five applied in one transaction'; end $$;",
    "\\ir /abs/path/supabase/migrations/PROPOSED_20261013120000_agent_capabilities_rollback.sql",
    "rollback;",
  ].join("\n");
  const r = lint(chain, "tmp/rc815/chain_pretest.sql");
  assert.equal(r.cls, "fixture");
  assert.equal(r.violations.filter((v) => v.rule === "include").length, 3);
  // the same content INLINED (what psql effectively executed) is caught by the COMMIT rule
  const rollbackFile = fs.readFileSync(path.join(REPO, "supabase/migrations/PROPOSED_20261013120000_agent_capabilities_rollback.sql"), "utf8");
  assert.match(rollbackFile, /^commit;/m, "the real rollback file ends in its own commit;");
  const inlined = lint(`begin;\n${rollbackFile}\nrollback;\n`);
  assert.ok(rules(inlined).includes("commit"), JSON.stringify(inlined.violations));
  assert.ok(rules(inlined).includes("begin-beyond-first"));
  // the rollback file itself is an APPLY file: its own begin/commit is allowed
  assert.equal(classifyFile("supabase/migrations/PROPOSED_20261013120000_agent_capabilities_rollback.sql", rollbackFile).cls, "apply");
});

test("linter: every forbidden construct in a fixture is reported", () => {
  const cases = [
    ["begin;\nselect 1;\ncommit;", "commit"],
    ["begin;\nselect 1;\nend;", "commit"],
    ["begin;\nselect 1;\nabort;", "commit"],
    ["begin;\nselect 1;\nrollback;\nselect 2;", "rollback-not-final"],
    ["begin;\nrollback;\nbegin;\nrollback;", "begin-beyond-first"],
    ["select 1;\nbegin;\nselect 2;\nrollback;", "begin-not-first"],
    ["begin;\nsavepoint a;\nrollback;", "savepoint"],
    ["begin;\nrelease a;\nrollback;", "savepoint"],
    ["begin;\nselect 1;\nrollback to savepoint a;\nrollback;", "savepoint"],
    ["begin;\nselect 1;\nrollback and chain;", "rollback-chain"],
    ["prepare transaction 'x';", "two-phase"],
    ["commit prepared 'x';", "two-phase"],
    ["\\i other.sql", "include"],
    ["\\ir other.sql", "include"],
    ["\\include other.sql", "include"],
    ["\\include_relative other.sql", "include"],
    ["\\connect prod", "connect"],
    ["\\c postgres", "connect"],
    ["select 'commit' \\gexec", "meta-command"],
    ["\\! psql $SOMETHING", "meta-command"],
    ["\\set AUTOCOMMIT off", "autocommit"],
    ["set session authorization postgres;", "session-authorization"],
    ["reset session authorization;", "session-authorization"],
    ["call public.some_procedure();", "call"],
    ["do $$ begin commit; end $$;", "body-transaction-control"],
    ["do $x$ begin perform 1; rollback; end $x$;", "body-transaction-control"],
    ["do $$ begin execute 'commit'; end $$;", "body-transaction-control"],
    ["select dblink_exec('dbname=x', 'insert into t values (1)');", "dblink"],
    ["select pg_read_file('/tmp/x.sql');", "file-reference"],
    ["copy t from '/tmp/x.csv';", "file-reference"],
    ["rollback;", "rollback-without-begin"],
  ];
  for (const [src, rule] of cases) {
    const r = lint(src);
    assert.ok(rules(r).includes(rule), `${JSON.stringify(src)} → expected ${rule}, got ${JSON.stringify(rules(r))}`);
  }
});

test("linter: legitimate fixture shapes pass (one leading BEGIN, one final ROLLBACK, PL/pgSQL blocks, temp tables, quoted words)", () => {
  const ok = [
    "\\set ON_ERROR_STOP on\nbegin;\ndo $$\nbegin\n  if true then raise notice 'x'; end if;\nend\n$$;\nrollback;",
    "begin read only;\nselect 1;\nrollback;",
    "do $t$ declare n int; begin select 1 into n; exception when others then null; end $t$;",
    "begin;\ncreate temp table t on commit drop as select 1;\nselect 'commit; rollback; \\ir x' as s; -- \\ir y.sql commit;\nrollback;",
    "/* begin; commit; */ select 1;",
    "select 1 \\gset\n\\if :x\n\\echo 'ok'\n\\endif",
    "do $$ begin perform set_config('agent.rollback_discard_data', 'on', true); end $$;",
    "select E'it''s \\\\ commit;';",
  ];
  for (const src of ok) assert.deepEqual(lint(src).violations, [], src);
  // conservative: dollar-quoted text is treated as code
  assert.ok(rules(lint("select $q$ commit; $q$;")).includes("body-transaction-control"));
});

test("linter: classification — names, explicit declarations, and headers that only POINT AT a pretest", () => {
  assert.equal(classifyFile("supabase/migrations/PROPOSED_x_pretest.sql", "").kind, "pretest");
  assert.equal(classifyFile("supabase/migrations/PROPOSED_x_posttest.sql", "").kind, "posttest");
  assert.equal(classifyFile("supabase/migrations/PROPOSED_x_rollback_posttest.sql", "").kind, "posttest");
  assert.equal(classifyFile("supabase/migrations/PROPOSED_x_verify.sql", "").kind, "verify");
  assert.equal(classifyFile("supabase/tests/a_test.sql", "").cls, "fixture");
  assert.equal(classifyFile("supabase/migrations/x.sql", "-- lc-fixture: rollback-only\nselect 1;").kind, "rollback-only");
  assert.equal(classifyFile("supabase/migrations/x.sql", "-- PRETEST for PROPOSED_y.sql\nselect 1;").cls, "fixture");
  assert.equal(classifyFile("supabase/migrations/x.sql", "-- Rollback-only: every change is undone\nselect 1;").cls, "fixture");
  assert.equal(classifyFile("supabase/migrations/x.sql", "-- Pretest: PROPOSED_x_pretest.sql\nbegin;\ncommit;").cls, "apply", "a header that names its pretest is not a fixture");
  assert.equal(classifyFile("supabase/rollbacks/x.rollback.sql", "-- Rollback-only test: run inside one txn\nbegin;\ncommit;").cls, "apply");
  assert.equal(classifyFile("supabase/migrations/x_rollback.sql", "begin;\ncommit;").cls, "apply");
});

test("linter: the repository is clean — every pretest / posttest / verify / test fixture passes", () => {
  const results = lintFiles(listCandidateFiles(REPO), REPO);
  const fixtures = results.filter((r) => r.cls === "fixture");
  assert.ok(fixtures.length >= 40, `fixtures found: ${fixtures.length}`);
  const bad = fixtures.filter((r) => r.violations.length);
  assert.deepEqual(bad.map((r) => `${r.file}: ${r.violations.map((v) => `${v.line} ${v.rule}`).join(", ")}`), []);
  // the files restructured in rc-8.5.15.1 are among them
  for (const f of [
    "supabase/migrations/PROPOSED_20261012140000_intel_runtime_pretest.sql",
    "supabase/migrations/PROPOSED_20261012140000_intel_runtime_posttest.sql",
    "supabase/migrations/PROPOSED_20261013120000_agent_capabilities_posttest.sql",
    "supabase/migrations/PROPOSED_20261013160000_conversation_ai_shadow_rollback_posttest.sql",
    "supabase/migrations/PROPOSED_20261013161000_conversation_decide_event_budget_rollback_posttest.sql",
    "supabase/migrations/PROPOSED_20261008110000_unlock_stale_jobs_status_predicate_posttest.sql",
    "supabase/migrations/PROPOSED_20261007170000_graph_sender_coverage_routing_v2_posttest.sql",
    "supabase/migrations/PROPOSED_20261015120000_repeat_asking_price_question_kind_posttest.sql",
    "supabase/migrations/PROPOSED_20261015110000_block_repeat_asking_price_mirror_posttest.sql",
    "supabase/migrations/PROPOSED_20261015130000_message_origin_ai_generated_messages_posttest.sql",
    "supabase/migrations/PROPOSED_20261014121000_runtime_kind_limits_event_budget_posttest.sql",
    "supabase/migrations/PROPOSED_20261014121000_runtime_kind_limits_event_budget_rollback_posttest.sql",
    "supabase/migrations/PROPOSED_20261014150000_ops_health_snapshot_delivery_ref_posttest.sql",
    "supabase/tests/operator_lockdown_test.sql",
    "supabase/tests/campaign_audience_completeness_test.sql",
  ]) assert.ok(fixtures.some((r) => r.file === f), f);
});

// ── the production-target scan ──────────────────────────────────────────────

test("scan: production identifiers, the URL file and secret READS are caught in test harnesses", () => {
  const ref = ["lcppdrmrdf", "blstpcbgpf"].join("");
  const hits = (src, scope = "test") => scanSource("apps/api/tests/critical/x.test.mjs", src, scope).map((f) => f.rule);
  assert.deepEqual(hits(`const url = 'postgres://postgres.${ref}:pw@host/db'`), ["prod-ref"]);
  assert.deepEqual(hits("host: 'aws-1-us-west-2.pooler.supabase.com'"), ["pooler-host"]);
  assert.deepEqual(hits("const u = 'db.abcdefghijklmnopqrst.supabase.co'"), ["pooler-host"]);
  assert.deepEqual(hits("fs.readFileSync('/tmp/.dburl', 'utf8')"), ["dburl-file"]);
  assert.deepEqual(hits("new pg.Client({ connectionString: process.env.SUPABASE_DB_URL })"), ["prod-secret-env"]);
  assert.deepEqual(hits("createClient(url, process.env['SUPABASE_SERVICE_ROLE_KEY'])"), ["prod-secret-env"]);
  assert.deepEqual(hits('psql "$SUPABASE_DB_URL" -f x.sql'), ["prod-secret-env"]);
  assert.deepEqual(hits("psql ${SUPABASE_DB_URL} -f x.sql"), ["prod-secret-env"]);
  assert.deepEqual(hits("key = os.environ['SUPABASE_SERVICE_ROLE_KEY']"), ["prod-secret-env"]);
  assert.deepEqual(hits("const k = env.SUPABASE_SERVICE_ROLE_KEY"), ["prod-secret-env"]);
  // placeholders, deletion and mentions are not reads
  assert.deepEqual(hits('process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";'), []);
  assert.deepEqual(hits("delete process.env.SUPABASE_SERVICE_ROLE_KEY;"), []);
  assert.deepEqual(hits("const env = { SUPABASE_SERVICE_ROLE_KEY: 'svc' }"), []);
  assert.deepEqual(hits("delete envSnapshot.SUPABASE_DB_URL"), []);
  // CI: a test job handed the production secrets
  assert.deepEqual(scanSource(".github/workflows/x.yml", "  DB: ${{ secrets.SUPABASE_DB_URL }}", "workflow").map((f) => f.rule), ["ci-prod-secret"]);
});

test("scan: scope — tests, fixtures, harnesses and migration rehearsals; not ordinary app code", () => {
  const none = () => "";
  assert.equal(inScope("apps/api/tests/critical/a.test.mjs", none), "test");
  assert.equal(inScope("apps/dashboard/src/x.test.ts", none), "test");
  assert.equal(inScope("supabase/tests/a_test.sql", none), "test");
  assert.equal(inScope("supabase/migrations/PROPOSED_x_pretest.sql", none), "test");
  assert.equal(inScope("apps/api/scripts/ops/inbound-replay-harness.mjs", none), "test");
  assert.equal(inScope("apps/api/.env.test.local", none), "test");
  assert.equal(inScope(".github/workflows/cloudflare-staging.yml", none), "workflow");
  assert.equal(inScope("apps/api/scripts/x.mjs", () => "import pg from 'pg'; fs.readFileSync('supabase/migrations/PROPOSED_1_rollback.sql')"), "migration-harness");
  assert.equal(inScope("apps/api/src/lib/x.js", () => "export const x = 1"), false);
});

test("scan: the repository is clean, and every allowlisted exception still exists and names its reason", () => {
  const { scanned, findings } = scanRepo(REPO);
  assert.ok(scanned > 500, `files in scope: ${scanned}`);
  assert.deepEqual(findings.map((f) => `${f.file}:${f.line} [${f.rule}]`), []);
  for (const [file, entry] of Object.entries(ALLOWLIST)) {
    assert.ok(fs.existsSync(path.join(REPO, file)), `allowlisted file exists: ${file}`);
    assert.ok(entry.reason && entry.rules.length, file);
  }
});
