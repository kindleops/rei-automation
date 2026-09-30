import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { deriveClosingExecution, summarizePortfolio, summarizeClosing, describeWhen, parseAddress, groupOf, READY_REQUIREMENTS } from "@/lib/domain/closings/closing-execution-model.js";
import { evaluateClosingGuard } from "@/lib/domain/closings/closing-guard.js";
import { planClosingAutomation } from "@/lib/domain/closings/closing-automation.js";
import { closingScenarios, SCENARIO_NOW } from "../fixtures/closing-execution-scenarios.mjs";

const NOW = SCENARIO_NOW;
const H = 3_600_000;
const scenario = (name) => closingScenarios(NOW).find((s) => s.scenario === name);
const all = () => closingScenarios(NOW).map((s) => ({ scenario: s.scenario, x: deriveClosingExecution({ ...s, now: NOW }) }));
const get = (name) => deriveClosingExecution({ ...scenario(name), now: NOW });
const hardItems = (x) => x.items.filter((i) => i.severity === "blocking" || i.severity === "overdue");

/* ── READY ─────────────────────────────────────────────────────────────── */

test("ready-to-close fixture → READY TO CLOSE 7/7, no blocker, closing today", () => {
  const x = get("ready_to_close_today");
  assert.equal(x.ready, true);
  assert.equal(x.state.key, "ready_to_close");
  assert.deepEqual(x.readiness, { met: 7, total: 7 });
  assert.equal(x.blockers.length, 0);
  assert.equal(hardItems(x).length, 0);
  assert.equal(x.group, "closing_today");
  assert.equal(x.proximity.key, "today");
  assert.equal(x.closing.time, "14:00");
  assert.equal(x.closing.tz, "America/Chicago");
  assert.equal(x.title.ctc.source, "title_email", "clear to close carries its provenance");
  assert.ok(x.title.ctc.evidence && x.title.ctc.actor && x.title.ctc.at);
});

test("READY is the canonical S10 guard's seven pre-closing requirements — no desk-only rule", () => {
  assert.deepEqual(READY_REQUIREMENTS.map((r) => r.code), ["seller_contract_not_executed", "buyer_not_committed", "buyer_agreement_not_executed", "emd_not_verified", "open_title_issues", "title_not_clear_to_close", "closing_date_not_confirmed"]);
  for (const { scenario: name, x } of all()) {
    const s = scenario(name);
    const guard = evaluateClosingGuard({ closingCase: s.closingCase, offers: s.offers, agreements: s.agreements, emdReceipts: s.emdReceipts, settlements: s.settlements, titleIssues: s.titleIssues });
    for (const r of x.requirements) assert.equal(r.met, !guard.missing.includes(r.code), `${name}: ${r.key} must match the guard`);
  }
  // Remove only clear-to-close: no longer ready, even though nothing is "wrong".
  const s = scenario("ready_to_close_today");
  const notClear = deriveClosingExecution({ ...s, closingCase: { ...s.closingCase, clear_to_close_at: null, clear_to_close_source: null, clear_to_close_evidence: null, clear_to_close_actor: null }, now: NOW });
  assert.equal(notClear.ready, false);
  assert.equal(notClear.requirements.find((r) => r.key === "title").met, false);
  assert.equal(notClear.title.legacyCtcFlag, true, "a readiness flag without provenance is surfaced, never counted");
  // A date the workflow calls "scheduled" is still a target until the authority confirms it.
  const unconfirmed = deriveClosingExecution({ ...s, closingCase: { ...s.closingCase, closing_date_confirmed_at: null }, now: NOW });
  assert.equal(unconfirmed.closing.confirmed, false);
  assert.equal(unconfirmed.requirements.find((r) => r.key === "schedule").met, false);
  assert.equal(unconfirmed.ready, false);
});

/* ── EMD ───────────────────────────────────────────────────────────────── */

test("EMD claimed on an offer without a receipt → NOT VERIFIED, not ready", () => {
  const x = get("closing_tomorrow_emd_overdue");
  assert.equal(x.emd.buyer.state, "overdue", "offer says emd_status=received with a timestamp, but no receipt exists");
  assert.equal(x.emd.buyer.receipt, null);
  assert.equal(x.requirements.find((r) => r.key === "emd").met, false);
  assert.equal(x.ready, false);
  assert.equal(x.state.key, "emd_overdue");
  assert.equal(x.blockers[0].key, "emd_overdue");
  assert.equal(x.blockers[0].owner, "buyer");
  assert.ok(x.blockers[0].why, "every blocker says why it matters");
  // Even with every other requirement met, an offer's own "verified" claim is not a receipt.
  const s = scenario("ready_to_close_today");
  const claimed = deriveClosingExecution({ ...s, offers: [{ ...s.offers[0], emd_status: "verified", emd_received_at: new Date(NOW - 5 * H).toISOString() }], emdReceipts: [], now: NOW });
  assert.equal(claimed.requirements.find((r) => r.key === "emd").met, false);
  assert.equal(claimed.ready, false);
  assert.notEqual(claimed.emd.buyer.state, "verified");
});

