import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@/lib/domain/closings/closing-authority.js";
import { evaluateClosingGuard } from "@/lib/domain/closings/closing-guard.js";
import { planClosingAutomation, runClosingAutomation, DEFAULT_CADENCE } from "@/lib/domain/closings/closing-automation.js";
import { deriveClosingExecution } from "@/lib/domain/closings/closing-execution-model.js";
import { transitionOpportunityStage, updateOpportunity } from "@/lib/domain/opportunity/opportunity-service.js";
import { makeClosingDb, makeTransitionSpy } from "../helpers/closing-db-mock.mjs";

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.parse("2026-10-01T15:00:00Z");
const OPP = "00000000-0000-4000-8000-0000000000aa";
const CASE = `closing:${OPP}`;

function seed(over = {}) {
  return {
    closing_cases: [{
      closing_case_id: CASE, opportunity_id: OPP, property_id: "prop-1", property_address: "1204 Penn Ave N, Minneapolis, MN 55411",
      thread_key: "+16125550100", universal_stage: "disposition", closing_status: "title_pending", contract_status: "fully_executed",
      contract_signed_date: new Date(T0 - 5 * D).toISOString(), seller_contract_price: 196000, earnest_money: 2000,
      title_company_key: "westline__minneapolis", title_company_name: "Westline Title", title_company_email: "orders@westline.example",
      title_route_status: "routed", readiness: {}, provenance: {}, automation_state: {}, ...over,
    }],
    acquisition_opportunities: [{ id: OPP, acquisition_stage: "disposition", opportunity_status: "active" }],
  };
}

function env(db, now = T0) {
  const notes = [];
  const tr = makeTransitionSpy(db);
  return { deps: { supabase: db, now: () => now, notify: async (n) => { notes.push(n); return { ok: true }; }, transitionOpportunityStage: tr.fn }, notes, transitions: tr.calls };
}

const actor = "operator-1";

async function committedBuyer(db, deps) {
  const offer = await A.recordBuyerOffer({ closingCaseId: CASE, buyerId: "buyer-7", buyerName: "Acme Investments LLC", offerPrice: 217500, emdAmount: 5000, emdDueDate: "2026-10-03", actor }, deps);
  await A.selectBuyerOffer({ closingCaseId: CASE, buyerOfferId: offer.buyerOfferId, actor }, deps);
  await A.recordBuyerAgreementStatus({ closingCaseId: CASE, buyerOfferId: offer.buyerOfferId, status: "sent", providerEnvelopeId: "env-77", actor }, deps);
  const ex = await A.recordBuyerAgreementStatus({ closingCaseId: CASE, buyerOfferId: offer.buyerOfferId, status: "fully_executed", providerEnvelopeId: "env-77", actor }, deps);
  return { offerId: offer.buyerOfferId, ex };
}

async function fullyReady(db, deps) {
  const { offerId } = await committedBuyer(db, deps);
  const r = await A.recordEmdReceipt({ closingCaseId: CASE, buyerOfferId: offerId, amount: 5000, receivedAt: new Date(T0 - D).toISOString(), escrowDestination: "Westline escrow", idempotencyKey: "wire-1", actor }, deps);
  await A.verifyEmdReceipt({ receiptId: r.receiptId, method: "title_provider", evidenceReference: "Westline EMD confirmation #88", actor }, deps);
  await A.acknowledgeTitleOrder({ closingCaseId: CASE, source: "title_email", actor }, deps);
  await A.recordTitleCommitment({ closingCaseId: CASE, evidenceReference: "Commitment WT-11790 v1", actor }, deps);
  await A.recordClearToClose({ closingCaseId: CASE, source: "title_email", evidenceReference: "CTC email 10/01 from Westline", actor }, deps);
  await A.setClosingDate({ closingCaseId: CASE, scheduledAt: "2026-10-02T19:00:00Z", tz: "America/Chicago", confirmed: true, reason: "Title confirmed", source: "title_email", actor }, deps);
  return { offerId };
}

async function settle(deps, over = {}) {
  return A.recordSettlement({ closingCaseId: CASE, leg: "single", strategy: "assignment", settle: true, statementType: "alta", statementReference: "Final ALTA WT-11790", actualSellerAmount: 196000, actualBuyerAmount: 217500, actualAssignmentFee: 21000, actualClosingCosts: 500, actualNetProceeds: 20500, closedAt: "2026-10-02T21:00:00Z", closingProvider: "Westline Title", verificationMethod: "title_provider", evidenceReference: "Final ALTA WT-11790 (signed)", actor, ...over }, deps);
}

/* ── S8 ─────────────────────────────────────────────────────────────── */

