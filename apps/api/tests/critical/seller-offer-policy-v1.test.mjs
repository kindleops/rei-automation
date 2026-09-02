import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  SELLER_OFFER_POLICY_V1,
  resolveNewOfferTerms,
  computeScheduledClosingDate,
  computeEmdDueDate,
  isBusinessDay,
  rollForwardToBusinessDay,
  assertContractComplete,
} from "@/lib/domain/seller-flow/seller-offer-policy.js";
import {
  persistActiveOffer,
  acceptActiveOffer,
  recordSellerCounter,
  loadAcceptedOffer,
  OFFER_STATUS,
} from "@/lib/domain/seller-flow/seller-offer-authority.js";
import { resolveCanonicalTerms } from "@/lib/domain/closings/create-closing-case-from-acceptance.js";

// SELLER_OFFER_POLICY_V1 wired into the durable offer authority:
//   new offer -> 14-day window + $1,000 EMD + 3 business-day EMD due
//   -> SMS and persisted offer carry identical terms
//   -> acceptance computes the exact closing date (weekend/holiday roll-forward)
//   -> closing case receives those terms exactly, or refuses creation.

const OPP = "11111111-1111-4111-8111-111111111111";
const THREAD = "+15550100888";

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
          if (row.status === OFFER_STATUS.ACTIVE && state.offers.some((o) => o.opportunity_id === row.opportunity_id && o.status === OFFER_STATUS.ACTIVE))
            return { select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "23505", message: "one active" } }) }) };
          // Deterministic offer-creation instant. acceptActiveOffer enforces
          // "acceptance must come after the offer was sent"; without a fixed
          // created_at this fixture used the real wall clock, so a hardcoded
          // acceptance_at of 2026-09-01T10:00Z began to PREDATE the freshly
          // created offer once the machine clock passed 10:00 UTC, flaking the
          // acceptance tests by time of day. Seeding a fixed past instant makes
          // the chronology guard deterministic (the sibling term-authority
          // suite pins sent_at for the same reason).
          const created = { created_at: "2026-08-01T00:00:00.000Z", ...row };
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

const newOffer = (supabase, over = {}) =>
  persistActiveOffer({
    opportunity_id: OPP, thread_key: THREAD, property_id: "prop-1",
    purchase_price: 250000, offer_type: "initial_offer", supabase, ...over,
  });

// ── policy defaults on every new offer ───────────────────────────────────────

test("policy V1 holds the authorized values in exactly one place", () => {
  assert.equal(SELLER_OFFER_POLICY_V1.closing_window_days, 14);
  assert.equal(SELLER_OFFER_POLICY_V1.earnest_money_amount, 1000);
  assert.equal(SELLER_OFFER_POLICY_V1.earnest_money_due_business_days, 3);
  assert.equal(SELLER_OFFER_POLICY_V1.policy_version, "v1");
});

test("a NEW offer defaults to a 14-day closing window", async () => {
  const supabase = makeSupabase();
  await newOffer(supabase);
  const o = supabase._state.offers[0];
  assert.equal(o.closing_window_days, 14);
  assert.equal(o.closing_term, "14_calendar_days_from_acceptance");
  assert.equal(o.policy_version, "v1");
});

test("a NEW offer defaults to $1,000 EMD due in 3 business days", async () => {
  const supabase = makeSupabase();
  await newOffer(supabase);
  const o = supabase._state.offers[0];
  assert.equal(o.emd_amount, 1000);
  assert.equal(o.emd_due_business_days, 3);
  assert.equal(o.emd_term, "3_business_days_from_acceptance");
});

test("the offer SMS and the persisted offer carry the same terms", async () => {
  // The executor renders {{offer_price}} from the same authority value it
  // persists; here we assert the persisted package matches what was proposed.
  const supabase = makeSupabase();
  const r = await newOffer(supabase, { purchase_price: 250000 });
  const o = supabase._state.offers[0];
  assert.equal(r.purchase_price, 250000);
  assert.equal(o.purchase_price, r.purchase_price, "sent price == persisted price");
  assert.equal(o.closing_window_days, SELLER_OFFER_POLICY_V1.closing_window_days);
  assert.equal(o.emd_amount, SELLER_OFFER_POLICY_V1.earnest_money_amount);
  assert.ok(o.terms_hash, "terms hash covers the whole package");
});

