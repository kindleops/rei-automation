/**
 * logical-communication-migration-contract.test.mjs
 *
 * Static contract for the §11 Slice 1 migration.
 *
 * PARSING NOTE, LEARNED THE HARD WAY.
 *   An earlier scope test in this repo stripped comments with
 *   /\/\*[\s\S]*?\*\//g and was silently fooled by the cron literal
 *   "*\/5 * * * *", whose embedded terminator mispaired the regex and swallowed
 *   real code. Every assertion in that file was then reading mangled text.
 *
 *   So this file does NOT use a regex stripper. It removes `--` comments with a
 *   QUOTE-AWARE line scanner, because this migration contains a CHECK regex
 *   ('^lck_v[0-9]+:[a-z_]+:[0-9a-f]{64}$') where a `$` and a `-` live inside a
 *   string literal, and six $$-quoted function bodies. A character-level scanner
 *   that tracks quote state cannot be fooled by either.
 *
 *   The static contract is deliberately paired with an EXECUTED Postgres
 *   contract. Text can only prove the migration SAYS something; execution proves
 *   the database DOES it. Both are reported, and a disagreement is a failure.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  __dirname,
  "../../supabase/migrations/20260904090000_seller_logical_communications_and_attempts.sql"
);

/**
 * Remove `--` line comments WITHOUT being fooled by `--` inside a string
 * literal or a dollar-quoted body. Character-level, quote-aware.
 */
function stripSqlLineComments(sql) {
  const out = [];
  let inSingle = false;
  let inDollar = false;

  for (const line of sql.split("\n")) {
    let kept = "";
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const next = line[i + 1];

      if (!inSingle && ch === "$" && next === "$") {
        inDollar = !inDollar;
        kept += "$$";
        i += 1;
        continue;
      }
      if (!inDollar && ch === "'") {
        // '' is an escaped quote inside a literal, not a terminator.
        if (inSingle && next === "'") { kept += "''"; i += 1; continue; }
        inSingle = !inSingle;
        kept += ch;
        continue;
      }
      if (!inSingle && !inDollar && ch === "-" && next === "-") break; // comment
      kept += ch;
    }
    out.push(kept);
  }
  return out.join("\n");
}

const RAW = fs.readFileSync(MIGRATION, "utf8");
const SQL = stripSqlLineComments(RAW);

/** Case-insensitive whitespace-tolerant presence check on stripped SQL. */
function hasSql(fragment) {
  const needle = fragment.replace(/\s+/g, " ").trim().toLowerCase();
  return SQL.replace(/\s+/g, " ").toLowerCase().includes(needle);
}

// ── the stripper itself must be trustworthy ────────────────────────────────

test("the comment stripper is not fooled by quotes or dollar-quoting", () => {
  // The exact shapes that broke the previous naive stripper.
  const sample = [
    "SELECT 1; -- a real comment",
    "CHECK (k ~ '^lck_v[0-9]+:[a-z_]+:[0-9a-f]{64}$'), -- trailing comment",
    "SELECT '-- not a comment, it is inside a string';",
    "AS $$ BEGIN -- inside a function body\n RETURN 1; END; $$;",
  ].join("\n");
  const stripped = stripSqlLineComments(sample);

  assert.ok(!stripped.includes("a real comment"), "real comments must be removed");
  assert.ok(!stripped.includes("trailing comment"), "trailing comments must be removed");
  assert.ok(stripped.includes("'^lck_v[0-9]+:[a-z_]+:[0-9a-f]{64}$'"),
    "the CHECK regex literal must survive intact");
  assert.ok(stripped.includes("'-- not a comment, it is inside a string'"),
    "a -- inside a string literal must survive");
  assert.ok(stripped.includes("RETURN 1;"), "code inside a $$ body must survive");
});

