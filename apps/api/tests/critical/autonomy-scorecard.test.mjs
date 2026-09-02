import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAutonomyScorecard,
  classifyTransition,
  renderScorecardTable,
  CONVERSATION_STAGES,
  OPERATIONAL_STAGES,
  AUTONOMY_SCORECARD_VERSION,
} from "@/lib/domain/seller-flow/autonomy-scorecard.js";
import { CANONICAL_INTENTS } from "@/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js";
import { listReviewHoldIntents, NEXT_ACTIONS } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";

// THE autonomy certification report (§20) and the §10 proof.
// Every figure is DERIVED from the resolver over the reachable grid. These
// tests pin: zero dead ends (the §10 proof), honest derivation (counts add up,
// percentages are computed not asserted), the held tiers are exactly the
// exception-only intents, and operational stages carry no invented number.

const card = buildAutonomyScorecard();

test("§10 PROOF: every non-terminal state has a next expected event or scheduled action (zero dead ends)", () => {
  assert.equal(card.overall.dead_end_count, 0, `dead ends: ${JSON.stringify(card.dead_ends, null, 2)}`);
  assert.equal(card.overall.every_nonterminal_state_has_next_action, true);
  for (const s of card.stages.filter((x) => x.kind === "conversation")) {
    assert.equal(s.dead_ends.count, 0, `${s.stage} has dead ends: ${s.dead_ends.intents.join(",")}`);
    assert.equal(s.next_action_coverage.pct, 100, `${s.stage} next_action coverage`);
  }
});

test("the grid is the FULL reachable grid: every conversation stage x every canonical intent", () => {
  assert.equal(card.grid.stages, CONVERSATION_STAGES.length);
  assert.equal(card.grid.intents, CANONICAL_INTENTS.length);
  assert.equal(card.grid.cells, CONVERSATION_STAGES.length * CANONICAL_INTENTS.length);
  assert.ok(card.grid.cells >= 200, "grid should be comprehensive");
  assert.equal(card.ingress_coverage.pct, 100, "every canonical intent normalizes to itself");
});

test("figures are DERIVED, not asserted: the four buckets partition the grid and percentages are computed", () => {
  let auto = 0, fb = 0, hum = 0, total = 0;
  for (const s of card.stages.filter((x) => x.kind === "conversation")) {
    const t = s.intent_coverage.total;
    assert.equal(
      s.autonomous.count + s.exception_autonomous_fallback.count + s.human_required.count + s.dead_ends.count,
      t,
      `${s.stage} buckets must partition the grid`
    );
    assert.equal(s.autonomous.pct, Math.round((s.autonomous.count / t) * 1000) / 10);
    assert.equal(s.converges_without_human.count, s.autonomous.count + s.exception_autonomous_fallback.count);
    assert.ok(s.autonomous.pct >= 0 && s.autonomous.pct <= 100);
    auto += s.autonomous.count; fb += s.exception_autonomous_fallback.count; hum += s.human_required.count; total += t;
  }
  assert.equal(card.overall.autonomous_pct, Math.round((auto / total) * 1000) / 10);
  assert.equal(card.overall.exception_autonomous_fallback_pct, Math.round((fb / total) * 1000) / 10);
  assert.equal(card.overall.human_required_pct, Math.round((hum / total) * 1000) / 10);
  assert.equal(card.overall.converges_without_human_pct, Math.round(((auto + fb) / total) * 1000) / 10);
});

test("every human-required or fallback exception is bound to an OWNED workflow, and every held intent is an exception", () => {
  const held = new Set(listReviewHoldIntents().map((h) => h.intent));
  for (const s of card.stages.filter((x) => x.kind === "conversation")) {
    for (const h of [...s.human_required_intents, ...s.exception_fallback_intents]) {
      assert.ok(h.workflow, `${s.stage}/${h.intent} must name an owned workflow`);
      assert.ok(h.fallback_action, `${s.stage}/${h.intent} must carry the workflow's fallback action`);
    }
    for (const intent of held) {
      const row = [...s.human_required_intents, ...s.exception_fallback_intents].find((h) => h.intent === intent);
      assert.ok(row, `${s.stage}: held intent ${intent} must be an exception (human or fallback)`);
      assert.equal(row.held_by_registry, true);
    }
    assert.ok(s.human_required.owned_workflows.every(Boolean));
    assert.ok(s.exception_autonomous_fallback.owned_workflows.every(Boolean));
  }
});

