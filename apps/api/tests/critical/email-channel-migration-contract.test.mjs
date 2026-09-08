/**
 * email-channel-migration-contract.test.mjs
 *
 * Static contract for the EMAIL-1 migration.
 *
 * PARSING NOTE. Like logical-communication-migration-contract.test.mjs, this
 * file does NOT strip comments with a regex. The migration contains CHECK
 * expressions with quoted literals and a $fn$-quoted function body, and a naive
 * /\/\*[\s\S]*?\*\//g stripper has already been fooled once in this repository
 * by a terminator inside a string. A character-level, quote-aware scanner
 * cannot be.
 *
 * Text can only prove the migration SAYS something. An executed contract proves
 * the database DOES it, and that belongs with the apply step. What this file
 * guarantees is that the statements a reviewer approved are the statements that
 * will run.
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
  "../../supabase/migrations/20260908120000_email_channel_canonical_domain.sql"
);

function stripSqlLineComments(sql) {
  const out = [];
  let inSingle = false;
  let inDollar = false;

  for (const line of sql.split("\n")) {
    let kept = "";
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const next = line[i + 1];

      if (!inSingle && ch === "$" && line.slice(i).startsWith("$fn$")) {
        inDollar = !inDollar;
        kept += "$fn$";
        i += 3;
        continue;
      }
      if (!inDollar && ch === "'") {
        if (inSingle && next === "'") { kept += "''"; i += 1; continue; }
        inSingle = !inSingle;
        kept += ch;
        continue;
      }
      if (!inSingle && !inDollar && ch === "-" && next === "-") break;
      kept += ch;
    }
    out.push(kept);
  }
  return out.join("\n");
}

const RAW = fs.readFileSync(MIGRATION, "utf8");
const SQL = stripSqlLineComments(RAW);

const has = (needle) => SQL.includes(needle);

// ── the channel column, and its absent default ──────────────────────────────

test("seller_logical_communications gains channel and to_email", () => {
  assert.ok(has("ADD COLUMN IF NOT EXISTS channel  text"));
  assert.ok(has("ADD COLUMN IF NOT EXISTS to_email text"));
});

test("channel is backfilled, then made NOT NULL", () => {
  assert.ok(has("SET channel = 'sms'"));
  assert.ok(has("ALTER COLUMN channel SET NOT NULL"));
});

test("channel on seller_logical_communications has NO surviving default", () => {
  // A default there would silently file a channel-less caller as SMS, re-opening
  // the cross-channel collision under the appearance of working.
  //
  // Scoped to that table on purpose: email_queue DOES carry
  // `channel text NOT NULL DEFAULT 'email'`, and that one is a tautology rather
  // than a fallback, because the same table is constrained CHECK (channel =
  // 'email'). A default that cannot be wrong is not a silent assumption.
  assert.ok(has("ALTER COLUMN channel DROP DEFAULT"),
    "the backfill default must be dropped, not left in place");

  const block = SQL.match(
    /ALTER TABLE public\.seller_logical_communications[\s\S]*?ADD COLUMN IF NOT EXISTS to_email text;/
  );
  assert.ok(block, "the ADD COLUMN block was not found");
  assert.ok(!/DEFAULT/i.test(block[0]),
    "the channel column must not be introduced with a default that survives");

  assert.ok(has("CHECK (channel = 'email')"),
    "email_queue's default is only safe because the column is pinned by a check");
});

test("channel is constrained to the closed vocabulary", () => {
  assert.ok(has("CHECK (channel IN ('sms', 'email'))"));
});

test("a row cannot carry both a phone and an email recipient", () => {
  assert.ok(has("seller_logical_communications_recipient_matches_channel"));
  assert.ok(has("(channel = 'sms'   AND to_email        IS NULL)"));
  assert.ok(has("(channel = 'email' AND to_phone_number IS NULL)"));
});

// ── the RPC ─────────────────────────────────────────────────────────────────

test("the RPC writes channel and to_email", () => {
  assert.ok(has("NULLIF(p_lineage->>'channel','')"));
  assert.ok(has("NULLIF(p_lineage->>'to_email','')"));
});

test("the RPC never COALESCEs a missing channel into a default", () => {
  // NOT NULL plus no coalesce means a channel-less caller fails loudly, which is
  // the correct outcome for a caller that cannot say how its message travels.
  assert.ok(!/COALESCE\([^)]*'channel'[^)]*'sms'/.test(SQL));
  assert.ok(!SQL.includes("COALESCE(NULLIF(p_lineage->>'channel',''), 'sms')"));
});

test("channel joins the identity-conflict guard, in both halves", () => {
  assert.ok(has("public.seller_logical_communications.channel              IS NOT DISTINCT FROM EXCLUDED.channel"),
    "the ON CONFLICT WHERE clause must compare channel");
  assert.ok(has("array_append(v_conflict, 'channel')"),
    "a channel disagreement must be reported as a conflicting field");
});

test("the RPC keeps its SECURITY DEFINER posture and its grants", () => {
  assert.ok(has("SECURITY DEFINER"));
  assert.ok(has("SET search_path = public, extensions, pg_temp"));
  assert.ok(has("REVOKE ALL ON FUNCTION public.seller_logical_communication_get_or_create"));
  assert.ok(has("GRANT EXECUTE ON FUNCTION public.seller_logical_communication_get_or_create(text, text, text, jsonb, jsonb) TO service_role"));
});

test("the non-semantic conflict update is preserved: no updated_at reset", () => {
  assert.ok(has("SET last_observed_at  = now()"));
  assert.ok(!/DO UPDATE[\s\S]{0,400}SET[\s\S]{0,200}updated_at\s*=\s*now\(\)/.test(SQL),
    "a replay is not a state transition and must not reset timers");
});

// ── suppression ─────────────────────────────────────────────────────────────

test("the email suppression table is created with a closed reason vocabulary", () => {
  assert.ok(has("CREATE TABLE IF NOT EXISTS public.email_suppression"));
  for (const reason of [
    "'unsubscribed'", "'hard_bounce'", "'soft_bounce'", "'complaint'",
    "'blocked'", "'invalid_address'", "'manual'",
  ]) {
    assert.ok(has(reason), `missing suppression reason ${reason}`);
  }
});

test("only a soft bounce may carry an expiry", () => {
  // Every other suppression is permanent. An expiry on an unsubscribe would be a
  // scheduled re-contact of someone who said stop.
  assert.ok(has("CHECK (expires_at IS NULL OR reason = 'soft_bounce')"));
});

test("suppression is unique per address, so one seller cannot be half-suppressed", () => {
  assert.ok(has("CREATE UNIQUE INDEX IF NOT EXISTS email_suppression_address_uq"));
});

test("suppression is service_role only", () => {
  assert.ok(has("ALTER TABLE public.email_suppression ENABLE ROW LEVEL SECURITY"));
  assert.ok(has("REVOKE ALL ON TABLE public.email_suppression FROM PUBLIC, anon, authenticated"));
  assert.ok(has("GRANT ALL  ON TABLE public.email_suppression TO service_role"));
});

// ── the queue and the contact governor ──────────────────────────────────────

test("email_queue gains the lineage a canonical dispatch requires", () => {
  for (const column of [
    "logical_communication_id", "dedupe_key", "campaign_target_id", "touch_number",
    "decision_id", "follow_up_id", "operator_action_id", "seller_offer_id",
  ]) {
    assert.ok(SQL.includes(`ADD COLUMN IF NOT EXISTS ${column}`), `missing ${column}`);
  }
});

test("email_queue dedupe uniqueness applies only to LIVE rows", () => {
  // Two historical rows may legitimately share a dedupe key; two queued ones
  // may not.
  assert.ok(has("email_queue_dedupe_key_inflight_uq"));
  assert.ok(has("queue_status IN ('queued', 'claimed', 'sending')"));
});

test("contact_outreach_state gains the email twin of its phone unique key", () => {
  // Without it the email path has no upsert target and records no outreach, so
  // every downstream cooldown check finds nothing.
  assert.ok(has("uq_contact_outreach_state_owner_email"));
  assert.ok(has("(podio_master_owner_id, to_email)"));
});

test("the email unique index is NOT partial: PostgREST cannot infer a predicate", () => {
  const match = SQL.match(/CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_outreach_state_owner_email[\s\S]*?;/);
  assert.ok(match, "index statement not found");
  assert.ok(!/\bWHERE\b/i.test(match[0]),
    "a partial index would silently fail to match PostgREST's ON CONFLICT");
});

// ── the whole thing applies or none of it does ──────────────────────────────

test("the migration is a single transaction", () => {
  assert.ok(SQL.trimStart().startsWith("BEGIN;"));
  assert.ok(SQL.trimEnd().endsWith("COMMIT;"));
});

test("the migration is re-runnable", () => {
  // Every creating statement guards itself, so a partial apply can be repeated.
  const creates = SQL.match(/CREATE (TABLE|UNIQUE INDEX|INDEX)[^;]*;/g) || [];
  for (const statement of creates) {
    assert.ok(/IF NOT EXISTS/.test(statement), `not idempotent: ${statement.slice(0, 90)}`);
  }
  const constraints = SQL.match(/ADD CONSTRAINT \w+/g) || [];
  assert.ok(constraints.length > 0);
  // Constraints cannot use IF NOT EXISTS, so each must be guarded by a catalog check.
  const guards = SQL.match(/SELECT 1 FROM pg_constraint\s+WHERE conname = '(\w+)'/g) || [];
  assert.ok(guards.length >= constraints.length,
    `${constraints.length} constraints but only ${guards.length} existence guards`);
});

test("the migration destroys nothing", () => {
  assert.ok(!/\bDROP\s+TABLE\b/i.test(SQL));
  assert.ok(!/\bDROP\s+COLUMN\b/i.test(SQL));
  assert.ok(!/\bTRUNCATE\b/i.test(SQL));
  assert.ok(!/\bDELETE\s+FROM\b/i.test(SQL));
});

test("the only UPDATE is the channel backfill, and it touches nothing else", () => {
  const updates = SQL.match(/UPDATE\s+public\.\w+[\s\S]*?;/g) || [];
  assert.equal(updates.length, 1, "an unreviewed second UPDATE would be a data change nobody approved");
  assert.ok(updates[0].includes("SET channel = 'sms'"));
  assert.ok(updates[0].includes("WHERE channel IS NULL"));
});
