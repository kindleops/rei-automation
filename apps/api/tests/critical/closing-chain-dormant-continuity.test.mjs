import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  createDocusignEnvelopeFromContract,
  buildDealTermTabs,
} from "@/lib/domain/contracts/create-docusign-envelope-from-contract.js";
import {
  __resetDocusignWebhookTestDeps,
  __setDocusignWebhookTestDeps,
  handleDocusignWebhook,
} from "@/lib/domain/contracts/handle-docusign-webhook.js";
import { CONTRACT_FIELDS } from "@/lib/podio/apps/contracts.js";
import {
  categoryField,
  createInMemoryIdempotencyLedger,
  createPodioItem,
  dateField,
  numberField,
  textField,
} from "../helpers/test-helpers.js";

// Phase (safe reconnect): prove the CLOSING chain is wired end-to-end WITHOUT any
// live send. Chain (operator's spec):
//   seller accepts active offer -> acceptance bound to property+offer/version ->
//   accepted state persisted -> contract creation trigger  [covered by
//     maybe-create-contract + burst-mode-contract-write-containment]
//   -> DocuSign envelope from CONFIGURED TEMPLATE -> seller recipient + per-deal
//     FIELDS populated -> envelope send-ready (dormant/dry-run)   [THIS FILE]
//   -> webhook received -> signature reconciled -> title/closing workflow ->
//     seller/title email   [THIS FILE + docusign-webhook-containment]
// No step performs a live send: the envelope is dry-run, and downstream external
// effects stay contained until closing execution is authorized.

const CONTRACT_ID = 9100;

function contractWithDealTerms() {
  return createPodioItem(CONTRACT_ID, {
    [CONTRACT_FIELDS.contract_status]: categoryField("Draft"),
    [CONTRACT_FIELDS.purchase_price_final]: numberField(250000),
    [CONTRACT_FIELDS.emd_amount]: numberField(5000),
    [CONTRACT_FIELDS.closing_date_target]: dateField("2026-09-30"),
    [CONTRACT_FIELDS.title]: textField("Purchase Agreement 9100"),
  });
}

// ── contract -> envelope from configured template, fields populated, dry-run ──

test("envelope is generated from the CONFIGURED TEMPLATE with the seller recipient + per-deal fields, send-ready but DORMANT", async () => {
  const result = await createDocusignEnvelopeFromContract({
    contract_item: contractWithDealTerms(),
    template_id: "TPL-PURCHASE-AGREEMENT",
    seller_recipient: { name: "Jane Seller", email: "jane@example.com" },
    deal_terms: { property_address: "123 Main St, Austin TX" },
    dry_run: true,
  });

  assert.equal(result.ok, true);
  // Send-ready but NOT sent — dormant.
  assert.equal(result.dry_run, true, "envelope is dry-run: send action ready, nothing sent");
  assert.equal(result.envelope_id, null, "no live envelope created");

  const def = result.raw;
  assert.equal(def.templateId, "TPL-PURCHASE-AGREEMENT", "envelope built from the configured template");

  const sellerRole = (def.templateRoles || []).find((r) => r.email === "jane@example.com");
  assert.ok(sellerRole, "seller recipient is on the envelope");
  assert.ok(sellerRole.tabs?.textTabs?.length, "per-deal FIELDS are populated as text tabs");

  const byLabel = Object.fromEntries(sellerRole.tabs.textTabs.map((t) => [t.tabLabel, t.value]));
  assert.equal(byLabel.purchase_price, "250000", "purchase price bound to the envelope");
  assert.equal(byLabel.property_address, "123 Main St, Austin TX", "property address bound");
  assert.equal(byLabel.closing_date, "2026-09-30", "closing date bound");
  assert.equal(byLabel.earnest_money, "5000", "earnest money bound");
});

