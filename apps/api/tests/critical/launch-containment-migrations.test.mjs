/**
 * Static contract tests for the two launch-containment migrations.
 *
 * The repo has no live-DB migration harness (no local Postgres in CI, no replay
 * gate), so these follow the existing pattern in
 * inbound-intelligence-migration.test.mjs: assert the SQL text carries the
 * security and behavioural clauses the launch depends on. Execution
 * verification happens as a transaction-safe BEGIN/ROLLBACK check against
 * production before the real apply.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../supabase/migrations");

const securityAddendumPath = path.join(
  migrationsDir,
  "20260729193000_launch_containment_security_addendum.sql",
);
const updatedAtPath = path.join(
  migrationsDir,
  "20260729194000_send_queue_content_aware_updated_at.sql",
);
const burstBasePath = path.join(migrationsDir, "20260726120000_seller_inbound_bursts.sql");

/** Drop `--` line comments so a prose mention can never satisfy a contract assertion. */
const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, "");

/**
 * Split the addendum on its `-- ── N.` section headers so each assertion is
 * scoped to the block it is actually about. Without this, the section-4 generic
 * loop can satisfy a search_path assertion even if the section-2
 * claim_seller_inbound_burst pin has been removed.
 */
const addendumSection = (sql, n) => {
  const section = sql
    .split(/^-- ── (?=\d+\.)/m)
    .find((part) => part.startsWith(`${n}.`));
  assert.ok(section, `addendum section ${n} not found — section headers changed`);
  return stripSqlComments(section);
};

// ── E. burst security addendum ───────────────────────────────────────────────

test("security addendum enables RLS and revokes public access on seller_inbound_bursts", () => {
  const sql = fs.readFileSync(securityAddendumPath, "utf8");
  assert.match(sql, /ALTER TABLE public\.seller_inbound_bursts ENABLE ROW LEVEL SECURITY/);
  for (const role of ["PUBLIC", "anon", "authenticated"]) {
    assert.match(
      sql,
      new RegExp(`REVOKE ALL ON TABLE public\\.seller_inbound_bursts FROM ${role}`),
      `must revoke ${role} on seller_inbound_bursts`,
    );
  }
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.seller_inbound_bursts TO service_role/,
  );
});

test("security addendum pins search_path and minimises EXECUTE on the claim RPC", () => {
  const sql = fs.readFileSync(securityAddendumPath, "utf8");
  assert.match(sql, /claim_seller_inbound_burst/);

  // `extensions` is mandatory, not cosmetic: the claim body calls
  // gen_random_bytes() (pgcrypto), which is installed in the `extensions`
  // schema. A `public, pg_temp` pin makes every claim raise
  // "function gen_random_bytes(integer) does not exist".
  //
  // Scoped to section 2 (the claim RPC block) so the section-4 generic loop
  // cannot satisfy this assertion on the claim RPC's behalf.
  const claimSection = addendumSection(sql, 2);
  assert.match(claimSection, /claim_seller_inbound_burst/);
  assert.match(
    claimSection,
    /ALTER FUNCTION %s SET search_path = public, extensions, pg_temp/,
    "the claim RPC pin itself must include the extensions schema",
  );

  // Section 4 pins any unpinned SECURITY DEFINER function; it must not
  // reintroduce an extensions-less path either.
  assert.match(
    addendumSection(sql, 4),
    /ALTER FUNCTION %s SET search_path = public, extensions, pg_temp/,
  );

  // Belt-and-braces across the whole file, comments stripped.
  assert.doesNotMatch(
    stripSqlComments(sql),
    /SET search_path = public, pg_temp/,
    "no search_path pin in this migration may omit the extensions schema",
  );

  assert.match(sql, /REVOKE ALL ON FUNCTION %s FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION %s TO service_role/);
  // Must NOT redefine the function: claim/reclaim/finalize semantics from PR #54
  // have to survive byte-for-byte, so ALTER is used instead of CREATE OR REPLACE.
  assert.doesNotMatch(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.claim_seller_inbound_burst/i);
  assert.match(sql, /ALTER FUNCTION %s SET search_path/);
});

