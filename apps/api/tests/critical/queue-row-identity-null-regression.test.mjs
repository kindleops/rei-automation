/**
 * queue-row-identity-null-regression.test.mjs
 *
 * A NULL QUEUE ROW MUST REFUSE, NOT THROW.
 *
 * THE DEFECT.
 *   resolveQueueRowIdentity(queue_row = {}) uses a default parameter, and a
 *   default parameter only applies to `undefined`. An explicit `null` therefore
 *   reached `queue_row.metadata` and threw a TypeError, while every other
 *   unusable input -- undefined, a string, a number -- correctly returned
 *   { ok: false, reason: 'queue_row_identity_underivable' }.
 *
 * WHY A THROW IS WORSE THAN A REFUSAL HERE, and not merely untidy.
 *   dispatch-seller-queue-row.js states the rule in its own words: a store that
 *   cannot answer "must REFUSE rather than throw: a TypeError escaping the
 *   dispatch path is something a caller may catch and mistake for a transport
 *   failure, which is the one reading that could justify a retry."
 *
 *   That is the whole exposure. A refusal is a decision the seam records and
 *   acts on. An exception is an unclassified failure, and an unclassified
 *   failure caught by a caller that treats exceptions as transport errors can
 *   be read as "the network was flaky, try again" -- for a message whose domain
 *   action was never even identified.
 *
 *   The email twin, resolveEmailQueueRowIdentity, was written with this closed
 *   from the start. This brings the SMS resolver to the same standard.
 *
 * Found while building the email resolver in EMAIL-2; repaired under an explicit
 * authorization in EMAIL-3 because cross-channel identity is what EMAIL-3 rests on.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveQueueRowIdentity } from "@/lib/domain/communications/queue-row-identity.js";
import { resolveEmailQueueRowIdentity } from "@/lib/domain/email/email-queue-row-identity.js";

test("a NULL queue row refuses instead of throwing", () => {
  let result;
  assert.doesNotThrow(() => { result = resolveQueueRowIdentity(null); });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "queue_row_identity_underivable");
});

test("every unusable input shape produces the SAME refusal, not a mix of refusals and throws", () => {
  // The defect was a discontinuity: null threw while its neighbours refused.
  // Asserting they agree is what stops the discontinuity coming back in another
  // form.
  for (const value of [undefined, null, "", "a string", 0, 42, true, [], () => {}, NaN]) {
    let result;
    assert.doesNotThrow(
      () => { result = resolveQueueRowIdentity(value); },
      `threw on ${String(value)}`
    );
    assert.equal(result.ok, false, `unexpectedly resolved ${String(value)}`);
    assert.equal(result.reason, "queue_row_identity_underivable", `wrong reason for ${String(value)}`);
  }
});

test("a null row never produces a bound identity", () => {
  // The refusal must not be reached via the `bound` short-circuit, which would
  // hand a caller a logical_communication_id of undefined.
  const result = resolveQueueRowIdentity(null);
  assert.notEqual(result.bound, true);
  assert.equal(result.logical_communication_id, undefined);
});

test("both channel resolvers refuse a null row identically", () => {
  // Cross-channel identity is what EMAIL-3 rests on. Two resolvers that disagree
  // about what "no row" means would eventually disagree about something worse.
  const sms = resolveQueueRowIdentity(null);
  const email = resolveEmailQueueRowIdentity(null);
  assert.equal(sms.ok, false);
  assert.equal(email.ok, false);
  assert.match(sms.reason, /identity_underivable$/);
  assert.match(email.reason, /identity_underivable$/);
});

// ── the fix must not have widened what IS accepted ─────────────────────────

test("a real row still resolves exactly as before", () => {
  const identity = resolveQueueRowIdentity({ campaign_target_id: "ct-1", touch_number: 3 });
  assert.equal(identity.ok, true);
  assert.equal(identity.communication_type, "campaign_touch");
  assert.equal(identity.anchors.channel, "sms");
  assert.equal(identity.anchors.campaign_target_id, "ct-1");
  assert.equal(identity.anchors.touch_number, "3");
});

test("a bound row still short-circuits", () => {
  const identity = resolveQueueRowIdentity({ logical_communication_id: "lc-9" });
  assert.equal(identity.bound, true);
  assert.equal(identity.logical_communication_id, "lc-9");
});

test("a monetary row with no offer authority still REFUSES loudly", () => {
  // The most important refusal in the file. A hardening change that turned this
  // into a generic underivable would lose the reason an operator needs.
  const identity = resolveQueueRowIdentity({
    message_type: "initial_offer",
    metadata: { use_case: "initial_offer" },
  });
  assert.equal(identity.ok, false);
  assert.equal(identity.reason, "monetary_communication_without_offer_authority");
});

test("a row with hostile metadata is tolerated without becoming permissive", () => {
  for (const metadata of [null, "string", 42, [], true]) {
    const identity = resolveQueueRowIdentity({ metadata });
    assert.equal(identity.ok, false);
    assert.equal(identity.reason, "queue_row_identity_underivable");
  }
});