for (const status of ["draft", "sent_for_signature", "seller_signed"]) {
  test(`seller contract ${status} is not S8 — a buyer cannot commit`, async () => {
    const db = makeClosingDb(seed({ contract_status: status, universal_stage: "formal_contract" }));
    const { deps, transitions } = env(db);
    const offer = await A.recordBuyerOffer({ closingCaseId: CASE, buyerId: "b1", offerPrice: 100000, actor }, deps);
    await A.selectBuyerOffer({ closingCaseId: CASE, buyerOfferId: offer.buyerOfferId, actor }, deps);
    const r = await A.commitBuyer({ closingCaseId: CASE, buyerOfferId: offer.buyerOfferId, commitmentType: "other", evidenceReference: "email", actor }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.code, "SELLER_CONTRACT_NOT_EXECUTED");
    assert.equal(transitions.length, 0);
  });
}

test("selected ≠ committed; executed agreement commits and moves case + opportunity to S8", async () => {
  const db = makeClosingDb(seed());
  const { deps, transitions, notes } = env(db);
  const offer = await A.recordBuyerOffer({ closingCaseId: CASE, buyerId: "buyer-7", offerPrice: 217500, emdAmount: 5000, actor }, deps);
  await A.selectBuyerOffer({ closingCaseId: CASE, buyerOfferId: offer.buyerOfferId, actor }, deps);
  const selected = db.state.buyer_offers[0];
  assert.equal(selected.status, "selected");
  assert.equal(selected.commitment_status, "agreement_required");
  assert.equal(evaluateClosingGuard({ closingCase: db.state.closing_cases[0], offers: db.state.buyer_offers }).missing.includes("buyer_not_committed"), true);
  // No commitment from selection, nor from an evidence-free operator claim.
  assert.equal((await A.commitBuyer({ closingCaseId: CASE, buyerOfferId: offer.buyerOfferId, actor }, deps)).code, "COMMITMENT_EVIDENCE_REQUIRED");
  await A.recordBuyerAgreementStatus({ closingCaseId: CASE, buyerOfferId: offer.buyerOfferId, status: "sent", providerEnvelopeId: "env-77", actor }, deps);
  assert.equal(db.state.buyer_offers[0].commitment_status, "agreement_sent");
  assert.equal((await A.recordBuyerAgreementStatus({ closingCaseId: CASE, buyerOfferId: offer.buyerOfferId, status: "fully_executed", actor }, deps)).code, "EXECUTION_EVIDENCE_REQUIRED");
  const ex = await A.recordBuyerAgreementStatus({ closingCaseId: CASE, buyerOfferId: offer.buyerOfferId, status: "fully_executed", providerEnvelopeId: "env-77", actor }, deps);
  assert.equal(ex.commitment.ok, true);
  assert.equal(db.state.buyer_offers[0].status, "committed");
  assert.equal(db.state.closing_cases[0].universal_stage, "under_contract");
  assert.deepEqual(transitions.map((t) => t.to_stage), ["under_contract"]);
  assert.ok(notes.some((n) => n.eventType === "closing_buyer_commitment"));
});

/* ── EMD ────────────────────────────────────────────────────────────── */

test("EMD: recorded once (idempotent), verified only with provenance", async () => {
  const db = makeClosingDb(seed());
  const { deps } = env(db);
  const { offerId } = await committedBuyer(db, deps);
  const input = { closingCaseId: CASE, buyerOfferId: offerId, amount: 5000, receivedAt: "2026-09-30T16:14:00Z", escrowDestination: "Westline escrow", idempotencyKey: "wire-1", actor };
  const r1 = await A.recordEmdReceipt(input, deps);
  const r2 = await A.recordEmdReceipt(input, deps);
  assert.equal(r2.duplicate, true);
  assert.equal(db.state.emd_receipts.length, 1, "a replay never creates a second receipt");
  assert.equal(db.state.emd_receipts[0].status, "received_unverified");
  assert.equal((await A.verifyEmdReceipt({ receiptId: r1.receiptId, method: "title_provider", actor }, deps)).code, "EVIDENCE_REQUIRED");
  assert.equal((await A.verifyEmdReceipt({ receiptId: r1.receiptId, evidenceReference: "x", actor }, deps)).code, "VERIFICATION_METHOD_REQUIRED");
  assert.equal((await A.verifyEmdReceipt({ receiptId: r1.receiptId, method: "title_provider", evidenceReference: "Westline confirmation #88", actor }, deps)).ok, true);
  const v = db.state.emd_receipts[0];
  assert.equal(v.status, "verified");
  assert.equal(v.verified_by, actor);
  assert.ok(db.state.closing_activity_events.some((e) => e.event_type === "emd_verified" && e.detail.evidence));
});

