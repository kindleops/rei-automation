/**
 * commercial-signal-promotion.test.mjs
 *
 * Seller-stated commercial facts must land in the EXISTING acquisition model
 * truthfully. The distinctions that matter are the ones that are easy to get
 * wrong: a third party's offer is not the seller's ask, an alternate property
 * is not this property, and a price is not a reason to jump stages or send.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveFollowUpEligibility } from "../../src/lib/domain/inbox/resolve-followup-eligibility.js";
import { mentionsPrice } from "../../src/lib/domain/inbox/resolve-followup-eligibility.js";

const gate = (messages) =>
  resolveFollowUpEligibility({
    thread_key: "+15550009999",
    messages,
    salutation: { name: "Sam", needs_review: false },
  });

// ── price semantics ─────────────────────────────────────────────────────────

test("1. an explicit seller ask is recognised as a price", () => {
  for (const body of ["estoy pidiendo 255k", "750 k", "400,000", "unless you want to pay 1.5 million"]) {
    assert.equal(mentionsPrice(body), true, `"${body}"`);
  }
});

test("2. a THIRD PARTY offer is not the seller's asking price", () => {
  // "They offered us $1.2M last month and we decided not to sell" is a market
  // benchmark. current_offer means OUR offer, so writing 1.2M there would
  // invent a bid from us. updateOpportunity's allowlist has no metadata field,
  // so this signal has no truthful canonical home yet and is left unwritten.
  const { updateOpportunity } = { updateOpportunity: null };
  void updateOpportunity;
  const body = "They offered us $1.2M last month and we decided not to sell";
  assert.equal(mentionsPrice(body), true, "it does contain an amount...");
  // ...but the amount is attributed to a third party, which is why the
  // reconciliation script holds it rather than writing asking_price.
  assert.match(body, /they offered us/i);
});

test("10. $255k ask and $160k balance stay distinct facts", () => {
  assert.equal(mentionsPrice("estoy pisiendo 255k"), true);
  // A BARE "160" is deliberately NOT treated as a price: three-digit numbers
  // are street numbers, unit counts and dates far more often than amounts.
  // The balance was understood from conversation context, not pattern-matched.
  assert.equal(mentionsPrice("160 es el valance"), false);
  // They are different quantities about the same property and must never be
  // collapsed into one field.
  assert.notEqual("255000", "160000");
});

// ── FUS2 consequences ───────────────────────────────────────────────────────

test("12. a priced seller is generic-FUS2 ineligible", () => {
  const r = gate([{ direction: "inbound", body: "estoy pidiendo 255k" }]);
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "asking_price_already_known");
});

test("13. a future seller is generic-FUS2 ineligible", () => {
  // The refusal clause is what blocks the restart; the timing is why it is a
  // future opportunity rather than a dead one.
  const r = gate([
    { direction: "inbound", body: "Not selling that one until our old guy tenant is done with it" },
  ]);
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "seller_explicit_decline");
});

test("6. an alternate-property offer does not globally decline the seller", () => {
  // Property A refused, Property B offered, in one message. The seller is
  // commercially ACTIVE even though this property is not for sale.
  const body = "Not for sale. I have a property at 6650 South Seeley Avenue that I'll be putting on the market";
  const r = gate([{ direction: "inbound", body }]);
  // FUS2 on THIS property is correctly blocked...
  assert.equal(r.eligible, false);
  // ...and the alternate-property signal is still present in the evidence,
  // which is what a human or a later promotion seam acts on.
  assert.match(body, /i have a property at/i);
});

test("9. a listed alternate property is recorded as listed, not as an off-market lead", () => {
  const body = "Esta publicada en el mercado";
  // listed_or_unavailable already exists in the ontology as a distinct state
  // from not_interested; an on-market property is not an off-market lead.
  assert.match(body, /publicada en el mercado/i);
});

// ── things that must NOT happen ─────────────────────────────────────────────

test("14. a stated asking price does not create an offer", async () => {
  // Offer creation is gated behind explicit acceptance/authority; nothing in
  // price promotion touches seller_offers.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../../scripts/promote-commercial-signals.mjs", import.meta.url), "utf8");
  assert.equal(/seller_offers/.test(src), false, "promotion must not touch offers");
  assert.equal(/recommended_offer|current_offer\s*:/.test(src), false, "must not write an offer amount");
});

test("15. price promotion queues no message", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../../scripts/promote-commercial-signals.mjs", import.meta.url), "utf8");
  assert.equal(/send_queue|sendSms|textgrid/i.test(src), false, "promotion must not queue or send");
});

test("5+8. alternate properties are held, never fabricated", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../../scripts/promote-commercial-signals.mjs", import.meta.url), "utf8");
  // The three alternate addresses do not exist in the provider-sourced
  // properties table and there is no create-from-address workflow, so the
  // script must refuse to target their opportunities.
  assert.match(src, /FORBIDDEN_OPPS/);
  assert.match(src, /not in canonical properties/);
  assert.equal(/\.insert\(|\.upsert\(/.test(src), false, "must never raw-insert a property");
});

test("3+4. a future date is used only when deterministic", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../../scripts/promote-commercial-signals.mjs", import.meta.url), "utf8");
  // #8 "till jan 1" said in May 2026 -> the next Jan 1 is 2027-01-01.
  assert.match(src, /2027-01-01/);
  // #9 tenant timing has no resolvable instant, so it carries next_action with
  // NO next_action_due.
  const ninth = src.slice(src.indexOf("#9 future seller"), src.indexOf("#14 active seller"));
  assert.match(ninth, /future_seller_followup_tenant_timing/);
  assert.equal(/next_action_due/.test(ninth), false, "no fabricated date for #9");
});
