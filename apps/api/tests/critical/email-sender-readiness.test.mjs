/**
 * email-sender-readiness.test.mjs
 *
 * "May this sender carry this message right now?"
 *
 * Deliverability is a property of the sender. Sending from a suspended mailbox,
 * an unverified domain, or past a warm-up allowance does not just fail once: it
 * damages the reputation of a domain every later send depends on. These are the
 * rules that stop one careless batch from burning it.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateEmailSenderReadiness,
  SENDER_BLOCKING_REASONS,
  WARMUP_DAILY_ALLOWANCE,
} from "@/lib/domain/email/email-sender-readiness.js";

const sender = (over = {}) => ({
  sender_key: "acq-primary",
  from_email: "acq@reivesti.com",
  sender_name: "Acquisitions",
  reply_to_email: "replies@reivesti.com",
  domain: "reivesti.com",
  domain_verified: true,
  is_active: true,
  sender_status: "active",
  warmup_status: "warmed",
  daily_limit: 500,
  messages_sent_today: 10,
  ...over,
});

test("a healthy, warmed, under-cap sender is ready", () => {
  const verdict = evaluateEmailSenderReadiness({ sender: sender() });
  assert.equal(verdict.ready, true);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.sender.remaining_today, 490);
});

// ── a fact we did not check is not a fact in our favour ────────────────────

test("a sender that was NOT LOADED refuses", () => {
  const verdict = evaluateEmailSenderReadiness({});
  assert.equal(verdict.ready, false);
  assert.equal(verdict.reason, "sender_not_found");
  assert.equal(verdict.reason_detail, "sender_not_loaded");
});

test("a sender that does not exist refuses, rather than falling back", () => {
  // Falling back to the env default would bypass caps, warm-up and suspension in
  // one step, because the env default has none of them.
  assert.equal(evaluateEmailSenderReadiness({ sender: null }).reason, "sender_not_found");
});

// ── posture ────────────────────────────────────────────────────────────────

test("an inactive sender refuses", () => {
  assert.equal(evaluateEmailSenderReadiness({ sender: sender({ is_active: false }) }).reason, "sender_inactive");
});

test("every suspended-shaped status refuses", () => {
  for (const status of ["suspended", "disabled", "paused", "blocked", "revoked"]) {
    const verdict = evaluateEmailSenderReadiness({ sender: sender({ sender_status: status }) });
    assert.equal(verdict.reason, "sender_suspended", `status ${status} was allowed`);
  }
});

test("an UNRECOGNISED status refuses rather than being assumed benign", () => {
  // A sender whose posture we cannot describe is a sender we cannot vouch for.
  const verdict = evaluateEmailSenderReadiness({ sender: sender({ sender_status: "quarantining" }) });
  assert.equal(verdict.reason, "sender_suspended");
  assert.match(verdict.reason_detail, /unrecognised_status/);
});

test("the usable statuses are genuinely usable, so the refusals above are not vacuous", () => {
  for (const status of ["active", "ready", "warming"]) {
    const verdict = evaluateEmailSenderReadiness({
      sender: sender({ sender_status: status, warmup_status: "warmed" }),
    });
    assert.equal(verdict.ready, true, `status ${status} was refused`);
  }
});

test("a paused warm-up refuses", () => {
  for (const warmup of ["paused", "halted"]) {
    assert.equal(
      evaluateEmailSenderReadiness({ sender: sender({ warmup_status: warmup }) }).reason,
      "sender_warmup_paused"
    );
  }
});

test("a sender with no from address refuses", () => {
  assert.equal(
    evaluateEmailSenderReadiness({ sender: sender({ from_email: "" }) }).reason,
    "sender_missing_from_address"
  );
});

// ── domain verification: false blocks, absent warns ────────────────────────

test("an explicitly unverified domain refuses", () => {
  const verdict = evaluateEmailSenderReadiness({ sender: sender({ domain_verified: false }) });
  assert.equal(verdict.reason, "sender_domain_unverified");
});

test("an UNKNOWN verification state warns but does not block", () => {
  // Most rows predate the column. Absent is unknown, not unverified, and
  // refusing on absence would stop every existing sender.
  for (const value of [undefined, null]) {
    const verdict = evaluateEmailSenderReadiness({ sender: sender({ domain_verified: value }) });
    assert.equal(verdict.ready, true);
    assert.equal(verdict.warnings[0].reason, "sender_domain_verification_unknown");
  }
});

test("domain verification can be waived deliberately", () => {
  const verdict = evaluateEmailSenderReadiness({
    sender: sender({ domain_verified: false }),
    require_domain_verified: false,
  });
  assert.equal(verdict.ready, true);
});

// ── volume ─────────────────────────────────────────────────────────────────

test("the configured daily cap blocks at, not after, the limit", () => {
  assert.equal(evaluateEmailSenderReadiness({ sender: sender({ messages_sent_today: 499 }) }).ready, true);
  const at = evaluateEmailSenderReadiness({ sender: sender({ messages_sent_today: 500 }) });
  assert.equal(at.reason, "sender_daily_cap_reached");
  assert.equal(at.reason_detail, "500/500");
});

test("the WARM-UP ladder binds independently of the configured limit", () => {
  // A daily_limit of 500 on a domain in its first week is an aspiration, not a
  // permission.
  const verdict = evaluateEmailSenderReadiness({
    sender: sender({ warmup_status: "new", daily_limit: 500, messages_sent_today: WARMUP_DAILY_ALLOWANCE.new }),
  });
  assert.equal(verdict.reason, "sender_warmup_cap_reached");
});

test("the LOWER of the two caps governs remaining_today", () => {
  const verdict = evaluateEmailSenderReadiness({
    sender: sender({ warmup_status: "warming", daily_limit: 500, messages_sent_today: 10 }),
  });
  assert.equal(verdict.sender.remaining_today, WARMUP_DAILY_ALLOWANCE.warming - 10);
});

test("a warmed sender has no ladder cap", () => {
  const verdict = evaluateEmailSenderReadiness({
    sender: sender({ warmup_status: "warmed", daily_limit: 500, messages_sent_today: 400 }),
  });
  assert.equal(verdict.ready, true);
  assert.equal(verdict.sender.warmup_allowance, null);
});

test("a sender with no configured cap and no ladder is unbounded, and says so", () => {
  const verdict = evaluateEmailSenderReadiness({
    sender: sender({ daily_limit: null, warmup_status: "established", messages_sent_today: 9999 }),
  });
  assert.equal(verdict.ready, true);
  assert.equal(verdict.sender.remaining_today, null);
});

test("a zero daily limit blocks everything, rather than reading as 'no limit'", () => {
  const verdict = evaluateEmailSenderReadiness({
    sender: sender({ daily_limit: 0, messages_sent_today: 0 }),
  });
  assert.equal(verdict.reason, "sender_daily_cap_reached");
});

// ── the verdict is auditable ───────────────────────────────────────────────

test("every reason the policy emits is in the ranked vocabulary", () => {
  const cases = [
    {}, { sender: null },
    { sender: sender({ is_active: false }) },
    { sender: sender({ sender_status: "suspended" }) },
    { sender: sender({ from_email: "" }) },
    { sender: sender({ domain_verified: false }) },
    { sender: sender({ warmup_status: "paused" }) },
    { sender: sender({ messages_sent_today: 500 }) },
    { sender: sender({ warmup_status: "new", messages_sent_today: 50 }) },
  ];
  for (const input of cases) {
    for (const reason of evaluateEmailSenderReadiness(input).blocking_reasons) {
      assert.ok(SENDER_BLOCKING_REASONS.includes(reason), `unranked reason: ${reason}`);
    }
  }
});

test("all blocking reasons are collected, and the most durable is the headline", () => {
  const verdict = evaluateEmailSenderReadiness({
    sender: sender({ is_active: false, sender_status: "suspended", messages_sent_today: 500 }),
  });
  assert.ok(verdict.blocking_reasons.includes("sender_inactive"));
  assert.ok(verdict.blocking_reasons.includes("sender_suspended"));
  assert.ok(verdict.blocking_reasons.includes("sender_daily_cap_reached"));
  assert.equal(verdict.reason, "sender_inactive", "a disabled sender outranks a full one");
});

test("evaluation is pure and carries its policy version", () => {
  const input = { sender: sender({ messages_sent_today: 42 }) };
  assert.deepEqual(evaluateEmailSenderReadiness(input), evaluateEmailSenderReadiness(input));
  assert.equal(evaluateEmailSenderReadiness(input).policy_version, "email_sender_readiness_v1");
});
