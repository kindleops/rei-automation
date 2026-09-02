import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildContextResolutionResult,
  detectDisagreement,
  evidenceFrom,
  RESOLUTION_STATUS,
  SOURCE_RANK,
  CONTEXT_RESOLUTION_VERSION,
} from "@/lib/domain/context/context-resolution-result.js";

// SELF-HEALING CONTEXT RESOLUTION (§6). The pure ranking + ambiguity core.
// Pins: deterministic ranking; provenance for every source; rejected candidates
// retained; fail-closed on genuine ambiguity (multi-owner tie, equal-authority
// disagreement); automatic REPAIR when one authoritative lineage dominates a
// weaker disagreeing source -- recorded, never silent. The old dirty-canary
// (two contexts, one silently chosen) is structurally impossible here.

const P1 = { property_id: "prop-1", master_owner_id: "owner-1", prospect_id: "pros-1" };
const P2 = { property_id: "prop-2", master_owner_id: "owner-2", prospect_id: "pros-2" };

test("explicit ids resolve with high confidence and full provenance", () => {
  const r = buildContextResolutionResult({ explicit_ids: P1 });
  assert.equal(r.status, RESOLUTION_STATUS.RESOLVED);
  assert.deepEqual(r.chosen, P1);
  assert.equal(r.confidence, "high");
  assert.equal(r.winner, "explicit_ids");
  assert.equal(r.evidence.length, 3, "every source is recorded, present or not");
  assert.equal(r.version, CONTEXT_RESOLUTION_VERSION);
  assert.ok(Object.isFrozen(r));
});

test("no source -> none, with the missing_context review reason", () => {
  const r = buildContextResolutionResult({});
  assert.equal(r.status, RESOLUTION_STATUS.NONE);
  assert.equal(r.chosen, null);
  assert.equal(r.review_reason, "missing_context");
});

// ── fail closed on genuine ambiguity ─────────────────────────────────────────

test("a multi-owner tie in the as-of deal context is AMBIGUOUS, never a guess", () => {
  const r = buildContextResolutionResult({
    deal_context: { ambiguous: true, distinct_owners: ["owner-1", "owner-2"] },
    outbound_pair: { ...P1, strategy: "sent", verified: true },
  });
  assert.equal(r.status, RESOLUTION_STATUS.AMBIGUOUS);
  assert.equal(r.chosen, null);
  assert.equal(r.reason, "multi_owner_tie_at_as_of_instant");
  assert.equal(r.review_reason, "conflicting_property", "routes to the owned conflicting-identity workflow");
});

test("explicit ids override a tie (the event itself names the context)", () => {
  const r = buildContextResolutionResult({
    explicit_ids: P1,
    deal_context: { ambiguous: true, distinct_owners: ["owner-1", "owner-2"] },
  });
  assert.equal(r.status, RESOLUTION_STATUS.RESOLVED);
  assert.deepEqual(r.chosen, P1);
});

test("two EQUAL-authority sources that disagree on the property are AMBIGUOUS (fail closed)", () => {
  // as-of deal context (rank 3) vs a LINKED outbound pair (rank 3)
  const r = buildContextResolutionResult({
    deal_context: P1,
    outbound_pair: { ...P2, strategy: "linked", context_linked: true, verified: true },
  });
  assert.equal(r.status, RESOLUTION_STATUS.AMBIGUOUS);
  assert.equal(r.reason, "equal_authority_sources_disagree");
  assert.deepEqual(r.disagreement.property_id, { a: "prop-1", b: "prop-2" });
  assert.ok(r.rejected.length >= 2, "both candidates are retained, neither is silently chosen");
  assert.equal(r.review_reason, "conflicting_property");
});

// ── repair when one lineage clearly dominates ────────────────────────────────

test("a dominant lineage REPAIRS a weaker disagreeing source, and records what it overrode", () => {
  // as-of deal context (rank 3) vs a merely-sent pair (rank 2) that names another property
  const r = buildContextResolutionResult({
    deal_context: P1,
    outbound_pair: { ...P2, strategy: "sent", verified: true },
  });
  assert.equal(r.status, RESOLUTION_STATUS.RESOLVED);
  assert.deepEqual(r.chosen, P1);
  assert.equal(r.reason, "dominant_lineage_repaired_weaker_source");
  assert.equal(r.repair.dominant, "deal_context_as_of");
  assert.equal(r.repair.overrode, "outbound_pair_sent");
  assert.deepEqual(r.repair.property_id, { a: "prop-1", b: "prop-2" });
  const rejected = r.rejected.find((x) => x.source === "outbound_pair_sent");
  assert.equal(rejected.disagreed, true, "the rejected candidate is retained and marked as disagreeing");
});

test("an unverified latest-pair fallback never overrides anything and carries low/unverified confidence", () => {
  const alone = buildContextResolutionResult({ outbound_pair: { ...P1, strategy: "fallback_latest_pair_match", verified: false } });
  assert.equal(alone.status, RESOLUTION_STATUS.RESOLVED);
  assert.equal(alone.confidence, "unverified");
  const withAuthority = buildContextResolutionResult({
    deal_context: P1,
    outbound_pair: { ...P2, strategy: "fallback_latest_pair_match", verified: false },
  });
  assert.deepEqual(withAuthority.chosen, P1);
  assert.equal(withAuthority.repair.overrode, "outbound_pair_latest");
});

// ── backfill without disagreement ────────────────────────────────────────────

test("missing keys on the winner are backfilled from agreeing weaker sources, never from disagreeing ones", () => {
  const r = buildContextResolutionResult({
    deal_context: { property_id: "prop-1", master_owner_id: "owner-1" }, // no prospect
    outbound_pair: { property_id: "prop-1", master_owner_id: "owner-1", prospect_id: "pros-1", strategy: "sent", verified: true },
  });
  assert.equal(r.chosen.prospect_id, "pros-1", "agreeing source backfills the prospect");
  const conflicting = buildContextResolutionResult({
    deal_context: { property_id: "prop-1", master_owner_id: "owner-1" },
    outbound_pair: { property_id: "prop-2", master_owner_id: "owner-1", prospect_id: "pros-9", strategy: "sent", verified: true },
  });
  assert.equal(conflicting.chosen.prospect_id, null, "a disagreeing source never backfills");
});

// ── helpers ──────────────────────────────────────────────────────────────────

test("detectDisagreement only fires when both sides name a DIFFERENT value", () => {
  assert.equal(detectDisagreement({ property_id: "a" }, { property_id: null }), null);
  assert.equal(detectDisagreement({ property_id: "a" }, { property_id: "a" }), null);
  assert.deepEqual(detectDisagreement({ property_id: "a" }, { property_id: "b" }), { property_id: { a: "a", b: "b" } });
  assert.equal(detectDisagreement(null, undefined), null);
});

test("ranking is declared, deterministic, and explicit ids sit on top", () => {
  assert.ok(SOURCE_RANK.explicit_ids > SOURCE_RANK.deal_context_as_of);
  assert.equal(SOURCE_RANK.deal_context_as_of, SOURCE_RANK.outbound_pair_linked);
  assert.ok(SOURCE_RANK.outbound_pair_sent > SOURCE_RANK.outbound_pair_latest);
  const e = evidenceFrom("outbound_pair_sent", { ...P1, verified: false });
  assert.equal(e.rank, 0, "an unverified source is ranked below every verified one");
});
