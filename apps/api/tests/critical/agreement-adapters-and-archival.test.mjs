import assert from "node:assert/strict";
import test from "node:test";

import {
  AGREEMENT_ADAPTER_BOUNDARIES,
  getAgreementAdapters,
} from "@/lib/domain/agreements/adapters.js";
import {
  DOCUMENT_GENERATION_NOT_CONFIGURED,
  generateContractDocument,
  registerDocumentGenerationProvider,
} from "@/lib/domain/documents/document-generation-adapter.js";
import {
  __resetMaybeSendContractForSigningTestDeps,
  __setMaybeSendContractForSigningTestDeps,
  maybeSendContractForSigning,
} from "@/lib/domain/contracts/maybe-send-contract-for-signing.js";
import {
  __resetStoreSignedContractDocumentTestDeps,
  __setStoreSignedContractDocumentTestDeps,
  storeSignedContractDocument,
} from "@/lib/domain/agreements/store-signed-contract-document.js";
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
} from "../helpers/test-helpers.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

test.afterEach(() => {
  __resetMaybeSendContractForSigningTestDeps();
  __resetStoreSignedContractDocumentTestDeps();
  __resetDocusignWebhookTestDeps();
});

// ── Boundary registry ─────────────────────────────────────────────────────

test("adapter registry names all five agreement boundaries with callable surfaces", () => {
  const expected = [
    "email",
    "document_generation",
    "esignature",
    "file_storage",
    "status_callbacks",
  ];

  assert.deepEqual(Object.keys(AGREEMENT_ADAPTER_BOUNDARIES).sort(), [...expected].sort());

  const adapters = getAgreementAdapters();
  assert.equal(typeof adapters.email.sendEmail, "function");
  assert.equal(typeof adapters.document_generation.generateContractDocument, "function");
  assert.equal(typeof adapters.esignature.createEnvelope, "function");
  assert.equal(typeof adapters.esignature.getEnvelope, "function");
  assert.equal(typeof adapters.file_storage.uploadFile, "function");
  assert.equal(typeof adapters.file_storage.storeSignedContractDocument, "function");
  assert.equal(typeof adapters.status_callbacks.handleDocusignWebhook, "function");
});

// ── Document generation: capability-absent by default ─────────────────────

test("default document generation provider returns an explicit capability-absent result", async () => {
  const result = await generateContractDocument(
    { contract_item_id: 6001 },
    { template_type: "Standard Purchase" }
  );

  assert.equal(result.ok, false);
  assert.equal(result.generated, false);
  assert.equal(result.capability_absent, true);
  assert.equal(result.provider, "not_configured");
  assert.equal(result.reason, DOCUMENT_GENERATION_NOT_CONFIGURED);
  assert.equal(result.document, null);
});

