import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  finalizeSellerAcceptance,
  isAcceptanceEdge,
  FINALIZE_ACCEPTANCE_VERSION,
} from "@/lib/domain/seller-flow/finalize-seller-acceptance.js";
import { persistActiveOffer } from "@/lib/domain/seller-flow/seller-offer-authority.js";

// THE live acceptance -> closing seam (supersprint §12, P0 #5).
//
// finalizeSellerAcceptance binds a durable acceptance to the EXACT active
// seller_offer and creates exactly ONE closing case from canonical Supabase
// authorities. These tests prove: the edge detector; that a "yes" with no
// active offer creates nothing; that a bound acceptance produces both an
// accepted offer and a closing case with matching lineage; idempotency /
// crash-recovery; dry-run; fail-closed on missing ids; and failure isolation.

const OPP = "11111111-1111-4111-8111-111111111111";
const THREAD = "+15550100777";
const ADDRESS = "123 Main St, Austin TX 78701";

// In-memory Supabase enforcing the real DB constraints across the three tables
// this seam touches: seller_offers (one active, one accepted, unique version,
// unique acceptance_event_id), acquisition_opportunities, closing_cases (unique
// closing_case_id). deal_thread_state / property_cash_offer_snapshots return
// empty (the closing creator falls back to the opportunity).
function makeSupabase({ opportunity = {} } = {}) {
  const state = {
    offers: [],
    opportunities: [
      {
        id: OPP,
        primary_thread_key: THREAD,
        primary_property_id: "prop-1",
        property_address_full: ADDRESS,
        master_owner_id: "owner-1",
        seller_display_name: "Jane Seller",
        version: 3,
        ...opportunity,
      },
    ],
    closing_cases: [],
  };

  function tableFor(name) {
    return name === "seller_offers"
      ? state.offers
      : name === "closing_cases"
        ? state.closing_cases
        : name === "acquisition_opportunities"
          ? state.opportunities
          : null;
  }

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
            return sel({ error: { code: "23505", message: "dup offer_id" } });
          if (state.offers.some((o) => o.opportunity_id === row.opportunity_id && o.offer_version === row.offer_version))
            return sel({ error: { code: "23505", message: "dup version" } });
          if (row.status === "active" && state.offers.some((o) => o.opportunity_id === row.opportunity_id && o.status === "active"))
            return sel({ error: { code: "23505", message: "one active" } });
          const created = { created_at: new Date().toISOString(), ...row };
          state.offers.push(created);
          return sel({ data: created });
        }
        if (name === "closing_cases") {
          if (state.closing_cases.some((c) => c.closing_case_id === row.closing_case_id))
            return sel({ error: { code: "23505", message: "dup closing_case_id" } });
          const created = { ...row };
          state.closing_cases.push(created);
          return sel({ data: created });
        }
        return Promise.resolve({ error: null });
      },
      update(patch) {
        const u = {
          _f: {}, _null: [],
          eq(c, v) { this._f[c] = v; return this; },
          is(c, v) { if (v === null) this._null.push(c); return this; },
          select() { return this; },
          async maybeSingle() { return { data: apply(this)[0] || null, error: null }; },
          then(res) { apply(this); return Promise.resolve({ error: null }).then(res); },
        };
        function apply(ctx) {
          const src = tableFor(name) || [];
          // unique acceptance_event_id across offers
          if (name === "seller_offers" && patch.acceptance_event_id) {
            const clash = state.offers.find(
              (o) => o.acceptance_event_id === patch.acceptance_event_id &&
                !Object.entries(ctx._f).every(([k, v]) => o[k] === v)
            );
            if (clash) return [];
          }
          const hits = src.filter(
            (r) => Object.entries(ctx._f).every(([k, v]) => r[k] === v) &&
              ctx._null.every((c) => r[c] == null)
          );
          hits.forEach((r) => Object.assign(r, patch));
          return hits;
        }
        return u;
      },
    };
    function sel({ data = null, error = null }) {
      return { select: () => ({ maybeSingle: async () => ({ data, error }) }) };
    }
    function rows() {
      const src = tableFor(name) || [];
      let out = src.filter((r) => Object.entries(q.f).every(([k, v]) => r[k] === v));
      if (q.order) out = [...out].sort((a, b) => (q.order.asc ? 1 : -1) * ((a[q.order.c] ?? 0) - (b[q.order.c] ?? 0)));
      return out;
    }
    // deal_thread_state / property_cash_offer_snapshots -> empty
    if (name === "deal_thread_state" || name === "property_cash_offer_snapshots") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
            order: () => ({ limit: async () => ({ data: [], error: null }) }),
          }),
        }),
      };
    }
    return api;
  }
  return { from, _state: state };
}

