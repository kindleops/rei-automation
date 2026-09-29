import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { deriveClosingExecution, summarizePortfolio, describeWhen, parseAddress } from "@/lib/domain/closings/closing-execution-model.js";
import { closingScenarios } from "../fixtures/closing-execution-scenarios.mjs";

const NOW = Date.parse("2026-09-29T15:00:00Z");
const all = () => closingScenarios(NOW).map((s) => ({ scenario: s.scenario, x: deriveClosingExecution({ ...s, now: NOW }) }));
const get = (name) => all().find((s) => s.scenario === name).x;

test("EMD is read ONLY from emd_receipts — an offer's emd_status/emd_received_at never marks it received", () => {
  const x = get("closing_tomorrow_emd_overdue");
  assert.equal(x.emd.buyer.state, "overdue", "offer says emd_status=received with a timestamp, but no receipt exists");
  assert.equal(x.emd.buyer.receipt, null);
  assert.equal(x.state.key, "emd_overdue");
  assert.equal(x.blockers[0].key, "emd_overdue");
  assert.equal(x.blockers[0].owner, "buyer");
  assert.ok(x.blockers[0].why, "every blocker says why it matters");
});

test("received-but-unverified EMD is not verified, and keeps the deal from Ready", () => {
  const x = get("prepared_no_date");
  assert.equal(x.emd.buyer.state, "received");
  assert.equal(x.requirements.find((r) => r.key === "emd").met, false);
  assert.equal(x.ready, false);
});

test("READY only when every required milestone is explicitly met", () => {
  const ready = get("ready_to_close_tomorrow");
  assert.equal(ready.ready, true);
  assert.equal(ready.state.key, "ready_to_close");
  assert.ok(ready.requirements.every((r) => r.met === true));
  // Remove only clear-to-close (never written by any backend today): no longer ready,
  // even though nothing is "wrong".
  const s = closingScenarios(NOW).find((x) => x.scenario === "ready_to_close_tomorrow");
  const notClear = deriveClosingExecution({ ...s, closingCase: { ...s.closingCase, readiness: {} }, now: NOW });
  assert.equal(notClear.ready, false);
  assert.equal(notClear.requirements.find((r) => r.key === "title").met, false);
});

test("CLOSED never derives from time passing — a past date raises a blocker instead", () => {
  const x = get("date_passed_not_closed");
  assert.equal(x.closed, false);
  assert.ok(x.blockers.some((b) => b.key === "date_passed"));
  assert.equal(x.state.key, "closing_at_risk");
});

test("ACTUAL money comes only from settled settlement_records; pending settlement gives no actuals", () => {
  const closed = get("closed_settled");
  assert.equal(closed.closed, true);
  assert.equal(closed.state.key, "closed");
  assert.equal(closed.money.actual.assignmentFee, 17480);
  assert.equal(closed.money.actual.netProceeds, 17480);
  assert.deepEqual(closed.money.expectedFeeVsActual, { expected: 18000, actual: 17480 });
  assert.equal(closed.money.estimated.assignmentFee.value, 18000, "estimate is kept, never overwritten by actuals");
  const pending = get("ready_to_close_tomorrow");
  assert.equal(pending.money.actual, null, "a pending settlement is not an actual");
});

test("a closed case with no settled record says so rather than inventing actuals", () => {
  const s = closingScenarios(NOW).find((x) => x.scenario === "closed_settled");
  const x = deriveClosingExecution({ ...s, settlements: [], now: NOW });
  assert.equal(x.closed, true);
  assert.equal(x.money.actual, null);
  assert.match(x.state.label, /settlement not recorded/);
});

test("buyer states stay distinct: selected ≠ committed ≠ agreement executed ≠ EMD", () => {
  const selected = get("buyer_selected_agreement_sent");
  assert.equal(selected.buyer.selected, true);
  assert.equal(selected.buyer.committed, false);
  assert.equal(selected.rail.find((r) => r.key === "buyer").status, "active");
  assert.equal(selected.rail.find((r) => r.key === "agreement").owner, "buyer");
  assert.equal(selected.buyer.name, "Acme Investments LLC");
  const committed = get("committed_waiting_on_title");
  assert.equal(committed.buyer.committed, true);
  assert.equal(committed.rail.find((r) => r.key === "agreement").status, "complete");
  assert.equal(committed.rail.find((r) => r.key === "emd").status, "complete");
  assert.equal(committed.state.key, "waiting_on_title");
});

test("buyer person names are withheld; company names shown", () => {
  const s = closingScenarios(NOW).find((x) => x.scenario === "buyer_selected_agreement_sent");
  const x = deriveClosingExecution({ ...s, offers: [{ ...s.offers[0], metadata: { buyer_name: "John Smith" } }], now: NOW });
  assert.equal(x.buyer.name, null);
});

test("closing time keeps the property's zone; a target date gets no countdown", () => {
  const ready = get("ready_to_close_tomorrow");
  assert.equal(ready.closing.tz, "America/Chicago");
  assert.equal(ready.closing.time, "14:00");
  assert.equal(ready.closing.confirmed, true);
  assert.equal(ready.closing.daysOut, 1);
  const target = get("committed_waiting_on_title");
  assert.equal(target.closing.confirmed, false);
  assert.equal(target.closing.daysOut, null, "no countdown drama for an unconfirmed date");
  assert.equal(target.rail.find((r) => r.key === "schedule").detail, "Target only — not confirmed");
  assert.deepEqual(describeWhen("2026-09-30T00:00:00+00:00", "America/Chicago"), { at: "2026-09-30T00:00:00.000Z", date: "2026-09-30", time: null, tz: null });
});

test("stages are the canonical S6–S10 codes; closing desk never invents one", () => {
  const codes = all().map(({ x }) => x.stage?.code).filter(Boolean);
  for (const c of codes) assert.ok(["S6", "S7", "S8", "S9", "S10"].includes(c), c);
});

test("S9 with no closing date is a blocker, owned by you", () => {
  const x = get("prepared_no_date");
  const b = x.blockers.find((y) => y.key === "no_date");
  assert.ok(b);
  assert.equal(b.owner, "you");
});

test("documents: signed only from executed status; missing ones are named; no invented files", () => {
  const selected = get("buyer_selected_agreement_sent");
  assert.equal(selected.documents.find((d) => d.key === "purchase_agreement").status, "signed");
  assert.equal(selected.documents.find((d) => d.key.startsWith("agreement:")).status, "awaiting_signature");
  const out = get("contract_out_for_signature");
  assert.equal(out.documents.find((d) => d.key === "purchase_agreement").status, "awaiting_signature");
  const atRisk = get("closing_tomorrow_emd_overdue");
  assert.ok(atRisk.documents.some((d) => d.key === "statement:missing" && d.status === "missing"));
});

test("cancelled cases are terminal, never active; portfolio counts stay simple", () => {
  const items = all().map(({ x }) => x);
  const cancelled = items.find((x) => x.terminal);
  assert.equal(cancelled.state.key, "cancelled");
  assert.equal(cancelled.next, null);
  const { counts, nextClosing } = summarizePortfolio(items, { now: NOW });
  assert.equal(counts.cancelled, 1);
  assert.equal(counts.closed, 1);
  assert.equal(counts.ready, 1);
  assert.equal(counts.active, 7);
  assert.ok(nextClosing, "the soonest upcoming closing is named");
});

test("parseAddress reads line/city/state/zip from the canonical address", () => {
  assert.deepEqual(parseAddress("3315 Aldrich Ave N, Minneapolis, Mn 55412"), { line: "3315 Aldrich Ave N", city: "Minneapolis", state: "MN", zip: "55412" });
});
