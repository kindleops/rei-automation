/**
 * email-outreach-eligibility.test.mjs
 *
 * "May we email this seller, at this address, right now?"
 *
 * The properties under test are the ones that cost real money or real trust:
 *   - an unchecked fact is a REFUSAL, never an assumed pass
 *   - an opt-out outranks a cooldown, so nobody waits an hour and then sends
 *   - a recent SMS blocks an email (duplicate contact across channels)
 *   - a permanent block never advertises a next_eligible_at
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateEmailOutreachEligibility,
  DEFAULT_EMAIL_ELIGIBILITY_POLICY,
  BLOCKING_REASONS,
} from "@/lib/domain/email/email-outreach-eligibility.js";

const NOW = "2026-09-08T18:00:00.000Z";
const hoursAgo = (h) => new Date(Date.parse(NOW) - h * 3600_000).toISOString();
const hoursFromNow = (h) => new Date(Date.parse(NOW) + h * 3600_000).toISOString();

/** A seller we are allowed to email: everything checked, nothing blocking. */
const clean = (over = {}) => ({
  email_address: "seller@example.com",
  suppression: null,
  contact_state: null,
  now: NOW,
  ...over,
});

// ── the happy path exists, so the refusals below mean something ─────────────

test("a checked, unsuppressed, never-contacted address is eligible", () => {
  const verdict = evaluateEmailOutreachEligibility(clean());
  assert.equal(verdict.eligible, true);
  assert.equal(verdict.reason, null);
  assert.deepEqual(verdict.blocking_reasons, []);
  assert.equal(verdict.normalized_email, "seller@example.com");
});

// ── unchecked is not permission ─────────────────────────────────────────────

test("suppression NOT CHECKED refuses: undefined is not 'no suppression'", () => {
  // This is the exact shape of the bug that made the old duplicate guard fail
  // open -- a read that errored was indistinguishable from a clean read.
  const verdict = evaluateEmailOutreachEligibility(clean({ suppression: undefined }));
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blocking_reasons.includes("suppression_state_unknown"));
});

test("contact state NOT CHECKED refuses", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({ contact_state: undefined }));
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blocking_reasons.includes("contact_state_unknown"));
});

test("checked-and-absent (null) is NOT the same as unchecked and does not block", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({ suppression: null, contact_state: null }));
  assert.equal(verdict.eligible, true);
});

// ── suppression ─────────────────────────────────────────────────────────────

test("an unsubscribe blocks permanently and reports opted_out", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    suppression: { reason: "unsubscribed", is_active: true },
  }));
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "opted_out");
  assert.equal(verdict.next_eligible_at, null, "a permanent block must never advertise a retry time");
});

test("a hard bounce blocks permanently", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    suppression: { reason: "hard_bounce", is_active: true },
  }));
  assert.equal(verdict.reason, "hard_bounced");
  assert.equal(verdict.next_eligible_at, null);
});

test("a complaint blocks permanently", () => {
  assert.equal(
    evaluateEmailOutreachEligibility(clean({
      suppression: { reason: "complaint", is_active: true },
    })).reason,
    "complained"
  );
});

test("an INACTIVE suppression row does not block", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    suppression: { reason: "hard_bounce", is_active: false },
  }));
  assert.equal(verdict.eligible, true);
});

test("an UNRECOGNISED active suppression reason still blocks", () => {
  // An opt-out recorded under a label this policy has not learned yet must not
  // be treated as harmless.
  const verdict = evaluateEmailOutreachEligibility(clean({
    suppression: { reason: "gdpr_erasure_request", is_active: true },
  }));
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "do_not_contact");
});

test("a soft bounce with a FUTURE expiry blocks, and says when it lifts", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    suppression: { reason: "soft_bounce", is_active: true, expires_at: hoursFromNow(6) },
  }));
  assert.equal(verdict.reason, "soft_bounce_cooldown");
  assert.equal(verdict.next_eligible_at, hoursFromNow(6));
});