// ── closing-date computation ─────────────────────────────────────────────────

test("acceptance computes closing date = acceptance + 14 calendar days", () => {
  // 2026-09-01 is a Tuesday; +14 = 2026-09-15, also a Tuesday (business day).
  assert.equal(
    computeScheduledClosingDate({ accepted_at: "2026-09-01T10:00:00.000Z", closing_window_days: 14 }),
    "2026-09-15"
  );
});

test("weekend roll-forward: a Saturday landing rolls to Monday", () => {
  // 2026-09-05 + 14 = 2026-09-19, a Saturday -> rolls to Monday 2026-09-21.
  assert.equal(new Date("2026-09-19T00:00:00Z").getUTCDay(), 6, "target really is a Saturday");
  assert.equal(
    computeScheduledClosingDate({ accepted_at: "2026-09-05T10:00:00.000Z", closing_window_days: 14 }),
    "2026-09-21"
  );
});

test("holiday roll-forward: landing on Christmas rolls past it", () => {
  // 2026-12-11 + 14 = 2026-12-25 (Christmas, a Friday) -> next business day is
  // Monday 2026-12-28.
  assert.equal(isBusinessDay(new Date("2026-12-25T00:00:00Z")), false, "Christmas is not a business day");
  assert.equal(
    computeScheduledClosingDate({ accepted_at: "2026-12-11T10:00:00.000Z", closing_window_days: 14 }),
    "2026-12-28"
  );
});

test("business-day helpers behave", () => {
  assert.equal(isBusinessDay(new Date("2026-09-19T00:00:00Z")), false, "Saturday");
  assert.equal(isBusinessDay(new Date("2026-09-20T00:00:00Z")), false, "Sunday");
  assert.equal(isBusinessDay(new Date("2026-09-21T00:00:00Z")), true, "Monday");
  assert.equal(
    rollForwardToBusinessDay(new Date("2026-09-19T00:00:00Z")).toISOString().slice(0, 10),
    "2026-09-21"
  );
  // EMD due: 3 business days from Thursday 2026-09-03 -> Tuesday 2026-09-08
  // (Fri, Mon, Tue; Labor Day 2026-09-07 is skipped).
  assert.equal(
    computeEmdDueDate({ accepted_at: "2026-09-03T10:00:00.000Z", emd_due_business_days: 3 }),
    "2026-09-09"
  );
});

test("acceptance persists the computed closing date and EMD due date", async () => {
  const supabase = makeSupabase();
  await newOffer(supabase);
  const acc = await acceptActiveOffer({
    opportunity_id: OPP, acceptance_event_id: "evt-a1",
    acceptance_at: "2026-09-01T10:00:00.000Z", supabase,
  });
  assert.equal(acc.accepted, true);
  assert.equal(acc.closing_date, "2026-09-15", "exact date computed at acceptance");
  assert.equal(acc.closing_window_days, 14);
  assert.equal(acc.emd_amount, 1000);
  assert.equal(acc.emd_due_business_days, 3);
  assert.ok(acc.emd_due_date, "EMD due date computed");
  assert.equal(acc.contract_complete, true, "accepted offer is contract-complete");
  assert.deepEqual(acc.missing_contract_terms, []);
});

// ── negotiated overrides produce NEW versions ────────────────────────────────

test("a seller-negotiated closing window produces a NEW offer version", async () => {
  const supabase = makeSupabase();
  await newOffer(supabase);
  const v2 = await newOffer(supabase, { closing_window_days: 30, offer_type: "counter_offer" });

  assert.equal(v2.offer_version, 2, "a negotiated term is a new version, not a mutation");
  const [first, second] = supabase._state.offers;
  assert.equal(first.closing_window_days, 14, "the original 14-day term is untouched");
  assert.equal(first.status, OFFER_STATUS.SUPERSEDED);
  assert.equal(second.closing_window_days, 30);
  assert.notEqual(second.terms_hash, first.terms_hash, "different terms, different hash");
});

