/**
 * s12-callback-migration-contract.test.mjs
 *
 * Static contract for the §11 Slice 2 callback ledger migration.
 *
 * Text can only prove the migration SAYS something. It is paired with an
 * executed proof against real Postgres, because the §11 Slice 1 migration
 * shipped a `v_conflict || 'decision_id'` that every static scan accepted and
 * that Postgres rejected at runtime with 22P02 -- the entire identity-conflict
 * path was dead and only execution found it.
 *
 * Comments are stripped with the SHARED quote-aware scanner, never a regex.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripSqlLineComments } from "../helpers/sql-comment-stripper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  __dirname, "../../supabase/migrations/20260906060000_seller_provider_callback_events.sql");

const RAW = fs.readFileSync(MIGRATION, "utf8");
const SQL = stripSqlLineComments(RAW);

test("the ledger is append-only and its evidence is immutable", () => {
  assert.match(SQL, /CREATE TRIGGER trg_seller_provider_callback_events_immutable/);
  assert.match(SQL, /BEFORE UPDATE OR DELETE ON public\.seller_provider_callback_events/,
    "DELETE must be trapped too: deleting evidence is how a duplicate becomes replayable");
  for (const col of [
    "callback_fingerprint", "provider_message_sid", "provider_status",
    "to_phone_number", "from_phone_number", "provider_event_at",
    "raw_evidence_hash", "received_at", "trust_class", "signature_verified",
  ]) {
    assert.ok(
      SQL.includes(`NEW.${col} IS DISTINCT FROM OLD.${col}`),
      `${col} must be pinned immutable -- it is received evidence, not interpretation`);
  }
});

test("one canonical event per fingerprint, unconditionally", () => {
  const m = SQL.match(
    /CREATE UNIQUE INDEX[^;]*uq_seller_provider_callback_events_fingerprint[^;]*;/);
  assert.ok(m, "the dedupe index must exist");
  assert.ok(!/WHERE/i.test(m[0]),
    "a PARTIAL dedupe index would leave a class of callbacks undeduplicated");
});

test("the get-or-create hands the race loser the canonical row", () => {
  // This is the defect the migration's own comment described and the code did
  // not implement: DO NOTHING returns zero rows to the loser, which then
  // re-SELECTs a row the winner has not committed and finds nothing.
  assert.match(SQL, /ON CONFLICT \(callback_fingerprint\) DO UPDATE/,
    "DO NOTHING cannot return the canonical row to a concurrent loser");
  assert.ok(!/ON CONFLICT \(callback_fingerprint\) DO NOTHING/.test(SQL));
  assert.match(SQL, /SET provider = public\.seller_provider_callback_events\.provider/,
    "the conflict update must be a self-assignment: it may carry no new information");
});

test("both functions are SECURITY DEFINER with a pinned search_path", () => {
  const fns = SQL.split("CREATE OR REPLACE FUNCTION").slice(1);
  const guarded = fns.filter((f) => /SECURITY DEFINER/.test(f));
  assert.equal(guarded.length, 2, "both RPCs, and only those, are SECURITY DEFINER");
  for (const f of guarded) {
    assert.match(f, /SET search_path = public, extensions, pg_temp/,
      "extensions must be on the path: gen_random_uuid/pgcrypto live there, and "
      + "omitting it is exactly what broke a prior launch migration");
  }
});

test("the ledger is service-role only", () => {
  assert.match(SQL, /ALTER TABLE public\.seller_provider_callback_events ENABLE ROW LEVEL SECURITY/);
  assert.match(SQL, /REVOKE ALL ON public\.seller_provider_callback_events FROM anon, authenticated/);
  const grants = SQL.match(/GRANT EXECUTE ON FUNCTION[^;]*;/g) || [];
  assert.equal(grants.length, 2);
  for (const g of grants) {
    assert.match(g, /TO service_role/);
    assert.ok(!/anon|authenticated|PUBLIC/.test(g), "no ambient grantee may execute these");
  }
});

test("orphan adoption cannot be loosened without failing this test", () => {
  // Each of these predicates is load-bearing. Dropping any one turns strict
  // adoption into a guess about which seller a receipt belongs to.
  for (const guard of [
    "a.provider_request_started_at IS NOT NULL",
    "a.provider_message_id IS NULL",
    "c.delivery_possibility IN ('may_have_been_sent', 'unknown')",
    "c.state NOT IN ('delivered', 'no_send', 'suppressed', 'cancelled')",
    "a.provider_request_started_at BETWEEN p_window_start AND p_window_end",
    "c.to_phone_number IS NOT DISTINCT FROM p_to_phone",
  ]) {
    const n = SQL.split(guard).length - 1;
    assert.equal(n, 2, `${guard} must guard BOTH the count and the fetch`);
  }
  assert.match(SQL, /'adoptable', \(v_count = 1\)/,
    "adoption is permitted at exactly one candidate: zero is unknown, two is a guess");
});

test("no array-concat against a bare literal, the 22P02 that killed Slice 1", () => {
  assert.ok(!/\|\|\s*'[a-z_]+'\s*;/.test(SQL),
    "text[] || <untyped literal> parses as array-concat and fails at runtime; use array_append");
});

test("the migration is re-runnable", () => {
  const creates = SQL.match(/CREATE (TABLE|UNIQUE INDEX|INDEX)[^;]*/g) || [];
  for (const c of creates) {
    assert.match(c, /IF NOT EXISTS/, `not re-runnable: ${c.slice(0, 60)}`);
  }
  assert.match(SQL, /DROP TRIGGER IF EXISTS trg_seller_provider_callback_events_immutable/,
    "the trigger must be dropped before recreation or a re-run errors");
});

test("adoption and binding cannot disagree", () => {
  assert.match(SQL, /adoption_status NOT IN \('bound_known_sid', 'orphan_adopted'\)\s*OR bound_attempt_id IS NOT NULL/,
    "an adopted event with no binding is a claim with no referent");
  assert.match(SQL, /adoption_status NOT IN \('orphan_unmatched', 'orphan_ambiguous'\)\s*OR bound_attempt_id IS NULL/,
    "an unmatched event carrying a binding is a misattribution already committed");
});
