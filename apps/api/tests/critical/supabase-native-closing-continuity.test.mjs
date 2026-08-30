import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  createClosingCaseFromAcceptance,
  resolveCanonicalTerms,
  buildClosingCaseId,
  buildTermsHash,
} from "@/lib/domain/closings/create-closing-case-from-acceptance.js";
import {
  createDocusignEnvelopeFromClosingCase,
  buildEnvelopeInputFromClosingCase,
  closingCaseToDealTermValues,
} from "@/lib/domain/closings/create-docusign-envelope-from-closing-case.js";
import {
  reconcileClosingCaseFromEnvelope,
  resolveClosingStatusTransition,
} from "@/lib/domain/closings/reconcile-closing-case-from-envelope.js";

// Slice 1: Supabase-native contract + DocuSign continuity.
//   accepted offer -> closing_case -> envelope payload from closing_case ->
//   hosted template populated -> envelope id persisted -> webhook resolves by
//   envelope id -> signature reconciles into Supabase.
// Everything here is dormant: no live send, envelopes are dry-run.

const OPP_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_OPP_ID = "22222222-2222-4222-8222-222222222222";

const OPPORTUNITY = {
  id: OPP_ID,
  primary_property_id: "prop-1",
  property_address_full: "123 Main St, Austin TX",
  master_owner_id: "owner-1",
  seller_display_name: "Jane Seller",
  primary_thread_key: "+15550100999",
  current_offer: 250000,
  recommended_offer: 240000,
  version: 7,
};

// ── Minimal in-memory Supabase stub (only what these modules call) ───────────
// The contract price now comes from the ACCEPTED OFFER (Offer Term Authority),
// never from recommended_offer. These tests therefore seed a real accepted
// offer for the opportunity, which is what production requires too.
const ACCEPTED_OFFER = {
  offer_id: "offer:" + OPP_ID + ":v1",
  opportunity_id: OPP_ID,
  offer_version: 1,
  status: "accepted",
  purchase_price: 250000,
  accepted_price: 250000,
  accepted_at: "2026-08-30T12:00:00.000Z",
  acceptance_event_id: "evt-accept-1",
  closing_date: null,
  closing_term: null,
  emd_amount: null,
  emd_term: null,
  terms_hash: "offer-terms-hash-1",
};

function makeSupabase({
  opportunity = OPPORTUNITY,
  cases = [],
  events = [],
  offers = [ACCEPTED_OFFER],
} = {}) {
  const state = { cases: [...cases], events: [...events], offers: [...offers] };

  function table(name) {
    const q = { _filters: {}, _isNull: [] };
    const api = {
      select: () => api,
      insert: (row) => {
        if (name === "closing_cases") {
          if (state.cases.some((c) => c.closing_case_id === row.closing_case_id)) {
            return { select: () => ({ maybeSingle: async () => ({ data: null, error: { message: "duplicate key", code: "23505" } }) }) };
          }
          const created = { ...row };
          state.cases.push(created);
          return { select: () => ({ maybeSingle: async () => ({ data: created, error: null }) }) };
        }
        if (name === "closing_activity_events") {
          const dupe = state.events.some((e) => e.idempotency_key === row.idempotency_key);
          if (dupe) return Promise.resolve({ error: { message: "duplicate key value", code: "23505" } });
          state.events.push({ ...row });
          return Promise.resolve({ error: null });
        }
        return Promise.resolve({ error: null });
      },
      update: (patch) => {
        const u = {
          _f: {},
          _null: [],
          eq(col, val) { this._f[col] = val; return this; },
          is(col, val) { if (val === null) this._null.push(col); return this; },
          select() { return this; },
          async maybeSingle() {
            const row = applyUpdate(this);
            return { data: row, error: null };
          },
          then(resolve) { applyUpdate(this); return Promise.resolve({ error: null }).then(resolve); },
        };
        function applyUpdate(ctx) {
          const target = state.cases.find((c) =>
            Object.entries(ctx._f).every(([k, v]) => c[k] === v) &&
            ctx._null.every((col) => c[col] == null)
          );
          if (target) Object.assign(target, patch);
          return target || null;
        }
        return u;
      },
      eq(col, val) { q._filters[col] = val; return api; },
      order: () => api,
      limit: async () => ({ data: rows(), error: null }),
      async maybeSingle() {
        const r = rows();
        return { data: r[0] || null, error: null };
      },
    };
    function rows() {
      if (name === "acquisition_opportunities") {
        const match = Object.entries(q._filters).every(([k, v]) => opportunity?.[k] === v);
        return opportunity && match ? [opportunity] : [];
      }
      if (name === "closing_cases") {
        return state.cases.filter((c) =>
          Object.entries(q._filters).every(([k, v]) => c[k] === v)
        );
      }
      if (name === "seller_offers") {
        return state.offers.filter((o) =>
          Object.entries(q._filters).every(([k, v]) => o[k] === v)
        );
      }
      return [];
    }
    return api;
  }

  return { from: table, _state: state };
}