test("security addendum locks down the launch alert sink and queue audit tables", () => {
  const sql = fs.readFileSync(securityAddendumPath, "utf8");
  for (const tbl of [
    "notification_events",
    "notification_action_audit",
    "ops_notifications",
    "send_queue_lifecycle_guard_events",
    "queue_claim_audit",
    "queue_canary_execution_audits",
  ]) {
    assert.match(sql, new RegExp(`'${tbl}'`), `${tbl} must be included in the lockdown list`);
  }
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.%I FROM anon/);
});

test("security addendum revokes PUBLIC execute from the SECURITY DEFINER delivery function", () => {
  const sql = fs.readFileSync(securityAddendumPath, "utf8");
  assert.match(sql, /'reconcile_delivery_receipt'/);
  assert.match(sql, /prosecdef/);
  assert.match(sql, /REVOKE ALL ON FUNCTION %s FROM PUBLIC/);
});

test("security addendum is object-existence guarded so it cannot half-fail", () => {
  const sql = fs.readFileSync(securityAddendumPath, "utf8");
  assert.match(sql, /to_regclass\('public\.seller_inbound_bursts'\) IS NULL/);
  assert.match(sql, /RAISE NOTICE/);
  // Every DDL statement runs inside a DO block guard.
  assert.doesNotMatch(sql, /^\s*ALTER TABLE public\.notification_events/m);
});

test("base burst migration still lacks RLS, proving the addendum is required", () => {
  // If this ever fails, the addendum overlaps the base migration and the two
  // must be reconciled rather than both applied blindly.
  const sql = fs.readFileSync(burstBasePath, "utf8");
  assert.doesNotMatch(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /GRANT\s+EXECUTE/i);
  assert.match(sql, /idx_seller_inbound_bursts_one_open_per_thread/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.claim_seller_inbound_burst/);
  // Documents the coupling that forces `extensions` onto the addendum's pinned
  // search_path. Comments are stripped so a prose mention cannot satisfy it, and
  // the match is anchored to the actual claim-token expression rather than the
  // bare identifier. If this call is ever removed, re-derive the required schema
  // list rather than assuming `extensions` is still needed.
  assert.match(
    stripSqlComments(sql),
    /encode\(\s*gen_random_bytes\(\s*16\s*\)\s*,\s*'hex'\s*\)/,
    "claim token must still derive from pgcrypto's gen_random_bytes",
  );
});

// ── G. content-aware updated_at ──────────────────────────────────────────────

test("updated_at trigger only bumps on real content change", () => {
  const sql = fs.readFileSync(updatedAtPath, "utf8");
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.send_queue_touch_updated_at/);
  // The content comparison must ignore updated_at itself, else it always differs.
  assert.match(
    sql,
    /\(to_jsonb\(NEW\) - 'updated_at'\) IS NOT DISTINCT FROM \(to_jsonb\(OLD\) - 'updated_at'\)/,
  );
  // Unchanged row preserves the previous audit timestamp...
  assert.match(sql, /NEW\.updated_at := OLD\.updated_at/);
  // ...and a genuine change still bumps it (audit timestamps not weakened).
  assert.match(sql, /NEW\.updated_at := now\(\)/);
});

test("updated_at trigger replaces the legacy unconditional trigger and fires last", () => {
  const sql = fs.readFileSync(updatedAtPath, "utf8");
  assert.match(sql, /DROP TRIGGER IF EXISTS update_send_queue_timestamp ON public\.send_queue/);
  // BEFORE triggers fire alphabetically; the zz_ prefix keeps the touch after
  // guard_send_queue_execution_mode and guard_send_queue_stale_expiration, so a
  // guard's silent revert is visible as "no content change".
  assert.match(sql, /CREATE TRIGGER zz_send_queue_touch_updated_at/);
  assert.match(sql, /BEFORE INSERT OR UPDATE ON public\.send_queue/);
  assert.match(sql, /SET search_path = public, pg_temp/);
});

test("guard trigger still blocks by reverting, which is why the touch must be content-aware", () => {
  // Documents the coupling: if the guard is ever changed to RAISE instead of
  // reverting, the content-aware touch becomes redundant rather than wrong.
  const guardPath = path.join(
    migrationsDir,
    "20260701150000_send_queue_stale_expiration_guard.sql",
  );
  const sql = fs.readFileSync(guardPath, "utf8");
  assert.match(sql, /NEW\.queue_status\s*:=\s*OLD\.queue_status/);
  assert.match(sql, /FUTURE_ROW_EXPIRATION_BLOCKED/);
});
