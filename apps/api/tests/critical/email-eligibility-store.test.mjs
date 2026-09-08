/**
 * email-eligibility-store.test.mjs
 *
 * The database side of email eligibility.
 *
 * The property this file exists to protect: A FAILED READ IS NOT A PASS.
 * The implementation this replaces queried columns that do not exist, caught the
 * error, and returned "no recent outreach" -- so the only cross-channel
 * duplicate-contact protection in the platform failed open, on every row,
 * silently. These tests make that shape of bug impossible to reintroduce
 * without turning red.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadEmailSuppression,
  loadContactOutreachState,
  resolveEmailOutreachEligibility,
  foldContactStateRows,
} from "@/lib/domain/email/email-eligibility-store.js";

/** Minimal PostgREST-shaped double that records the query it was asked to run. */
function makeDb(handlers = {}) {
  const seen = { tables: [], filters: [] };
  const db = {
    seen,
    from(table) {
      seen.tables.push(table);
      const handler = handlers[table] || (async () => ({ data: [], error: null }));
      const builder = {
        select() { return builder; },
        eq(column, value) { seen.filters.push([column, value]); return builder; },
        in(column, values) { seen.filters.push([column, values]); return builder; },
        limit() { return handler(seen); },
        then(resolve, reject) { return handler(seen).then(resolve, reject); },
      };
      return builder;
    },
  };
  return db;
}

const OK_EMPTY = async () => ({ data: [], error: null });
const BOOM = async () => ({ data: null, error: { message: "column does not exist" } });

// ── the failed-read invariant ───────────────────────────────────────────────

test("a suppression read that ERRORS returns undefined, never null", () => {
  return loadEmailSuppression("seller@example.com", {
    supabase: makeDb({ email_suppression: BOOM }),
  }).then((result) => {
    assert.equal(result.suppression, undefined,
      "undefined means 'could not check'; null would mean 'checked, clean'");
    assert.equal(result.reason, "suppression_lookup_failed");
  });
});

test("a contact-state read that ERRORS returns undefined, never null", async () => {
  const result = await loadContactOutreachState(
    { master_owner_id: "own-1" },
    { supabase: makeDb({ contact_outreach_state: BOOM }) }
  );
  assert.equal(result.contact_state, undefined);
});

test("a failed read makes the whole verdict INELIGIBLE", async () => {
  const verdict = await resolveEmailOutreachEligibility(
    { email_address: "seller@example.com", master_owner_id: "own-1" },
    { supabase: makeDb({ email_suppression: BOOM, contact_outreach_state: BOOM }) }
  );
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blocking_reasons.includes("suppression_state_unknown"));
  assert.ok(verdict.blocking_reasons.includes("contact_state_unknown"));
  assert.equal(verdict.facts.suppression_read, "failed");
  assert.equal(verdict.facts.contact_state_read, "failed");
});

test("a clean empty read is eligible, so the refusals above are not vacuous", async () => {
  const verdict = await resolveEmailOutreachEligibility(
    { email_address: "seller@example.com", master_owner_id: "own-1" },
    { supabase: makeDb({ email_suppression: OK_EMPTY, contact_outreach_state: OK_EMPTY }) }
  );
  assert.equal(verdict.eligible, true);
  assert.equal(verdict.facts.suppression_read, "ok");
  assert.equal(verdict.facts.contact_state_read, "ok");
});

// ── the columns queried are the ones production has ─────────────────────────

test("contact state is keyed on podio_master_owner_id, not master_owner_id", async () => {
  // The old code filtered on master_owner_id / property_id / last_outreach_at.
  // None of those exist on this table.
  const db = makeDb({ contact_outreach_state: OK_EMPTY });
  await loadContactOutreachState({ master_owner_id: "own-1", property_id: "prop-1" }, { supabase: db });
  const columns = db.seen.filters.map(([column]) => column);
  assert.ok(columns.includes("podio_master_owner_id"));
  assert.ok(columns.includes("podio_property_id"));
  assert.ok(!columns.includes("master_owner_id"));
  assert.ok(!columns.includes("last_outreach_at"));
});

// ── suppression is checked on BOTH forms of the address ─────────────────────

test("suppression is looked up on the delivery form AND the folded mailbox", async () => {
  const db = makeDb({ email_suppression: OK_EMPTY });
  await loadEmailSuppression("B.Ob+house@GoogleMail.com", { supabase: db });
  const [, candidates] = db.seen.filters.find(([column]) => column === "email_address");
  assert.ok(candidates.includes("b.ob+house@googlemail.com"), "the address as we would send it");
  assert.ok(candidates.includes("bob@gmail.com"), "the same human's inbox, folded");
});

