/**
 * scoped-canary-null-campaign-contract.test.mjs
 *
 * Static contract for the NULL-campaign scoped-canary seam.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE
 *   These two migrations change a Postgres FUNCTION and a COLUMN constraint, so
 *   the authoritative proof is the A-N matrix executed against Postgres (run
 *   inside a transaction that is rolled back by a terminal RAISE, so no fixture
 *   ever persists). Its results are recorded in EXPECTED_CLAIM_MATRIX below.
 *
 *   What a static test adds is a REGRESSION FLOOR: if someone later rewrites
 *   these migrations, or hand-edits the RPC and regenerates them, the guards
 *   this seam depends on must still be present. Text can only prove the
 *   migration SAYS something; the executed matrix proved the database DOES it.
 *
 * THE SEAM
 *   queue_atomic_claim_send_row already performed NULL-safe symmetric campaign
 *   matching in both directions (IS DISTINCT FROM on the authorization and on
 *   the row). The only blocker to an exact-row canary for an ordinary seller
 *   row was an up-front rejection of a NULL p_campaign_id, plus a NOT NULL
 *   constraint on queue_canary_authorizations.campaign_id.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(__dirname, "..", "..", "supabase", "migrations");

const RPC_MIGRATION = "20260906120000_scoped_canary_null_campaign.sql";
const COL_MIGRATION = "20260906120100_scoped_canary_authorization_nullable_campaign.sql";

const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");

/**
 * Results of the executed A-N matrix (Postgres, rolled back).
 * Recorded so a reviewer can see the observed behaviour without re-running it,
 * and so the intent is version-controlled alongside the migration.
 */
const EXPECTED_CLAIM_MATRIX = Object.freeze({
  A_null_auth_null_request_null_row_allowlisted: { claimed: true, reason: "claimed" },
  B_null_auth_campaign_row: { claimed: false, reason: "scoped_canary_wrong_campaign_row" },
  C_campaign_auth_null_row: { claimed: false, reason: "scoped_canary_wrong_campaign_row" },
  D_campaign_auth_campaign_row: { claimed: true, reason: "claimed" },
  E_campaign_auth_wrong_request: { claimed: false, reason: "authorization_campaign_mismatch" },
  F_row_not_allowlisted: { claimed: false, reason: "authorization_row_not_allowlisted" },
  G_expired: { claimed: false, reason: "authorization_expired" },
  H_consumed: { claimed: false, reason: "authorization_already_consumed" },
  I_wrong_token: { claimed: false, reason: "authorization_token_invalid" },
  // J was proven in an ISOLATED local Postgres (PGlite, PG18) rather than
  // against the shared project, because it is the one case that requires
  // queue_execution_mode to hold a value other than 'scoped_canary_only' --
  // and that key is shared containment, not an environment-scoped setting.
  // Fidelity was established by md5(prosrc) equality with production for
  // queue_atomic_claim_send_row and all five helpers it calls.
  // See scripts/scoped-canary-case-j-proof.mjs.
  J_mode_not_scoped_canary_only: { claimed: false, reason: "queue_execution_mode_not_scoped_canary_only" },
  K_processor_off_scoped_claim: { claimed: true, reason: "claimed" },
  L_processor_off_unrestricted: { claimed: false, reason: "queue_execution_mode_scoped_canary_only" },
  M_consumed_exactly_once: { consumed_at_set: true, claimed_row_ids_length: 1 },
  N_authorization_reuse: { claimed: false, reason: "authorization_already_consumed" },
});

test("the RPC migration removes ONLY the NULL-campaign rejection", () => {
  const sql = read(RPC_MIGRATION);
  // The old predicate is named as the search target, and the new one as the
  // replacement. Both must be present as literals or the migration is not the
  // one this contract was written against.
  assert.match(sql, /IF p_canary_run_id IS NULL OR p_authorization_token_hash IS NULL OR p_campaign_id IS NULL THEN/);
  assert.match(sql, /IF p_canary_run_id IS NULL OR p_authorization_token_hash IS NULL THEN/);
});

test("the RPC migration patches by substitution, never by retyping the body", () => {
  const sql = read(RPC_MIGRATION);
  // Rewriting 247 lines by hand is how unrelated logic silently drifts.
  assert.match(sql, /pg_get_functiondef/);
  assert.match(sql, /replace\(v_def, v_old_pred, v_new_pred\)/);
  // And it must refuse a body it does not recognise.
  assert.match(sql, /refusing to patch/);
  assert.match(sql, /exactly one occurrence/);
});

test("the RPC migration asserts every safety guard survives the rewrite", () => {
  const sql = read(RPC_MIGRATION);
  for (const guard of [
    "v_auth.campaign_id IS DISTINCT FROM p_campaign_id",
    "v_row.campaign_id IS DISTINCT FROM p_campaign_id",
    "authorization_row_not_allowlisted",
    "v_processor = ''off''",
  ]) {
    assert.ok(sql.includes(guard), `migration must assert the guard survives: ${guard}`);
  }
});