test("a provider claiming success without a real document fails closed", async () => {
  registerDocumentGenerationProvider("broken_provider", {
    generateContractDocument: async () => ({
      ok: true,
      generated: true,
      document: { name: "empty.pdf", file_base64: "" },
    }),
  });

  const result = await generateContractDocument({}, null, {
    provider: "broken_provider",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "document_generation_empty_result");
  assert.equal(result.document, null);
});

// ── Send-for-signing seam behavior ────────────────────────────────────────

function sendableContractItem(item_id = 6001) {
  return createPodioItem(item_id, {
    [CONTRACT_FIELDS.contract_status]: categoryField("Draft"),
  });
}

test("a configured docgen provider feeds its document into the signing flow", async () => {
  let sent_documents = null;

  __setMaybeSendContractForSigningTestDeps({
    resolveContractTemplate: async () => ({
      ok: false,
      reason: "no_usable_contract_template_found",
    }),
    generateContractDocument: async () => ({
      ok: true,
      generated: true,
      provider: "test_provider",
      reason: "document_generated",
      document: {
        document_id: "1",
        name: "generated-contract.pdf",
        file_base64: Buffer.from("pdf-bytes").toString("base64"),
        file_extension: "pdf",
      },
    }),
    createStoredDocumentPackage: async () => ({ ok: false, reason: "skipped_in_test" }),
    createMessageEvent: async () => ({ ok: true }),
    sendContractViaDocusign: async ({ documents }) => {
      sent_documents = documents;
      return { ok: true, sent: true, reason: "sent", envelope_id: "env-1" };
    },
    syncPipelineState: async () => ({ ok: true }),
  });

  const result = await maybeSendContractForSigning({
    contract: sendableContractItem(),
    documents: [],
    signers: [{ name: "Seller One", email: "seller@example.com", role_name: "Seller" }],
    auto_send: true,
    // Deliberate operator send: ENABLE_AUTO_CONTRACT_SEND is default-false and
    // now gates the SENDER itself, so this seam test states its authority
    // explicitly rather than relying on the sender being ungated.
    operator_override: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.document_generation.provider, "test_provider");
  assert.equal(sent_documents.length, 1);
  assert.equal(sent_documents[0].name, "generated-contract.pdf");
});

test("capability-absent docgen keeps documents-supplied and server-template flows untouched", async () => {
  let docgen_calls = 0;

  __setMaybeSendContractForSigningTestDeps({
    resolveContractTemplate: async () => ({
      ok: true,
      reason: "contract_template_resolved",
      docusign_template_id: "tmpl-1",
    }),
    generateContractDocument: async () => {
      docgen_calls += 1;
      return { ok: false, reason: DOCUMENT_GENERATION_NOT_CONFIGURED };
    },
    createStoredDocumentPackage: async () => ({ ok: false, reason: "skipped_in_test" }),
    createMessageEvent: async () => ({ ok: true }),
    sendContractViaDocusign: async () => ({ ok: true, sent: true, reason: "sent" }),
    syncPipelineState: async () => ({ ok: true }),
  });

  // Server template resolvable ⇒ docgen is never consulted.
  const via_template = await maybeSendContractForSigning({
    contract: sendableContractItem(6002),
    documents: [],
    signers: [{ name: "Seller One", email: "seller@example.com", role_name: "Seller" }],
    auto_send: true,
    // Deliberate operator send: ENABLE_AUTO_CONTRACT_SEND is default-false and
    // now gates the SENDER itself, so this seam test states its authority
    // explicitly rather than relying on the sender being ungated.
    operator_override: true,
  });

  assert.equal(via_template.ok, true);
  assert.equal(docgen_calls, 0);
  assert.equal(via_template.document_generation, null);

  // Caller-supplied documents ⇒ docgen is never consulted either.
  const via_documents = await maybeSendContractForSigning({
    contract: sendableContractItem(6003),
    documents: [
      { name: "signed.pdf", file_base64: Buffer.from("x").toString("base64") },
    ],
    signers: [{ name: "Seller One", email: "seller@example.com", role_name: "Seller" }],
    auto_send: true,
    // Deliberate operator send: ENABLE_AUTO_CONTRACT_SEND is default-false and
    // now gates the SENDER itself, so this seam test states its authority
    // explicitly rather than relying on the sender being ungated.
    operator_override: true,
  });

  assert.equal(via_documents.ok, true);
  assert.equal(docgen_calls, 0);
});

// ── Signed-contract archival: flag OFF is inert ───────────────────────────

test("archival module is a skipped no-op while ENABLE_SIGNED_CONTRACT_ARCHIVAL is off (default)", async () => {
  __setStoreSignedContractDocumentTestDeps({
    // Real default flag value (false in this environment) is exercised via
    // the real isFeatureEnabled; network/storage deps must never be touched.
    getAccessToken: async () => {
      throw new Error("docusign auth must not run while the flag is off");
    },
    fetchImpl: async () => {
      throw new Error("network fetch must not run while the flag is off");
    },
    createStoredDocumentPackage: async () => {
      throw new Error("storage must not run while the flag is off");
    },
    logger: silentLogger,
  });

  const result = await storeSignedContractDocument({
    envelope_id: "env-off",
    contract_item_id: 9001,
  });

  assert.equal(result.ok, true);
  assert.equal(result.archived, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "signed_contract_archival_disabled");
});

function buildCompletedWebhookPayload(envelope_id = "env-completed") {
  return {
    event_id: `evt-${envelope_id}`,
    envelopeSummary: {
      envelopeId: envelope_id,
      status: "completed",
      completedDateTime: "2026-04-11T12:15:00.000Z",
      recipients: {
        signers: [
          { roleName: "Seller", status: "completed", completedDateTime: "2026-04-11T12:10:00.000Z" },
          { roleName: "Buyer", status: "completed", completedDateTime: "2026-04-11T12:12:00.000Z" },
        ],
      },
    },
  };
}

function buildWebhookDeps({ contract_item, store_calls, isFeatureEnabled = undefined }) {
  const ledger = createInMemoryIdempotencyLedger();

  __setDocusignWebhookTestDeps({
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    info: () => {},
    warn: () => {},
    findContractItems: async () => [contract_item],
    updateContractItem: async () => {},
    maybeCreateTitleRoutingFromSignedContract: async () => ({ ok: true, created: false }),
    maybeCreateClosingFromTitleRouting: async () => ({ ok: true, created: false }),
    createBuyerMatchFlow: async () => ({ ok: true, created: false }),
    maybeSendTitleIntro: async () => ({ sent: false }),
    syncPipelineState: async () => ({ current_stage: "Contract" }),
    updateBrainFromExecution: async () => ({ ok: true, updated: true }),
    storeSignedContractDocument: async (payload) => {
      store_calls.push(payload);
      return {
        ok: true,
        archived: true,
        skipped: false,
        reason: "signed_contract_archived",
        package: { package_id: "pkg-1", manifest_key: "contracts/manifest.json" },
      };
    },
    ...(isFeatureEnabled ? { isFeatureEnabled } : {}),
  });
}

test("completed webhook does not invoke archival while the flag is off — behavior unchanged", async () => {
  const store_calls = [];

  buildWebhookDeps({
    contract_item: createPodioItem(9001, {
      [CONTRACT_FIELDS.contract_status]: categoryField("Viewed"),
    }),
    store_calls,
    // Real isFeatureEnabled: ENABLE_SIGNED_CONTRACT_ARCHIVAL defaults false.
  });

  const result = await handleDocusignWebhook(buildCompletedWebhookPayload("env-flag-off"));

  assert.equal(result.ok, true);
  assert.equal(result.normalized_status, "Completed");
  assert.equal(result.contract_status, "Fully Executed");
  assert.equal(store_calls.length, 0, "archival dep must never be invoked while off");
  assert.equal(result.signed_document_archive, null);
});

test("completed webhook archives the signed document when the flag is on", async () => {
  const store_calls = [];

  buildWebhookDeps({
    contract_item: createPodioItem(9002, {
      [CONTRACT_FIELDS.contract_status]: categoryField("Viewed"),
    }),
    store_calls,
    isFeatureEnabled: (flag) => flag === "ENABLE_SIGNED_CONTRACT_ARCHIVAL",
  });

  const result = await handleDocusignWebhook(buildCompletedWebhookPayload("env-flag-on"));

  assert.equal(result.ok, true);
  assert.equal(store_calls.length, 1);
  assert.equal(store_calls[0].envelope_id, "env-flag-on");
  assert.equal(store_calls[0].contract_item_id, 9002);
  assert.equal(result.signed_document_archive.archived, true);
});

test("non-completed webhook never archives even with the flag on", async () => {
  const store_calls = [];

  buildWebhookDeps({
    contract_item: createPodioItem(9003, {
      [CONTRACT_FIELDS.contract_status]: categoryField("Draft"),
    }),
    store_calls,
    isFeatureEnabled: () => true,
  });

  const result = await handleDocusignWebhook({
    event_id: "evt-sent",
    envelopeSummary: {
      envelopeId: "env-sent",
      status: "sent",
      sentDateTime: "2026-04-11T12:00:00.000Z",
      recipients: { signers: [{ roleName: "Seller", status: "sent" }] },
    },
  });

  assert.equal(result.ok, true);
  assert.notEqual(result.normalized_status, "Completed");
  assert.equal(store_calls.length, 0);
  assert.equal(result.signed_document_archive, null);
});

// ── Archival module happy path + contained failures (flag forced on) ──────

test("archival fetches the combined signed PDF and persists it via the storage package layer", async () => {
  const uploads = [];
  const pdf_bytes = Buffer.from("signed-pdf-bytes");

  __setStoreSignedContractDocumentTestDeps({
    isFeatureEnabled: () => true,
    getAccessToken: async () => ({
      ok: true,
      access_token: "token-1",
      config: { base_url: "https://demo.docusign.net/restapi", account_id: "acct-1", timeout_ms: 1000 },
    }),
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      url,
      arrayBuffer: async () => pdf_bytes.buffer.slice(
        pdf_bytes.byteOffset,
        pdf_bytes.byteOffset + pdf_bytes.byteLength
      ),
    }),
    createStoredDocumentPackage: async (payload) => {
      uploads.push(payload);
      return {
        ok: true,
        package_id: "pkg-signed-1",
        package_root_key: "contracts/contract-9001/pkg-signed-1",
        manifest_key: "contracts/contract-9001/pkg-signed-1/manifest.json",
        files: [{ key: "contracts/contract-9001/pkg-signed-1/signed.pdf" }],
      };
    },
    logger: silentLogger,
  });

  const result = await storeSignedContractDocument({
    envelope_id: "env-archive",
    contract_item_id: 9001,
    completed_at: "2026-04-11T12:15:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.archived, true);
  assert.equal(result.package.package_id, "pkg-signed-1");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].namespace, "contracts");
  assert.equal(uploads[0].label, "signed-contract");
  assert.equal(uploads[0].metadata.envelope_id, "env-archive");
  assert.equal(uploads[0].files[0].content_type, "application/pdf");
  assert.equal(uploads[0].files[0].body, pdf_bytes.toString("base64"));
});

test("archival failure is contained to an explicit non-throwing result", async () => {
  __setStoreSignedContractDocumentTestDeps({
    isFeatureEnabled: () => true,
    getAccessToken: async () => ({ ok: true, access_token: "t", config: { base_url: "b", account_id: "a" } }),
    fetchImpl: async () => ({ ok: false, status: 404 }),
    createStoredDocumentPackage: async () => {
      throw new Error("storage must not be reached when the fetch fails");
    },
    logger: silentLogger,
  });

  const result = await storeSignedContractDocument({
    envelope_id: "env-missing",
    contract_item_id: 9001,
  });

  assert.equal(result.ok, false);
  assert.equal(result.archived, false);
  assert.equal(result.reason, "docusign_document_fetch_failed_404");
});
