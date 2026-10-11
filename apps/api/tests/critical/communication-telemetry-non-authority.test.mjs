/**
 * communication-telemetry-non-authority.test.mjs
 *
 * last_observed_at and observation_count are TELEMETRY. They exist so replay
 * pressure is visible, and for nothing else.
 *
 * WHY THIS NEEDS A TEST AT ALL.
 *   They are tempting. "This row has been observed 40 times, something must be
 *   wrong, let it retry" is a plausible-sounding rule that would hand send
 *   authority to a counter incremented by duplicate workers. A replay is not
 *   evidence about the provider, and a counter is not evidence about a seller.
 *   The whole point of the model is that only delivery_possibility and
 *   retry_authority may gate execution.
 *
 * The audit at the time of writing found ZERO consumers outside the migration
 * itself, because these fields are new. This file exists to keep that true.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(__dirname, "../../src");
const MIGRATION = path.resolve(
  __dirname,
  "../../supabase/migrations/20260904090000_seller_logical_communications_and_attempts.sql"
);

const TELEMETRY_FIELDS = ["last_observed_at", "observation_count"];

/** Every .js under src, so the audit cannot miss a directory. */
function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}

const SRC_FILES = walk(API_SRC);

test("the audit actually covers the source tree", () => {
  // Guards against a broken walker making every assertion below vacuous.
  assert.ok(SRC_FILES.length > 500, `expected a full source walk, got ${SRC_FILES.length} files`);
});

/**
 * HOMONYMS — a DIFFERENT table's column that happens to share a telemetry field's name.
 * comp_private.comp_properties.last_observed_at is the vendor owner-snapshot date (when the
 * owner of record was last seen), not seller-communication replay telemetry. Each entry is
 * one exact source line, pinned below: the line must still exist verbatim, must qualify the
 * column with the named table's alias, and the file must never touch the communication
 * tables. Any other occurrence of a telemetry field anywhere (including a second line in an
 * allowlisted file) is still a consumer.
 */
const COMMUNICATION_TABLES = ["seller_logical_communications", "seller_communication_attempts"];
const HOMONYMS = [
  {
    file: "lib/domain/market-intelligence/mi-sale-owner.js",
    line: "cp.last_observed_at::date::text as owner_observed_on,",
    alias: "cp",
    table: "comp_private.comp_properties cp",
  },
];

test("telemetry-name homonyms are exact, other-table, and never in a communications module", () => {
  for (const h of HOMONYMS) {
    const code = fs.readFileSync(path.join(API_SRC, h.file), "utf8");
    const lines = code.split("\n").map((l) => l.trim());
    assert.equal(lines.filter((l) => l === h.line).length, 1, `${h.file}: pinned homonym line missing or duplicated`);
    assert.ok(h.line.startsWith(`${h.alias}.`), `${h.file}: homonym must be qualified by ${h.alias}.`);
    assert.ok(code.includes(h.table), `${h.file}: alias ${h.alias} must be bound to ${h.table}`);
    for (const t of COMMUNICATION_TABLES) assert.ok(!code.includes(t), `${h.file} must not touch ${t}`);
  }
});

test("NO application module reads the telemetry fields", () => {
  const consumers = [];
  for (const file of SRC_FILES) {
    const rel = path.relative(API_SRC, file);
    const allowed = new Set(HOMONYMS.filter((h) => h.file === rel).map((h) => h.line));
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const field of TELEMETRY_FIELDS) {
      if (lines.some((l) => l.includes(field) && !allowed.has(l.trim()))) consumers.push(`${rel} (${field})`);
    }
  }
  assert.deepEqual(
    consumers,
    [],
    `telemetry fields must have no application consumers, found:\n  ${consumers.join("\n  ")}`
  );
});

test("the telemetry fields appear in NO execution-authority decision", () => {
  // Belt and braces: even if a future module reads them, it must never be in the
  // same expression as an authority concept.
  const AUTHORITY_TOKENS = [
    "retry_authority", "delivery_possibility", "next_retry_at", "retry_after_at",
    "queue_status", "lock_token", "claimed_at", "canAllocateAttempt",
    "evaluateCanonicalSendAuthority", "sendTextgridSMS",
  ];
  for (const file of SRC_FILES) {
    const code = fs.readFileSync(file, "utf8");
    if (!TELEMETRY_FIELDS.some((f) => code.includes(f))) continue;
    for (const line of code.split("\n")) {
      const hasTelemetry = TELEMETRY_FIELDS.some((f) => line.includes(f));
      if (!hasTelemetry) continue;
      for (const token of AUTHORITY_TOKENS) {
        assert.ok(
          !line.includes(token),
          `${path.relative(API_SRC, file)}: telemetry appears alongside authority token ${token}\n  ${line.trim()}`
        );
      }
    }
  }
});

test("the migration writes telemetry ONLY on the non-semantic conflict path", () => {
  const sql = fs.readFileSync(MIGRATION, "utf8");

  // The one write site is the ON CONFLICT DO UPDATE of get-or-create.
  const writes = sql.split("\n").filter((l) => /SET\s+last_observed_at|observation_count\s*=/.test(l));
  assert.ok(writes.length >= 1, "expected the conflict path to advance telemetry");

  // The attempt allocator must not touch telemetry: allocation is an authority
  // decision, and telemetry must stay out of it entirely.
  const allocator = sql.slice(sql.indexOf("FUNCTION public.seller_communication_attempt_allocate"));
  for (const field of TELEMETRY_FIELDS) {
    assert.ok(!allocator.includes(field), `the attempt allocator must not reference ${field}`);
  }
});

test("the allocator's refusal reasons never cite telemetry", () => {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  const allocator = sql.slice(sql.indexOf("FUNCTION public.seller_communication_attempt_allocate"));
  // Its guards must be exactly the authority axes.
  assert.ok(allocator.includes("delivery_possibility = 'may_have_been_sent'"));
  assert.ok(allocator.includes("retry_authority IN"));
  assert.ok(allocator.includes("state IN"));
});

test("the `reused` flag is informational, never a send decision", () => {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  // get-or-create returns `reused` derived from observation_count. That is fine
  // for emitting logical_communication.reused telemetry, but it must not appear
  // anywhere that decides execution. Since no application module reads the
  // telemetry fields at all (asserted above), the derived flag cannot leak into
  // an authority path either. Pin the derivation so it stays a pure report.
  assert.ok(sql.includes("'reused', v_row.observation_count > 1"));

  // The precise property: telemetry must never appear in a BRANCH. Returning it
  // inside a jsonb report is fine (and the report legitimately also carries
  // retry_authority, so proximity to the word "retry" proves nothing). What
  // would be wrong is a conditional or predicate keyed on it.
  for (const line of sql.split("\n")) {
    const t = line.trim();
    if (t.startsWith("--")) continue;
    if (!TELEMETRY_FIELDS.some((f) => t.includes(f))) continue;
    assert.ok(
      !/^\s*(IF|ELSIF|WHEN|WHILE)\b/i.test(t),
      `telemetry must not drive a conditional:\n  ${t}`
    );
    assert.ok(
      !/\bWHERE\b/i.test(t),
      `telemetry must not appear in a predicate that selects rows:\n  ${t}`
    );
    assert.ok(
      !/\bORDER\s+BY\b|\bLIMIT\b/i.test(t),
      `telemetry must not order or bound a work-list:\n  ${t}`
    );
  }
});