test("received-but-unverified EMD is a human decision, not verified, not ready", () => {
  const x = get("emd_received_unverified");
  assert.equal(x.emd.buyer.state, "received");
  assert.equal(x.requirements.find((r) => r.key === "emd").met, false);
  assert.equal(x.ready, false);
  const item = x.items.find((i) => i.key === "emd_unverified");
  assert.equal(item.group, "human_decision");
  assert.equal(item.severity, "pending", "open, but not a blocker");
  assert.equal(x.ball.owner, "you");
  assert.equal(x.group, "needs_you");
});

/* ── DATE / CLOSED ─────────────────────────────────────────────────────── */

test("date passed without a close → CLOSING DATE PASSED — NOT CLOSED, never auto-closed", () => {
  const x = get("date_passed_not_closed");
  assert.equal(x.closed, false);
  assert.equal(x.state.key, "date_passed");
  assert.equal(x.state.label, "Closing date passed — not closed");
  assert.equal(x.readiness.met, 7, "the checklist can be complete…");
  assert.equal(x.ready, false, "…but a passed date blocks READY");
  assert.ok(x.blockers.some((b) => b.key === "date_passed"));
  assert.equal(x.ball.owner, "you");
  assert.equal(x.proximity.key, "passed");
  assert.equal(x.finalize.ok, false, "no settlement record — the S10 guard refuses");
  assert.ok(x.finalize.missing.includes("settlement_not_settled"));
});

test("expected $18,000 vs settled $17,480: both visible, distinct, with variance", () => {
  const closed = get("closed_settled");
  assert.equal(closed.closed, true);
  assert.equal(closed.state.key, "closed");
  assert.equal(closed.money.estimated.assignmentFee.value, 18000, "the estimate is kept, never overwritten");
  assert.equal(closed.money.actual.assignmentFee, 17480);
  assert.equal(closed.money.actual.netProceeds, 17480);
  assert.deepEqual(closed.money.expectedFeeVsActual, { expected: 18000, actual: 17480 });
  const fee = closed.money.comparison.find((r) => r.key === "fee");
  assert.deepEqual(fee, { key: "fee", label: "Assignment fee", expected: 18000, actual: 17480, variance: -520 });
  assert.equal(closed.money.actual.legs[0].evidence, "Final ALTA — WT-26-11355 (signed)");
  const pending = get("ready_to_close_today");
  assert.equal(pending.money.actual, null, "a pending settlement is not an actual");
  assert.equal(pending.money.comparison.find((r) => r.key === "fee").actual, null);
});

test("closed without a settlement record → honest 'settlement record unavailable', no invented actuals", () => {
  const x = get("closed_no_settlement");
  assert.equal(x.closed, true);
  assert.equal(x.money.actual, null);
  assert.equal(x.state.label, "Closed · settlement record unavailable");
  assert.equal(x.rail.find((r) => r.key === "close").detail, "Closed — settlement record unavailable");
  assert.equal(x.money.estimated.assignmentFee.value, 16500, "expected stays labelled expected");
  assert.equal(x.ball, null);
  // Same for the settled fixture with its settlement removed.
  const s = scenario("closed_settled");
  const bare = deriveClosingExecution({ ...s, settlements: [], now: NOW });
  assert.equal(bare.money.actual, null);
  assert.match(bare.state.label, /settlement record unavailable/);
});

/* ── TITLE ─────────────────────────────────────────────────────────────── */