test("EMD overdue is a blocker and a notification; automation reminds within bounds", async () => {
  const db = makeClosingDb(seed());
  const { deps } = env(db);
  const { offerId } = await committedBuyer(db, deps);
  db.state.buyer_offers[0].metadata.buyer_email = "ops@acme.example";
  const due = Date.parse("2026-10-03T00:00:00Z");
  // 40h after the due DATE (the model measures in the property's zone: CT).
  const plan = planClosingAutomation({ closingCase: db.state.closing_cases[0], offers: db.state.buyer_offers, agreements: db.state.buyer_agreements, emdReceipts: [], requests: [], now: due + 40 * H });
  assert.ok(plan.actions.some((a) => a.type === "notify" && a.eventType === "closing_earnest_money_due"));
  const x = deriveClosingExecution({ closingCase: db.state.closing_cases[0], offers: db.state.buyer_offers, agreements: db.state.buyer_agreements, now: due + 40 * H });
  assert.equal(x.emd.buyer.state, "overdue");
  assert.ok(x.blockers.some((b) => b.key === "emd_overdue"));
  void offerId;
});

test("EMD waiver needs a reason AND evidence, and is recorded, not implied", async () => {
  const db = makeClosingDb(seed());
  const { deps } = env(db);
  await committedBuyer(db, deps);
  assert.equal((await A.waiveBuyerEmd({ closingCaseId: CASE, reason: "cash buyer", actor }, deps)).code, "WAIVER_NEEDS_REASON_AND_EVIDENCE");
  assert.equal((await A.waiveBuyerEmd({ closingCaseId: CASE, reason: "cash buyer, funds at title", evidenceReference: "Title email 10/01", actor }, deps)).ok, true);
  assert.equal(db.state.buyer_offers[0].emd_status, "not_required");
  assert.ok(db.state.buyer_offers[0].metadata.emd_waiver.evidence);
});

/* ── TITLE ──────────────────────────────────────────────────────────── */

test("title: issue blocks clear-to-close; resolution needs evidence; CTC needs a trusted source + evidence", async () => {
  const db = makeClosingDb(seed());
  const { deps, notes } = env(db);
  await A.acknowledgeTitleOrder({ closingCaseId: CASE, source: "title_email", actor }, deps);
  assert.ok(db.state.closing_cases[0].title_acknowledged_at);
  assert.equal((await A.recordTitleCommitment({ closingCaseId: CASE, actor }, deps)).code, "EVIDENCE_REQUIRED");
  await A.recordTitleCommitment({ closingCaseId: CASE, evidenceReference: "Commitment v1", actor }, deps);
  const issue = await A.openTitleIssue({ closingCaseId: CASE, issueType: "open_lien", description: "2019 HELOC not released", source: "title_commitment", actor }, deps);
  assert.ok(notes.some((n) => n.eventType === "closing_title_issue"));
  const blocked = await A.recordClearToClose({ closingCaseId: CASE, source: "title_email", evidenceReference: "CTC", actor }, deps);
  assert.equal(blocked.code, "OPEN_TITLE_ISSUES");
  assert.equal((await A.updateTitleIssue({ issueId: issue.issueId, status: "resolved", actor }, deps)).code, "RESOLUTION_EVIDENCE_REQUIRED");
  assert.equal((await A.updateTitleIssue({ issueId: issue.issueId, status: "resolved", resolutionEvidence: "Release recorded Doc #123", actor }, deps)).ok, true);
  assert.equal((await A.recordClearToClose({ closingCaseId: CASE, source: "vibes", evidenceReference: "CTC", actor }, deps)).code, "CTC_SOURCE_REQUIRED");
  assert.equal((await A.recordClearToClose({ closingCaseId: CASE, source: "title_email", actor }, deps)).code, "EVIDENCE_REQUIRED");
  assert.equal((await A.recordClearToClose({ closingCaseId: CASE, source: "title_email", evidenceReference: "CTC email from Westline", actor }, deps)).ok, true);
  const c = db.state.closing_cases[0];
  assert.ok(c.clear_to_close_at && c.clear_to_close_source === "title_email" && c.clear_to_close_actor === actor);
});

test("clear-to-close is never inferred from the absence of problems", () => {
  const c = { ...seed().closing_cases[0], title_commitment_received_at: "2026-09-30T00:00:00Z", scheduled_closing_date: "2026-10-02T19:00:00Z", closing_date_confirmed_at: "2026-09-30T00:00:00Z" };
  const x = deriveClosingExecution({ closingCase: c, now: T0 });
  assert.equal(x.title.clearToClose, false);
  assert.equal(x.rail.find((r) => r.key === "title").detail, "Commitment received — awaiting clear to close");
});

/* ── CLOSING DATE ───────────────────────────────────────────────────── */