test("a seller-negotiated EMD produces a NEW offer version", async () => {
  const supabase = makeSupabase();
  await newOffer(supabase);
  const v2 = await newOffer(supabase, { emd_amount: 2500, offer_type: "counter_offer" });

  assert.equal(v2.offer_version, 2);
  assert.equal(supabase._state.offers[0].emd_amount, 1000, "history preserved");
  assert.equal(supabase._state.offers[1].emd_amount, 2500);
});

test("acceptance binds the CURRENT version's negotiated terms", async () => {
  const supabase = makeSupabase();
  await newOffer(supabase);
  await newOffer(supabase, { closing_window_days: 30, offer_type: "counter_offer" });

  const acc = await acceptActiveOffer({
    opportunity_id: OPP, acceptance_event_id: "evt-a2",
    acceptance_at: "2026-09-01T10:00:00.000Z", supabase,
  });
  assert.equal(acc.offer_version, 2);
  assert.equal(acc.closing_window_days, 30, "the negotiated window is what binds");
  // 2026-09-01 + 30 = 2026-10-01 (Thursday, a business day)
  assert.equal(acc.closing_date, "2026-10-01");
});

test("a STALE acceptance cannot accept an older term version", async () => {
  const supabase = makeSupabase();
  const v1 = await newOffer(supabase);
  await newOffer(supabase, { closing_window_days: 30, offer_type: "counter_offer" });

  const stale = await acceptActiveOffer({
    opportunity_id: OPP, acceptance_event_id: "evt-stale",
    expected_offer_id: v1.offer_id, supabase,
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, "stale_offer_acceptance");
});

test("duplicate acceptance remains idempotent", async () => {
  const supabase = makeSupabase();
  await newOffer(supabase);
  const first = await acceptActiveOffer({ opportunity_id: OPP, acceptance_event_id: "evt-dup", supabase });
  const second = await acceptActiveOffer({ opportunity_id: OPP, acceptance_event_id: "evt-dup", supabase });
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "duplicate_acceptance");
  assert.equal(supabase._state.offers.filter((o) => o.status === OFFER_STATUS.ACCEPTED).length, 1);
});

// ── closing case receives the terms exactly, or refuses ──────────────────────

const OPPORTUNITY = { id: OPP, primary_property_id: "prop-1", property_address_full: "1 Main St", primary_thread_key: THREAD };

test("closing case receives accepted price / date / EMD exactly", async () => {
  const supabase = makeSupabase();
  await newOffer(supabase);
  await acceptActiveOffer({
    opportunity_id: OPP, acceptance_event_id: "evt-c1",
    acceptance_at: "2026-09-01T10:00:00.000Z", supabase,
  });
  const accepted = await loadAcceptedOffer({ opportunity_id: OPP, supabase });

  const r = resolveCanonicalTerms({ opportunity: OPPORTUNITY, accepted_offer: accepted });
  assert.equal(r.ok, true);
  assert.equal(r.terms.seller_contract_price, 250000);
  assert.equal(r.terms.earnest_money, 1000, "EMD comes from the accepted offer");
  assert.equal(r.terms.scheduled_closing_date.slice(0, 10), "2026-09-15", "exact accepted date");
  assert.equal(r.terms.accepted_offer_version, 1);
  assert.equal(r.terms.acceptance_event_id, "evt-c1");
});