test("an open title issue blocks clear-to-close and READY; it is never auto-resolved", () => {
  const s = scenario("title_issue_automation_paused");
  const x = deriveClosingExecution({ ...s, now: NOW });
  assert.equal(x.requirements.find((r) => r.key === "issues").met, false);
  assert.equal(x.requirements.find((r) => r.key === "title").met, false);
  assert.equal(x.state.tone, "blocked");
  const issue = x.items.find((i) => i.key.startsWith("title_issue:"));
  assert.equal(issue.severity, "blocking");
  assert.equal(issue.what, "Unreleased mortgage: automation paused, needs operator direction");
  assert.equal(issue.owner, "you");
  assert.equal(x.ball.owner, "you");
  assert.ok(x.items.some((i) => i.key === "automation_paused" && i.group === "human_decision"));
  assert.ok(evaluateClosingGuard({ closingCase: s.closingCase, offers: s.offers, agreements: s.agreements, emdReceipts: s.emdReceipts, titleIssues: s.titleIssues }).missing.includes("open_title_issues"));
  // Automation never touches title issues — paused or not.
  for (const paused of [s.closingCase.automation_paused_at, null]) {
    const plan = planClosingAutomation({ closingCase: { ...s.closingCase, automation_paused_at: paused }, offers: s.offers, agreements: s.agreements, emdReceipts: s.emdReceipts, requests: s.emailRequests, now: NOW + 3 * 24 * H });
    assert.ok(plan.actions.every((a) => !/issue/i.test(JSON.stringify(a))), "no planner action resolves or waives an issue");
  }
});

/* ── SYSTEM HANDLING ───────────────────────────────────────────────────── */

test("an automated title follow-up is SYSTEM HANDLING, with the next moment and why", () => {
  const x = get("committed_waiting_on_title");
  assert.equal(x.state.key, "system_handling");
  assert.equal(x.group, "system_handling");
  assert.equal(x.ball.owner, "system");
  assert.equal(x.ball.waitingOn, "title");
  assert.equal(x.ball.automation.label, "Title commitment follow-up");
  assert.equal(x.ball.automation.sequence, 2);
  assert.equal(x.ball.automation.at, "2026-10-01T03:47:00.000Z", "10:47 PM Central tonight — 24h after follow-up #1");
  assert.equal(x.ball.automation.why, "Commitment not yet received");
  const loop = x.automation.loops.find((l) => l.key === "title_commitment");
  assert.equal(loop.state, "scheduled");
  assert.equal(loop.latest.status, "sent");
  // No follow-up has gone out yet → the title simply owes it (waiting, not system).
  const first = deriveClosingExecution({ ...scenario("title_order_awaiting_ack"), now: NOW });
  assert.equal(first.ball.owner, "title");
  assert.equal(first.group, "waiting_title");
});

test("SYSTEM HANDLING is never claimed while nothing can move: paused, switched off, or email sending off", () => {
  const s = scenario("committed_waiting_on_title");
  const emailOff = deriveClosingExecution({ ...s, runtime: { ...s.runtime, emailSendEnabled: false }, now: NOW });
  assert.equal(emailOff.ball.owner, "title");
  assert.equal(emailOff.automation.held, "email_sending_off");
  assert.match(emailOff.ball.why, /Email sending is off/);
  const off = deriveClosingExecution({ ...s, runtime: { ...s.runtime, automationEnabled: false }, now: NOW });
  assert.notEqual(off.ball.owner, "system");
  const paused = deriveClosingExecution({ ...s, closingCase: { ...s.closingCase, automation_paused_at: new Date(NOW - H).toISOString(), automation_paused_reason: "Handling title by phone" }, now: NOW });
  assert.notEqual(paused.ball.owner, "system");
  assert.ok(paused.items.some((i) => i.key === "automation_paused"));
});

test("a title reply supersedes a stale follow-up: shown as superseded, never re-sent, nothing claims it is scheduled", () => {
  const s = scenario("committed_waiting_on_title");
  const first = s.emailRequests.find((r) => r.category === "title_commitment");
  const second = { ...first, id: "req-3-title_commitment-2", request_key: first.request_key.replace(/:1$/, ":2"), sequence: 2, requested_at: "2026-10-01T03:47:00.000Z", due_at: "2026-10-01T03:47:00.000Z", claimed_at: "2026-10-01T03:48:00.000Z", sent_at: null, status: "cancelled", status_reason: "counterparty_replied", updated_at: "2026-10-01T04:30:00.000Z" };
  const later = Date.parse("2026-10-01T05:00:00Z");
  const x = deriveClosingExecution({ ...s, emailRequests: [...s.emailRequests, second], now: later });
  const loop = x.automation.loops.find((l) => l.key === "title_commitment");
  assert.equal(loop.state, "superseded");
  assert.equal(loop.occupiedBy.reason, "counterparty_replied");
  assert.equal(loop.escalateAt, "2026-10-01T15:47:00.000Z", "bounded catch-up: the planner escalates if nothing arrives");
  assert.equal(x.automation.emails.find((e) => e.sequence === 2 && e.category === "title_commitment").reason, "counterparty_replied");
  assert.notEqual(x.ball.owner, "system", "a superseded follow-up is not 'system handling'");
  const plan = planClosingAutomation({ closingCase: s.closingCase, offers: s.offers, agreements: s.agreements, emdReceipts: s.emdReceipts, requests: [...s.emailRequests, second], now: later });
  const again = plan.actions.find((a) => a.type === "email" && a.category === "title_commitment");
  assert.equal(again?.sequence, 2, "the planner can only name sequence 2 again, whose request key is taken — no second send");
});