test("stripping did not destroy the migration", () => {
  // Guards against a stripper bug silently emptying the text and making every
  // "must contain" assertion below vacuous in the other direction.
  assert.ok(SQL.length > RAW.length * 0.5, "stripped SQL is implausibly short");
  assert.ok(SQL.includes("CREATE TABLE IF NOT EXISTS public.seller_logical_communications"));
});

// ── tables ─────────────────────────────────────────────────────────────────

test("both canonical tables are created, additively", () => {
  assert.ok(hasSql("CREATE TABLE IF NOT EXISTS public.seller_logical_communications"));
  assert.ok(hasSql("CREATE TABLE IF NOT EXISTS public.seller_communication_attempts"));
  // Additive only: no destructive verb anywhere near the existing tables.
  for (const destructive of ["DROP TABLE", "TRUNCATE", "ALTER TABLE public.send_queue", "ALTER TABLE public.message_events"]) {
    assert.ok(!hasSql(destructive), `migration must not contain: ${destructive}`);
  }
});

// ── identity authority ─────────────────────────────────────────────────────

test("logical_key uniqueness is TOTAL, not partial or lifecycle-scoped", () => {
  assert.ok(hasSql("CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_logical_communications_logical_key"));
  const idx = SQL.slice(SQL.indexOf("uq_seller_logical_communications_logical_key"));
  const stmt = idx.slice(0, idx.indexOf(";"));
  assert.ok(stmt.includes("(logical_key)"), "must key on logical_key");
  assert.ok(!/\bWHERE\b/i.test(stmt),
    "a partial unique index would let a second row exist for the same action");
});

test("the logical key shape is enforced in the database", () => {
  assert.ok(hasSql("seller_logical_communications_key_shape"));
  assert.ok(SQL.includes("'^lck_v[0-9]+:[a-z_]+:[0-9a-f]{64}$'"),
    "the version-tagged key shape CHECK must be present and intact");
});

test("attempt numbering cannot collide", () => {
  assert.ok(hasSql("CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_communication_attempts_number"));
  assert.ok(hasSql("(logical_communication_id, attempt_number)"));
});

test("one provider message id binds to at most one attempt", () => {
  assert.ok(hasSql("uq_seller_communication_attempts_provider_message_id"));
  assert.ok(hasSql("WHERE provider_message_id IS NOT NULL"),
    "must be a partial unique index, since the column is nullable before a send");
});

// ── lineage + impossible states ────────────────────────────────────────────

test("source lineage is required per communication type, in SQL", () => {
  assert.ok(hasSql("seller_logical_communications_lineage_required"));
  for (const [type, anchor] of [
    ["'autonomous_reply'", "decision_id IS NOT NULL"],
    ["'monetary_offer'", "seller_offer_id IS NOT NULL AND seller_offer_version IS NOT NULL"],
    ["'campaign_touch'", "campaign_target_id IS NOT NULL AND touch_number IS NOT NULL"],
    ["'follow_up'", "follow_up_id IS NOT NULL"],
    ["'unknown_inbound_reply'", "message_event_id IS NOT NULL"],
    ["'manual_operator_send'", "operator_action_id IS NOT NULL"],
    ["'internal_canary'", "canary_run_id IS NOT NULL AND canary_leg IS NOT NULL"],
  ]) {
    assert.ok(hasSql(type), `lineage CHECK must cover ${type}`);
    assert.ok(hasSql(anchor), `lineage CHECK must require ${anchor}`);
  }
  // An unrecognised type must not slip through as "no rule applies".
  assert.ok(hasSql("ELSE false"), "an unknown communication_type must be rejected");
});

test("ambiguity cannot coexist with automatic retry authority", () => {
  assert.ok(hasSql("seller_logical_communications_ambiguous_is_absorbing"));
  assert.ok(hasSql("state = 'ambiguous_provider_outcome' OR delivery_possibility = 'may_have_been_sent'"));
  assert.ok(hasSql("retry_authority IN ('retry_allowed', 'retry_after')"));
});

