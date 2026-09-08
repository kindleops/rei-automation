/**
 * email-suppression-consequences.test.mjs
 *
 * What happens after a seller tells us to stop, and to WHICH channel it applies.
 *
 * THE ASYMMETRY THIS FILE EXISTS TO PIN DOWN.
 *
 *   An email unsubscribe is CHANNEL-SPECIFIC. A seller who unsubscribes from
 *   emails has not opted out of a phone conversation, and treating it as a
 *   global opt-out silently destroys a live acquisition lead. It writes
 *   email_suppression and nothing else.
 *
 *   A DNC is GLOBAL. contact_outreach_state.dnc means "do not contact this
 *   person", full stop, and it blocks email exactly as it blocks SMS.
 *
 *   Getting these the wrong way round is expensive in both directions: too
 *   narrow and we email someone who opted out; too broad and we stop calling a
 *   seller who only wanted less email.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { createEmailProviderEventStore } from "@/lib/domain/email/email-provider-event-store.js";
import { evaluateEmailOutreachEligibility } from "@/lib/domain/email/email-outreach-eligibility.js";
import { EMAIL_SUPPRESSION_REASON } from "@/lib/domain/email/email-provider-outcome-lattice.js";

/** A supabase double that records every table it was asked to write. */
function makeDb(over = {}) {
  const writes = [];
  const db = {
    writes,
    from(table) {
      return {
        upsert(rows, options) {
          writes.push({ table, op: "upsert", rows: Array.isArray(rows) ? rows : [rows], options });
          return Promise.resolve(over[table] ?? { error: null });
        },
        update(patch) {
          writes.push({ table, op: "update", patch });
          return { eq: () => Promise.resolve(over[table] ?? { error: null }) };
        },
        select() {
          const builder = {
            eq: () => builder,
            order: () => builder,
            limit: () => Promise.resolve({ data: [], error: null }),
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            then: (resolve) => resolve({ data: [], error: null }),
          };
          return builder;
        },
      };
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return db;
}

const tablesWritten = (db) => [...new Set(db.writes.map((w) => w.table))];

// ── channel specificity ────────────────────────────────────────────────────

test("an email unsubscribe writes ONLY email_suppression", async () => {
  const db = makeDb();
  const store = createEmailProviderEventStore({ supabase: db });
  await store.applySuppression({
    email_address: "seller@example.com",
    mailbox_identity: "seller@example.com",
    reason: EMAIL_SUPPRESSION_REASON.UNSUBSCRIBED,
  });

  assert.deepEqual(tablesWritten(db), ["email_suppression"]);
});

test("an email unsubscribe never touches the SMS suppression list", async () => {
  const db = makeDb();
  const store = createEmailProviderEventStore({ supabase: db });
  for (const reason of Object.values(EMAIL_SUPPRESSION_REASON)) {
    await store.applySuppression({ email_address: "seller@example.com", reason });
  }
  const tables = tablesWritten(db);
  assert.ok(!tables.includes("sms_suppression_list"));
  assert.ok(!tables.includes("automation_suppressions"));
});

test("an email unsubscribe never sets the GLOBAL do-not-contact flag", async () => {
  // dnc means "do not contact this person at all". Setting it from an email
  // unsubscribe would silently stop calling a seller who only wanted less email.
  const db = makeDb();
  const store = createEmailProviderEventStore({ supabase: db });
  await store.applySuppression({
    email_address: "seller@example.com",
    reason: EMAIL_SUPPRESSION_REASON.UNSUBSCRIBED,
  });
  assert.ok(!tablesWritten(db).includes("contact_outreach_state"));
});

test("a GLOBAL dnc blocks email, because it is global", async () => {
  const verdict = evaluateEmailOutreachEligibility({
    email_address: "seller@example.com",
    suppression: null,
    contact_state: { dnc: true },
  });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "do_not_contact");
});

test("an email suppression blocks email", async () => {
  const verdict = evaluateEmailOutreachEligibility({
    email_address: "seller@example.com",
    suppression: { reason: "unsubscribed", is_active: true },
    contact_state: null,
  });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "opted_out");
});

// ── both address forms are suppressed together ─────────────────────────────

test("suppression covers the delivery address AND the folded mailbox", async () => {
  // A seller who unsubscribed as bob+house@gmail.com must not be emailed at
  // bob@gmail.com tomorrow.
  const db = makeDb();
  const store = createEmailProviderEventStore({ supabase: db });
  const result = await store.applySuppression({
    email_address: "bob+house@googlemail.com",
    mailbox_identity: "bob@gmail.com",
    reason: EMAIL_SUPPRESSION_REASON.UNSUBSCRIBED,
  });

  assert.deepEqual(result.addresses, ["bob+house@googlemail.com", "bob@gmail.com"]);
  assert.equal(db.writes[0].rows.length, 2);
});