test("reschedule keeps history (before → after, reason, source), zone, and confirmation", async () => {
  const db = makeClosingDb(seed());
  const { deps, notes } = env(db);
  assert.equal((await A.setClosingDate({ closingCaseId: CASE, scheduledAt: "2026-09-30T19:00:00Z", confirmed: true, source: "title_email", actor }, deps)).code, "REASON_REQUIRED");
  await A.setClosingDate({ closingCaseId: CASE, scheduledAt: "2026-09-30T19:00:00Z", tz: "America/Chicago", confirmed: true, reason: "Initial schedule", source: "title_email", actor }, deps);
  await A.setClosingDate({ closingCaseId: CASE, scheduledAt: "2026-10-02T19:00:00Z", tz: "America/Chicago", confirmed: true, reason: "Title commitment delayed", source: "operator", actor }, { ...deps, now: () => T0 + H });
  const c = db.state.closing_cases[0];
  assert.equal(c.scheduled_closing_date, "2026-10-02T19:00:00.000Z");
  assert.equal(c.closing_tz, "America/Chicago");
  assert.equal(c.closing_status, "scheduled");
  const history = db.state.closing_activity_events.filter((e) => e.event_type === "closing_date_changed");
  assert.equal(history.length, 2);
  assert.equal(history[1].detail.before.at, "2026-09-30T19:00:00.000Z", "the prior date is kept");
  assert.equal(history[1].detail.reason, "Title commitment delayed");
  assert.ok(notes.some((n) => n.eventType === "closing_status_changed"), "reschedule notifies");
});

test("S9 Prepared to Close = clear to close AND confirmed date (after S8)", async () => {
  const db = makeClosingDb(seed());
  const { deps, transitions } = env(db);
  await fullyReady(db, deps);
  assert.equal(db.state.closing_cases[0].universal_stage, "prepared_to_close");
  assert.deepEqual(transitions.map((t) => t.to_stage), ["under_contract", "prepared_to_close"]);
  assert.ok(transitions.every((t) => t.to_stage !== "closed"), "no lifecycle write ever targets closed");
});

/* ── SETTLEMENT ─────────────────────────────────────────────────────── */

test("settlement: draft stays pending; settled needs evidence; settled is immutable; weak extraction needs review", async () => {
  const db = makeClosingDb(seed());
  const { deps } = env(db);
  const draft = await A.recordSettlement({ closingCaseId: CASE, statementType: "alta", statementReference: "ALTA draft v2", actualNetProceeds: 20000, actor }, deps);
  assert.equal(draft.status, "pending");
  assert.equal((await A.recordSettlement({ closingCaseId: CASE, settle: true, actualNetProceeds: 20500, actor }, deps)).code, "VERIFICATION_METHOD_REQUIRED");
  assert.equal((await settle(deps, { extractionConfidence: 0.7 })).code, "REVIEW_REQUIRED", "parsed money is never settled on low confidence");
  assert.equal((await settle(deps)).status, "settled");
  assert.equal((await settle(deps, { actualNetProceeds: 99999 })).code, "SETTLEMENT_IMMUTABLE");
  assert.equal(db.state.settlement_records[0].actual_net_proceeds, 20500);
});

test("actual vs expected stay separate: the model never shows an estimate as actual", async () => {
  const db = makeClosingDb(seed({ assignment_fee: 21500 }));
  const { deps } = env(db);
  const pre = deriveClosingExecution({ closingCase: db.state.closing_cases[0], now: T0 });
  assert.equal(pre.money.actual, null);
  assert.equal(pre.money.estimated.assignmentFee.value, 21500);
  await settle(deps);
  const post = deriveClosingExecution({ closingCase: db.state.closing_cases[0], settlements: db.state.settlement_records, now: T0 });
  assert.equal(post.money.actual.assignmentFee, 21000);
  assert.equal(post.money.estimated.assignmentFee.value, 21500, "the estimate is kept as an estimate");
});

/* ── S10 NEGATIVES ──────────────────────────────────────────────────── */

test("S10 cannot happen from: a passed date, a reason, a selected buyer, an EMD proposal, a commitment w/o CTC, a draft settlement, expected economics", async () => {
  const past = seed({ scheduled_closing_date: "2026-09-20T19:00:00Z", closing_date_confirmed_at: "2026-09-10T00:00:00Z", closing_status: "scheduled", assignment_fee: 18000, expected_gross_revenue: 18000 });
  const db = makeClosingDb(past);
  const { deps } = env(db);
  const offer = await A.recordBuyerOffer({ closingCaseId: CASE, buyerId: "b1", offerPrice: 200000, emdAmount: 5000, actor }, deps);
  await A.selectBuyerOffer({ closingCaseId: CASE, buyerOfferId: offer.buyerOfferId, actor }, deps);
  db.state.buyer_offers[0].emd_status = "received"; // a proposal field
  db.state.buyer_offers[0].emd_received_at = "2026-09-25T00:00:00Z";
  await A.recordTitleCommitment({ closingCaseId: CASE, evidenceReference: "Commitment v1", actor }, deps);
  await A.recordSettlement({ closingCaseId: CASE, statementReference: "ALTA draft", actualNetProceeds: 17000, actor }, deps);
  const r = await A.finalizeClosing({ closingCaseId: CASE, actor }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, "CLOSING_BLOCKED");
  for (const code of ["buyer_not_committed", "buyer_agreement_not_executed", "emd_not_verified", "title_not_clear_to_close", "settlement_not_settled", "settlement_leg_unsettled"]) {
    assert.ok(r.missing.includes(code), `missing ${code}`);
  }
  assert.ok(r.blockers.every((b) => b.code && b.message && b.owner), "structured blockers: what + who");
  assert.equal(db.state.closing_cases[0].closing_status, "scheduled");
  assert.equal(db.state.acquisition_opportunities[0].opportunity_status, "active");
});