/* ── BUYER ─────────────────────────────────────────────────────────────── */

test("buyer states stay distinct: selected ≠ committed ≠ agreement executed ≠ EMD", () => {
  const selected = get("buyer_selected_agreement_sent");
  assert.equal(selected.buyer.selected, true);
  assert.equal(selected.buyer.committed, false);
  assert.equal(selected.rail.find((r) => r.key === "buyer").status, "active");
  assert.equal(selected.rail.find((r) => r.key === "agreement").owner, "buyer");
  assert.equal(selected.buyer.name, "Acme Investments LLC");
  assert.equal(selected.group, "waiting_buyer");
  assert.equal(selected.ball.owner, "buyer");
  const committed = get("committed_waiting_on_title");
  assert.equal(committed.buyer.committed, true);
  assert.equal(committed.rail.find((r) => r.key === "agreement").status, "complete");
  assert.equal(committed.rail.find((r) => r.key === "emd").status, "complete");
});

test("buyer person names are withheld; company names shown", () => {
  const s = scenario("buyer_selected_agreement_sent");
  const x = deriveClosingExecution({ ...s, offers: [{ ...s.offers[0], metadata: { buyer_name: "John Smith" } }], now: NOW });
  assert.equal(x.buyer.name, null);
});

/* ── TIME ──────────────────────────────────────────────────────────────── */

test("closing time keeps the property's zone; a target date gets no countdown", () => {
  const tomorrow = get("closing_tomorrow_emd_overdue");
  assert.equal(tomorrow.closing.tz, "America/Chicago");
  assert.equal(tomorrow.closing.time, "14:00");
  assert.equal(tomorrow.closing.confirmed, true);
  assert.equal(tomorrow.closing.daysOut, 1);
  assert.equal(tomorrow.proximity.label, "Closing tomorrow");
  const target = get("committed_waiting_on_title");
  assert.equal(target.closing.confirmed, false);
  assert.equal(target.closing.daysOut, null, "no countdown drama for an unconfirmed date");
  assert.equal(target.proximity, null);
  assert.equal(target.rail.find((r) => r.key === "schedule").detail, "Target only — not confirmed");
  assert.deepEqual(describeWhen("2026-09-30T00:00:00+00:00", "America/Chicago"), { at: "2026-09-30T00:00:00.000Z", date: "2026-09-30", time: null, tz: null });
});

test("stages are the canonical S6–S10 codes; closing desk never invents one", () => {
  const codes = all().map(({ x }) => x.stage?.code).filter(Boolean);
  for (const c of codes) assert.ok(["S6", "S7", "S8", "S9", "S10"].includes(c), c);
});

test("S9 with no closing date is a MISSING blocker, owned by you", () => {
  const s = scenario("date_passed_not_closed");
  const x = deriveClosingExecution({ ...s, closingCase: { ...s.closingCase, scheduled_closing_date: null, closing_date_confirmed_at: null }, now: NOW });
  const b = x.items.find((y) => y.key === "no_date");
  assert.ok(b);
  assert.equal(b.owner, "you");
  assert.equal(b.group, "missing");
});

/* ── DOCUMENTS / TIMELINE / CANCELLED ─────────────────────────────────── */

test("documents: signed only from executed status; missing ones are named; no invented files", () => {
  const selected = get("buyer_selected_agreement_sent");
  assert.equal(selected.documents.find((d) => d.key === "purchase_agreement").status, "signed");
  assert.equal(selected.documents.find((d) => d.key.startsWith("agreement:")).status, "awaiting_signature");
  const out = get("contract_out_for_signature");
  assert.equal(out.documents.find((d) => d.key === "purchase_agreement").status, "awaiting_signature");
  const atRisk = get("closing_tomorrow_emd_overdue");
  assert.ok(atRisk.documents.some((d) => d.key === "statement:missing" && d.status === "missing"));
  assert.ok(atRisk.documents.some((d) => d.key === "emd:missing" && d.status === "missing"));
  assert.ok(atRisk.documents.some((d) => d.key === "title_commitment:missing"));
  for (const { x } of all()) for (const d of x.documents) if (d.status !== "missing") assert.ok(d.reference || d.source, `${x.id} ${d.key} has a real reference`);
});

