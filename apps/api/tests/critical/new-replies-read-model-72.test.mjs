/**
 * ONE canonical New Replies rule (7.2): genuine engagement + no resolved
 * disposition + a response still owed. Pinned on both sides of the read model:
 *   writer  resolve-inbox-state-from-classification.js (inbox_bucket on inbound)
 *   reader  inbox-bucket-predicates.js resolveInboxBucketFlags, the JS mirror of
 *           v_inbox_thread_state_buckets (migration 20261001160000, NOT applied)
 * The Inbox lens counts, Inbox 4.0 and the Command Rail all read the view's
 * flags through v_inbox_bucket_counts / getLiveCounts, so they cannot drift.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveInboxBucketFromClassification } from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import {
  resolveInboxBucketFlags,
  resolveDerivedInboxBucket,
  isStaleExplicitInboxBucket,
  RESOLVED_REPLY_INTENTS,
  NON_ENGAGEMENT_REPLY_INTENTS,
  CLOSED_DISPOSITIONS,
} from "@/lib/domain/inbox/inbox-bucket-predicates.js";

const NOW = Date.parse("2026-10-01T18:00:00.000Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const inbound = { direction: "inbound" };

// ── Writer ──────────────────────────────────────────────────────────────────

test("writer: resolved replies never get the new_replies bucket", () => {
  assert.equal(resolveInboxBucketFromClassification({ primary_intent: "sold_property" }, inbound, {}, NOW), "dead");
  assert.equal(
    resolveInboxBucketFromClassification({ primary_intent: "hostile_or_legal", matched_rule_ids: ["hostile_insult_no_opt_out"] }, inbound, {}, NOW),
    "dead",
    "hostility without opt-out language is archived/cooled"
  );
  assert.equal(
    resolveInboxBucketFromClassification({ primary_intent: "hostile_or_legal", matched_rule_ids: ["emoji_hostile"] }, inbound, {}, NOW),
    "dead"
  );
  assert.equal(
    resolveInboxBucketFromClassification({ primary_intent: "hostile_or_legal", matched_rule_ids: ["hostile_legal_threat"] }, inbound, {}, NOW),
    "needs_review",
    "a legal threat keeps the human lane"
  );
  assert.equal(resolveInboxBucketFromClassification({ primary_intent: "need_time" }, inbound, {}, NOW), "follow_up");
  assert.equal(resolveInboxBucketFromClassification({ primary_intent: "contract_requested" }, inbound, {}, NOW), "priority");
});

test("writer: a reaction / acknowledgement keeps the state it found; nothing open means cold (waiting inside 24h)", () => {
  assert.equal(
    resolveInboxBucketFromClassification({ primary_intent: "reaction_only" }, inbound, { inbox_bucket: "new_replies" }, NOW),
    "new_replies",
    "an earlier unanswered reply is still unanswered after a thumbs-up"
  );
  assert.equal(
    resolveInboxBucketFromClassification({ primary_intent: "acknowledgement" }, inbound, { inbox_bucket: "priority" }, NOW),
    "priority"
  );
  assert.equal(resolveInboxBucketFromClassification({ primary_intent: "reaction_only" }, inbound, { inbox_bucket: "waiting" }, NOW), "cold");
  assert.equal(resolveInboxBucketFromClassification({ primary_intent: "acknowledgement" }, inbound, {}, NOW), "cold");
});

test("writer: a not-interested seller who writes back with engagement is a NEW REPLY again; a reaction is not", () => {
  const declined = { disposition: "not_interested", inbox_bucket: null };
  assert.equal(resolveInboxBucketFromClassification({ primary_intent: "asks_offer" }, inbound, declined, NOW), "priority");
  assert.equal(resolveInboxBucketFromClassification({ primary_intent: "who_is_this" }, inbound, declined, NOW), "new_replies");
  assert.equal(resolveInboxBucketFromClassification({ primary_intent: "reaction_only" }, inbound, declined, NOW), null, "stays in follow-up");
  assert.equal(resolveInboxBucketFromClassification({ primary_intent: "not_interested" }, inbound, declined, NOW), null);
  assert.equal(resolveInboxBucketFromClassification({}, { direction: "outbound" }, declined, NOW), null, "outbound unchanged");
});

test("writer: genuine engagement still lands in New Replies or Priority", () => {
  for (const intent of ["who_is_this", "unclear", "condition_disclosed", "language_switch"]) {
    assert.equal(resolveInboxBucketFromClassification({ primary_intent: intent }, inbound, {}, NOW), "new_replies", intent);
  }
  for (const intent of ["asks_offer", "callback_requested", "seller_interested", "ownership_confirmed"]) {
    assert.equal(resolveInboxBucketFromClassification({ primary_intent: intent }, inbound, {}, NOW), "priority", intent);
  }
});

// ── Reader (JS mirror of the view) ──────────────────────────────────────────

const inboundRow = (extra = {}) => ({
  thread_key: "t",
  latest_direction: "inbound",
  last_inbound_at: hoursAgo(1),
  latest_message_at: hoursAgo(1),
  last_outbound_at: hoursAgo(3),
  inbox_bucket: "new_replies",
  property_id: "p",
  ...extra,
});

test("reader: a stale explicit 'new_replies' bucket cannot hold a resolved conversation", () => {
  for (const last_intent of RESOLVED_REPLY_INTENTS) {
    const flags = resolveInboxBucketFlags(inboundRow({ last_intent }), NOW);
    assert.equal(flags.in_new_replies, false, last_intent);
    assert.equal(flags.in_active, flags.in_priority || flags.in_needs_review || flags.in_follow_up, `${last_intent}: active stays the union`);
    assert.equal(isStaleExplicitInboxBucket(inboundRow({ last_intent }), "new_replies", NOW), true, `${last_intent} is a stale New Reply`);
  }
  for (const last_intent of ["who_is_this", "unclear", "asks_offer", "callback_requested", "language_switch"]) {
    assert.equal(resolveInboxBucketFlags(inboundRow({ last_intent }), NOW).in_new_replies, true, last_intent);
  }
});

test("reader: sold / unqualified close the thread (Dead), never actionable", () => {
  for (const disposition of CLOSED_DISPOSITIONS) {
    const flags = resolveInboxBucketFlags(inboundRow({ inbox_bucket: null, disposition, last_intent: "unclear" }), NOW);
    assert.equal(resolveDerivedInboxBucket({ disposition }), "dead");
    assert.equal(flags.in_dead, true, disposition);
    assert.equal(flags.in_new_replies, false, disposition);
    assert.equal(flags.in_priority || flags.in_cold || flags.in_waiting, false, disposition);
  }
});

test("reader: a reaction that left nothing open reads as Waiting inside the reply window, Cold after it", () => {
  const fresh = resolveInboxBucketFlags(inboundRow({ inbox_bucket: "cold", last_intent: "reaction_only", last_outbound_at: hoursAgo(2) }), NOW);
  assert.equal(fresh.in_waiting, true);
  assert.equal(fresh.in_cold, false);
  assert.equal(fresh.in_new_replies, false);
  const old = resolveInboxBucketFlags(inboundRow({ inbox_bucket: "cold", last_intent: "acknowledgement", last_outbound_at: hoursAgo(30) }), NOW);
  assert.equal(old.in_waiting, false);
  assert.equal(old.in_cold, true);
  const open = resolveInboxBucketFlags(inboundRow({ inbox_bucket: "new_replies", last_intent: "reaction_only" }), NOW);
  assert.equal(open.in_new_replies, true, "an earlier unanswered reply keeps the thread in New Replies");
});

// ── Parity with the SQL view (the deployed authority) ───────────────────────

test("the migration and the JS mirror carry the same lists", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(here, "../../../../supabase/migrations/20261001160000_new_replies_genuine_engagement.sql"), "utf8");
  const arrayAfter = (marker) => {
    const at = sql.indexOf(marker);
    assert.ok(at > 0, `marker ${marker} missing`);
    const before = sql.lastIndexOf("array[", at);
    const body = sql.slice(before + 6, sql.indexOf("]", before));
    return body.split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
  };
  assert.deepEqual(arrayAfter(") as f_reply_resolved"), [...RESOLVED_REPLY_INTENTS].sort());
  assert.deepEqual(arrayAfter(") as f_nonengagement_latest"), [...NON_ENGAGEMENT_REPLY_INTENTS].sort());
  assert.deepEqual(arrayAfter(") as f_closed_disposition"), [...CLOSED_DISPOSITIONS].sort());
  assert.match(sql, /and not f_reply_resolved/);
  assert.match(sql, /create or replace view public\.v_inbox_thread_state_buckets/);
  assert.equal(/\bdrop\s+view\b/i.test(sql), false, "replace in place; v_inbox_bucket_counts depends on it");
});

test("the view rollback restores the pre-7.2 predicates and keeps the 4 new columns as inert stubs (no DROP)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, "../../../..");
  const sql = fs.readFileSync(path.join(root, "supabase/migrations/20261001160000_new_replies_genuine_engagement.sql"), "utf8");
  const rb = fs.readFileSync(path.join(root, "supabase/rollbacks/20261001160000_new_replies_genuine_engagement_ROLLBACK.sql"), "utf8");
  const outputColumns = (text) => {
    const body = text.slice(text.indexOf("create or replace view"), text.lastIndexOf("from i;"));
    const finalSelect = body.slice(body.lastIndexOf("\nselect\n") + 8);
    return finalSelect
      .split(/,\n/)
      .map((chunk) => chunk.replace(/--[^\n]*\n/g, "").trim())
      .map((chunk) => (/ as ([a-z_0-9]+)\s*$/i.exec(chunk) || [null, chunk.trim()])[1]);
  };
  const forward = outputColumns(sql);
  const back = outputColumns(rb);
  assert.deepEqual(back, forward, "same names in the same order: CREATE OR REPLACE VIEW accepts it");
  assert.equal(forward.length, 129, "125 production columns + 4 appended (prod information_schema, 2026-10-02)");
  assert.deepEqual(forward.slice(-4), ["f_last_intent", "f_reply_resolved", "f_nonengagement_latest", "f_closed_disposition"]);
  assert.match(rb, /''::text as f_last_intent,\s*false as f_reply_resolved,\s*false as f_nonengagement_latest,\s*false as f_closed_disposition/);
  assert.equal(/\bdrop\s+view\b/i.test(rb.replace(/--[^\n]*/g, "")), false, "no DROP (v_inbox_bucket_counts, v_inbox_zero_counts depend on it)");
  const code = rb.replace(/--[^\n]*/g, "");
  for (const gone of ["and not f_reply_resolved", "or f_closed_disposition", "f_nonengagement_latest and", "array['sold','unqualified']"]) {
    assert.equal(code.includes(gone), false, `rollback still contains 7.2 logic: ${gone}`);
  }
});
