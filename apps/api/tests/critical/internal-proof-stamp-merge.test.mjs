// ─── internal-proof-stamp-merge.test.mjs ─────────────────────────────────────
// Static contract tests for the internal_proof_stamp_queue_row migration —
// the atomic server-side jsonb merge that closes the runbook stamp-reply
// read-modify-write race.
//
// The repo has no live-DB migration harness in CI, so (like
// launch-containment-migrations.test.mjs) these are text-level assertions on
// the SQL, plus the JS-side wiring contract. The REAL concurrency proof runs
// against a disposable Postgres via
// scripts/proof/internal-proof-stamp-concurrency-proof.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(
  __dirname,
  "../../supabase/migrations/20260802092000_internal_proof_stamp_merge.sql"
);

const FN =
  "public\\.internal_proof_stamp_queue_row\\(uuid, text, uuid, uuid, jsonb, text, text\\)";

test("stamp-merge migration exists", () => {
  assert.ok(fs.existsSync(migrationPath), `missing ${migrationPath}`);
});

test("stamp allowlist is hard-coded to exactly the five contract keys", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  for (const key of [
    "internal_canary",
    "campaign_id_stamped_for_internal_proof",
    "campaign_stamped_at",
    "internal_proof_session_id",
    "internal_proof_processing_run_id",
  ]) {
    assert.match(sql, new RegExp(`'${key}'`), `allowlist must contain ${key}`);
  }
  // Rejection of any other key must be a first-class outcome.
  assert.match(sql, /stamp_key_not_allowed/);
});

test("merge is a server-side jsonb concatenation, never a whole-object replace", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /metadata\s*=\s*COALESCE\(metadata,\s*'\{\}'::jsonb\)\s*\|\|/);
});

test("write is CASed on queue_status and the observed campaign state", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /AND queue_status = v_expected_status/);
  assert.match(sql, /p_expected_campaign_id IS NULL AND campaign_id IS NULL/);
  assert.match(sql, /OR campaign_id = p_expected_campaign_id/);
  assert.match(sql, /OR campaign_id = p_campaign_id/);
});

test("zero-row match is a first-class refusal with diagnostics", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /row_not_in_expected_state/);
  assert.match(sql, /row_not_found/);
});

test("function is locked down to service_role only", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${FN} FROM PUBLIC`));
  assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${FN} FROM anon, authenticated`));
  assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION ${FN} TO service_role`));
});

test("runbook stamp-reply has no client-side metadata write path left", () => {
  const runbook = fs.readFileSync(
    path.resolve(__dirname, "../../scripts/ops/internal-proof-runbook.mjs"),
    "utf8"
  );
  // The stamp step must call the RPC…
  assert.match(runbook, /internal_proof_stamp_queue_row/);
  // …and the old racy snapshot merge must be gone.
  assert.doesNotMatch(runbook, /\.\.\.\(reply\.metadata \|\| \{\}\)/);
  // Missing-function handling names the migration instead of falling back.
  assert.match(runbook, /20260802092000_internal_proof_stamp_merge\.sql/);
});