test("the RPC migration is idempotent", () => {
  const sql = read(RPC_MIGRATION);
  assert.match(sql, /already applied; nothing to do/);
});

test("the column migration drops NOT NULL on campaign_id only", () => {
  const sql = read(COL_MIGRATION);
  assert.match(sql, /ALTER COLUMN campaign_id DROP NOT NULL/);
  // queue_row_ids is the actual scope of an authorization and must stay required.
  assert.match(sql, /queue_row_ids must remain NOT NULL/);
  // It must not touch any other column or table.
  assert.ok(!/DROP COLUMN|ADD COLUMN|DROP TABLE|TRUNCATE|DELETE FROM|UPDATE public\./i.test(sql),
    "column migration must not mutate data or other schema");
});

test("neither migration reinterprets existing authorization rows", () => {
  for (const name of [RPC_MIGRATION, COL_MIGRATION]) {
    const sql = read(name);
    assert.ok(!/UPDATE public\.queue_canary_authorizations/i.test(sql),
      `${name} must not rewrite existing authorizations`);
    assert.ok(!/DELETE FROM public\.queue_canary_authorizations/i.test(sql),
      `${name} must not delete existing authorizations`);
  }
});

test("neither migration MUTATES system_control or queue execution controls", () => {
  // Mentioning a control in a comment is fine and in fact desirable -- the RPC
  // migration documents that it preserves the unrestricted path's
  // queue_processor_mode='off' denial. What must not appear is a WRITE.
  for (const name of [RPC_MIGRATION, COL_MIGRATION]) {
    const sql = read(name);
    assert.ok(!/UPDATE\s+(public\.)?system_control/i.test(sql),
      `${name} must not update system_control`);
    assert.ok(!/INSERT\s+INTO\s+(public\.)?system_control/i.test(sql),
      `${name} must not insert into system_control`);
    assert.ok(!/DELETE\s+FROM\s+(public\.)?system_control/i.test(sql),
      `${name} must not delete from system_control`);
  }
});

test("the recorded matrix keeps campaign isolation symmetric in both directions", () => {
  const m = EXPECTED_CLAIM_MATRIX;
  // A NULL authorization must not reach a campaign row, and a campaign
  // authorization must not reach a NULL row. Both deny on the ROW guard.
  assert.equal(m.B_null_auth_campaign_row.claimed, false);
  assert.equal(m.C_campaign_auth_null_row.claimed, false);
  assert.equal(m.B_null_auth_campaign_row.reason, "scoped_canary_wrong_campaign_row");
  assert.equal(m.C_campaign_auth_null_row.reason, "scoped_canary_wrong_campaign_row");
});

test("the recorded matrix shows existing campaign canaries still work", () => {
  assert.equal(EXPECTED_CLAIM_MATRIX.D_campaign_auth_campaign_row.claimed, true);
});

test("the recorded matrix shows the allowlist remains mandatory", () => {
  assert.equal(EXPECTED_CLAIM_MATRIX.F_row_not_allowlisted.reason, "authorization_row_not_allowlisted");
});

test("the recorded matrix shows the scoped seam requires scoped_canary_only mode", () => {
  // The seam is not a way around containment: it only opens while the operator
  // has deliberately put the queue in scoped_canary_only. Every other mode --
  // including an ABSENT control key and an unrecognised value, both of which
  // normalize to 'stopped' -- denies, consumes no authorization and locks no row.
  assert.equal(EXPECTED_CLAIM_MATRIX.J_mode_not_scoped_canary_only.claimed, false);
  assert.equal(
    EXPECTED_CLAIM_MATRIX.J_mode_not_scoped_canary_only.reason,
    "queue_execution_mode_not_scoped_canary_only",
  );
});

test("the recorded matrix shows processor_off blocks unrestricted but not scoped", () => {
  // The whole point of the seam: an explicitly authorized single row proceeds
  // while the global processor stays off, and unrestricted traffic does not.
  assert.equal(EXPECTED_CLAIM_MATRIX.K_processor_off_scoped_claim.claimed, true);
  assert.equal(EXPECTED_CLAIM_MATRIX.L_processor_off_unrestricted.claimed, false);
});

test("the recorded matrix shows one-time consumption", () => {
  assert.equal(EXPECTED_CLAIM_MATRIX.M_consumed_exactly_once.consumed_at_set, true);
  assert.equal(EXPECTED_CLAIM_MATRIX.M_consumed_exactly_once.claimed_row_ids_length, 1);
  assert.equal(EXPECTED_CLAIM_MATRIX.N_authorization_reuse.reason, "authorization_already_consumed");
});