test("HUMAN-REQUIRED is exactly the compliance tier: legal/authority disclosures + safety holds, nothing else", () => {
  // The truthful answer to "where are humans still required". A human must act
  // ONLY where policy requires it (§1): outreach-blocking legal / safety holds.
  const LEGAL = new Set(["title_issue", "lien_tax_issue", "bankruptcy_disclosed", "trust_ownership", "llc_corporation"]);
  const SAFETY = new Set(["hostile_or_legal"]);
  for (const s of card.stages.filter((x) => x.kind === "conversation")) {
    const names = s.human_required_intents.map((h) => h.intent).sort();
    for (const n of names) assert.ok(LEGAL.has(n) || SAFETY.has(n), `${s.stage}: ${n} requires a human but is not a compliance-tier intent`);
    for (const h of s.human_required_intents) {
      assert.equal(h.fallback_action, "hold_no_automated_reply", `${h.intent} human-required only when outreach is held`);
      assert.ok(["legal_compliance_hold", "safety_hold"].includes(h.workflow), h.intent);
    }
    // and every compliance-tier intent IS human-required at every stage
    for (const n of [...LEGAL, ...SAFETY]) assert.ok(names.includes(n), `${s.stage}: ${n} must be human-required`);
  }
});

test("the system converges without a human on the large majority of the grid, and the number is real", () => {
  // Not a fixed target -- an honesty check: the share that converges without a
  // human (fully autonomous + exception-first-with-automated-fallback) must be
  // a computed figure well above the compliance-only human share.
  const o = card.overall;
  assert.ok(o.converges_without_human_pct > o.human_required_pct, `converges ${o.converges_without_human_pct}% must exceed human-required ${o.human_required_pct}%`);
  assert.ok(o.converges_without_human_pct >= 75, `converges-without-human share is ${o.converges_without_human_pct}%`);
  assert.ok(o.human_required_pct <= 25, `human-required share is ${o.human_required_pct}% (compliance tier only)`);
  // The exact partition is enforced on COUNTS (above). Percentages are each
  // rounded to one decimal independently, so their sum may differ from 100 by
  // rounding (45.9 + 37.8 + 16.2 = 99.9); only a dead end could move it further.
  const pctSum = o.autonomous_pct + o.exception_autonomous_fallback_pct + o.human_required_pct;
  assert.ok(Math.abs(pctSum - 100) <= 0.3, `buckets sum to ~100 within rounding (got ${pctSum}); zero dead ends`);
});

test("operational stages carry their source of truth and NO invented percentage", () => {
  for (const stage of OPERATIONAL_STAGES) {
    const s = card.stages.find((x) => x.stage === stage);
    assert.ok(s, stage);
    assert.equal(s.kind, "operational");
    assert.equal(s.autonomous.pct, null, `${stage} must not fake a percentage`);
    assert.match(s.derived_from, /milestone/);
    assert.equal(s.dead_ends.count, 0);
  }
});

test("economic authority + retry coverage are read from the policy manifest", () => {
  assert.equal(card.economic_authority.margin_bound_enforced, true);
  assert.ok(card.economic_authority.invariants);
  assert.ok(card.retry_coverage.outbound_retry_contract);
  assert.match(card.policy_fingerprint, /^[0-9a-f]{32}$/);
  assert.equal(card.version, AUTONOMY_SCORECARD_VERSION);
  assert.ok(Object.isFrozen(card));
});

test("classifyTransition is total and honest", () => {
  assert.equal(classifyTransition({ next_action: NEXT_ACTIONS.SCHEDULE_FOLLOW_UP }, "need_time").outcome, "autonomous");
  assert.equal(classifyTransition({ next_action: NEXT_ACTIONS.HUMAN_REVIEW, review_reason: "legal_authority_disclosure" }, "title_issue").outcome, "human_required");
  assert.equal(classifyTransition({ next_action: NEXT_ACTIONS.HUMAN_REVIEW, review_reason: "respondent_identity_review" }, "tenant_respondent").outcome, "exception_autonomous_fallback");
  assert.equal(classifyTransition({ next_action: NEXT_ACTIONS.HUMAN_REVIEW, review_reason: "ambiguous_intent" }, "unclear").outcome, "exception_autonomous_fallback");
  assert.equal(classifyTransition({ next_action: null, follow_up: { create: false } }, "unclear").outcome, "dead_end");
  assert.equal(classifyTransition(null, "unclear").outcome, "dead_end");
  assert.equal(classifyTransition({ next_action: null, follow_up: { create: true, days: 3 } }, "need_time").outcome, "autonomous");
});

test("the operator table renders one row per stage", () => {
  const table = renderScorecardTable(card);
  const lines = table.split("\n");
  assert.equal(lines.length, 1 + CONVERSATION_STAGES.length + OPERATIONAL_STAGES.length);
  assert.match(lines[0], /autonomous/);
  assert.match(lines[0], /human-required/);
  for (const s of CONVERSATION_STAGES) assert.ok(table.includes(s), s);
});
