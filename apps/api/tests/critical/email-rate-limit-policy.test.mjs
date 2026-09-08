/**
 * email-rate-limit-policy.test.mjs
 *
 * THE 429 DECISION, pinned so it can only change deliberately.
 *
 * THE QUESTION. When Brevo answers a send with HTTP 429, was a message CREATED?
 * If the request was rejected outright the send is provably unsent and safe to
 * repeat after a delay. If a message may have been queued before the limiter
 * answered, acceptance cannot be excluded and the send must be held.
 *
 * WHAT THIS REPOSITORY CURRENTLY KNOWS: nothing, from evidence. Brevo documents
 * 429 as "too many requests", which describes the status code and says nothing
 * about message creation. So `provider_rate_limited` is a NAMED class that is
 * deliberately absent from every set in transport-outcome-mapping.js, landing it
 * in the fail-closed ambiguous branch.
 *
 * THAT HOLD HAS A REAL COST -- a rate-limited send stalls instead of backing off
 * -- so these tests exist to make sure it is a decision rather than an accident,
 * and to make the exact change required to lift it obvious.
 *
 * TO LIFT THE HOLD:
 *   1. Run `npm run proof:brevo-429-probe` with a real credential.
 *   2. Confirm no 429 carried a messageId AND that Brevo's transactional log for
 *      the probe window shows exactly accepted_count messages.
 *   3. Add "provider_rate_limited" to a set in transport-outcome-mapping.js that
 *      yields definitely_not_sent + retry_after, and carry Retry-After through.
 *   4. The final assertion below will fail. Update it, citing the probe report.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classifyBrevoProviderError } from "@/lib/domain/email/transport/brevo-error-classifier.js";
import { mapTransportOutcome } from "@/lib/domain/communications/transport-outcome-mapping.js";
import { EMAIL_FAILURE_CLASSES } from "@/lib/domain/email/transport/email-transport-contract.js";

test("a 429 is classified as its own NAMED class, not as a generic ambiguity", () => {
  // Named so the hold is greppable. An anonymous ambiguity is indistinguishable
  // from a bug, and nobody would ever find it to lift it.
  const classified = classifyBrevoProviderError({ status: 429, data: { message: "Too many requests" } });
  assert.equal(classified.failure_class, "provider_rate_limited");
  assert.ok(EMAIL_FAILURE_CLASSES.includes("provider_rate_limited"));
});

test("the operator reason explains WHY it is held, not just that it was", () => {
  const classified = classifyBrevoProviderError({ status: 429 });
  assert.match(classified.operator_reason, /unverified|semantics/i);
});

test("BEFORE the probe: a 429 is HELD, not retried", () => {
  const outcome = mapTransportOutcome({ failure_class: "provider_rate_limited" });
  assert.equal(outcome.delivery_possibility, "may_have_been_sent");
  assert.equal(outcome.retry_authority, "retry_denied");
  assert.equal(outcome.logical_state, "ambiguous_provider_outcome");
});

test("provider_rate_limited is absent from every mapped set, which is what holds it", () => {
  // The hold is a property of the mapping's structure -- the class simply falls
  // through to the fail-closed branch -- rather than a special case that could be
  // deleted by accident.
  const held = mapTransportOutcome({ failure_class: "provider_rate_limited" });
  const unknown = mapTransportOutcome({ failure_class: "an_entirely_made_up_class" });
  assert.equal(held.delivery_possibility, unknown.delivery_possibility);
  assert.equal(held.retry_authority, unknown.retry_authority);
});

test("a 429 never masquerades as a send", () => {
  const outcome = mapTransportOutcome({ failure_class: "provider_rate_limited" });
  assert.notEqual(outcome.logical_state, "provider_accepted");
  assert.notEqual(outcome.delivery_possibility, "provider_accepted");
});

test("a 5xx and a 429 are held for the SAME reason, and are told apart", () => {
  // Both are ambiguous, but an operator must be able to tell a rate limit from an
  // outage: one is our own volume and the other is theirs.
  const rate = classifyBrevoProviderError({ status: 429 });
  const outage = classifyBrevoProviderError({ status: 503 });
  assert.notEqual(rate.failure_class, outage.failure_class);
  assert.equal(
    mapTransportOutcome(rate).retry_authority,
    mapTransportOutcome(outage).retry_authority
  );
});

/**
 * THE TRIPWIRE.
 *
 * This asserts the CURRENT, evidence-free position. It is meant to fail the day
 * someone maps provider_rate_limited, which forces the change to be accompanied
 * by a deliberate edit here and, with it, a citation of the probe that justified
 * it. A retry policy that could be widened without anyone noticing is a retry
 * policy that will eventually send a seller a duplicate.
 */
test("TRIPWIRE: lifting the 429 hold must be a deliberate, cited change", () => {
  const outcome = mapTransportOutcome({ failure_class: "provider_rate_limited" });
  assert.equal(
    outcome.retry_authority,
    "retry_denied",
    "provider_rate_limited is no longer held. If npm run proof:brevo-429-probe " +
    "established that a 429 creates no message, update this test and cite the " +
    "probe report path. If it did not, revert the mapping change."
  );
});