test("resolved and forbidden outcomes cannot carry retry authority", () => {
  assert.ok(hasSql("seller_logical_communications_terminal_has_no_retry"));
  assert.ok(hasSql("state IN ('delivered', 'no_send', 'suppressed', 'cancelled', 'failed_terminal')"));
});

test("the two outcome axes are separately constrained", () => {
  assert.ok(hasSql("seller_logical_communications_delivery_possibility_valid"));
  assert.ok(hasSql("seller_logical_communications_retry_authority_valid"));
  for (const v of ["'definitely_not_sent'", "'may_have_been_sent'", "'provider_accepted'", "'delivered'", "'unknown'"]) {
    assert.ok(hasSql(v), `delivery_possibility must allow ${v}`);
  }
  for (const v of ["'retry_allowed'", "'retry_after'", "'retry_denied'", "'operator_hold'", "'terminal'"]) {
    assert.ok(hasSql(v), `retry_authority must allow ${v}`);
  }
});

// ── attempt evidence ───────────────────────────────────────────────────────

test("attempt evidence is append-only and set-once", () => {
  assert.ok(hasSql("CREATE OR REPLACE FUNCTION public.enforce_seller_communication_attempt_immutability"));
  assert.ok(hasSql("BEFORE UPDATE OR DELETE ON public.seller_communication_attempts"));
  assert.ok(hasSql("DELETE is not permitted"));
  for (const field of [
    "provider_request_started_at is immutable once set",
    "provider_message_id is immutable once set",
    "claimed_at is immutable once set",
    "completed_at is immutable once set",
  ]) {
    assert.ok(hasSql(field), `immutability trigger must protect: ${field}`);
  }
});

test("a provider SID implies the request actually went out", () => {
  assert.ok(hasSql("seller_communication_attempts_sid_implies_request"));
  assert.ok(hasSql("provider_message_id IS NULL OR provider_request_started_at IS NOT NULL"));
});

// ── atomic authority ───────────────────────────────────────────────────────

test("get-or-create is atomic and validates lineage on conflict", () => {
  assert.ok(hasSql("CREATE OR REPLACE FUNCTION public.seller_logical_communication_get_or_create"));
  assert.ok(hasSql("ON CONFLICT (logical_key) DO UPDATE"));
  assert.ok(hasSql("IS NOT DISTINCT FROM EXCLUDED"),
    "the conflict path must compare stored lineage against the caller's");
  assert.ok(hasSql("logical_communication_identity_conflict"),
    "a lineage mismatch must produce a deterministic conflict, not a silent reuse");
});

test("duplicate get-or-create does not fake a semantic mutation", () => {
  const fn = SQL.slice(
    SQL.indexOf("FUNCTION public.seller_logical_communication_get_or_create"),
    SQL.indexOf("FUNCTION public.seller_communication_attempt_allocate")
  );
  assert.ok(fn.includes("last_observed_at"), "replay must advance the observation timestamp");
  assert.ok(fn.includes("observation_count"), "replay must advance the observation counter");
  assert.ok(!/SET\s+updated_at/i.test(fn),
    "a replay is an observation, not a state transition: updated_at must not move");
});

test("attempt allocation locks the parent and refuses ambiguity", () => {
  assert.ok(hasSql("CREATE OR REPLACE FUNCTION public.seller_communication_attempt_allocate"));
  assert.ok(hasSql("FOR UPDATE"),
    "allocation must serialise on the parent row, not race on MAX()+1");
  assert.ok(hasSql("ambiguous_outcome_absorbing"),
    "an ambiguous parent must be refused before an attempt number is computed");
  assert.ok(hasSql("retry_authority_denies"));
  assert.ok(hasSql("state_forbids_attempt"));
});