test("a soft bounce with a PAST expiry no longer blocks", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    suppression: { reason: "soft_bounce", is_active: true, expires_at: hoursAgo(1) },
  }));
  assert.equal(verdict.eligible, true);
});

test("a soft bounce with NO expiry is held, not released", () => {
  // "We do not know when this lifts" is not "it has lifted".
  const verdict = evaluateEmailOutreachEligibility(clean({
    suppression: { reason: "soft_bounce", is_active: true, expires_at: null },
  }));
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason_detail, "no_expiry_recorded");
});

// ── contact state: pauses and DNC ───────────────────────────────────────────

test("dnc blocks", () => {
  assert.equal(
    evaluateEmailOutreachEligibility(clean({ contact_state: { dnc: true } })).reason,
    "do_not_contact"
  );
});

test("is_paused blocks and surfaces the operator's reason", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    contact_state: { is_paused: true, pause_reason: "human_took_over" },
  }));
  assert.equal(verdict.reason, "automation_paused");
  assert.equal(verdict.reason_detail, "human_took_over");
});

// ── duplicate contact protection: the point of the whole module ─────────────

test("an SMS sent an hour ago BLOCKS an email", () => {
  // The defect this replaces: the old guard queried columns that do not exist,
  // swallowed the error and returned "no recent outreach", so this case sent.
  const verdict = evaluateEmailOutreachEligibility(clean({
    contact_state: { last_sms_at: hoursAgo(1), last_outbound_at: hoursAgo(1) },
  }));
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "cross_channel_cooldown_active");
});

test("the cross-channel window expires on schedule", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    contact_state: {
      last_sms_at: hoursAgo(DEFAULT_EMAIL_ELIGIBILITY_POLICY.cross_channel_cooldown_hours + 1),
      last_outbound_at: hoursAgo(DEFAULT_EMAIL_ELIGIBILITY_POLICY.cross_channel_cooldown_hours + 1),
    },
  }));
  assert.equal(verdict.eligible, true);
});

test("last_outbound_at is preferred over a per-channel timestamp", () => {
  // A channel that writes only its own column must not shorten the shared window.
  const verdict = evaluateEmailOutreachEligibility(clean({
    contact_state: { last_sms_at: hoursAgo(48), last_outbound_at: hoursAgo(2) },
  }));
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reason, "cross_channel_cooldown_active");
});

test("a recent email blocks another email under the channel cooldown", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    contact_state: { last_email_at: hoursAgo(30), last_outbound_at: hoursAgo(30) },
  }));
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blocking_reasons.includes("channel_cooldown_active"));
});

test("an explicit next_allowed_email_at is honoured", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    contact_state: { next_allowed_email_at: hoursFromNow(3) },
  }));
  assert.equal(verdict.reason, "channel_cooldown_active");
  assert.equal(verdict.next_eligible_at, hoursFromNow(3));
});

test("next_allowed_any_contact_at is honoured across channels", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    contact_state: { next_allowed_any_contact_at: hoursFromNow(5) },
  }));
  assert.equal(verdict.reason, "cross_channel_cooldown_active");
});

test("the touch budget blocks, and does NOT advertise a retry time", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    contact_state: { touch_count: DEFAULT_EMAIL_ELIGIBILITY_POLICY.max_touches },
  }));
  assert.equal(verdict.reason, "max_touches_reached");
  assert.equal(verdict.next_eligible_at, null, "a touch budget does not refill with time");
});

// ── reason ranking: the operator must be told the durable truth ─────────────

test("an opt-out OUTRANKS a cooldown", () => {
  // Reporting "cooldown" here would imply the seller becomes contactable later,
  // and eventually somebody waits and sends.
  const verdict = evaluateEmailOutreachEligibility(clean({
    suppression: { reason: "unsubscribed", is_active: true },
    contact_state: { last_outbound_at: hoursAgo(1) },
  }));
  assert.equal(verdict.reason, "opted_out");
  assert.ok(verdict.blocking_reasons.includes("cross_channel_cooldown_active"),
    "the cooldown is still reported, just not as the headline");
  assert.equal(verdict.next_eligible_at, null);
});