test("an address whose two forms are identical is written once, not twice", async () => {
  const db = makeDb();
  const store = createEmailProviderEventStore({ supabase: db });
  await store.applySuppression({
    email_address: "seller@example.com",
    mailbox_identity: "seller@example.com",
    reason: EMAIL_SUPPRESSION_REASON.HARD_BOUNCE,
  });
  assert.equal(db.writes[0].rows.length, 1);
});

test("suppression upserts on the address, so a stronger reason can replace a weaker one", async () => {
  const db = makeDb();
  const store = createEmailProviderEventStore({ supabase: db });
  await store.applySuppression({ email_address: "a@example.net", reason: "soft_bounce" });
  assert.equal(db.writes[0].options.onConflict, "email_address");
});

// ── failure behaviour ──────────────────────────────────────────────────────

test("a failed suppression write REPORTS failure rather than claiming success", async () => {
  // This is the one storage failure that can put a message in front of someone
  // who asked us to stop.
  const db = makeDb({ email_suppression: { error: { message: "permission denied" } } });
  const store = createEmailProviderEventStore({ supabase: db });
  const result = await store.applySuppression({ email_address: "a@example.net", reason: "unsubscribed" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "suppression_write_failed");
});

test("a suppression with no address refuses instead of writing a blank row", async () => {
  const db = makeDb();
  const store = createEmailProviderEventStore({ supabase: db });
  const result = await store.applySuppression({ reason: "unsubscribed" });
  assert.equal(result.ok, false);
  assert.equal(db.writes.length, 0);
});

// ── every reason the lattice emits is writable ─────────────────────────────

test("every suppression reason the lattice can emit satisfies the table's CHECK", async () => {
  // The vocabulary is duplicated between the lattice and the migration's CHECK
  // constraint. A value in one and not the other fails at write time in
  // production rather than at review time here.
  const allowed = new Set([
    "unsubscribed", "hard_bounce", "soft_bounce", "complaint",
    "blocked", "invalid_address", "manual",
  ]);
  for (const reason of Object.values(EMAIL_SUPPRESSION_REASON)) {
    assert.ok(allowed.has(reason), `${reason} is not in the email_suppression CHECK vocabulary`);
  }
});

// ── delivery outcomes are applied separately from suppression ──────────────

test("applying a delivery outcome never writes the suppression list", async () => {
  const db = makeDb();
  const store = createEmailProviderEventStore({ supabase: db });
  await store.applyOutcome({
    logical_communication_id: "lc-1",
    provider_outcome: "delivered",
    event_type: "delivered",
    event_at: "2026-09-08T18:00:00.000Z",
  });
  assert.ok(!tablesWritten(db).includes("email_suppression"));
});

test("only `delivered` sets a terminal state; other outcomes leave state alone", async () => {
  // An event increases certainty about DELIVERY. It does not re-drive the send
  // lifecycle, and an outcome that rewrote state could resurrect or terminate a
  // communication the send path still owns.
  const db = makeDb();
  const store = createEmailProviderEventStore({ supabase: db });

  await store.applyOutcome({ logical_communication_id: "lc-1", provider_outcome: "delivered" });
  const deliveredPatch = db.writes.find((w) => w.table === "seller_logical_communications").patch;
  assert.equal(deliveredPatch.state, "delivered");
  assert.equal(deliveredPatch.retry_authority, "terminal");

  const db2 = makeDb();
  const store2 = createEmailProviderEventStore({ supabase: db2 });
  await store2.applyOutcome({ logical_communication_id: "lc-1", provider_outcome: "sent_by_provider" });
  const sentPatch = db2.writes.find((w) => w.table === "seller_logical_communications").patch;
  assert.equal(sentPatch.state, undefined);
  assert.equal(sentPatch.retry_authority, undefined);
});

test("a projection failure does not undo the ledger write", async () => {
  // Reconciliation repairs projections; it never re-sends.
  const db = makeDb({ email_queue: { error: { message: "projection unavailable" } } });
  const store = createEmailProviderEventStore({ supabase: db });
  const result = await store.applyOutcome({
    logical_communication_id: "lc-1", provider_outcome: "delivered", event_type: "delivered",
  });
  assert.equal(result.ok, true);
});

// ── telemetry stays out of every delivery write ────────────────────────────

test("recording telemetry touches no table directly", async () => {
  // It goes through the atomic RPC, which can only write telemetry columns.
  const db = makeDb();
  const store = createEmailProviderEventStore({ supabase: db });
  await store.recordTelemetry({ provider_message_id: "<m1@brevo>", event_type: "opened" });
  assert.equal(db.writes.length, 0);
});

test("telemetry with no message id is a no-op, not an error", async () => {
  const db = makeDb();
  const store = createEmailProviderEventStore({ supabase: db });
  const result = await store.recordTelemetry({ event_type: "opened" });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});