test("Pipeline 'move to Closed' with only a reason is refused with blockers (no direct stage write)", async () => {
  const db = makeClosingDb(seed());
  db.state.acquisition_opportunities[0] = { id: OPP, acquisition_stage: "prepared_to_close", opportunity_status: "active", version: 3 };
  const r = await transitionOpportunityStage(OPP, { to_stage: "closed", reason: "it closed, trust me", actor }, { supabase: db, notify: async () => null });
  assert.equal(r.ok, false);
  assert.equal(r.code, "CLOSING_BLOCKED");
  assert.ok(r.blockers.length > 0);
  assert.equal(r.open, `/closing-desk?case=${encodeURIComponent(CASE)}`);
  assert.equal(db.state.acquisition_opportunities[0].acquisition_stage, "prepared_to_close");
});

test("status 'won' cannot be patched onto an opportunity", async () => {
  const db = makeClosingDb(seed());
  const r = await updateOpportunity(OPP, { opportunity_status: "won" }, { supabase: db });
  assert.equal(r.code, "CLOSING_BLOCKED");
});

test("the DB backstop refuses closed-won for any writer that skips the authority", async () => {
  const db = makeClosingDb(seed());
  const { error } = await db.from("acquisition_opportunities").update({ acquisition_stage: "closed" }).eq("id", OPP);
  assert.match(error.message, /CLOSING_BLOCKED/);
  // Closed-LOST stays an ordinary write.
  const lost = await db.from("acquisition_opportunities").update({ acquisition_stage: "closed", opportunity_status: "dead" }).eq("id", OPP);
  assert.equal(lost.error, null);
});

/* ── S10 POSITIVE ───────────────────────────────────────────────────── */

test("S10: one complete transaction closes once, through the same authority Pipeline uses", async () => {
  const db = makeClosingDb(seed({ assignment_fee: 21500 }));
  const { deps, notes } = env(db);
  await fullyReady(db, deps);
  await settle(deps);
  const guard = await A.getClosingGuard(CASE, deps);
  assert.equal(guard.ok, true, JSON.stringify(guard.missing));
  const r1 = await A.finalizeClosing({ closingCaseId: CASE, actor }, deps);
  assert.equal(r1.ok, true);
  assert.equal(r1.alreadyClosed, false);
  const c = db.state.closing_cases[0];
  assert.equal(c.closing_status, "closed");
  assert.ok(c.closed_at);
  assert.equal(c.confirmed_gross_revenue, 21000, "revenue is the settled actual, not the 21,500 estimate");
  assert.equal(db.state.acquisition_opportunities[0].acquisition_stage, "closed");
  assert.equal(db.state.acquisition_opportunities[0].opportunity_status, "won");
  assert.equal(db.state.closing_activity_events.filter((e) => e.event_type === "closing_finalized").length, 1);
  assert.ok(notes.some((n) => n.eventType === "closing_case_completed"));
  const r2 = await A.finalizeClosing({ closingCaseId: CASE, actor }, deps);
  assert.equal(r2.alreadyClosed, true, "repeat is a no-op");
  assert.equal(db.state.closing_milestones.filter((m) => m.milestone_type === "closed").length, 1);
  assert.equal(db.state.settlement_records[0].actual_net_proceeds, 20500, "actuals retained");
  // Pipeline's path reaches the same authority and is idempotent too.
  const viaPipeline = await transitionOpportunityStage(OPP, { to_stage: "closed", actor }, { ...deps });
  assert.equal(viaPipeline.ok, true);
});

/* ── CANCELLATION ───────────────────────────────────────────────────── */

test("cancellation stops automation, keeps history, and can never close", async () => {
  const db = makeClosingDb(seed());
  const { deps } = env(db);
  await runClosingAutomation({ now: T0 }, { ...deps, getSystemValue: async (k) => (k === "closing_automation_enabled" ? "true" : null), setSystemValues: async () => null });
  assert.equal(db.state.closing_email_requests.filter((r) => r.status === "pending_transport").length, 1, "title open requested");
  assert.equal((await A.terminateClosing({ closingCaseId: CASE, outcome: "withdrawn", actor }, deps)).code, "REASON_REQUIRED");
  await A.terminateClosing({ closingCaseId: CASE, outcome: "withdrawn", reason: "Buyer and seller mutually released", actor }, deps);
  assert.equal(db.state.closing_email_requests[0].status, "cancelled");
  const plan = planClosingAutomation({ closingCase: db.state.closing_cases[0], requests: db.state.closing_email_requests, now: T0 + 5 * D });
  assert.equal(plan.actions.filter((a) => a.type === "email").length, 0);
  const x = deriveClosingExecution({ closingCase: db.state.closing_cases[0], now: T0 });
  assert.equal(x.state.label, "Withdrawn");
  assert.equal((await A.finalizeClosing({ closingCaseId: CASE, actor }, deps)).missing.includes("closing_terminated"), true);
  assert.ok(db.state.closing_activity_events.some((e) => e.event_type === "closing_terminated"));
});