test("cancelled: cancelled_at, reason, actor and last milestone; terminal, never active", () => {
  const x = get("cancelled");
  assert.equal(x.terminal, true);
  assert.equal(x.state.key, "cancelled");
  assert.equal(x.next, null);
  assert.equal(x.group, "cancelled");
  assert.equal(x.cancellation.at, new Date(NOW - 3 * 24 * H).toISOString());
  assert.match(x.cancellation.reason, /probate/);
  assert.equal(x.cancellation.actor, "Ryan K. (operator)");
  assert.equal(x.cancellation.lastMilestone.label, "Title issue opened · Probate");
  // The production shape: a voided case with no terminal_* columns reads its void from provenance.
  const voided = deriveClosingExecution({ closingCase: { closing_case_id: "closing:v", contract_status: "cancelled", universal_stage: "formal_contract", closing_status: "not_scheduled", provenance: { voided: true, monetary_correction: { truth: "4100 is a MONTHLY RENT.", applied_at: "2026-09-10T23:51:34.501127+00:00", authorized_by: "operator: underwriting integrity mission, phase 2" } }, created_at: "2026-09-10T11:59:19Z", updated_at: "2026-09-10T23:51:34Z" }, property: { property_address_full: "935 Nw 20th St # 1-2, Fort Lauderdale, Fl 33311", market: "Miami, FL" }, now: NOW });
  assert.equal(voided.state.key, "voided");
  assert.equal(voided.cancellation.at, "2026-09-10T23:51:34.501Z");
  assert.match(voided.cancellation.reason, /MONTHLY RENT/);
  assert.equal(voided.cancellation.actor, "operator: underwriting integrity mission, phase 2");
  assert.equal(voided.property.line, "935 Nw 20th St # 1-2", "address from the canonical property when the case lacks it");
  assert.equal(voided.property.addressSource, "property");
  assert.equal(voided.market, "Miami, FL");
});

/* ── PORTFOLIO ─────────────────────────────────────────────────────────── */

test("portfolio: next closing is the next FUTURE confirmed closing; attention grouped; nav groups by precedence", () => {
  const items = all().map(({ x }) => x);
  const { counts, nextClosing, attention, groups } = summarizePortfolio(items, { now: NOW });
  assert.equal(counts.active, 10);
  assert.equal(counts.needsYou, 4);
  assert.equal(counts.ready, 1);
  assert.equal(counts.closed, 2);
  assert.equal(counts.cancelled, 1);
  assert.equal(nextClosing.address, "1204 Penn Ave N", "today 2:00 PM — the passed Sep 29 closing is attention, not next");
  assert.ok(attention.blocking.some((a) => a.key === "date_passed"));
  assert.ok(attention.overdue.some((a) => a.key === "emd_overdue"));
  const risk = attention.due_soon.find((a) => a.key === "at_risk");
  assert.match(risk.what, /^Closing tomorrow — \d open$/);
  assert.deepEqual(risk.requirements, ["emd", "title"], "the room highlights exactly the unresolved requirements");
  assert.ok(attention.human_decision.some((a) => a.key === "emd_unverified"));
  assert.deepEqual(groups.map((g) => g.key), ["needs_you", "closing_today", "closing_soon", "waiting_seller", "waiting_buyer", "waiting_title", "system_handling", "closed", "cancelled"]);
  for (const x of items) assert.equal(groupOf(x), x.group);
});

test("portfolio row projection carries what the navigation needs, and ids stay canonical", () => {
  for (const { x } of all()) {
    const row = summarizeClosing(x);
    assert.equal(row.id, x.id);
    assert.match(row.id, /^closing:[0-9a-f-]{36}$/);
    assert.equal(row.group, x.group);
    assert.deepEqual(row.readiness, x.readiness);
    assert.ok(!("timeline" in row) && !("documents" in row), "the room loads those by id");
    assert.equal(x.automation.workflow.runId, x.id, "Workflow Studio run = the closing case");
    if (x.closing) assert.equal(x.closing.calendar.eventId, `${"closing:"}${x.id}:closing_date`);
    for (const d of x.deadlines) assert.equal(d.calendar.eventId, `closing:${x.id}:${d.key}`);
  }
});

test("parseAddress reads line/city/state/zip from the canonical address", () => {
  assert.deepEqual(parseAddress("3315 Aldrich Ave N, Minneapolis, Mn 55412"), { line: "3315 Aldrich Ave N", city: "Minneapolis", state: "MN", zip: "55412" });
});
