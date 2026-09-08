/**
 * inbox-decline-bucket-coherence.test.mjs
 *
 * A canonically declined seller matched BOTH Dead and Priority at once:
 * `case "dead"` read disposition=not_interested, while Priority/Cold/Active
 * excluded only isTerminalNoContactThread, which does not. 18 of the 28
 * reconciled threads were in that contradictory state.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  threadMatchesBucketFilter,
  isTerminalNoContactThread,
  isSuppressedContact,
  isDeclinedNotSellingThread,
  isClosedAttentionThread,
} from "../../src/lib/domain/inbox/inbox-bucket-predicates.js";

/** A reconciled thread: declined, still carrying its stale priority bucket. */
const declined = (over = {}) => ({
  thread_key: "+15550003333",
  inbox_bucket: "priority",
  disposition: "not_interested",
  operational_status: "paused",
  lead_temperature: "cold",
  is_suppressed: false,
  latest_message_direction: "inbound",
  is_read: false,
  // Fresh timestamps: threadMatchesNewRepliesFacts is fact-derived and treats
  // an explicit new_replies bucket with no recent inbound as stale.
  last_inbound_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  latest_message_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  last_outbound_at: new Date(Date.now() - 60 * 60_000).toISOString(),
  unread_count: 1,
  ...over,
});

test("1. a declined seller is Dead", () => {
  assert.equal(threadMatchesBucketFilter(declined(), "dead"), true);
});

test("2. a declined seller is NOT Priority", () => {
  assert.equal(threadMatchesBucketFilter(declined(), "priority"), false);
});

test("3. a declined seller is NOT stale New Replies", () => {
  assert.equal(threadMatchesBucketFilter(declined({ inbox_bucket: "new_replies" }), "new_replies"), false);
});

test("declined also leaves Needs Review, Follow-Up, Active and Cold", () => {
  for (const bucket of ["needs_review", "follow_up", "active", "cold"]) {
    assert.equal(
      threadMatchesBucketFilter(declined({ inbox_bucket: bucket }), bucket),
      false,
      `${bucket} must not retain a declined seller`,
    );
  }
});

test("8. a thread can NEVER be both Dead and Priority", () => {
  for (const bucket of ["priority", "new_replies", "needs_review", "follow_up", "cold", "active"]) {
    const row = declined({ inbox_bucket: bucket });
    const isDead = threadMatchesBucketFilter(row, "dead");
    const isActionable = threadMatchesBucketFilter(row, bucket);
    assert.equal(isDead && isActionable, false, `simultaneously dead and ${bucket}`);
  }
});

test("7. All retains the declined conversation -- nothing is destroyed", () => {
  assert.equal(threadMatchesBucketFilter(declined(), "all"), true);
  assert.equal(threadMatchesBucketFilter(declined(), "all_messages"), true);
});

// ── decline is not suppression ──────────────────────────────────────────────

test("4+7. a decline is NOT a contact prohibition", () => {
  const row = declined();
  assert.equal(isDeclinedNotSellingThread(row), true);
  assert.equal(isSuppressedContact(row), false, "a decline must never read as suppression");
  assert.equal(isTerminalNoContactThread(row), false, "contact is not prohibited by a decline");
  assert.equal(isClosedAttentionThread(row), true, "but it IS closed for attention");
  assert.equal(threadMatchesBucketFilter(row, "suppressed"), false);
});

test("5. DNC / suppressed behaviour is unchanged", () => {
  const suppressed = { inbox_bucket: "suppressed", is_suppressed: true, disposition: null };
  assert.equal(threadMatchesBucketFilter(suppressed, "suppressed"), true);
  assert.equal(threadMatchesBucketFilter(suppressed, "priority"), false);
  assert.equal(isTerminalNoContactThread(suppressed), true);

  const wrongNumber = { inbox_bucket: "priority", disposition: "wrong_number" };
  assert.equal(threadMatchesBucketFilter(wrongNumber, "priority"), false);
  assert.equal(threadMatchesBucketFilter(wrongNumber, "dead"), true);
});

// ── reopening ───────────────────────────────────────────────────────────────

test("6. a REOPENED seller becomes actionable again", () => {
  // The live path clears disposition on re-engagement. Inbox follows CURRENT
  // canonical state, so the thread returns -- it never derives permanent death
  // from historical message text.
  const reopened = declined({ disposition: "none", operational_status: "active_communication" });
  assert.equal(threadMatchesBucketFilter(reopened, "priority"), true);
  assert.equal(threadMatchesBucketFilter(reopened, "dead"), false);

  const reopenedNewReply = declined({
    inbox_bucket: "new_replies", disposition: null, operational_status: "active_communication",
  });
  assert.equal(threadMatchesBucketFilter(reopenedNewReply, "new_replies"), true);
});

test("a null disposition is never treated as a decline", () => {
  const plain = declined({ disposition: null });
  assert.equal(isDeclinedNotSellingThread(plain), false);
  assert.equal(threadMatchesBucketFilter(plain, "priority"), true);
});

// ── unrelated behaviour ─────────────────────────────────────────────────────

test("10. Scheduled and Snoozed behaviour is unchanged", () => {
  const scheduled = { inbox_bucket: "priority", is_schedule_suppressed: true, disposition: null };
  assert.equal(threadMatchesBucketFilter(scheduled, "scheduled"), true);
  assert.equal(threadMatchesBucketFilter(scheduled, "priority"), false);

  // A declined thread is not scheduled merely by being declined.
  assert.equal(threadMatchesBucketFilter(declined(), "scheduled"), false);
});

test("9. counts recompute: declined threads leave attention totals, join dead", () => {
  const rows = [
    declined({ thread_key: "a" }),
    declined({ thread_key: "b", inbox_bucket: "new_replies" }),
    { thread_key: "c", inbox_bucket: "priority", disposition: null },
  ];
  const count = (bucket) => rows.filter((r) => threadMatchesBucketFilter(r, bucket)).length;
  assert.equal(count("priority"), 1, "only the undeclined thread counts as priority");
  assert.equal(count("new_replies"), 0);
  assert.equal(count("dead"), 2);
  assert.equal(count("all"), 3, "all retains every conversation");
});