test("an unparseable address short-circuits without querying", async () => {
  const db = makeDb({ email_suppression: BOOM });
  const result = await loadEmailSuppression("not an address", { supabase: db });
  assert.equal(result.suppression, null);
  assert.equal(db.seen.tables.length, 0);
});

test("the most durable suppression wins when both address forms are suppressed", async () => {
  const db = makeDb({
    email_suppression: async () => ({
      data: [
        { email_address: "bob+x@gmail.com", reason: "soft_bounce", is_active: true },
        { email_address: "bob@gmail.com", reason: "unsubscribed", is_active: true },
      ],
      error: null,
    }),
  });
  const result = await loadEmailSuppression("bob+x@gmail.com", { supabase: db });
  assert.equal(result.suppression.reason, "unsubscribed",
    "a soft bounce must not mask an unsubscribe recorded on the folded form");
});

// ── folding rows across channels ────────────────────────────────────────────

test("an SMS row and an email row fold into ONE contact history", () => {
  // Reading only the email row would miss an SMS sent an hour ago, which is
  // precisely the duplicate-contact case this path exists to prevent.
  const folded = foldContactStateRows([
    { channel: "sms", to_phone_number: "+13125550100", last_sms_at: "2026-09-08T17:00:00Z", last_outbound_at: "2026-09-08T17:00:00Z", touch_count: 3 },
    { channel: "email", to_email: "bob@example.com", last_email_at: "2026-09-01T09:00:00Z", last_outbound_at: "2026-09-01T09:00:00Z", touch_count: 2 },
  ], "bob@example.com");
  assert.equal(folded.last_outbound_at, "2026-09-08T17:00:00.000Z", "the LATEST contact, on any channel");
  assert.equal(folded.touch_count, 3, "the largest count, never the sum");
});

test("any row saying dnc or paused wins over every row that does not", () => {
  const folded = foldContactStateRows([
    { channel: "sms", dnc: true },
    { channel: "email", dnc: false, is_paused: false },
  ]);
  assert.equal(folded.dnc, true);

  const paused = foldContactStateRows([
    { channel: "sms", is_paused: true, pause_reason: "human_took_over" },
    { channel: "email", is_paused: false },
  ]);
  assert.equal(paused.is_paused, true);
  assert.equal(paused.pause_reason, "human_took_over");
});

test("a row for a DIFFERENT mailbox still constrains recency", () => {
  // The seller was contacted. Which address we used does not make that untrue.
  const folded = foldContactStateRows([
    { channel: "email", to_email: "other@example.com", last_outbound_at: "2026-09-08T17:00:00Z" },
  ], "bob@example.com");
  assert.equal(folded.last_outbound_at, "2026-09-08T17:00:00.000Z");
});

test("folding tolerates null and malformed timestamps without throwing", () => {
  assert.doesNotThrow(() => foldContactStateRows([
    { last_sms_at: null, last_outbound_at: "not-a-date", touch_count: null },
    {},
  ], null));
  const folded = foldContactStateRows([{ last_outbound_at: "not-a-date" }]);
  assert.equal(folded.last_outbound_at, null);
});

// ── an owner-less lookup is honest about which kind of nothing it found ─────

test("no owner anchor is a clean 'nothing to look up', not a failed read", async () => {
  const db = makeDb({ contact_outreach_state: BOOM });
  const result = await loadContactOutreachState({ master_owner_id: "" }, { supabase: db });
  assert.equal(result.contact_state, null);
  assert.equal(db.seen.tables.length, 0);
});

// ── the verdict is explainable after the fact ───────────────────────────────

test("the verdict carries the facts it was decided from", async () => {
  const db = makeDb({
    email_suppression: async () => ({
      data: [{ email_address: "bob@example.com", reason: "hard_bounce", is_active: true }],
      error: null,
    }),
    contact_outreach_state: OK_EMPTY,
  });
  const verdict = await resolveEmailOutreachEligibility(
    { email_address: "bob@example.com", master_owner_id: "own-1", property_id: "prop-1" },
    { supabase: db }
  );
  assert.equal(verdict.reason, "hard_bounced");
  assert.equal(verdict.facts.suppression.reason, "hard_bounce");
  assert.equal(verdict.facts.master_owner_id, "own-1");
  assert.equal(verdict.facts.property_id, "prop-1");
});
