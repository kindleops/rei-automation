import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetRecordTermsSnapshotTestDeps,
  __setRecordTermsSnapshotTestDeps,
  computeTermsHash,
  recordAcceptanceTermsSnapshot,
  recordTermsSnapshot,
} from "@/lib/domain/agreements/record-terms-snapshot.js";
import {
  __resetMaybeCreateContractTestDeps,
  __setMaybeCreateContractTestDeps,
  maybeCreateContractFromAcceptedOffer,
} from "@/lib/domain/contracts/maybe-create-contract-from-accepted-offer.js";
import { CONTRACT_FIELDS } from "@/lib/podio/apps/contracts.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeSnapshotClient({
  existing = null,
  insert_error = null,
  select_error = null,
} = {}) {
  const calls = { selects: [], inserts: [] };

  const client = {
    from(table) {
      return {
        select() {
          return {
            eq(column, value) {
              calls.selects.push({ table, column, value });
              return {
                limit() {
                  return {
                    maybeSingle: async () => ({
                      data: existing,
                      error: select_error,
                    }),
                  };
                },
              };
            },
          };
        },
        insert(row) {
          calls.inserts.push({ table, row });
          return {
            select() {
              return {
                maybeSingle: async () =>
                  insert_error
                    ? { data: null, error: insert_error }
                    : { data: { id: "snap-1" }, error: null },
              };
            },
          };
        },
      };
    },
  };

  return { client, calls };
}

test.afterEach(() => {
  __resetRecordTermsSnapshotTestDeps();
  __resetMaybeCreateContractTestDeps();
});

// ── terms hash determinism ────────────────────────────────────────────────