/* ── AUTOMATION ─────────────────────────────────────────────────────── */

const runAt = (db, deps, now) => runClosingAutomation({ now }, { ...deps, now: () => now, getSystemValue: async (k) => (k === "closing_automation_enabled" ? "true" : null), setSystemValues: async () => null });
const markSent = (db, category, at) => { for (const r of db.state.closing_email_requests.filter((x) => x.category === category && x.status === "pending_transport")) Object.assign(r, { status: "sent", sent_at: new Date(at).toISOString() }); };

test("normal closing runs without any manual stage mutation", async () => {
  const db = makeClosingDb(seed({ title_commitment_date: "2026-10-06T00:00:00Z" }));
  const { deps, transitions } = env(db);
  await runAt(db, deps, T0);
  const open = db.state.closing_email_requests.find((r) => r.category === "title_open");
  assert.equal(open.action, "title_open");
  assert.equal(open.recipient_email, "orders@westline.example");
  assert.equal(open.thread_key, `closing:${CASE}:title`);
  await runAt(db, deps, T0 + 10 * 60_000);
  assert.equal(db.state.closing_email_requests.filter((r) => r.category === "title_open").length, 1, "never requested twice");
  markSent(db, "title_open", T0 + H);
  await runAt(db, deps, T0 + 26 * H);
  assert.equal(db.state.closing_email_requests.filter((r) => r.category === "title_ack").length, 1, "acknowledgement follow-up after 24h");
  await A.acknowledgeTitleOrder({ closingCaseId: CASE, source: "title_email", actor: "title-inbound" }, deps);
  await runAt(db, deps, T0 + 27 * H);
  assert.equal(db.state.closing_email_requests.find((r) => r.category === "title_ack").status, "cancelled", "stops once acknowledged");
  await A.recordTitleCommitment({ closingCaseId: CASE, evidenceReference: "Commitment v1", actor: "title-inbound" }, deps);
  await fullyReady(db, deps);
  await settle(deps);
  const fin = await A.finalizeClosing({ closingCaseId: CASE, actor: "operator-1" }, deps);
  assert.equal(fin.ok, true);
  assert.deepEqual(transitions.map((t) => t.to_stage), ["under_contract", "prepared_to_close"], "every stage move came from the authority");
  assert.equal(db.state.closing_email_requests.filter((r) => r.status === "pending_transport").length, 0, "nothing left to send after close");
});

test("title never responds → 3 follow-ups → escalation, NEEDS YOU, notification, then silence", async () => {
  const db = makeClosingDb(seed());
  const { deps, notes } = env(db);
  await runAt(db, deps, T0);
  markSent(db, "title_open", T0);
  for (let i = 1; i <= 3; i += 1) {
    await runAt(db, deps, T0 + (24 * i + 1) * H);
    markSent(db, "title_ack", T0 + (24 * i + 1) * H);
  }
  assert.equal(db.state.closing_email_requests.filter((r) => r.category === "title_ack").length, 3);
  await runAt(db, deps, T0 + (24 * 4 + 1) * H);
  assert.equal(db.state.closing_email_requests.filter((r) => r.category === "title_ack").length, 3, "no 4th chase");
  const esc = db.state.closing_cases[0].automation_state.escalations.title_ack;
  assert.match(esc.message, /not acknowledged the order after 3 follow-ups/);
  assert.ok(notes.some((n) => n.eventType === "closing_party_unreachable"));
  const x = deriveClosingExecution({ closingCase: db.state.closing_cases[0], emailRequests: db.state.closing_email_requests, now: T0 + 5 * D });
  assert.equal(x.next.owner, "you");
  assert.match(x.next.what, /3 follow-ups/);
  await runAt(db, deps, T0 + 6 * D);
  assert.equal(notes.filter((n) => n.eventType === "closing_party_unreachable").length, 1, "escalates once");
});

test("bounded catch-up: a follow-up missed by days is not sent — it escalates", () => {
  const c = { ...seed().closing_cases[0], title_intro_sent_at: new Date(T0).toISOString() };
  const plan = planClosingAutomation({ closingCase: c, requests: [{ category: "title_open", status: "sent" }], now: T0 + 12 * D });
  assert.equal(plan.actions.filter((a) => a.type === "email" && a.category === "title_ack").length, 0);
  assert.ok(plan.actions.some((a) => a.type === "escalate" && a.reason === "stale_followup_not_sent"));
});