// A contract-COMPLETE active offer (SELLER_OFFER_POLICY_V1 terms present), so
// acceptance can compute a closing date and the closing case can be created.
async function seedActiveOffer(supabase, over = {}) {
  return persistActiveOffer({
    opportunity_id: OPP,
    thread_key: THREAD,
    property_id: "prop-1",
    master_owner_id: "owner-1",
    purchase_price: 250000,
    offer_type: "initial_offer",
    ade_snapshot_id: "ade:snap:1",
    recommended_offer: 240000,
    authorized_ceiling: 260000,
    closing_date: "2026-09-20",
    closing_term: "14_calendar_days_from_acceptance",
    emd_term: "3_business_days_from_acceptance",
    supabase,
    ...over,
  });
}

// ── edge detector ───────────────────────────────────────────────────────────

test("acceptance edge: false->true is an edge; true->true and false->false are not", () => {
  assert.equal(isAcceptanceEdge({ terms_accepted: false }, { terms_accepted: true }), true);
  assert.equal(isAcceptanceEdge(null, { terms_accepted: true }), true);
  assert.equal(isAcceptanceEdge({ terms_accepted: true }, { terms_accepted: true }), false);
  assert.equal(isAcceptanceEdge({ terms_accepted: false }, { terms_accepted: false }), false);
  assert.equal(isAcceptanceEdge(null, null), false);
});

// ── the happy path: acceptance -> accepted offer + one closing case ──────────

test("a bound acceptance produces an accepted offer AND exactly one closing case", async () => {
  const supabase = makeSupabase();
  const seeded = await seedActiveOffer(supabase);
  assert.equal(seeded.ok, true);

  const r = await finalizeSellerAcceptance({
    opportunity_id: OPP,
    thread_key: THREAD,
    acceptance_event_id: "evt-accept-1",
    acceptance_at: "2026-09-06T15:00:00.000Z",
    supabase,
  });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.offer_accepted, true);
  assert.equal(r.offer_id, seeded.offer_id);
  assert.equal(r.accepted_price, 250000);
  assert.ok(r.closing_case_id, "a closing case id must be returned");
  assert.equal(r.closing_case_created, true);
  assert.equal(r.reason, "converged");
  assert.equal(r.version, FINALIZE_ACCEPTANCE_VERSION);

  // The durable offer flipped active -> accepted.
  const offer = supabase._state.offers.find((o) => o.offer_id === seeded.offer_id);
  assert.equal(offer.status, "accepted");
  assert.equal(offer.acceptance_event_id, "evt-accept-1");
  assert.equal(offer.accepted_price, 250000);

  // Exactly one closing case, priced from the accepted offer.
  assert.equal(supabase._state.closing_cases.length, 1);
  assert.equal(supabase._state.closing_cases[0].seller_contract_price, 250000);
});

// ── fail-closed: a "yes" with no active offer creates nothing ────────────────

test("a 'yes' with no active offer accepts nothing and creates no closing case", async () => {
  const supabase = makeSupabase();
  const r = await finalizeSellerAcceptance({
    opportunity_id: OPP,
    thread_key: THREAD,
    acceptance_event_id: "evt-accept-none",
    supabase,
  });
  assert.equal(r.offer_accepted, false);
  assert.equal(r.closing_case_id, null);
  assert.equal(r.closing_case_created, false);
  assert.equal(r.reason, "no_active_offer");
  assert.equal(supabase._state.closing_cases.length, 0);
});

// ── the money is never fabricated ────────────────────────────────────────────

test("the accepted price comes from the offer, never invented", async () => {
  const supabase = makeSupabase();
  const seeded = await seedActiveOffer(supabase, { purchase_price: 312500 });
  const r = await finalizeSellerAcceptance({
    opportunity_id: OPP, thread_key: THREAD, acceptance_event_id: "evt-p", supabase,
  });
  assert.equal(r.accepted_price, 312500);
  assert.equal(supabase._state.closing_cases[0].seller_contract_price, 312500);
});

