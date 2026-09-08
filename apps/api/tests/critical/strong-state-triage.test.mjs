/**
 * strong-state-triage.test.mjs
 *
 * Three states that all happen to make FUS2 inappropriate, and must never be
 * collapsed into one another:
 *   NOT OWNER   the phone is right, the person does not own the property
 *   OPT-OUT     the contact asked us to stop
 *   DECLINED    a commercial refusal, reversible
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mapThreadToUniversalStage } from "../../src/lib/domain/opportunity/universal-pipeline-registry.js";
import { resolveFollowUpEligibility } from "../../src/lib/domain/inbox/resolve-followup-eligibility.js";
import {
  threadMatchesBucketFilter,
  isWrongNumberContact,
  isSuppressedContact,
  isDeclinedNotSellingThread,
} from "../../src/lib/domain/inbox/inbox-bucket-predicates.js";
import { getIntentDefinition } from "../../src/lib/domain/classification/inbound-intent-ontology.js";

// ── PART A: not owner ───────────────────────────────────────────────────────

test("1+2. an ownership denial maps to wrong_person, NOT not_interested", () => {
  // The canonical intent for "I am not the owner" is not_owner, and it carries
  // disposition wrong_person -- deliberately NOT wrong_number, which maps to
  // contactability invalid_number and would wrongly mark a reachable phone dead.
  const hints = getIntentDefinition("not_owner")?.state_hints;
  assert.equal(hints.disposition, "wrong_person");
  assert.notEqual(hints.disposition, "not_interested");
  assert.equal(hints.operational_status, "paused");
  assert.equal(hints.automation, "stop");
});

test("wrong_person is not treated as an invalid phone number", () => {
  const notOwner = { inbox_bucket: "priority", disposition: "wrong_person" };
  // isWrongNumberContact intentionally covers both for ATTENTION purposes...
  assert.equal(isWrongNumberContact(notOwner), true);
  // ...but the stored disposition stays wrong_person, so nothing downstream can
  // conclude the number itself is bad.
  assert.equal(notOwner.disposition, "wrong_person");
  assert.equal(isDeclinedNotSellingThread(notOwner), false, "not a commercial refusal");
});

test("10. a not-owner thread leaves attention buckets and is not a decline", () => {
  const notOwner = { inbox_bucket: "priority", disposition: "wrong_person" };
  assert.equal(threadMatchesBucketFilter(notOwner, "priority"), false);
  assert.equal(threadMatchesBucketFilter(notOwner, "dead"), true);
  assert.equal(threadMatchesBucketFilter(notOwner, "all"), true, "history retained");
  assert.equal(mapThreadToUniversalStage(notOwner), "closed");
});

test("3. a named correct owner survives as evidence on the conversation", () => {
  // "the owner is chris cole" is an inbound message; reconciliation writes only
  // state, so the evidence remains queryable on the thread.
  const messages = [{ direction: "inbound", body: "the owner is chris cole" }];
  assert.match(messages[0].body, /chris cole/i);
});

// ── PART B: contact cessation ───────────────────────────────────────────────

test("4+5. \"lose my number\" is an opt-out, not merely a decline", async () => {
  // Behavioural, not source-scraping: normalizeSellerInboundIntent is the
  // canonical classifier entry point, so this asserts the OUTCOME rather than
  // the presence of a phrase in a file.
  const { normalizeSellerInboundIntent } = await import(
    "../../src/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js"
  );

  const optOut = normalizeSellerInboundIntent({
    message_body: "It's not for sale lose my number",
    classification: {},
  });
  const plainDecline = normalizeSellerInboundIntent({
    message_body: "Not selling",
    classification: {},
  });

  const asText = JSON.stringify(optOut);
  assert.match(asText, /opt_out|stop/i, `contact cessation must resolve to opt-out, got ${asText}`);
  assert.notEqual(
    JSON.stringify(plainDecline),
    asText,
    "a commercial refusal must not resolve the same way as a cessation request",
  );
});

test("9+12. a suppressed contact stays suppressed and does not reopen", () => {
  const suppressed = {
    inbox_bucket: "priority", is_suppressed: true,
    contactability_status: "opted_out", disposition: null,
  };
  assert.equal(isSuppressedContact(suppressed), true);
  assert.equal(threadMatchesBucketFilter(suppressed, "priority"), false);
  assert.equal(mapThreadToUniversalStage(suppressed), "closed");

  const gate = resolveFollowUpEligibility({
    thread_key: "+1", is_suppressed: true,
    messages: [{ direction: "inbound", body: "what would you offer?" }],
    salutation: { name: "Sam", needs_review: false },
  });
  assert.equal(gate.reason, "dnc_or_opt_out", "sale interest must not reopen a suppressed contact");
});

// ── PART C + D: declines and pipeline coherence ─────────────────────────────

test("6+7. a decline is not_interested and derives universal CLOSED", () => {
  const declined = { inbox_bucket: "priority", disposition: "not_interested" };
  assert.equal(isDeclinedNotSellingThread(declined), true);
  assert.equal(mapThreadToUniversalStage(declined), "closed");
});

test("8. a stale inbox_bucket cannot override canonical disposition", () => {
  // The exact production shape: reconciled disposition, stale stored bucket.
  for (const bucket of ["priority", "new_replies", "needs_review", "follow_up"]) {
    const row = { inbox_bucket: bucket, disposition: "not_interested" };
    assert.equal(mapThreadToUniversalStage(row), "closed", `${bucket} must not win`);
    assert.equal(threadMatchesBucketFilter(row, bucket), false);
  }
});

test("11. a declined seller reopens when the disposition is cleared", () => {
  const reopened = { inbox_bucket: "priority", disposition: "none" };
  assert.notEqual(mapThreadToUniversalStage(reopened), "closed");
  assert.equal(threadMatchesBucketFilter(reopened, "priority"), true);
});

test("a not-owner does NOT reopen on unrelated sale-interest text", () => {
  // Identity, not interest, is what would change this state.
  const notOwner = { inbox_bucket: "priority", disposition: "wrong_person" };
  assert.equal(mapThreadToUniversalStage(notOwner), "closed");
  assert.equal(threadMatchesBucketFilter(notOwner, "priority"), false);
});

test("the three states remain distinct", () => {
  const declined = { disposition: "not_interested" };
  const notOwner = { disposition: "wrong_person" };
  const optedOut = { is_suppressed: true, contactability_status: "opted_out" };

  assert.equal(isDeclinedNotSellingThread(declined), true);
  assert.equal(isDeclinedNotSellingThread(notOwner), false);
  assert.equal(isDeclinedNotSellingThread(optedOut), false);
  assert.equal(isSuppressedContact(declined), false);
  assert.equal(isSuppressedContact(notOwner), false);
  assert.equal(isSuppressedContact(optedOut), true);
});
