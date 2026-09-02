import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateAutonomyInvariants,
  summarizeInvariantViolations,
  INVARIANT_CODES,
  AUTONOMY_INVARIANTS_VERSION,
} from "@/lib/domain/seller-flow/autonomy-invariants.js";

// AUTONOMOUS INCIDENT DETECTION (supersprint §18).
// A pure evaluator over bounded windows of canonical state. Each invariant has
// a positive case (the impossible state is DETECTED) and the clean estate
// produces zero violations. Monetary / identity violations are fatal.

const OPP = "11111111-1111-4111-8111-111111111111";
const THREAD = "+15550100777";
const NOW = "2026-09-01T12:00:00.000Z";

const opp = (over = {}) => ({
  id: OPP, primary_thread_key: THREAD, primary_property_id: "prop-1",
  acquisition_stage: "offer", opportunity_status: "active", next_action: "generate_offer",
  ...over,
});
const offer = (over = {}) => ({
  offer_id: `offer:${OPP}:v1`, opportunity_id: OPP, offer_version: 1, status: "active",
  direction: "outbound", purchase_price: 250000, authorized_ceiling: 260000,
  ade_snapshot_id: "ade:1", metadata: { minimum_margin: 5000 },
  ...over,
});
const closing = (over = {}) => ({
  closing_case_id: `closing:${OPP}`, opportunity_id: OPP, offer_id: `offer:${OPP}:v1`,
  seller_contract_price: 250000, ...over,
});
const qrow = (over = {}) => ({
  id: "q-1", queue_status: "queued", to_phone_number: THREAD, property_id: "prop-1",
  use_case_template: "initial_offer", opportunity_id: OPP,
  metadata: { offer_id: `offer:${OPP}:v1`, offer_price: 250000, inbound_message_event_id: "evt-1" },
  ...over,
});

const codes = (vs) => vs.map((v) => v.code);
const fatalCodes = (vs) => vs.filter((v) => v.fatal).map((v) => v.code);

// ── clean estate ─────────────────────────────────────────────────────────────

test("a clean, consistent estate produces zero violations", () => {
  const vs = evaluateAutonomyInvariants({
    opportunities: [opp()],
    offers: [offer({ status: "accepted", accepted_price: 250000 })],
    closing_cases: [closing()],
    queue_rows: [qrow()],
    now: NOW,
  });
  assert.deepEqual(vs, []);
  const s = summarizeInvariantViolations(vs);
  assert.equal(s.ok, true);
  assert.equal(s.fail_closed, false);
  assert.equal(s.total, 0);
  assert.equal(s.version, AUTONOMY_INVARIANTS_VERSION);
});

test("an empty estate is clean (evaluator is total, never throws)", () => {
  assert.deepEqual(evaluateAutonomyInvariants(), []);
  assert.deepEqual(evaluateAutonomyInvariants({ offers: [null, {}], queue_rows: [{}], opportunities: [{}], now: NOW }).filter((v) => v.fatal), []);
});

// ── monetary / identity (fatal) ──────────────────────────────────────────────

test("a monetary queue row with no seller_offer is FATAL", () => {
  const vs = evaluateAutonomyInvariants({ queue_rows: [qrow({ metadata: { offer_id: null } })], now: NOW });
  assert.ok(fatalCodes(vs).includes(INVARIANT_CODES.MONETARY_QUEUE_ROW_WITHOUT_OFFER));
  assert.equal(summarizeInvariantViolations(vs).fail_closed, true);
});

test("a rendered amount that differs from the persisted price is FATAL", () => {
  const vs = evaluateAutonomyInvariants({
    offers: [offer()], queue_rows: [qrow({ metadata: { offer_id: `offer:${OPP}:v1`, offer_price: 275000 } })], now: NOW,
  });
  const v = vs.find((x) => x.code === INVARIANT_CODES.RENDERED_AMOUNT_MISMATCH);
  assert.ok(v && v.fatal);
  assert.equal(v.detail.rendered_price, 275000);
  assert.equal(v.detail.persisted_price, 250000);
});

test("an offer above the authorized ceiling is FATAL", () => {
  const vs = evaluateAutonomyInvariants({ offers: [offer({ purchase_price: 270000, authorized_ceiling: 260000 })], now: NOW });
  const v = vs.find((x) => x.code === INVARIANT_CODES.OFFER_EXCEEDS_CEILING);
  assert.ok(v && v.fatal);
  assert.equal(v.detail.over_by, 10000);
});

test("an offer that violates the minimum margin is FATAL", () => {
  // ceiling 260000, price 258000 -> margin 2000 < minimum 5000
  const vs = evaluateAutonomyInvariants({ offers: [offer({ purchase_price: 258000 })], now: NOW });
  const v = vs.find((x) => x.code === INVARIANT_CODES.OFFER_BELOW_MINIMUM_MARGIN);
  assert.ok(v && v.fatal);
  assert.equal(v.detail.margin, 2000);
});