test("terms hash is deterministic and independent of object key order", () => {
  const a = computeTermsHash({
    opportunity_id: "6f6a3a24-0000-4000-8000-000000000001",
    thread_key: "thread-1",
    accepted_price: 150000,
    accepted_terms: { price: 150000, basis: "we_accepted_seller_ask", nested: { b: 2, a: 1 } },
    seller_ask_at_acceptance: 155000,
    our_last_offer: 148000,
    authorized_ceiling_at_acceptance: 152000,
    podio_contract_item_id: 9001,
    source: "negotiation_acceptance",
  });
  const b = computeTermsHash({
    source: "negotiation_acceptance",
    podio_contract_item_id: 9001,
    authorized_ceiling_at_acceptance: 152000,
    our_last_offer: 148000,
    seller_ask_at_acceptance: 155000,
    accepted_terms: { nested: { a: 1, b: 2 }, basis: "we_accepted_seller_ask", price: 150000 },
    accepted_price: "150000",
    thread_key: "thread-1",
    opportunity_id: "6f6a3a24-0000-4000-8000-000000000001",
  });

  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("terms hash separates different economics, identities, and sources", () => {
  const base = {
    opportunity_id: "6f6a3a24-0000-4000-8000-000000000001",
    accepted_price: 150000,
    accepted_terms: { price: 150000 },
    source: "negotiation_acceptance",
  };

  const original = computeTermsHash(base);
  assert.notEqual(original, computeTermsHash({ ...base, accepted_price: 151000 }));
  assert.notEqual(original, computeTermsHash({ ...base, opportunity_id: "6f6a3a24-0000-4000-8000-000000000002" }));
  assert.notEqual(original, computeTermsHash({ ...base, source: "contract_creation" }));
});

test("a RE-ISSUED contract with identical economics gets its own hash", () => {
  // podio_contract_item_id is part of snapshot identity. Without it, cancelling
  // a contract and issuing a replacement at the same price hashed to the
  // original row and the replacement was silently deduped away, leaving the
  // live contract with no snapshot of its own.
  const economics = {
    opportunity_id: "6f6a3a24-0000-4000-8000-000000000001",
    accepted_price: 150000,
    accepted_terms: { price: 150000 },
    source: "contract_creation",
  };

  const first = computeTermsHash({ ...economics, podio_contract_item_id: 9001 });
  const reissued = computeTermsHash({ ...economics, podio_contract_item_id: 9002 });

  assert.notEqual(first, reissued);
  assert.equal(
    first,
    computeTermsHash({ ...economics, podio_contract_item_id: 9001 }),
    "the same contract still dedupes"
  );
  assert.equal(
    computeTermsHash({ ...economics, podio_contract_item_id: 9001 }),
    computeTermsHash({ ...economics, podio_contract_item_id: "9001" }),
    "id type does not fork the hash"
  );
});

test("an absent contract id is still a stable, distinct identity", () => {
  const economics = {
    opportunity_id: "6f6a3a24-0000-4000-8000-000000000001",
    accepted_price: 150000,
    source: "negotiation_acceptance",
  };
  assert.equal(computeTermsHash(economics), computeTermsHash({ ...economics, podio_contract_item_id: null }));
  assert.notEqual(computeTermsHash(economics), computeTermsHash({ ...economics, podio_contract_item_id: 9001 }));
});

// ── writer behavior ───────────────────────────────────────────────────────

test("snapshot writer rejects unknown sources without touching the client", async () => {
  const { client, calls } = makeSnapshotClient();
  __setRecordTermsSnapshotTestDeps({
    hasSupabaseConfig: () => true,
    getClient: () => client,
    logger: silentLogger,
  });

  const result = await recordTermsSnapshot({
    accepted_price: 100000,
    source: "made_up_source",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_terms_snapshot_source");
  assert.equal(calls.selects.length, 0);
  assert.equal(calls.inserts.length, 0);
});

test("snapshot writer degrades to a logged no-op without supabase config", async () => {
  const warns = [];
  __setRecordTermsSnapshotTestDeps({
    hasSupabaseConfig: () => false,
    getClient: () => {
      throw new Error("client must not be requested without config");
    },
    logger: { ...silentLogger, warn: (msg, meta) => warns.push({ msg, meta }) },
  });

  const result = await recordTermsSnapshot({
    accepted_price: 100000,
    source: "operator",
  });

  assert.equal(result.ok, false);
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "supabase_not_configured");
  assert.ok(result.terms_hash, "hash still computed for observability");
  assert.equal(warns.length, 1);
});

test("snapshot writer degrades to an explicit no-op while the table migration is unapplied", async () => {
  const warns = [];
  const { client } = makeSnapshotClient({
    select_error: {
      code: "PGRST205",
      message: "Could not find the table 'public.agreement_terms_snapshots' in the schema cache",
    },
    insert_error: {
      code: "PGRST205",
      message: "Could not find the table 'public.agreement_terms_snapshots' in the schema cache",
    },
  });
  __setRecordTermsSnapshotTestDeps({
    hasSupabaseConfig: () => true,
    getClient: () => client,
    logger: { ...silentLogger, warn: (msg, meta) => warns.push({ msg, meta }) },
  });

  const result = await recordTermsSnapshot({
    accepted_price: 100000,
    accepted_terms: { price: 100000 },
    source: "contract_creation",
  });

  assert.equal(result.ok, false);
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "agreement_terms_snapshots_table_missing");
  assert.ok(
    warns.some((w) => w.meta?.reason === "agreement_terms_snapshots_table_missing"),
    "explicit reason is logged"
  );
});

test("snapshot writer records once and replays as a dedupe no-op", async () => {
  const first = makeSnapshotClient({ existing: null });
  __setRecordTermsSnapshotTestDeps({
    hasSupabaseConfig: () => true,
    getClient: () => first.client,
    logger: silentLogger,
  });

  const payload = {
    opportunity_id: "6f6a3a24-0000-4000-8000-000000000001",
    thread_key: "thread-1",
    accepted_price: 150000,
    accepted_terms: { price: 150000, basis: "we_accepted_seller_ask" },
    source: "negotiation_acceptance",
  };

  const recorded = await recordTermsSnapshot(payload);
  assert.equal(recorded.ok, true);
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.deduped, false);
  assert.equal(first.calls.inserts.length, 1);
  assert.equal(first.calls.inserts[0].table, "agreement_terms_snapshots");
  assert.equal(first.calls.inserts[0].row.terms_hash, recorded.terms_hash);

  // Replay against a store that already has the row.
  const second = makeSnapshotClient({ existing: { id: "snap-existing" } });
  __setRecordTermsSnapshotTestDeps({ getClient: () => second.client });

  const replay = await recordTermsSnapshot(payload);
  assert.equal(replay.ok, true);
  assert.equal(replay.recorded, false);
  assert.equal(replay.deduped, true);
  assert.equal(replay.terms_hash, recorded.terms_hash);
  assert.equal(second.calls.inserts.length, 0, "replay must not insert");
});

test("insert race resolving to unique violation is treated as dedupe, not failure", async () => {
  const { client } = makeSnapshotClient({
    existing: null,
    insert_error: { code: "23505", message: "duplicate key value violates unique constraint" },
  });
  __setRecordTermsSnapshotTestDeps({
    hasSupabaseConfig: () => true,
    getClient: () => client,
    logger: silentLogger,
  });

  const result = await recordTermsSnapshot({
    accepted_price: 90000,
    accepted_terms: { price: 90000 },
    source: "operator",
  });

  assert.equal(result.ok, true);
  assert.equal(result.deduped, true);
  assert.equal(result.reason, "terms_snapshot_already_recorded");
});

// ── acceptance-time hook ──────────────────────────────────────────────────

test("acceptance hook is a no-op unless terms are actually accepted", async () => {
  const { client, calls } = makeSnapshotClient();
  __setRecordTermsSnapshotTestDeps({
    hasSupabaseConfig: () => true,
    getClient: () => client,
    logger: silentLogger,
  });

  const skipped = await recordAcceptanceTermsSnapshot(
    { terms_accepted: false, accepted_price: 100000 },
    { id: "6f6a3a24-0000-4000-8000-000000000009" }
  );
  assert.equal(skipped.reason, "terms_not_accepted");
  assert.equal(calls.inserts.length, 0);

  const recorded = await recordAcceptanceTermsSnapshot(
    {
      terms_accepted: true,
      accepted_price: 132500,
      accepted_terms: { price: 132500, basis: "seller_accepted_our_offer" },
      current_asking_price: 140000,
      latest_offer: 132500,
      authorized_offer_ceiling: 135000,
      version: "negotiation_state_v2",
    },
    {
      id: "6f6a3a24-0000-4000-8000-000000000009",
      primary_thread_key: "thread-9",
      primary_property_id: "prop-9",
      master_owner_id: "owner-9",
    }
  );

  assert.equal(recorded.ok, true);
  assert.equal(recorded.recorded, true);
  assert.equal(calls.inserts.length, 1);
  const row = calls.inserts[0].row;
  assert.equal(row.source, "negotiation_acceptance");
  assert.equal(row.opportunity_id, "6f6a3a24-0000-4000-8000-000000000009");
  assert.equal(row.thread_key, "thread-9");
  assert.equal(row.accepted_price, 132500);
  assert.equal(row.seller_ask_at_acceptance, 140000);
  assert.equal(row.our_last_offer, 132500);
  assert.equal(row.authorized_ceiling_at_acceptance, 135000);
  assert.equal(row.negotiation_state_version, "negotiation_state_v2");
});

// ── contract-path wiring ──────────────────────────────────────────────────

test("contract creation records a contract_creation snapshot with the exact Podio economics", async () => {
  const snapshots = [];

  __setMaybeCreateContractTestDeps({
    findContractItems: async () => [],
    createContractFromOffer: async () => ({
      ok: true,
      created: true,
      contract_item_id: 42001,
      contract_id: "CTR-9001-1",
      payload: {
        [CONTRACT_FIELDS.contract_id]: "CTR-9001-1",
        [CONTRACT_FIELDS.contract_status]: "Draft",
        [CONTRACT_FIELDS.contract_type]: "Cash",
        [CONTRACT_FIELDS.template_type]: "Standard Purchase",
        [CONTRACT_FIELDS.property]: [777],
        [CONTRACT_FIELDS.master_owner]: [888],
        [CONTRACT_FIELDS.offer]: [9001],
        [CONTRACT_FIELDS.purchase_price_final]: 145000,
        [CONTRACT_FIELDS.emd_amount]: 2500,
        [CONTRACT_FIELDS.closing_date_target]: { start: "2026-09-15" },
        [CONTRACT_FIELDS.creative_terms]: "as-is, seller keeps appliances",
      },
    }),
    recordTermsSnapshot: async (payload) => {
      snapshots.push(payload);
      return { ok: true, recorded: true, deduped: false, terms_hash: "h", snapshot_id: "s" };
    },
    maybeSendContractForSigning: async () => ({ ok: true, sent: false, reason: "auto_send_disabled" }),
    syncPipelineState: async () => ({ ok: true }),
  });

  const result = await maybeCreateContractFromAcceptedOffer({
    offer_item_id: 9001,
    offer_status: "accepted (ready for contract)",
    metadata: {
      opportunity_id: "6f6a3a24-0000-4000-8000-000000000021",
      thread_key: "thread-21",
      seller_ask_at_acceptance: 150000,
      our_last_offer: 145000,
      authorized_ceiling_at_acceptance: 147000,
      negotiation_state_version: "negotiation_state_v2",
    },
    auto_send: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(snapshots.length, 1);

  const snap = snapshots[0];
  assert.equal(snap.source, "contract_creation");
  assert.equal(snap.podio_contract_item_id, 42001);
  assert.equal(snap.opportunity_id, "6f6a3a24-0000-4000-8000-000000000021");
  assert.equal(snap.thread_key, "thread-21");
  assert.equal(snap.property_id, 777);
  assert.equal(snap.master_owner_id, 888);
  assert.equal(snap.accepted_price, 145000);
  assert.equal(snap.accepted_terms.purchase_price, 145000);
  assert.equal(snap.accepted_terms.emd_amount, 2500);
  assert.equal(snap.accepted_terms.closing_date_target, "2026-09-15");
  assert.equal(snap.accepted_terms.creative_terms, "as-is, seller keeps appliances");
  assert.equal(snap.seller_ask_at_acceptance, 150000);
  assert.equal(snap.our_last_offer, 145000);
  assert.equal(snap.authorized_ceiling_at_acceptance, 147000);
  assert.equal(result.terms_snapshot.ok, true);
});

test("a failing snapshot writer never blocks contract creation", async () => {
  __setMaybeCreateContractTestDeps({
    findContractItems: async () => [],
    createContractFromOffer: async () => ({
      ok: true,
      created: true,
      contract_item_id: 42002,
      payload: { [CONTRACT_FIELDS.purchase_price_final]: 99000 },
    }),
    recordTermsSnapshot: async () => ({
      ok: false,
      recorded: false,
      deduped: false,
      reason: "agreement_terms_snapshots_table_missing",
      terms_hash: "h2",
      snapshot_id: null,
    }),
    maybeSendContractForSigning: async () => ({ ok: true, sent: false, reason: "auto_send_disabled" }),
    syncPipelineState: async () => ({ ok: true }),
  });

  const result = await maybeCreateContractFromAcceptedOffer({
    offer_item_id: 9002,
    offer_status: "accepted (ready for contract)",
    auto_send: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.contract_item_id, 42002);
  assert.equal(result.terms_snapshot.reason, "agreement_terms_snapshots_table_missing");
});
