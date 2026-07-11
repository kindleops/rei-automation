import test from "node:test";
import assert from "node:assert/strict";

import {
  extractSellerFacts,
  extractionToResolverFacts,
  SELLER_FACT_EXTRACTOR_VERSION,
} from "@/lib/domain/seller-flow/extract-seller-facts.js";
import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";

const NOW = "2026-07-11T12:00:00.000Z";
const MSG_ID = "evt-123";

function extract(message, options = {}) {
  return extractSellerFacts({ message, sourceMessageId: MSG_ID, now: NOW, ...options });
}

// ── Feature vs defect (spec: weak evidence extracts nothing) ─────────────────

test("extraction: property features never read as repairs", () => {
  const result = extract("The house has a roof and two bathrooms");
  assert.equal(result.facts.repairs, undefined);
  assert.equal(result.facts.condition, undefined);
  assert.equal(result.needs_review, false);
});

test("extraction: explicit defect extracts a repair item with evidence", () => {
  const result = extract("The roof leaks and needs replacement");
  const repairs = result.facts.repairs;
  assert.ok(repairs, "repair fact expected");
  assert.equal(repairs.value.repairs_needed, true);
  assert.ok(repairs.value.items.some((item) => item.item === "roof"));
  assert.equal(repairs.value.severity, "major");
  assert.ok(repairs.evidence_text.toLowerCase().includes("roof leaks"));
  assert.equal(repairs.source_message_id, MSG_ID);
  assert.equal(repairs.extractor_version, SELLER_FACT_EXTRACTOR_VERSION);
});

test("extraction: 'I work nights' is a schedule, not property work", () => {
  const result = extract("I work nights so texting is best");
  assert.equal(result.facts.repairs, undefined);
});

test("extraction: 'that offer could work' is not a repair", () => {
  const result = extract("That offer could work for me");
  assert.equal(result.facts.repairs, undefined);
});

test("extraction: explicit no-repairs claim extracts good condition", () => {
  const result = extract("No repairs needed, it's move-in ready");
  const condition = result.facts.condition;
  assert.ok(condition);
  assert.equal(condition.value.repairs_needed, false);
  assert.equal(condition.value.condition_level, "good");
});

test("extraction: no-repairs claim plus defect evidence flags a conflict", () => {
  const result = extract("It's in good condition but the roof leaks pretty bad");
  assert.ok(result.facts.condition);
  assert.ok(result.facts.repairs);
  assert.equal(result.facts.condition.conflict, true);
  assert.equal(result.needs_review, true);
  assert.ok(result.conflicts.some((c) => c.field === "condition"));
});

// ── Ownership and authority claims ───────────────────────────────────────────

test("extraction: spouse liking the house is not a signer claim", () => {
  const result = extract("My wife likes the house a lot");
  assert.equal(result.facts.authority, undefined);
});

test("extraction: spouse on title creates additional-signer claim, never verified authority", () => {
  const result = extract("My wife is on title and must sign too");
  const authority = result.facts.authority;
  assert.ok(authority);
  assert.equal(authority.value.authority_verified, false);
  assert.equal(authority.value.can_execute_alone, false);
  assert.equal(authority.value.requires_authority_review, true);
  assert.ok(
    authority.value.additional_signers_claimed.some((s) => s.relationship === "spouse")
  );
  assert.equal(result.needs_review, true);
});

test("extraction: executor claim requires authority review and is not verified", () => {
  const result = extract("I am the executor of my mother's estate");
  const authority = result.facts.authority;
  assert.ok(authority);
  assert.equal(authority.value.authority_type, "executor");
  assert.equal(authority.value.authority_claimed, true);
  assert.equal(authority.value.authority_verified, false);
  assert.equal(authority.value.requires_authority_review, true);
});

test("extraction: trustee and POA claims extract as claims", () => {
  assert.equal(extract("I'm the trustee for the property").facts.authority.value.authority_type, "trustee");
  assert.equal(extract("I have power of attorney for my dad").facts.authority.value.authority_type, "poa");
});

test("extraction: 'I own it' confirms an ownership claim, not sole signing authority", () => {
  const result = extract("Yes I own it");
  assert.equal(result.facts.ownership.value.ownership_claim, "confirmed");
  // No authority fact is fabricated from a bare ownership claim.
  assert.equal(result.facts.authority, undefined);
});

