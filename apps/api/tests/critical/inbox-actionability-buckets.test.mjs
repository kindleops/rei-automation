/**
 * Inbox Actionability 8.5 (2026-10-06). Owner: "New Replies and Priority are
 * ONLY messages we can actually do something with. Junk goes under All
 * messages." Pinned here:
 *   - every canonical intent lands in its expected bucket (writer + reader)
 *   - HOT LEAD / warm-hot never come from an implausible ask, a troll or
 *     profanity, a non-owner or a thanks
 *   - a later actionable reply re-promotes a parked thread; opt-out / wrong
 *     number never re-open
 *   - the PROPOSED SQL view carries the same lists as reply-actionability.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NON_ACTIONABLE_REPLY_INTENTS,
  PRIORITY_REPLY_INTENTS,
  POSITIVE_REPLY_INTENTS,
  NEW_REPLY_ACTIONABLE_INTENTS,
  resolveCanonicalLeadHeat,
} from "@/lib/domain/inbox/reply-actionability.js";
import { resolveInboxBucketFlags } from "@/lib/domain/inbox/inbox-bucket-predicates.js";
import { resolveInboxBucketFromClassification } from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import { computeTemperatureSignal } from "@/lib/domain/seller-flow/temperature-signal-model.js";
import { CANONICAL_INTENTS } from "@/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js";

const NOW = Date.parse("2026-10-06T18:00:00.000Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

// An unanswered latest inbound (the seller wrote after our last send).
const reply = (extra = {}) => ({
  thread_key: "+15550001111",
  latest_direction: "inbound",
  last_inbound_at: hoursAgo(1),
  latest_message_at: hoursAgo(1),
  last_outbound_at: hoursAgo(3),
  inbox_bucket: "new_replies",
  property_id: "p1",
  ...extra,
});

const bucketOf = (flags) =>
  flags.in_priority ? "priority"
    : flags.in_new_replies ? "new_replies"
      : flags.in_unclear ? "unclear"
      : flags.in_needs_review ? "needs_review"
        : flags.in_follow_up ? "follow_up"
          : flags.in_suppressed ? "suppressed"
            : flags.in_dead ? "dead"
              : "all";

// ── Intent → bucket (reader: the JS mirror of the PROPOSED view) ────────────

const READER_EXPECT = {
  // Never New Replies / Priority.
  opt_out: "all",
  hostile_or_legal: "all",
  hostile_or_troll: "all",
  wrong_number: "all",
  wrong_person: "all",
  property_specific_non_owner: "all",
  tenant_respondent: "all",
  former_owner_respondent: "all",
  sold_property: "all",
  not_interested: "all",
  need_time: "all",
  asking_price_implausible: "all",
  acknowledgement: "all",
  reaction_only: "all",
  // Actionable (round 9 whitelist).
  ownership_confirmed: "new_replies",
  latent_interest: "new_replies",
  condition_disclosed: "new_replies",
  tenant_occupied: "new_replies",
  non_owner_referral: "new_replies",
  executor_heir_respondent: "new_replies",
  family_member_respondent: "new_replies",
  // Round 9 (owner 2026-10-07): not actionable -> the non-alerting Unclear lane.
  who_is_this: "unclear",
  info_request: "unclear",
  unclear: "unclear",
  // Priority-grade — stored under a writer-assigned 'priority'.
  asking_price_provided: "priority",
  asks_offer: "priority",
  contract_requested: "priority",
  seller_interested: "priority",
  callback_requested: "priority",
};

test("reader: each intent maps to its bucket (New Replies / Priority hold only actionable replies)", () => {
  for (const [intent, expected] of Object.entries(READER_EXPECT)) {
    for (const stored of ["new_replies", "priority"]) {
      const flags = resolveInboxBucketFlags(reply({ inbox_bucket: stored, last_intent: intent }), NOW);
      let want = expected;
      // A priority-grade reply the writer filed as new_replies stays a New Reply.
      if (expected === "priority" && stored === "new_replies") want = "new_replies";
      assert.equal(bucketOf(flags), want, `${intent} stored as ${stored}`);
      assert.equal(flags.in_all_messages, true, `${intent} is always under All messages`);
    }
  }
});

test("reader: Priority never holds an implausible ask, a troll, profanity, an opt-out or a non-owner — even once answered", () => {
  for (const intent of ["asking_price_implausible", "hostile_or_troll", "hostile_or_legal", "opt_out", "property_specific_non_owner", "wrong_number", "ownership_confirmed", "latent_interest", "unclear"]) {
    const answered = resolveInboxBucketFlags(
      reply({ inbox_bucket: "priority", last_intent: intent, latest_direction: "outbound", last_outbound_at: hoursAgo(0.5) }),
      NOW,
    );
    assert.equal(answered.in_priority, false, intent);
  }
  const plausible = resolveInboxBucketFlags(
    reply({ inbox_bucket: "priority", last_intent: "asking_price_provided", latest_direction: "outbound", last_outbound_at: hoursAgo(0.5) }),
    NOW,
  );
  assert.equal(plausible.in_priority, true, "a plausible ask stays Priority after the auto-reply");
});

test("reader: buckets stay exclusive and active stays the union", () => {
  for (const intent of [...CANONICAL_INTENTS, "wrong_person", "sold_property"]) {
    for (const stored of ["new_replies", "priority", "follow_up", null]) {
      const flags = resolveInboxBucketFlags(reply({ inbox_bucket: stored, last_intent: intent }), NOW);
      const on = ["in_priority", "in_new_replies", "in_needs_review", "in_follow_up"].filter((k) => flags[k]);
      assert.ok(on.length <= 1, `${intent}/${stored}: ${on.join("+")}`);
      assert.equal(flags.in_active, on.length === 1, `${intent}/${stored}: active is the union`);
    }
  }
});

test("every canonical intent is classified as non-actionable, New-Replies-worthy or Unclear (no intent is forgotten)", () => {
  const nonActionable = new Set(NON_ACTIONABLE_REPLY_INTENTS);
  const actionable = new Set(NEW_REPLY_ACTIONABLE_INTENTS);
  for (const intent of CANONICAL_INTENTS) {
    const flags = resolveInboxBucketFlags(reply({ last_intent: intent }), NOW);
    assert.equal(flags.in_new_replies, actionable.has(intent), intent);
    assert.equal(flags.in_unclear, !nonActionable.has(intent) && !actionable.has(intent), intent);
  }
  // No recorded intent is unknown, not unclear: it stays visible in New Replies.
  assert.equal(resolveInboxBucketFlags(reply({ last_intent: null }), NOW).in_new_replies, true);
});

// ── Writer ──────────────────────────────────────────────────────────────────

test("writer: junk never gets new_replies / priority; non-owners and trolls close the property thread", () => {
  const inbound = { direction: "inbound" };
  const w = (primary_intent, existing = {}) => resolveInboxBucketFromClassification({ primary_intent }, inbound, existing, NOW);
  for (const intent of ["property_specific_non_owner", "tenant_respondent", "former_owner_respondent", "hostile_or_troll"]) {
    assert.equal(w(intent), "dead", intent);
  }
  // Owner P0 2026-10-10: an absurd ask is the PRICE GAP nurture (follow_up), never Priority.
  assert.equal(w("asking_price_implausible"), "follow_up");
  assert.equal(w("acknowledgement", { inbox_bucket: "priority" }), "cold");
  assert.equal(w("need_time"), "follow_up");
  // Owner P0 2026-10-10: a stated ask needs credible economics; interest without an ask does not.
  for (const intent of PRIORITY_REPLY_INTENTS.filter((i) => i !== "asking_price_provided")) assert.equal(w(intent), "priority", intent);
  assert.equal(w("asking_price_provided"), "new_replies", "unknown value is never a deal by default");
  assert.equal(resolveInboxBucketFromClassification({ primary_intent: "asking_price_provided", deal_economics: { verdict: "credible", ratio: 0.95, lane: "sfr" } }, inbound, {}, NOW), "priority");
  for (const intent of ["ownership_confirmed", "latent_interest", "requests_email", "who_is_this", "unclear"]) {
    assert.equal(w(intent), "new_replies", intent);
  }
});

// ── Hot / temperature ───────────────────────────────────────────────────────

test("temperature model: a sticky price never makes a troll, a joke ask or an unclear reply warm/hot", () => {
  const stickyPrice = { asking_price: { value: 5000000 } };
  for (const intent of ["hostile_or_troll", "asking_price_implausible", "unclear", "who_is_this", "property_specific_non_owner", "acknowledgement"]) {
    const signal = computeTemperatureSignal({ intent, facts: stickyPrice, secondary: { seller_reply_count: 4, question_count: 1 } });
    assert.ok(["unscored", "cold"].includes(signal.temperature_floor), `${intent}: ${signal.temperature_floor}`);
    assert.equal(signal.reason_codes.includes("FLOOR_HOT_EXPLICIT_PRICE_OR_URGENT_INTENT"), false, intent);
  }
  const plausible = computeTemperatureSignal({ intent: "asking_price_provided", facts: { asking_price: { value: 180000 } } });
  assert.equal(plausible.temperature_floor, "hot", "a plausible ask on a positive reply is still hot");
  const flagged = computeTemperatureSignal({
    intent: "asking_price_provided",
    facts: { asking_price: { value: 1000000, implausibility: { implausible: true } } },
  });
  assert.notEqual(flagged.temperature_floor, "hot", "a price marked implausible never counts");
});

test("canonical lead heat: HOT LEAD only from a priority-grade reply; warm/hot only from a positive one", () => {
  for (const intent of ["asking_price_implausible", "hostile_or_troll", "hostile_or_legal", "opt_out", "property_specific_non_owner", "unclear", "who_is_this"]) {
    const heat = resolveCanonicalLeadHeat({ last_intent: intent, lead_temperature: "hot", is_hot_lead: true });
    assert.equal(heat.is_hot_lead, false, intent);
    assert.equal(heat.lead_temperature, "cold", intent);
    assert.equal(heat.recorded_lead_temperature, "hot", `${intent}: the recorded value is kept`);
  }
  assert.equal(resolveCanonicalLeadHeat({ last_intent: "asks_offer", lead_temperature: "hot" }).is_hot_lead, true);
  assert.equal(resolveCanonicalLeadHeat({ last_intent: "ownership_confirmed", lead_temperature: "warm" }).lead_temperature, "warm");
  assert.equal(resolveCanonicalLeadHeat({ last_intent: "ownership_confirmed", lead_temperature: "hot" }).is_hot_lead, false, "a bare yes is not a hot lead");
  assert.equal(
    resolveCanonicalLeadHeat({ last_intent: "asks_offer", lead_temperature: "hot", is_suppressed: true }).is_hot_lead,
    false,
    "a suppressed thread is never hot",
  );
  const manual = resolveCanonicalLeadHeat({ last_intent: "unclear", lead_temperature: "hot", manual_temperature_lock: true });
  assert.equal(manual.lead_temperature, "hot", "an operator's manual temperature is shown as recorded");
  assert.equal(manual.is_hot_lead, true);
});

// ── Re-promotion ────────────────────────────────────────────────────────────

test("re-promotion: a parked nurture re-opens on a later actionable reply; never on unclear, never past opt-out / wrong number", () => {
  const nurture = (last_intent, extra = {}) => resolveInboxBucketFlags(
    reply({ inbox_bucket: null, disposition: "not_interested", last_intent, ...extra }),
    NOW,
  );
  for (const intent of ["ownership_confirmed", "asks_offer", "asking_price_provided", "executor_heir_respondent"]) {
    const flags = nurture(intent);
    assert.equal(flags.in_new_replies, true, intent);
    assert.equal(flags.in_follow_up, false, `${intent}: one bucket per thread`);
  }
  for (const intent of ["unclear", "who_is_this", "not_interested", "need_time", "hostile_or_troll", "asking_price_implausible"]) {
    const flags = nurture(intent);
    assert.equal(flags.in_new_replies, false, intent);
    assert.equal(flags.in_follow_up, true, `${intent}: stays a 30-day nurture (not suppressed, not archived)`);
  }
  // A reply that has already been answered does not re-open anything.
  assert.equal(nurture("asks_offer", { latest_direction: "outbound", last_outbound_at: hoursAgo(0.5) }).in_new_replies, false);
  // Terminal never re-opens.
  assert.equal(resolveInboxBucketFlags(reply({ is_suppressed: true, last_intent: "asks_offer" }), NOW).in_new_replies, false);
  assert.equal(resolveInboxBucketFlags(reply({ inbox_bucket: null, disposition: "wrong_number", last_intent: "asks_offer" }), NOW).in_new_replies, false);
  // A later actionable reply on a junk thread is New Replies again (latest intent wins).
  assert.equal(resolveInboxBucketFlags(reply({ last_intent: "ownership_confirmed" }), NOW).in_new_replies, true);
});

// ── Parity with the PROPOSED SQL view ───────────────────────────────────────

test("the PROPOSED view, its rollback and reply-actionability.js carry the same lists and columns", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(here, "../../../../supabase/migrations");
  const sql = fs.readFileSync(path.join(dir, "PROPOSED_20261006235000_inbox_actionability_buckets.sql"), "utf8");
  const rb = fs.readFileSync(path.join(dir, "PROPOSED_20261006235000_inbox_actionability_buckets_rollback.sql"), "utf8");
  const arrayBefore = (marker) => {
    const at = sql.indexOf(marker);
    assert.ok(at > 0, `marker ${marker} missing`);
    const start = sql.lastIndexOf("array[", at);
    return sql.slice(start + 6, sql.indexOf("]", start)).split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
  };
  assert.deepEqual(arrayBefore(") as f_reply_resolved"), [...NON_ACTIONABLE_REPLY_INTENTS].sort());
  assert.deepEqual(arrayBefore(") as f_thread_resolved"), [...NON_ACTIONABLE_REPLY_INTENTS].sort());
  assert.deepEqual(arrayBefore(") as f_priority_intent"), [...PRIORITY_REPLY_INTENTS].sort());
  assert.deepEqual(arrayBefore(") as f_positive_intent"), [...POSITIVE_REPLY_INTENTS].sort());
  const code = (text) => text.replace(/--[^\n]*/g, "");
  for (const text of [sql, rb]) {
    assert.equal(/\bdrop\s+view\b/i.test(code(text)), false, "replace in place; two views depend on it");
    assert.match(text, /create or replace view public\.v_inbox_thread_state_buckets/);
  }
  const outputColumns = (text, tail) => {
    const body = text.slice(text.indexOf("create or replace view"), text.lastIndexOf(tail));
    return body.slice(body.lastIndexOf("\nselect\n") + 8)
      .split(/,\n/)
      .map((chunk) => chunk.replace(/--[^\n]*\n/g, "").trim())
      .map((chunk) => (/ as ([a-z_0-9]+)\s*$/i.exec(chunk) || [null, chunk.trim()])[1]);
  };
  const forward = outputColumns(sql, "from k;");
  assert.equal(forward.length, 136, "129 live columns + 7 appended");
  assert.deepEqual(outputColumns(rb, "from i;"), forward, "rollback keeps names and order");
  assert.deepEqual(forward.slice(-7), ["f_thread_intent", "f_thread_resolved", "f_priority_intent", "f_positive_intent", "f_reopening_reply", "f_lead_temperature", "f_hot_lead"]);
});