test("every blocking reason is collected, not just the first", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    email_address: "info@example.com",
    suppression: { reason: "hard_bounce", is_active: true },
    contact_state: { dnc: true, is_paused: true },
  }));
  assert.ok(verdict.blocking_reasons.length >= 4);
  assert.ok(verdict.blocking_reasons.includes("role_account"));
  assert.ok(verdict.blocking_reasons.includes("hard_bounced"));
  assert.ok(verdict.blocking_reasons.includes("do_not_contact"));
  assert.ok(verdict.blocking_reasons.includes("automation_paused"));
});

test("every reason the evaluator can emit is in the ranked vocabulary", () => {
  // An unranked reason would sort last and could hide a permanent block behind
  // a temporary one in the headline.
  const cases = [
    clean({ email_address: "!!!" }),
    clean({ suppression: undefined }),
    clean({ contact_state: undefined }),
    clean({ email_address: "info@x.com" }),
    clean({ email_address: "a@mailinator.com" }),
    clean({ suppression: { reason: "unsubscribed", is_active: true } }),
    clean({ suppression: { reason: "soft_bounce", is_active: true } }),
    clean({ contact_state: { dnc: true } }),
    clean({ contact_state: { is_paused: true } }),
    clean({ contact_state: { suppression_until: hoursFromNow(1) } }),
    clean({ contact_state: { last_outbound_at: hoursAgo(1) } }),
    clean({ contact_state: { last_email_at: hoursAgo(1), last_outbound_at: hoursAgo(1) } }),
    clean({ contact_state: { touch_count: 99 } }),
    clean({ address_record: { email_eligible: false } }),
  ];
  for (const input of cases) {
    for (const reason of evaluateEmailOutreachEligibility(input).blocking_reasons) {
      assert.ok(BLOCKING_REASONS.includes(reason), `unranked reason: ${reason}`);
    }
  }
});

// ── address quality ─────────────────────────────────────────────────────────

test("an unparseable address is the whole verdict and stops evaluation", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    email_address: "not an address",
    suppression: undefined,
  }));
  assert.equal(verdict.reason, "address_unparseable");
  assert.deepEqual(verdict.blocking_reasons, ["address_unparseable"],
    "no later check can rescue an address we cannot name");
  assert.equal(verdict.normalized_email, null);
});

test("role accounts and disposable domains block by default, and can be opted into", () => {
  assert.equal(evaluateEmailOutreachEligibility(clean({ email_address: "info@x.com" })).eligible, false);
  assert.equal(
    evaluateEmailOutreachEligibility(clean({
      email_address: "info@x.com", policy: { allow_role_accounts: true },
    })).eligible,
    true
  );
  assert.equal(evaluateEmailOutreachEligibility(clean({ email_address: "a@yopmail.com" })).eligible, false);
});

test("emails.email_eligible=false blocks", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    address_record: { email_eligible: false },
  }));
  assert.equal(verdict.reason, "address_marked_ineligible");
});

test("a low-confidence address WARNS but does not block", () => {
  const verdict = evaluateEmailOutreachEligibility(clean({
    address_record: { email_eligible: true, email_score_final: 12 },
  }));
  assert.equal(verdict.eligible, true);
  assert.equal(verdict.warnings[0].reason, "low_confidence_address");
});

// ── the verdict is auditable ────────────────────────────────────────────────

test("the verdict carries the policy version and the instant it was decided", () => {
  const verdict = evaluateEmailOutreachEligibility(clean());
  assert.equal(verdict.policy_version, "email_eligibility_v1");
  assert.equal(verdict.evaluated_at, NOW);
});

test("evaluation is pure: the same facts give the same verdict", () => {
  const input = clean({ contact_state: { last_outbound_at: hoursAgo(2) } });
  assert.deepEqual(
    evaluateEmailOutreachEligibility(input),
    evaluateEmailOutreachEligibility(input)
  );
});