test("a missing contract-bearing term fails the closing case CLOSED", () => {
  const complete = {
    offer_id: "offer:x:v1", offer_version: 1, opportunity_id: OPP, thread_key: THREAD,
    purchase_price: 250000, closing_window_days: 14, closing_date: "2026-09-15",
    emd_amount: 1000, emd_due_business_days: 3, terms_hash: "h",
    acceptance_event_id: "e", accepted_at: "2026-09-01T10:00:00.000Z",
  };
  assert.equal(assertContractComplete(complete).ok, true);

  for (const field of ["purchase_price", "closing_date", "emd_amount", "closing_window_days", "emd_due_business_days"]) {
    const broken = { ...complete, [field]: null };
    const check = assertContractComplete(broken);
    assert.equal(check.ok, false, `${field} missing must fail`);
    assert.ok(check.missing.includes(field));

    const r = resolveCanonicalTerms({
      opportunity: OPPORTUNITY,
      accepted_offer: { ...broken, accepted_price: broken.purchase_price },
    });
    assert.equal(r.ok, false, `${field} missing must refuse the closing case`);
    assert.equal(r.reason, "incomplete_contract_terms");
  }
});

test("a ZERO EMD is treated as missing, never inferred", () => {
  const check = assertContractComplete({
    offer_id: "o", offer_version: 1, opportunity_id: OPP, thread_key: THREAD,
    purchase_price: 250000, closing_window_days: 14, closing_date: "2026-09-15",
    emd_amount: 0, emd_due_business_days: 3, terms_hash: "h",
    acceptance_event_id: "e", accepted_at: "2026-09-01T10:00:00.000Z",
  });
  assert.equal(check.ok, false);
  assert.ok(check.missing.includes("emd_amount"), "zero is not a valid EMD");
});

