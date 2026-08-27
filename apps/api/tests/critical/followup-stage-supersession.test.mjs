import test from "node:test";
import assert from "node:assert/strict";

import {
  resolvePendingFollowupSupersession,
  supersedePriorStageFollowups,
} from "@/lib/domain/seller-flow/delivery-triggered-followup.js";

// Phase 6 residual — Gap 1 (stage-aware supersession). When the seller advances
// a stage, a follow-up queued for the PRIOR stage must not (a) block the new
// stage's follow-up as a "duplicate", nor (b) outlive the advance and fire a
// stale prior-stage message. The delivery-triggered scheduler resolves this by
// superseding (cancelling) any pending follow-up whose use case differs from the
// just-delivered outbound's, while a SAME-use-case pending follow-up still
// blocks (no duplicate same-stage follow-up). Unclassifiable rows fail safe by
// still blocking.

const row = (id, use_case, metadata = {}) => ({
  id,
  use_case_template: use_case,
  metadata,
});

// ── Pure decision ──────────────────────────────────────────────────────────

test("stage advance supersedes the prior-stage follow-up and unblocks scheduling", () => {
  const pending = [row("f1", "ownership_check")];
  const r = resolvePendingFollowupSupersession({
    pending_rows: pending,
    outbound_use_case: "asking_price_follow_up", // advanced to a new stage
  });
  assert.deepEqual(
    r.stale_prior_stage.map((x) => x.id),
    ["f1"],
    "the prior-stage follow-up is flagged stale"
  );
  assert.equal(r.pending, false, "no non-stale pending remains -> scheduling proceeds");
  assert.equal(r.target_use_case, "asking_price_follow_up");
});

test("same-stage pending follow-up still blocks (no duplicate) and is NOT superseded", () => {
  const pending = [row("f1", "ownership_check")];
  const r = resolvePendingFollowupSupersession({
    pending_rows: pending,
    outbound_use_case: "ownership_check", // same stage redelivered
  });
  assert.equal(r.stale_prior_stage.length, 0, "same-stage row is never superseded");
  assert.equal(r.pending, true, "same-stage pending blocks a duplicate");
});

test("mixed pending: prior-stage superseded, same-stage still blocks", () => {
  const pending = [row("old", "ownership_check"), row("cur", "asking_price_follow_up")];
  const r = resolvePendingFollowupSupersession({
    pending_rows: pending,
    outbound_use_case: "asking_price_follow_up",
  });
  assert.deepEqual(r.stale_prior_stage.map((x) => x.id), ["old"]);
  assert.equal(r.pending, true, "the surviving same-stage row still blocks scheduling");
});

test("unclassifiable pending row (no use case) fails safe: still blocks, never superseded", () => {
  const pending = [row("f1", null, {})];
  const r = resolvePendingFollowupSupersession({
    pending_rows: pending,
    outbound_use_case: "asking_price_follow_up",
  });
  assert.equal(r.stale_prior_stage.length, 0, "a row we cannot classify is not superseded");
  assert.equal(r.pending, true, "and it still blocks (fail safe)");
});

test("unknown current stage (no outbound use case) supersedes nothing; any pending blocks", () => {
  const pending = [row("f1", "ownership_check")];
  const r = resolvePendingFollowupSupersession({
    pending_rows: pending,
    outbound_use_case: null,
  });
  assert.equal(r.stale_prior_stage.length, 0, "cannot compare -> supersede nothing");
  assert.equal(r.pending, true, "conservative gate: any pending blocks");
  assert.equal(r.target_use_case, null);
});

test("no pending follow-ups -> nothing superseded, nothing blocks", () => {
  const r = resolvePendingFollowupSupersession({
    pending_rows: [],
    outbound_use_case: "ownership_check",
  });
  assert.equal(r.stale_prior_stage.length, 0);
  assert.equal(r.pending, false);
});

test("follow-up use case read from metadata.followup_use_case when column is absent", () => {
  const pending = [row("f1", null, { followup_use_case: "ownership_check" })];
  const r = resolvePendingFollowupSupersession({
    pending_rows: pending,
    outbound_use_case: "asking_price_follow_up",
  });
  assert.deepEqual(r.stale_prior_stage.map((x) => x.id), ["f1"], "metadata use case is honored");
  assert.equal(r.pending, false);
});

// ── Cancel effect ──────────────────────────────────────────────────────────

function captureUpdate() {
  const calls = [];
  const chain = {
    _c: {},
    update(patch) {
      this._c.patch = patch;
      return this;
    },
    eq(col, val) {
      (this._c.eq ||= []).push([col, val]);
      return this;
    },
    in(col, vals) {
      (this._c.in ||= []).push([col, vals]);
      return this;
    },
    then(resolve) {
      calls.push(this._c);
      this._c = {};
      return Promise.resolve({ error: null }).then(resolve);
    },
  };
  return { calls, supabase: { from: () => chain } };
}

test("supersede cancels ONLY the given ids, scoped to scheduled/queued follow-up rows", async () => {
  const { calls, supabase } = captureUpdate();
  await supersedePriorStageFollowups(supabase, {
    rows: [row("old", "ownership_check")],
    thread_key: "t1",
    superseded_by_use_case: "asking_price_follow_up",
  });
  assert.equal(calls.length, 1, "one cancel issued for the one stale row");
  const c = calls[0];
  assert.equal(c.patch.queue_status, "cancelled");
  assert.equal(c.patch.metadata.superseded_by_stage_advance, true);
  assert.equal(c.patch.metadata.superseded_by_use_case, "asking_price_follow_up");
  assert.equal(c.patch.metadata.superseded_from_use_case, "ownership_check");
  assert.deepEqual(c.eq, [["id", "old"]], "scoped to the specific row id");
  assert.deepEqual(
    c.in,
    [["queue_status", ["scheduled", "queued"]], ["type", ["followup"]]],
    "only cancels a still-pending follow-up row (never a sent/other-type row)"
  );
});

test("supersede is best-effort: a row without an id is skipped, no throw", async () => {
  const { calls, supabase } = captureUpdate();
  await supersedePriorStageFollowups(supabase, {
    rows: [{ use_case_template: "ownership_check" }],
    thread_key: "t1",
  });
  assert.equal(calls.length, 0, "no id -> no update, and no exception");
});
