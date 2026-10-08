/**
 * Inbox round 9 (owner 2026-10-07): New Replies is a whitelist of actionable
 * replies; everything else unresolved goes to the non-alerting Unclear lane.
 * The PROPOSED view (supabase/migrations/PROPOSED_20261008020000_inbox_round9_buckets.sql)
 * and its JS mirror must carry the same list and columns.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NEW_REPLY_ACTIONABLE_INTENTS, POSITIVE_REPLY_INTENTS, PRIORITY_REPLY_INTENTS } from "@/lib/domain/inbox/reply-actionability.js";
import { resolveInboxBucketFlags, threadMatchesBucketFilter } from "@/lib/domain/inbox/inbox-bucket-predicates.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../supabase/migrations");
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
const SQL = read("PROPOSED_20261008020000_inbox_round9_buckets.sql");
const RB = read("PROPOSED_20261008020000_inbox_round9_buckets_rollback.sql");
const PRE = read("PROPOSED_20261008020000_inbox_round9_buckets_pretest.sql");

const NOW = Date.parse("2026-10-07T18:00:00.000Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const reply = (extra = {}) => ({
  thread_key: "+15550001111", latest_direction: "inbound", last_inbound_at: hoursAgo(1), latest_message_at: hoursAgo(1),
  last_outbound_at: hoursAgo(3), inbox_bucket: "new_replies", property_id: "p1", ...extra,
});

function arrayBefore(sql, marker) {
  const at = sql.indexOf(marker);
  assert.ok(at > 0, `marker ${marker} missing`);
  const start = sql.lastIndexOf("array[", at);
  return sql.slice(start + 6, sql.indexOf("]", start)).split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
}

function outputColumns(text, tail) {
  const body = text.slice(text.indexOf("create or replace view public.v_inbox_thread_state_buckets"), text.lastIndexOf(tail));
  return body.slice(body.lastIndexOf("\nselect\n") + 8)
    .split(/,\n/)
    .map((chunk) => chunk.replace(/--[^\n]*\n/g, "").trim())
    .map((chunk) => (/ as ([a-z_0-9]+)\s*$/i.exec(chunk) || [null, chunk.trim()])[1]);
}

test("the whitelist is the positive set plus the other actionable intents; priority stays a subset", () => {
  for (const intent of POSITIVE_REPLY_INTENTS) assert.ok(NEW_REPLY_ACTIONABLE_INTENTS.includes(intent), intent);
  for (const intent of PRIORITY_REPLY_INTENTS) assert.ok(NEW_REPLY_ACTIONABLE_INTENTS.includes(intent), intent);
  for (const intent of ["unclear", "who_is_this", "language_switch", "info_request", "reaction_only", "asking_price_implausible", "hostile_or_troll", "opt_out"]) {
    assert.equal(NEW_REPLY_ACTIONABLE_INTENTS.includes(intent), false, intent);
  }
});

test("PROPOSED round-9 view: same whitelist as reply-actionability.js; 138 columns; rollback keeps names and order", () => {
  assert.deepEqual(arrayBefore(SQL, ") as f_new_reply_intent"), [...NEW_REPLY_ACTIONABLE_INTENTS].sort());
  assert.deepEqual(arrayBefore(SQL, ") as f_reopening_reply"), [...NEW_REPLY_ACTIONABLE_INTENTS].sort());
  const code = (text) => text.replace(/--[^\n]*/g, "");
  for (const text of [SQL, RB, PRE]) {
    assert.equal(/\bdrop\s+view\b/i.test(code(text)), false, "replace in place; two views depend on it");
    assert.match(text, /create or replace view public\.v_inbox_thread_state_buckets/);
  }
  const forward = outputColumns(SQL, "from k;");
  assert.equal(forward.length, 138, "129 live + 7 (8.5) + 2 (round 9)");
  assert.deepEqual(forward.slice(-2), ["f_new_reply_intent", "in_unclear"]);
  assert.deepEqual(outputColumns(RB, "from i;"), forward, "rollback keeps names and order");
  for (const text of [SQL, RB]) assert.match(text, /count\(\*\) FILTER \(WHERE in_unclear\) AS unclear/);
  assert.match(PRE, /\nrollback;\n/);
  assert.equal(/\ncommit;/.test(PRE), false, "the pretest never commits");
});

test("JS mirror: actionable -> New Replies, the rest -> Unclear (never both, never active)", () => {
  for (const intent of NEW_REPLY_ACTIONABLE_INTENTS) {
    const f = resolveInboxBucketFlags(reply({ last_intent: intent, inbox_bucket: "new_replies" }), NOW);
    assert.equal(f.in_new_replies, true, intent);
    assert.equal(f.in_unclear, false, intent);
  }
  for (const intent of ["unclear", "who_is_this", "language_switch", "info_request"]) {
    const f = resolveInboxBucketFlags(reply({ last_intent: intent }), NOW);
    assert.equal(f.in_new_replies, false, intent);
    assert.equal(f.in_unclear, true, intent);
    assert.equal(f.in_active, false, `${intent}: Unclear is non-alerting`);
    assert.equal(f.in_all, true, `${intent}: still under All`);
    assert.equal(threadMatchesBucketFilter(reply({ last_intent: intent }), "unclear", NOW), true, intent);
    assert.equal(threadMatchesBucketFilter(reply({ last_intent: intent }), "new_replies", NOW), false, intent);
  }
  // Answered threads leave Unclear too.
  assert.equal(resolveInboxBucketFlags(reply({ last_intent: "unclear", latest_direction: "outbound", last_outbound_at: hoursAgo(0.5) }), NOW).in_unclear, false);
});

test("Priority: '2 million' / '$1M' (implausible) and a frustration close are never Priority", () => {
  for (const intent of ["asking_price_implausible", "wrong_number", "unclear"]) {
    const f = resolveInboxBucketFlags(reply({ inbox_bucket: "priority", last_intent: intent }), NOW);
    assert.equal(f.in_priority, false, intent);
  }
  assert.equal(resolveInboxBucketFlags(reply({ inbox_bucket: "priority", last_intent: "asks_offer" }), NOW).in_priority, true);
});