// ── 1) acceptance creates exactly one closing case ───────────────────────────

test("acceptance creates exactly ONE closing case from canonical Supabase authorities", async () => {
  const supabase = makeSupabase();
  const r = await createClosingCaseFromAcceptance({
    opportunity_id: OPP_ID,
    accepted_at: "2026-08-28T10:00:00.000Z",
    supabase,
  });

  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.closing_case_id, buildClosingCaseId(OPP_ID));
  assert.equal(supabase._state.cases.length, 1, "exactly one closing case");

  const c = supabase._state.cases[0];
  assert.equal(c.opportunity_id, OPP_ID, "acquisition opportunity id persisted");
  assert.equal(c.property_id, "prop-1", "property identity persisted");
  assert.equal(c.property_address, "123 Main St, Austin TX");
  assert.equal(c.master_owner_id, "owner-1", "seller identity persisted");
  assert.equal(c.thread_key, "+15550100999");
  assert.equal(c.seller_contract_price, 250000, "canonical negotiated price, not SMS-derived");
  assert.equal(c.accepted_at, "2026-08-28T10:00:00.000Z", "acceptance timestamp");
  assert.ok(c.terms_hash, "terms/version hash persisted");
  assert.equal(c.contract_status, "draft");
  assert.equal(c.universal_stage, "formal_contract");
  assert.equal(c.provenance.opportunity_version, 7, "provenance carries the source version");
});

test("price comes from the ACCEPTED OFFER, never from message text or a recommendation", () => {
  // CONTRACT CHANGE (deliberate): this test previously asserted that with no
  // live counter "the ADE baseline is used" — i.e. recommended_offer became the
  // contract price. That is exactly the defect the Offer Term Authority exists
  // to remove: a recommendation is lineage, not a term anyone agreed to. The
  // assertions below are inverted on purpose.
  const r = resolveCanonicalTerms({ opportunity: OPPORTUNITY, accepted_offer: ACCEPTED_OFFER });
  assert.equal(r.terms.seller_contract_price, 250000, "the accepted offer sets the price");

  // A recommendation with NO accepted offer must NOT produce a contract price.
  const baseline = resolveCanonicalTerms({
    opportunity: { ...OPPORTUNITY, current_offer: null, recommended_offer: 240000 },
    accepted_offer: null,
  });
  assert.equal(baseline.ok, false, "recommended_offer can never substitute for acceptance");
  assert.equal(baseline.reason, "no_accepted_offer");

  // Nothing accepted at all -> fail closed, no contract.
  const none = resolveCanonicalTerms({
    opportunity: { ...OPPORTUNITY, current_offer: null, recommended_offer: null },
    accepted_offer: null,
  });
  assert.equal(none.ok, false);
  assert.equal(none.reason, "no_accepted_offer");
});

// ── 2) replay creates no duplicate ───────────────────────────────────────────

