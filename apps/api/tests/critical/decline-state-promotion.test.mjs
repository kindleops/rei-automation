/**
 * decline-state-promotion.test.mjs
 *
 * inbound-intent-ontology.js declares the durable outcome of every intent. For
 * not_interested that is disposition="not_interested", operational_status=
 * "paused", automation="pause". Nothing consumed it -- `state_hints` had ZERO
 * references outside its own file -- so 44 sellers who said "Not selling" kept
 * disposition = null and read as live leads everywhere except the send gate.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveIntentStatePromotion } from "../../src/lib/domain/lead-state/resolve-intent-state-promotion.js";
import { detectSaleDecline } from "../../src/lib/domain/classification/detect-sale-decline.js";

const promote = (intent, body, currentDisposition = null) =>
  resolveIntentStatePromotion({ intent, body, currentDisposition });

// ── declines become durable ─────────────────────────────────────────────────

test("1-3. English declines promote to a durable decline", () => {
  for (const body of ["Not selling", "It's not for sale", "I'm not looking to sell."]) {
    const r = promote("not_interested", body);
    assert.equal(r.patch.disposition, "not_interested", `"${body}"`);
    assert.equal(r.patch.operational_status, "paused");
    assert.equal(r.patch.automation, "pause");
  }
});

test("4. a Spanish decline promotes to a durable decline", () => {
  for (const body of ["No está de venta", "No la vendo", "no esta en venta"]) {
    const r = promote(null, body);
    assert.equal(r.patch.disposition, "not_interested", `"${body}"`);
  }
});

test("5. \"Si, pero no esta de venta\" keeps ownership AND records the decline", () => {
  // The exact production message. Classified ownership_confirmed because the
  // leading "Si" answered the ownership question; the refusal was dropped.
  const r = promote("ownership_confirmed", "Si, pero no esta de venta!");
  assert.equal(r.patch.disposition, "not_interested", "the refusal must win");
  assert.equal(r.patch.ownership_claim, "confirmed", "the ownership fact must survive");
  assert.equal(r.reason, "compound_ownership_confirmed_with_sale_decline");
  assert.equal(r.facts.compound_message, true);
});

test("accented and unaccented Spanish are treated identically", () => {
  const a = detectSaleDecline("Sí, pero no está de venta");
  const b = detectSaleDecline("Si, pero no esta de venta");
  assert.equal(a.declined, b.declined);
  assert.equal(a.ownership_affirmed, b.ownership_affirmed);
  assert.equal(a.compound, true);
});

test("more compound forms keep both facts", () => {
  for (const body of ["Sí es mía, pero no la vendo", "Yes I do, but it's not for sale"]) {
    const r = promote("ownership_confirmed", body);
    assert.equal(r.patch.disposition, "not_interested", `"${body}"`);
    assert.equal(r.patch.ownership_claim, "confirmed");
  }
});

// ── decline is not DNC ──────────────────────────────────────────────────────

test("6. a decline NEVER becomes suppression", () => {
  const r = promote("not_interested", "Not selling");
  assert.equal(r.patch.disposition, "not_interested");
  for (const forbidden of ["suppressed", "dnc", "opt_out", "do_not_contact"]) {
    assert.notEqual(r.patch.disposition, forbidden);
  }
  assert.equal("suppression" in r.patch, false);
  assert.equal("opt_out" in r.patch, false);
});

test("7. STOP promotes to the opt-out outcome, distinguishable from a decline", () => {
  const stop = promote("opt_out", "STOP");
  const decline = promote("not_interested", "Not selling");
  assert.ok(stop.patch, "opt_out must still produce durable state");

  // FINDING, recorded rather than papered over: the ontology gives opt_out and
  // not_interested the SAME disposition, despite its own header saying never
  // to conflate them. `automation` is the field that actually separates a
  // legal prohibition from a commercial refusal.
  assert.equal(stop.patch.automation, "stop");
  assert.equal(decline.patch.automation, "pause");
  assert.notEqual(stop.patch.automation, decline.patch.automation);
});

test("8. a bare asking price is NOT a decline", () => {
  for (const body of ["150k", "I do. 430k cash offer", "$160k as-is"]) {
    assert.equal(detectSaleDecline(body).declined, false, `"${body}"`);
  }
  const r = promote("asking_price", "150k");
  assert.notEqual(r.patch?.disposition, "not_interested");
});

test("a plain ownership confirmation is not a decline", () => {
  const r = promote("ownership_confirmed", "Yes, I do");
  assert.notEqual(r.patch?.disposition, "not_interested");
  assert.equal(detectSaleDecline("Yes, I do").declined, false);
});

// ── reopening ───────────────────────────────────────────────────────────────

test("9. a declined seller who re-engages becomes actionable again", () => {
  const r = promote("asking_price", "Actually, what would you offer?", "not_interested");
  assert.equal(r.patch.disposition, "none");
  assert.equal(r.patch.operational_status, "active_communication");
  assert.equal(r.reason, "reopened_by_seller_interest");
});

test("10. sale-interest language does NOT reopen a suppressed contact", () => {
  // Reopening is keyed on disposition='not_interested' only. A compliance state
  // is not this module's to clear, and it never emits one either.
  const r = promote("asking_price", "what's your offer?", "suppressed");
  assert.notEqual(r.reason, "reopened_by_seller_interest");
  assert.notEqual(r.patch?.disposition, "none");
});

// ── downstream consequences ─────────────────────────────────────────────────

test("11. a canonically declined seller is FUS2 ineligible", async () => {
  const { resolveFollowUpEligibility } = await import(
    "../../src/lib/domain/inbox/resolve-followup-eligibility.js"
  );
  const r = resolveFollowUpEligibility({
    thread_key: "+15550001111",
    messages: [{ direction: "inbound", body: "Not selling", intent: "not_interested" }],
    salutation: { name: "Sam", needs_review: false },
  });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "seller_explicit_decline");
});

test("12. the promoted state pauses automation, which is what drops stale Priority", () => {
  const r = promote("not_interested", "Not selling");
  assert.equal(r.patch.operational_status, "paused");
  assert.equal(r.patch.lead_temperature, "cold");
  assert.equal(r.patch.automation, "pause");
});

test("13. existing seller facts are preserved, not overwritten", () => {
  const r = promote("ownership_confirmed", "Si, pero no esta de venta!");
  // The patch is additive: it names disposition/status/ownership and says
  // nothing about price, address, agent or any other established fact.
  const keys = Object.keys(r.patch).sort();
  assert.deepEqual(keys, ["automation", "disposition", "lead_temperature", "operational_status", "ownership_claim"]);
});

test("14. no closing or transaction semantics are touched", () => {
  const r = promote("not_interested", "Not selling");
  for (const forbidden of ["acquisition_stage", "closing_stage", "contract_status", "opportunity_status"]) {
    assert.equal(forbidden in r.patch, false, `${forbidden} must not be written by a decline`);
  }
});

test("an unknown intent with no decline text produces no patch", () => {
  const r = promote(null, "ok thanks");
  assert.equal(r.patch, null);
});
