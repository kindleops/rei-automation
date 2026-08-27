import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadProductionCoverageGraph,
  auditCoverageGraph,
} from "@/lib/domain/coverage-net/coverage-graph-audit.js";

// Phase 14: the automation coverage-audit guard. This encodes the manual Phase
// 11 graph audit as an executable assertion over the REAL production registries.
// The first test is the guard itself (production graph must have zero gaps). The
// rest are ADVERSARIAL: each removes/breaks exactly one node in a cloned graph
// and proves the guard fails with the right code — so the guard cannot silently
// stop catching a regression.

const clone = (g) => structuredClone(g);
const codes = (r) => r.gaps.map((x) => x.code);

// ── The guard: production graph is complete ─────────────────────────────────

test("PRODUCTION coverage graph has zero gaps", () => {
  const r = auditCoverageGraph(loadProductionCoverageGraph());
  assert.equal(
    r.ok,
    true,
    `coverage gaps found: ${JSON.stringify(r.gaps, null, 2)}`
  );
  assert.equal(r.gaps.length, 0);
  // Sanity: the graph actually loaded real registries, not an empty shell.
  assert.ok(r.report.intent_count >= 20, "all producible intents present");
  assert.ok(r.report.route_count >= 10, "route profiles present");
});

test("db-backed template use cases are REPORTED, not failed (honest CI boundary)", () => {
  const r = auditCoverageGraph(loadProductionCoverageGraph());
  // The broad catalog is DB-only; those use cases surface as a report, never a
  // gap (CI cannot prove DB-row absence, and a missing template degrades to
  // human review, not silence — see Phase 11).
  assert.ok(Array.isArray(r.report.db_backed_template_use_cases));
  assert.equal(r.ok, true, "db-backed use cases must not fail the guard");
});

// ── Adversarial: removing each node type makes the guard fail ────────────────

test("ADVERSARIAL: removing a route makes an intent uncovered (intent_no_route)", () => {
  const g = clone(loadProductionCoverageGraph());
  // who_is_this: terminal_hint reply_sent, not escalate/clarifier/review/terminal
  // -> its ONLY destination is its route. Remove it and coverage breaks.
  delete g.routeProfiles.who_is_this;
  const r = auditCoverageGraph(g);
  assert.equal(r.ok, false);
  assert.ok(
    r.gaps.some((x) => x.code === "intent_no_route" && x.node === "who_is_this"),
    `expected intent_no_route for who_is_this, got ${JSON.stringify(codes(r))}`
  );
});

test("ADVERSARIAL: emptying a route's template candidates (immediate_send_no_template)", () => {
  const g = clone(loadProductionCoverageGraph());
  g.routeProfiles.seller_interested.template_use_case_candidates = [];
  const r = auditCoverageGraph(g);
  assert.equal(r.ok, false);
  assert.ok(
    r.gaps.some((x) => x.code === "immediate_send_no_template" && x.node === "seller_interested")
  );
});

test("ADVERSARIAL: a route with a no-op action (route_no_action)", () => {
  const g = clone(loadProductionCoverageGraph());
  g.routeProfiles.seller_interested.next_action = "none";
  const r = auditCoverageGraph(g);
  assert.equal(r.ok, false);
  assert.ok(
    r.gaps.some((x) => x.code === "route_no_action" && x.node === "seller_interested")
  );
});

test("ADVERSARIAL: do_not_reply is NOT treated as a no-op (guard stays precise)", () => {
  // A deliberate soft-close action must not be flagged — proves the guard does
  // not over-fire and mask real gaps behind noise.
  const g = clone(loadProductionCoverageGraph());
  g.routeProfiles.seller_interested.next_action = "do_not_reply";
  const r = auditCoverageGraph(g);
  assert.ok(
    !r.gaps.some((x) => x.code === "route_no_action" && x.node === "seller_interested"),
    "do_not_reply must not be a route_no_action gap"
  );
});

