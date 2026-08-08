// ─── contract-send-authority-and-acceptance.test.mjs ─────────────────────────
//
// Four seams around turning an accepted offer into a signed contract:
//
//  1. SEND AUTHORITY — ENABLE_AUTO_CONTRACT_SEND was checked in exactly one
//     caller (run-deals-autopilot), so every other path into
//     maybeSendContractForSigning could dispatch a real e-signature envelope
//     with the flag off. The gate now lives in the sender; only a deliberate
//     authenticated operator send (sendContract) passes operator_override.
//
//  2. ACCEPTANCE MATCHING — isAcceptedOffer accepted any progress reason
//     CONTAINING "accept", which also matches "not accepted" / "didn't accept".
//
//  3. CORROBORATION — an acceptance is now labelled text_agreement or
//     podio_status_only. podio_status_only is NOT blocked (phone-negotiated
//     deals are a real operator flow) — it is recorded so the seam is auditable.
//
//  4. TERMS SNAPSHOT ON THE EXISTING-CONTRACT BRANCH — that branch returned
//     without recording a snapshot, so an acceptance landing on an
//     already-created contract left no durable record of its economics.

import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  maybeSendContractForSigning,
  __setMaybeSendContractForSigningTestDeps,
  __resetMaybeSendContractForSigningTestDeps,
} from "@/lib/domain/contracts/maybe-send-contract-for-signing.js";
import { sendContract } from "@/lib/domain/contracts/send-contract.js";
import {
  maybeCreateContractFromAcceptedOffer,
  __setMaybeCreateContractTestDeps,
  __resetMaybeCreateContractTestDeps,
} from "@/lib/domain/contracts/maybe-create-contract-from-accepted-offer.js";
import { FEATURE_FLAGS } from "@/lib/config/feature-flags.js";
import { CONTRACT_FIELDS } from "@/lib/podio/apps/contracts.js";

afterEach(() => {
  __resetMaybeSendContractForSigningTestDeps();
  __resetMaybeCreateContractTestDeps();
  FEATURE_FLAGS.ENABLE_AUTO_CONTRACT_SEND = false;
});

function contractItem(item_id = 7001, status = "Draft") {
  return {
    item_id,
    fields: [
      {
        external_id: CONTRACT_FIELDS.contract_status,
        values: [{ value: { text: status } }],
      },
    ],
  };
}

/** Every downstream dep stubbed so a send would visibly succeed if allowed. */
function armSender() {
  const dispatched = [];
  __setMaybeSendContractForSigningTestDeps({
    resolveContractTemplate: async () => ({
      ok: true,
      reason: "contract_template_resolved",
      docusign_template_id: "tmpl-1",
    }),
    generateContractDocument: async () => ({ ok: false, reason: "not_configured" }),
    createStoredDocumentPackage: async () => ({ ok: false, reason: "skipped_in_test" }),
    createMessageEvent: async () => ({ ok: true }),
    sendContractViaDocusign: async (args) => {
      dispatched.push(args);
      return { ok: true, sent: true, reason: "sent", envelope_id: "env-1" };
    },
    syncPipelineState: async () => ({ ok: true }),
    getContractItem: async (item_id) => contractItem(item_id),
  });
  return dispatched;
}

const SIGNERS = [{ name: "Seller One", email: "seller@example.com", role_name: "Seller" }];

// ════════════════════════════════════════════════════════════════════════════
// 1. SEND AUTHORITY
// ════════════════════════════════════════════════════════════════════════════

test("with the flag off the sender refuses and dispatches nothing", async () => {
  const dispatched = armSender();
  FEATURE_FLAGS.ENABLE_AUTO_CONTRACT_SEND = false;

  const result = await maybeSendContractForSigning({
    contract: contractItem(),
    signers: SIGNERS,
    auto_send: true,
  });

  assert.equal(result.ok, true, "a disabled flag is not an error");
  assert.equal(result.attempted, false);
  assert.equal(result.sent, false);
  assert.equal(result.reason, "auto_contract_send_disabled");
  assert.equal(dispatched.length, 0, "no envelope reached the provider");
});

test("the flag is checked BEFORE any Podio or provider work", async () => {
  let touched = false;
  __setMaybeSendContractForSigningTestDeps({
    resolveContractTemplate: async () => {
      touched = true;
      return { ok: true, docusign_template_id: "tmpl-1" };
    },
    sendContractViaDocusign: async () => {
      touched = true;
      return { ok: true, sent: true };
    },
    syncPipelineState: async () => ({ ok: true }),
  });
  FEATURE_FLAGS.ENABLE_AUTO_CONTRACT_SEND = false;

  await maybeSendContractForSigning({ contract: contractItem(), signers: SIGNERS });
  assert.equal(touched, false);
});