test("extraction: contradictory ownership statements flag conflict + review", () => {
  const result = extract("I own it, well actually it's not mine anymore, I sold it");
  assert.equal(result.facts.ownership.value.ownership_claim, "contradictory");
  assert.equal(result.facts.ownership.conflict, true);
  assert.equal(result.needs_review, true);
});

// ── Asking price (delegated to monetary-understanding) ──────────────────────

test("extraction: explicit asking price carries evidence and provenance", () => {
  const result = extract("I want $120,000 for it");
  const price = result.facts.asking_price;
  assert.ok(price);
  assert.equal(price.value.amount, 120000);
  assert.equal(price.source_message_id, MSG_ID);
  assert.ok(price.evidence_text.includes("120,000"));
});

test("extraction: Spanish word-number 'ciento veinte mil' parses to 120000", () => {
  const signal = resolveAskingPriceSignal("Quiero ciento veinte mil por la casa");
  assert.equal(signal.asking_price?.value, 120000);
});

test("extraction: '120 mil' parses to 120000", () => {
  const signal = resolveAskingPriceSignal("I need 120 mil for the house");
  assert.equal(signal.asking_price?.value, 120000);
});

test("extraction: monthly rent amount is not an asking price", () => {
  const result = extract("The tenants pay $1,200 a month");
  assert.equal(result.facts.asking_price, undefined);
});

test("extraction: mortgage payoff amount is not an asking price", () => {
  const result = extract("I still owe $80,000 on the mortgage");
  assert.equal(result.facts.asking_price, undefined);
});

test("extraction: repair estimate amount is not an asking price", () => {
  const result = extract("I got a quote for $15,000 to fix the foundation");
  assert.equal(result.facts.asking_price, undefined);
});

test("extraction: ambiguous bare '120' never silently becomes asking_price", () => {
  const result = extract("120");
  const promoted = Boolean(result.facts.asking_price);
  const clarification = result.asking_price_needs_clarification === true;
  // Either the monetary layer refused the bare number entirely, or it asked
  // for clarification — silent promotion to a canonical price is forbidden.
  assert.equal(promoted && !clarification, false);
  if (result.facts.asking_price) {
    assert.ok(result.facts.asking_price.value.amount !== 120 || clarification);
  }
});

// ── Timeline / occupancy / listing / interest ───────────────────────────────

test("extraction: explicit timeline extracts urgency", () => {
  assert.equal(extract("I need to sell ASAP").facts.timeline.value.urgency, "immediate");
  assert.equal(extract("Maybe next year").facts.timeline.value.urgency, "long_term");
});

test("extraction: tenant occupancy extracts from explicit statement", () => {
  const result = extract("Tenants live there right now");
  assert.equal(result.facts.occupancy.value.occupancy_status, "tenant_occupied");
});

test("extraction: listed-with-agent extracts listing status", () => {
  const result = extract("It's already listed with an agent");
  assert.equal(result.facts.listing_status.value.listing_status, "listed_with_agent");
});

test("extraction: offer request extracts wants_offer", () => {
  const result = extract("Just make me an offer");
  assert.equal(result.facts.offer_interest.value.wants_offer, true);
});

test("extraction: explicit Spanish request records a language claim", () => {
  const result = extract("En español por favor");
  assert.equal(result.facts.language_claim.value.language, "Spanish");
});

// ── Resolver projection ──────────────────────────────────────────────────────

test("extractionToResolverFacts projects only resolver-relevant scalars", () => {
  const extraction = extract(
    "Yes I own it. Tenants live there, the roof leaks, and I need to sell this month."
  );
  const facts = extractionToResolverFacts(extraction);
  assert.equal(facts.extractor_version, SELLER_FACT_EXTRACTOR_VERSION);
  assert.equal(facts.occupancy_status, "tenant_occupied");
  assert.equal(facts.condition_disclosed, true);
  assert.ok(facts.repairs_summary.includes("roof"));
  assert.equal(facts.timeline, "soon");
  assert.equal(facts.ownership_claim_evidence.toLowerCase().includes("i own it"), true);
});

test("extraction: empty message extracts nothing", () => {
  const result = extract("");
  assert.deepEqual(result.facts, {});
  assert.equal(result.needs_review, false);
});
