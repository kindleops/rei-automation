import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  persistActiveOffer,
  recordSellerCounter,
  acceptActiveOffer,
  loadActiveOffer,
  loadAcceptedOffer,
  buildOfferId,
  buildOfferTermsHash,
  OFFER_STATUS,
  MONETARY_OFFER_USE_CASES,
} from "@/lib/domain/seller-flow/seller-offer-authority.js";
import { resolveAuthorizedOfferAmount } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { resolveCanonicalTerms } from "@/lib/domain/closings/create-closing-case-from-acceptance.js";

// Canonical Seller Offer Term Authority.
//   calculated offer -> persisted ACTIVE offer -> SMS renders the SAME price
//   -> seller acceptance -> accepted terms persisted -> closing_case gets the
//   identical terms.
// Plus: counter chronology, stale/unrelated acceptance rejection, replay
// idempotency, and proof that neither corrupt asking_price nor
// recommended_offer can become the accepted price.

const OPP = "11111111-1111-4111-8111-111111111111";
const THREAD = "+15550100777";

// In-memory stand-in enforcing the DB's real constraints (one active, one
// accepted, unique version, unique acceptance event).
function makeSupabase() {
  const state = { offers: [], opportunities: [{ id: OPP }] };
  function from(name) {
    const q = { f: {}, order: null };
    const api = {
      select: () => api,
      eq(c, v) { q.f[c] = v; return api; },
      order(c, o) { q.order = { c, asc: o?.ascending !== false }; return api; },
      limit: async () => ({ data: rows(), error: null }),
      async maybeSingle() { return { data: rows()[0] || null, error: null }; },
      insert(row) {
        if (name === "seller_offers") {
          if (state.offers.some((o) => o.offer_id === row.offer_id))
            return { select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "23505", message: "duplicate offer_id" } }) }) };
          if (state.offers.some((o) => o.opportunity_id === row.opportunity_id && o.offer_version === row.offer_version))
            return { select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "23505", message: "duplicate version" } }) }) };
          if (row.status === OFFER_STATUS.ACTIVE && state.offers.some((o) => o.opportunity_id === row.opportunity_id && o.status === OFFER_STATUS.ACTIVE))
            return { select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "23505", message: "one active offer" } }) }) };
          const created = { created_at: new Date().toISOString(), ...row };
          state.offers.push(created);
          return { select: () => ({ maybeSingle: async () => ({ data: created, error: null }) }) };
        }
        return Promise.resolve({ error: null });
      },
      update(patch) {
        const u = {
          _f: {},
          eq(c, v) { this._f[c] = v; return this; },
          select() { return this; },
          async maybeSingle() { return { data: apply(this._f)[0] || null, error: null }; },
          then(resolve) { apply(this._f); return Promise.resolve({ error: null }).then(resolve); },
        };
        function apply(f) {
          const src = name === "seller_offers" ? state.offers : state.opportunities;
          const hits = src.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v));
          // enforce unique acceptance_event_id
          if (patch.acceptance_event_id) {
            const clash = state.offers.find(
              (o) => o.acceptance_event_id === patch.acceptance_event_id && !hits.includes(o)
            );
            if (clash) return [];
          }
          hits.forEach((r) => Object.assign(r, patch));
          return hits;
        }
        return u;
      },
    };
    function rows() {
      const src = name === "seller_offers" ? state.offers : state.opportunities;
      let out = src.filter((r) => Object.entries(q.f).every(([k, v]) => r[k] === v));
      if (q.order) out = [...out].sort((a, b) => (q.order.asc ? 1 : -1) * ((a[q.order.c] ?? 0) - (b[q.order.c] ?? 0)));
      return out;
    }
    return api;
  }
  return { from, _state: state };
}

const base = (over = {}) => ({
  opportunity_id: OPP, thread_key: THREAD, property_id: "prop-1",
  master_owner_id: "owner-1", purchase_price: 250000, offer_type: "initial_offer",
  ...over,
});

// ── 1) calculated offer -> persisted active offer -> SMS renders same price ──

test("the SMS price and the persisted offer price come from ONE resolver", async () => {
  // This is the invariant: the {{offer_price}} token and the persisted offer
  // both derive from resolveAuthorizedOfferAmount(dealAuthority).
  const authority = { authorized_offer_amount: 250000, authorized_offer_ceiling: 300000, recommended_offer: 240000 };
  const sent_amount = resolveAuthorizedOfferAmount(authority);
  assert.equal(sent_amount, 250000, "strategy-authorized amount wins over the recommendation");

  const supabase = makeSupabase();
  const r = await persistActiveOffer(base({ purchase_price: sent_amount, recommended_offer: 240000, authorized_ceiling: 300000, supabase }));
  assert.equal(r.ok, true);
  assert.equal(r.purchase_price, sent_amount, "persisted offer == amount in the SMS");
  assert.equal(r.offer_version, 1);
  assert.equal(r.offer_id, buildOfferId(OPP, 1));

  const stored = supabase._state.offers[0];
  assert.equal(stored.status, OFFER_STATUS.ACTIVE);
  assert.equal(stored.recommended_offer, 240000, "lineage recorded separately from the price");
  assert.notEqual(stored.purchase_price, stored.recommended_offer, "price is NOT the recommendation");
  assert.ok(stored.terms_hash, "terms hash persisted");
  assert.equal(stored.closing_date, null, "no closing term invented");
  assert.equal(stored.emd_amount, null, "no EMD invented");
});

