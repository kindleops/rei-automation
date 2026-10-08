/**
 * ARCHIVE NEVER STOPS NURTURE (owner, 2026-10-04 / 2026-10-08).
 *
 * Archive is a shared VISIBILITY flag. It never changes stage, status,
 * automation, nurture, suppression or read state, so an archived nurture
 * prospect (is_archived=true / archived_at / archive_scope) must still get its
 * scheduled nurture / follow-up. Each path that used to read the flag:
 *   - no-response-followup evaluateNoResponseCandidate (was "thread_archived")
 *   - delivery-triggered-followup resolveDeliveryFollowUpDecision ('archived' terminal)
 *   - recover-seller-execution-gaps stale-active sweep (.eq('is_archived', false))
 *   - autonomy-invariants (archived thread treated as terminal)
 * Genuine suppression stays a block (control cases below).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateNoResponseCandidate } from "../../src/lib/domain/seller-flow/no-response-followup.js";
import { resolveDeliveryFollowUpDecision } from "../../src/lib/domain/seller-flow/delivery-triggered-followup.js";
import { evaluateAutonomyInvariants, INVARIANT_CODES } from "../../src/lib/domain/seller-flow/autonomy-invariants.js";
import fs from "node:fs";

const NOW = new Date("2026-10-06T20:00:00.000Z");
const ARCHIVED = { is_archived: true, archived_at: "2026-10-05T12:00:00.000Z", archive_scope: "conversation", archive_reason: "operator_cleanup" };
const S2_BODY = "Would you consider an offer on 123 Main St?";

function facts(threadState = {}) {
  return {
    anchor: { id: "q_anchor", type: "auto_reply", use_case: "consider_selling", message_body: S2_BODY, seller_first_name: "Charles", language: null },
    anchor_sent_at: "2026-10-05T18:00:00.000Z",
    anchor_message_event_id: "me_anchor",
    thread_key: "+15550100777",
    has_inbound_before_anchor: true,
    has_inbound_after_anchor: false,
    has_newer_outbound: false,
    thread_state: { contactability_status: "contactable", ...threadState },
    on_suppression_list: false,
    inbound_rows_newest_first: [{ message_body: "Yes I own it" }],
  };
}

test("no-response follow-up: an archived conversation is still eligible", () => {
  const base = evaluateNoResponseCandidate(facts(), { now: NOW });
  assert.equal(base.eligible, true, base.reason);
  for (const over of [ARCHIVED, { is_archived: true }, { archived_at: ARCHIVED.archived_at }, { archive_scope: "lead" }, { lifecycle_stage: "archived" }]) {
    const ev = evaluateNoResponseCandidate(facts(over), { now: NOW });
    assert.equal(ev.eligible, true, `${JSON.stringify(over)} → ${ev.reason}`);
    assert.equal(ev.plan.use_case, base.plan.use_case);
    assert.equal(ev.plan.scheduled_for, base.plan.scheduled_for);
  }
});

test("no-response follow-up: suppression is still a block (control)", () => {
  assert.equal(evaluateNoResponseCandidate(facts({ ...ARCHIVED, is_suppressed: true }), { now: NOW }).reason, "thread_suppressed");
});

test("no-response thread facts no longer read the archive flag", () => {
  const src = fs.readFileSync(new URL("../../src/lib/domain/seller-flow/no-response-followup.js", import.meta.url), "utf8");
  assert.equal(/is_archived/.test(src.replace(/\/\/.*$/gm, "")), false);
});

test("delivery-triggered follow-up: lifecycle 'archived' is not terminal", () => {
  const d = resolveDeliveryFollowUpDecision({
    final_delivery_status: "delivered",
    provider_message_id: "SM1",
    followup_intent: "nurture_not_interested",
    contactability_status: "contactable",
    lifecycle_stage: "archived",
  });
  assert.equal(d.eligible, true, d.reason);
  const closed = resolveDeliveryFollowUpDecision({ final_delivery_status: "delivered", provider_message_id: "SM1", followup_intent: "x", lifecycle_stage: "closed" });
  assert.equal(closed.reason, "terminal_stage:closed");
});

test("execution-gap recovery: the stale-active sweep does not filter out archived threads", () => {
  const src = fs.readFileSync(new URL("../../src/lib/domain/seller-flow/recover-seller-execution-gaps.js", import.meta.url), "utf8");
  assert.equal(/\.eq\(\s*["']is_archived["']/.test(src), false);
});

test("autonomy invariants: an archived nurture deal with no next step is still a dead end", () => {
  const vs = evaluateAutonomyInvariants({
    opportunities: [{ id: "opp-a", primary_thread_key: "+15550100002", acquisition_stage: "offer_interest", opportunity_status: "nurture", next_action: null }],
    thread_states: [{ thread_key: "+15550100002", ...ARCHIVED }],
    now: NOW,
  });
  assert.deepEqual(vs.filter((v) => v.code === INVARIANT_CODES.STAGE_WITHOUT_NEXT_ACTION).map((v) => v.entity_id), ["opp-a"]);
});
