import assert from "node:assert/strict";
import test from "node:test";

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

// Closing-execution containment guard: a DocuSign signature webhook must always
// reconcile the contract's signature STATUS (it records truth), but it must NOT
// autonomously PROPAGATE that signature into title routing, closing, buyer
// match, or the real title-intro EMAIL unless closing execution is authorized
// (ENABLE_AUTO_CONTRACT_SEND). Default-deny keeps the whole chain dormant even
// if a stray / manual / replayed envelope webhook arrives. This suite proves the
// boundary; the happy-path propagation is covered by docusign-webhook-mapping.

function buildContractItem({ item_id = 9001, status = "Sent" } = {}) {
  return createPodioItem(item_id, {
    [CONTRACT_FIELDS.contract_status]: categoryField(status),
  });
}

// Records every downstream effect the webhook attempts.
function harness(featureFlags) {
  const calls = { updates: [], title: 0, closing: 0, buyer: 0, intro: 0, pipeline: 0, brain: 0 };
  const ledger = createInMemoryIdempotencyLedger();
  __setDocusignWebhookTestDeps({
    featureFlags,
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    info: () => {},
    warn: () => {},
    findContractItems: async () => [buildContractItem()],
    updateContractItem: async (_id, payload) => calls.updates.push(payload),
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
      return { ok: true, buyer_match_item_id: 3 };
    },
    maybeSendTitleIntro: async () => {
      calls.intro += 1;
      return { ok: true, sent: true };
    },
    syncPipelineState: async () => {
      calls.pipeline += 1;
      return { current_stage: "Contract" };
    },
    updateBrainFromExecution: async () => {
      calls.brain += 1;
      return { ok: true, updated: true };
    },
  });
  return calls;
}

const COMPLETED_WEBHOOK = {
  event_id: "evt-completed",
  envelopeSummary: {
    envelopeId: "env-1",
    status: "completed",
    completedDateTime: "2026-08-27T12:00:00.000Z",
    recipients: {
      signers: [
        { roleName: "Seller", status: "completed", completedDateTime: "2026-08-27T12:00:00.000Z" },
      ],
    },
  },
};

test.afterEach(() => __resetDocusignWebhookTestDeps());

test("DORMANT by default: signature status is reconciled but NO downstream propagates", async () => {
  // ENABLE_AUTO_CONTRACT_SEND omitted -> falsy -> dormant.
  const calls = harness({});
  const result = await handleDocusignWebhook(COMPLETED_WEBHOOK);

  assert.equal(result.ok, true);
  assert.equal(result.downstream_authorized, false);
  assert.equal(result.downstream_skip_reason, "closing_execution_dormant");
  // Internal reconciliation ALWAYS runs (records the signature truth):
  assert.equal(calls.updates.length, 1, "contract status IS still reconciled");
  assert.equal(calls.pipeline, 1, "pipeline STILL reconciles (internal deal-state, not an effect)");
  assert.equal(calls.brain, 1, "brain STILL reconciles (internal deal-state, not an effect)");
  // External-effect propagation is contained:
  assert.equal(calls.title, 0, "no title routing artifact");
  assert.equal(calls.closing, 0, "no closing artifact");
  assert.equal(calls.buyer, 0, "no buyer match");
  assert.equal(calls.intro, 0, "no title-intro EMAIL");
});

test("DORMANT: an explicit ENABLE_AUTO_CONTRACT_SEND=false blocks the real email send", async () => {
  const calls = harness({ ENABLE_AUTO_CONTRACT_SEND: false, ENABLE_AUTO_TITLE_INTRO: true });
  const result = await handleDocusignWebhook(COMPLETED_WEBHOOK);
  assert.equal(result.downstream_authorized, false);
  assert.equal(calls.intro, 0, "the title-intro email must not fire even with its own flag on");
});

test("AUTHORIZED: with closing execution enabled, the full downstream propagates", async () => {
  const calls = harness({
    ENABLE_AUTO_CONTRACT_SEND: true,
    ENABLE_AUTO_TITLE_ROUTING: true,
    ENABLE_AUTO_CLOSING_FLOW: true,
    ENABLE_AUTO_TITLE_INTRO: true,
    ENABLE_AUTO_BUYER_MATCH: true,
  });
  const result = await handleDocusignWebhook(COMPLETED_WEBHOOK);
  assert.equal(result.downstream_authorized, true);
  assert.equal(calls.title, 1);
  assert.equal(calls.closing, 1);
  assert.equal(calls.buyer, 1);
  assert.equal(calls.intro, 1);
});

test("PER-STEP: within the boundary, a single per-step flag off skips only that step", async () => {
  // Authorized, but the title-intro email is individually disabled.
  const calls = harness({
    ENABLE_AUTO_CONTRACT_SEND: true,
    ENABLE_AUTO_TITLE_ROUTING: true,
    ENABLE_AUTO_CLOSING_FLOW: true,
    ENABLE_AUTO_TITLE_INTRO: false,
    ENABLE_AUTO_BUYER_MATCH: true,
  });
  await handleDocusignWebhook(COMPLETED_WEBHOOK);
  assert.equal(calls.title, 1, "title routing still runs");
  assert.equal(calls.closing, 1, "closing still runs");
  assert.equal(calls.intro, 0, "only the individually-disabled email is skipped");
});

test("the module's default featureFlags are deny-by-default (ENABLE_AUTO_CONTRACT_SEND off)", async () => {
  // No featureFlags override at all -> handler falls back to the real
  // FEATURE_FLAGS, whose ENABLE_AUTO_CONTRACT_SEND defaults to false. Proves the
  // guard is dormant in production without any test injection.
  const calls = { updates: [], title: 0, intro: 0 };
  const ledger = createInMemoryIdempotencyLedger();
  __setDocusignWebhookTestDeps({
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    info: () => {},
    warn: () => {},
    findContractItems: async () => [buildContractItem()],
    updateContractItem: async (_id, payload) => calls.updates.push(payload),
    maybeCreateTitleRoutingFromSignedContract: async () => {
      calls.title += 1;
      return { ok: true };
    },
    maybeSendTitleIntro: async () => {
      calls.intro += 1;
      return { ok: true, sent: true };
    },
    // Internal reconciliation always runs; mock it so nothing hits the network.
    syncPipelineState: async () => ({ current_stage: "Contract" }),
    updateBrainFromExecution: async () => ({ ok: true, updated: true }),
  });
  const result = await handleDocusignWebhook(COMPLETED_WEBHOOK);
  assert.equal(result.downstream_authorized, false, "prod default is dormant");
  assert.equal(calls.title, 0);
  assert.equal(calls.intro, 0);
});