test("buildDealTermTabs sources contract fields + caller overrides, omitting empty terms", () => {
  const tabs = buildDealTermTabs(contractWithDealTerms(), { property_address: "9 Oak Ave" });
  const labels = tabs.textTabs.map((t) => t.tabLabel).sort();
  assert.deepEqual(labels, ["closing_date", "earnest_money", "property_address", "purchase_price"]);

  // A contract with no deal terms and no overrides yields no tabs (nothing to inject).
  const bare = createPodioItem(1, { [CONTRACT_FIELDS.contract_status]: categoryField("Draft") });
  assert.equal(buildDealTermTabs(bare, {}), null);
});

test("envelope requires a template (or documents): a bare call fails closed, never sends blind", async () => {
  const result = await createDocusignEnvelopeFromContract({
    contract_item: contractWithDealTerms(),
    seller_recipient: { name: "Jane Seller", email: "jane@example.com" },
    dry_run: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_documents_or_template");
});

// ── webhook -> reconcile -> title/closing/email (back half of the chain) ──────

function webhookHarness(featureFlags) {
  const calls = { updates: [], title: 0, closing: 0, buyer: 0, intro: 0, brain: 0 };
  const ledger = createInMemoryIdempotencyLedger();
  __setDocusignWebhookTestDeps({
    featureFlags,
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    info: () => {},
    warn: () => {},
    findContractItems: async () => [contractWithDealTerms()],
    updateContractItem: async (_id, p) => calls.updates.push(p),
    maybeCreateTitleRoutingFromSignedContract: async () => {
      calls.title += 1;
      return { ok: true, created: true, title_routing_item_id: 1 };
    },
    maybeCreateClosingFromTitleRouting: async () => {
      calls.closing += 1;
      return { ok: true, created: true, closing_item_id: 2 };
    },
    createBuyerMatchFlow: async () => {
      calls.buyer += 1;
      return { ok: true };
    },
    maybeSendTitleIntro: async () => {
      calls.intro += 1;
      return { ok: true, sent: true };
    },
    syncPipelineState: async () => ({ current_stage: "Contract" }),
    updateBrainFromExecution: async () => {
      calls.brain += 1;
      return { ok: true };
    },
  });
  return calls;
}

const SIGNED_WEBHOOK = {
  event_id: "evt-chain-completed",
  envelopeSummary: {
    envelopeId: "env-chain",
    status: "completed",
    completedDateTime: "2026-08-27T12:00:00.000Z",
    recipients: { signers: [{ roleName: "Seller", status: "completed", completedDateTime: "2026-08-27T12:00:00.000Z" }] },
  },
};

test.afterEach(() => __resetDocusignWebhookTestDeps());

test("webhook reconciles the signature and stays CONTAINED while closing execution is dormant", async () => {
  const calls = webhookHarness({}); // dormant
  const result = await handleDocusignWebhook(SIGNED_WEBHOOK);
  assert.equal(result.ok, true);
  assert.equal(result.contract_status, "Fully Executed", "signature reconciled");
  assert.equal(calls.updates.length, 1, "contract status recorded");
  assert.equal(calls.brain, 1, "brain reconciled (internal truth)");
  assert.equal(calls.title + calls.closing + calls.buyer + calls.intro, 0, "no live downstream while dormant");
});

test("when closing execution is authorized, the chain completes: title -> closing -> title email", async () => {
  const calls = webhookHarness({
    ENABLE_AUTO_CONTRACT_SEND: true,
    ENABLE_AUTO_TITLE_ROUTING: true,
    ENABLE_AUTO_CLOSING_FLOW: true,
    ENABLE_AUTO_TITLE_INTRO: true,
    ENABLE_AUTO_BUYER_MATCH: true,
  });
  const result = await handleDocusignWebhook(SIGNED_WEBHOOK);
  assert.equal(result.ok, true);
  assert.equal(calls.title, 1, "title routing fires");
  assert.equal(calls.closing, 1, "closing fires");
  assert.equal(calls.intro, 1, "title email fires");
  assert.equal(calls.brain, 1, "brain reconciled");
});