test("recommended_offer still cannot substitute for accepted price", () => {
  const r = resolveCanonicalTerms({
    opportunity: { ...OPPORTUNITY, recommended_offer: 32800, current_offer: 0 },
    accepted_offer: null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_accepted_offer");
});

test("overrides resolve through the policy, not scattered literals", () => {
  const d = resolveNewOfferTerms();
  assert.equal(d.closing_window_days, 14);
  assert.equal(d.earnest_money, 1000);
  assert.equal(d.emd_due_business_days, 3);

  const negotiated = resolveNewOfferTerms({
    overrides: { closing_window_days: 30, earnest_money: 2500, earnest_money_due_business_days: 5 },
  });
  assert.equal(negotiated.closing_window_days, 30);
  assert.equal(negotiated.earnest_money, 2500);
  assert.equal(negotiated.emd_due_business_days, 5);
  assert.equal(negotiated.policy_version, "v1", "still stamped with the policy that produced it");
});

// ── Final gate proofs (contract-complete before send; exact package on accept) ─

test("a newly generated offer carries ONE exact durable contract package before send", async () => {
  const supabase = makeSupabase();
  const r = await newOffer(supabase, { purchase_price: 250000 });
  const o = supabase._state.offers[0];

  // The complete pre-send package, asserted as one unit.
  assert.deepEqual(
    {
      purchase_price: o.purchase_price,
      closing_window_days: o.closing_window_days,
      emd_amount: o.emd_amount,
      emd_due_business_days: o.emd_due_business_days,
      policy_version: o.policy_version,
      has_terms_hash: Boolean(o.terms_hash),
    },
    {
      purchase_price: 250000,
      closing_window_days: 14,
      emd_amount: 1000,
      emd_due_business_days: 3,
      policy_version: "v1",
      has_terms_hash: true,
    }
  );
  // The value returned to the SEND path is the same package the DB holds, so
  // the SMS and the persisted offer cannot disagree.
  assert.equal(r.purchase_price, o.purchase_price);
  assert.equal(r.terms_hash, o.terms_hash);
});

test("acceptance materializes the exact contract-complete package", async () => {
  const supabase = makeSupabase();
  const offer = await newOffer(supabase);
  const before_hash = supabase._state.offers[0].terms_hash;

  const acc = await acceptActiveOffer({
    opportunity_id: OPP, acceptance_event_id: "evt-final",
    acceptance_at: "2026-09-01T10:00:00.000Z", supabase,
  });

  assert.equal(acc.accepted_price, 250000, "exact accepted purchase price");
  assert.equal(acc.offer_id, offer.offer_id, "exact accepted offer ID");
  assert.equal(acc.offer_version, 1, "exact accepted offer version");
  assert.equal(acc.accepted_at, "2026-09-01T10:00:00.000Z", "accepted_at persisted");
  assert.equal(acc.closing_date, "2026-09-15", "computed scheduled_closing_date");
  assert.equal(acc.emd_amount, 1000, "$1,000 EMD");
  assert.equal(acc.emd_due_business_days, 3, "3-business-day EMD due policy");
  assert.equal(acc.terms_hash, before_hash, "terms hash is IMMUTABLE through acceptance");
  assert.equal(acc.contract_complete, true);
});

test("an accepted offer cannot be silently mutated afterward", async () => {
  const supabase = makeSupabase();
  await newOffer(supabase);
  await acceptActiveOffer({
    opportunity_id: OPP, acceptance_event_id: "evt-lock",
    acceptance_at: "2026-09-01T10:00:00.000Z", supabase,
  });
  const accepted = supabase._state.offers[0];
  const snapshot = {
    price: accepted.accepted_price,
    date: accepted.closing_date,
    emd: accepted.emd_amount,
    hash: accepted.terms_hash,
  };

  // A later proposal must NOT rewrite the accepted terms: persistActiveOffer
  // only supersedes rows whose status is ACTIVE, and the accepted row is not.
  await newOffer(supabase, { purchase_price: 300000, closing_window_days: 30, offer_type: "counter_offer" });

  const still = supabase._state.offers.find((o) => o.acceptance_event_id === "evt-lock");
  assert.equal(still.status, OFFER_STATUS.ACCEPTED, "still accepted");
  assert.equal(still.accepted_price, snapshot.price, "accepted price unchanged");
  assert.equal(still.closing_date, snapshot.date, "accepted closing date unchanged");
  assert.equal(still.emd_amount, snapshot.emd, "accepted EMD unchanged");
  assert.equal(still.terms_hash, snapshot.hash, "accepted terms hash unchanged");
});

test("REGRESSION: an absent override must not coerce to numeric zero", () => {
  // Number(null) === 0 and Number("") === 0 are both finite. Without an explicit
  // guard these would win the `??` against the policy default and silently
  // produce a 0-day window and a $0 EMD.
  for (const absent of [null, undefined, ""]) {
    const t = resolveNewOfferTerms({
      overrides: {
        closing_window_days: absent,
        earnest_money: absent,
        earnest_money_due_business_days: absent,
      },
    });
    assert.equal(t.closing_window_days, 14, `closing window must not become 0 for ${JSON.stringify(absent)}`);
    assert.equal(t.earnest_money, 1000, `EMD must not become 0 for ${JSON.stringify(absent)}`);
    assert.equal(t.emd_due_business_days, 3);
  }
});

test("ad hoc overrides cannot fill missing contractual terms at closing time", () => {
  // Even if a caller passes closing/EMD overrides into contract creation, the
  // terms come from the accepted offer; an offer missing them still fails closed.
  const incomplete = {
    offer_id: "offer:x:v1", offer_version: 1, opportunity_id: OPP, thread_key: THREAD,
    purchase_price: 250000, accepted_price: 250000,
    closing_window_days: 14, closing_date: null,
    emd_amount: null, emd_due_business_days: 3,
    terms_hash: "h", acceptance_event_id: "e", accepted_at: "2026-09-01T10:00:00.000Z",
  };
  const r = resolveCanonicalTerms({
    opportunity: OPPORTUNITY,
    accepted_offer: incomplete,
    overrides: { earnest_money: 5000, scheduled_closing_date: "2026-10-01" },
  });
  assert.equal(r.ok, false, "overrides cannot manufacture a contract term");
  assert.equal(r.reason, "incomplete_contract_terms");
  assert.ok(r.missing_contract_terms.includes("closing_date"));
  assert.ok(r.missing_contract_terms.includes("emd_amount"));
});