test("an email is never chased before it was sent; a missing address escalates instead of sending to nobody", () => {
  const c = { ...seed().closing_cases[0] };
  const plan = planClosingAutomation({ closingCase: c, requests: [{ category: "title_open", status: "pending_transport" }], now: T0 + 5 * D });
  assert.equal(plan.actions.filter((a) => a.category === "title_ack").length, 0);
  const noAddr = planClosingAutomation({ closingCase: { ...c, title_company_email: null, title_intro_sent_at: new Date(T0).toISOString() }, requests: [], now: T0 + 25 * H });
  assert.ok(noAddr.actions.some((a) => a.type === "escalate" && a.reason === "no_recipient_address"));
});

test("paused automation creates nothing and withdraws what was pending", async () => {
  const db = makeClosingDb(seed());
  const { deps } = env(db);
  await runAt(db, deps, T0);
  assert.equal((await A.setAutomationPaused({ closingCaseId: CASE, paused: true, actor }, deps)).code, "REASON_REQUIRED");
  await A.setAutomationPaused({ closingCaseId: CASE, paused: true, reason: "Handling title by phone", actor }, deps);
  await runAt(db, deps, T0 + 2 * D);
  assert.equal(db.state.closing_email_requests.every((r) => r.status === "cancelled"), true);
});

test("cadence is configuration, not code", () => {
  assert.equal(DEFAULT_CADENCE.title_ack.max, 3);
  assert.equal(typeof DEFAULT_CADENCE.catchUpHours, "number");
});

/* ── CLOSING DESK 3.0 — execution truths through the real authority ──── */

import { evaluateSendSafety } from "@/lib/domain/email/email-send-safety.js";
import { writeBackClosingRequest } from "@/lib/domain/email/email-closing-bridge.js";

