/**
 * email-inbound-thread-resolution.test.mjs
 *
 * WHICH CONVERSATION DOES THIS REPLY BELONG TO?
 *
 * The wrong answer here is silent: a reply attached to the wrong property does
 * not error, it appears in a deal and an operator negotiates about the wrong
 * house. So most of what is tested here is the REFUSALS -- the resolver must
 * decline far more readily than it guesses.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveInboundThread,
  RESOLUTION_STATUS,
  RESOLUTION_TIER,
} from "@/lib/domain/email/inbound/resolve-inbound-thread.js";

const OPP_A = { opportunity_id: "opp-a", master_owner_id: "own-1", property_id: "prop-a", thread_key: "+13125550100" };
const OPP_B = { opportunity_id: "opp-b", master_owner_id: "own-1", property_id: "prop-b", thread_key: "+13125550100" };

// ── TIER 1: the reply alias wins ───────────────────────────────────────────

test("a valid alias resolves, and outranks everything else", () => {
  const result = resolveInboundThread({
    alias: { id: "alias-1", is_active: true, ...OPP_A },
    presented_token: `r1.${"a".repeat(32)}`,
    // Deliberately contradictory weaker evidence: it must not be consulted.
    header_matches: [OPP_B],
    sender_candidates: [OPP_B, OPP_A],
  });

  assert.equal(result.status, RESOLUTION_STATUS.RESOLVED);
  assert.equal(result.tier, RESOLUTION_TIER.REPLY_ALIAS);
  assert.equal(result.conversation.opportunity_id, "opp-a");
});

test("a REVOKED alias refuses rather than falling through to weaker evidence", () => {
  // Revocation is a deliberate decision that this address should stop working.
  // Guessing past it would make revocation dangerous rather than merely useless.
  const result = resolveInboundThread({
    alias: { id: "alias-1", is_active: false, revoked_reason: "seller_requested", ...OPP_A },
    presented_token: `r1.${"a".repeat(32)}`,
    sender_candidates: [OPP_A],
  });

  assert.equal(result.status, RESOLUTION_STATUS.UNMATCHED);
  assert.equal(result.reason, "reply_alias_revoked");
  assert.equal(result.conversation, null);
});

test("a token that was PRESENTED but did not resolve is unmatched, not downgraded", () => {
  // Someone replied to an address we minted and we cannot find it. Falling
  // through to sender context might attach it somewhere plausible and wrong.
  const result = resolveInboundThread({
    alias: null,
    presented_token: `r1.${"f".repeat(32)}`,
    sender_candidates: [OPP_A],
  });

  assert.equal(result.status, RESOLUTION_STATUS.UNMATCHED);
  assert.equal(result.reason, "reply_token_unknown");
  assert.equal(result.presented_token_unknown, true);
});

// ── TIER 2: RFC headers ────────────────────────────────────────────────────

test("In-Reply-To / References matching one conversation resolves", () => {
  const result = resolveInboundThread({
    alias: null,
    presented_token: null,
    header_matches: [OPP_A],
    sender_candidates: [OPP_A, OPP_B],
  });

  assert.equal(result.status, RESOLUTION_STATUS.RESOLVED);
  assert.equal(result.tier, RESOLUTION_TIER.RFC_HEADERS);
  assert.equal(result.conversation.opportunity_id, "opp-a");
});

test("header matches spanning TWO conversations refuse", () => {
  // A seller forwarding one thread into another produces exactly this. There is
  // no correct pick.
  const result = resolveInboundThread({ alias: null, header_matches: [OPP_A, OPP_B] });

  assert.equal(result.status, RESOLUTION_STATUS.AMBIGUOUS);
  assert.equal(result.reason, "rfc_headers_span_multiple_conversations");
  assert.equal(result.candidate_count, 2);
});

test("several messages from the SAME conversation still resolve", () => {
  // References usually names the whole chain. Multiple matches are the normal
  // case, not an ambiguity.
  const result = resolveInboundThread({
    alias: null, header_matches: [OPP_A, { ...OPP_A }, { ...OPP_A }],
  });
  assert.equal(result.status, RESOLUTION_STATUS.RESOLVED);
  assert.equal(result.matched_message_count, 3);
});

test("headers outrank sender context", () => {
  const result = resolveInboundThread({
    alias: null, header_matches: [OPP_A], sender_candidates: [OPP_B],
  });
  assert.equal(result.conversation.opportunity_id, "opp-a");
});

// ── TIER 3: provider thread identity is inert on purpose ───────────────────

test("a provider thread id does NOT resolve, because Brevo documents none", () => {
  // Building on an undocumented field is building on something the provider can
  // change without telling anyone.
  const result = resolveInboundThread({ alias: null, provider_thread: { id: "brevo-thread-1" } });
  assert.equal(result.status, RESOLUTION_STATUS.UNMATCHED);
  assert.equal(result.reason, "provider_thread_identity_not_proven_stable");
  assert.equal(result.provider_thread_ignored, true);
});

// ── TIER 4: sender context, narrowly ───────────────────────────────────────

test("a sender with exactly ONE active conversation resolves", () => {
  const result = resolveInboundThread({
    alias: null, from_email: "seller@example.com", sender_candidates: [OPP_A],
  });
  assert.equal(result.status, RESOLUTION_STATUS.RESOLVED);
  assert.equal(result.tier, RESOLUTION_TIER.SENDER_CONTEXT);
});

test("ONE SELLER, TWO PROPERTIES refuses -- the case this file exists for", () => {
  // A landlord emailing about six properties. Recency and subject similarity are
  // both available here and both deliberately unused.
  const result = resolveInboundThread({
    alias: null, from_email: "landlord@example.com", sender_candidates: [OPP_A, OPP_B],
  });

  assert.equal(result.status, RESOLUTION_STATUS.AMBIGUOUS);
  assert.equal(result.reason, "sender_maps_to_multiple_conversations");
  assert.equal(result.conversation, null,
    "attaching to the wrong property is worse than requiring review");
});

test("duplicate rows for ONE conversation are not two candidates", () => {
  const result = resolveInboundThread({
    alias: null,
    sender_candidates: [OPP_A, { ...OPP_A }, { ...OPP_A, prospect_id: "p-9" }],
  });
  assert.equal(result.status, RESOLUTION_STATUS.RESOLVED);
});

test("candidates differing only by owner+property are DIFFERENT conversations", () => {
  const result = resolveInboundThread({
    alias: null,
    sender_candidates: [
      { master_owner_id: "own-1", property_id: "prop-a" },
      { master_owner_id: "own-1", property_id: "prop-b" },
    ],
  });
  assert.equal(result.status, RESOLUTION_STATUS.AMBIGUOUS);
});

test("candidates that cannot be PROVEN the same are treated as different", () => {
  // Two rows with no comparable anchors must push towards ambiguity rather than
  // towards a merge nobody authorised.
  const result = resolveInboundThread({
    alias: null, sender_candidates: [{ prospect_id: "p-1" }, { prospect_id: "p-2" }],
  });
  assert.equal(result.status, RESOLUTION_STATUS.AMBIGUOUS);
});

// ── no evidence at all ─────────────────────────────────────────────────────

test("an unknown sender with no evidence is unmatched, never attached", () => {
  const result = resolveInboundThread({
    alias: null, from_email: "stranger@example.com", sender_candidates: [],
  });
  assert.equal(result.status, RESOLUTION_STATUS.UNMATCHED);
  assert.equal(result.reason, "no_conversation_for_sender");
});

test("an empty input refuses without throwing", () => {
  const result = resolveInboundThread({});
  assert.equal(result.status, RESOLUTION_STATUS.UNMATCHED);
  assert.equal(result.reason, "no_resolution_evidence");
});

test("resolution never throws on hostile input", () => {
  for (const input of [undefined, null, {}, { alias: "string" }, { header_matches: "nope" }, { sender_candidates: 42 }]) {
    assert.doesNotThrow(() => resolveInboundThread(input));
  }
});

// ── the explicit prohibitions ──────────────────────────────────────────────

test("SUBJECT is never consulted, even when it would disambiguate", () => {
  const result = resolveInboundThread({
    alias: null,
    subject: "Re: Your offer on 123 Main St",
    sender_candidates: [
      { ...OPP_A, subject: "Your offer on 123 Main St" },
      { ...OPP_B, subject: "Your offer on 456 Oak Ave" },
    ],
  });
  assert.equal(result.status, RESOLUTION_STATUS.AMBIGUOUS);
});

test("RECENCY is never consulted, even when one candidate is obviously newer", () => {
  const result = resolveInboundThread({
    alias: null,
    sender_candidates: [
      { ...OPP_A, last_activity_at: "2026-09-08T18:00:00Z" },
      { ...OPP_B, last_activity_at: "2024-01-01T00:00:00Z" },
    ],
  });
  assert.equal(result.status, RESOLUTION_STATUS.AMBIGUOUS,
    "'the most recent one' is a guess dressed as logic");
});

test("every verdict carries its tier, reason and policy version", () => {
  for (const input of [
    { alias: { is_active: true, ...OPP_A } },
    { alias: null, header_matches: [OPP_A] },
    { alias: null, sender_candidates: [OPP_A, OPP_B] },
    { alias: null },
  ]) {
    const result = resolveInboundThread(input);
    assert.ok(result.tier, "a verdict with no tier cannot be explained later");
    assert.ok(result.reason);
    assert.equal(result.policy_version, "inbound_thread_resolution_v1");
  }
});

test("resolution is pure: the same evidence gives the same verdict", () => {
  const input = { alias: null, sender_candidates: [OPP_A] };
  assert.deepEqual(resolveInboundThread(input), resolveInboundThread(input));
});