test("multiple ACCEPTED offers for one opportunity is FATAL", () => {
  const vs = evaluateAutonomyInvariants({
    offers: [offer({ status: "accepted" }), offer({ offer_id: `offer:${OPP}:v2`, offer_version: 2, status: "accepted" })],
    closing_cases: [closing()], now: NOW,
  });
  assert.ok(fatalCodes(vs).includes(INVARIANT_CODES.MULTIPLE_ACCEPTED_OFFERS));
});

test("multiple ACTIVE offers for one opportunity is FATAL", () => {
  const vs = evaluateAutonomyInvariants({
    offers: [offer(), offer({ offer_id: `offer:${OPP}:v2`, offer_version: 2 })], now: NOW,
  });
  assert.ok(fatalCodes(vs).includes(INVARIANT_CODES.MULTIPLE_ACTIVE_OFFERS));
});

test("closing case terms that do not match the accepted offer are FATAL", () => {
  const vs = evaluateAutonomyInvariants({
    offers: [offer({ status: "accepted", accepted_price: 250000 })],
    closing_cases: [closing({ seller_contract_price: 240000 })], now: NOW,
  });
  const v = vs.find((x) => x.code === INVARIANT_CODES.CLOSING_TERMS_MISMATCH);
  assert.ok(v && v.fatal);
  assert.equal(v.detail.seller_contract_price, 240000);
  assert.equal(v.detail.accepted_price, 250000);
});

test("a closing case with NO accepted offer is FATAL (no fake closings)", () => {
  const vs = evaluateAutonomyInvariants({ closing_cases: [closing()], offers: [offer()], now: NOW });
  assert.ok(fatalCodes(vs).includes(INVARIANT_CODES.CLOSING_WITHOUT_ACCEPTED_OFFER));
});

test("a queue recipient that differs from the opportunity seller is FATAL", () => {
  const vs = evaluateAutonomyInvariants({
    opportunities: [opp()], offers: [offer()],
    queue_rows: [qrow({ to_phone_number: "+15550109999" })], now: NOW,
  });
  assert.ok(fatalCodes(vs).includes(INVARIANT_CODES.QUEUE_RECIPIENT_MISMATCH));
});

test("a queue row whose property differs from the opportunity is FATAL (wrong property context)", () => {
  const vs = evaluateAutonomyInvariants({
    opportunities: [opp()], offers: [offer()],
    queue_rows: [qrow({ property_id: "prop-OTHER" })], now: NOW,
  });
  assert.ok(fatalCodes(vs).includes(INVARIANT_CODES.WRONG_PROPERTY_CONTEXT));
});

test("two provider sends for one logical decision is FATAL (duplicate seller spam)", () => {
  const vs = evaluateAutonomyInvariants({
    offers: [offer()],
    queue_rows: [
      qrow({ id: "q-a", queue_status: "sent", provider_message_sid: "SM-a" }),
      qrow({ id: "q-b", queue_status: "sent", provider_message_sid: "SM-b" }),
    ], now: NOW,
  });
  const v = vs.find((x) => x.code === INVARIANT_CODES.DUPLICATE_PROVIDER_SEND);
  assert.ok(v && v.fatal);
  assert.deepEqual(v.detail.provider_message_sids.sort(), ["SM-a", "SM-b"]);
});

test("a retry of the SAME provider send (one sid) is not a duplicate", () => {
  const vs = evaluateAutonomyInvariants({
    offers: [offer()],
    queue_rows: [
      qrow({ id: "q-a", queue_status: "sent", provider_message_sid: "SM-a" }),
      qrow({ id: "q-b", queue_status: "sent", provider_message_sid: "SM-a" }),
    ], now: NOW,
  });
  assert.ok(!codes(vs).includes(INVARIANT_CODES.DUPLICATE_PROVIDER_SEND));
});

// ── lifecycle / lineage (non-fatal errors) ───────────────────────────────────

test("an outbound offer with no ADE snapshot is an ERROR (lineage gap), not fatal", () => {
  const vs = evaluateAutonomyInvariants({ offers: [offer({ ade_snapshot_id: null })], now: NOW });
  const v = vs.find((x) => x.code === INVARIANT_CODES.OFFER_WITHOUT_ADE_SNAPSHOT);
  assert.ok(v);
  assert.equal(v.fatal, false);
  // a seller counter (inbound) carries no ADE lineage by design
  const inbound = evaluateAutonomyInvariants({ offers: [offer({ direction: "inbound", ade_snapshot_id: null })], now: NOW });
  assert.ok(!codes(inbound).includes(INVARIANT_CODES.OFFER_WITHOUT_ADE_SNAPSHOT));
});

