/**
 * P0 outbound safety (owner, 2026-10-08): the contact-history + suppression
 * checks re-run at FINAL DISPATCH (send-time-contact-guard.js). Matrix B:
 * requeues, concurrent workers, multiple properties per owner, legacy phone
 * records (public.phones only), phone formats, wrong-number reports, a contact
 * previously approached about another property, a precautionary hold, expired
 * vs active automation_suppressions, and fail-closed reads.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSendTimeContactGuard,
  runSendTimeContactGuard,
  loadSendTimeContactFacts,
  isOpenerRow,
  isPriorTouch,
  phoneKey,
  phoneVariants,
  SEND_TIME_GUARD_REASONS as R,
} from "@/lib/domain/queue/send-time-contact-guard.js";

const NOW = Date.parse("2026-10-08T15:00:00.000Z");
const E164 = "+13145550101";
const opener = (extra = {}) => ({
  id: "row-b", to_phone_number: E164, thread_key: E164, from_phone_number: "+13145559999",
  property_id: "prop-1", prospect_id: "pr-1", type: "campaign_launch", touch_number: 1,
  queue_status: "processing", created_at: "2026-10-08T14:00:00.000Z", ...extra,
});
const followup = (extra = {}) => opener({ type: "followup", message_type: "followup", touch_number: 2, metadata: { followup_reason: "nurture_followup:not_interested" }, ...extra });
const evaluate = (row, facts = {}) => evaluateSendTimeContactGuard(row, facts, { now: NOW });

test("phone shapes: 10-digit, 1+10, E.164 and formatted share one key", () => {
  for (const v of ["3145550101", "13145550101", "+13145550101", "(314) 555-0101", "314.555.0101"]) assert.equal(phoneKey(v), "3145550101", v);
  assert.deepEqual(new Set(phoneVariants(["3145550101"])), new Set(["3145550101", "13145550101", "+13145550101"]));
});

test("a clean opener and a clean follow-up pass", () => {
  assert.equal(evaluate(opener()).blocked, false);
  assert.equal(evaluate(followup()).blocked, false);
});

// ── suppression list (formats) ───────────────────────────────────────────────
for (const stored of ["+13145550101", "3145550101", "13145550101"]) {
  test(`sms_suppression_list active row stored as ${stored} blocks an opener AND a follow-up to a 10-digit target`, () => {
    const facts = { suppressions: [{ phone_e164: stored, is_active: true, suppression_type: "opt_out" }] };
    for (const row of [opener({ to_phone_number: "3145550101", thread_key: null }), followup({ to_phone_number: "(314) 555-0101" })]) {
      const r = evaluate(row, facts);
      assert.equal(r.blocked, true);
      assert.equal(r.reason, R.SUPPRESSION_LIST);
    }
  });
}
test("an inactive suppression row does not block; a pair row blocks only its own sender", () => {
  assert.equal(evaluate(opener(), { suppressions: [{ phone_e164: E164, is_active: false }] }).blocked, false);
  assert.equal(evaluate(opener(), { suppressions: [{ phone_e164: E164, is_active: true, sender_phone_e164: "+13145558888" }] }).blocked, false);
  assert.equal(evaluate(opener(), { suppressions: [{ phone_e164: E164, is_active: true, sender_phone_e164: "+13145559999" }] }).reason, R.SUPPRESSION_LIST);
});

// ── automation_suppressions: any type, active vs expired ────────────────────
test("precautionary hold (automation_suppressions precautionary_no_contact) blocks openers and follow-ups", () => {
  const facts = { automation_suppressions: [{ phone_e164: E164, status: "active", suppression_type: "precautionary_no_contact", expires_at: null }] };
  for (const row of [opener(), followup()]) {
    const r = evaluate(row, facts);
    assert.equal(r.reason, R.AUTOMATION_SUPPRESSION);
    assert.equal(r.detail.suppression_type, "precautionary_no_contact");
  }
});
test("expired vs active automation_suppressions", () => {
  const expired = { phone_e164: E164, status: "active", suppression_type: "precautionary_no_contact", expires_at: "2026-10-08T14:59:59.000Z" };
  const active = { ...expired, expires_at: "2026-10-09T00:00:00.000Z" };
  const released = { ...active, status: "released" };
  const nullStatus = { phone_e164: "3145550101", status: null, suppression_type: "opt_out_fallback", expires_at: null };
  assert.equal(evaluate(opener(), { automation_suppressions: [expired] }).blocked, false);
  assert.equal(evaluate(opener(), { automation_suppressions: [released] }).blocked, false);
  assert.equal(evaluate(opener(), { automation_suppressions: [active] }).reason, R.AUTOMATION_SUPPRESSION);
  assert.equal(evaluate(opener(), { automation_suppressions: [nullStatus] }).reason, R.AUTOMATION_SUPPRESSION, "unknown status = active (fail closed)");
});

// ── thread suppressed / opted out ────────────────────────────────────────────
test("thread is_suppressed / opted-out disposition / blocking contactability block every automated send", () => {
  assert.equal(evaluate(followup(), { threads: [{ thread_key: E164, is_suppressed: true }] }).reason, R.THREAD_SUPPRESSED);
  assert.equal(evaluate(followup(), { threads: [{ thread_key: E164, disposition: "opt_out" }] }).reason, R.THREAD_OPTED_OUT);
  assert.equal(evaluate(followup(), { threads: [{ canonical_e164: "3145550101", contactability_status: "do_not_contact" }] }).reason, R.THREAD_OPTED_OUT);
  assert.equal(evaluate(followup(), { inbound_replies: [{ from_phone_number: E164, detected_intent: "opt_out" }] }).reason, R.OPT_OUT_REPLY);
});

// ── wrong-number reports ─────────────────────────────────────────────────────
test("wrong-number reports (thread, inbound reply, public.phones) block openers and follow-ups for every property", () => {
  const cases = [
    { threads: [{ thread_key: E164, last_intent: "wrong_number", property_id: "prop-OTHER" }] },
    { inbound_replies: [{ from_phone_number: "3145550101", detected_intent: "wrong_person", property_id: "prop-OTHER" }] },
    { phones: [{ canonical_e164: E164, phone_contact_status: "wrong_number" }] },
    { phones: [{ canonical_e164: E164, wrong_number_at: "2026-10-01T00:00:00Z" }] },
  ];
  for (const facts of cases) {
    for (const row of [opener(), followup()]) assert.equal(evaluate(row, facts).reason, R.WRONG_NUMBER, JSON.stringify(facts));
  }
});

// ── prior_reply_not_owner (person × property) ────────────────────────────────
test("prior_reply_not_owner: 'sold it' for THIS property blocks; for ANOTHER property it does not", () => {
  const sold_here = { inbound_replies: [{ from_phone_number: E164, detected_intent: "sold_property", property_id: "prop-1" }] };
  const sold_there = { inbound_replies: [{ from_phone_number: E164, detected_intent: "sold_property", property_id: "prop-2" }] };
  assert.equal(evaluate(followup(), sold_here).reason, R.PRIOR_REPLY_NOT_OWNER);
  assert.equal(evaluate(followup(), sold_there).blocked, false);
  assert.equal(evaluate(followup(), { threads: [{ thread_key: E164, disposition: "former_owner_respondent", property_id: "prop-1" }] }).reason, R.PRIOR_REPLY_NOT_OWNER);
});

// ── already contacted (openers only) ─────────────────────────────────────────
const sent = (extra = {}) => ({ id: "row-a", to_phone_number: E164, property_id: "prop-1", prospect_id: "pr-1", queue_status: "delivered", sent_at: "2026-10-01T15:00:00Z", created_at: "2026-10-01T14:00:00Z", ...extra });

test("already contacted: pair / phone / person / property each block an opener; follow-ups are exempt", () => {
  assert.equal(evaluate(opener(), { prior_sends: [sent()] }).reason, R.ALREADY_CONTACTED_PAIR);
  assert.equal(evaluate(opener(), { prior_sends: [sent({ prospect_id: "pr-OTHER" })] }).reason, R.ALREADY_CONTACTED_PHONE);
  assert.equal(evaluate(opener(), { prior_sends: [sent({ to_phone_number: "+13145550202", property_id: "prop-2" })] }).reason, R.ALREADY_CONTACTED_PERSON);
  assert.equal(evaluate(opener(), { prior_sends: [sent({ to_phone_number: "+13145550303", prospect_id: "pr-9" })] }).reason, R.ALREADY_CONTACTED_PROPERTY);
  for (const facts of [{ prior_sends: [sent()] }, { prior_sends: [sent({ to_phone_number: "+13145550303", prospect_id: "pr-9" })] }]) {
    assert.equal(evaluate(followup(), facts).blocked, false);
    assert.equal(evaluate(opener({ type: "auto_reply", touch_number: null }), facts).blocked, false);
  }
});

test("phone formats: a 10-digit opener target matches an E.164 ledger row (and the reverse)", () => {
  assert.equal(evaluate(opener({ to_phone_number: "3145550101", thread_key: null }), { prior_sends: [sent()] }).reason, R.ALREADY_CONTACTED_PAIR);
  assert.equal(evaluate(opener(), { prior_sends: [sent({ to_phone_number: "3145550101" })] }).reason, R.ALREADY_CONTACTED_PAIR);
  assert.equal(evaluate(opener(), { prior_outbound_events: [{ id: "ev-1", direction: "outbound", to_phone_number: "13145550101", property_id: "prop-9" }] }).reason, R.ALREADY_CONTACTED_PAIR);
});

test("a contact previously approached about ANOTHER property is not a fresh opener", () => {
  const r = evaluate(opener(), { prior_sends: [sent({ property_id: "prop-2" })] });
  assert.equal(r.blocked, true);
  assert.equal(r.reason, R.ALREADY_CONTACTED_PAIR);
  const via_other_phone = evaluate(opener(), { prior_sends: [sent({ to_phone_number: "+13145550202", property_id: "prop-2" })] });
  assert.equal(via_other_phone.reason, R.ALREADY_CONTACTED_PERSON);
  assert.equal(via_other_phone.detail.other_property, true);
});

test("multiple properties per owner: one opener out for property A blocks the property-B opener to the same person", () => {
  const a = sent({ id: "row-a", property_id: "prop-A" });
  assert.equal(evaluate(opener({ property_id: "prop-B" }), { prior_sends: [a] }).blocked, true);
  // ... but the property-B follow-up after an A conversation is not an opener.
  assert.equal(evaluate(followup({ property_id: "prop-B" }), { prior_sends: [a] }).blocked, false);
});

test("legacy phone records (public.phones only): the person's other phone in phones counts as the person", () => {
  const facts = { person_phones: ["3145550404"], prior_sends: [sent({ to_phone_number: "+13145550404", prospect_id: null, property_id: "prop-7" })] };
  assert.equal(evaluate(opener({ prospect_id: "pr-1" }), facts).reason, R.ALREADY_CONTACTED_PERSON);
  // no prospect at all: the phones-table numbers still identify the person
  assert.equal(evaluate(opener({ prospect_id: null }), facts).reason, R.ALREADY_CONTACTED_PERSON);
});

test("requeues: a cancelled / failed original with no sent_at is not a touch; a sent original is", () => {
  for (const status of ["cancelled", "failed", "failed_transport", "expired", "blocked_by_health_guard", "queued", "scheduled"]) {
    assert.equal(evaluate(opener(), { prior_sends: [sent({ queue_status: status, sent_at: null })] }).blocked, false, status);
  }
  assert.equal(evaluate(opener(), { prior_sends: [sent({ queue_status: "cancelled", sent_at: "2026-10-01T15:00:00Z" })] }).blocked, true, "sent then cancelled is a touch");
  assert.equal(evaluate(opener(), { prior_outbound_events: [{ id: "ev-f", direction: "outbound", to_phone_number: E164, event_type: "outbound_failed", is_final_failure: true }] }).blocked, false);
});

test("concurrent workers: the row itself never counts; two in-flight openers to one phone let exactly one through", () => {
  const me = opener({ id: "row-b", created_at: "2026-10-08T14:00:00.000Z" });
  assert.equal(evaluate(me, { prior_sends: [{ ...me }] }).blocked, false, "a claim of the same row is not a prior touch");
  assert.equal(evaluate(me, { prior_outbound_events: [{ id: "ev", direction: "outbound", to_phone_number: E164, queue_id: "row-b" }] }).blocked, false);
  const earlier = { ...me, id: "row-a", created_at: "2026-10-08T13:59:00.000Z", queue_status: "sending", sent_at: null };
  const later = { ...me, id: "row-c", created_at: "2026-10-08T14:01:00.000Z", queue_status: "sending", sent_at: null };
  assert.equal(evaluate(me, { prior_sends: [earlier] }).blocked, true, "an earlier in-flight sibling wins");
  assert.equal(evaluate(me, { prior_sends: [later] }).blocked, false, "a later in-flight sibling does not block this one");
  const tieA = { ...me, id: "row-a" }, tieZ = { ...me, id: "row-z" };
  const results = [evaluate(tieA, { prior_sends: [tieZ] }).blocked, evaluate(tieZ, { prior_sends: [tieA] }).blocked];
  assert.deepEqual(results.sort(), [false, true], "same created_at: the id breaks the tie, one passes");
  assert.equal(isPriorTouch({ id: "x", queue_status: "queued", created_at: "2026-10-08T13:00:00Z" }, me), false, "a queued sibling is checked at its own dispatch");
});

test("opener detection", () => {
  assert.equal(isOpenerRow(opener()), true);
  assert.equal(isOpenerRow(opener({ touch_number: 2 })), false);
  assert.equal(isOpenerRow(followup()), false);
  assert.equal(isOpenerRow(opener({ type: "auto_reply" })), false);
  assert.equal(isOpenerRow(opener({ touch_number: null, metadata: { is_first_touch: true } })), true);
});

// ── fail closed + the loader ─────────────────────────────────────────────────
test("fail closed: any read error at send time = blocked with a reason", async () => {
  const r = await runSendTimeContactGuard(opener(), { loadFacts: async () => { throw new Error("statement timeout"); } });
  assert.equal(r.blocked, true);
  assert.equal(r.reason, R.READ_FAILED);
  const no_client = await runSendTimeContactGuard(followup(), { supabase: null });
  assert.equal(no_client.reason, R.READ_FAILED);
});

function fakeDb(tables, { failTable = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = [];
      const chain = {
        select: () => chain,
        eq: (c, v) => (filters.push((r) => String(r[c] ?? "") === String(v)), chain),
        in: (c, vs) => (filters.push((r) => vs.map(String).includes(String(r[c] ?? ""))), chain),
        limit: async () => {
          calls.push(table);
          if (table === failTable) return { data: null, error: new Error(`${table} unavailable`) };
          return { data: (tables[table] || []).filter((r) => filters.every((f) => f(r))), error: null };
        },
      };
      return chain;
    },
  };
}

test("loader: reads every source with both phone shapes; a failing table fails closed", async () => {
  const db = fakeDb({
    sms_suppression_list: [],
    automation_suppressions: [{ phone_e164: "3145550101", status: "active", suppression_type: "precautionary_no_contact" }],
  });
  const r = await runSendTimeContactGuard(opener({ to_phone_number: "+13145550101" }), { supabase: db, now: NOW });
  assert.equal(r.reason, R.AUTOMATION_SUPPRESSION, "a 10-digit automation_suppressions row matches an E.164 row");
  for (const t of ["sms_suppression_list", "automation_suppressions", "inbox_thread_state", "phones", "message_events"]) assert.ok(db.calls.includes(t), t);
  for (const t of ["sms_suppression_list", "automation_suppressions", "inbox_thread_state", "phones", "message_events", "send_queue"]) {
    const failing = fakeDb({}, { failTable: t });
    const res = await runSendTimeContactGuard(opener(), { supabase: failing, now: NOW });
    assert.equal(res.reason, R.READ_FAILED, `read error on ${t}`);
  }
});

test("loader: an opener reads the ledgers (phone, the person's public.phones numbers, property); a follow-up does not", async () => {
  const tables = {
    phones: [{ canonical_e164: "+13145550404", primary_prospect_id: "pr-1" }],
    send_queue: [{ id: "old", to_phone_number: "3145550404", property_id: "prop-7", prospect_id: null, queue_status: "delivered", sent_at: "2026-09-20T00:00:00Z", created_at: "2026-09-20T00:00:00Z" }],
  };
  const r = await runSendTimeContactGuard(opener(), { supabase: fakeDb(tables), now: NOW });
  assert.equal(r.reason, R.ALREADY_CONTACTED_PERSON);
  const f = fakeDb(tables);
  const facts = await loadSendTimeContactFacts(f, followup());
  assert.equal(f.calls.includes("send_queue"), false);
  assert.deepEqual(facts.prior_sends, []);
});