test("EMD overdue → automated reminder → receipt verified → the blocker resolves (and is shown resolved)", async () => {
  const db = makeClosingDb(seed());
  const { deps } = env(db);
  const { offerId } = await committedBuyer(db, deps);
  db.state.buyer_offers[0].metadata.buyer_email = "ops@acme.example";
  const due = Date.parse("2026-10-03T00:00:00Z");
  const t1 = due + 30 * H;
  // Reminders on cadence (24h before due, then daily); each is marked sent as the dispatcher would.
  for (const at of [due - 24 * H, due, t1]) {
    await runAt(db, deps, at);
    markSent(db, "buyer_emd", at + 60_000);
  }
  const view = (now) => deriveClosingExecution({ closingCase: db.state.closing_cases[0], offers: db.state.buyer_offers, agreements: db.state.buyer_agreements, emdReceipts: db.state.emd_receipts, emailRequests: db.state.closing_email_requests, runtime: { automationEnabled: true, emailSendEnabled: true, heartbeatAt: new Date(now).toISOString() }, now });
  const before = view(t1 + H);
  assert.equal(before.emd.buyer.state, "overdue");
  assert.ok(before.blockers.some((b) => b.key === "emd_overdue"));
  assert.equal(db.state.closing_email_requests.filter((r) => r.category === "buyer_emd" && r.status === "sent").length, 3, "three reminders went out");
  const r = await A.recordEmdReceipt({ closingCaseId: CASE, buyerOfferId: offerId, amount: 5000, receivedAt: new Date(t1 + 2 * H).toISOString(), escrowDestination: "Westline escrow", idempotencyKey: "wire-late", actor }, deps);
  await A.verifyEmdReceipt({ receiptId: r.receiptId, method: "title_provider", evidenceReference: "Westline EMD confirmation #91", actor }, { ...deps, now: () => t1 + 3 * H });
  const after = view(t1 + 4 * H);
  assert.equal(after.emd.buyer.state, "verified");
  assert.ok(!after.blockers.some((b) => b.key === "emd_overdue"), "the blocker is gone");
  const resolved = after.items.find((i) => i.key === "emd_resolved");
  assert.equal(resolved?.severity, "resolved");
  assert.match(resolved.why, /Westline EMD confirmation #91/);
  const plan = planClosingAutomation({ closingCase: db.state.closing_cases[0], offers: db.state.buyer_offers, agreements: db.state.buyer_agreements, emdReceipts: db.state.emd_receipts, requests: db.state.closing_email_requests, now: t1 + 5 * H });
  assert.ok(plan.schedule.some((s) => s.category === "buyer_emd" && s.state === "satisfied"), "the reminder loop stops");
  assert.equal(plan.actions.filter((a) => a.type === "email" && a.category === "buyer_emd").length, 0);
});

test("a date change through the canonical route moves the closing — one event, same identity, prior date kept as history", async () => {
  const db = makeClosingDb(seed());
  const { deps } = env(db);
  await A.setClosingDate({ closingCaseId: CASE, scheduledAt: "2026-10-05T19:00:00Z", tz: "America/Chicago", confirmed: true, reason: "Title scheduled", source: "title_email", actor }, deps);
  const view = () => deriveClosingExecution({ closingCase: db.state.closing_cases[0], activity: db.state.closing_activity_events, now: T0 });
  const first = view();
  await A.setClosingDate({ closingCaseId: CASE, scheduledAt: "2026-10-07T20:30:00Z", tz: "America/Chicago", confirmed: true, reason: "Buyer's lender needs two days", source: "operator", actor }, { ...deps, now: () => T0 + H });
  const moved = view();
  assert.equal(moved.closing.calendar.eventId, first.closing.calendar.eventId, "the calendar event keeps its identity");
  assert.equal(moved.closing.date, "2026-10-07");
  assert.equal(moved.closing.time, "15:30");
  assert.ok(!moved.deadlines.some((d) => d.key === "closing" || d.state === "superseded"), "the closing date is never a second deadline");
  const history = moved.deadlineHistory.filter((d) => d.state === "superseded");
  assert.equal(history.length, 1);
  assert.equal(history[0].date, "2026-10-05");
  assert.equal(history[0].reason, "Buyer's lender needs two days");
  // Calendar projects closings from this same model (when that projection is present in the tree).
  const cal = await import("@/lib/domain/calendar/calendar-timeline-service.js");
  if (typeof cal.buildClosingModelEvents === "function") {
    const events = cal.buildClosingModelEvents([moved], { from: "2026-09-01", to: "2026-12-31", today: "2026-10-01" })
    const closings = events.filter((e) => e.type === "closing");
    assert.equal(closings.length, 1, "no duplicate closing event after the move");
    assert.equal(closings[0].id, moved.closing.calendar.eventId);
    assert.equal(closings[0].date, "2026-10-07");
  }
});

test("a title reply supersedes a planned follow-up (email safety policy) and the closing request records why", async () => {
  const db = makeClosingDb(seed());
  const { deps } = env(db);
  await runAt(db, deps, T0);
  markSent(db, "title_open", T0);
  await runAt(db, deps, T0 + 25 * H);
  const req = db.state.closing_email_requests.find((r) => r.category === "title_ack");
  assert.equal(req.status, "pending_transport");
  // Dispatch time: the title company replied after the chase was planned.
  const row = { source: "closing", source_ref: req.request_key, action_key: "closing.title_followup", sequence: 1, to_email: "orders@westline.example", subject: "Following up", text_body: "…", created_at: new Date(T0 + 25 * H).toISOString(), scheduled_for: new Date(T0 + 25 * H).toISOString() };
  const verdict = evaluateSendSafety({ row, thread: { automation_state: "active", resolution_status: "resolved", last_inbound_at: new Date(T0 + 25 * H + 20 * 60_000).toISOString() }, revalidation: { state: "still_needed" }, sender: { ok: true, sender: {} }, now: T0 + 25 * H + 30 * 60_000 });
  assert.deepEqual([verdict.decision, verdict.code], ["supersede", "counterparty_replied"]);
  await writeBackClosingRequest(db, row, { status: "superseded", code: verdict.code }, T0 + 25 * H + 30 * 60_000);
  assert.equal(req.status, "cancelled");
  assert.equal(req.status_reason, "counterparty_replied");
  const x = deriveClosingExecution({ closingCase: db.state.closing_cases[0], emailRequests: db.state.closing_email_requests, now: T0 + 26 * H });
  const shown = x.automation.emails.find((e) => e.category === "title_ack");
  assert.equal(shown.status, "cancelled");
  assert.equal(shown.reason, "counterparty_replied");
  await runAt(db, deps, T0 + 27 * H);
  assert.equal(db.state.closing_email_requests.filter((r) => r.category === "title_ack").length, 1, "the superseded follow-up is never re-sent");
});

test("automation never resolves a title issue — paused or running, it stays open until an operator resolves it with evidence", async () => {
  const db = makeClosingDb(seed({ title_acknowledged_at: new Date(T0 - 2 * D).toISOString(), title_intro_sent_at: new Date(T0 - 3 * D).toISOString() }));
  const { deps } = env(db);
  const issue = await A.openTitleIssue({ closingCaseId: CASE, issueType: "missing_release", description: "Unreleased 2019 mortgage", owner: "you", source: "title_commitment", actor: "email_command" }, deps);
  await A.setAutomationPaused({ closingCaseId: CASE, paused: true, reason: "Unreleased mortgage — needs operator direction", actor }, deps);
  await runAt(db, deps, T0 + D);
  await A.setAutomationPaused({ closingCaseId: CASE, paused: false, actor }, deps);
  await runAt(db, deps, T0 + 2 * D);
  assert.equal(db.state.closing_title_issues.find((i) => i.issue_id === issue.issueId).status, "open");
  assert.equal((await A.recordClearToClose({ closingCaseId: CASE, source: "title_email", evidenceReference: "CTC email", actor: "email_command" }, deps)).code, "OPEN_TITLE_ISSUES", "a title email cannot clear it either");
});