// ── idempotency / crash recovery ─────────────────────────────────────────────

test("replaying the same acceptance creates no second closing case", async () => {
  const supabase = makeSupabase();
  await seedActiveOffer(supabase);
  const first = await finalizeSellerAcceptance({ opportunity_id: OPP, thread_key: THREAD, acceptance_event_id: "evt-dup", supabase });
  const second = await finalizeSellerAcceptance({ opportunity_id: OPP, thread_key: THREAD, acceptance_event_id: "evt-dup", supabase });
  assert.equal(first.closing_case_created, true);
  // Second call: acceptActiveOffer reports duplicate_acceptance; the closing
  // case already exists so it is reconciled, not recreated.
  assert.equal(second.ok, true);
  assert.equal(supabase._state.offers.filter((o) => o.status === "accepted").length, 1);
  assert.equal(supabase._state.closing_cases.length, 1);
});

test("crash between accept and closing is recovered on the next call", async () => {
  const supabase = makeSupabase();
  const seeded = await seedActiveOffer(supabase);
  // Simulate a prior turn that accepted the offer but crashed before the closing
  // case was created: flip the offer to accepted directly, no closing case.
  const offer = supabase._state.offers.find((o) => o.offer_id === seeded.offer_id);
  offer.status = "accepted";
  offer.acceptance_event_id = "evt-crash";
  offer.accepted_price = offer.purchase_price;
  offer.accepted_at = "2026-09-06T15:00:00.000Z";
  assert.equal(supabase._state.closing_cases.length, 0);

  // Replay with the same acceptance_event_id: duplicate_acceptance, then the
  // closing case IS created (the seam heals).
  const r = await finalizeSellerAcceptance({
    opportunity_id: OPP, thread_key: THREAD, acceptance_event_id: "evt-crash", supabase,
  });
  assert.equal(r.ok, true);
  assert.equal(r.offer_id, seeded.offer_id);
  assert.equal(r.closing_case_created, true);
  assert.equal(supabase._state.closing_cases.length, 1);
});

// ── dry run + fail-closed guards ─────────────────────────────────────────────

test("dry_run writes nothing", async () => {
  const supabase = makeSupabase();
  await seedActiveOffer(supabase);
  const r = await finalizeSellerAcceptance({ opportunity_id: OPP, thread_key: THREAD, acceptance_event_id: "evt-dry", dry_run: true, supabase });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true);
  assert.equal(supabase._state.closing_cases.length, 0);
  assert.equal(supabase._state.offers.filter((o) => o.status === "accepted").length, 0);
});

test("missing opportunity_id or acceptance_event_id fails closed", async () => {
  const supabase = makeSupabase();
  const a = await finalizeSellerAcceptance({ acceptance_event_id: "e", supabase });
  assert.equal(a.ok, false);
  assert.equal(a.reason, "missing_opportunity_id");
  const b = await finalizeSellerAcceptance({ opportunity_id: OPP, supabase });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "missing_acceptance_event_id");
});

// ── stale-offer acceptance never binds the wrong offer ───────────────────────

test("a 'yes' naming a superseded offer binds nothing and creates no closing case", async () => {
  const supabase = makeSupabase();
  await seedActiveOffer(supabase); // v1 active
  const r = await finalizeSellerAcceptance({
    opportunity_id: OPP, thread_key: THREAD, acceptance_event_id: "evt-stale",
    expected_offer_id: `offer:${OPP}:v99`, supabase,
  });
  assert.equal(r.offer_accepted, false);
  assert.equal(r.reason, "stale_offer_acceptance");
  assert.equal(supabase._state.closing_cases.length, 0);
});

// ── failure isolation ────────────────────────────────────────────────────────

test("an exception binding the offer is isolated, not thrown", async () => {
  const throwing = {
    from() {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => { throw new Error("db down"); } }) }),
      };
    },
  };
  const r = await finalizeSellerAcceptance({
    opportunity_id: OPP, thread_key: THREAD, acceptance_event_id: "evt-throw", supabase: throwing,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "accept_exception");
  assert.equal(r.closing_case_created, false);
});