test("an amount above the authorized ceiling is refused (never sent, never persisted)", async () => {
  assert.equal(resolveAuthorizedOfferAmount({ authorized_offer_amount: 400000, authorized_offer_ceiling: 300000 }), null);
  const supabase = makeSupabase();
  const r = await persistActiveOffer(base({ purchase_price: 0, supabase }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_offer_price");
  assert.equal(supabase._state.offers.length, 0);
});

test("offer use cases that carry money are the ones gated by the authority", () => {
  for (const uc of ["initial_offer", "counter_offer", "final_offer"]) {
    assert.ok(MONETARY_OFFER_USE_CASES.has(uc), `${uc} must be gated`);
  }
  assert.equal(MONETARY_OFFER_USE_CASES.has("ownership_check"), false, "non-monetary is not gated");
});

// ── 2) counters: durable, versioned, chronological ───────────────────────────

test("a seller counter is a NEW version; history is never overwritten", async () => {
  const supabase = makeSupabase();
  await persistActiveOffer(base({ supabase }));
  const counter = await recordSellerCounter({
    opportunity_id: OPP, thread_key: THREAD, counter_price: 265000,
    source_message_event_id: "evt-counter-1", supabase,
  });

  assert.equal(counter.ok, true);
  assert.equal(counter.offer_version, 2, "monotonic version");
  assert.equal(supabase._state.offers.length, 2, "the original offer still exists");

  const v1 = supabase._state.offers.find((o) => o.offer_version === 1);
  const v2 = supabase._state.offers.find((o) => o.offer_version === 2);
  assert.equal(v1.status, OFFER_STATUS.SUPERSEDED, "prior proposal superseded, not deleted");
  assert.equal(v1.purchase_price, 250000, "history preserved intact");
  assert.equal(v1.superseded_by_offer_id, v2.offer_id, "supersession is traceable");
  assert.equal(v2.status, OFFER_STATUS.ACTIVE);
  assert.equal(v2.direction, "inbound", "a counter is inbound");
  assert.equal(v2.purchase_price, 265000);

  const active = await loadActiveOffer({ opportunity_id: OPP, supabase });
  assert.equal(active.offer_version, 2, "latest counter is the active proposal");
});

test("a counter with no parsed price is refused (no guessing a number)", async () => {
  const supabase = makeSupabase();
  await persistActiveOffer(base({ supabase }));
  const r = await recordSellerCounter({ opportunity_id: OPP, thread_key: THREAD, counter_price: null, supabase });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_counter_price");
});

// ── 3) acceptance binds to the EXACT active offer ────────────────────────────

test("acceptance binds to the active offer and persists the full accepted terms", async () => {
  const supabase = makeSupabase();
  const offer = await persistActiveOffer(base({ supabase }));
  supabase._state.offers[0].sent_at = "2026-08-30T10:00:00.000Z";

  const acc = await acceptActiveOffer({
    opportunity_id: OPP, acceptance_event_id: "evt-yes-1",
    acceptance_at: "2026-08-30T11:00:00.000Z", supabase,
  });

  assert.equal(acc.accepted, true);
  assert.equal(acc.offer_id, offer.offer_id, "accepted offer id");
  assert.equal(acc.offer_version, 1, "accepted offer version");
  assert.equal(acc.accepted_price, 250000, "accepted purchase price");
  assert.equal(acc.terms_hash, offer.terms_hash, "immutable terms hash carried through");
  assert.equal(acc.accepted_at, "2026-08-30T11:00:00.000Z");
  const stored = supabase._state.offers[0];
  assert.equal(stored.status, OFFER_STATUS.ACCEPTED);
  assert.equal(stored.acceptance_event_id, "evt-yes-1", "acceptance message id persisted");
});

test("the LATEST counter is what gets accepted, not the original offer", async () => {
  const supabase = makeSupabase();
  await persistActiveOffer(base({ supabase }));
  await recordSellerCounter({ opportunity_id: OPP, thread_key: THREAD, counter_price: 265000, supabase });

  const acc = await acceptActiveOffer({ opportunity_id: OPP, acceptance_event_id: "evt-yes-2", supabase });
  assert.equal(acc.accepted, true);
  assert.equal(acc.accepted_price, 265000, "the current negotiated number is accepted");
  assert.equal(acc.offer_version, 2);
});

test("a STALE yes naming a superseded offer is REJECTED", async () => {
  const supabase = makeSupabase();
  const v1 = await persistActiveOffer(base({ supabase }));
  await recordSellerCounter({ opportunity_id: OPP, thread_key: THREAD, counter_price: 265000, supabase });

  const stale = await acceptActiveOffer({
    opportunity_id: OPP, acceptance_event_id: "evt-stale",
    expected_offer_id: v1.offer_id, supabase,
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, "stale_offer_acceptance");
  assert.equal(supabase._state.offers.find((o) => o.offer_version === 1).status, OFFER_STATUS.SUPERSEDED);
});

test("a yes that PREDATES the offer cannot accept it (chronology enforced)", async () => {
  const supabase = makeSupabase();
  await persistActiveOffer(base({ supabase }));
  supabase._state.offers[0].sent_at = "2026-08-30T12:00:00.000Z";

  const early = await acceptActiveOffer({
    opportunity_id: OPP, acceptance_event_id: "evt-early",
    acceptance_at: "2026-08-30T09:00:00.000Z", supabase,
  });
  assert.equal(early.accepted, false);
  assert.equal(early.reason, "acceptance_predates_offer");
});

test("an UNRELATED yes with no active offer accepts nothing", async () => {
  const supabase = makeSupabase();
  const r = await acceptActiveOffer({ opportunity_id: OPP, acceptance_event_id: "evt-unrelated", supabase });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "no_active_offer", "a bare yes is not acceptance in isolation");
});

test("REPLAY of the same acceptance cannot accept twice", async () => {
  const supabase = makeSupabase();
  await persistActiveOffer(base({ supabase }));
  const first = await acceptActiveOffer({ opportunity_id: OPP, acceptance_event_id: "evt-dup", supabase });
  const second = await acceptActiveOffer({ opportunity_id: OPP, acceptance_event_id: "evt-dup", supabase });

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "duplicate_acceptance");
  assert.equal(supabase._state.offers.filter((o) => o.status === OFFER_STATUS.ACCEPTED).length, 1);
});

// ── 4) closing case receives the IDENTICAL accepted terms ────────────────────

test("closing case terms come from the accepted offer, identical to what was sent", async () => {
  const supabase = makeSupabase();
  const offer = await persistActiveOffer(base({ supabase }));
  const acc = await acceptActiveOffer({ opportunity_id: OPP, acceptance_event_id: "evt-yes-3", supabase });
  const accepted = await loadAcceptedOffer({ opportunity_id: OPP, supabase });

  const terms = resolveCanonicalTerms({
    opportunity: { id: OPP, primary_property_id: "prop-1", property_address_full: "1 Main St", primary_thread_key: THREAD },
    accepted_offer: accepted,
  });

  assert.equal(terms.ok, true);
  assert.equal(terms.terms.seller_contract_price, 250000, "contract price == sent price == accepted price");
  assert.equal(terms.terms.seller_contract_price, offer.purchase_price);
  assert.equal(terms.terms.seller_contract_price, acc.accepted_price);
  assert.equal(terms.terms.accepted_offer_id, offer.offer_id, "offer identity carried to the contract");
  assert.equal(terms.terms.accepted_offer_version, 1);
  assert.equal(terms.terms.acceptance_event_id, "evt-yes-3");
  assert.equal(terms.terms.offer_terms_hash, offer.terms_hash);
  // No policy exists, so these are honestly null rather than invented:
  assert.equal(terms.terms.scheduled_closing_date, null);
  assert.equal(terms.terms.earnest_money, null);
});

test("NO accepted offer -> no contract (fails closed)", () => {
  const r = resolveCanonicalTerms({ opportunity: { id: OPP }, accepted_offer: null });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_accepted_offer");
});

test("recommended_offer can NEVER become the accepted contract price", () => {
  // An opportunity carrying only a recommendation, with no accepted offer.
  const r = resolveCanonicalTerms({
    opportunity: { id: OPP, recommended_offer: 32800, current_offer: 0 },
    accepted_offer: null,
  });
  assert.equal(r.ok, false, "recommendation lineage is not an agreed term");
  assert.equal(r.reason, "no_accepted_offer");
});

test("corrupt asking_price can NEVER contaminate the accepted price", async () => {
  const supabase = makeSupabase();
  await persistActiveOffer(base({ supabase }));
  await acceptActiveOffer({ opportunity_id: OPP, acceptance_event_id: "evt-yes-4", supabase });
  const accepted = await loadAcceptedOffer({ opportunity_id: OPP, supabase });

  // Production carries corrupted asking_price values such as 2, 4, 331.
  const terms = resolveCanonicalTerms({
    opportunity: { id: OPP, asking_price: 331, recommended_offer: 25400, current_offer: 0 },
    accepted_offer: accepted,
  });
  assert.equal(terms.terms.seller_contract_price, 250000, "the accepted offer wins");
  assert.notEqual(terms.terms.seller_contract_price, 331);
  assert.notEqual(terms.terms.seller_contract_price, 25400);
});

test("terms hash changes when a contract-bearing term changes", () => {
  const a = buildOfferTermsHash({ opportunity_id: OPP, purchase_price: 250000 });
  assert.equal(a, buildOfferTermsHash({ opportunity_id: OPP, purchase_price: 250000 }));
  assert.notEqual(a, buildOfferTermsHash({ opportunity_id: OPP, purchase_price: 265000 }));
  assert.notEqual(a, buildOfferTermsHash({ opportunity_id: OPP, purchase_price: 250000, emd_amount: 5000 }));
});