test("text[] accumulation cannot be written as bare `|| 'literal'`", () => {
  // FOUND BY REAL INSTALL, NOT BY THIS FILE.
  //
  // The conflict path originally read `v_conflict := v_conflict || 'decision_id'`.
  // PL/pgSQL resolves `text[] || <untyped literal>` as ARRAY concatenation and
  // then tries to parse the string as an array literal:
  //
  //   ERROR 22P02: malformed array literal: "decision_id"
  //
  // So every identity-conflict return threw instead of reporting the conflict.
  // That path is the safety net for an lck_v1 bug or a genuine hash collision --
  // precisely the case where a silent throw is worst -- and it would have stayed
  // invisible until it mattered.
  //
  // No amount of static SQL scanning could have caught this: the text is
  // syntactically valid and only fails at EXECUTION. The lesson is the reason
  // the safe-install phase exists. This test pins the corrected form so the
  // shorter spelling cannot come back.
  const bad = [];
  for (const [i, line] of SQL.split("\n").entries()) {
    if (/:=\s*\w+\s*\|\|\s*'/.test(line)) bad.push(`${i + 1}: ${line.trim()}`);
  }
  assert.deepEqual(bad, [],
    `use array_append(); bare || with a literal is parsed as an array literal:\n  ${bad.join("\n  ")}`);

  assert.ok(SQL.includes("array_append(v_conflict,"),
    "the conflict path must accumulate via array_append");
});

test("an unresolved attempt blocks allocation of a sibling", () => {
  // The parent-state guards alone are NOT sufficient. Allocation sets the
  // parent to 'claimed', which is deliberately not a forbidden state, and the
  // two outcome axes still read definitely_not_sent / retry_allowed until the
  // first worker gets an answer from the provider. A second worker released
  // from the FOR UPDATE therefore passes every other check. Verified by
  // mutation: dropping this guard produces three provider calls for one
  // domain action.
  assert.ok(hasSql("attempt_already_in_flight"),
    "concurrent allocation must be refused while an attempt is unresolved");
  assert.ok(hasSql("completed_at IS NULL"),
    "unresolved means no recorded outcome, not an expired lease");

  // 'claimed' must NOT be smuggled into the forbidden-state list as a shortcut:
  // that would block the legitimate retry of a resolved, retry-allowed
  // communication whose parent still reads 'claimed'.
  const forbidden = SQL.slice(SQL.indexOf("state_forbids_attempt") - 400,
                              SQL.indexOf("state_forbids_attempt"));
  assert.ok(!forbidden.includes("'claimed'"),
    "in-flight exclusion belongs to the attempt guard, not the state list");
});

// ── security posture ───────────────────────────────────────────────────────

test("both tables are service-role only, matching existing ledgers", () => {
  for (const t of ["seller_logical_communications", "seller_communication_attempts"]) {
    assert.ok(hasSql(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`));
    assert.ok(hasSql(`REVOKE ALL ON public.${t} FROM anon, authenticated`));
  }
  assert.ok(hasSql("GRANT EXECUTE ON FUNCTION public.seller_logical_communication_get_or_create"));
  assert.ok(hasSql("TO service_role"));
});

test("SECURITY DEFINER functions pin search_path", () => {
  // A SECURITY DEFINER function without a pinned search_path is a privilege
  // escalation vector; the repo already learned this on an earlier migration.
  const definers = SQL.split("SECURITY DEFINER").slice(1);
  assert.ok(definers.length >= 2, "expected both RPCs to be SECURITY DEFINER");
  for (const body of definers) {
    const head = body.slice(0, 200);
    assert.match(head, /SET\s+search_path\s*=/i, "each SECURITY DEFINER must pin search_path");
  }
});

test("required lookup indexes exist", () => {
  for (const idx of [
    "idx_seller_logical_communications_state",
    "idx_seller_logical_communications_ambiguous",
    "idx_seller_logical_communications_recipient",
    "idx_seller_communication_attempts_logical",
    "idx_seller_communication_attempts_unresolved",
  ]) {
    assert.ok(hasSql(idx), `missing index: ${idx}`);
  }
});
