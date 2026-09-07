/**
 * followup-eligibility-and-identity.test.mjs
 *
 * Built from a real production near-miss: a bulk batch queued "would you be
 * open to talking numbers?" to ten sellers who had already answered that
 * question -- four with an explicit refusal, two with a price, two after we had
 * already made an offer -- plus three addressed by the wrong name, one of them
 * a limited company greeted as "D".
 *
 * Every case below is one of those real threads.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveFollowUpEligibility } from "../../src/lib/domain/inbox/resolve-followup-eligibility.js";
import {
  resolveSellerSalutation,
  isEntityName,
  isMultiOwnerName,
} from "../../src/lib/domain/inbox/resolve-seller-salutation.js";

const msg = (direction, body, intent) => ({ direction, body, intent: intent ?? null });
const evidence = (over = {}) => ({
  thread_key: "+15550001111",
  is_suppressed: false,
  opt_out: false,
  wrong_number: false,
  messages: [],
  salutation: { name: "Sam", needs_review: false },
  ...over,
});

// ── declines ────────────────────────────────────────────────────────────────

test("1. \"Not selling\" makes FUS2 ineligible", () => {
  const r = resolveFollowUpEligibility(evidence({
    messages: [msg("outbound", "Do you still own 113 Shore Dr?"), msg("inbound", "Not selling", "not_interested")],
  }));
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "seller_explicit_decline");
});

test("2. \"It's not for sale\" makes FUS2 ineligible", () => {
  const r = resolveFollowUpEligibility(evidence({
    messages: [msg("inbound", "It's not for sale", "not_interested")],
  }));
  assert.equal(r.reason, "seller_explicit_decline");
});

test("3. a Spanish decline the CLASSIFIER MISSED is still caught", () => {
  // Real row: "Si, pero no esta de venta!" was classified ownership_confirmed
  // because the leading "Si" read as confirmation. Text is the backstop.
  const r = resolveFollowUpEligibility(evidence({
    messages: [msg("inbound", "Si, pero no esta de venta!", "ownership_confirmed")],
  }));
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "seller_explicit_decline");
});

test("a tenant respondent is a decline, not a lead", () => {
  const r = resolveFollowUpEligibility(evidence({
    messages: [msg("inbound", "Nope, have great long-term tenants...", "tenant_respondent")],
  }));
  assert.equal(r.reason, "seller_explicit_decline");
});

// ── price / offer ───────────────────────────────────────────────────────────

test("4. a seller who already named a price is ineligible for a generic restart", () => {
  for (const body of ["150k", "I do. 430k cash offer", "$160k as-is", "70 mil"]) {
    const r = resolveFollowUpEligibility(evidence({ messages: [msg("inbound", body)] }));
    assert.equal(r.eligible, false, `"${body}" should block`);
    assert.equal(r.reason, "asking_price_already_known");
  }
});

test("5. a thread where WE already made an offer is ineligible", () => {
  const r = resolveFollowUpEligibility(evidence({
    messages: [
      msg("inbound", "is this about the house?"),
      msg("outbound", "I could offer $68K, closing in 7 days."),
    ],
  }));
  assert.equal(r.reason, "offer_already_presented");
});

test("a street number or ZIP is never mistaken for a price", () => {
  const r = resolveFollowUpEligibility(evidence({
    messages: [msg("inbound", "yes that's me at 5005 1/2 Larkspur St, Houston, Tx 77033")],
  }));
  assert.equal(r.eligible, true, "addresses must not read as prices");
});

// ── decline is not DNC ──────────────────────────────────────────────────────

test("6. a decline is NOT treated as a regulatory opt-out", () => {
  const decline = resolveFollowUpEligibility(evidence({
    messages: [msg("inbound", "I'm not looking to sell.", "not_interested")],
  }));
  const optOut = resolveFollowUpEligibility(evidence({
    messages: [msg("inbound", "STOP", "opt_out")],
  }));
  assert.equal(decline.reason, "seller_explicit_decline");
  assert.equal(optOut.reason, "dnc_or_opt_out");
  assert.notEqual(decline.reason, optOut.reason, "these must never collapse into one state");
});

// ── identity ────────────────────────────────────────────────────────────────

test("7. Tammy stays Tammy", () => {
  const r = resolveSellerSalutation({
    ownerName: "Randy & Tammy Reid",
    outboundBodies: ["Hi Tammy, this is Scott. Do you still own 113 Shore Dr?"],
  });
  assert.equal(r.name, "Tammy");
  assert.equal(r.source, "established_addressee");
});

test("8. Maricela stays Maricela", () => {
  const r = resolveSellerSalutation({
    ownerName: "Jose & Maricela Munoz",
    outboundBodies: ["Hola Maricela, soy Carmen. 8807 W Pierson St es tu propiedad?"],
  });
  assert.equal(r.name, "Maricela");
});

test("9. a limited company NEVER becomes a first name", () => {
  const r = resolveSellerSalutation({ ownerName: "D & S LLC", outboundBodies: [] });
  assert.equal(r.name, null, 'must never render "D"');
  assert.equal(r.reason, "owner_is_legal_entity");
  assert.equal(r.needs_review, false, "neutral copy is a valid answer, not a review queue");
  assert.equal(isEntityName("D & S LLC"), true);
});

test("10. a company WITH a known human contact uses the human", () => {
  const r = resolveSellerSalutation({
    confirmedContactFirstName: "William",
    ownerName: "D & S LLC",
    outboundBodies: [],
  });
  assert.equal(r.name, "William");
  assert.equal(r.source, "confirmed_contact");
});

test("11. a company with NO known contact yields no name for neutral copy", () => {
  const r = resolveSellerSalutation({ ownerName: "Keystone Holdings LLC", outboundBodies: [] });
  assert.equal(r.name, null);
  const gate = resolveFollowUpEligibility(evidence({ salutation: r }));
  assert.equal(gate.eligible, true, "an entity is addressable with neutral copy");
});

test("a multi-owner household with NO history is held for review, never guessed", () => {
  const r = resolveSellerSalutation({ ownerName: "Randy & Tammy Reid", outboundBodies: [] });
  assert.equal(r.name, null, "taking the first token is what produced the Randy/Tammy flip");
  assert.equal(r.needs_review, true);
  const gate = resolveFollowUpEligibility(evidence({ salutation: r }));
  assert.equal(gate.reason, "contact_identity_unresolved");
});

test("6b. household resolution is STABLE across repeated sends", () => {
  const history = ["Hi Tammy, this is Scott. Do you still own 113 Shore Dr?"];
  const first = resolveSellerSalutation({ ownerName: "Randy & Tammy Reid", outboundBodies: history });
  const second = resolveSellerSalutation({
    ownerName: "Tammy & Randy Reid", // owner ordering changed upstream
    outboundBodies: history,
  });
  assert.equal(first.name, second.name, "the name must not oscillate with owner ordering");
});

test("conflicting prior salutations are reviewed, not re-guessed", () => {
  const r = resolveSellerSalutation({
    ownerName: "Randy & Tammy Reid",
    outboundBodies: ["Hi Tammy, quick question", "Hey Randy, following up"],
  });
  assert.equal(r.name, null);
  assert.equal(r.needs_review, true);
  assert.match(r.reason, /prior_salutations_disagree/);
});

// ── the clean case still works ──────────────────────────────────────────────

test("12. a genuinely silent seller remains ELIGIBLE", () => {
  const r = resolveFollowUpEligibility(evidence({
    messages: [
      msg("outbound", "Hi Sam, this is Dana. Do you still own 12 Oak St?"),
      msg("inbound", "Yes, I do", "ownership_confirmed"),
    ],
    salutation: { name: "Sam", needs_review: false },
  }));
  assert.equal(r.eligible, true);
  assert.equal(r.reason, null);
});

test("regulatory state outranks everything below it", () => {
  const r = resolveFollowUpEligibility(evidence({
    is_suppressed: true,
    messages: [msg("inbound", "150k")],
  }));
  assert.equal(r.reason, "dnc_or_opt_out", "suppression is checked before price");
});

test("isMultiOwnerName recognises household forms", () => {
  assert.equal(isMultiOwnerName("Randy & Tammy Reid"), true);
  assert.equal(isMultiOwnerName("Jose and Maricela Munoz"), true);
  assert.equal(isMultiOwnerName("David L Williams III"), false);
});