test("the authed operator send path still works with the flag off", async () => {
  const dispatched = armSender();
  FEATURE_FLAGS.ENABLE_AUTO_CONTRACT_SEND = false;

  const result = await sendContract({
    contract_id: 7001,
    signers: SIGNERS,
    auto_send: true,
  });

  assert.notEqual(result.reason, "auto_contract_send_disabled");
  assert.equal(result.sent, true, "a deliberate operator send is authorized");
  assert.equal(dispatched.length, 1);
});

test("flag ON restores the previous behavior for every caller", async () => {
  const dispatched = armSender();
  FEATURE_FLAGS.ENABLE_AUTO_CONTRACT_SEND = true;

  const result = await maybeSendContractForSigning({
    contract: contractItem(),
    signers: SIGNERS,
    auto_send: true,
  });

  assert.equal(result.sent, true);
  assert.equal(dispatched.length, 1);
});

test("the accepted-offer creation path cannot dispatch with the flag off", async () => {
  const dispatched = armSender();
  FEATURE_FLAGS.ENABLE_AUTO_CONTRACT_SEND = false;

  __setMaybeCreateContractTestDeps({
    findContractItems: async () => [],
    createContractFromOffer: async () => ({
      ok: true,
      contract_item_id: 7100,
      payload: { [CONTRACT_FIELDS.purchase_price_final]: 150000 },
    }),
    recordTermsSnapshot: async () => ({ ok: true, recorded: true }),
    syncPipelineState: async () => ({ ok: true }),
    loadOpportunityNegotiationState: async () => null,
  });

  const result = await maybeCreateContractFromAcceptedOffer({
    offer_item_id: 5001,
    offer_progress: { reason: "seller_acceptance_signal" },
    auto_send: true,
  });

  assert.equal(result.created, true, "the contract record is still created");
  assert.equal(result.sent, false, "but nothing was sent");
  assert.equal(result.send_result.reason, "auto_contract_send_disabled");
  assert.equal(dispatched.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. ACCEPTANCE MATCHING
// ════════════════════════════════════════════════════════════════════════════

function armCreation({ negotiation_state = null, existing = [] } = {}) {
  const snapshots = [];
  __setMaybeCreateContractTestDeps({
    findContractItems: async () => existing,
    createContractFromOffer: async () => ({
      ok: true,
      contract_item_id: 7100,
      payload: {
        [CONTRACT_FIELDS.purchase_price_final]: 150000,
        [CONTRACT_FIELDS.contract_status]: "Draft",
      },
    }),
    maybeSendContractForSigning: async () => ({ ok: true, attempted: false, sent: false }),
    recordTermsSnapshot: async (args) => {
      snapshots.push(args);
      return { ok: true, recorded: true, terms_hash: `h${snapshots.length}` };
    },
    syncPipelineState: async () => ({ ok: true }),
    loadOpportunityNegotiationState: async () => negotiation_state,
  });
  return snapshots;
}

test("negation reasons never create a contract", async () => {
  armCreation();

  for (const reason of [
    "not accepted",
    "offer_not_accepted",
    "didn't accept",
    "seller_did_not_accept",
    "acceptance_withdrawn",
    "unaccepted",
    "seller_counter_signal",
    "seller_rejection_signal",
    "no_offer_status_change",
    "compliance_stop",
  ]) {
    const result = await maybeCreateContractFromAcceptedOffer({
      offer_item_id: 5001,
      offer_progress: { reason },
    });
    assert.equal(result.created, false, reason);
    assert.equal(result.reason, "offer_not_accepted", reason);
  }
});

test("the one genuine acceptance reason still creates the contract", async () => {
  armCreation();
  const result = await maybeCreateContractFromAcceptedOffer({
    offer_item_id: 5001,
    offer_progress: { reason: "seller_acceptance_signal" },
  });
  assert.equal(result.created, true);
  assert.equal(result.acceptance_corroboration, "text_agreement");
});

test("the Podio status field alone still creates the contract", async () => {
  armCreation();
  const result = await maybeCreateContractFromAcceptedOffer({
    offer_item_id: 5001,
    offer_status: "Accepted (Ready for Contract)",
  });
  assert.equal(result.created, true, "phone-negotiated deals are not blocked");
  assert.equal(result.acceptance_corroboration, "podio_status_only");
});

test("a near-miss status is not an acceptance", async () => {
  armCreation();
  for (const offer_status of ["Accepted (Pending Review)", "Not Accepted", "Draft"]) {
    const result = await maybeCreateContractFromAcceptedOffer({
      offer_item_id: 5001,
      offer_status,
    });
    assert.equal(result.created, false, offer_status);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 3. CORROBORATION STAMPING
// ════════════════════════════════════════════════════════════════════════════

test("a recorded terms_accepted upgrades a status-only acceptance", async () => {
  const snapshots = armCreation({
    negotiation_state: { terms_accepted: true, accepted_price: 150000 },
  });

  const result = await maybeCreateContractFromAcceptedOffer({
    offer_item_id: 5001,
    offer_status: "Accepted (Ready for Contract)",
    metadata: { opportunity_id: "opp-1" },
  });

  assert.equal(result.acceptance_corroboration, "text_agreement");
  assert.equal(result.terms_accepted, true);
  assert.equal(result.accepted_price, 150000);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].accepted_terms.acceptance_corroboration, "text_agreement");
  assert.equal(snapshots[0].accepted_terms.accepted_price, 150000);
});

test("an uncorroborated status acceptance is stamped podio_status_only", async () => {
  const snapshots = armCreation({ negotiation_state: { terms_accepted: false } });

  const result = await maybeCreateContractFromAcceptedOffer({
    offer_item_id: 5001,
    offer_status: "Accepted (Ready for Contract)",
    metadata: { opportunity_id: "opp-1" },
  });

  assert.equal(result.created, true, "still not blocked");
  assert.equal(result.acceptance_corroboration, "podio_status_only");
  assert.equal(result.terms_accepted, false);
  assert.equal(snapshots[0].accepted_terms.acceptance_corroboration, "podio_status_only");
});

test("an unreadable negotiation state degrades to podio_status_only, never throws", async () => {
  __setMaybeCreateContractTestDeps({
    findContractItems: async () => [],
    createContractFromOffer: async () => ({
      ok: true,
      contract_item_id: 7100,
      payload: {},
    }),
    maybeSendContractForSigning: async () => ({ ok: true, sent: false }),
    recordTermsSnapshot: async () => ({ ok: true, recorded: true }),
    syncPipelineState: async () => ({ ok: true }),
    loadOpportunityNegotiationState: async () => null,
  });

  const result = await maybeCreateContractFromAcceptedOffer({
    offer_item_id: 5001,
    offer_status: "Accepted (Ready for Contract)",
    metadata: { opportunity_id: "opp-missing" },
  });

  assert.equal(result.created, true);
  assert.equal(result.acceptance_corroboration, "podio_status_only");
});

// ════════════════════════════════════════════════════════════════════════════
// 4. TERMS SNAPSHOT ON THE EXISTING-CONTRACT BRANCH
// ════════════════════════════════════════════════════════════════════════════

function existingContractItem(item_id = 7200) {
  return {
    item_id,
    fields: [
      { external_id: CONTRACT_FIELDS.contract_status, values: [{ value: { text: "Draft" } }] },
      { external_id: CONTRACT_FIELDS.purchase_price_final, values: [{ value: 150000 }] },
      { external_id: CONTRACT_FIELDS.contract_id, values: [{ value: "C-7200" }] },
    ],
  };
}

test("an acceptance landing on an existing contract still records a snapshot", async () => {
  const snapshots = armCreation({ existing: [existingContractItem()] });

  const result = await maybeCreateContractFromAcceptedOffer({
    offer_item_id: 5001,
    offer_progress: { reason: "seller_acceptance_signal" },
    metadata: { opportunity_id: "opp-1" },
  });

  assert.equal(result.created, false);
  assert.equal(result.reason, "existing_contract_found");
  assert.equal(snapshots.length, 1, "the branch no longer returns snapshot-less");
  assert.equal(snapshots[0].podio_contract_item_id, 7200, "keyed to the contract it found");
  assert.equal(snapshots[0].accepted_price, 150000, "economics read off the real item");
  assert.equal(snapshots[0].source, "contract_creation");
  assert.equal(snapshots[0].accepted_terms.acceptance_corroboration, "text_agreement");
  assert.ok(result.terms_snapshot?.recorded, "and it is reported on the result");
});

test("a terminal existing contract falls through to creating a new one", async () => {
  const terminal = existingContractItem(7300);
  terminal.fields[0].values = [{ value: { text: "Fully Executed" } }];
  const snapshots = armCreation({ existing: [terminal] });

  const result = await maybeCreateContractFromAcceptedOffer({
    offer_item_id: 5001,
    offer_progress: { reason: "seller_acceptance_signal" },
    metadata: { opportunity_id: "opp-1" },
  });

  assert.equal(result.created, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].podio_contract_item_id, 7100, "the NEW contract");
});