test("an active stage with no next action is an ERROR; terminal stages are exempt", () => {
  const vs = evaluateAutonomyInvariants({ opportunities: [opp({ next_action: null })], now: NOW });
  assert.ok(codes(vs).includes(INVARIANT_CODES.STAGE_WITHOUT_NEXT_ACTION));
  const closed = evaluateAutonomyInvariants({ opportunities: [opp({ acquisition_stage: "closed", next_action: null })], now: NOW });
  assert.ok(!codes(closed).includes(INVARIANT_CODES.STAGE_WITHOUT_NEXT_ACTION));
});

test("a follow-up that is due but not scheduled is an ERROR; a scheduled one is clean", () => {
  const due = opp({ next_action: "schedule_follow_up", next_action_due: "2026-09-01T09:00:00.000Z" });
  const missing = evaluateAutonomyInvariants({ opportunities: [due], followups: [], now: NOW });
  assert.ok(codes(missing).includes(INVARIANT_CODES.FOLLOWUP_DUE_NOT_SCHEDULED));
  const scheduled = evaluateAutonomyInvariants({
    opportunities: [due], followups: [{ thread_key: THREAD, status: "scheduled" }], now: NOW,
  });
  assert.ok(!codes(scheduled).includes(INVARIANT_CODES.FOLLOWUP_DUE_NOT_SCHEDULED));
  // not yet due -> clean
  const future = evaluateAutonomyInvariants({
    opportunities: [opp({ next_action: "schedule_follow_up", next_action_due: "2026-09-09T09:00:00.000Z" })], now: NOW,
  });
  assert.ok(!codes(future).includes(INVARIANT_CODES.FOLLOWUP_DUE_NOT_SCHEDULED));
});

test("an accepted offer with no closing case is an ERROR (the seam did not converge)", () => {
  const vs = evaluateAutonomyInvariants({ offers: [offer({ status: "accepted" })], closing_cases: [], now: NOW });
  const v = vs.find((x) => x.code === INVARIANT_CODES.ACCEPTED_OFFER_WITHOUT_CLOSING);
  assert.ok(v);
  assert.equal(v.fatal, false);
});

// ── machine-readable shape ───────────────────────────────────────────────────

test("every violation is machine-readable and frozen", () => {
  const vs = evaluateAutonomyInvariants({ offers: [offer({ purchase_price: 999999 })], now: NOW });
  assert.ok(vs.length > 0);
  for (const v of vs) {
    assert.ok(Object.values(INVARIANT_CODES).includes(v.code));
    assert.ok(["fatal", "error", "warn"].includes(v.severity));
    assert.equal(typeof v.fatal, "boolean");
    assert.ok(v.entity_type);
    assert.equal(typeof v.detail, "object");
    assert.ok(Object.isFrozen(v));
  }
  const s = summarizeInvariantViolations(vs);
  assert.equal(s.total, vs.length);
  assert.equal(s.fatal, vs.filter((v) => v.fatal).length);
});


// ── §19 precision: suppression lives on the projection, not the canonical record ──

test("a suppressed or archived thread is NOT a missing-next-action dead end", () => {
  const suppressed = opp({ id: "opp-s", primary_thread_key: "+15550100001", next_action: null });
  const archived = opp({ id: "opp-a", primary_thread_key: "+15550100002", next_action: null });
  const live = opp({ id: "opp-l", primary_thread_key: "+15550100003", next_action: null });
  const vs = evaluateAutonomyInvariants({
    opportunities: [suppressed, archived, live],
    thread_states: [
      { thread_key: "+15550100001", is_suppressed: true },
      { thread_key: "+15550100002", is_archived: true },
    ],
    now: NOW,
  });
  const ids = vs.filter((v) => v.code === INVARIANT_CODES.STAGE_WITHOUT_NEXT_ACTION).map((v) => v.entity_id);
  assert.deepEqual(ids, ["opp-l"], "only the live thread is a dead end");
});

test("a due follow-up on a suppressed thread is not flagged", () => {
  const due = opp({ id: "opp-d", primary_thread_key: "+15550100009", next_action: "schedule_follow_up", next_action_due: "2026-09-01T09:00:00.000Z" });
  const vs = evaluateAutonomyInvariants({
    opportunities: [due], followups: [], thread_states: [{ thread_key: "+15550100009", is_suppressed: true }], now: NOW,
  });
  assert.ok(!codes(vs).includes(INVARIANT_CODES.FOLLOWUP_DUE_NOT_SCHEDULED));
});

test("an EMPTY-STRING next_action on the canonical record is absent (a dead end), matching the sweep", () => {
  const vs = evaluateAutonomyInvariants({ opportunities: [opp({ next_action: "" })], now: NOW });
  assert.ok(codes(vs).includes(INVARIANT_CODES.STAGE_WITHOUT_NEXT_ACTION));
});