test("replaying the same acceptance creates NO second closing case", async () => {
  const supabase = makeSupabase();
  const args = { opportunity_id: OPP_ID, accepted_at: "2026-08-28T10:00:00.000Z", supabase };

  const first = await createClosingCaseFromAcceptance(args);
  const second = await createClosingCaseFromAcceptance(args);

  assert.equal(first.created, true);
  assert.equal(second.ok, true);
  assert.equal(second.created, false, "replay does not create");
  assert.equal(second.reason, "already_exists");
  assert.equal(supabase._state.cases.length, 1, "still exactly one closing case");
});

// ── 3) stale acceptance does not overwrite newer terms ───────────────────────

test("a STALE acceptance never overwrites newer negotiated terms", async () => {
  const supabase = makeSupabase();
  await createClosingCaseFromAcceptance({
    opportunity_id: OPP_ID,
    accepted_at: "2026-08-28T12:00:00.000Z",
    supabase,
  });
  // Terms renegotiated upward and recorded at the newer time.
  supabase._state.cases[0].seller_contract_price = 260000;
  supabase._state.cases[0].terms_hash = "newer-hash";

  const stale = await createClosingCaseFromAcceptance({
    opportunity_id: OPP_ID,
    accepted_at: "2026-08-28T09:00:00.000Z", // older than recorded acceptance
    supabase,
  });

  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale_acceptance");
  assert.equal(
    supabase._state.cases[0].seller_contract_price,
    260000,
    "newer negotiated price survives"
  );
});

test("a NEWER acceptance with changed terms updates in place (one case, new terms)", async () => {
  const supabase = makeSupabase();
  await createClosingCaseFromAcceptance({
    opportunity_id: OPP_ID,
    accepted_at: "2026-08-28T09:00:00.000Z",
    supabase,
  });
  supabase._state.cases[0].terms_hash = "stale-hash"; // force a terms delta

  const renegotiated = await createClosingCaseFromAcceptance({
    opportunity_id: OPP_ID,
    accepted_at: "2026-08-28T12:00:00.000Z",
    supabase,
  });
  assert.equal(renegotiated.ok, true);
  assert.equal(renegotiated.created, false);
  assert.equal(renegotiated.reason, "terms_updated");
  assert.equal(supabase._state.cases.length, 1, "still exactly one closing case");
});

// ── 4) wrong opportunity cannot bind to another seller's case ────────────────