test("ADVERSARIAL: removing a stage's follow-up policy (stage_no_followup_policy)", () => {
  const g = clone(loadProductionCoverageGraph());
  delete g.followupPolicyByStage.offer_interest;
  const r = auditCoverageGraph(g);
  assert.equal(r.ok, false);
  assert.ok(
    r.gaps.some((x) => x.code === "stage_no_followup_policy" && x.node === "offer_interest")
  );
});

test("ADVERSARIAL: emptying a nurture intent's candidates (followup_no_template)", () => {
  const g = clone(loadProductionCoverageGraph());
  g.nurtureCandidates.not_interested = [];
  const r = auditCoverageGraph(g);
  assert.equal(r.ok, false);
  assert.ok(
    r.gaps.some((x) => x.code === "followup_no_template" && x.node === "not_interested")
  );
});

test("ADVERSARIAL: removing a required code-level fallback template (local_fallback_missing)", () => {
  const g = clone(loadProductionCoverageGraph());
  const removed = g.requiredLocalFallbackUseCases[0];
  g.localTemplateUseCases = g.localTemplateUseCases.filter((u) => u !== removed);
  const r = auditCoverageGraph(g);
  assert.equal(r.ok, false);
  assert.ok(
    r.gaps.some((x) => x.code === "local_fallback_missing" && x.node === removed)
  );
});

test("ADVERSARIAL: removing a terminal disposition (terminal_hint_not_durable)", () => {
  const g = clone(loadProductionCoverageGraph());
  // opt_out's terminal_hint is suppressed_opt_out — remove that durable
  // disposition and the intentional STOP outcome names a record that is gone.
  g.terminalDispositions = g.terminalDispositions.filter((d) => d !== "suppressed_opt_out");
  const r = auditCoverageGraph(g);
  assert.equal(r.ok, false);
  assert.ok(
    r.gaps.some((x) => x.code === "terminal_hint_not_durable" && x.node === "opt_out")
  );
});

test("ADVERSARIAL: an unbounded send failure (retryable_no_bounded_recovery)", () => {
  const g = clone(loadProductionCoverageGraph());
  // Break a retryable class so it neither re-queues nor terminates.
  const retry = g.failureRecovery.find((f) => f.retryable);
  retry.queue_disposition = null;
  const r = auditCoverageGraph(g);
  assert.equal(r.ok, false);
  assert.ok(r.gaps.some((x) => x.code === "retryable_no_bounded_recovery"));
});

test("ADVERSARIAL: a no-op decision that derives no status (silent_success_possible)", () => {
  const g = clone(loadProductionCoverageGraph());
  g.noopOperationalStatus = "";
  const r = auditCoverageGraph(g);
  assert.equal(r.ok, false);
  assert.ok(r.gaps.some((x) => x.code === "silent_success_possible"));
});

test("ADVERSARIAL: a producible intent with no ontology entry (intent_no_ontology)", () => {
  const g = clone(loadProductionCoverageGraph());
  g.intents = [...g.intents, "made_up_intent_xyz"];
  const r = auditCoverageGraph(g);
  assert.equal(r.ok, false);
  assert.ok(
    r.gaps.some((x) => x.code === "intent_no_ontology" && x.node === "made_up_intent_xyz")
  );
});

// ── Preservation: intentional terminal outcomes are NOT gaps ─────────────────

test("PRESERVED: STOP / wrong number / sold / hostile / human-review are covered, not gaps", () => {
  const r = auditCoverageGraph(loadProductionCoverageGraph());
  const gapNodes = new Set(r.gaps.map((x) => x.node));
  for (const terminalIntent of [
    "opt_out", // STOP / DNC
    "wrong_number",
    "sold_property",
    "hostile_or_legal",
    "trust_ownership", // execution-authority -> human review
    "unclear", // clarifier / review
  ]) {
    assert.ok(
      !gapNodes.has(terminalIntent),
      `${terminalIntent} is an intentional terminal/handled outcome and must not be a gap`
    );
  }
});