test("a wrong opportunity cannot bind to another seller's closing case", async () => {
  const supabase = makeSupabase();
  await createClosingCaseFromAcceptance({ opportunity_id: OPP_ID, supabase });

  // Corrupt the stored case so its id maps to a DIFFERENT opportunity, then
  // attempt to reconcile it under the original id.
  supabase._state.cases[0].opportunity_id = OTHER_OPP_ID;

  const r = await createClosingCaseFromAcceptance({
    opportunity_id: OPP_ID,
    accepted_at: "2026-08-28T13:00:00.000Z",
    supabase,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "opportunity_mismatch", "cross-seller bind is refused");
  assert.equal(supabase._state.cases[0].opportunity_id, OTHER_OPP_ID, "nothing overwritten");
});

test("closing case id is deterministic per opportunity (one case per opportunity)", () => {
  assert.equal(buildClosingCaseId(OPP_ID), buildClosingCaseId(OPP_ID));
  assert.notEqual(buildClosingCaseId(OPP_ID), buildClosingCaseId(OTHER_OPP_ID));
  // terms hash changes only when a contract-bearing term changes
  const base = { opportunity_id: OPP_ID, seller_contract_price: 250000 };
  assert.equal(buildTermsHash(base), buildTermsHash({ ...base }));
  assert.notEqual(buildTermsHash(base), buildTermsHash({ ...base, seller_contract_price: 260000 }));
});

// ── 5) envelope uses persisted canonical terms ───────────────────────────────

const CASE_ROW = {
  closing_case_id: "closing:" + OPP_ID,
  opportunity_id: OPP_ID,
  property_address: "123 Main St, Austin TX",
  seller_contract_price: 250000,
  earnest_money: 5000,
  scheduled_closing_date: "2026-09-30T00:00:00.000Z",
  signer_email: "jane@example.com",
  signer_name: "Jane Seller",
  terms_hash: "hash-1",
  docusign_envelope_id: null,
};

test("envelope is built from the PERSISTED canonical terms on the closing case", () => {
  const values = closingCaseToDealTermValues(CASE_ROW);
  assert.deepEqual(values, {
    purchase_price: "250000",
    property_address: "123 Main St, Austin TX",
    closing_date: "2026-09-30",
    earnest_money: "5000",
  });

  const built = buildEnvelopeInputFromClosingCase(CASE_ROW, { template_id: "TPL-1" });
  assert.equal(built.ok, true);
  assert.equal(built.input.template_id, "TPL-1", "hosted template preserved");
  const signer = built.input.recipients[0];
  assert.equal(signer.email, "jane@example.com", "seller recipient populated");
  const byLabel = Object.fromEntries(signer.tabs.textTabs.map((t) => [t.tabLabel, t.value]));
  assert.equal(byLabel.purchase_price, "250000");
  assert.equal(byLabel.property_address, "123 Main St, Austin TX");
  assert.equal(byLabel.closing_date, "2026-09-30");
  assert.equal(byLabel.earnest_money, "5000");
  assert.equal(built.input.metadata.closing_case_id, CASE_ROW.closing_case_id);
});

test("envelope fails closed without a signer email or template (never sends blind)", () => {
  assert.equal(
    buildEnvelopeInputFromClosingCase({ ...CASE_ROW, signer_email: null }, { template_id: "TPL-1" }).reason,
    "missing_signer_email"
  );
  assert.equal(
    buildEnvelopeInputFromClosingCase(CASE_ROW, { template_id: null }).reason,
    "missing_docusign_template_id"
  );
  assert.equal(
    buildEnvelopeInputFromClosingCase({ ...CASE_ROW, seller_contract_price: null }, { template_id: "TPL-1" })
      .reason,
    "missing_canonical_price"
  );
});

// ── 6) envelope id persists correctly + no second envelope ───────────────────

test("envelope id persists onto the closing case, and a second envelope is never created", async () => {
  const supabase = makeSupabase({ cases: [{ ...CASE_ROW }] });
  const r = await createDocusignEnvelopeFromClosingCase({
    closing_case_id: CASE_ROW.closing_case_id,
    template_id: "TPL-1",
    dry_run: false,
    supabase,
    createEnvelopeImpl: async () => ({ ok: true, dry_run: false, envelope_id: "ENV-1", status: "sent" }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.envelope_id, "ENV-1");
  assert.equal(supabase._state.cases[0].docusign_envelope_id, "ENV-1", "envelope id persisted");
  assert.equal(supabase._state.cases[0].contract_status, "sent_for_signature");

  // Replay: already enveloped -> no second envelope.
  let called = 0;
  const again = await createDocusignEnvelopeFromClosingCase({
    closing_case_id: CASE_ROW.closing_case_id,
    template_id: "TPL-1",
    dry_run: false,
    supabase,
    createEnvelopeImpl: async () => {
      called += 1;
      return { ok: true, envelope_id: "ENV-2" };
    },
  });
  assert.equal(again.created, false);
  assert.equal(again.reason, "envelope_already_exists");
  assert.equal(called, 0, "provider was never called a second time");
});

test("DORMANT: a dry-run envelope is fully populated but persists nothing", async () => {
  const supabase = makeSupabase({ cases: [{ ...CASE_ROW }] });
  const r = await createDocusignEnvelopeFromClosingCase({
    closing_case_id: CASE_ROW.closing_case_id,
    template_id: "TPL-1",
    dry_run: true,
    supabase,
    createEnvelopeImpl: async (input) => ({ ok: true, dry_run: true, envelope_id: null, raw: input }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.created, false);
  assert.equal(supabase._state.cases[0].docusign_envelope_id, null, "nothing persisted while dormant");
});

// ── 7) webhook resolves by envelope id + 8/9) reconciliation ─────────────────

const ENVELOPED_CASE = { ...CASE_ROW, docusign_envelope_id: "ENV-1", contract_status: "sent_for_signature" };

const completedPayload = (event_id = "evt-1") => ({
  event_id,
  envelopeSummary: {
    envelopeId: "ENV-1",
    status: "completed",
    completedDateTime: "2026-08-28T15:00:00.000Z",
    recipients: {
      signers: [{ roleName: "Seller", status: "completed", completedDateTime: "2026-08-28T15:00:00.000Z" }],
    },
  },
});

test("webhook resolves the closing case BY ENVELOPE ID and advances Supabase state", async () => {
  const supabase = makeSupabase({ cases: [{ ...ENVELOPED_CASE }] });
  const r = await reconcileClosingCaseFromEnvelope({ payload: completedPayload(), supabase });

  assert.equal(r.ok, true);
  assert.equal(r.reconciled, true);
  assert.equal(r.closing_case_id, ENVELOPED_CASE.closing_case_id, "resolved by envelope id");
  assert.equal(r.normalized_status, "Completed");
  const c = supabase._state.cases[0];
  assert.equal(c.contract_status, "fully_executed", "completed signature advances Supabase state");
  assert.equal(c.universal_stage, "under_contract");
  assert.equal(c.contract_signed_date, "2026-08-28T15:00:00.000Z");
});

test("an unknown envelope changes nothing and is not an error", async () => {
  const supabase = makeSupabase({ cases: [] });
  const r = await reconcileClosingCaseFromEnvelope({ payload: completedPayload(), supabase });
  assert.equal(r.ok, true);
  assert.equal(r.reconciled, false);
  assert.equal(r.reason, "closing_case_not_found");
  assert.equal(supabase._state.events.length, 0, "no state written for a foreign envelope");
});

// ── 10) retries remain idempotent ────────────────────────────────────────────

test("a REPLAYED webhook is idempotent (no duplicate reconciliation)", async () => {
  const supabase = makeSupabase({ cases: [{ ...ENVELOPED_CASE }] });
  const first = await reconcileClosingCaseFromEnvelope({ payload: completedPayload("evt-9"), supabase });
  const after_first = supabase._state.events.length;
  const second = await reconcileClosingCaseFromEnvelope({ payload: completedPayload("evt-9"), supabase });

  assert.equal(first.reconciled, true);
  assert.equal(second.reconciled, false);
  assert.equal(second.reason, "duplicate_event");

  // Exactly ONE docusign claim event: that is the idempotency gate. (A completion
  // also earns a separate title_route audit event downstream, so counting ALL
  // events would conflate "replay wrote nothing" with "one completion writes one
  // event".)
  assert.equal(
    supabase._state.events.filter((e) => e.event_type === "docusign_status").length,
    1,
    "exactly one docusign claim event"
  );
  // The replay must write NOTHING at all — stricter than the old total count.
  assert.equal(
    supabase._state.events.length,
    after_first,
    "the replay added no audit events of any kind"
  );
});

test("a lower-signal event never regresses a fully-executed contract", () => {
  const regress = resolveClosingStatusTransition({
    normalized_status: "Sent",
    current_contract_status: "fully_executed",
  });
  assert.equal(regress.apply, false, "monotonic: sent cannot undo fully_executed");

  const advance = resolveClosingStatusTransition({
    normalized_status: "Completed",
    current_contract_status: "sent_for_signature",
  });
  assert.equal(advance.apply, true);

  // A void is authoritative even over a signed contract.
  const voided = resolveClosingStatusTransition({
    normalized_status: "Voided",
    current_contract_status: "fully_executed",
  });
  assert.equal(voided.apply, true);
  assert.equal(voided.target.contract_status, "cancelled");
});

// ── 11) malformed payload changes nothing ────────────────────────────────────

test("a payload with no envelope id changes nothing (forged/garbage input is inert)", async () => {
  const supabase = makeSupabase({ cases: [{ ...ENVELOPED_CASE }] });
  const r = await reconcileClosingCaseFromEnvelope({ payload: { nonsense: true }, supabase });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_envelope_id");
  assert.equal(supabase._state.cases[0].contract_status, "sent_for_signature", "state untouched");
  assert.equal(supabase._state.events.length, 0);
});
